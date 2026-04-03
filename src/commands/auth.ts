/**
 * cva auth login / cva auth status
 *
 * Manages CV-Hub authentication credentials.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  readCredentials,
  writeCredentialField,
} from '../utils/credentials.js';
import { apiCall } from '../utils/api.js';
import { readConfig, writeConfig } from '../utils/config.js';

async function authLogin(opts: { token?: string; apiUrl?: string }): Promise<void> {
  const token = opts.token || await promptForToken();
  const apiUrl = opts.apiUrl || 'https://api.hub.controlvector.io';

  // Validate the token
  console.log(chalk.gray('Validating token...'));
  try {
    const res = await fetch(`${apiUrl}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      console.log(chalk.red('Invalid token.') + ` API returned ${res.status}`);
      process.exit(1);
    }

    const data = await res.json() as any;
    const username = data.user?.username || data.user?.email || 'unknown';

    // Save credentials
    await writeCredentialField('CV_HUB_PAT', token);
    await writeCredentialField('CV_HUB_API', apiUrl);

    console.log(chalk.green('Authenticated') + ` as ${chalk.bold(username)}`);
    console.log(chalk.gray(`Token saved to ~/.config/cv-hub/credentials`));
  } catch (err: any) {
    console.log(chalk.red('Connection failed:') + ` ${err.message}`);
    process.exit(1);
  }
}

async function promptForToken(): Promise<string> {
  // Simple stdin read for token
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Enter your CV-Hub PAT token: ', (answer: string) => {
      rl.close();
      const token = answer.trim();
      if (!token) {
        console.log(chalk.red('No token provided.'));
        process.exit(1);
      }
      resolve(token);
    });
  });
}

async function authStatus(): Promise<void> {
  const creds = await readCredentials();

  if (!creds.CV_HUB_PAT) {
    console.log(chalk.yellow('Not authenticated.') + ' Run ' + chalk.cyan('cva auth login') + ' first.');
    return;
  }

  const apiUrl = creds.CV_HUB_API || 'https://api.hub.controlvector.io';
  const maskedToken = creds.CV_HUB_PAT.substring(0, 8) + '...' + creds.CV_HUB_PAT.slice(-4);

  console.log(`API:   ${chalk.cyan(apiUrl)}`);
  console.log(`Token: ${chalk.gray(maskedToken)}`);

  // Verify token
  try {
    const res = await fetch(`${apiUrl}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${creds.CV_HUB_PAT}` },
    });

    if (res.ok) {
      const data = await res.json() as any;
      const username = data.user?.username || data.user?.email || 'unknown';
      console.log(`User:  ${chalk.green(username)}`);
      console.log(`Status: ${chalk.green('valid')}`);
    } else {
      console.log(`Status: ${chalk.red('invalid')} (${res.status})`);
    }
  } catch (err: any) {
    console.log(`Status: ${chalk.red('unreachable')} (${err.message})`);
  }
}

async function authSetApiKey(key: string): Promise<void> {
  if (!key.startsWith('sk-ant-')) {
    console.log(chalk.red('Invalid API key.') + ' Anthropic API keys start with sk-ant-');
    process.exit(1);
  }

  const config = await readConfig();
  config.anthropic_api_key = key;
  await writeConfig(config);

  const masked = key.substring(0, 10) + '...' + key.slice(-4);
  console.log(chalk.green('API key saved') + ` (${masked})`);
  console.log(chalk.gray('This key will be used as fallback when Claude Code OAuth expires.'));
}

async function authRemoveApiKey(): Promise<void> {
  const config = await readConfig();
  if (!config.anthropic_api_key) {
    console.log(chalk.yellow('No API key configured.'));
    return;
  }
  delete config.anthropic_api_key;
  await writeConfig(config);
  console.log(chalk.green('API key removed.'));
}

export function authCommand(): Command {
  const cmd = new Command('auth');
  cmd.description('Manage CV-Hub authentication');

  cmd
    .command('login')
    .description('Authenticate with CV-Hub using a PAT token')
    .option('--token <token>', 'PAT token (or enter interactively)')
    .option('--api-url <url>', 'CV-Hub API URL', 'https://api.hub.controlvector.io')
    .action(authLogin);

  cmd
    .command('status')
    .description('Show current authentication status')
    .action(authStatus);

  cmd
    .command('set-api-key')
    .description('Set Anthropic API key as fallback for Claude Code OAuth')
    .argument('<key>', 'Anthropic API key (sk-ant-...)')
    .action(authSetApiKey);

  cmd
    .command('remove-api-key')
    .description('Remove stored Anthropic API key')
    .action(authRemoveApiKey);

  return cmd;
}
