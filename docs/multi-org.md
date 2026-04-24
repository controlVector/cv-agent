# Multi-Organization Accounts

If your CV-Hub account belongs to more than one organization, cv-agent needs
to know which one a given executor should register under.

## Quick Start

Set one of the following (in precedence order):

1. `--org <slug>` on `cva agent` or `cva setup`
2. `CV_HUB_ORG=<slug>` environment variable
3. Repo-local: `<repo-root>/.cva/agent.json` with `{"organization": "<slug>"}`
4. Global: `~/.config/cva/config.json` with `{"organization": "<slug>"}`

If none are set and your account has multiple orgs, cv-agent prompts
interactively and offers to save your choice.

## Why Repo-Local is Recommended

If you work across multiple orgs from the same machine, repo-local
persistence ensures work in one repo never accidentally registers under
another org. A workstation that has both `~/project/controlvector-work/`
and `~/project/foxconn-work/` should have a different `.cva/agent.json`
in each.

## Org-Scoped PATs

You can also mint an org-scoped Personal Access Token in CV-Hub's
settings. PATs bound to a single org skip the selection prompt entirely.
Useful for CI and headless runners.

## Example

```bash
# Explicit flag (always works)
cva agent --org controlvector --auto-approve

# Environment variable (good for CI)
CV_HUB_ORG=controlvector cva agent --auto-approve

# After first interactive prompt and saving to repo config,
# subsequent runs use the saved value automatically:
cva agent --auto-approve
# → reads controlvector from .cva/agent.json → no prompt
```

## Forward Compatibility with cv-code

The cv-code CLI (Go binary, `cvc`) uses the same design:
- Config path: `~/.config/controlvector/cvc/config.toml` (global) and `<repo>/.cvc/config.toml` (repo-local)
- Same org slug values accepted (both tools talk to the same CV-Hub)
- `.cva` and `.cvc` directories are separate so the tools coexist
