/**
 * Post-Task Deploy
 *
 * Reads .cva/deploy.json from workspace root and executes:
 * 1. Build steps (cargo build, npm build, etc.)
 * 2. Database migration
 * 3. Service restart (systemd, pm2, manual, docker, or none)
 * 4. Health check + smoke tests
 * 5. Auto-rollback on verification failure
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

interface BuildStep {
  name: string;
  command: string;
  timeout_seconds?: number;
  working_dir?: string;
}

interface SmokeTest {
  name: string;
  url: string;
  expected_status: number[];
  description?: string;
}

interface ServiceConfig {
  type: 'systemd' | 'pm2' | 'manual' | 'docker' | 'none';
  name?: string;
  restart_command?: string;
  status_command?: string;
  startup_wait_seconds?: number;
}

export interface DeployManifest {
  version: number;
  build?: { steps: BuildStep[] };
  migrate?: { check?: string; command: string; env?: Record<string, string> };
  service?: ServiceConfig;
  verify?: { health_url?: string; smoke_tests?: SmokeTest[]; timeout_seconds?: number };
  rollback?: { strategy: 'git_revert' | 'manual'; auto_rollback_on_verify_failure?: boolean };
}

export interface DeployResult {
  deployed: boolean;
  steps: DeployStepResult[];
  error?: string;
  rolledBack?: boolean;
}

interface DeployStepResult {
  step: string;
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  durationMs?: number;
}

type LogFn = (type: string, message: string) => void;

// ============================================================================
// Helpers
// ============================================================================

function exec(cmd: string, cwd: string, timeoutMs = 300_000, env?: Record<string, string>): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err: any) {
    return { ok: false, stdout: err.stdout || '', stderr: err.stderr || err.message || '' };
  }
}

async function httpStatus(url: string, timeoutMs = 10_000): Promise<number> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.status;
  } catch {
    return 0;
  }
}

async function checkHealth(url: string, timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const status = await httpStatus(url);
    if (status >= 200 && status < 500) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

function getHeadCommit(cwd: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Main
// ============================================================================

export function loadDeployManifest(workspaceRoot: string): DeployManifest | null {
  const manifestPath = join(workspaceRoot, '.cva', 'deploy.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as DeployManifest;
    if (!manifest.version || manifest.version < 1) {
      console.log('  [deploy] Invalid manifest version');
      return null;
    }
    return manifest;
  } catch (err: any) {
    console.log(`  [deploy] Failed to read .cva/deploy.json: ${err.message}`);
    return null;
  }
}

export async function postTaskDeploy(
  workspaceRoot: string,
  taskId: string,
  log: LogFn,
): Promise<DeployResult> {
  const manifest = loadDeployManifest(workspaceRoot);
  if (!manifest) {
    return { deployed: false, steps: [{ step: 'manifest', status: 'skipped', message: 'No .cva/deploy.json' }] };
  }

  const steps: DeployStepResult[] = [];
  const preDeployCommit = getHeadCommit(workspaceRoot);

  // ── Build ──────────────────────────────────────────────────────────────
  if (manifest.build?.steps) {
    for (const buildStep of manifest.build.steps) {
      const stepName = `build:${buildStep.name}`;
      console.log(`  [deploy] Building: ${buildStep.name}`);
      log('lifecycle', `Building: ${buildStep.name}`);

      const start = Date.now();
      const cwd = join(workspaceRoot, buildStep.working_dir || '.');
      const timeoutMs = (buildStep.timeout_seconds || 300) * 1000;
      const result = exec(buildStep.command, cwd, timeoutMs);

      if (!result.ok) {
        const msg = `Build failed: ${buildStep.name}\n${result.stderr.slice(-500)}`;
        steps.push({ step: stepName, status: 'failed', message: msg, durationMs: Date.now() - start });
        log('error', msg);
        return { deployed: false, steps, error: msg };
      }

      steps.push({ step: stepName, status: 'ok', durationMs: Date.now() - start });
    }
  }

  // ── Migrate ────────────────────────────────────────────────────────────
  if (manifest.migrate?.command) {
    console.log('  [deploy] Running migration...');
    log('lifecycle', 'Applying database migration');

    const start = Date.now();
    const env = manifest.migrate.env || {};
    const result = exec(manifest.migrate.command, workspaceRoot, 60_000, env);

    if (!result.ok) {
      const msg = `Migration failed:\n${result.stderr.slice(-500)}`;
      steps.push({ step: 'migrate', status: 'failed', message: msg, durationMs: Date.now() - start });
      log('error', msg);
      return { deployed: false, steps, error: msg };
    }

    steps.push({ step: 'migrate', status: 'ok', durationMs: Date.now() - start });
  }

  // ── Restart ────────────────────────────────────────────────────────────
  if (manifest.service && manifest.service.type !== 'none' && manifest.service.restart_command) {
    console.log(`  [deploy] Restarting service: ${manifest.service.name || 'default'}`);
    log('lifecycle', `Restarting service: ${manifest.service.name || 'default'}`);

    const start = Date.now();
    const result = exec(manifest.service.restart_command, workspaceRoot, 30_000);

    if (!result.ok) {
      const msg = `Restart failed:\n${result.stderr.slice(-300)}`;
      steps.push({ step: 'restart', status: 'failed', message: msg, durationMs: Date.now() - start });
      // Don't abort — verification will catch if the service is actually down
    } else {
      steps.push({ step: 'restart', status: 'ok', durationMs: Date.now() - start });
    }

    // Wait for startup
    const waitMs = (manifest.service.startup_wait_seconds || 5) * 1000;
    await new Promise(r => setTimeout(r, waitMs));
  }

  // ── Verify ─────────────────────────────────────────────────────────────
  if (manifest.verify) {
    console.log('  [deploy] Verifying deployment...');
    log('lifecycle', 'Verifying deployment');

    const timeoutSec = manifest.verify.timeout_seconds || 30;

    // Health check
    if (manifest.verify.health_url) {
      const healthy = await checkHealth(manifest.verify.health_url, timeoutSec);
      if (!healthy) {
        const msg = `Health check failed: ${manifest.verify.health_url} did not respond within ${timeoutSec}s`;
        steps.push({ step: 'verify:health', status: 'failed', message: msg });
        log('error', msg);

        if (manifest.rollback?.auto_rollback_on_verify_failure && preDeployCommit) {
          await rollback(workspaceRoot, preDeployCommit, manifest, log);
          return { deployed: false, steps, error: msg, rolledBack: true };
        }
        return { deployed: false, steps, error: msg };
      }
      steps.push({ step: 'verify:health', status: 'ok' });
    }

    // Smoke tests
    for (const test of manifest.verify.smoke_tests || []) {
      const status = await httpStatus(test.url);
      if (!test.expected_status.includes(status)) {
        const msg = `Smoke test "${test.name}" failed: got ${status}, expected ${test.expected_status.join('|')}`;
        steps.push({ step: `verify:${test.name}`, status: 'failed', message: msg });
        log('error', msg);

        if (manifest.rollback?.auto_rollback_on_verify_failure && preDeployCommit) {
          await rollback(workspaceRoot, preDeployCommit, manifest, log);
          return { deployed: false, steps, error: msg, rolledBack: true };
        }
        return { deployed: false, steps, error: msg };
      }
      steps.push({ step: `verify:${test.name}`, status: 'ok' });
    }
  }

  console.log('  [deploy] Deployment verified');
  log('lifecycle', 'Deployment verified successfully');
  return { deployed: true, steps };
}

// ============================================================================
// Rollback
// ============================================================================

async function rollback(
  workspaceRoot: string,
  targetCommit: string,
  manifest: DeployManifest,
  log: LogFn,
): Promise<void> {
  console.log(`  [deploy] Rolling back to ${targetCommit.substring(0, 8)}`);
  log('lifecycle', `Rolling back to ${targetCommit.substring(0, 8)}`);

  try {
    exec(`git checkout ${targetCommit}`, workspaceRoot, 10_000);
  } catch {
    log('error', 'Rollback: git checkout failed');
    return;
  }

  // Rebuild
  if (manifest.build?.steps) {
    for (const step of manifest.build.steps) {
      exec(step.command, join(workspaceRoot, step.working_dir || '.'), (step.timeout_seconds || 300) * 1000);
    }
  }

  // Restart
  if (manifest.service?.restart_command) {
    exec(manifest.service.restart_command, workspaceRoot, 30_000);
  }

  log('lifecycle', 'Rollback complete');
}
