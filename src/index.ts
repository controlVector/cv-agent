/**
 * cva — CV-Hub Agent CLI
 *
 * Standalone agent daemon that bridges Claude Code with CV-Hub task dispatch.
 * Binary: cva
 * Package: @controlvector/cv-agent
 */

import { Command } from 'commander';
import { agentCommand } from './commands/agent.js';
import { authCommand } from './commands/auth.js';
import { remoteCommand } from './commands/remote.js';
import { taskCommand } from './commands/task.js';
import { statusCommand } from './commands/status.js';

declare const __CVA_VERSION__: string;

const program = new Command();

program
  .name('cva')
  .description('CV-Hub Agent — bridges Claude Code with CV-Hub task dispatch')
  .version(typeof __CVA_VERSION__ !== 'undefined' ? __CVA_VERSION__ : '1.1.0');

program.addCommand(agentCommand());
program.addCommand(authCommand());
program.addCommand(remoteCommand());
program.addCommand(taskCommand());
program.addCommand(statusCommand());

program.parse(process.argv);
