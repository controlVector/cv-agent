/**
 * Retry logic for API calls.
 */

import chalk from 'chalk';

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === maxRetries - 1) throw err;
      const delay = (i + 1) * 5;
      console.log(`\n${chalk.yellow('⚠')} ${label} failed, retrying in ${delay}s... (${err.message})`);
      await new Promise(r => setTimeout(r, delay * 1000));
    }
  }
  throw new Error('unreachable');
}
