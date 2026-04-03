/**
 * Tests for Claude Code auth handling in the agent.
 *
 * Tests: containsAuthError(), buildAuthFailureMessage(), checkClaudeAuth(), getClaudeEnv()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  containsAuthError,
  buildAuthFailureMessage,
  AUTH_ERROR_PATTERNS,
} from './agent';

describe('containsAuthError', () => {
  it('detects "Not logged in" in output', () => {
    const result = containsAuthError('Error: Not logged in · Please run /login');
    expect(result).toBe('Not logged in');
  });

  it('detects "Please run /login" in output', () => {
    const result = containsAuthError('Please run /login to authenticate');
    expect(result).toBe('Please run /login');
  });

  it('detects "authentication required" case-insensitively', () => {
    const result = containsAuthError('Authentication Required — please sign in');
    expect(result).toBe('authentication required');
  });

  it('detects "unauthorized" in output', () => {
    const result = containsAuthError('401 Unauthorized');
    expect(result).toBe('unauthorized');
  });

  it('detects "expired token" in output', () => {
    const result = containsAuthError('Your token has expired. expired token detected.');
    expect(result).toBe('expired token');
  });

  it('returns null for normal output', () => {
    const result = containsAuthError('claude-code v1.2.3');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = containsAuthError('');
    expect(result).toBeNull();
  });

  it('detects auth error in multi-line output', () => {
    const output = 'Starting...\nLoading config...\nNot logged in\nExiting.';
    const result = containsAuthError(output);
    expect(result).toBe('Not logged in');
  });
});

describe('buildAuthFailureMessage', () => {
  it('includes error string, machine name, and fix command', () => {
    const msg = buildAuthFailureMessage('Not logged in', 'z840-primary', false);
    expect(msg).toContain('CLAUDE_AUTH_REQUIRED');
    expect(msg).toContain('Not logged in');
    expect(msg).toContain('z840-primary');
    expect(msg).toContain('SSH into z840-primary');
    expect(msg).toContain('claude /login');
  });

  it('suggests API key fallback when not configured', () => {
    const msg = buildAuthFailureMessage('expired token', 'worker-1', false);
    expect(msg).toContain('cva auth set-api-key');
  });

  it('omits API key suggestion when already configured', () => {
    const msg = buildAuthFailureMessage('expired token', 'worker-1', true);
    expect(msg).not.toContain('cva auth set-api-key');
  });
});

describe('AUTH_ERROR_PATTERNS', () => {
  it('contains expected patterns', () => {
    expect(AUTH_ERROR_PATTERNS).toContain('Not logged in');
    expect(AUTH_ERROR_PATTERNS).toContain('Please run /login');
    expect(AUTH_ERROR_PATTERNS).toContain('authentication required');
    expect(AUTH_ERROR_PATTERNS).toContain('unauthorized');
    expect(AUTH_ERROR_PATTERNS).toContain('expired token');
  });
});
