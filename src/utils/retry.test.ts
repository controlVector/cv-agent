/**
 * Tests for retry.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from './retry';

// Suppress console.log from retry warnings
vi.spyOn(console, 'log').mockImplementation(() => {});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, 'test', 3);

    // First retry waits 5s
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries', async () => {
    // maxRetries=1 means no retry delay — just one attempt then throw
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(withRetry(fn, 'test', 1)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
