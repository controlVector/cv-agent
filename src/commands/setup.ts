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
// OAuth Device Authorization Flow (RFC 8628)
// ============================================================================

const DEVICE_CLIENT_ID = 'cv-agent-cli';
const DEVICE_SCOPES = 'repo:read repo:write profile offline_access';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 180; // 15 minutes

interface DeviceAuthResult {
  token: string;
  username: string;
}

async function deviceAuthFlow(hubUrl: string, appUrl: string): Promise<DeviceAuthResult> {
  // Step 1: Request device authorization
  const authRes = await fetch(`${hubUrl}/oauth/device/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DEVICE_CLIENT_ID,
      scope: DEVICE_SCOPES,
    }),
  });

  if (!authRes.ok) {
    const err = await authRes.json().catch(() => ({})) as { error_description?: string };
    throw new Error(err.error_description || `Device auth failed: ${authRes.status}`);
  }

  const auth = await authRes.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };

  // Step 2: Display code and open browser
  console.log(chalk.bold('  ┌──────────────────────────────────────────┐'));
  console.log(chalk.bold('  │     CV-Hub Device Authorization          │'));
  console.log(chalk.bold('  ├──────────────────────────────────────────┤'));
  console.log(chalk.bold('  │                                          │'));
  console.log(chalk.bold('  │  Open this URL in your browser:          │'));
  console.log(chalk.bold(`  │  ${chalk.cyan(auth.verification_uri).padEnd(51)}│`));
  console.log(chalk.bold('  │                                          │'));
  console.log(chalk.bold('  │  Then enter this code:                   │'));
  console.log(chalk.bold(`  │          ${chalk.white.bold(auth.user_code)}                       │`));
  console.log(chalk.bold('  │                                          │'));
  console.log(chalk.bold(`  │  ${chalk.gray(`Expires in ${Math.floor(auth.expires_in / 60)} minutes`).padEnd(51)}│`));
  console.log(chalk.bold('  └──────────────────────────────────────────┘'));
  console.log();

  // Try to open browser
  try {
    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execSync(`${openCmd} "${auth.verification_uri_complete}" 2>/dev/null`, { timeout: 5000 });
    console.log(chalk.gray('  Browser opened. Waiting for authorization...'));
  } catch {
    console.log(chalk.gray('  Open the URL above in your browser.'));
  }

  // Step 3: Poll for token
  let interval = Math.max(auth.interval * 1000, POLL_INTERVAL_MS);
  const expireTime = Date.now() + auth.expires_in * 1000;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, interval));

    if (Date.now() > expireTime) {
      throw new Error('Authorization timed out');
    }

    const remaining = Math.ceil((expireTime - Date.now()) / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    process.stdout.write(`\r  Waiting for authorization... (${mins}:${secs.toString().padStart(2, '0')} remaining) `);

    const tokenRes = await fetch(`${hubUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: auth.device_code,
        client_id: DEVICE_CLIENT_ID,
      }),
    });

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      error?: string;
      scope?: string;
    };

    if (tokenData.access_token) {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');

      // Get username
      let uname = 'user';
      try {
        const userRes = await fetch(`${hubUrl}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (userRes.ok) {
          const userInfo = await userRes.json() as { preferred_username?: string; name?: string };
          uname = userInfo.preferred_username || userInfo.name || 'user';
        }
      } catch { /* use default */ }

      return { token: tokenData.access_token, username: uname };
    }

    if (tokenData.error === 'slow_down') {
      interval += 5000;
    } else if (tokenData.error === 'access_denied') {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      throw new Error('Authorization denied by user');
    } else if (tokenData.error === 'expired_token') {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      throw new Error('Authorization expired');
    }
    // authorization_pending → keep polling
  }

  throw new Error('Authorization timed out');
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

    // Use OAuth Device Authorization flow (RFC 8628)
    // Same flow as cv-git: CLI gets a code, user approves in browser, CLI gets token
    try {
      const deviceResult = await deviceAuthFlow(hubUrl, appUrl);
      token = deviceResult.token;
      username = deviceResult.username;

      console.log(chalk.green('  ✓') + ` Authenticated as ${chalk.bold(username)}`);

      // Save to shared credentials
      writeSharedCreds({ hub_url: hubUrl, token, username, created_at: new Date().toISOString() });

      // Also save to cv-hub credentials for backward compatibility
      await writeCredentialField('CV_HUB_PAT', token);
      await writeCredentialField('CV_HUB_API', hubUrl);
    } catch (err: any) {
      console.log(chalk.red(`  Authentication failed: ${err.message}`));
      console.log(chalk.gray('  You can retry with: cva setup'));
      console.log(chalk.gray('  Or manually: cva auth login --token <your-pat>'));
      process.exit(1);
    }
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
  let cwd = process.cwd();
  let isGitRepo = existsSync(join(cwd, '.git'));
  let repoName = basename(cwd);

  if (isGitRepo) {
    console.log(chalk.green('  ✓') + ` Git repo found: ${repoName}`);
  } else {
    // Offer options: init, clone, or change dir
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('  No git repository found in this directory.');
    console.log();
    console.log(`    ${chalk.cyan('a')} — Initialize a new project here: ${cwd}`);
    console.log(`    ${chalk.cyan('b')} — Clone an existing repo from CV-Hub`);
    console.log();

    const choice = await new Promise<string>((resolve) => {
      rl.question('  Choose [a/b]: ', (answer: string) => {
        rl.close();
        resolve(answer.trim().toLowerCase() || 'a');
      });
    });

    if (choice === 'b' && token) {
      // Clone from CV-Hub
      try {
        console.log(chalk.gray('  Fetching your repositories...'));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        const res = await fetch(`${hubUrl}/api/v1/repos?limit=50`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          const data = await res.json() as { repositories?: Array<{ name: string; slug: string; description?: string }> };
          const repos = data.repositories || [];

          if (repos.length === 0) {
            console.log(chalk.yellow('  No repos found on CV-Hub. Initializing a new project instead.'));
          } else {
            console.log();
            console.log('  Your CV-Hub repositories:');
            const displayRepos = repos.slice(0, 20);
            displayRepos.forEach((r, i) => {
              const desc = r.description ? chalk.gray(` — ${r.description.substring(0, 40)}`) : '';
              console.log(`    ${chalk.cyan(String(i + 1).padStart(2))}. ${r.slug || r.name}${desc}`);
            });
            console.log();

            const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
            const selection = await new Promise<string>((resolve) => {
              rl2.question(`  Select a repo [1-${displayRepos.length}]: `, (answer: string) => {
                rl2.close();
                resolve(answer.trim());
              });
            });

            const idx = parseInt(selection, 10) - 1;
            if (idx >= 0 && idx < displayRepos.length) {
              const repo = displayRepos[idx];
              const gitHost = 'git.hub.controlvector.io';
              const slug = repo.slug || repo.name;
              const cloneUrl = `https://${username}:${token}@${gitHost}/${username}/${slug}.git`;

              console.log(chalk.gray(`  Cloning ${username}/${slug}...`));
              execSync(`git clone ${cloneUrl} ${slug}`, { cwd, stdio: 'pipe', timeout: 60_000 });
              cwd = join(cwd, slug);
              process.chdir(cwd);
              repoName = slug;
              isGitRepo = true;
              console.log(chalk.green('  ✓') + ` Cloned ${username}/${slug}`);
            }
          }
        }
      } catch (err: any) {
        console.log(chalk.yellow(`  Could not fetch repos: ${err.message}. Initializing instead.`));
      }
    }

    // If we haven't cloned, init a new repo
    if (!isGitRepo) {
      console.log('  Initializing git repository...');
      execSync('git init && git checkout -b main', { cwd, stdio: 'pipe' });
      console.log(chalk.green('  ✓') + ' Git repo initialized');
    }
  }

  const hasClaudeMd = existsSync(join(cwd, 'CLAUDE.md'));
  const hasCVDir = existsSync(join(cwd, '.cv'));

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
        // Create repo on CV-Hub (non-fatal if it already exists or fails)
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15_000);
          await fetch(`${hubUrl}/api/v1/user/repos`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: repoName, auto_init: false }),
            signal: controller.signal,
          });
          clearTimeout(timeout);
          console.log(chalk.green('  ✓') + ` Repo created on CV-Hub: ${username}/${repoName}`);
        } catch {
          // May already exist — that's fine
        }

        execSync(`git remote add cv-hub ${remoteUrl}`, { cwd, stdio: 'pipe' });
        console.log(chalk.green('  ✓') + ` Remote added: cv-hub → ${remoteUrl}`);
      } else {
        console.log(chalk.green('  ✓') + ` CV-Hub remote exists`);
      }
    } catch {
      // Remote setup non-fatal
    }

    // Configure git credentials for CV-Hub pushes
    try {
      const credStorePath = join(homedir(), '.git-credentials');
      const credLine = `https://${username}:${token}@${gitHost}`;
      let existing = '';
      try { existing = readFileSync(credStorePath, 'utf-8'); } catch { /* doesn't exist yet */ }
      if (!existing.includes(gitHost)) {
        writeFileSync(credStorePath, existing + credLine + '\n', { mode: 0o600 });
      }
      execSync(`git config --global credential.helper store`, { stdio: 'pipe' });
    } catch {
      // Non-fatal
    }

    // Initial commit if repo has no commits
    try {
      execSync('git log --oneline -1', { cwd, stdio: 'pipe' });
      // Has commits — check for uncommitted new files
      const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
      if (status) {
        execSync('git add -A', { cwd, stdio: 'pipe' });
        execSync('git commit -m "chore: cv-agent setup"', { cwd, stdio: 'pipe' });
        console.log(chalk.green('  ✓') + ' Changes committed');
      }
    } catch {
      // No commits yet — make initial commit
      try {
        execSync('git add -A', { cwd, stdio: 'pipe' });
        execSync('git commit -m "Initial commit via cv-agent"', { cwd, stdio: 'pipe' });
        console.log(chalk.green('  ✓') + ' Initial commit created');
      } catch { /* empty repo with nothing to commit */ }
    }

    // Push to CV-Hub
    try {
      execSync('git push -u cv-hub main 2>&1', { cwd, stdio: 'pipe', timeout: 30_000 });
      console.log(chalk.green('  ✓') + ' Pushed to CV-Hub');
    } catch {
      // Push may fail if repo doesn't exist yet or auth issue — non-fatal
      console.log(chalk.gray('  (Push skipped — you can push later with: git push cv-hub main)'));
    }
  }

  console.log();

  // ── Step 5: Agent Daemon ────────────────────────────────────────────
  let agentStatus = '';
  const pidFile = join(homedir(), '.config', 'controlvector', 'agent.pid');

  // Check if agent is already running
  let agentRunning = false;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (pid > 0) {
      process.kill(pid, 0); // throws if not running
      agentRunning = true;
      agentStatus = `running (PID ${pid})`;
      console.log(chalk.green('  ✓') + ` Agent already running (PID ${pid})`);
    }
  } catch {
    // PID file missing or process dead
  }

  if (!agentRunning) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question('  Start the CV-Agent daemon? (Y/n): ', (a: string) => {
        rl.close();
        resolve(a.trim().toLowerCase() || 'y');
      });
    });

    if (answer === 'y' || answer === 'yes' || answer === '') {
      const machName = hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      console.log(chalk.gray(`  Starting agent as "${machName}"...`));

      try {
        const { spawn: spawnChild } = await import('node:child_process');
        const child = spawnChild('cva', [
          'agent', '--auto-approve', '--machine', machName, '--working-dir', cwd,
        ], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env },
        });
        child.unref();

        if (child.pid) {
          mkdirSync(join(homedir(), '.config', 'controlvector'), { recursive: true });
          writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
          agentStatus = `running (PID ${child.pid})`;
          console.log(chalk.green('  ✓') + ` Agent started (PID ${child.pid}) — executor "${machName}"`);
        }
      } catch (err: any) {
        console.log(chalk.yellow(`  Could not start agent: ${err.message}`));
        console.log(chalk.gray('  Start manually with: cva agent --auto-approve'));
        agentStatus = 'not started';
      }
    } else {
      agentStatus = 'not started';
      console.log(chalk.gray('  Start anytime with: cva agent --auto-approve'));
    }
  }

  console.log();

  // ── Step 6: Summary ────────────────────────────────────────────────
  console.log(chalk.bold('  Setup Complete'));
  console.log(chalk.gray('  ' + '─'.repeat(40)));
  console.log(`  ${chalk.green('✓')} Authenticated as: ${chalk.cyan(username)}`);
  console.log(`  ${chalk.green('✓')} Repository: ${chalk.cyan(repoName)}`);
  console.log(`  ${chalk.green('✓')} CLAUDE.md: present`);
  if (agentStatus.startsWith('running')) {
    console.log(`  ${chalk.green('✓')} Agent daemon: ${chalk.cyan(agentStatus)}`);
  }
  console.log(chalk.gray('  ' + '─'.repeat(40)));
  console.log();
  console.log('  What\'s next:');
  console.log('    Open Claude.ai and try:');
  console.log(chalk.cyan(`    "Create a task in ${repoName} to add a hello world index.html"`));
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
