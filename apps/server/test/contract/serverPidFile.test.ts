// S-a fix round 2: files the server writes under run/ are new files renamed into place — never written into an existing
// file, which could be a link to another place (결정 62). Owner: supervisor.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { serverEnv, startServerProcess, stopProcess, waitFor } from '../helpers/proc';
import { freePort } from '../helpers/server';
import { tempDir } from '../helpers/tmp';

it('server.pid replaces a stale file by rename (a new inode, no temp file left) and is removed at the stop', async () => {
  const root = tempDir();
  const env = serverEnv(root, 'data', await freePort());
  const run = join(env.SP_DATA_DIR!, 'run');
  mkdirSync(run, { recursive: true });
  const pidFile = join(run, 'server.pid');
  writeFileSync(pidFile, 'stale pid of a crashed server');
  const staleInode = statSync(pidFile).ino;
  const p = startServerProcess(env);
  await waitFor(() => p.output().includes('listening on') || p.child.exitCode !== null, 'listening or an exit');
  expect(p.output()).toContain('listening on');
  expect(readFileSync(pidFile, 'utf8')).toBe(String(p.child.pid));
  expect(statSync(pidFile).ino).not.toBe(staleInode);
  expect(readdirSync(run).filter((n) => n.startsWith('server.pid.'))).toEqual([]);
  await stopProcess(p.child);
  expect(await p.exit).toBe(0);
  expect(existsSync(pidFile)).toBe(false);
}, 40_000);
