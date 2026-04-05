/**
 * Agent config at ~/.config/cva/config.json
 */

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export type ExecutorRole = 'development' | 'production' | 'ci' | 'staging';
export type DispatchGuard = 'open' | 'confirm' | 'locked';

export interface ExecutorIntegration {
  system: string;
  description: string;
  service_port?: number;
  safe_task_types?: string[];
  unsafe_task_types?: string[];
  self_referential?: boolean;
}

export interface CvaConfig {
  defaultApiUrl?: string;
  defaultPollInterval?: number;
  autoApprove?: boolean;
  anthropic_api_key?: string;

  // Executor identity
  role?: ExecutorRole;
  integration?: ExecutorIntegration;
  tags?: string[];
  owner_project?: string;
  dispatch_guard?: DispatchGuard;

  [key: string]: unknown;
}

/**
 * Load workspace-local agent config from .cva/agent.json (if it exists).
 * This is per-project config, not global.
 */
export async function readWorkspaceConfig(workspaceRoot: string): Promise<Partial<CvaConfig>> {
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(join(workspaceRoot, '.cva', 'agent.json'), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function getConfigPath(): string {
  return join(homedir(), '.config', 'cva', 'config.json');
}

export async function readConfig(): Promise<CvaConfig> {
  try {
    const content = await fs.readFile(getConfigPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function writeConfig(config: CvaConfig): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
