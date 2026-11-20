// Real server processes for integration tests (node --import tsx apps/server/src/index.ts). Owner: supervisor.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export const SERVER_ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((c) => stopProcess(c, 'SIGKILL')));
});

export interface StartedProcess {
  child: ChildProcess;
  output: () => string;
  exit: Promise<number | null>;
}

export function startServerProcess(env: Record<string, string>, entry: string = SERVER_ENTRY): StartedProcess {
  let out = '';
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: REPO_ROOT, env: { ...process.env, SP_LLM: 'mock', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (c) => (out += c));
  child.stderr!.on('data', (c) => (out += c));
  children.push(child);
  return { child, output: () => out, exit: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
}

/**
 * A child that lost the free-port race may retry after closing. Other exits (including a
 * data-dir lock refusal) are returned to the caller with their original status and output.
 */
export async function startWithPortRetry(env: Record<string, string>, nextPort: () => Promise<number>): Promise<StartedProcess & { port: number }> {
  let port = Number(env.SP_PORT);
  for (let attempt = 1; ; attempt++) {
    const proc = startServerProcess({ ...env, SP_PORT: String(port) });
    let closed = false;
    const onClose = () => { closed = true; };
    proc.child.once('close', onClose);
    try {
      await waitFor(() => closed || proc.output().includes('listening on'), 'child to listen or exit');
    } finally {
      proc.child.off('close', onClose);
    }
    if (!closed || attempt === 5 || !/server error:.*\bEADDRINUSE\b/.test(proc.output())) return { ...proc, port };
    port = await nextPort();
  }
}

export function stopProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill(signal);
  });
}

export async function waitFor(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Environment of an isolated server: own data dir, own runtime dir, no user config. */
export function serverEnv(root: string, dataName: string, port: number, spEnv: 'dev' | 'prod' = 'prod'): Record<string, string> {
  mkdirSync(join(root, 'run'), { recursive: true });
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>app</body></html>');
  return { SP_ENV: spEnv, SP_PORT: String(port), SP_DATA_DIR: join(root, dataName), SP_CONFIG_PATH: join(root, 'config','none.json'), SP_SECRETS_DIR: join(root, dataName + '-secrets'), XDG_RUNTIME_DIR: join(root, 'run'), SP_WEB_DIST: dist, SP_NETWORK: 'off' };
}

export interface ProbeResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function probeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const full: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('VITEST') && k !== 'TEST' && k !== 'NODE_ENV') full[k] = v;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete full[k];
    else full[k] = v;
  }
  return full;
}

function spawnProbe(command: string, argv: string[], env: Record<string, string>, timeoutMs: number, cwd: string = REPO_ROOT): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); // stopped by its own handle (PID) in afterEach
    child.stdout!.on('data', (c) => (stdout += c));
    child.stderr!.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

/**
 * Runs a small TypeScript probe script in its own node process (`--import tsx`, no VITEST in its env), e.g. to test
 * env-dependent guards. `env` replaces the inherited values of the listed keys; keys set to undefined are removed.
 */
export function runProbe(script: string, env: Record<string, string | undefined>, args: string[] = [], timeoutMs = 60_000): Promise<ProbeResult> {
  return spawnProbe(process.execPath, ['--import', 'tsx', script, ...args], probeEnv(env), timeoutMs);
}

/**
 * Runs a system command (an absolute path, no shell) in `cwd` with the probe environment, e.g. `sha256sum -c` on a
 * snapshot directory. Same cleanup as runProbe (own handle, SIGKILL after timeoutMs).
 */
export function runCommand(command: string, argv: string[], opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number }): Promise<ProbeResult> {
  return spawnProbe(command, argv, probeEnv(opts.env ?? {}), opts.timeoutMs ?? 60_000, opts.cwd);
}

/** bash is needed for runProbeWithFileSizeLimit (`ulimit -f` counts 1024-byte blocks in bash). Linux only. */
export const FILE_SIZE_LIMIT_PROBE_SUPPORTED = process.platform === 'linux' && existsSync('/bin/bash');

/**
 * runProbe under a file size limit (RLIMIT_FSIZE) that applies to that child only: `/bin/bash -c 'ulimit -f <kib>'`
 * then exec node (same PID, so the afterEach cleanup stops it). Node ignores SIGXFSZ, so a write past the limit is a
 * short write and then EFBIG instead of a kill. tsx's disk cache is off (TSX_DISABLE_CACHE) so the loader writes no file.
 */
export function runProbeWithFileSizeLimit(script: string, fileSizeKiB: number, env: Record<string, string | undefined>, args: string[] = [], timeoutMs = 60_000): Promise<ProbeResult> {
  if (!FILE_SIZE_LIMIT_PROBE_SUPPORTED) throw new Error('runProbeWithFileSizeLimit needs Linux and /bin/bash');
  if (!Number.isInteger(fileSizeKiB) || fileSizeKiB < 1) throw new Error(`bad file size limit ${fileSizeKiB}`);
  const argv = ['-c', 'ulimit -f "$1" || exit 97; shift; exec "$@"', 'bash', String(fileSizeKiB), process.execPath, '--import', 'tsx', script, ...args];
  return spawnProbe('/bin/bash', argv, probeEnv({ TSX_DISABLE_CACHE: '1', ...env }), timeoutMs);
}

/** Seeds the synthetic fixture paper into the data dir of `env` (scripts/seed-fixture.ts). */
export function seedDataDir(env: Record<string, string>): void {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'seed-fixture.ts')], { cwd: REPO_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`seed-fixture failed: ${r.stderr || r.stdout}`);
}
