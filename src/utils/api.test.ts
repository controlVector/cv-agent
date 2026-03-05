/**
 * Tests for api.ts — CV-Hub API client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  apiCall,
  registerExecutor,
  markOffline,
  pollForTask,
  startTask,
  completeTask,
  failTask,
  sendHeartbeat,
  sendTaskLog,
  createTaskPrompt,
  pollPromptResponse,
  listExecutors,
  listTasks,
  getTask,
  getTaskLogs,
  createRepo,
} from './api';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const creds = {
  CV_HUB_PAT: 'test-token',
  CV_HUB_API: 'https://api.test.io',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('apiCall', () => {
  it('sends correct headers and body', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await apiCall(creds, 'POST', '/api/v1/test', { foo: 'bar' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test.io/api/v1/test',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ foo: 'bar' }),
      }),
    );
  });

  it('sends no body for GET requests', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await apiCall(creds, 'GET', '/api/v1/test');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test.io/api/v1/test',
      expect.objectContaining({
        method: 'GET',
        body: undefined,
      }),
    );
  });
});

describe('registerExecutor', () => {
  it('returns executor id and name on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        executor: { id: 'exec-123', name: 'cva:test-machine' },
      }),
    });

    const result = await registerExecutor(creds, 'test-machine', '/tmp');
    expect(result).toEqual({ id: 'exec-123', name: 'cva:test-machine' });
  });

  it('uses cva: prefix for executor name', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        executor: { id: 'exec-123', name: 'cva:my-machine' },
      }),
    });

    await registerExecutor(creds, 'my-machine', '/tmp');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.name).toBe('cva:my-machine');
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(registerExecutor(creds, 'test', '/tmp')).rejects.toThrow('Failed to register executor: 401');
  });
});

describe('pollForTask', () => {
  it('returns task when available', async () => {
    const task = { id: 'task-1', title: 'Test task' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ task }),
    });

    const result = await pollForTask(creds, 'exec-123');
    expect(result).toEqual(task);
  });

  it('returns null when no task', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ task: null }),
    });

    const result = await pollForTask(creds, 'exec-123');
    expect(result).toBeNull();
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(pollForTask(creds, 'exec-123')).rejects.toThrow('Poll failed: 500');
  });
});

describe('startTask', () => {
  it('succeeds silently', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(startTask(creds, 'exec-1', 'task-1')).resolves.toBeUndefined();
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(startTask(creds, 'exec-1', 'task-1')).rejects.toThrow('Start failed: 404');
  });
});

describe('completeTask', () => {
  it('sends completion payload', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await completeTask(creds, 'exec-1', 'task-1', { summary: 'done' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.summary).toBe('done');
  });
});

describe('failTask', () => {
  it('sends error message', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await failTask(creds, 'exec-1', 'task-1', 'something broke');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.error).toBe('something broke');
  });
});

describe('sendHeartbeat', () => {
  it('sends executor heartbeat', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await sendHeartbeat(creds, 'exec-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends task heartbeat when taskId provided', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await sendHeartbeat(creds, 'exec-1', 'task-1', 'running');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('sendTaskLog', () => {
  it('sends log entry', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await sendTaskLog(creds, 'exec-1', 'task-1', 'lifecycle', 'started');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.log_type).toBe('lifecycle');
    expect(body.message).toBe('started');
  });

  it('includes optional details and progress', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await sendTaskLog(creds, 'exec-1', 'task-1', 'progress', 'halfway', { step: 5 }, 50);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.details).toEqual({ step: 5 });
    expect(body.progress_pct).toBe(50);
  });
});

describe('createTaskPrompt', () => {
  it('returns prompt_id on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ prompt_id: 'prompt-123' }),
    });

    const result = await createTaskPrompt(creds, 'exec-1', 'task-1', 'Allow?', 'approval', ['y', 'n']);
    expect(result.prompt_id).toBe('prompt-123');
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });
    await expect(createTaskPrompt(creds, 'exec-1', 'task-1', 'Allow?')).rejects.toThrow('Create prompt failed');
  });
});

describe('pollPromptResponse', () => {
  it('returns response when answered', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'y' }),
    });

    const result = await pollPromptResponse(creds, 'exec-1', 'task-1', 'prompt-1');
    expect(result.response).toBe('y');
  });

  it('returns null when pending', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ response: null }),
    });

    const result = await pollPromptResponse(creds, 'exec-1', 'task-1', 'prompt-1');
    expect(result.response).toBeNull();
  });
});

describe('listExecutors', () => {
  it('returns executor list', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ executors: [{ id: 'e1' }, { id: 'e2' }] }),
    });

    const result = await listExecutors(creds);
    expect(result).toHaveLength(2);
  });
});

describe('listTasks', () => {
  it('passes status filter as query param', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tasks: [] }),
    });

    await listTasks(creds, 'running,completed');
    expect(mockFetch.mock.calls[0][0]).toContain('?status=running%2Ccompleted');
  });

  it('omits status query when not provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tasks: [] }),
    });

    await listTasks(creds);
    expect(mockFetch.mock.calls[0][0]).not.toContain('?status');
  });
});

describe('getTask', () => {
  it('returns task detail', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: 't1', title: 'Test' } }),
    });

    const result = await getTask(creds, 't1');
    expect(result.title).toBe('Test');
  });
});

describe('getTaskLogs', () => {
  it('returns logs array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ logs: [{ id: 'l1', message: 'started' }] }),
    });

    const result = await getTaskLogs(creds, 't1');
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('started');
  });
});

describe('createRepo', () => {
  it('sends repo creation request', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ repository: { id: 'r1' } }),
    });

    await createRepo(creds, 'test-repo', 'A test repo');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.name).toBe('test-repo');
    expect(body.description).toBe('A test repo');
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => 'already exists',
    });

    await expect(createRepo(creds, 'test')).rejects.toThrow('Create repo failed: 409');
  });
});

describe('markOffline', () => {
  it('does not throw on failure', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    await expect(markOffline(creds, 'exec-1')).resolves.toBeUndefined();
  });
});
