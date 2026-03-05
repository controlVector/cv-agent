/**
 * cva task list / cva task logs
 *
 * View tasks and task logs from CV-Hub.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readCredentials } from '../utils/credentials.js';
import { listTasks, getTask, getTaskLogs } from '../utils/api.js';

async function taskList(opts: { status?: string }): Promise<void> {
  const creds = await readCredentials();
  if (!creds.CV_HUB_PAT) {
    console.log(chalk.red('Not authenticated.') + ' Run ' + chalk.cyan('cva auth login') + ' first.');
    process.exit(1);
  }
  if (!creds.CV_HUB_API) creds.CV_HUB_API = 'https://api.hub.controlvector.io';

  try {
    const tasks = await listTasks(creds, opts.status);

    if (tasks.length === 0) {
      console.log(chalk.gray('No tasks found.'));
      return;
    }

    // Table output
    const statusColors: Record<string, (s: string) => string> = {
      pending: chalk.yellow,
      assigned: chalk.blue,
      running: chalk.cyan,
      completed: chalk.green,
      failed: chalk.red,
      cancelled: chalk.gray,
      waiting_for_input: chalk.magenta,
    };

    for (const t of tasks) {
      const colorFn = statusColors[t.status] || chalk.white;
      const status = colorFn(t.status.padEnd(18));
      const title = (t.title || '').substring(0, 50);
      const id = chalk.gray(t.id.substring(0, 8));
      const age = t.created_at ? chalk.gray(timeSince(new Date(t.created_at))) : '';
      console.log(`${id} ${status} ${title} ${age}`);
    }

    console.log(chalk.gray(`\n${tasks.length} task(s)`));
  } catch (err: any) {
    console.log(chalk.red('Failed:') + ` ${err.message}`);
    process.exit(1);
  }
}

async function taskLogs(taskId: string): Promise<void> {
  const creds = await readCredentials();
  if (!creds.CV_HUB_PAT) {
    console.log(chalk.red('Not authenticated.') + ' Run ' + chalk.cyan('cva auth login') + ' first.');
    process.exit(1);
  }
  if (!creds.CV_HUB_API) creds.CV_HUB_API = 'https://api.hub.controlvector.io';

  try {
    const logs = await getTaskLogs(creds, taskId);

    if (logs.length === 0) {
      // Fallback: show task detail
      console.log(chalk.gray('No logs found. Showing task detail:'));
      const task = await getTask(creds, taskId);
      console.log(JSON.stringify(task, null, 2));
      return;
    }

    const typeColors: Record<string, (s: string) => string> = {
      lifecycle: chalk.blue,
      heartbeat: chalk.gray,
      progress: chalk.cyan,
      git: chalk.green,
      error: chalk.red,
      info: chalk.white,
    };

    for (const log of logs) {
      const colorFn = typeColors[log.log_type] || chalk.white;
      const type = colorFn(`[${log.log_type}]`.padEnd(14));
      const time = chalk.gray(new Date(log.created_at).toLocaleTimeString());
      const pct = log.progress_pct !== null && log.progress_pct !== undefined
        ? chalk.yellow(` ${log.progress_pct}%`)
        : '';
      console.log(`${time} ${type} ${log.message}${pct}`);
    }
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

export function taskCommand(): Command {
  const cmd = new Command('task');
  cmd.description('View tasks and task logs');

  cmd
    .command('list')
    .description('List tasks')
    .option('--status <status>', 'Filter by status (e.g. running,completed)')
    .action(taskList);

  cmd
    .command('logs <taskId>')
    .description('View logs for a task')
    .action(taskLogs);

  return cmd;
}
