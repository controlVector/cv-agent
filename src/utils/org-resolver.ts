/**
 * Multi-Organization Resolver
 *
 * Resolves which CV-Hub organization an executor should register under.
 * Layered precedence: CLI flag > env var > repo-local config > global config > interactive.
 *
 * Design: repo-local persistence is the recommended default to prevent
 * accidental cross-org registration on multi-org workstations.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';

export interface Organization {
  id: string;
  name: string;
  slug: string;
}

export interface ResolvedOrg {
  value: string;
  source: 'cli' | 'env' | 'repo-config' | 'global-config' | null;
}

export type AutoMatchDecision = 'accept' | 'abort' | 'pick';
export type PersistScope = 'repo' | 'global' | 'none';

// ============================================================================
// Resolve from config chain (no I/O prompts)
// ============================================================================

export function resolveOrg(opts: { cliFlag?: string; cwd?: string }): ResolvedOrg {
  if (opts.cliFlag?.trim()) {
    return { value: opts.cliFlag.trim(), source: 'cli' };
  }

  const envVal = process.env.CV_HUB_ORG?.trim();
  if (envVal) {
    return { value: envVal, source: 'env' };
  }

  const cwd = opts.cwd || process.cwd();
  try {
    const repoConfigPath = join(cwd, '.cva', 'agent.json');
    if (existsSync(repoConfigPath)) {
      const config = JSON.parse(readFileSync(repoConfigPath, 'utf-8'));
      if (config.organization?.trim()) {
        return { value: config.organization.trim(), source: 'repo-config' };
      }
    }
  } catch {}

  try {
    const globalConfigPath = join(homedir(), '.config', 'cva', 'config.json');
    if (existsSync(globalConfigPath)) {
      const config = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
      if (config.organization?.trim()) {
        return { value: config.organization.trim(), source: 'global-config' };
      }
    }
  } catch {}

  return { value: '', source: null };
}

// ============================================================================
// UUID / slug resolution
// ============================================================================

export function resolveToUUID(identifier: string, orgs: Organization[]): string {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (uuidRegex.test(identifier)) {
    const match = orgs.find(o => o.id.toLowerCase() === identifier.toLowerCase());
    if (match) return match.id;
  }

  const slugMatch = orgs.find(o => o.slug.toLowerCase() === identifier.toLowerCase());
  if (slugMatch) return slugMatch.id;

  throw new Error(
    `Organization "${identifier}" not found. Valid options: ${orgs.map(o => o.slug).join(', ')}`
  );
}

// ============================================================================
// Persist choice
// ============================================================================

export function persistOrg(value: string, scope: PersistScope, cwd?: string): string {
  let configPath: string;

  if (scope === 'repo') {
    const dir = join(cwd || process.cwd(), '.cva');
    mkdirSync(dir, { recursive: true });
    configPath = join(dir, 'agent.json');
  } else {
    const dir = join(homedir(), '.config', 'cva');
    mkdirSync(dir, { recursive: true });
    configPath = join(dir, 'config.json');
  }

  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch {}

  existing.organization = value;

  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(existing, null, 2) + '\n', {
    mode: scope === 'global' ? 0o600 : 0o644,
  });
  renameSync(tmpPath, configPath);

  return configPath;
}

// ============================================================================
// Persist scope prompt (reusable)
// ============================================================================

export async function promptPersistScope(): Promise<PersistScope> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log();
  console.log(chalk.gray('  Save this choice for next time?'));
  console.log(`    ${chalk.cyan('r')}. Save to this repo's .cva/agent.json ${chalk.gray('(recommended)')}`);
  console.log(`    ${chalk.cyan('g')}. Save globally to ~/.config/cva/config.json`);
  console.log(`    ${chalk.cyan('n')}. Don't save — prompt again next time`);
  console.log();

  const input = await new Promise<string>((resolve) => {
    rl.question('  Choice [r/g/n] (default: r): ', (answer: string) => {
      rl.close();
      resolve(answer.trim().toLowerCase() || 'r');
    });
  });

  return input === 'g' ? 'global' : input === 'n' ? 'none' : 'repo';
}

// ============================================================================
// Auto-match confirmation
// ============================================================================

export async function confirmAutoMatch(
  match: Organization,
  sourceSlug: string,
): Promise<AutoMatchDecision> {
  const readline = await import('node:readline');

  console.log();
  console.log(`  Auto-matched organization: ${chalk.bold(match.name)} (${match.slug})`);
  console.log(chalk.gray(`    from repo owner: ${sourceSlug}`));
  console.log();
  console.log(`  Register executor under ${match.name}?`);
  console.log(`    ${chalk.cyan('Y')} — yes, use ${match.name}`);
  console.log(`    ${chalk.cyan('n')} — no, abort`);
  console.log(`    ${chalk.cyan('p')} — show the full org list and pick manually`);
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let attempts = 0;
  while (attempts < 2) {
    const input = await new Promise<string>((resolve) => {
      rl.question('  Choice [Y/n/p] (default: Y): ', (answer: string) => {
        resolve(answer.trim().toLowerCase() || 'y');
      });
    });

    if (input === 'y' || input === 'yes') { rl.close(); return 'accept'; }
    if (input === 'n' || input === 'no') { rl.close(); return 'abort'; }
    if (input === 'p' || input === 'pick') { rl.close(); return 'pick'; }

    attempts++;
    if (attempts < 2) {
      console.log(chalk.yellow('  Invalid input. Enter Y, n, or p.'));
    }
  }

  rl.close();
  return 'abort'; // Two invalid inputs → abort
}

// ============================================================================
// Full interactive picker
// ============================================================================

export async function pickOrg(
  orgs: Organization[],
  opts: { interactive: boolean; cwd: string },
): Promise<{ chosen: Organization; persistScope: PersistScope }> {
  if (!opts.interactive || !process.stdout.isTTY) {
    throw new Error(
      `CV-Hub requires organization selection. Set CV_HUB_ORG or pass --org. ` +
      `Valid slugs: ${orgs.map(o => o.slug).join(', ')}`
    );
  }

  const readline = await import('node:readline');

  console.log();
  console.log(chalk.bold('  CV-Hub requires organization selection.'));
  console.log(chalk.gray('  Which organization should this executor register under?'));
  console.log();

  orgs.forEach((o, i) => {
    console.log(`    ${chalk.cyan(String(i + 1))}. ${o.name.padEnd(20)} (${chalk.gray(o.slug)})`);
  });
  console.log(`    ${chalk.cyan('c')}. Cancel`);
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = await new Promise<string>((resolve) => {
    rl.question('  Enter number, slug, or \'c\': ', (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (input.toLowerCase() === 'c' || !input) {
    throw new Error('Registration aborted. Set CV_HUB_ORG or use --org to skip this prompt.');
  }

  let chosen: Organization | undefined;
  const num = parseInt(input, 10);
  if (!isNaN(num) && num >= 1 && num <= orgs.length) {
    chosen = orgs[num - 1];
  } else {
    chosen = orgs.find(o => o.slug.toLowerCase() === input.toLowerCase());
  }

  if (!chosen) {
    throw new Error(`"${input}" doesn't match any organization. Valid: ${orgs.map(o => o.slug).join(', ')}`);
  }

  console.log();
  console.log(`  ${chalk.green('✓')} ${chosen.name} (${chosen.slug})`);

  const persistScope = await promptPersistScope();

  return { chosen, persistScope };
}

// ============================================================================
// Error parser
// ============================================================================

export function parseMultiOrgError(status: number, body: string): Organization[] | null {
  if (status !== 400) return null;
  try {
    const data = JSON.parse(body);
    const orgs = data?.error?.organizations;
    if (Array.isArray(orgs) && orgs.length > 0 && orgs[0]?.id && orgs[0]?.slug) {
      return orgs;
    }
  } catch {}
  return null;
}
