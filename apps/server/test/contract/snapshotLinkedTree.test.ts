// S-a fix round 2 (결정 62): data:snapshot (snapshot · verify · restore · compare) and rehearsal refuse a --data or
// --snapshot tree that holds a symbolic link or shares a file's inode with a place outside it — exit 2 with the JSON
// line and no stack, before any DB is opened or any mode changed. Owner: supervisor.
import { existsSync, linkSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, runProbe, seedDataDir, type ProbeResult } from '../helpers/proc';
import { fileTempDir } from '../helpers/tmp';

const SNAP = join(REPO_ROOT, 'scripts/data-snapshot.ts');
const REHEARSAL = join(REPO_ROOT, 'scripts/rehearsal.ts');
const DB = join('db', 'study_paper.sqlite');

let root: string;
let env: Record<string, string | undefined>;
let other: string;
let good: string;

function refused(r: ProbeResult, pattern: RegExp): void {
  expect(r.status, r.stderr).toBe(2);
  const line = JSON.parse(r.stdout.trim().split('\n').pop()!) as { ok: boolean; exitCode: number; error: string };
  expect(line).toMatchObject({ ok: false, exitCode: 2 });
  expect(line.error).toMatch(pattern);
  expect(r.stderr).not.toMatch(/\n\s+at /);
}

beforeAll(async () => {
  root = fileTempDir();
  env = { HOME: join(root, 'home'), XDG_DATA_HOME: undefined, SP_SNAPSHOT_ALLOW_REAL: undefined };
  other = join(root, 'other');
  seedDataDir({ SP_DATA_DIR: other, SP_CONFIG_PATH: join(root, 'other.json') });
  good = join(root, 'good-snap');
  const r = await runProbe(SNAP, env, ['snapshot', '--data', other, '--out', good]);
  expect(r.status, r.stderr).toBe(0);
}, 60_000);

/** A scratch data directory whose db/ is a link to another data directory's db/. */
function linkedData(name: string): string {
  const data = join(root, name);
  mkdirSync(join(data, 'papers'), { recursive: true });
  symlinkSync(join(other, 'db'), join(data, 'db'));
  return data;
}

describe('data:snapshot and rehearsal: the link-free tree rule', () => {
  it('snapshot of a scratch whose db/ links to another data directory: exit 2, nothing read into a snapshot', async () => {
    const data = linkedData('linked-for-snapshot');
    const out = join(root, 'snap-from-linked');
    refused(await runProbe(SNAP, env, ['snapshot', '--data', data, '--out', out]), /--data .*: db is a symbolic link/);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(root).filter((n) => n.startsWith('snap-from-linked'))).toEqual([]);
  }, 60_000);

  it('verify --seal on a snapshot that shares an inode with an outside file: exit 2 before any chmod', async () => {
    const snap = join(root, 'shared-snap');
    expect((await runProbe(SNAP, env, ['snapshot', '--data', other, '--out', snap])).status).toBe(0);
    const outside = join(root, 'outside-copy.sqlite');
    linkSync(join(snap, DB), outside);
    const mode = statSync(outside).mode & 0o777;
    refused(await runProbe(SNAP, env, ['verify', '--snapshot', snap, '--seal']), /--snapshot .*: db\/study_paper\.sqlite has 2 hard links \(1 outside the tree\)/);
    expect(statSync(outside).mode & 0o777).toBe(mode);
    expect(statSync(snap).mode & 0o777).not.toBe(0o555);
  }, 60_000);

  it('restore and compare refuse a linked --data and a linked --snapshot; the data directory is left as it was', async () => {
    const data = linkedData('linked-for-restore');
    refused(await runProbe(SNAP, env, ['compare', '--snapshot', good, '--data', data, '--out', join(root, 'cmp-linked')]), /--data .*: db is a symbolic link/);
    // restore's own shape check already stops a linked db/ (not a directory); a link deeper in papers/ reaches the rule
    const deeper = join(root, 'linked-deeper');
    mkdirSync(join(deeper, 'db'), { recursive: true });
    mkdirSync(join(deeper, 'papers'));
    symlinkSync(join(other, 'papers'), join(deeper, 'papers', 'p'));
    refused(await runProbe(SNAP, env, ['restore', '--snapshot', good, '--data', deeper]), /--data .*: papers\/p is a symbolic link/);
    expect(readdirSync(deeper).sort()).toEqual(['db', 'papers']);
    expect(readdirSync(data).sort()).toEqual(['db', 'papers']);
    const snapWithLink = join(root, 'snap-with-link');
    expect((await runProbe(SNAP, env, ['snapshot', '--data', other, '--out', snapWithLink])).status).toBe(0);
    symlinkSync(join(root, 'home'), join(snapWithLink, 'papers', 'elsewhere'));
    const plain = join(root, 'plain-data');
    mkdirSync(join(plain, 'db'), { recursive: true });
    mkdirSync(join(plain, 'papers'));
    refused(await runProbe(SNAP, env, ['restore', '--snapshot', snapWithLink, '--data', plain]), /--snapshot .*: papers\/elsewhere is a symbolic link/);
    refused(await runProbe(SNAP, env, ['compare', '--snapshot', snapWithLink, '--data', other, '--out', join(root, 'cmp-snap-link')]), /--snapshot .*: papers\/elsewhere is a symbolic link/);
    expect(readdirSync(root).filter((n) => n.includes('-m2-aside-') || n.includes('.restore-'))).toEqual([]);
  }, 60_000);

  it('rehearsal refuses a linked --snapshot or --data with its exit-2 JSON line', async () => {
    const snap = join(root, 'rehearsal-snap');
    expect((await runProbe(SNAP, env, ['snapshot', '--data', other, '--out', snap])).status).toBe(0);
    symlinkSync(join(root, 'home'), join(snap, 'papers', 'elsewhere'));
    refused(await runProbe(REHEARSAL, env, ['precheck', '--snapshot', snap, '--out', join(root, 'pre-out')]), /--snapshot .*: papers\/elsewhere is a symbolic link/);
    const data = linkedData('linked-for-rehearsal');
    const log = join(root, 'server.log');
    writeFileSync(log, ''); // the files a command reads exist, so the refusal is the link rule's
    refused(await runProbe(REHEARSAL, env, ['mutate', '--base-url', 'http://127.0.0.1:9', '--data', data, '--server-log', log, '--out', join(root, 'mut-out')]), /--data .*: db is a symbolic link/);
    expect(existsSync(join(root, 'pre-out'))).toBe(false);
  }, 60_000);
});
