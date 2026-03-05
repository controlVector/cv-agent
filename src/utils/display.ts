/**
 * Display helpers for the cva agent.
 */

import chalk from 'chalk';

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function setTerminalTitle(title: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }
}

export function printBanner(
  status: 'COMPLETED' | 'FAILED' | 'ABORTED',
  elapsed: string,
  changedFiles: string[],
  commitSha: string | null,
): void {
  const color = status === 'COMPLETED' ? chalk.green : status === 'ABORTED' ? chalk.yellow : chalk.red;
  const icon = status === 'COMPLETED' ? '✅' : status === 'ABORTED' ? '⏹' : '❌';

  console.log(color('┌─────────────────────────────────────────────────────────────┐'));
  console.log(color(`│ ${icon} ${status.padEnd(57)}│`));
  console.log(color(`│ Duration: ${elapsed.padEnd(49)}│`));
  if (changedFiles.length > 0) {
    const shown = changedFiles.slice(0, 3);
    const fileStr = shown.join(', ') + (changedFiles.length > 3 ? ` and ${changedFiles.length - 3} more` : '');
    console.log(color(`│ Files: ${fileStr.substring(0, 51).padEnd(51)}│`));
  }
  if (commitSha) {
    console.log(color(`│ Commit: ${commitSha.substring(0, 8).padEnd(51)}│`));
  }
  console.log(color('└─────────────────────────────────────────────────────────────┘'));
}

export function updateStatusLine(
  idle: string,
  poll: string,
  completedCount: number,
  failedCount: number,
): void {
  const line = `\r${chalk.cyan('🔄')} Listening... (${idle} idle) | Last poll: ${poll} ago | Completed: ${completedCount} | Failed: ${failedCount}`;
  process.stdout.write(`\r\x1b[K${line}`);
}
