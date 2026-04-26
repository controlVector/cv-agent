/**
 * cva orgs — Organization management
 *
 * Commands:
 *   cva orgs list    List organizations your account belongs to
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readCredentials } from '../utils/credentials.js';
import { apiCall } from '../utils/api.js';

async function listOrgs(): Promise<void> {
  const creds = await readCredentials();

  if (!creds.CV_HUB_PAT) {
    console.log(chalk.red('Not authenticated.') + ` Run ${chalk.cyan('cva auth login')} first.`);
    process.exit(1);
  }

  if (!creds.CV_HUB_API) {
    creds.CV_HUB_API = 'https://api.hub.controlvector.io';
  }

  try {
    const res = await apiCall(creds, 'GET', '/api/v1/orgs/my/list');

    if (!res.ok) {
      console.log(chalk.red(`Error: ${res.status}`));
      process.exit(1);
    }

    const data = await res.json() as {
      organizations?: Array<{
        id: string;
        slug: string;
        name: string;
        description?: string;
        isPublic?: boolean;
      }>;
    };

    const orgs = data.organizations || [];

    if (orgs.length === 0) {
      console.log(chalk.gray('You are not a member of any organizations.'));
      return;
    }

    console.log();
    console.log(chalk.bold(`  Your Organizations (${orgs.length})`));
    console.log();

    // Header
    console.log(
      chalk.gray('  ') +
      'Slug'.padEnd(24) +
      'Name'.padEnd(24) +
      'ID'
    );
    console.log(chalk.gray('  ' + '─'.repeat(72)));

    for (const org of orgs) {
      console.log(
        '  ' +
        chalk.cyan(org.slug.padEnd(24)) +
        org.name.padEnd(24) +
        chalk.gray(org.id)
      );
    }

    console.log();
    console.log(chalk.gray('  Use with: cva agent --org <slug>'));
    console.log(chalk.gray('  Or set:   CV_HUB_ORG=<slug>'));
    console.log();
  } catch (err: any) {
    console.log(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

export function orgsCommand(): Command {
  const cmd = new Command('orgs');
  cmd.description('Manage organizations');

  cmd
    .command('list')
    .description('List organizations your account belongs to')
    .action(listOrgs);

  return cmd;
}
