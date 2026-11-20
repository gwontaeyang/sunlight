// S-a fix round 3 (결정 64 ①): the other direction — a user data directory whose own managed entry is a link into the
// scratch tree (or around it) — is refused before start-up recovery; the user data side is read as metadata only.
// Owner: supervisor.
import { mkdirSync, readdirSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertStartupPaths } from '../../src/security/startupPaths';
import { SERVER_ENTRY, serverEnv, startServerProcess, waitFor } from '../helpers/proc';
import { freePort } from '../helpers/server';
import { tempDir } from '../helpers/tmp';
import { chmodSync } from 'node:fs';

const MANAGED = ['db', 'papers', 'backups', 'tmp', 'claude-cwd', 'run', 'fixtures'] as const;

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
function rmIfPresent(p: string): void {
  try {
    rmdirSync(p);
  } catch {
    /* absent */
  }
}

describe('S-a fix round 3: overlap with the user data directory', () => {
  it('a user-data tmp/ linked to the scratch tmp/ stops the server before start-up recovery empties it', async () => {
    const { root, real, data, env } = layout();
    mkdirSync(join(data, 'tmp'), { recursive: true });
    writeFileSync(join(data, 'tmp', 'kept.bin'), 'reachable as the user data tmp/');
    symlinkSync(join(data, 'tmp'), join(real, 'tmp'));
    expect(() => assertStartupPaths(env)).toThrow(/SP_DATA_DIR tmp overlaps tmp of the user data directory/);
    const port = await freePort();
    const p = startServerProcess({ ...serverEnv(join(root, 'srv'), 'unused', port), SP_DATA_DIR: data, HOME: root }, SERVER_ENTRY);
    await waitFor(() => p.output().includes('listening on') || p.child.exitCode !== null, 'a refusal or a start');
    expect(p.output()).toMatch(/SP_DATA_DIR tmp overlaps tmp of the user data directory/);
    expect(await p.exit).not.toBe(0);
    expect(readdirSync(join(data, 'tmp'))).toEqual(['kept.bin']);
  }, 60_000);

  it('every managed entry, in both directions (user data under scratch, scratch under user data), is refused', () => {
    for (const name of MANAGED) {
      const into = layout();
      mkdirSync(join(into.data, name), { recursive: true });
      mkdirSync(join(into.data, name, 'inner'));
      rmIfPresent(join(into.real, name));
      symlinkSync(join(into.data, name, 'inner'), join(into.real, name)); // the user data entry lies inside the scratch one
      expect(() => assertStartupPaths(into.env), name).toThrow(new RegExp(`SP_DATA_DIR ${name} overlaps ${name} of the user data directory`));
      const around = layout();
      rmIfPresent(join(around.real, name));
      symlinkSync(around.data, join(around.real, name)); // the scratch tree lies inside the user data entry
      expect(() => assertStartupPaths(around.env), name).toThrow(/overlaps .* of the user data directory/);
    }
  });

  it('a missing user data directory or entry is fine; the approved user launcher is not compared with itself', () => {
    const { root, real, env } = layout();
    expect(() => assertStartupPaths({ ...env, HOME: join(root, 'no-such-home') })).not.toThrow();
    expect(() => assertStartupPaths(env)).not.toThrow();
    expect(() => assertStartupPaths({ ...env, SP_DATA_DIR: real }, true)).not.toThrow();
  });

});

describe('S-a last fix: the overlap is judged before any directory is listed', () => {
  it.each(MANAGED)('an overlapped %s is refused without being listed (its listing would fail)', (name) => {
    const { real, data, env } = layout();
    const shared = join(data, name);
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'user-file'), 'the user data, reachable as the scratch entry');
    rmIfPresent(join(real, name));
    symlinkSync(shared, join(real, name)); // the user data entry and the scratch entry are one directory
    chmodSync(shared, 0o300); // write + search only: realpath / lstat work, readdir fails with EACCES
    try {
      expect(() => readdirSync(shared)).toThrow(/EACCES/);
      expect(() => assertStartupPaths(env)).toThrow(new RegExp(`SP_DATA_DIR ${name} overlaps ${name} of the user data directory`));
    } finally {
      chmodSync(shared, 0o700);
    }
  });

  it('a scratch entry that is itself a link into the user data directory keeps its tree-link message', () => {
    const { real, data, env } = layout();
    symlinkSync(join(real, 'db'), join(data, 'db'));
    expect(() => assertStartupPaths(env)).toThrow(/SP_DATA_DIR entry db resolves into the user data directory; the data tree must not contain links/);
  });
});
