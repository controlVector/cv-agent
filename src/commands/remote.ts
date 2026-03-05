/**
 * cva remote add / cva remote setup
 *
 * Manages CV-Hub git remotes for the current repository.
 */

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { readCredentials } from '../utils/credentials.js';
import { createRepo } from '../utils/api.js';

function getGitHost(apiUrl: string): string {
  return apiUrl
    .replace(/^https?:\/\//, '')
    .replace(/^api\./, 'git.');
}

async function remoteAdd(ownerRepo: string): Promise<void> {
  const creds = await readCredentials();
  const apiUrl = creds.CV_HUB_API || 'https://api.hub.controlvector.io';
  const gitHost = getGitHost(apiUrl);

  const [owner, repo] = ownerRepo.split('/');
  if (!owner || !repo) {
    console.log(chalk.red('Invalid format.') + ' Use: cva remote add <owner>/<repo>');
    process.exit(1);
  }

  const remoteUrl = `https://${gitHost}/${owner}/${repo}.git`;

  // Check if cvhub remote already exists
  try {
    const existing = execSync('git remote get-url cvhub', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (existing === remoteUrl) {
      console.log(chalk.gray(`Remote 'cvhub' already set to ${remoteUrl}`));
      return;
    }
    // Update it
    execSync(`git remote set-url cvhub ${remoteUrl}`, { timeout: 5000 });
    console.log(chalk.green('Updated') + ` remote 'cvhub' -> ${remoteUrl}`);
  } catch {
    // Add new remote
    try {
      execSync(`git remote add cvhub ${remoteUrl}`, { timeout: 5000 });
      console.log(chalk.green('Added') + ` remote 'cvhub' -> ${remoteUrl}`);
    } catch (err: any) {
      console.log(chalk.red('Failed to add remote:') + ` ${err.message}`);
      process.exit(1);
    }
  }
}

async function remoteSetup(ownerRepo: string): Promise<void> {
  const creds = await readCredentials();

  if (!creds.CV_HUB_PAT) {
    console.log(chalk.red('Not authenticated.') + ' Run ' + chalk.cyan('cva auth login') + ' first.');
    process.exit(1);
  }

  if (!creds.CV_HUB_API) {
    creds.CV_HUB_API = 'https://api.hub.controlvector.io';
  }

  const [owner, repo] = ownerRepo.split('/');
  if (!owner || !repo) {
    console.log(chalk.red('Invalid format.') + ' Use: cva remote setup <owner>/<repo>');
    process.exit(1);
  }

  // Create repo on CV-Hub
  console.log(chalk.gray(`Creating repository ${ownerRepo} on CV-Hub...`));
  try {
    await createRepo(creds, repo);
    console.log(chalk.green('Created') + ` repository ${ownerRepo}`);
  } catch (err: any) {
    if (err.message.includes('409') || err.message.includes('already exists')) {
      console.log(chalk.gray(`Repository ${ownerRepo} already exists.`));
    } else {
      console.log(chalk.red('Failed to create repo:') + ` ${err.message}`);
      process.exit(1);
    }
  }

  // Add the remote
  await remoteAdd(ownerRepo);
}

export function remoteCommand(): Command {
  const cmd = new Command('remote');
  cmd.description('Manage CV-Hub git remotes');

  cmd
    .command('add <owner/repo>')
    .description('Add cvhub remote to current git repo')
    .action(remoteAdd);

  cmd
    .command('setup <owner/repo>')
    .description('Create repo on CV-Hub and add cvhub remote')
    .action(remoteSetup);

  return cmd;
}
