/**
 * Git Safety Net
 *
 * Runs AFTER Claude Code exits, BEFORE task is reported as complete.
 * Ensures all changes are committed and pushed, because Claude Code
 * cannot be trusted to do this reliably.
 *
 * SAFETY GUARDS (Bug 3 fix, 2026-04-11):
 * - REFUSES to run if workspace is user's HOME directory
 * - REFUSES to run if workspace has no .git directory
 * - Filters out sensitive files from staging (.claude/, .zsh_history, etc.)
 * - Logs warnings instead of silently committing dangerous paths
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface GitSafetyResult {
  hadChanges: boolean;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  commitSha?: string;
  pushed: boolean;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

/** Files/directories that must NEVER be committed by the safety net */
const DANGEROUS_PATTERNS = [
  '.claude/',
  '.claude.json',
  '.credentials',
  '.zsh_history',
  '.bash_history',
  '.zsh_sessions/',
  '.ssh/',
  '.gnupg/',
  '.npm/',
  '.config/',
  '.CFUserTextEncoding',
  'Library/',
  'Applications/',
  '.Trash/',
  '.DS_Store',
  'node_modules/',
  '.env',
  '.env.local',
  '.env.production',
];

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

/**
 * Check if a workspace is safe for auto-commit operations.
 * Returns an error string if unsafe, null if safe.
 */
function checkWorkspaceSafety(workspaceRoot: string): string | null {
  const resolved = resolve(workspaceRoot);
  const home = resolve(homedir());

  // NEVER auto-commit from user's HOME directory
  if (resolved === home) {
    return `Workspace is user HOME directory (${home}). Refusing to auto-commit to prevent indexing personal files.`;
  }

  // NEVER auto-commit from a parent of HOME (e.g., /Users or /)
  if (home.startsWith(resolved + '/')) {
    return `Workspace (${resolved}) is a parent of HOME. Refusing to auto-commit.`;
  }

  // Must have a .git directory
  if (!existsSync(join(resolved, '.git'))) {
    return `No .git directory in ${resolved}. Not a git repository.`;
  }

  return null;
}

/**
 * Filter out dangerous files from git status output.
 * Returns only the safe lines.
 */
function filterDangerousFiles(statusLines: string[]): { safe: string[]; blocked: string[] } {
  const safe: string[] = [];
  const blocked: string[] = [];

  for (const line of statusLines) {
    const filePath = line.substring(3).trim(); // Remove status prefix (e.g., "?? " or " M ")
    const isDangerous = DANGEROUS_PATTERNS.some(pattern =>
      filePath.startsWith(pattern) || filePath.includes('/' + pattern)
    );

    if (isDangerous) {
      blocked.push(filePath);
    } else {
      safe.push(line);
    }
  }

  return { safe, blocked };
}

/**
 * Ensure all changes are committed and pushed after Claude Code exits.
 *
 * Safety guards:
 * - Refuses if workspace is HOME directory
 * - Refuses if no .git directory exists
 * - Filters out sensitive files (.claude/, .zsh_history, etc.)
 * - Only stages files that pass the safety filter
 */
export function gitSafetyNet(
  workspaceRoot: string,
  taskTitle: string,
  taskId: string,
  branch?: string,
): GitSafetyResult {
  const targetBranch = branch || 'main';

  // ── Safety check: refuse to run in dangerous directories ──────────
  const safetyError = checkWorkspaceSafety(workspaceRoot);
  if (safetyError) {
    console.log(`  [git-safety] BLOCKED: ${safetyError}`);
    return {
      hadChanges: false, filesAdded: 0, filesModified: 0,
      filesDeleted: 0, pushed: false, skipped: true,
      skipReason: safetyError,
    };
  }

  try {
    // 1. Check for uncommitted changes
    let statusOutput: string;
    try {
      statusOutput = git('git status --porcelain', workspaceRoot);
    } catch {
      return { hadChanges: false, filesAdded: 0, filesModified: 0, filesDeleted: 0, pushed: false, error: 'git status failed' };
    }

    const allLines = statusOutput.split('\n').filter(Boolean);

    if (allLines.length === 0) {
      // No local changes — check for unpushed commits
      try {
        const unpushed = git(`git log origin/${targetBranch}..HEAD --oneline 2>/dev/null`, workspaceRoot);
        if (unpushed) {
          console.log(`  [git-safety] Found unpushed commits — pushing now`);
          git(`git push origin ${targetBranch}`, workspaceRoot);
          return { hadChanges: false, filesAdded: 0, filesModified: 0, filesDeleted: 0, pushed: true };
        }
      } catch {
        // No remote tracking or push failed
      }
      return { hadChanges: false, filesAdded: 0, filesModified: 0, filesDeleted: 0, pushed: false };
    }

    // 2. Filter out dangerous files
    const { safe: safeLines, blocked } = filterDangerousFiles(allLines);

    if (blocked.length > 0) {
      console.log(`  [git-safety] Blocked ${blocked.length} sensitive file(s) from staging: ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? '...' : ''}`);
    }

    if (safeLines.length === 0) {
      console.log(`  [git-safety] All ${allLines.length} changed files were blocked by safety filter`);
      return { hadChanges: false, filesAdded: 0, filesModified: 0, filesDeleted: 0, pushed: false };
    }

    // 3. Parse safe changes
    let added = 0, modified = 0, deleted = 0;
    for (const line of safeLines) {
      const code = line.substring(0, 2);
      if (code.includes('?')) added++;
      else if (code.includes('D')) deleted++;
      else if (code.includes('M') || code.includes('A')) modified++;
      else added++;
    }

    console.log(
      `  [git-safety] ${safeLines.length} safe changes ` +
      `(${added} new, ${modified} modified, ${deleted} deleted) — committing now`
    );

    // 4. Stage only safe files (NOT git add -A)
    for (const line of safeLines) {
      const filePath = line.substring(3).trim();
      try {
        git(`git add -- ${JSON.stringify(filePath)}`, workspaceRoot);
      } catch {
        // Individual file add failed — skip it
      }
    }

    // 5. Commit with task metadata
    const shortId = taskId.substring(0, 8);
    const commitMsg = `task: ${taskTitle} [${shortId}]\n\nAuto-committed by cv-agent git safety net.\nTask ID: ${taskId}\nFiles: ${added} added, ${modified} modified, ${deleted} deleted`;

    let commitSha: string | undefined;
    try {
      const commitOutput = git(`git commit -m ${JSON.stringify(commitMsg)}`, workspaceRoot);
      const shaMatch = commitOutput.match(/\[[\w/]+ ([a-f0-9]+)\]/);
      commitSha = shaMatch ? shaMatch[1] : undefined;
    } catch (e: any) {
      if (!e.message?.includes('nothing to commit')) {
        return {
          hadChanges: true, filesAdded: added, filesModified: modified,
          filesDeleted: deleted, pushed: false, error: `Commit failed: ${e.message}`,
        };
      }
    }

    // 6. Push
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
