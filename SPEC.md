# CVA — Control Vector Agent: Separation Spec

## Context

CV-Hub's agentic loop works: Claude.ai → CV-Hub MCP → cv-agent → Claude Code on remote machines. But the agent functionality is currently bundled inside `cv` (the cv-git CLI), which creates two problems:

1. **Recursion trap**: `cv agent` spawns Claude Code, which might call `cv` commands, creating circular dependency. The agent must be in a separate binary namespace.
2. **Remote mismatch**: When the agent creates a repo on CV-Hub (`git.hub.controlvector.io`), the local git clone's `origin` still points at GitHub. Claude Code pushes to the wrong remote.

## Solution: `cva` — A New Package

Extract all agent/hub operations into a new npm package `@controlvector/cv-agent` with binary `cva`.

### Package Identity

```
Package: @controlvector/cv-agent
Binary: cva
Registry: npmjs.org (public)
Version: 0.1.0 (fresh start, independent of cv-git versioning)
```

### Clean Separation of Concerns

| Binary | Package | Responsibility |
|--------|---------|---------------|
| `cv` | `@controlvector/cv-git` | Git operations, knowledge graph, code analysis, local dev workflow |
| `cva` | `@controlvector/cv-agent` | Agent daemon, task dispatch, CV-Hub remote management, permission relay |

**Rule**: Claude Code sessions spawned by `cva agent` use **standard `git` commands only** — never `cv` or `cva`. This eliminates the recursion trap entirely.

---

## Architecture

### Directory Structure

```
cv-agent/
├── package.json
├── tsconfig.json
├── README.md
├── CHANGELOG.md
├── src/
│   ├── index.ts                    # CLI entry point (commander)
│   ├── commands/
│   │   ├── agent.ts                # `cva agent` — daemon mode
│   │   ├── task.ts                 # `cva task` — task management
│   │   ├── remote.ts               # `cva remote` — CV-Hub remote management
│   │   ├── auth.ts                 # `cva auth` — CV-Hub authentication
│   │   └── status.ts               # `cva status` — executor/task status
│   ├── agent/
│   │   ├── daemon.ts               # Agent daemon loop (poll for tasks)
│   │   ├── executor.ts             # Claude Code process management
│   │   ├── permission-relay.ts     # Permission prompt interception + CV-Hub relay
│   │   ├── task-runner.ts          # Task lifecycle (claim → run → report)
│   │   └── heartbeat.ts            # Executor heartbeat to CV-Hub
│   ├── hub/
│   │   ├── client.ts               # CV-Hub API client (REST)
│   │   ├── auth.ts                 # Token management, login flow
│   │   └── types.ts                # API response types
│   ├── git/
│   │   ├── remote.ts               # Git remote management (add/set cvhub remote)
│   │   └── push.ts                 # Push helpers (ensure correct remote)
│   └── utils/
│       ├── config.ts               # CVA config (~/.cva/config.json)
│       ├── logger.ts               # Structured logging
│       └── platform.ts             # OS detection, paths
├── tests/
│   ├── permission-relay.test.ts
│   ├── task-runner.test.ts
│   └── remote.test.ts
└── dist/
```

### package.json

```json
{
  "name": "@controlvector/cv-agent",
  "version": "0.1.0",
  "description": "Control Vector Agent — Remote Claude Code task dispatch and CV-Hub integration",
  "type": "module",
  "bin": {
    "cva": "./dist/bundle.cjs"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "build": "tsc && esbuild dist/index.js --bundle --platform=node --format=cjs --outfile=dist/bundle.cjs --banner:js=\"#!/usr/bin/env node\"",
    "dev": "tsc --watch",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "commander": "^11.1.0",
    "chalk": "^5.3.0",
    "cli-table3": "^0.6.3",
    "ora": "^8.2.0",
    "simple-git": "^3.22.0"
  },
  "publishConfig": {
    "access": "public"
  },
  "keywords": ["claude-code", "agent", "cv-hub", "control-vector", "ai-agent"],
  "author": "Control Vector",
  "license": "MIT"
}
```

---

## CLI Commands

### `cva agent [--auto-approve] [--dir <path>]`

Start the agent daemon.

```
$ sudo cva agent --auto-approve
🤖 CVA Agent v0.1.0
   Machine:   schmotzersurfa
   Executor:  24612060-4c86-...
   API:       https://api.hub.controlvector.io
   Dir:       /home/jwscho/github/cv-trade
   Polling:   every 5s
   Ctrl+C to stop

🔵 Listening for tasks...
```

Behavior:
- Registers as executor with CV-Hub
- Polls for pending tasks every 5s
- When task claimed: spawns Claude Code with the task description as prompt
- Monitors Claude Code stdout for permission prompts
- If `--auto-approve`: auto-approves all permission prompts locally (pipes "y" to stdin)
- If NOT `--auto-approve`: relays prompts to CV-Hub API, polls for response, pipes response to stdin
- When Claude Code exits: reports result (files changed, elapsed time) to CV-Hub
- Sends heartbeat every 30s

**Root detection**: If running as root, `--dangerously-skip-permissions` is unavailable for Claude Code. The agent MUST handle permissions via either `--auto-approve` (local auto-yes) or the CV-Hub prompt relay.

### `cva remote add [--name <n>]`

Configure the CV-Hub git remote for the current repository.

```
$ cd ~/github/cv-trade
$ cva remote add
✅ Added remote 'cvhub' → https://git.hub.controlvector.io/schmotz/cv-trade.git
```

### `cva remote setup <owner/repo>`

Create a repo on CV-Hub AND configure the local remote in one step.

### `cva task list [--status <status>]`

List tasks for the current executor.

### `cva task logs <task-id>`

Stream task logs/progress.

### `cva status`

Show executor status, active tasks, recent completions.

### `cva auth login`

Authenticate with CV-Hub. Store token in `~/.cva/config.json`.

---

## Critical Implementation: Permission Relay

### File: `src/agent/permission-relay.ts`

When Claude Code runs WITHOUT --dangerously-skip-permissions (e.g., as root), every tool call requires explicit approval. This module:

1. Captures Claude Code's stdout via piped streams
2. Detects permission prompt patterns
3. Either auto-approves (--auto-approve) or relays to CV-Hub for remote approval
4. Pipes the approval response back to Claude Code's stdin

### Claude Code Permission Prompt Detection

Common patterns to match:

```
Allow write to /path/to/file? (y/n)
Allow bash: <command>? (y/n)
Allow edit to /path/to/file? (y/n)
Do you want to proceed? (y/n)
```

**Implementation approach**: 
- Spawn Claude Code with `stdio: ['pipe', 'pipe', 'pipe']`
- Read stdout line by line
- Tee all output to the terminal for visibility
- When a line matches permission patterns: either write "y\n" to stdin (auto-approve) or relay via CV-Hub

### Auto-Approve Mode (--auto-approve)

```typescript
if (options.autoApprove && isPermissionPrompt(line)) {
  childProcess.stdin.write('y\n');
  logger.info(`Auto-approved: ${line.trim()}`);
}
```

### CV-Hub Relay Mode (default)

```typescript
if (!options.autoApprove && isPermissionPrompt(line)) {
  const prompt = await hubClient.createPrompt(taskId, {
    type: 'permission',
    text: line.trim(),
    options: ['y', 'n']
  });
  
  const response = await hubClient.waitForPromptResponse(prompt.id, {
    timeout: 300_000,
    pollInterval: 2_000
  });
  
  childProcess.stdin.write(response.text + '\n');
}
```

---

## Critical Implementation: Git Remote Management

### The Problem

When `cva agent` dispatches a task that creates files, Claude Code runs `git push origin main` — but `origin` points to GitHub, not CV-Hub.

### The Fix: Three-Layer Approach

**Layer 1: Task description injection**

When `cva agent` spawns Claude Code, it prepends remote information:

```
## Git Remote Configuration
The CV-Hub remote for this repository is: https://git.hub.controlvector.io/{owner}/{repo}.git
When pushing, use: git push cvhub main
If the 'cvhub' remote doesn't exist, add it first:
  git remote add cvhub https://git.hub.controlvector.io/{owner}/{repo}.git
```

**Layer 2: Pre-task remote setup**

Before spawning Claude Code, the agent ensures the `cvhub` remote exists:

```typescript
async function ensureCvHubRemote(workspaceDir: string, repoUrl: string) {
  const git = simpleGit(workspaceDir);
  const remotes = await git.getRemotes(true);
  const cvhub = remotes.find(r => r.name === 'cvhub');
  
  if (!cvhub) {
    await git.addRemote('cvhub', repoUrl);
  } else if (cvhub.refs.push !== repoUrl) {
    await git.remote(['set-url', 'cvhub', repoUrl]);
  }
}
```

**Layer 3: Task description instructs push to cvhub**

Injected automatically by the agent:

```bash
git add -A
git commit -m "commit message"
git push cvhub main
```

---

## Migration from cv-git

### What Moves to CVA

| Current (`cv`) | New (`cva`) | Notes |
|----------------|-------------|-------|
| `cv agent` | `cva agent` | Full daemon, executor registration, task polling |
| Agent task runner | `cva` internal | Task claim, Claude Code spawn, result reporting |
| Permission relay code | `cva` internal | All stdout capture, prompt detection, relay logic |
| Hub API client (agent-specific) | `cva` internal | Executor endpoints, task endpoints, prompt endpoints |

### What Stays in cv-git

All git operations, knowledge graph, code analysis, local dev workflow commands.

### What Gets Removed from cv-git (later)

Once CVA is stable: remove `cv agent` command, add deprecation message pointing to `cva agent`.

**Do NOT remove yet.** Keep `cv agent` functional during the transition.

---

## Config File: `~/.cva/config.json`

```json
{
  "hub": {
    "api": "https://api.hub.controlvector.io",
    "token": "cvh_xxxxxxxxxxxx"
  },
  "agent": {
    "pollInterval": 5000,
    "heartbeatInterval": 30000,
    "autoApprove": false,
    "claudeCodePath": "claude",
    "maxConcurrentTasks": 1
  },
  "defaults": {
    "remoteName": "cvhub"
  }
}
```

---

## Testing Checklist

- [ ] `cva agent --auto-approve` starts daemon, registers executor, polls for tasks
- [ ] Task dispatch from Claude.ai → claimed by cva agent → Claude Code spawned
- [ ] Claude Code writes files (permission auto-approved)
- [ ] Claude Code commits and pushes to `cvhub` remote
- [ ] Files appear in CV-Hub repo
- [ ] Task result reported back to CV-Hub with correct file list
- [ ] `cva remote add` correctly configures cvhub remote
- [ ] `cva auth login` stores token
- [ ] Works on Linux (root and non-root)
- [ ] Works on Windows (WSL)
- [ ] Permission relay to CV-Hub works (non-auto-approve mode)

---

## Version Roadmap

| Version | Milestone |
|---------|-----------|
| 0.1.0 | Core agent daemon, auto-approve, git remote management |
| 0.2.0 | Full CV-Hub permission relay (non-auto-approve mode) |
| 0.3.0 | Multi-task support, task queuing |
| 0.4.0 | Agent health monitoring, auto-restart |
| 1.0.0 | Production-ready, full test coverage |
