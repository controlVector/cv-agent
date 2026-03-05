/**
 * Tests for config.ts
 */

import { describe, it, expect } from 'vitest';
import { getConfigPath } from './config';
import { homedir } from 'os';
import { join } from 'path';

describe('getConfigPath', () => {
  it('returns path under ~/.config/cva/', () => {
    const path = getConfigPath();
    expect(path).toBe(join(homedir(), '.config', 'cva', 'config.json'));
  });
});
