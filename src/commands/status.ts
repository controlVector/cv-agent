/**
 * cva status
 *
 * Show registered executors and their current status.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readCredentials } from '../utils/credentials.js';
import { listExecutors } from '../utils/api.js';

async function showStatus(): Promise<void> {
  const creds = await readCredentials();
  if (!creds.CV_HUB_PAT) {
    console.log(chalk.red('Not authenticated.') + ' Run ' + chalk.cyan('cva auth login') + ' first.');
    process.exit(1);
  }
  if (!creds.CV_HUB_API) creds.CV_HUB_API = 'https://api.hub.controlvector.io';

  try {
    const executors = await listExecutors(creds);

    if (executors.length === 0) {
      console.log(chalk.gray('No executors registered.'));
      return;
    }

    const statusColors: Record<string, (s: string) => string> = {
      online: chalk.green,
      offline: chalk.gray,
      busy: chalk.yellow,
      error: chalk.red,
    };

    console.log(chalk.bold('Executors:'));
    console.log();

    for (const e of executors) {
      const colorFn = statusColors[e.status] || chalk.white;
      const status = colorFn(e.status.padEnd(10));
      const name = chalk.cyan(e.name || e.machine_name || 'unknown');
      const id = chalk.gray(e.id.substring(0, 8));
      const heartbeat = e.last_heartbeat_at
        ? chalk.gray(`last seen ${timeSince(new Date(e.last_heartbeat_at))}`)
        : chalk.gray('never');
      const workspace = e.workspace_root ? chalk.gray(` | ${e.workspace_root}`) : '';

      console.log(`  ${id} ${status} ${name} ${heartbeat}${workspace}`);
    }

    console.log(chalk.gray(`\n${executors.length} executor(s)`));
  } catch (err: any) {
    console.log(chalk.red('Failed:') + ` ${err.message}`);
    process.exit(1);
  }
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function statusCommand(): Command {
  const cmd = new Command('status');
  cmd.description('Show registered executors and their status');
  cmd.action(showStatus);
  return cmd;
}
