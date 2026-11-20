// Data-directory lock (instanceLock.ts) — unit tests and real-process startup races. Owner: supervisor.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireInstanceLock, InstanceLockError, isHolderAlive, processStartTime, type LockInfo } from '../../src/instanceLock';
import { serverEnv as envFor, startServerProcess as start, startWithPortRetry, stopProcess as stop, waitFor } from '../helpers/proc';
import { freePort } from '../helpers/server';
import { tempDir } from '../helpers/tmp';

const lockIn = (dir: string) => join(dir, 'instance.lock');
const dead = () => false;
const alive = () => true;

describe('instance lock (unit)', () => {
  it('acquires a free lock, records pid/role, and releases only its own lock', () => {
    const file = lockIn(tempDir('sp-lock-'));
    const a = acquireInstanceLock(file, 'server');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid, role: 'server' });
    expect(() => acquireInstanceLock(file, 'restore')).toThrow(InstanceLockError); // held by a live process (us)
    a.release();
    expect(existsSync(file)).toBe(false);
    const b = acquireInstanceLock(file, 'restore');
    a.release(); // stale handle: must not remove b's lock
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ role: 'restore' });
    b.release();
    expect(readdirSync(join(file, '..'))).toEqual([]); // no temp or stale files left behind
  });

  it('takes over a stale lock (holder gone) and garbage content, but never a live one', () => {
    const file = lockIn(tempDir('sp-lock-'));
    const stale: LockInfo = { pid: 1111, startTime: '1', role: 'server', acquiredAt: 1 };
    writeFileSync(file, JSON.stringify(stale));
    expect(() => acquireInstanceLock(file, 'server', { isAlive: alive })).toThrow(/pid 1111/);
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(1111); // untouched
    const got = acquireInstanceLock(file, 'server', { isAlive: dead });
    expect(got.info.pid).toBe(process.pid);
    got.release();
    writeFileSync(file, 'not json');
    acquireInstanceLock(file, 'server', { isAlive: alive }).release();
    expect(existsSync(file)).toBe(false);
  });

  it('liveness: a dead pid and a recycled pid (other start time) are not alive', () => {
    const me: LockInfo = { pid: process.pid, startTime: processStartTime(process.pid), role: 'server', acquiredAt: 0 };
    expect(isHolderAlive(me)).toBe(true);
    expect(isHolderAlive({ ...me, pid: 2 ** 30 })).toBe(false);
    if (me.startTime !== null) expect(isHolderAlive({ ...me, startTime: String(Number(me.startTime) + 1) })).toBe(false);
  });
});

describe('instance lock (real processes)', () => {
  it('two servers started at the same time on one data dir: exactly one runs, the other exits 1 and changes nothing', async () => {
    const root = tempDir('sp-race-');
    const [p1, p2] = [await freePort(), await freePort()];
    const [a, b] = await Promise.all([p1, p2].map((port) => startWithPortRetry(envFor(root, 'data', port), freePort)));
    await waitFor(() => [a, b].filter((s) => s.output().includes('listening on')).length + [a, b].filter((s) => s.child.exitCode !== null).length === 2, 'one winner and one loser');
    const winner = a.output().includes('listening on') ? a : b;
    const loser = winner === a ? b : a;
    expect(loser.output()).not.toContain('listening on');
    expect(await loser.exit).toBe(1);
    expect(loser.output()).toMatch(/data directory is in use by a study_paper server|could not take the data directory lock/);
    expect(loser.output()).not.toContain('startup recovery');
    const lock = JSON.parse(readFileSync(join(root, 'data', 'run', 'instance.lock'), 'utf8')) as LockInfo;
    expect(lock.pid).toBe(winner.child.pid);
    expect(readFileSync(join(root, 'data', 'run', 'server.pid'), 'utf8')).toBe(String(winner.child.pid));
    await stop(winner.child);
    expect(existsSync(join(root, 'data', 'run', 'instance.lock'))).toBe(false);
    expect(existsSync(join(root, 'data', 'run', 'server.pid'))).toBe(false);
  }, 40_000);

  it('a start that cannot bind the port leaves the running server\'s token file alone; a killed server\'s lock is taken over', async () => {
    const root = tempDir('sp-race-');
    const a = await startWithPortRetry(envFor(root, 'a', await freePort(), 'dev'), freePort);
    const { port } = a;
    const tokenFile = join(root, 'run', 'study_paper', `token.${port}`);
    await waitFor(() => existsSync(tokenFile), 'token file of the first server');
    const token = readFileSync(tokenFile, 'utf8');
    const b = start(envFor(root, 'b', port, 'dev')); // other data dir, same port → EADDRINUSE
    expect(await b.exit).toBe(1);
    expect(b.output()).toContain('EADDRINUSE');
    expect(readFileSync(tokenFile, 'utf8')).toBe(token);
    expect(existsSync(join(root, 'b', 'run', 'instance.lock'))).toBe(false); // the loser released its own lock

    await stop(a.child, 'SIGKILL'); // crash: lock, pid and token files stay behind
    expect(existsSync(join(root, 'a', 'run', 'instance.lock'))).toBe(true);
    const c = start(envFor(root, 'a', port, 'dev'));
    await waitFor(() => c.output().includes('listening on'), 'restart after a crash');
    expect(readFileSync(tokenFile, 'utf8')).not.toBe(token); // rotated by the new server
    await stop(c.child);
    expect(existsSync(tokenFile)).toBe(false);
  }, 40_000);
});
