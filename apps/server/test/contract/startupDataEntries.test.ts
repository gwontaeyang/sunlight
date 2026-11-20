// S-a fix round (MAJOR 1): a scratch SP_DATA_DIR whose sub-directory, DB file or DB side file reaches the user data
// directory through a symbolic link, or whose DB file has a second hard link (a `cp -al` copy), is refused before the
// server, the seed or a DB tool makes a directory or opens the DB. Owner: supervisor.
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertStartupPaths } from '../../src/security/startupPaths';
import { REPO_ROOT, SERVER_ENTRY, runProbe } from '../helpers/proc';
import { freePort } from '../helpers/server';
import { tempDir } from '../helpers/tmp';
import { serverEnv, startServerProcess, waitFor } from '../helpers/proc';

const ENTRY_POINTS = [[SERVER_ENTRY, []], ['scripts/seed-fixture.ts', []], ['scripts/db-restore.ts', ['absent.sqlite']], ['scripts/check-startup-paths.ts', []]] as const;
const SUB_DIRS = ['db', 'papers', 'backups', 'run', 'tmp', 'claude-cwd'] as const;
const DB = join('db', 'study_paper.sqlite');

/** A fake HOME: its ~/.local/share/study_paper is the user data directory of the rule; the data dir is a scratch dir. */
function layout() {
  const root = tempDir();
  const real = join(root, '.local', 'share', 'study_paper');
  mkdirSync(join(real, 'db'), { recursive: true });
  const data = join(root, 'scratch', 'data');
  mkdirSync(data, { recursive: true });
  const env: Record<string, string | undefined> = {
    HOME: root, XDG_DATA_HOME: undefined, XDG_RUNTIME_DIR: join(root, 'xdg-run'), SP_ENV: 'prod', SP_LLM: 'mock', SP_NETWORK: 'off',
    SP_DATA_DIR: data, SP_CONFIG_PATH: join(root, 'scratch', 'config.json'),
  };
  return { root, real, data, env };
}
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function refusedAtEveryEntryPoint(env: Record<string, string | undefined>, pattern: RegExp): Promise<void> {
  const port = String(await freePort());
  for (const [file, args] of ENTRY_POINTS) {
    const r = await runProbe(file.startsWith('/') ? file : join(REPO_ROOT, file), { ...env, SP_PORT: port }, [...args], 30_000);
    expect(r.status, `${file}: ${r.stderr}`).not.toBe(0);
    expect(r.stderr, file).toMatch(pattern);
  }
}

describe('S-a fix round: entries of the data directory', () => {
  it('a sub-directory linked into the user data directory is refused; the server, seed and DB tools create and open nothing', async () => {
    for (const sub of SUB_DIRS) {
      const { real, data, env } = layout();
      mkdirSync(join(real, sub), { recursive: true });
      symlinkSync(join(real, sub), join(data, sub));
      expect(() => assertStartupPaths(env), sub).toThrow(new RegExp(`SP_DATA_DIR entry ${sub} resolves into the user data directory`));
    }
    const { real, data, env } = layout();
    symlinkSync(join(real, 'db'), join(data, 'db'));
    await refusedAtEveryEntryPoint(env, /SP_DATA_DIR entry db resolves into the user data directory/);
    expect(readdirSync(join(real, 'db'))).toEqual([]);
    expect(readdirSync(data)).toEqual(['db']);
  }, 180_000);

  it('a DB file with a second hard link is refused and left byte for byte as it was, wherever the other link is', async () => {
    const { real, data, env } = layout();
    writeFileSync(join(real, DB), 'the user database');
    mkdirSync(join(data, 'db'));
    linkSync(join(real, DB), join(data, DB));
    const before = sha(join(real, DB));
    await refusedAtEveryEntryPoint(env, /SP_DATA_DIR database file study_paper\.sqlite has 2 hard links/);
    expect(sha(join(real, DB))).toBe(before);
    expect(readdirSync(data)).toEqual(['db']);
    expect(readdirSync(join(data, 'db'))).toEqual(['study_paper.sqlite']);

    const scratchOnly = layout();
    mkdirSync(join(scratchOnly.data, 'db'));
    writeFileSync(join(scratchOnly.data, DB), 'scratch copy');
    linkSync(join(scratchOnly.data, DB), join(scratchOnly.root, 'scratch', 'another-copy.sqlite'));
    expect(() => assertStartupPaths(scratchOnly.env)).toThrow(/database file study_paper\.sqlite has 2 hard links/);
  }, 180_000);

  it('a DB file, WAL or SHM file linked into the user data directory is refused', () => {
    for (const name of ['study_paper.sqlite', 'study_paper.sqlite-wal', 'study_paper.sqlite-shm']) {
      const { real, data, env } = layout();
      writeFileSync(join(real, 'db', name), 'x');
      mkdirSync(join(data, 'db'));
      symlinkSync(join(real, 'db', name), join(data, 'db', name));
      expect(() => assertStartupPaths(env), name).toThrow(/resolves into the user data directory/);
    }
  });

  it('an ordinary scratch data directory still seeds and creates its DB; the user launcher skips the entry check', async () => {
    const { real, data, env } = layout();
    const r = await runProbe(join(REPO_ROOT, 'scripts/seed-fixture.ts'), env);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(data, DB))).toBe(true);
    expect(() => assertStartupPaths(env)).not.toThrow();
    expect(() => assertStartupPaths({ ...env, SP_DATA_DIR: real }, true)).not.toThrow();
  }, 60_000);
});

// Fix round 2 (결정 62): one link-free rule over the whole data tree instead of a list of sub-paths.
describe('S-a fix round 2: the data tree holds no link', () => {
  it('a captures/ link under a paper directory stops the server before start-up recovery; the linked files stay', async () => {
    const { root, data, env } = layout();
    const elsewhere = join(root, 'elsewhere', 'captures');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'keep.png'), 'not the app’s file');
    mkdirSync(join(data, 'papers', 'p1'), { recursive: true });
    symlinkSync(elsewhere, join(data, 'papers', 'p1', 'captures'));
    const port = await freePort();
    const p = startServerProcess({ ...serverEnv(join(root, 'srv'), 'unused', port), SP_DATA_DIR: data, HOME: root }, SERVER_ENTRY);
    await waitFor(() => p.output().includes('listening on') || p.child.exitCode !== null, 'a refusal or a start');
    expect(p.output()).toMatch(/SP_DATA_DIR entry papers\/p1\/captures is a symbolic link/);
    expect(await p.exit).not.toBe(0);
    expect(readdirSync(elsewhere)).toEqual(['keep.png']);
    expect(existsSync(join(data, 'db'))).toBe(false);
  }, 60_000);

  it('a link deep in papers/ or backups/ is refused by the server, the seed and the DB tools, whatever it points at', async () => {
    const { root, data, env } = layout();
    mkdirSync(join(data, 'backups', 'old'), { recursive: true });
    mkdirSync(join(root, 'other'), { recursive: true });
    symlinkSync(join(root, 'other'), join(data, 'backups', 'old', 'linked'));
    expect(() => assertStartupPaths(env)).toThrow(/SP_DATA_DIR entry backups\/old\/linked is a symbolic link/);
    await refusedAtEveryEntryPoint(env, /SP_DATA_DIR entry backups\/old\/linked is a symbolic link/);
    const second = layout();
    mkdirSync(join(second.data, 'papers', 'p2'), { recursive: true });
    writeFileSync(join(root, 'outside.pdf'), 'pdf');
    linkSync(join(root, 'outside.pdf'), join(second.data, 'papers', 'p2', 'paper.pdf'));
    expect(() => assertStartupPaths(second.env)).toThrow(/SP_DATA_DIR file papers\/p2\/paper\.pdf has 2 hard links \(1 outside the data directory\)/);
  }, 180_000);

  it('links the app itself leaves inside the tree after a crash (a published file and its .part) are not a copy', () => {
    const { data, env } = layout();
    mkdirSync(join(data, 'papers', 'p3'), { recursive: true });
    mkdirSync(join(data, 'tmp'));
    writeFileSync(join(data, 'tmp', 'x.part'), 'bytes');
    linkSync(join(data, 'tmp', 'x.part'), join(data, 'papers', 'p3', 'paper.pdf'));
    expect(() => assertStartupPaths(env)).not.toThrow();
  });

  it('the approved user launcher applies the same rule to the user data directory', () => {
    const { real, env } = layout();
    mkdirSync(join(real, 'papers'));
    symlinkSync(join(real, 'db'), join(real, 'papers', 'alias'));
    expect(() => assertStartupPaths({ ...env, SP_DATA_DIR: real }, true)).toThrow(/SP_DATA_DIR entry papers\/alias is a symbolic link/);
  });
});

// Fix round 3 (결정 64 ②): fixtures/ is part of the managed tree, and links are counted over all of it.
describe('S-a fix round 3: fixtures/ in the managed tree', () => {
  it('fixtures/ is scanned: a linked fixtures/ or a fixture sharing its inode with an outside file is refused', async () => {
    const { root, data, env } = layout();
    mkdirSync(join(root, 'shared-fixtures'));
    symlinkSync(join(root, 'shared-fixtures'), join(data, 'fixtures'));
    expect(() => assertStartupPaths(env)).toThrow(/SP_DATA_DIR entry fixtures is a symbolic link/);
    await refusedAtEveryEntryPoint(env, /SP_DATA_DIR entry fixtures is a symbolic link/);
    const second = layout();
    mkdirSync(join(second.data, 'fixtures'));
    writeFileSync(join(second.root, 'paper.pdf'), 'pdf');
    linkSync(join(second.root, 'paper.pdf'), join(second.data, 'fixtures', 'paper.pdf'));
    expect(() => assertStartupPaths(second.env)).toThrow(/SP_DATA_DIR file fixtures\/paper\.pdf has 2 hard links \(1 outside the data directory\)/);
  }, 180_000);

  it('a papers/ ↔ fixtures/ hard link pair inside the managed tree is internal, not an outside copy', () => {
    const { data, env } = layout();
    mkdirSync(join(data, 'papers', 'p4'), { recursive: true });
    mkdirSync(join(data, 'fixtures'));
    writeFileSync(join(data, 'fixtures', '2209.15397v2.pdf'), 'fixture bytes');
    linkSync(join(data, 'fixtures', '2209.15397v2.pdf'), join(data, 'papers', 'p4', 'paper.pdf'));
    expect(() => assertStartupPaths(env)).not.toThrow();
  });
});
