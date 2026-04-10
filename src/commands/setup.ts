/**
 * cva setup — Unified onboarding command
 *
 * Walks user from zero to dispatching tasks in under 2 minutes:
 * 1. Environment preflight (node, git, claude-code)
 * 2. CV-Hub authentication (shared credentials)
 * 3. Claude.ai MCP connector
 * 4. Repository setup (git init, cv-git init, CLAUDE.md, CV-Hub remote)
 * 5. Start agent daemon
 */

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, hostname } from 'node:os';
import chalk from 'chalk';
import {
  readCredentials,
  writeCredentialField,
} from '../utils/credentials.js';

// ============================================================================
// Shared Credentials (same format as cv-git)
// ============================================================================

const SHARED_CRED_DIR = join(homedir(), '.config', 'controlvector');
const SHARED_CRED_PATH = join(SHARED_CRED_DIR, 'credentials.json');

interface SharedCreds {
  hub_url: string;
  token: string;
  username?: string;
  created_at?: string;
}

function readSharedCreds(): SharedCreds | null {
  try {
    const data = JSON.parse(readFileSync(SHARED_CRED_PATH, 'utf-8'));
    if (data.token && data.hub_url) return data;
    return null;
  } catch { return null; }
}

function writeSharedCreds(creds: SharedCreds): void {
  mkdirSync(SHARED_CRED_DIR, { recursive: true });
  writeFileSync(SHARED_CRED_PATH, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

async function validateToken(hubUrl: string, token: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${hubUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json() as { user?: { username?: string; email?: string } };
    return data.user?.username || data.user?.email || 'unknown';
  } catch { return null; }
}

// ============================================================================
// Preflight Checks
// ============================================================================

function checkBinary(cmd: string): string | null {
  try {
    return execSync(`${cmd} 2>&1`, { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
  } catch { return null; }
}

// ============================================================================
// Setup Command
// ============================================================================

async function runSetup(): Promise<void> {
  const hubUrl = 'https://api.hub.controlvector.io';
  const appUrl = 'https://hub.controlvector.io';

  console.log();
  console.log(chalk.bold('  CV-Agent Setup'));
  console.log();

  // ── Step 1: Environment Preflight ──────────────────────────────────
  console.log('  Checking environment...');

  const nodeVersion = checkBinary('node --version');
  const gitVersion = checkBinary('git --version');
  const claudeVersion = checkBinary('claude --version');

  console.log(`    ${nodeVersion ? chalk.green('✓') : chalk.red('✗')} Node.js ${nodeVersion || '— not found'}`);
  console.log(`    ${gitVersion ? chalk.green('✓') : chalk.red('✗')} Git ${gitVersion || '— not found'}`);
  console.log(`    ${claudeVersion ? chalk.green('✓') : chalk.red('✗')} Claude Code ${claudeVersion || '— not found'}`);
  console.log();

  if (!nodeVersion || !gitVersion) {
    if (!nodeVersion) console.log(chalk.red('  Node.js required: https://nodejs.org'));
    if (!gitVersion) console.log(chalk.red('  Git required: https://git-scm.com'));
    process.exit(1);
  }

  if (!claudeVersion) {
    console.log(chalk.yellow('  Claude Code not found. Install with:'));
    console.log(chalk.cyan('    npm install -g @anthropic-ai/claude-code'));
    console.log();
    console.log(chalk.gray('  Continuing setup — you can install Claude Code later.'));
    console.log();
  }

  // ── Step 2: Authentication ─────────────────────────────────────────
  let username: string | undefined;
  let token: string | undefined;

  // Check shared credentials first, then cv-hub credentials
  const shared = readSharedCreds();
  if (shared) {
    const user = await validateToken(shared.hub_url, shared.token);
    if (user) {
      username = user;
      token = shared.token;
      console.log(chalk.green('  ✓') + ` Authenticated as ${chalk.bold(user)}`);
    }
  }

  if (!token) {
    // Check cv-hub credentials
    const creds = await readCredentials();
    if (creds.CV_HUB_PAT) {
      const user = await validateToken(hubUrl, creds.CV_HUB_PAT);
      if (user) {
        username = user;
        token = creds.CV_HUB_PAT;
        console.log(chalk.green('  ✓') + ` Authenticated as ${chalk.bold(user)} (from cv-hub credentials)`);
        // Migrate to shared format
        writeSharedCreds({ hub_url: hubUrl, token, username, created_at: new Date().toISOString() });
      }
    }
  }

  if (!token) {
    console.log('  Let\'s connect you to CV-Hub.');
    console.log();

    const autoName = `${hostname()}-${new Date().toISOString().slice(0, 10)}`;
    const tokenUrl = `${appUrl}/settings/tokens/new?name=${encodeURIComponent(autoName)}&scopes=agent,repo`;

    console.log(chalk.gray(`  Opening: ${tokenUrl}`));

    // Try to open browser
    try {
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execSync(`${openCmd} "${tokenUrl}" 2>/dev/null`, { timeout: 5000 });
    } catch {
      console.log(chalk.gray('  (Could not open browser — copy the URL above)'));
    }

    console.log();

    // Prompt for token
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    token = await new Promise<string>((resolve) => {
      rl.question('  Paste your token here: ', (answer: string) => {
        rl.close();
        resolve(answer.trim());
      });
    });

    if (!token) {
      console.log(chalk.red('  No token provided. Run cva setup again.'));
      process.exit(1);
    }

    // Validate
    const user = await validateToken(hubUrl, token);
    if (!user) {
      console.log(chalk.red('  Token validation failed. Check your token and try again.'));
      process.exit(1);
    }

    username = user;
    console.log(chalk.green('  ✓') + ` Authenticated as ${chalk.bold(user)}`);

    // Save to shared credentials
    writeSharedCreds({ hub_url: hubUrl, token, username, created_at: new Date().toISOString() });

    // Also save to cv-hub credentials for backward compatibility
    await writeCredentialField('CV_HUB_PAT', token);
    await writeCredentialField('CV_HUB_API', hubUrl);
  }

  console.log();

  // ── Step 3: Claude.ai MCP Connector ────────────────────────────────
  console.log('  Claude.ai MCP connector:');
  const mcpUrl = `https://claude.ai/settings/integrations?add_mcp=${encodeURIComponent(`${hubUrl}/mcp`)}`;

  console.log(chalk.gray(`  To connect Claude.ai to CV-Hub, visit:`));
  console.log(chalk.cyan(`    ${mcpUrl}`));
  console.log();
  console.log(chalk.gray('  Click "Add Integration" → "Allow" when prompted.'));
  console.log(chalk.gray('  (You can do this later — setup will continue.)'));
  console.log();

  // ── Step 4: Repository Setup ───────────────────────────────────────
  const cwd = process.cwd();
  const isGitRepo = existsSync(join(cwd, '.git'));
  const hasCVDir = existsSync(join(cwd, '.cv'));
  const hasClaudeMd = existsSync(join(cwd, 'CLAUDE.md'));
  const repoName = basename(cwd);

  if (isGitRepo) {
    console.log(chalk.green('  ✓') + ` Git repo found: ${repoName}`);
  } else {
    console.log('  Initializing git repository...');
    execSync('git init && git checkout -b main', { cwd, stdio: 'pipe' });
    console.log(chalk.green('  ✓') + ' Git repo initialized');
  }

  if (!hasClaudeMd) {
    const template = `# ${repoName}\n\n## Overview\n[Describe your project here]\n\n## Tech Stack\n[What languages/frameworks does this project use?]\n\n## Build & Run\n[How to build and run this project]\n`;
    writeFileSync(join(cwd, 'CLAUDE.md'), template);
    console.log(chalk.green('  ✓') + ' CLAUDE.md created');
  } else {
    console.log(chalk.green('  ✓') + ' CLAUDE.md present');
  }

  if (!hasCVDir) {
    mkdirSync(join(cwd, '.cv'), { recursive: true });
  }

  // Add CV-Hub remote if we have credentials
  if (token && username) {
    const gitHost = 'git.hub.controlvector.io';
    const remoteUrl = `https://${gitHost}/${username}/${repoName}.git`;
    try {
      const existingRemote = execSync('git remote get-url cv-hub 2>/dev/null || echo ""', { cwd, encoding: 'utf8' }).trim();
      if (!existingRemote) {
        execSync(`git remote add cv-hub ${remoteUrl}`, { cwd, stdio: 'pipe' });
        console.log(chalk.green('  ✓') + ` Remote added: cv-hub → ${remoteUrl}`);
      } else {
        console.log(chalk.green('  ✓') + ` CV-Hub remote exists`);
      }
    } catch {
      // Remote setup non-fatal
    }
  }

  console.log();

  // ── Step 5: Summary ────────────────────────────────────────────────
  console.log(chalk.bold('  Setup Complete'));
  console.log(chalk.gray('  ' + '─'.repeat(40)));
  console.log(`  ${chalk.green('✓')} Authenticated as: ${chalk.cyan(username)}`);
  console.log(`  ${chalk.green('✓')} Repository: ${chalk.cyan(repoName)}`);
  console.log(`  ${chalk.green('✓')} CLAUDE.md: present`);
  console.log(chalk.gray('  ' + '─'.repeat(40)));
  console.log();
  console.log('  What\'s next:');
  console.log(`    ${chalk.cyan('cva agent --auto-approve')}  — Start listening for tasks`);
  console.log(`    Or open Claude.ai and dispatch a task to this repo.`);
  console.log();
  console.log(chalk.gray(`  Dashboard: ${appUrl}`));
  console.log();
}

export function setupCommand(): Command {
  const cmd = new Command('setup');
  cmd.description('Set up CV-Agent — authentication, repo, and connections (start here)');
  cmd.action(runSetup);
  return cmd;
}
