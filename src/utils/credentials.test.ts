/**
 * Tests for credentials.ts
 */

import { describe, it, expect } from 'vitest';
import { parseCredentials, cleanMachineName } from './credentials';

describe('parseCredentials', () => {
  it('parses KEY=VALUE lines', () => {
    const content = `CV_HUB_PAT=abc123
CV_HUB_API=https://api.test.io
`;
    const result = parseCredentials(content);
    expect(result.CV_HUB_PAT).toBe('abc123');
    expect(result.CV_HUB_API).toBe('https://api.test.io');
  });

  it('ignores comments and empty lines', () => {
    const content = `# This is a comment
CV_HUB_PAT=abc123

# Another comment
CV_HUB_API=https://api.test.io
`;
    const result = parseCredentials(content);
    expect(result.CV_HUB_PAT).toBe('abc123');
    expect(result.CV_HUB_API).toBe('https://api.test.io');
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('handles values with equals signs', () => {
    const content = `CV_HUB_PAT=abc=123=def`;
    const result = parseCredentials(content);
    expect(result.CV_HUB_PAT).toBe('abc=123=def');
  });

  it('returns empty object for empty content', () => {
    expect(parseCredentials('')).toEqual({});
  });

  it('handles whitespace around keys and values', () => {
    const content = `  CV_HUB_PAT = abc123  `;
    const result = parseCredentials(content);
    expect(result.CV_HUB_PAT).toBe('abc123');
  });
});

describe('cleanMachineName', () => {
  it('lowercases and trims', () => {
    expect(cleanMachineName('  MyMachine  ')).toBe('mymachine');
  });

  it('replaces spaces with hyphens', () => {
    expect(cleanMachineName('My Machine Name')).toBe('my-machine-name');
  });

  it('replaces multiple spaces with single hyphen', () => {
    expect(cleanMachineName('My   Machine')).toBe('my-machine');
  });
});
