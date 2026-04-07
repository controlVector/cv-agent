# Process Management in CV-Agent

## Problem Statement

CV-Agent tasks frequently need to interact with long-running processes — starting servers, restarting services, managing tunnels. Today this is done ad-hoc via `nohup` and `&`, leading to:

1. **Self-inflicted SIGTERM**: Agent restarts a server that hosts the tunnel it communicates through, killing itself mid-task.
2. **Orphaned processes**: Background processes started by tasks persist after the agent exits, with no tracking or cleanup.
3. **PID ignorance**: The agent has no awareness of what processes it or its tasks have started, making diagnosis impossible.
4. **Circular dependencies**: Restarting the MCP server from within a task dispatched through that same MCP server.

### Real-World Failure (April 2026)

The `cva:tastytrade-mcp` executor was tasked with restarting the tastytrade MCP server. The server hosts the Cloudflare tunnel that the agent itself connects through. When the task killed the server process, it severed the tunnel, which sent SIGTERM to the agent, aborting the task. The pending follow-up task sat in the queue with no executor to claim it.

---

## Rules for Task Authors (CLAUDE.md content)

These rules should be added to any repo's CLAUDE.md where the cv-agent operates:

```markdown
## Process Management Rules

### NEVER restart the MCP server or tunnel from inside a task
The cv-agent connects to CV-Hub through infrastructure that may share the
same process tree. Restarting servers, tunnels, or network services can
sever the agent's connection, abort the task, and leave the agent offline.

**For service restarts:** Complete the code change, commit, push, and
report. State explicitly that a manual restart is required. Do NOT attempt
to kill/restart node processes, cloudflared, or any network service.

### Background processes (nohup, &, disown)
- NEVER start background processes during a task
- If a task requires starting a service, write a startup script and report
  that it needs to be run manually by the operator
- If you must check a process, use read-only commands (ps, pgrep, lsof)

### Deploy tasks
Deploy tasks should ONLY: build, commit, push, and report.
The planner or operator handles the actual service restart.
```

---

## PID Management Design

### Overview

Add a `ProcessRegistry` to cv-agent that tracks all child processes spawned during task execution. This provides visibility, cleanup on exit, and guards against circular dependency kills.

### Architecture

```
┌──────────────────────────────────────────┐
│ cv-agent process (main)                  │
│                                          │
│  ┌─────────────────────────────────────┐ │
│  │ ProcessRegistry (singleton)         │ │
│  │                                     │ │
│  │  registry: Map<pid, ProcessEntry>   │ │
│  │  protectedPids: Set<pid>           │ │
│  │                                     │ │
│  │  register(pid, meta) → void        │ │
│  │  unregister(pid) → void            │ │
│  │  protect(pid) → void               │ │
│  │  killAll(signal?) → Promise<void>  │ │
│  │  isProtected(pid) → boolean        │ │
│  │  snapshot() → ProcessEntry[]       │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  ┌──────────┐  ┌──────────┐             │
│  │ Task A   │  │ Task B   │   ...       │
│  │ (Claude) │  │ (Claude) │             │
│  └──────────┘  └──────────┘             │
└──────────────────────────────────────────┘
```

### ProcessEntry Schema

```typescript
interface ProcessEntry {
  pid: number;
  taskId: string | null;      // which task spawned it, null = agent-owned
  command: string;             // the command that was run
  startedAt: Date;
  role: 'task-child' | 'agent-infra' | 'external';
  protected: boolean;          // if true, killAll() skips this process
  notes?: string;              // human-readable context
}
```

### Protected Processes

On startup, the agent should detect and register infrastructure processes it depends on:

```typescript
// On agent boot:
const tunnelPid = await findPidByPort(3100);  // or by process name
if (tunnelPid) {
  registry.register(tunnelPid, {
    taskId: null,
    command: 'cloudflared tunnel',
    role: 'agent-infra',
    protected: true,
    notes: 'Cloudflare tunnel — killing this severs agent connection'
  });
}

const mcpServerPid = await findPidByCommand('node.*dist/index.js');
if (mcpServerPid) {
  registry.register(mcpServerPid, {
    taskId: null,
    command: 'node dist/index.js',
    role: 'agent-infra',
    protected: true,
    notes: 'MCP server — killing this severs Claude.ai connection'
  });
}
```

### Kill Guard

Before any `kill` command in a task, intercept and check:

```typescript
// In the bash tool wrapper or command interceptor:
function guardedKill(pid: number, signal: string = 'SIGTERM'): boolean {
  if (registry.isProtected(pid)) {
    console.warn(`⛔ BLOCKED: Cannot kill PID ${pid} — protected process`);
    console.warn(`   ${registry.get(pid)?.notes}`);
    return false;
  }
  // Allow the kill to proceed
  return true;
}
```

This can be implemented as a pre-exec hook on the bash tool. When a task runs `kill <pid>` or `kill $(pgrep ...)`, the agent resolves the PID(s) and checks the registry before allowing execution.

### Lifecycle Hooks

```typescript
// In installSignalHandlers() — already exists in agent.ts:
process.on('SIGTERM', async () => {
  log('Received SIGTERM — cleaning up child processes');
  await registry.killAll('SIGTERM');  // kills task-children, skips protected
  // existing shutdown logic...
});

// On task completion:
async function onTaskComplete(taskId: string) {
  const taskProcesses = registry.snapshot()
    .filter(p => p.taskId === taskId && !p.protected);

  if (taskProcesses.length > 0) {
    log(`Cleaning up ${taskProcesses.length} processes from task ${taskId}`);
    for (const proc of taskProcesses) {
      process.kill(proc.pid, 'SIGTERM');
      registry.unregister(proc.pid);
    }
  }
}
```

### PID File for External Visibility

Write a JSON PID file so operators and other tools can see what the agent is managing:

```typescript
// Write on every registry change:
const PID_FILE = path.join(workspaceRoot, '.cv-agent-pids.json');

function writePidFile() {
  const data = {
    agentPid: process.pid,
    agentStartedAt: agentStartTime.toISOString(),
    processes: registry.snapshot(),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(PID_FILE, JSON.stringify(data, null, 2));
}

// Clean up on exit:
process.on('exit', () => {
  try { fs.unlinkSync(PID_FILE); } catch {}
});
```

### Task Output Timestamps

Currently task events lack timestamps, making it hard to correlate with external logs. Add timestamps to all task event output:

```typescript
interface TaskEvent {
  timestamp: string;    // ISO 8601 — ADD THIS
  type: 'thinking' | 'decision' | 'progress' | 'question' | 'error';
  content: string;
  taskId: string;
}

// In parseClaudeCodeOutput() and event emission:
function emitEvent(type: string, content: string, taskId: string) {
  const event: TaskEvent = {
    timestamp: new Date().toISOString(),  // <-- always include
    type,
    content,
    taskId
  };
  // emit to CV-Hub...
}
```

### CLI Additions

```bash
# Show what the agent is managing:
cv agent pids
# Output:
# PID    ROLE          PROTECTED  TASK                   COMMAND
# 1234   agent-infra   ✓          —                      cloudflared tunnel...
# 5678   agent-infra   ✓          —                      node dist/index.js
# 9012   task-child    ✗          68c610bc...            npm run build

# Force-clean orphans from a specific task:
cv agent cleanup --task 68c610bc

# Show the PID file:
cv agent pids --json
```

---

## Implementation Priority

1. **P0 (now)**: Add CLAUDE.md rules to tastytrade-mcp and any other repos where deploy tasks run — prevents the immediate failure mode
2. **P1 (this sprint)**: `ProcessRegistry` class + PID file + integration into `installSignalHandlers`
3. **P1 (this sprint)**: Timestamps on all task events
4. **P2 (next sprint)**: Kill guard / bash tool interception
5. **P2 (next sprint)**: `cv agent pids` CLI command
6. **P3 (backlog)**: Auto-discovery of infrastructure processes on boot
