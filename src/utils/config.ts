/**
 * Agent config at ~/.config/cva/config.json
 */

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export interface CvaConfig {
  defaultApiUrl?: string;
  defaultPollInterval?: number;
  autoApprove?: boolean;
  anthropic_api_key?: string;
  [key: string]: unknown;
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
