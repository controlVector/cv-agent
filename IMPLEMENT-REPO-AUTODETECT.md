# CV-Agent Fix: Auto-Detect Repository on Registration + Pass repository_id

## Problem

When `cva agent` starts, it registers with CV-Hub but sends `repository_id: null` even when the working directory IS a CV-Hub repository. The new server-side affinity routing (Pass 2 in `claimNextTask`) needs executor `repository_id` bindings to match tasks to the correct executor.

## Changes Required

### 1. `src/utils/api.ts` — Update `registerExecutor()` + Add `resolveRepoId()`

**Update `registerExecutor` to accept and pass `repositoryId`:**

Replace the current function:

```typescript
export async function registerExecutor(
  creds: CVHubCredentials,
  machineName: string,
  workingDir: string,
  repositoryId?: string,
): Promise<{ id: string; name: string }> {
  const body: Record<string, unknown> = {
    name: `cva:${machineName}`,
    machine_name: machineName,
    type: 'claude_code',
    workspace_root: workingDir,
    capabilities: {
      tools: ['bash', 'read', 'write', 'edit', 'glob', 'grep'],
      maxConcurrentTasks: 1,
    },
  };

  if (repositoryId) {
    body.repository_id = repositoryId;
  }

  const res = await apiCall(creds, 'POST', '/api/v1/executors', body);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to register executor: ${res.status} ${err}`);
  }

  const data = await res.json() as any;
  return { id: data.executor.id, name: data.executor.name };
}
```

**Add `resolveRepoId` helper at the bottom of the file:**

```typescript
export async function resolveRepoId(
  creds: CVHubCredentials,
  owner: string,
  repo: string,
): Promise<{ id: string; slug: string } | null> {
  try {
    const res = await apiCall(creds, 'GET', `/api/v1/repos/${owner}/${repo}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.repository
      ? { id: data.repository.id, slug: data.repository.slug }
      : null;
  } catch {
    return null;
  }
}
```

### 2. `src/commands/agent.ts` — Auto-Detect Repo Before Registration

In `runAgent()`, find the section where `registerExecutor` is called. It looks like:

```typescript
const executor = await withRetry(
  () => registerExecutor(creds, machineName, workingDir),
  'Executor registration',
);
```

**Add repo auto-detection BEFORE that call:**

```typescript
// ── Auto-detect CV-Hub repository from git remote ────────────────
let detectedRepoId: string | undefined;
try {
  const remoteUrl = execSync('git remote get-url origin 2>/dev/null', {
    cwd: workingDir,
    encoding: 'utf8',
    timeout: 5000,
  }).trim();

  // Match CV-Hub remote URL patterns:
  //   https://git.hub.controlvector.io/owner/repo.git
  //   git@git.hub.controlvector.io:owner/repo.git
  const cvHubMatch = remoteUrl.match(
    /git\.hub\.controlvector\.io[:/]([^/]+)\/([^/.]+)/
  );

  if (cvHubMatch) {
    const [, repoOwner, repoSlug] = cvHubMatch;
    const repoData = await resolveRepoId(creds, repoOwner, repoSlug);
    if (repoData?.id) {
      detectedRepoId = repoData.id;
    }
  }
} catch {
  // Not a git repo or no CV-Hub remote — register without repo binding
}
```

**Then update the registerExecutor call:**

```typescript
const executor = await withRetry(
  () => registerExecutor(creds, machineName, workingDir, detectedRepoId),
  'Executor registration',
);
```

**Add the import** for `resolveRepoId` at the top of the file — it's already in the same utils/api module:

```typescript
import {
  registerExecutor,
  pollForTask,
  startTask,
  completeTask,
  failTask,
  sendHeartbeat,
  sendTaskLog,
  markOffline,
  createTaskPrompt,
  pollPromptResponse,
  postTaskEvent,
  getEventResponse,
  getRedirects,
  resolveRepoId,          // ADD THIS
} from '../utils/api.js';
```

**Update the banner display** to show the detected repo (after the executor is registered, where the existing console.log lines are):

Add after the `Dir:` line:
```typescript
if (detectedRepoId) {
  console.log(`   Repo:     ${chalk.cyan(detectedRepoId.slice(0, 8) + '...')}`);
}
```

### 3. Build + Publish

```bash
npm run build
npm version minor -m "feat: auto-detect repository_id on registration"
npm publish
```

### 4. Update on All Machines

After publishing, update on z840 (or wherever agents run):

```bash
npm install -g @controlvector/cv-agent@latest
```

Then restart all agent sessions so they re-register with repository_id:

```bash
# Kill existing agents
pkill -f "cva agent" || true

# Restart each agent in its workspace
cd /home/schmotz/project/tastytrade-mcp && nohup cva agent --auto-approve > /tmp/cva-tastytrade.log 2>&1 &
cd /home/schmotz/speranza && nohup cva agent --auto-approve > /tmp/cva-speranza.log 2>&1 &
cd /home/schmotz/nyxIndustries/github/nyxCore && nohup cva agent --auto-approve > /tmp/cva-nyxcore.log 2>&1 &
cd /home/schmotz/nyxIndustries/github/nyxForge && nohup cva agent --auto-approve > /tmp/cva-nyxforge.log 2>&1 &
```

## Constraints

- Do NOT break existing functionality — registration without a repo must still work
- The git remote check must be wrapped in try/catch (not all workspaces are git repos)
- The resolveRepoId API call must be non-fatal (executor still registers if it fails)
- Do NOT modify any cv-hub code (that's already deployed)

## Verification

After restarting agents, check that executors now have repository_id set:

```bash
curl -s https://api.hub.controlvector.io/api/v1/executors \
  -H "Authorization: Bearer $CV_HUB_PAT" | jq '.executors[] | {name, repository_id}'
```

Expected: tastytrade-mcp, NyxCore, NyxForge, speranza should all have non-null repository_id values (if their working directories have CV-Hub git remotes).
