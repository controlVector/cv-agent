/**
 * Git Safety Net
 *
 * Runs AFTER Claude Code exits, BEFORE task is reported as complete.
 * Ensures all changes are committed and pushed, because Claude Code
 * cannot be trusted to do this reliably.
 *
 * Evidence: ANAX Artifact Registry task (2026-04-03) — Claude Code wrote
 * an entire module and didn't git-add a single file.
 */

import { execSync } from 'node:child_process';

export interface GitSafetyResult {
  hadChanges: boolean;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  commitSha?: string;
  pushed: boolean;
  error?: string;
}

/**
 * Execute a git command, return stdout or throw.
 */
function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

/**
 * Ensure all changes are committed and pushed after Claude Code exits.
 *
 * 1. Check for uncommitted changes (untracked, modified, deleted)
 * 2. If any: git add -A, commit with task metadata, push
 * 3. If no local changes but unpushed commits: push them
 * 4. Return structured result for task reporting
 */
export function gitSafetyNet(
  workspaceRoot: string,
  taskTitle: string,
  taskId: string,
  branch?: string,
): GitSafetyResult {
  const targetBranch = branch || 'main';

  try {
    // 1. Check for ANY uncommitted changes
    let statusOutput: string;
    try {
      statusOutput = git('git status --porcelain', workspaceRoot);
    } catch {
      return { hadChanges: false, filesAdded: 0, filesModified: 0, filesDeleted: 0, pushed: false, error: 'git status failed' };
    }

    const lines = statusOutput.split('\n').filter(Boolean);

    if (lines.length === 0) {
      // No local changes — check for unpushed commits
      try {
        const unpushed = git(`git log origin/${targetBranch}..HEAD --oneline 2>/dev/null`, workspaceRoot);
        if (unpushed) {
          console.log(`  [git-safety] Found unpushed commits — pushing now`);
          git(`git push origin ${targetBranch}`, workspaceRoot);
          return { hadChanges: false, filesAdded: 0, filesModified: 0, filesDeleted: 0, pushed: true };
        }
      } catch {
        // No remote tracking or push failed — not critical
      }
      return { hadChanges: false, filesAdded: 0, filesModified: 0, filesDeleted: 0, pushed: false };
    }

    // 2. Parse what Claude Code left behind
    let added = 0, modified = 0, deleted = 0;
    for (const line of lines) {
      const code = line.substring(0, 2);
      if (code.includes('?')) added++;
      else if (code.includes('D')) deleted++;
      else if (code.includes('M') || code.includes('A')) modified++;
      else added++; // Treat unknown status as added
    }

    console.log(
      `  [git-safety] ${lines.length} uncommitted changes ` +
      `(${added} new, ${modified} modified, ${deleted} deleted) — committing now`
    );

    // 3. Stage everything
    git('git add -A', workspaceRoot);

    // 4. Commit with task metadata
    const shortId = taskId.substring(0, 8);
    const commitMsg = `task: ${taskTitle} [${shortId}]\n\nAuto-committed by cv-agent git safety net.\nTask ID: ${taskId}\nFiles: ${added} added, ${modified} modified, ${deleted} deleted`;

    let commitSha: string | undefined;
    try {
      const commitOutput = git(`git commit -m ${JSON.stringify(commitMsg)}`, workspaceRoot);
      const shaMatch = commitOutput.match(/\[[\w/]+ ([a-f0-9]+)\]/);
      commitSha = shaMatch ? shaMatch[1] : undefined;
    } catch (e: any) {
      // Commit may fail if there's nothing to commit after add
      if (!e.message?.includes('nothing to commit')) {
        return {
          hadChanges: true, filesAdded: added, filesModified: modified,
          filesDeleted: deleted, pushed: false, error: `Commit failed: ${e.message}`,
        };
      }
    }

    // 5. Push
    try {
      git(`git push origin ${targetBranch}`, workspaceRoot);
      console.log(`  [git-safety] Committed and pushed: ${commitSha || 'ok'}`);
    } catch (pushErr: any) {
      console.log(`  [git-safety] Push failed: ${pushErr.message}`);
      return {
        hadChanges: true, filesAdded: added, filesModified: modified,
        filesDeleted: deleted, commitSha, pushed: false,
        error: `Push failed: ${pushErr.message}`,
      };
    }

    return {
      hadChanges: true, filesAdded: added, filesModified: modified,
      filesDeleted: deleted, commitSha, pushed: true,
    };

  } catch (err: any) {
    return {
      hadChanges: false, filesAdded: 0, filesModified: 0,
      filesDeleted: 0, pushed: false, error: err.message,
    };
  }
}
