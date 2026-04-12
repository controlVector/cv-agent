/**
 * Tests for git safety net
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { gitSafetyNet } from './git-safety';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);

describe('gitSafetyNet', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    // Default: workspace has .git
    mockExistsSync.mockReturnValue(true);
  });

  it('BLOCKS when workspace is user HOME directory', () => {
    const result = gitSafetyNet('/home/testuser', 'Test', 'abc', 'main');
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('HOME directory');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('BLOCKS when workspace has no .git directory', () => {
    mockExistsSync.mockReturnValue(false);
    const result = gitSafetyNet('/workspace', 'Test', 'abc', 'main');
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('Not a git repository');
  });

  it('returns no changes when git status is clean', () => {
    mockExecSync.mockReturnValueOnce(''); // git status
    mockExecSync.mockReturnValueOnce(''); // git log unpushed

    const result = gitSafetyNet('/workspace', 'Test', 'abc', 'main');
    expect(result.hadChanges).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.skipped).toBeUndefined();
  });

  it('pushes unpushed commits', () => {
    mockExecSync.mockReturnValueOnce('');
    mockExecSync.mockReturnValueOnce('abc1234 some commit');
    mockExecSync.mockReturnValueOnce('');

    const result = gitSafetyNet('/workspace', 'Test', 'abc', 'main');
    expect(result.pushed).toBe(true);
  });

  it('commits safe files and pushes', () => {
    mockExecSync.mockReturnValueOnce('?? src/new-file.ts\n?? src/another.ts');
    // git add for each file
    mockExecSync.mockReturnValueOnce('');
    mockExecSync.mockReturnValueOnce('');
    // git commit
    mockExecSync.mockReturnValueOnce('[main abc1234] task: Test [abc12345]');
    // git push
    mockExecSync.mockReturnValueOnce('');

    const result = gitSafetyNet('/workspace', 'Test', 'abc12345-def', 'main');
    expect(result.hadChanges).toBe(true);
    expect(result.filesAdded).toBe(2);
    expect(result.pushed).toBe(true);
  });

  it('BLOCKS dangerous files from staging', () => {
    mockExecSync.mockReturnValueOnce(
      '?? .claude/credentials.json\n?? .zsh_history\n?? src/real-code.ts'
    );
    // Only src/real-code.ts should be staged
    mockExecSync.mockReturnValueOnce(''); // git add src/real-code.ts
    mockExecSync.mockReturnValueOnce('[main def5678] task: Test [abc12345]');
    mockExecSync.mockReturnValueOnce(''); // push

    const result = gitSafetyNet('/workspace', 'Test', 'abc12345', 'main');
    expect(result.hadChanges).toBe(true);
    expect(result.filesAdded).toBe(1); // only the safe file
  });

  it('returns empty when ALL files are blocked', () => {
    mockExecSync.mockReturnValueOnce(
      '?? .claude/credentials.json\n?? .zsh_history\n?? .npm/cache/foo'
    );

    const result = gitSafetyNet('/workspace', 'Test', 'abc', 'main');
    expect(result.hadChanges).toBe(false);
  });

  it('handles push failure gracefully', () => {
    mockExecSync.mockReturnValueOnce('?? new-file.ts');
    mockExecSync.mockReturnValueOnce(''); // add
    mockExecSync.mockReturnValueOnce('[main abc1234] task: T [abc12345]');
    mockExecSync.mockImplementationOnce(() => { throw new Error('push rejected'); });

    const result = gitSafetyNet('/workspace', 'T', 'abc12345', 'main');
    expect(result.pushed).toBe(false);
    expect(result.error).toContain('Push failed');
  });
});
