/**
 * Tests for deploy manifest
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadDeployManifest, postTaskDeploy, type DeployManifest } from './deploy-manifest';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockExists = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFileSync);
const mockExecSync = vi.mocked(execSync);

const MANIFEST: DeployManifest = {
  version: 1,
  build: {
    steps: [{ name: 'backend', command: 'make build', timeout_seconds: 60 }],
  },
  service: {
    type: 'manual',
    name: 'test-svc',
    restart_command: 'systemctl restart test',
    startup_wait_seconds: 1,
  },
  verify: {
    health_url: 'http://localhost:3000/health',
    timeout_seconds: 5,
    smoke_tests: [],
  },
};

describe('loadDeployManifest', () => {
  beforeEach(() => {
    mockExists.mockReset();
    mockReadFile.mockReset();
  });

  it('returns null when .cva/deploy.json does not exist', () => {
    mockExists.mockReturnValue(false);
    expect(loadDeployManifest('/workspace')).toBeNull();
  });

  it('returns parsed manifest when file exists', () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(JSON.stringify(MANIFEST));
    const result = loadDeployManifest('/workspace');
    expect(result?.version).toBe(1);
    expect(result?.build?.steps).toHaveLength(1);
  });

  it('returns null for invalid JSON', () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue('not json');
    expect(loadDeployManifest('/workspace')).toBeNull();
  });

  it('returns null for version 0', () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(JSON.stringify({ version: 0 }));
    expect(loadDeployManifest('/workspace')).toBeNull();
  });
});

describe('postTaskDeploy', () => {
  const mockLog = vi.fn();

  beforeEach(() => {
    mockExists.mockReset();
    mockReadFile.mockReset();
    mockExecSync.mockReset();
    mockLog.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns skipped when no manifest exists', async () => {
    mockExists.mockReturnValue(false);
    const result = await postTaskDeploy('/workspace', 'task-1', mockLog);
    expect(result.deployed).toBe(false);
    expect(result.steps[0].status).toBe('skipped');
  });

  it('runs build steps and reports failure', async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(JSON.stringify({
      version: 1,
      build: { steps: [{ name: 'backend', command: 'make fail' }] },
    }));
    // git rev-parse HEAD for preDeployCommit
    mockExecSync.mockReturnValueOnce('abc123');
    // make fail — throw to simulate failure
    mockExecSync.mockImplementationOnce(() => { throw Object.assign(new Error('exit 1'), { stderr: 'compile error' }); });

    const result = await postTaskDeploy('/workspace', 'task-1', mockLog);
    expect(result.deployed).toBe(false);
    expect(result.error).toContain('Build failed');
  });

  it('succeeds when all steps pass', async () => {
    mockExists.mockReturnValue(true);
    mockReadFile.mockReturnValue(JSON.stringify({
      version: 1,
      build: { steps: [{ name: 'be', command: 'echo ok' }] },
      service: { type: 'none' },
      verify: { health_url: 'http://localhost:3000/health', timeout_seconds: 2 },
    }));
    // preDeployCommit
    mockExecSync.mockReturnValueOnce('abc123');
    // build step
    mockExecSync.mockReturnValueOnce('ok');

    // Health check fetch
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await postTaskDeploy('/workspace', 'task-1', mockLog);
    expect(result.deployed).toBe(true);
  });
});
