# Permission Intelligence v1 — Design Spec

**Status:** Draft for review
**Owner:** TBD (proposed: Jason as product owner, implementation TBD)
**Contributors:** John Schmotzer
**Date:** 2026-04-23
**Target repo:** schmotz/cv-agent (primary), controlvector/cv-hub (federation server)
**Related prior work:** Sprint 1 Context Prediction Engine (cv-git), see references below.

---

## 1. Executive Summary

Users running Claude Code inside cv-agent are presented with a three-way permission prompt on most tool calls: **Yes**, **Yes to all**, **No**. Today users have no guidance on which to pick. They either rubber-stamp "Yes to all" (unsafe), reject everything (unproductive), or stall (uncertain). This is a trust and velocity problem, and it scales badly as agent autonomy increases.

Permission Intelligence (PI) is a recommendation layer that scores each option in context and surfaces a confidence-weighted suggestion with a one-line explanation. It does not auto-select; it informs. The system learns from three signals: hand-curated safety policy, the individual user's decision history, and the aggregated patterns of other users on similar actions. Under the hood it reuses the three-layer math stack we already built on cv-git (variable-order Markov chain, Personalized PageRank on a knowledge graph, LinUCB contextual bandit).

This document specifies the v1 implementation in enough detail for a sprint-level execution.

## 2. Problem Statement

### 2.1 What's broken today

1. **Decision paralysis on each prompt.** Users cannot tell whether a given `Bash(git push -f)` or `Write(.env)` call is safe to approve without reading the full context.
2. **Over-use of Yes-to-all.** Users toggle `launchAutoApproveMode` to escape friction, which disables all safety review for the remainder of the session.
3. **No institutional memory.** If a teammate already made the same decision on the same action in the same kind of context, that knowledge is lost.
4. **Asymmetric costs.** A wrong Yes is orders of magnitude worse than a wrong No, but the UI treats them symmetrically.

### 2.2 Who this serves

- **Individual developers** running `cva agent` locally.
- **Teams** running cv-agent across multiple engineers on shared repos, where cohort signal is the key value.
- **Enterprise customers** who need auditability and policy enforcement with gradations finer than "auto-approve everything" vs "prompt every time."

### 2.3 Success, in one line

The user says "I trust the recommendation more often than not, I learn from the explanations, and I have fewer regretted Yes clicks per week."

## 3. Prior Art and What We Reuse

The cv-git Sprint 1 "Context Prediction Engine" (merged, `core/context/`) already ships:

- **Phase detector** (`phase-detector.ts`): classifies current session into {code, compile, test, debug, deploy, explore}.
- **Transition model** (`transition-model.ts`): first-order Markov chain with EWMA decay (alpha=0.15).
- **Personalized PageRank** (`personalized-pagerank.ts`): bounded 500-node subgraph, seeded by current state.
- **Contextual bandit** (`contextual-bandit.ts`): LinUCB with 8-dim context, implicit reward signal.
- **Combined scorer** (`context-scorer.ts`): `score = PPR * phase_weight * bandit_quality * freshness_decay`.

Permission Intelligence reuses **all four** modules as-is or with minor extensions. The novel additions are the action fingerprinter, risk tagger, regret-signal extractor, and fusion scorer that combines three sources (policy, personal, cohort).

This reuse is the main reason v1 is a 4-5 week effort rather than a 6-month project.

## 4. Architecture Overview

```
                    Claude Code permission prompt
                            {Yes, Yes-to-all, No}
                                      |
                                      v
                    +-----------------------------------+
                    |    cv-agent Permission Relay      |
                    |    (launchRelayMode, existing)    |
                    +-----------------------------------+
                                      |
                                      v
                    +-----------------------------------+
                    |    Permission Intelligence        |
                    |    Recommender (new)              |
                    +-----------------------------------+
                                      |
       +------------------+-----------+---------------+---------------------+
       v                  v                           v                     v
  +---------+       +-----------+              +-------------+      +--------------+
  | Policy  |       | Personal  |              | Cohort      |      | Risk Tagger  |
  | Layer   |       | VMM       |              | Layer       |      | (KG-driven)  |
  |         |       | (local)   |              | (federated) |      |              |
  | Hand    |       | SQLite    |              | via cv-hub  |      | Action tags  |
  | rules + |       | per user  |              | k-anon + DP |      | + blast      |
  | KG tags |       |           |              |             |      |   radius     |
  +----+----+       +-----+-----+              +------+------+      +------+-------+
       |                  |                           |                    |
       +------------------+---------------------------+--------------------+
                                      |
                                      v
                         +-------------------------+
                         |   Fusion Scorer         |
                         |   (LinUCB-weighted)     |
                         +-------------------------+
                                      |
                                      v
                         +-------------------------+
                         |   Recommendation +      |
                         |   Confidence +          |
                         |   Explanation           |
                         +-------------------------+
                                      |
                                      v
                         +-------------------------+
                         |   Regret Watcher        |
                         |   (reward extraction)   |
                         +-------------------------+
                                      |
                                      v
                              back to bandit training
```

Three trust tiers, explicitly separated so they can be audited and tuned independently:

| Layer | Lives where | Privacy | Latency | Purpose |
|-------|-------------|---------|---------|---------|
| Policy | cv-agent local + cv-hub registry | Public rules, no user data | <1 ms | Hard safety rails (vetoes) |
| Personal | cv-agent local SQLite | Private, never leaves device | <5 ms | Learn individual tolerance |
| Cohort | cv-hub federated KG | k-anon, DP noise on aggregates | <30 ms async | Team and global precedent |

Fusion is always at the edge. Edge is authoritative when confidence is high. Cohort can be stale without hurting latency.

## 5. Module Specifications

### 5.1 Action Fingerprinter

**Location:** `cv-agent/src/permission/fingerprint.ts`

Takes a raw tool call from Claude Code and produces a canonical fingerprint tuple.

**Input:**
```typescript
interface ToolCall {
  toolName: string;           // "Bash", "Edit", "Write", "WebFetch", ...
  input: Record<string, any>; // tool-specific args
  repoContext: RepoContext;   // cwd, branch, remote, is_dirty
}
```

**Output:**
```typescript
interface ActionFingerprint {
  family: string;              // "bash/git-commit", "bash/rm", "edit/src", "write/config"
  verbNormalized: string;      // lowercased, flag-stripped canonical form
  pathPattern: string | null;  // glob pattern of target paths, PII-stripped
  sensitivityTags: SensitivityTag[];
  fingerprintHash: string;     // SHA256 for cohort lookup, deterministic
}

type SensitivityTag =
  | "touches-git-history"
  | "touches-credentials"
  | "touches-dotfiles"
  | "writes-outside-repo"
  | "net-egress"
  | "destructive"
  | "recoverable"
  | "idempotent"
  | "requires-sudo"
  | "modifies-remote";
```

**Normalization rules (critical for cohort matching to work):**
- Absolute paths replaced with repo-relative patterns
- Hostnames stripped from URLs (keep domain family)
- Usernames, emails, tokens redacted
- Numeric args bucketed (e.g., port numbers classified as `well-known | ephemeral | privileged`)
- Command chains split and fingerprinted per segment (`a | b && c` becomes three fingerprints with a `chained` flag)

### 5.2 Risk Tagger

**Location:** `cv-agent/src/permission/risk.ts`

Assigns a risk tier {T1, T2, T3} and a blast-radius score `[0, 1]`.

**Tiers:**
- **T1 (critical):** Never auto-recommend Yes-to-all. Includes: history rewrites (`git push -f`, `git reset --hard`), credential file writes, recursive deletes outside sandbox, sudo operations, network calls to non-allowlisted domains, DROP/TRUNCATE SQL, `curl | sh` patterns.
- **T2 (moderate):** Recommendations allowed with confidence threshold >=0.7. Includes: file writes to project, git commits, package installs, running tests.
- **T3 (low):** Aggressive auto-recommendation permitted. Includes: file reads in project, status commands, searches, type checks.

**Source of tier classification:**
1. Hand-curated rule table (ships with cv-agent, updates via cv-hub).
2. KG classifier trained on labeled decisions over time.
3. User-defined overrides (per-user, per-repo).

The hand-curated layer **always wins on conflict**. This is non-negotiable for safety.

**Blast radius** is a continuous scalar the fusion scorer uses as a penalty weight. It factors file count touched, recoverability (can git reflog restore it?), network scope, and whether the action is idempotent.

### 5.3 Personal VMM (Variable-order Markov Model)

**Location:** `cv-agent/src/permission/personal-vmm.ts`

Per-user model of `P(decision | state)` where state is the fingerprint tuple plus session context.

**Storage:** SQLite at `~/.cv-agent/personal-vmm.db`

**Schema:**
```sql
CREATE TABLE decisions (
  id              INTEGER PRIMARY KEY,
  fingerprint     TEXT NOT NULL,   -- ActionFingerprint.fingerprintHash
  phase           TEXT NOT NULL,   -- WorkflowPhase
  session_ctx     TEXT NOT NULL,   -- JSON: repo_trust, session_age_bucket, recent_err_rate
  decision        TEXT NOT NULL,   -- 'yes' | 'yes_to_all' | 'no'
  ts              INTEGER NOT NULL,
  regret_score    REAL DEFAULT 0,  -- filled in later by regret watcher
  INDEX ix_fp (fingerprint, phase)
);

CREATE TABLE vmm_stats (
  fingerprint     TEXT NOT NULL,
  phase           TEXT NOT NULL,
  decision        TEXT NOT NULL,
  count           INTEGER NOT NULL,
  weighted_count  REAL NOT NULL,   -- EWMA with alpha=0.15 over ts
  last_updated    INTEGER NOT NULL,
  PRIMARY KEY (fingerprint, phase, decision)
);
```

**Estimation:** Dirichlet-smoothed MLE with backoff.

```
Order 3: P(d | fingerprint, phase, session_ctx_bucket)
Order 2: P(d | fingerprint, phase)
Order 1: P(d | family, phase)
Order 0: P(d | family)

P(d | state) = (weighted_count(state, d) + alpha) / (sum_d' weighted_count(state, d') + 3 * alpha)
```

Backoff is triggered when `sum_d' weighted_count(state, d') < k_min` (proposed: k_min=5).

**EWMA:** weighted_count decays such that decisions from T days ago are worth `exp(-lambda * T)` times a fresh decision. Proposed lambda to give half-life of 60 days.

### 5.4 Cohort Layer

**Location:** server-side in cv-hub, agent-side client in `cv-agent/src/permission/cohort-client.ts`

Federated aggregate of decisions across users in a tenant (team) or globally (opt-in).

**Data flow:**
1. User opts in via `cva config permission-intelligence.share-to=team|global|none`
2. cv-agent batches decisions every N minutes, hashes fingerprints, strips paths, and uploads to cv-hub
3. cv-hub maintains a **cohort decision KG** where nodes are `(fingerprint_hash, phase)` and edges encode semantic similarity between fingerprints (from the existing cv-git KG) and co-occurrence within sessions
4. On query, cv-agent sends `(fingerprint_hash, phase, session_ctx_bucket)` and receives a distribution `P(decision)` plus `n_distinct_users` and `confidence`

**Semantic similarity for PPR seed:** If the exact fingerprint has fewer than k_min contributors, PPR from the fingerprint's node in the KG expands the seed set by semantic neighbors. Reuses cv-git `personalized-pagerank.ts` with alpha=0.15, max 500 nodes.

**Privacy guarantees:**
- **k-anonymity:** aggregated counts only released when n_distinct_users >= 5.
- **Differential privacy:** Laplace noise added to counts with epsilon=1.0 per daily update.
- **Fingerprint normalization:** paths, hostnames, tokens stripped client-side before hashing.
- **Opt-in only:** defaults to `share-to=none`. Team admin can set org default.

**API contract (cv-hub side):**
```
POST /api/permission-intelligence/query
  body: { fingerprint_hash, phase, session_ctx_bucket, cohort: "team" | "global" }
  response: {
    distribution: { yes: 0.72, yes_to_all: 0.18, no: 0.10 },
    n_distinct_users: 12,
    n_observations: 47,
    confidence: 0.81,
    ppr_expansion_used: false
  }

POST /api/permission-intelligence/contribute
  body: { batch: [{ fingerprint_hash, phase, session_ctx_bucket, decision, regret_score, ts }] }
  response: { accepted: N, rejected: 0 }
```

### 5.5 Fusion Scorer

**Location:** `cv-agent/src/permission/fusion-scorer.ts`

Combines the three layers into a single score per decision option.

```typescript
interface FusionInput {
  policy: PolicyLayerOutput;   // hard constraints + scores
  personal: Distribution;      // { yes, yes_to_all, no }, plus n
  cohort: Distribution;        // { yes, yes_to_all, no }, plus n_distinct_users
  risk: { tier: "T1" | "T2" | "T3"; blastRadius: number };
  banditCtx: number[];         // 8-dim context vector for LinUCB
}

interface FusionOutput {
  recommendation: "yes" | "yes_to_all" | "no";
  confidence: number;           // [0, 1]
  scores: Record<Decision, number>;
  explanation: string;          // one-line "why"
  sources: {                    // for transparency UI
    policy: Partial<Distribution>;
    personal: Partial<Distribution> & { n: number };
    cohort: Partial<Distribution> & { n_users: number };
  };
}
```

**Scoring formula:**
```
score(d) = w_pol * policyScore(d)
        + w_per * personalProb(d)
        + w_coh * cohortProb(d)
        - w_risk * riskPenalty(d)
```

Subject to hard policy constraints that can force `score = 0` for specific options regardless of other signals. Weights `[w_pol, w_per, w_coh, w_risk]` learned per user via LinUCB on regret signals.

**Confidence** is computed as `1 - H(distribution) / log(3)` where H is entropy, then further attenuated by `min(1, n_effective / n_reference)` to account for data sparsity.

**Never auto-suppress the "No" option.** Even if scoring says Yes is obvious, the user must be able to choose No. Recommendation changes which option is highlighted, not which options are available.

**Explanation templates:**
- `"Most teammates chose Yes for similar npm install in test phase. Your history agrees."`
- `"You rejected this action 3 times in the last week. Cohort split 50/50."`
- `"Policy blocks Yes-to-all for force push. Recommend single Yes only."`
- `"Low confidence. Not enough history. Follow your gut."`

### 5.6 Regret Watcher

**Location:** `cv-agent/src/permission/regret-watcher.ts`

Extracts implicit reward signal from session telemetry to train the bandit.

**Signals instrumented:**
| Signal | Window | Weight |
|--------|--------|--------|
| Post-Yes git reset / git stash | 5 min | -0.8 |
| Post-Yes rm on just-created file | 5 min | -0.9 |
| Post-Yes Ctrl-C during run | real-time | -0.4 |
| Post-Yes "undo that" to Claude | 10 min | -0.7 |
| Post-Yes error chain (N>=3 failed turns) | 15 min | -0.5 |
| Post-No quick re-approve of same fingerprint | 5 min | -0.3 (under-trust signal) |
| Post-YesToAll Esc during permitted action | real-time | -0.6 (scope too broad) |
| Session continued productively (commit velocity stable) | 30 min | +0.1 |

Regret score is written back to the `decisions` table and becomes part of the bandit's reward vector. Negative regret is what tunes `[w_pol, w_per, w_coh, w_risk]` downward for sources that led the user astray.

### 5.7 Recommendation UI

**Location:** cv-agent's relay mode already prints permission prompts. Extend `launchRelayMode` to add a recommendation line above the prompt.

**Format:**
```
Claude wants to run: git push -f origin feature/x

Recommended: [ No ]  (confidence: high)
  > Policy blocks Yes-to-all for force push.
  > 8 teammates rejected similar force push in test phase.
  > Your history: 2 yes, 4 no, 0 yes-to-all.

  Options:
  (y) Yes   [Y] Yes to all   (n) No
```

The recommendation is always visible but **never pre-selected**. User must press a key. No click-through acceleration for T1 actions.

## 6. Phased Implementation Plan

Designed to land measurable value at the end of each phase. Each phase produces something shippable.

### Phase 0 (Week 0, prep): Design review and scoping

- Review this spec with Jason, Greg, Tom
- Decide: v1 scope = Phase 1+2 only, or include Phase 3 (cohort)?
- Decide: who owns each module
- Open tracking issues in cv-agent

**Exit criteria:** Signed-off scope, assigned owners, dependency freeze.

### Phase 1 (Week 1): Action Fingerprinter + Risk Tagger + Recommendation UI shell

- Ship the fingerprinter with 20 hand-curated rules for common Claude Code actions (git, npm, pnpm, cargo, pytest, rm, curl, docker, ssh)
- Ship the risk tagger with T1/T2/T3 classification
- Ship the recommendation UI shell that prints risk tier + blast radius (no ML yet, just rule-based)
- Wire into `launchRelayMode`

**Value at end of phase:** Users see "this is a T1 destructive action touching git history" before they decide. This alone is better than nothing.

**Exit criteria:** Fingerprint coverage >= 80% of typical Claude Code session. Risk tagger passes 50-case test matrix. UI renders inline.

### Phase 2 (Weeks 2-3): Personal VMM + Fusion Scorer (no cohort yet)

- Implement SQLite personal VMM with variable-order backoff
- Implement fusion scorer with cohort stubbed as uniform
- Wire regret watcher into the agent event stream (instrumented but not training yet)
- LinUCB bandit scaffolded with fixed weights `[0.5, 0.3, 0.0, 0.2]` as baseline

**Value at end of phase:** Personalized recommendation. "You've rejected this 3 times" style feedback.

**Exit criteria:** Personal VMM produces recommendations with calibrated confidence. Regret watcher logs signals to decisions table. End-to-end latency <50ms.

### Phase 3 (Weeks 3-4): Cohort Layer on cv-hub

- Server-side cohort KG schema in cv-hub
- Contribute/query endpoints with k-anon and DP
- Agent-side cohort client with batched upload
- Opt-in config and defaults

**Value at end of phase:** Team-level precedent signal. The "other humans like you said X" feature becomes real.

**Exit criteria:** Cohort query round-trip <100ms P95. k-anon enforced. DP noise calibrated. At least one team running internally (us).

### Phase 4 (Week 5): Bandit Weight Learning

- Wire regret scores back into decisions table
- Enable LinUCB to update weights per user
- A/B shadow test: recommendation with fixed weights vs learned weights
- Ship learned weights when shadow test shows improvement

**Value at end of phase:** System self-tunes. New users inherit global priors, experienced users diverge to their own weights.

**Exit criteria:** Shadow test shows statistically significant regret reduction. Weights converge within 30 decisions per user.

## 7. Success Metrics

**North star:** Regret rate per week per user (lower is better).

**Leading indicators:**
- Recommendation acceptance rate (target: >60% by end of Phase 2)
- Recommendation disagreement rate on T1 actions (should be low; high means policy is wrong)
- Cohort contribution rate among opted-in users (target: >80% of decisions uploaded)
- Time-to-decision on a prompt (target: 30% reduction)

**Lagging indicators:**
- Reduction in `launchAutoApproveMode` usage (we want users to not have to reach for the nuclear option)
- Reduction in git reset frequency after agent runs
- Qualitative user feedback on trust

## 8. Privacy, Safety, Auditability

### 8.1 What leaves the device

**Never:** raw commands, file contents, paths with PII, credentials, hostnames, actual arg values beyond normalized buckets.

**Only with opt-in:** hashed fingerprints, phase labels, session context buckets, decision, regret score, timestamp.

### 8.2 Safety rails above the ML

- T1 policy vetoes **cannot** be overridden by ML recommendation.
- No auto-selection of any option, ever.
- Confidence floor: recommendations with confidence <0.4 render as "Low confidence, follow your gut" instead of a specific recommendation.
- Exploration noise: LinUCB's UCB bonus ensures we don't lock into local minima.

### 8.3 Auditability

Every recommendation logged with: fingerprint, three source distributions, fusion weights, final recommendation, user's actual decision, subsequent regret score. Accessible via `cva permission-intelligence audit --session <id>`.

## 9. Open Questions / Decisions Needed

1. **Risk tier authority.** Who owns the hand-curated T1 list? Proposal: Greg as CSO owns it, Jason approves UX changes, engineers propose additions via PR. Needs confirmation.
2. **Cohort default.** Should team share-to default to "team" or "none"? "team" gets us data faster, "none" is safer for customer trust. Proposal: "none" by default, team admin can set org default.
3. **Integration surface in Claude Code.** Claude Code's permission prompt UI is outside our control. Does recommendation render inside the prompt box (requires upstream change) or as a pre-prompt line (we can ship today)? Proposal: ship as pre-prompt line in v1, propose upstream integration in v2.
4. **Licensing.** Is this a CV-Safe feature (bundled) or standalone? Proposal: bundled with cv-agent, marketed under CV-Safe umbrella.
5. **Patent filing.** The combination of (a) VMM over agent tool-use decisions, (b) KG-mediated precedent retrieval, (c) regret-signal extraction from agentic sessions, (d) hierarchical federation with DP, looks patentable. Should we file before Phase 3 lands? Proposal: yes, James Iwanicki to review after Phase 0 sign-off.

## 10. References

- **Sprint 1 Context Prediction Engine** (cv-git) — the Markov + PPR + LinUCB stack we reuse
  - Commit: `core/context/` module
  - Docs: `docs/sprints/sprint-1-context-prediction-engine.md`
- **cv-agent permission relay** — `src/commands/agent.ts`, functions `launchRelayMode` and `launchAutoApproveMode`
- **cv-agent event parser** — `src/utils/output-parser.ts`, function `parseClaudeCodeOutput`
- **Context Manifold paper** (arXiv) — theoretical basis for KG-mediated retrieval

## 11. Change Log

| Date | Who | Change |
|------|-----|--------|
| 2026-04-23 | John + Claude | Initial draft |
