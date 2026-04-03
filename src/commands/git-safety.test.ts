/**
 * Tests for git safety net
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { gitSafetyNet } from './git-safety';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

describe('gitSafetyNet', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns no changes when git status is clean and nothing unpushed', () => {
    // git status --porcelain returns empty
    mockExecSync.mockReturnValueOnce('');
    // git log origin/main..HEAD returns empty
    mockExecSync.mockReturnValueOnce('');

    const result = gitSafetyNet('/workspace', 'Test task', 'abc12345-def', 'main');
    expect(result.hadChanges).toBe(false);
    expect(result.pushed).toBe(false);
  });

  it('pushes when there are unpushed commits but no local changes', () => {
    // git status --porcelain returns empty
    mockExecSync.mockReturnValueOnce('');
    // git log origin/main..HEAD returns unpushed commits
    mockExecSync.mockReturnValueOnce('abc1234 some commit\ndef5678 another commit');
    // git push succeeds
    mockExecSync.mockReturnValueOnce('');

    const result = gitSafetyNet('/workspace', 'Test task', 'abc12345-def', 'main');
    expect(result.hadChanges).toBe(false);
    expect(result.pushed).toBe(true);
  });

  it('commits and pushes untracked files', () => {
    // git status --porcelain returns untracked files
    mockExecSync.mockReturnValueOnce('?? src/new-file.ts\n?? src/another.ts');
    // git add -A
    mockExecSync.mockReturnValueOnce('');
    // git commit
    mockExecSync.mockReturnValueOnce('[main abc1234] task: Test task [abc12345]');
    // git push
    mockExecSync.mockReturnValueOnce('');

    const result = gitSafetyNet('/workspace', 'Test task', 'abc12345-def', 'main');
    expect(result.hadChanges).toBe(true);
    expect(result.filesAdded).toBe(2);
    expect(result.commitSha).toBe('abc1234');
    expect(result.pushed).toBe(true);
  });

  it('commits modified and deleted files', () => {
    mockExecSync.mockReturnValueOnce(' M src/changed.ts\n D src/removed.ts');
    mockExecSync.mockReturnValueOnce(''); // git add
    mockExecSync.mockReturnValueOnce('[main def5678] task: Fix bug [abc12345]'); // git commit
    mockExecSync.mockReturnValueOnce(''); // git push

    const result = gitSafetyNet('/workspace', 'Fix bug', 'abc12345-def', 'main');
    expect(result.hadChanges).toBe(true);
    expect(result.filesModified).toBe(1);
    expect(result.filesDeleted).toBe(1);
    expect(result.pushed).toBe(true);
  });

  it('reports push failure without crashing', () => {
    mockExecSync.mockReturnValueOnce('?? new-file.ts');
    mockExecSync.mockReturnValueOnce(''); // git add
    mockExecSync.mockReturnValueOnce('[main abc1234] task: T [abc12345]'); // git commit
    mockExecSync.mockImplementationOnce(() => { throw new Error('push rejected'); }); // git push fails

    const result = gitSafetyNet('/workspace', 'T', 'abc12345', 'main');
    expect(result.hadChanges).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.error).toContain('Push failed');
  });

  it('handles git status failure gracefully', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('not a git repo'); });

    const result = gitSafetyNet('/workspace', 'T', 'abc', 'main');
    expect(result.hadChanges).toBe(false);
    expect(result.error).toContain('git status failed');
  });

  it('uses default branch "main" when none specified', () => {
    mockExecSync.mockReturnValueOnce('');
    mockExecSync.mockReturnValueOnce('abc123 commit');
    mockExecSync.mockReturnValueOnce('');

    gitSafetyNet('/workspace', 'T', 'abc', undefined);

    // Second call should reference origin/main
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('origin/main'),
      expect.any(Object),
    );
  });
});
