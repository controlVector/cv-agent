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

// ============================================================================
// Types
// ============================================================================

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

async function launchAutoApproveMode(
  prompt: string,
  options: {
    cwd: string;
    creds?: CVHubCredentials;
    taskId?: string;
  },
): Promise<{ exitCode: number; stderr: string }> {
  // Use a stable session ID so we can --continue if a question needs follow-up
  const sessionId = options.taskId
    ? options.taskId.replace(/-/g, '').slice(0, 32).padEnd(32, '0')
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
    : undefined;
  const pendingQuestionIds: string[] = [];

  const runOnce = (inputPrompt: string, isContinue: boolean): Promise<{ exitCode: number; stderr: string }> => {
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
        env: { ...process.env },
      });

      _activeChild = child;
      let stderr = '';
      let lineBuffer = '';

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(data);

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
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        process.stderr.write(data);
      });

      child.on('close', (code, signal) => {
        _activeChild = null;
        resolve({ exitCode: signal === 'SIGKILL' ? 137 : (code ?? 1), stderr });
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
  },
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Spawn Claude Code in interactive mode (no -p flag)
    const child = spawn('claude', [], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    _activeChild = child;
    let stderr = '';
    let stdoutBuffer = '';

    // Send the task prompt as initial input
    child.stdin?.write(prompt + '\n');

    let lastRedirectCheck = Date.now();
    let lineBuffer = '';

    // Tee stdout to terminal while scanning for permission patterns + structured markers
    child.stdout?.on('data', async (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(data); // Tee to terminal
      stdoutBuffer += text;

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
    });

    child.on('close', (code, signal) => {
      _activeChild = null;
      if (signal === 'SIGKILL') {
        resolve({ exitCode: 137, stderr });
      } else {
        resolve({ exitCode: code ?? 1, stderr });
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

  // Claude Code check
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
  } catch {
    console.log();
    console.log(chalk.red('Claude Code CLI not found.') + ' Install it first:');
    console.log(`   ${chalk.cyan('npm install -g @anthropic-ai/claude-code')}`);
    console.log();
    process.exit(1);
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

  // Register executor
  const executor = await withRetry(
    () => registerExecutor(creds, machineName, workingDir),
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
      const task = await withRetry(
        () => pollForTask(creds, state.executorId),
        'Task poll',
      );
      state.lastPoll = Date.now();

      if (task) {
        await executeTask(task, state, creds, options);
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
): Promise<void> {
  const startTime = Date.now();
  state.currentTaskId = task.id;

  // Clear status line
  process.stdout.write('\r\x1b[K');

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
      await sendHeartbeat(creds, state.executorId, task.id, `Claude Code running (${elapsed} elapsed)`);
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
    console.log(chalk.cyan('Launching Claude Code') + ` (${mode} mode)...`);
    if (options.autoApprove) {
      console.log(chalk.gray('   Allowed tools: ') + ALLOWED_TOOLS.join(', '));
    }
    console.log(chalk.gray('-'.repeat(60)));

    let result: { exitCode: number; stderr: string };

    if (options.autoApprove) {
      result = await launchAutoApproveMode(prompt, {
        cwd: options.workingDir,
        creds,
        taskId: task.id,
      });
    } else {
      result = await launchRelayMode(prompt, {
        cwd: options.workingDir,
        creds,
        executorId: state.executorId,
        taskId: task.id,
      });
    }

    console.log(chalk.gray('\n' + '-'.repeat(60)));

    // Capture post-task git state
    const postGitState = capturePostTaskState(options.workingDir, preGitState);
    const payload = buildCompletionPayload(result.exitCode, preGitState, postGitState, startTime);
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
      printBanner('COMPLETED', elapsed, allChangedFiles, postGitState.headSha);

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
      printBanner('ABORTED', elapsed, [], null);

      try {
        await failTask(creds, state.executorId, task.id, 'Aborted by user (Ctrl+C)');
      } catch {}
      state.failedCount++;
    } else {
      const stderrTail = result.stderr.trim().slice(-500);
      sendTaskLog(creds, state.executorId, task.id, 'lifecycle',
        `Claude Code exited with code ${result.exitCode} (${elapsed})`,
        stderrTail ? { stderr_tail: stderrTail } : undefined);

      console.log();
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
