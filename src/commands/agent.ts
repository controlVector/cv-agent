/**
 * cva agent command
 *
 * Listens for tasks dispatched via CV-Hub and executes them
 * with Claude Code. The agent registers as an executor, polls for tasks,
 * and reports results back.
 *
 * Two execution modes:
 *   --auto-approve: Uses Claude Code -p mode with --allowedTools (proven)
 *   Default (relay): Spawns interactive Claude Code, relays permission prompts
 *
 * Usage:
 *   cva agent                          # Start in relay mode
 *   cva agent --auto-approve           # Start in auto-approve mode
 *   cva agent --machine z840-primary   # Override machine name
 *   cva agent --poll-interval 10       # Check every 10 seconds
 */

import { Command } from 'commander';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import chalk from 'chalk';
import {
  readCredentials,
  getMachineName,
  type CVHubCredentials,
} from '../utils/credentials.js';
import {
  registerExecutor,
  resolveRepoId,
  pollForTask,
  startTask,
  completeTask,
  failTask,
  sendHeartbeat,
  sendTaskLog,
  markOffline,
  createTaskPrompt,
  pollPromptResponse,
  postTaskEvent,
  getEventResponse,
  getRedirects,
} from '../utils/api.js';
import { parseClaudeCodeOutput } from '../utils/output-parser.js';
import {
  capturePreTaskState,
  capturePostTaskState,
  buildCompletionPayload,
  verifyGitRemote,
} from './agent-git.js';
import {
  formatDuration,
  setTerminalTitle,
  printBanner,
  updateStatusLine,
} from '../utils/display.js';
import { withRetry } from '../utils/retry.js';
import { readConfig } from '../utils/config.js';

// ============================================================================
// Types
// ============================================================================

export type AuthStatus = 'authenticated' | 'expired' | 'not_configured' | 'api_key_fallback';

/** Patterns that indicate Claude Code auth failure */
export const AUTH_ERROR_PATTERNS = [
  'Not logged in',
  'Please run /login',
  'authentication required',
  'unauthorized',
  'expired token',
  'not authenticated',
  'login required',
];

interface AgentOptions {
  machine?: string;
  pollInterval: string;
  workingDir: string;
  autoApprove: boolean;
}

interface AgentState {
  executorId: string;
  currentTaskId: string | null;
  completedCount: number;
  failedCount: number;
  lastPoll: number;
  lastTaskEnd: number;
  running: boolean;
  authStatus: AuthStatus;
  machineName: string;
}

interface Task {
  id: string;
  title: string;
  description?: string;
  task_type: string;
  priority: string;
  status: string;
  input?: { description?: string; context?: string; instructions?: string[]; constraints?: string[] };
  repository_id?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  file_paths?: string[];
  timeout_at?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Claude Code auth check & environment
// ============================================================================

/**
 * Check if a string contains Claude Code auth error patterns.
 * Exported for testing.
 */
export function containsAuthError(text: string): string | null {
  const lower = text.toLowerCase();
  for (const pattern of AUTH_ERROR_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return pattern;
    }
  }
  return null;
}

/**
 * Pre-flight check: verify Claude Code is authenticated.
 * Runs `claude --version` and checks output/stderr for auth errors.
 * Returns the detected auth status.
 */
export async function checkClaudeAuth(): Promise<{ status: AuthStatus; error?: string }> {
  try {
    const output = execSync('claude --version 2>&1', {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env },
    });

    const authError = containsAuthError(output);
    if (authError) {
      return { status: 'expired', error: authError };
    }

    return { status: 'authenticated' };
  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '') + (err.message || '');
    const authError = containsAuthError(output);
    if (authError) {
      return { status: 'expired', error: authError };
    }
    // Binary not found or other error — not an auth issue per se
    return { status: 'not_configured', error: output.slice(0, 500) };
  }
}

/**
 * Build the environment for spawning Claude Code.
 * If an Anthropic API key is configured, inject it as ANTHROPIC_API_KEY.
 */
export async function getClaudeEnv(): Promise<{ env: NodeJS.ProcessEnv; usingApiKey: boolean }> {
  const env = { ...process.env };
  let usingApiKey = false;

  // Don't override if already set in environment
  if (!env.ANTHROPIC_API_KEY) {
    try {
      const config = await readConfig();
      if (config.anthropic_api_key) {
        env.ANTHROPIC_API_KEY = config.anthropic_api_key;
        usingApiKey = true;
      }
    } catch {
      // Config read failed — continue without API key
    }
  }

  return { env, usingApiKey };
}

/**
 * Build an actionable auth failure message with machine name and fix instructions.
 */
export function buildAuthFailureMessage(
  errorString: string,
  machineName: string,
  hasApiKeyFallback: boolean,
): string {
  let msg = `CLAUDE_AUTH_REQUIRED: ${errorString}\n`;
  msg += `Machine: ${machineName}\n`;
  msg += `Fix: SSH into ${machineName} and run: claude /login\n`;
  if (!hasApiKeyFallback) {
    msg += `Alternative: Set an API key fallback with: cva auth set-api-key sk-ant-...\n`;
  }
  return msg;
}

// ============================================================================
// Claude Code launcher
// ============================================================================

function buildClaudePrompt(task: Task): string {
  let prompt = '';
  prompt += `You are executing a task dispatched via CV-Hub.\n\n`;
  prompt += `## Task: ${task.title}\n`;
  prompt += `Task ID: ${task.id}\n`;
  prompt += `Priority: ${task.priority}\n`;

  if (task.branch) prompt += `Branch: ${task.branch}\n`;
  if (task.file_paths?.length) prompt += `Focus files: ${task.file_paths.join(', ')}\n`;

  prompt += `\n`;

  // Main instructions
  if (task.description) {
    prompt += task.description;
  } else if (task.input?.description) {
    prompt += task.input.description;
  }

  if (task.input?.context) {
    prompt += `\n\n## Context\n${task.input.context}`;
  }

  if (task.input?.instructions?.length) {
    prompt += `\n\n## Instructions\n`;
    task.input.instructions.forEach((i, idx) => {
      prompt += `${idx + 1}. ${i}\n`;
    });
  }

  if (task.input?.constraints?.length) {
    prompt += `\n\n## Constraints\n`;
    task.input.constraints.forEach(c => {
      prompt += `- ${c}\n`;
    });
  }

  // Git & CV-Hub CLI instructions
  prompt += `\n\n## Git & CV-Hub Instructions\n`;
  prompt += `You have the \`cv\` CLI (@controlvector/cv-git) available for all CV-Hub git operations.\n`;
  prompt += `Use \`cv\` instead of raw \`git\` commands when interacting with CV-Hub repositories:\n`;
  prompt += `  cv push                          # push to CV-Hub\n`;
  prompt += `  cv pr create --title "..."       # create pull request\n`;
  prompt += `  cv issue list                    # list issues\n`;
  prompt += `  cv repo info                     # repo details\n`;
  prompt += `\n`;
  prompt += `For standard git operations (commit, branch, diff, log, status), use regular \`git\` commands.\n`;
  if (task.owner && task.repo) {
    prompt += `\nTarget repository: ${task.owner}/${task.repo}\n`;
    if (task.branch) prompt += `Target branch: ${task.branch}\n`;
  }
  prompt += `\n`;
  prompt += `IMPORTANT: Do NOT run \`cva\` commands. The \`cva\` binary is the agent daemon that launched you — calling it would cause recursion.\n`;

  prompt += `\n\n---\n`;
  prompt += `When complete, provide a brief summary of what you accomplished.\n`;

  return prompt;
}

/** Shared reference to current child process so signal handlers can kill it */
let _activeChild: ChildProcess | null = null;

/** Signal handling state */
let _sigintCount = 0;
let _sigintTimer: ReturnType<typeof setTimeout> | null = null;
let _signalHandlerInstalled = false;

function installSignalHandlers(
  getState: () => AgentState,
  cleanup: () => Promise<void>,
): void {
  if (_signalHandlerInstalled) return;
  _signalHandlerInstalled = true;

  process.on('SIGINT', async () => {
    if (!_activeChild) {
      console.log('\n' + chalk.gray('Agent stopped.'));
      await cleanup();
      process.exit(0);
    }

    _sigintCount++;

    if (_sigintCount === 1) {
      console.log(`\n${chalk.yellow('!')} Press Ctrl+C again within 3s to abort task.`);
      _sigintTimer = setTimeout(() => { _sigintCount = 0; }, 3000);
      return;
    }

    if (_sigintTimer) clearTimeout(_sigintTimer);
    console.log(`\n${chalk.red('X')} Aborting task...`);
    try { _activeChild.kill('SIGKILL'); } catch {}
    _activeChild = null;
    _sigintCount = 0;
  });

  process.on('SIGTERM', async () => {
    console.log(`\n${chalk.gray('Received SIGTERM, shutting down...')}`);
    if (_activeChild) {
      try { _activeChild.kill('SIGKILL'); } catch {}
      _activeChild = null;
    }
    await cleanup();
    process.exit(0);
  });
}

// ============================================================================
// Permission handling
// ============================================================================

/** Tools to pre-approve when --auto-approve is active */
const ALLOWED_TOOLS = [
  'Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)',
  'Glob(*)', 'Grep(*)', 'WebFetch(*)', 'WebSearch(*)',
  'NotebookEdit(*)', 'TodoWrite(*)',
];

/** Permission prompt patterns to detect in relay mode */
const PERMISSION_PATTERNS = [
  /Allow .+ to .+\? \(y\/n\)/,
  /Do you want to proceed\? \(y\/n\)/,
  /\? \(y\/n\)/,
];

// ============================================================================
// Auto-approve mode launcher (proven, -p + --allowedTools)
// ============================================================================

/** Max output buffer size (200KB) — truncate to last 200KB if exceeded */
const MAX_OUTPUT_BYTES = 200 * 1024;

/** Max size for output_final event content (50KB) */
const MAX_OUTPUT_FINAL_BYTES = 50 * 1024;

/** Interval (in bytes) at which to post progress events with output chunks */
const OUTPUT_PROGRESS_INTERVAL = 4096;

async function launchAutoApproveMode(
  prompt: string,
  options: {
    cwd: string;
    creds?: CVHubCredentials;
    taskId?: string;
    executorId?: string;
    spawnEnv?: NodeJS.ProcessEnv;
    machineName?: string;
  },
): Promise<{ exitCode: number; stderr: string; output: string; authFailure?: boolean }> {
  // Use a stable session ID so we can --continue if a question needs follow-up
  const sessionId = options.taskId
    ? options.taskId.replace(/-/g, '').slice(0, 32).padEnd(32, '0')
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
    : undefined;
  const pendingQuestionIds: string[] = [];

  let fullOutput = '';
  let lastProgressBytes = 0;

  const runOnce = (inputPrompt: string, isContinue: boolean): Promise<{ exitCode: number; stderr: string; output: string; authFailure: boolean }> => {
    return new Promise((resolve, reject) => {
      const args: string[] = isContinue
        ? ['-p', inputPrompt, '--continue', '--allowedTools', ...ALLOWED_TOOLS]
        : ['-p', inputPrompt, '--allowedTools', ...ALLOWED_TOOLS];

      if (sessionId && !isContinue) {
        args.push('--session-id', sessionId);
      }

      const child = spawn('claude', args, {
        cwd: options.cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: options.spawnEnv || { ...process.env },
      });

      _activeChild = child;
      let stderr = '';
      let lineBuffer = '';
      let authFailure = false;
      const spawnTime = Date.now();

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(data);

        // Accumulate full output (capped at MAX_OUTPUT_BYTES)
        fullOutput += text;
        if (fullOutput.length > MAX_OUTPUT_BYTES) {
          fullOutput = fullOutput.slice(-MAX_OUTPUT_BYTES);
        }

        // Early exit detection: check first 10s for auth errors
        if (Date.now() - spawnTime < 10_000) {
          const authError = containsAuthError(fullOutput + stderr);
          if (authError) {
            authFailure = true;
            console.log(`\n${chalk.red('!')} Claude Code auth failure detected: "${authError}"`);
            console.log(chalk.yellow(`  Killing process — it won't recover without re-authentication.`));
            if (options.machineName) {
              console.log(chalk.cyan(`  Fix: SSH into ${options.machineName} and run: claude /login`));
            }
            try { child.kill('SIGTERM'); } catch {}
            return;
          }
        }

        if (options.creds && options.taskId) {
          lineBuffer += text;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';

          for (const line of lines) {
            const event = parseClaudeCodeOutput(line);
            if (event) {
              postTaskEvent(options.creds, options.taskId, {
                event_type: event.eventType,
                content: event.content,
                needs_response: event.needsResponse,
              }).then((created) => {
                if (event.needsResponse && created?.id) {
                  pendingQuestionIds.push(created.id);
                }
              }).catch(() => {});
            }
          }

          // Post periodic progress with output chunk
          if (fullOutput.length - lastProgressBytes >= OUTPUT_PROGRESS_INTERVAL) {
            const chunk = fullOutput.slice(lastProgressBytes).slice(-OUTPUT_PROGRESS_INTERVAL);
            lastProgressBytes = fullOutput.length;
            if (options.executorId) {
              sendTaskLog(options.creds!, options.executorId, options.taskId!, 'progress',
                'Claude Code output', { output_chunk: chunk }).catch(() => {});
            }
            // Also post as output event for cv_task_summary/stream visibility
            postTaskEvent(options.creds!, options.taskId!, {
              event_type: 'output',
              content: { chunk, byte_offset: lastProgressBytes },
            }).catch(() => {});
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        process.stderr.write(data);

        // Early exit detection on stderr too
        if (Date.now() - spawnTime < 10_000 && !authFailure) {
          const authError = containsAuthError(text);
          if (authError) {
            authFailure = true;
            console.log(`\n${chalk.red('!')} Claude Code auth failure (stderr): "${authError}"`);
            try { child.kill('SIGTERM'); } catch {}
          }
        }
      });

      child.on('close', (code, signal) => {
        _activeChild = null;
        resolve({
          exitCode: signal === 'SIGKILL' ? 137 : (code ?? 1),
          stderr, output: fullOutput,
          authFailure,
        });
      });

      child.on('error', (err) => {
        _activeChild = null;
        reject(err);
      });
    });
  };

  // Initial run
  let result = await runOnce(prompt, false);

  // If there were unanswered questions and the task isn't aborted,
  // attempt to continue with responses (up to 3 follow-ups)
  if (options.creds && options.taskId && result.exitCode === 0) {
    let followUps = 0;
    while (pendingQuestionIds.length > 0 && followUps < 3) {
      const questionId = pendingQuestionIds.shift()!;
      console.log(chalk.gray(`  [auto-approve] Waiting for planner response to question...`));

      const response = await pollForEventResponse(
        options.creds, options.taskId, questionId, 300_000,
      );

      if (response) {
        const responseText = typeof response === 'string' ? response : JSON.stringify(response);
        console.log(chalk.gray(`  [auto-approve] Planner responded, continuing with --continue`));
        result = await runOnce(responseText, true);
        followUps++;
      } else {
        console.log(chalk.yellow(`  [auto-approve] No response received, continuing without.`));
        break;
      }
    }
  }

  return result;
}

// ============================================================================
// Relay mode launcher (interactive, permission prompts relayed to CV-Hub)
// ============================================================================

async function launchRelayMode(
  prompt: string,
  options: {
    cwd: string;
    creds: CVHubCredentials;
    executorId: string;
    taskId: string;
    spawnEnv?: NodeJS.ProcessEnv;
    machineName?: string;
  },
): Promise<{ exitCode: number; stderr: string; output: string; authFailure?: boolean }> {
  return new Promise((resolve, reject) => {
    // Spawn Claude Code in interactive mode (no -p flag)
    const child = spawn('claude', [], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.spawnEnv || { ...process.env },
    });

    _activeChild = child;
    let stderr = '';
    let stdoutBuffer = '';
    let fullOutput = '';
    let lastProgressBytes = 0;
    let authFailure = false;
    const spawnTime = Date.now();

    // Send the task prompt as initial input
    child.stdin?.write(prompt + '\n');

    let lastRedirectCheck = Date.now();
    let lineBuffer = '';

    // Tee stdout to terminal while scanning for permission patterns + structured markers
    child.stdout?.on('data', async (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(data); // Tee to terminal
      stdoutBuffer += text;

      // Accumulate full output (capped at MAX_OUTPUT_BYTES)
      fullOutput += text;
      if (fullOutput.length > MAX_OUTPUT_BYTES) {
        fullOutput = fullOutput.slice(-MAX_OUTPUT_BYTES);
      }

      // Early exit detection: check first 10s for auth errors
      if (Date.now() - spawnTime < 10_000 && !authFailure) {
        const authError = containsAuthError(fullOutput + stderr);
        if (authError) {
          authFailure = true;
          console.log(`\n${chalk.red('!')} Claude Code auth failure detected: "${authError}"`);
          try { child.kill('SIGTERM'); } catch {}
          return;
        }
      }

      // Parse line-by-line for structured markers
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const event = parseClaudeCodeOutput(line);
        if (event) {
          try {
            const created = await postTaskEvent(options.creds, options.taskId, {
              event_type: event.eventType,
              content: event.content,
              needs_response: event.needsResponse,
            });

            // If question, wait for response via task events
            if (event.needsResponse && created?.id) {
              console.log(chalk.gray(`  [stream] Question detected, waiting for planner response...`));
              const response = await pollForEventResponse(
                options.creds, options.taskId, created.id, 300_000,
              );
              if (response) {
                const responseText = typeof response === 'string' ? response : JSON.stringify(response);
                child.stdin?.write(responseText + '\n');
                console.log(chalk.gray(`  [stream] Planner responded.`));
              } else {
                child.stdin?.write('[No response received within timeout. Continue with your best judgment.]\n');
                console.log(chalk.yellow(`  [stream] Question timed out.`));
              }
            }
          } catch {
            // Non-fatal: don't block execution
          }
        }
      }

      // Post periodic progress with output chunk
      if (fullOutput.length - lastProgressBytes >= OUTPUT_PROGRESS_INTERVAL) {
        const chunk = fullOutput.slice(lastProgressBytes).slice(-OUTPUT_PROGRESS_INTERVAL);
        lastProgressBytes = fullOutput.length;
        sendTaskLog(options.creds, options.executorId, options.taskId, 'progress',
          'Claude Code output', { output_chunk: chunk }).catch(() => {});
        // Also post as output event for cv_task_summary/stream visibility
        postTaskEvent(options.creds, options.taskId, {
          event_type: 'output',
          content: { chunk, byte_offset: lastProgressBytes },
        }).catch(() => {});
      }

      // Periodic redirect check (every 10 seconds)
      if (Date.now() - lastRedirectCheck > 10_000) {
        try {
          const redirects = await getRedirects(
            options.creds, options.taskId,
            new Date(lastRedirectCheck).toISOString(),
          );
          for (const redirect of redirects) {
            const instruction = redirect.content?.instruction;
            if (instruction) {
              child.stdin?.write(`\n[REDIRECT FROM PLANNER]: ${instruction}\n`);
              console.log(chalk.gray(`  [stream] Redirect received from planner.`));
            }
          }
        } catch {
          // Non-fatal
        }
        lastRedirectCheck = Date.now();
      }

      // Check for permission prompts (existing relay logic)
      for (const pattern of PERMISSION_PATTERNS) {
        const match = stdoutBuffer.match(pattern);
        if (match) {
          const promptText = match[0];
          stdoutBuffer = ''; // Reset buffer after match

          try {
            await sendTaskLog(
              options.creds,
              options.executorId,
              options.taskId,
              'info',
              `Permission prompt: ${promptText}`,
              { prompt_text: promptText },
            );

            const { prompt_id } = await createTaskPrompt(
              options.creds,
              options.executorId,
              options.taskId,
              promptText,
              'approval',
              ['y', 'n'],
            );

            // Also emit as approval_request event
            postTaskEvent(options.creds, options.taskId, {
              event_type: 'approval_request',
              content: { prompt_text: promptText },
              needs_response: true,
            }).catch(() => {});

            const timeoutMs = 5 * 60 * 1000;
            const startPoll = Date.now();
            let answered = false;

            while (Date.now() - startPoll < timeoutMs) {
              await new Promise(r => setTimeout(r, 2000));

              try {
                const { response } = await pollPromptResponse(
                  options.creds,
                  options.executorId,
                  options.taskId,
                  prompt_id,
                );

                if (response !== null) {
                  const answer = response.toLowerCase().startsWith('y') ? 'y' : 'n';
                  child.stdin?.write(answer + '\n');
                  answered = true;
                  console.log(chalk.gray(`  [relay] User responded: ${answer}`));
                  break;
                }
              } catch {
                // Poll error — continue
              }
            }

            if (!answered) {
              child.stdin?.write('n\n');
              console.log(chalk.yellow(`  [relay] Prompt timed out, denying.`));
            }
          } catch (err: any) {
            child.stdin?.write('n\n');
            console.log(chalk.yellow(`  [relay] Prompt relay error: ${err.message}, denying.`));
          }

          break;
        }
      }

      // Keep buffer manageable (only last 2KB)
      if (stdoutBuffer.length > 2048) {
        stdoutBuffer = stdoutBuffer.slice(-1024);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(data);

      // Early exit detection on stderr
      if (Date.now() - spawnTime < 10_000 && !authFailure) {
        const authError = containsAuthError(text);
        if (authError) {
          authFailure = true;
          console.log(`\n${chalk.red('!')} Claude Code auth failure (stderr): "${authError}"`);
          try { child.kill('SIGTERM'); } catch {}
        }
      }
    });

    child.on('close', (code, signal) => {
      _activeChild = null;
      if (signal === 'SIGKILL') {
        resolve({ exitCode: 137, stderr, output: fullOutput, authFailure });
      } else {
        resolve({ exitCode: code ?? 1, stderr, output: fullOutput, authFailure });
      }
    });

    child.on('error', (err) => {
      _activeChild = null;
      reject(err);
    });
  });
}

// ============================================================================
// Event response polling
// ============================================================================

async function pollForEventResponse(
  creds: CVHubCredentials,
  taskId: string,
  eventId: string,
  timeoutMs: number,
): Promise<unknown | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const result = await getEventResponse(creds, taskId, eventId);
      if (result.response !== null) {
        return result.response;
      }
    } catch {
      // Continue polling
    }
  }
  return null;
}

// ============================================================================
// Self-update handler
// ============================================================================

async function handleSelfUpdate(
  task: Task,
  state: AgentState,
  creds: CVHubCredentials,
): Promise<void> {
  const startTime = Date.now();
  try {
    await startTask(creds, state.executorId, task.id);
    sendTaskLog(creds, state.executorId, task.id, 'lifecycle', 'Self-update started');

    const source = (task.input?.description || task.description || 'npm').trim();
    let output = '';

    if (source === 'npm' || source.startsWith('npm:')) {
      const pkg = source === 'npm' ? '@controlvector/cv-agent@latest' : source.replace('npm:', '');
      output = execSync(`npm install -g ${pkg} 2>&1`, { encoding: 'utf8', timeout: 120_000 });
    } else if (source.startsWith('git:')) {
      const repoPath = source.replace('git:', '');
      output = execSync(`cd ${repoPath} && git pull && npm install && npm run build && npm link 2>&1`, {
        encoding: 'utf8', timeout: 300_000,
      });
    } else {
      // Default: try npm
      output = execSync(`npm install -g @controlvector/cv-agent@latest 2>&1`, { encoding: 'utf8', timeout: 120_000 });
    }

    let newVersion = 'unknown';
    try {
      newVersion = execSync('cva --version 2>/dev/null || echo unknown', { encoding: 'utf8' }).trim();
    } catch {}

    // Post output as event so planner can see it
    postTaskEvent(creds, task.id, {
      event_type: 'output_final',
      content: { output: output.slice(-10000), new_version: newVersion },
    }).catch(() => {});

    sendTaskLog(creds, state.executorId, task.id, 'lifecycle',
      `Self-update completed. New version: ${newVersion}`, { output: output.slice(-5000) }, 100);

    await completeTask(creds, state.executorId, task.id, {
      summary: `Updated to ${newVersion}`,
      exit_code: 0,
      stats: { duration_seconds: Math.round((Date.now() - startTime) / 1000) },
    });
    state.completedCount++;

    // Restart if requested
    if (task.input?.constraints?.includes('restart')) {
      console.log(chalk.yellow('Restarting agent with updated binary...'));
      const args = process.argv.slice(1).join(' ');
      execSync(`nohup cva ${args} > /tmp/cva-restart.log 2>&1 &`, { stdio: 'ignore' });
      process.exit(0);
    }
  } catch (err: any) {
    sendTaskLog(creds, state.executorId, task.id, 'error', `Self-update failed: ${err.message}`);
    try { await failTask(creds, state.executorId, task.id, err.message); } catch {}
    state.failedCount++;
  } finally {
    state.currentTaskId = null;
    state.lastTaskEnd = Date.now();
  }
}

// ============================================================================
// Main agent loop
// ============================================================================

async function runAgent(options: AgentOptions): Promise<void> {
  const creds = await readCredentials();

  if (!creds.CV_HUB_API) {
    creds.CV_HUB_API = 'https://api.hub.controlvector.io';
  }

  if (!creds.CV_HUB_PAT) {
    console.log();
    console.log(chalk.red('Not authenticated.') + ' Run ' + chalk.cyan('cva auth login') + ' first.');
    console.log();
    console.log(chalk.bold('Quick setup:'));
    console.log(`  ${chalk.cyan('cva auth login')}                   # Authenticate`);
    console.log(`  ${chalk.cyan('cd ~/project/my-project')}          # Go to your project`);
    console.log(`  ${chalk.cyan('cva agent')}                        # Start listening`);
    console.log();
    process.exit(1);
  }

  // Claude Code check (binary + auth pre-flight)
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
  } catch {
    console.log();
    console.log(chalk.red('Claude Code CLI not found.') + ' Install it first:');
    console.log(`   ${chalk.cyan('npm install -g @anthropic-ai/claude-code')}`);
    console.log();
    process.exit(1);
  }

  // Pre-flight auth check
  const { env: claudeEnv, usingApiKey } = await getClaudeEnv();
  const authCheck = await checkClaudeAuth();
  let currentAuthStatus: AuthStatus = authCheck.status;

  if (authCheck.status === 'expired') {
    if (usingApiKey) {
      console.log(chalk.yellow('!') + ' Claude Code OAuth expired, but API key fallback is configured.');
      currentAuthStatus = 'api_key_fallback';
    } else {
      console.log();
      console.log(chalk.red('Claude Code auth expired: ') + chalk.yellow(authCheck.error || 'unknown'));
      console.log(`   Fix: Run ${chalk.cyan('claude /login')} to re-authenticate.`);
      console.log(`   Alternative: ${chalk.cyan('cva auth set-api-key sk-ant-...')} for API key fallback.`);
      console.log();
      console.log(chalk.gray('Agent will start but pause task claims until auth is resolved.'));
      console.log();
    }
  } else if (usingApiKey) {
    console.log(chalk.gray('   Using Anthropic API key from config as fallback.'));
    currentAuthStatus = 'api_key_fallback';
  }

  // cv-git check (warn, don't block)
  try {
    execSync('cv --version', { stdio: 'pipe', timeout: 5000 });
  } catch {
    console.log(chalk.yellow('!') + ' cv-git CLI not found. Claude Code will fall back to raw git commands.');
    console.log(`  Install it: ${chalk.cyan('npm install -g @controlvector/cv-git')}`);
    console.log();
  }

  const machineName = options.machine || await getMachineName();
  const pollInterval = Math.max(3, parseInt(options.pollInterval, 10)) * 1000;
  const workingDir = options.workingDir === '.' ? process.cwd() : options.workingDir;

  if (!options.machine) {
    const credCheck = await readCredentials();
    if (!credCheck.CV_HUB_MACHINE_NAME) {
      console.log();
      console.log(chalk.yellow('!') + ` No machine name set. Registering as "${chalk.bold(machineName)}".`);
      console.log(chalk.gray(`  Use --machine <name> to override.`));
      console.log();
    }
  }

  // Auto-detect CV-Hub repository from git remote
  let detectedRepoId: string | undefined;
  try {
    const remoteUrl = execSync('git remote get-url origin 2>/dev/null', {
      cwd: workingDir,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    const cvHubMatch = remoteUrl.match(
      /git\.hub\.controlvector\.io[:/]([^/]+)\/([^/.]+)/
    );

    if (cvHubMatch) {
      const [, repoOwner, repoSlug] = cvHubMatch;
      try {
        const repoData = await resolveRepoId(creds, repoOwner, repoSlug);
        if (repoData?.id) {
          detectedRepoId = repoData.id;
          console.log(chalk.gray(`   Repo:     ${repoOwner}/${repoSlug}`));
        }
      } catch {
        // API call failed — register without repo binding
      }
    }
  } catch {
    // Not a git repo or no origin remote — that's fine
  }

  // Register executor
  const executor = await withRetry(
    () => registerExecutor(creds, machineName, workingDir, detectedRepoId),
    'Executor registration',
  );

  // Display banner
  const mode = options.autoApprove ? 'auto-approve' : 'relay';
  console.log();
  console.log(chalk.bold('CVA — CV-Hub Agent'));
  console.log(`   Machine:  ${chalk.cyan(machineName)}`);
  console.log(`   Executor: ${chalk.gray(executor.id)}`);
  console.log(`   API:      ${chalk.gray(creds.CV_HUB_API)}`);
  console.log(`   Dir:      ${chalk.gray(workingDir)}`);
  console.log(`   Polling:  every ${options.pollInterval}s`);
  console.log(`   Mode:     ${chalk.cyan(mode)}`);
  console.log(`   Ctrl+C to stop`);
  console.log();
  console.log(chalk.cyan('Listening for tasks...'));
  console.log();

  const state: AgentState = {
    executorId: executor.id,
    currentTaskId: null,
    completedCount: 0,
    failedCount: 0,
    lastPoll: Date.now(),
    lastTaskEnd: Date.now(),
    running: true,
    authStatus: currentAuthStatus,
    machineName,
  };

  installSignalHandlers(
    () => state,
    async () => {
      state.running = false;
      await markOffline(creds, state.executorId);
    },
  );

  // Main loop
  while (state.running) {
    try {
      // If auth is expired (no fallback), re-check periodically instead of claiming tasks
      if (state.authStatus === 'expired') {
        const recheck = await checkClaudeAuth();
        if (recheck.status === 'authenticated') {
          state.authStatus = 'authenticated';
          console.log(`\n${chalk.green('✓')} Claude Code auth restored. Resuming task claims.`);
        } else {
          // Still expired — heartbeat but don't poll for tasks
          sendHeartbeat(creds, state.executorId, undefined, undefined, state.authStatus).catch(() => {});
          await new Promise(r => setTimeout(r, pollInterval));
          continue;
        }
      }

      const task = await withRetry(
        () => pollForTask(creds, state.executorId),
        'Task poll',
      );
      state.lastPoll = Date.now();

      if (task) {
        await executeTask(task, state, creds, options, claudeEnv);
      } else {
        updateStatusLine(
          formatDuration(Date.now() - state.lastTaskEnd),
          formatDuration(Date.now() - state.lastPoll),
          state.completedCount,
          state.failedCount,
        );
      }
    } catch (err: any) {
      console.log(`\n${chalk.red('!')} Error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }
}

async function executeTask(
  task: Task,
  state: AgentState,
  creds: CVHubCredentials,
  options: AgentOptions,
  claudeEnv?: NodeJS.ProcessEnv,
): Promise<void> {
  const startTime = Date.now();
  state.currentTaskId = task.id;

  // Handle system update tasks — no Claude Code, just self-update
  if (task.task_type === '_system_update') {
    await handleSelfUpdate(task, state, creds);
    return;
  }

  // Clear status line
  process.stdout.write('\r\x1b[K');

  // Task received
  console.log(`📥 ${chalk.bold.cyan('RECEIVED')}  — Task: ${task.title} (${task.priority})`);

  // Task header
  console.log(chalk.bold('┌─────────────────────────────────────────────────────────────┐'));
  console.log(chalk.bold(`│ Task: ${(task.title || '').substring(0, 53).padEnd(53)}│`));
  console.log(chalk.bold(`│ ID: ${task.id.padEnd(55)}│`));
  console.log(chalk.bold(`│ Priority: ${task.priority.padEnd(49)}│`));
  console.log(chalk.bold('└─────────────────────────────────────────────────────────────┘'));
  console.log();

  // Mark task as running
  try {
    await startTask(creds, state.executorId, task.id);
    setTerminalTitle(`cva: ${task.title} (starting...)`);
    sendTaskLog(creds, state.executorId, task.id, 'lifecycle', 'Task started, launching Claude Code');
  } catch (err: any) {
    console.log(chalk.red(`Failed to start task: ${err.message}`));
    state.currentTaskId = null;
    return;
  }

  // Heartbeat timer
  const heartbeatTimer = setInterval(async () => {
    try {
      const elapsed = formatDuration(Date.now() - startTime);
      setTerminalTitle(`cva: ${task.title} (${elapsed})`);
      await sendHeartbeat(creds, state.executorId, task.id, `Claude Code running (${elapsed} elapsed)`, state.authStatus);
    } catch {}
  }, 30_000);

  // Timeout timer
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  if (task.timeout_at) {
    const timeoutMs = new Date(task.timeout_at).getTime() - Date.now();
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        console.log(`\n${chalk.red('Timeout')} Task timed out after ${formatDuration(timeoutMs)}`);
      }, timeoutMs);
    }
  }

  // Capture pre-task git state
  const preGitState = capturePreTaskState(options.workingDir);

  // Verify/fix git remote
  const gitHost = (creds.CV_HUB_API || 'https://api.hub.controlvector.io')
    .replace(/^https?:\/\//, '')
    .replace(/^api\./, 'git.');
  const remoteInfo = verifyGitRemote(options.workingDir, task, gitHost);
  if (remoteInfo) {
    console.log(chalk.gray(`   Git remote: ${remoteInfo.remoteName} -> ${remoteInfo.remoteUrl}`));
  }

  // Build prompt and launch
  const prompt = buildClaudePrompt(task);

  try {
    const mode = options.autoApprove ? 'auto-approve' : 'relay';
    console.log(`🚀 ${chalk.bold.green('RUNNING')}   — Launching Claude Code (${mode})...`);
    if (options.autoApprove) {
      console.log(chalk.gray('   Allowed tools: ') + ALLOWED_TOOLS.join(', '));
    }
    console.log(chalk.gray('-'.repeat(60)));

    let result: { exitCode: number; stderr: string; output: string; authFailure?: boolean };

    if (options.autoApprove) {
      result = await launchAutoApproveMode(prompt, {
        cwd: options.workingDir,
        creds,
        taskId: task.id,
        executorId: state.executorId,
        spawnEnv: claudeEnv,
        machineName: state.machineName,
      });
    } else {
      result = await launchRelayMode(prompt, {
        cwd: options.workingDir,
        creds,
        executorId: state.executorId,
        taskId: task.id,
        spawnEnv: claudeEnv,
        machineName: state.machineName,
      });
    }

    console.log(chalk.gray('\n' + '-'.repeat(60)));

    // Capture post-task git state
    const postGitState = capturePostTaskState(options.workingDir, preGitState);
    const payload = buildCompletionPayload(result.exitCode, preGitState, postGitState, startTime, result.output);
    const elapsed = formatDuration(Date.now() - startTime);
    const allChangedFiles = [
      ...postGitState.filesAdded,
      ...postGitState.filesModified,
      ...postGitState.filesDeleted,
    ];

    // Emit completion event via task events
    postTaskEvent(creds, task.id, {
      event_type: 'completed',
      content: {
        exit_code: result.exitCode,
        duration_seconds: Math.round((Date.now() - startTime) / 1000),
        files_changed: allChangedFiles.length,
      },
    }).catch(() => {});

    if (result.exitCode === 0) {
      if (allChangedFiles.length > 0) {
        sendTaskLog(creds, state.executorId, task.id, 'git',
          `${allChangedFiles.length} file(s) changed (+${postGitState.linesAdded}/-${postGitState.linesDeleted})`,
          { added: postGitState.filesAdded.slice(0, 10), modified: postGitState.filesModified.slice(0, 10), deleted: postGitState.filesDeleted.slice(0, 10) });
      }

      sendTaskLog(creds, state.executorId, task.id, 'lifecycle',
        `Claude Code completed successfully (${elapsed})`, undefined, 100);

      console.log();
      console.log(`✅ ${chalk.bold.green('COMPLETED')} — Duration: ${elapsed}`);
      printBanner('COMPLETED', elapsed, allChangedFiles, postGitState.headSha);

      // Post final output as event for planner visibility
      postTaskEvent(creds, task.id, {
        event_type: 'output_final',
        content: {
          output: result.output.slice(-MAX_OUTPUT_FINAL_BYTES),
          exit_code: result.exitCode,
          duration_seconds: Math.round((Date.now() - startTime) / 1000),
        },
      }).catch(() => {});

      await withRetry(
        () => completeTask(creds, state.executorId, task.id, payload as unknown as Record<string, unknown>),
        'Report completion',
      );
      state.completedCount++;

      console.log(chalk.gray('   Reported to CV-Hub.'));
    } else if (result.exitCode === 137) {
      sendTaskLog(creds, state.executorId, task.id, 'lifecycle',
        'Task aborted by user (Ctrl+C)');

      console.log();
      console.log(`⏹ ${chalk.bold.yellow('ABORTED')}   — Duration: ${elapsed}`);
      printBanner('ABORTED', elapsed, [], null);

      try {
        await failTask(creds, state.executorId, task.id, 'Aborted by user (Ctrl+C)');
      } catch {}
      state.failedCount++;
    } else if (result.authFailure) {
      // Auth failure — produce actionable error message
      const authErrorStr = containsAuthError(result.output + result.stderr) || 'auth failure';
      const hasApiKey = !!(claudeEnv?.ANTHROPIC_API_KEY);
      const authMsg = buildAuthFailureMessage(authErrorStr, state.machineName, hasApiKey);

      sendTaskLog(creds, state.executorId, task.id, 'error', authMsg);

      console.log();
      console.log(`🔑 ${chalk.bold.red('AUTH FAILED')} — Claude Code is not authenticated`);
      console.log(chalk.yellow(`   ${authMsg.replace(/\n/g, '\n   ')}`));

      // Emit specific auth failure event
      postTaskEvent(creds, task.id, {
        event_type: 'auth_failure',
        content: {
          error: authErrorStr,
          machine: state.machineName,
          fix_command: `claude /login`,
          api_key_configured: hasApiKey,
        },
      }).catch(() => {});

      await withRetry(
        () => failTask(creds, state.executorId, task.id, authMsg),
        'Report auth failure',
      );
      state.failedCount++;

      // Set auth status to expired so we stop claiming tasks
      state.authStatus = 'expired';
      console.log(chalk.yellow('   Pausing task claims until auth is restored.'));
    } else {
      const stderrTail = result.stderr.trim().slice(-500);
      sendTaskLog(creds, state.executorId, task.id, 'lifecycle',
        `Claude Code exited with code ${result.exitCode} (${elapsed})`,
        stderrTail ? { stderr_tail: stderrTail } : undefined);

      console.log();
      console.log(`❌ ${chalk.bold.red('FAILED')}    — Duration: ${elapsed} (exit code ${result.exitCode})`);
      printBanner('FAILED', elapsed, allChangedFiles, postGitState.headSha);

      const errorDetail = result.stderr.trim()
        ? `${result.stderr.trim().slice(-1500)}\n\nExit code ${result.exitCode} after ${elapsed}.`
        : `Claude Code exited with code ${result.exitCode} after ${elapsed}.`;

      await withRetry(
        () => failTask(creds, state.executorId, task.id, errorDetail),
        'Report failure',
      );
      state.failedCount++;
    }
  } catch (err: any) {
    console.log(`\n${chalk.red('!')} Task error: ${err.message}`);

    sendTaskLog(creds, state.executorId, task.id, 'error',
      `Agent error: ${err.message}`);

    try {
      await failTask(creds, state.executorId, task.id, err.message);
    } catch {}
    state.failedCount++;
  } finally {
    clearInterval(heartbeatTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    state.currentTaskId = null;
    state.lastTaskEnd = Date.now();
  }

  setTerminalTitle('cva: listening...');
  console.log();
  console.log(chalk.cyan('Listening for tasks...'));
  console.log();
}

// ============================================================================
// Command definition
// ============================================================================

export function agentCommand(): Command {
  const cmd = new Command('agent');
  cmd.description('Listen for tasks dispatched via CV-Hub and execute them with Claude Code');

  cmd.option('--machine <name>', 'Override auto-detected machine name');
  cmd.option('--poll-interval <seconds>', 'How often to check for tasks, minimum 3 (default: 5)', '5');
  cmd.option('--working-dir <path>', 'Working directory for Claude Code (default: current directory)', '.');
  cmd.option('--auto-approve', 'Pre-approve all tool permissions (uses -p mode)', false);

  cmd.action(async (opts: AgentOptions) => {
    await runAgent(opts);
  });

  return cmd;
}
