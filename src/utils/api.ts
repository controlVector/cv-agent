/**
 * CV-Hub API client for the cva agent.
 *
 * Extracted from cv-git agent.ts with additional endpoints for
 * listing executors, tasks, logs, and creating repos.
 */

import type { CVHubCredentials } from './credentials.js';

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

export async function registerExecutor(
  creds: CVHubCredentials,
  machineName: string,
  workingDir: string,
): Promise<{ id: string; name: string }> {
  const hostname = (await import('node:os')).hostname();
  const res = await apiCall(creds, 'POST', '/api/v1/executors', {
    name: `cva:${machineName}`,
    machine_name: machineName,
    type: 'claude_code',
    workspace_root: workingDir,
    capabilities: {
      tools: ['bash', 'read', 'write', 'edit', 'glob', 'grep'],
      maxConcurrentTasks: 1,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to register executor: ${res.status} ${err}`);
  }

  const data = await res.json() as any;
  return { id: data.executor.id, name: data.executor.name };
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
): Promise<void> {
  await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/heartbeat`).catch(() => {});
  if (taskId) {
    const body = message ? { message, log_type: 'heartbeat' } : undefined;
    await apiCall(creds, 'POST', `/api/v1/executors/${executorId}/tasks/${taskId}/heartbeat`, body).catch(() => {});
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
