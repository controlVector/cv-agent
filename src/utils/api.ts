/**
 * CV-Hub API client for the cva agent.
 *
 * Extracted from cv-git agent.ts with additional endpoints for
 * listing executors, tasks, logs, and creating repos.
 */

import type { CVHubCredentials } from './credentials.js';
import chalk from 'chalk';

// ============================================================================
// Core API call
// ============================================================================

export async function apiCall(
  creds: CVHubCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `${creds.CV_HUB_API}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${creds.CV_HUB_PAT}`,
    'Content-Type': 'application/json',
  };
  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ============================================================================
// Executor lifecycle
// ============================================================================

export interface ExecutorRegistrationMetadata {
  role?: string;
  integration?: {
    system: string;
    description?: string;
    service_port?: number;
    safe_task_types?: string[];
    unsafe_task_types?: string[];
    self_referential?: boolean;
  };
  tags?: string[];
  owner_project?: string;
  dispatch_guard?: string;
}

export async function registerExecutor(
  creds: CVHubCredentials,
  machineName: string,
  workingDir: string,
  repositoryId?: string,
  metadata?: ExecutorRegistrationMetadata,
  orgOptions?: { cliFlag?: string; repoOwnerSlug?: string; cwd?: string },
): Promise<{ id: string; name: string }> {
  const {
    resolveOrg,
    resolveToUUID,
    pickOrg,
    confirmAutoMatch,
    promptPersistScope,
    persistOrg,
    parseMultiOrgError,
  } = await import('./org-resolver.js');

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

  // Executor identity metadata
  if (metadata?.role) body.role = metadata.role;
  if (metadata?.dispatch_guard) body.dispatch_guard = metadata.dispatch_guard;
  if (metadata?.tags) body.tags = metadata.tags;
  if (metadata?.owner_project) body.owner_project = metadata.owner_project;
  if (metadata?.integration) body.integration = metadata.integration;

  // Resolve org from config chain: CLI > env > repo-local > global
  const resolved = resolveOrg({
    cliFlag: orgOptions?.cliFlag,
    cwd: orgOptions?.cwd || workingDir,
  });

  // If we have a resolved org value, we'll use it on the retry if needed
  // Don't send it on the first attempt — let the server try its own inference
  // (from repository_id) first. Only add it if we get the multi-org 400.

  let res = await apiCall(creds, 'POST', '/api/v1/executors', body);

  // Handle multi-org 400
  if (res.status === 400) {
    const errBody = await res.text();
    const orgs = parseMultiOrgError(res.status, errBody);

    if (orgs) {
      // Strategy 1: Use resolved config value
      if (resolved.value) {
        try {
          const orgId = resolveToUUID(resolved.value, orgs);
          body.organization_id = orgId;
          res = await apiCall(creds, 'POST', '/api/v1/executors', body);
        } catch (e: any) {
          throw new Error(
            `Organization "${resolved.value}" (from ${resolved.source}) is invalid. ${e.message}`
          );
        }
      }
      // Strategy 2: Auto-match from repo owner slug (requires one-time confirmation)
      let autoMatchHandled = false;
      if (!resolved.value && orgOptions?.repoOwnerSlug) {
        const match = orgs.find(
          o => o.slug.toLowerCase() === orgOptions.repoOwnerSlug!.toLowerCase()
        );
        if (match) {
          // Non-interactive: fail loud, don't silently register
          if (!process.stdout.isTTY) {
            throw new Error(
              `Auto-matched "${match.slug}" from repo owner, but running non-interactively. ` +
              `Set CV_HUB_ORG=${match.slug} or pass --org ${match.slug} to confirm, ` +
              `or pick a different org from: ${orgs.map(o => o.slug).join(', ')}.`
            );
          }

          const decision = await confirmAutoMatch(match, orgOptions.repoOwnerSlug);

          if (decision === 'accept') {
            const scope = await promptPersistScope();
            if (scope !== 'none') {
              const savedPath = persistOrg(match.slug, scope, orgOptions?.cwd || workingDir);
              console.log(chalk.gray(`  Saved to ${savedPath}`));
            }
            body.organization_id = match.id;
            res = await apiCall(creds, 'POST', '/api/v1/executors', body);
            autoMatchHandled = true;
          } else if (decision === 'abort') {
            throw new Error(
              'Registration aborted. Set CV_HUB_ORG or use --org to choose an org non-interactively.'
            );
          }
          // decision === 'pick' → fall through to Strategy 3
        }
      }

      // Strategy 3: Full interactive picker (if nothing above resolved)
      if (!autoMatchHandled && !res.ok) {
        const picked = await pickOrg(orgs, {
          interactive: true,
          cwd: orgOptions?.cwd || workingDir,
        });

        if (picked.persistScope !== 'none') {
          const savedPath = persistOrg(picked.chosen.slug, picked.persistScope, orgOptions?.cwd || workingDir);
          console.log(chalk.gray(`  Saved to ${savedPath}`));
        }

        body.organization_id = picked.chosen.id;
        res = await apiCall(creds, 'POST', '/api/v1/executors', body);
      }
    } else {
      // Not a multi-org error — throw the original error
      throw new Error(`Failed to register executor: ${res.status} ${errBody}`);
    }
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to register executor: ${res.status} ${err}`);
  }

  const data = await res.json() as any;
  return { id: data.executor.id, name: data.executor.name };
}

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

export async function markOffline(
  creds: CVHubCredentials,
  executorId: string,
): Promise<void> {
  await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/offline`).catch(() => {});
}

// ============================================================================
// Task lifecycle
// ============================================================================

export async function pollForTask(
  creds: CVHubCredentials,
  executorId: string,
): Promise<any | null> {
  const res = await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/poll`);
  if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
  const data = await res.json() as any;
  return data.task || null;
}

export async function startTask(
  creds: CVHubCredentials,
  executorId: string,
  taskId: string,
): Promise<void> {
  const res = await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/tasks/${taskId}/start`);
  if (!res.ok) throw new Error(`Start failed: ${res.status}`);
}

export async function completeTask(
  creds: CVHubCredentials,
  executorId: string,
  taskId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const res = await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/tasks/${taskId}/complete`, result);
  if (!res.ok) throw new Error(`Complete failed: ${res.status}`);
}

export async function failTask(
  creds: CVHubCredentials,
  executorId: string,
  taskId: string,
  error: string,
): Promise<void> {
  const res = await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/tasks/${taskId}/fail`, { error });
  if (!res.ok) throw new Error(`Fail failed: ${res.status}`);
}

export async function sendHeartbeat(
  creds: CVHubCredentials,
  executorId: string,
  taskId?: string,
  message?: string,
  authStatus?: string,
): Promise<void> {
  const body: Record<string, unknown> | undefined = authStatus ? { auth_status: authStatus } : undefined;
  await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/heartbeat`, body).catch(() => {});
  if (taskId) {
    const taskBody = message ? { message, log_type: 'heartbeat' } : undefined;
    await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/tasks/${taskId}/heartbeat`, taskBody).catch(() => {});
  }
}

export async function sendTaskLog(
  creds: CVHubCredentials,
  executorId: string,
  taskId: string,
  logType: string,
  message: string,
  details?: Record<string, unknown>,
  progressPct?: number,
): Promise<void> {
  await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/tasks/${taskId}/log`, {
    log_type: logType,
    message,
    ...(details ? { details } : {}),
    ...(progressPct !== undefined ? { progress_pct: progressPct } : {}),
  }).catch(() => {});
}

// ============================================================================
// Prompt relay (for relay mode)
// ============================================================================

export async function createTaskPrompt(
  creds: CVHubCredentials,
  executorId: string,
  taskId: string,
  promptText: string,
  promptType: string = 'approval',
  options?: string[],
  context?: Record<string, unknown>,
): Promise<{ prompt_id: string }> {
  const res = await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/tasks/${taskId}/prompt`, {
    type: promptType,
    text: promptText,
    ...(options ? { options } : {}),
    ...(context ? { context } : {}),
  });
  if (!res.ok) throw new Error(`Create prompt failed: ${res.status}`);
  return await res.json() as { prompt_id: string };
}

export async function pollPromptResponse(
  creds: CVHubCredentials,
  executorId: string,
  taskId: string,
  promptId: string,
): Promise<{ response: string | null }> {
  const res = await apiCall(creds, 'GET', `/api/v1/executors/${executorId}/tasks/${taskId}/prompts/${promptId}`);
  if (!res.ok) throw new Error(`Poll prompt failed: ${res.status}`);
  const data = await res.json() as any;
  return { response: data.response ?? null };
}

// ============================================================================
// New listing endpoints
// ============================================================================

export async function listExecutors(
  creds: CVHubCredentials,
): Promise<any[]> {
  const res = await apiCall(creds, 'GET', '/api/v1/executors');
  if (!res.ok) throw new Error(`List executors failed: ${res.status}`);
  const data = await res.json() as any;
  return data.executors || [];
}

export async function listTasks(
  creds: CVHubCredentials,
  status?: string,
): Promise<any[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await apiCall(creds, 'GET', `/api/v1/tasks${qs}`);
  if (!res.ok) throw new Error(`List tasks failed: ${res.status}`);
  const data = await res.json() as any;
  return data.tasks || [];
}

export async function getTask(
  creds: CVHubCredentials,
  taskId: string,
): Promise<any> {
  const res = await apiCall(creds, 'GET', `/api/v1/tasks/${taskId}`);
  if (!res.ok) throw new Error(`Get task failed: ${res.status}`);
  const data = await res.json() as any;
  return data.task;
}

export async function getTaskLogs(
  creds: CVHubCredentials,
  taskId: string,
): Promise<any[]> {
  const res = await apiCall(creds, 'GET', `/api/v1/tasks/${taskId}/logs`);
  if (!res.ok) throw new Error(`Get task logs failed: ${res.status}`);
  const data = await res.json() as any;
  return data.logs || [];
}

// ============================================================================
// Task events (structured streaming events)
// ============================================================================

export async function postTaskEvent(
  creds: CVHubCredentials,
  taskId: string,
  event: {
    event_type: string;
    content: Record<string, unknown> | string;
    needs_response?: boolean;
    sequence_number?: number;
  },
): Promise<{ id: string; event_type: string }> {
  const res = await apiCall(creds, 'POST', `/api/v1/tasks/${taskId}/events`, event);
  if (!res.ok) throw new Error(`Post event failed: ${res.status}`);
  return await res.json() as any;
}

export async function getEventResponse(
  creds: CVHubCredentials,
  taskId: string,
  eventId: string,
): Promise<{ response: unknown | null; responded_at: string | null }> {
  const res = await apiCall(creds, 'GET', `/api/v1/tasks/${taskId}/events?after_id=&limit=200`);
  if (!res.ok) throw new Error(`Get events failed: ${res.status}`);
  const events = await res.json() as any[];
  const event = events.find((e: any) => e.id === eventId);
  return {
    response: event?.response ?? null,
    responded_at: event?.respondedAt ?? event?.responded_at ?? null,
  };
}

export async function getRedirects(
  creds: CVHubCredentials,
  taskId: string,
  afterTimestamp?: string,
): Promise<Array<{ id: string; content: { instruction: string } }>> {
  const qs = afterTimestamp ? `?after_timestamp=${encodeURIComponent(afterTimestamp)}` : '';
  const res = await apiCall(creds, 'GET', `/api/v1/tasks/${taskId}/events${qs}`);
  if (!res.ok) return [];
  const events = await res.json() as any[];
  return events
    .filter((e: any) => (e.eventType ?? e.event_type) === 'redirect')
    .map((e: any) => ({ id: e.id, content: e.content }));
}

// ============================================================================
// Repository management
// ============================================================================

export async function createRepo(
  creds: CVHubCredentials,
  name: string,
  description?: string,
): Promise<any> {
  const res = await apiCall(creds, 'POST', '/api/v1/repos', {
    name,
    ...(description ? { description } : {}),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Create repo failed: ${res.status} ${err}`);
  }
  return await res.json();
}
