# CV-Agent

**Remote task dispatch daemon for CV-Hub. Bridges Claude Code with CV-Hub's agentic task system.**

CV-Agent (`cva`) runs as a daemon on your machine, polls CV-Hub for dispatched tasks, spawns Claude Code to execute them, and reports results back. It handles permission relay, git remote management, and executor heartbeats.

[![npm](https://img.shields.io/npm/v/@controlvector/cv-agent)](https://www.npmjs.com/package/@controlvector/cv-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Installation

```bash
npm install -g @controlvector/cv-agent
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code) to be installed and on your PATH.

---

## Quick Start

```bash
# Authenticate with CV-Hub
cva auth login

# Add the CV-Hub remote to your repo
cd your-project
cva remote add

# Start the agent daemon (auto-approves Claude Code tool permissions)
cva agent --auto-approve
```

The agent will register as an executor with CV-Hub, poll for tasks, and execute them using Claude Code.

---

## Commands

### `cva agent [options]`

Start the agent daemon. Polls CV-Hub for pending tasks and executes them with Claude Code.

```bash
cva agent                  # Start with permission relay to CV-Hub
cva agent --auto-approve   # Auto-approve all Claude Code permissions locally
cva agent --dir /path      # Override working directory
```

Options:
- `--auto-approve` — Auto-approve all tool permission prompts (no CV-Hub relay)
- `--dir <path>` — Working directory for Claude Code sessions

### `cva auth login`

Authenticate with CV-Hub. Opens a browser for device auth flow, or accepts a token paste.

```bash
cva auth login
```

Token is stored in `~/.cva/config.json`.

### `cva remote add [--name <n>]`

Add or update the CV-Hub git remote for the current repository.

```bash
cva remote add                          # Auto-detects from CV-Hub
cva remote add --name cvhub             # Custom remote name (default: cvhub)
```

### `cva remote setup <owner/repo>`

Create a repo on CV-Hub and configure the local remote in one step.

### `cva task list [--status <status>]`

List tasks for the current executor.

### `cva task logs <task-id>`

Stream task logs and progress.

### `cva status`

Show executor registration status, active tasks, and recent completions.

---

## How It Works

1. `cva agent` registers this machine as an **executor** with CV-Hub
2. It polls CV-Hub every 5 seconds for pending tasks
3. When a task is claimed, it spawns Claude Code with the task prompt
4. **Permission handling**: Claude Code tool calls require approval:
   - `--auto-approve`: writes `y` to stdin automatically
   - Default: relays prompts to CV-Hub for remote approval (e.g., from Claude.ai)
5. When Claude Code exits, the agent reports the result (files changed, commits, exit code) to CV-Hub
6. Heartbeats are sent every 30 seconds to keep the executor registration alive

### Git Remote Management

Before each task, the agent ensures a `cvhub` remote exists pointing to the correct CV-Hub repo URL. Task prompts are prepended with instructions to push to `cvhub` instead of `origin`.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 20 | Runtime |
| Claude Code | Latest | Must be on PATH as `claude` |
| CV-Hub account | — | Sign up at [hub.controlvector.io](https://hub.controlvector.io) |

---

## Configuration

Config file: `~/.cva/config.json`

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
    "maxConcurrentTasks": 1
  },
  "defaults": {
    "remoteName": "cvhub"
  }
}
```

---

## Why a Separate Binary?

CV-Git (`cv`) and CV-Agent (`cva`) are separate packages to avoid a recursion trap: `cv agent` would spawn Claude Code, which might call `cv` commands, creating a circular dependency. By using `cva` as the agent binary, Claude Code sessions use standard `git` commands only.

| Binary | Package | Responsibility |
|--------|---------|---------------|
| `cv` | `@controlvector/cv-git` | Git operations, knowledge graph, code analysis, local dev |
| `cva` | `@controlvector/cv-agent` | Agent daemon, task dispatch, CV-Hub remote management |

---

## Related Projects

- [CV-Git](https://www.npmjs.com/package/@controlvector/cv-git) (`cv`) — AI-native version control CLI
- [CV-Hub](https://hub.controlvector.io) — AI-native Git platform (web app + API)

---

## License

MIT
