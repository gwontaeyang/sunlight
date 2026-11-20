import http from 'node:http';
import net from 'node:net';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { freePort, startTestServer } from '../helpers/server';
import { REPO_ROOT, runProbe, serverEnv, startWithPortRetry, stopProcess } from '../helpers/proc';
import { tempDir } from '../helpers/tmp';

it('restarts only the child that lost the port race; the original listener remains and other errors never retry', async () => {
  const held = net.createServer();
  await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve));
  const busy = (held.address() as net.AddressInfo).port;
  try {
    const env = serverEnv(tempDir(), 'data', busy);
    const next = vi.fn(freePort);
    const proc = await startWithPortRetry(env, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(proc.port).not.toBe(busy);
    expect(proc.output()).toContain('listening on');
    expect(held.listening).toBe(true);
    await stopProcess(proc.child);
    expect(await proc.exit).toBe(0);
    const invalid = await startWithPortRetry({ ...env, SP_NETWORK: 'invalid' }, next);
    expect(await invalid.exit).not.toBe(0);
    expect(invalid.output()).toContain('SP_NETWORK must be on|off');
    expect(next).toHaveBeenCalledTimes(1);
  } finally { await new Promise<void>((resolve) => held.close(() => resolve())); }
});

it('releases the HTTP listener when configuration fails after bind', async () => {
  const close = vi.spyOn(http.Server.prototype, 'close');
  try {
    await expect(startTestServer({ env: 'invalid' as 'test' })).rejects.toThrow(/SP_ENV/);
    expect(close.mock.contexts).toHaveLength(1);
    expect(close.mock.contexts[0]).toHaveProperty('listening', false);
  } finally { close.mockRestore(); }
});

it('a refused restore removes only report directories created by this invocation', async () => {
  const root = tempDir();
  const parent = join(root, 'empty');
  mkdirSync(parent);
  const r = await runProbe(join(REPO_ROOT, 'scripts/data-snapshot.ts'), {}, [
    'restore', '--snapshot', join(root, 'missing'), '--data', join(root, 'target'), '--report', join(parent, 'child', 'leaf'),
  ]);
  expect(r.status).toBe(2);
  expect(JSON.parse(r.stdout)).toMatchObject({ exitCode: 2, ok: false });
  expect(readdirSync(parent)).toEqual([]);
});

it('refuses an existing read-only report file before verify can overwrite it', async () => {
  const root = tempDir();
  const report = join(root, 'rep');
  mkdirSync(report);
  const file = join(report, 'verify.json');
  writeFileSync(file, 'original'); chmodSync(file, 0o444);
  const env: Record<string, string> = {};
  if (process.getuid?.() === 0) {
    // Root bypasses mode 0444. Inject the same EACCES at this one access check.
    const preload = join(root, 'deny.cjs');
    writeFileSync(preload, "const fs=require('node:fs'), check=fs.accessSync; fs.accessSync=function(p,...args){ if(p===process.env.DENIED_REPORT)throw Object.assign(new Error('EACCES'),{code:'EACCES'}); return check(p,...args); }; require('node:module').syncBuiltinESMExports();");
    Object.assign(env, { NODE_OPTIONS: '--require=' + preload, DENIED_REPORT: file });
  }
  const r = await runProbe(join(REPO_ROOT, 'scripts/data-snapshot.ts'), env, [
    'verify', '--snapshot', join(root, 'missing'), '--report', report,
  ]);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/--report .* cannot be written:.*EACCES/);
  expect(readFileSync(file, 'utf8')).toBe('original');
});

// S-a fix round: data:snapshot and rehearsal take their paths from arguments and never read SP_DATA_DIR or
// SP_CONFIG_PATH, so neither is required; a usage error stays exit 2 with the JSON line and no stack trace.
it.each([
  ['data-snapshot', ['verify', '--snapshot', 'missing-dir']],
  ['data-snapshot', []],
  ['rehearsal', []],
] as const)('%s %j without SP_DATA_DIR and SP_CONFIG_PATH keeps the exit-2 JSON contract', async (tool, args) => {
  const root = tempDir();
  const r = await runProbe(join(REPO_ROOT, `scripts/${tool}.ts`), { SP_DATA_DIR: undefined, SP_CONFIG_PATH: undefined }, args.map((a) => (a === 'missing-dir' ? join(root, a) : a)));
  expect(r.status, r.stderr).toBe(2);
  expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toMatchObject({ ok: false, exitCode: 2 });
  expect(r.stderr).not.toMatch(/\n\s+at |startupPaths|SP_DATA_DIR|SP_CONFIG_PATH/);
});
