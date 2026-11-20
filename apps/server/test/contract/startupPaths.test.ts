import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { assertStartupPaths } from '../../src/security/startupPaths';
import { REPO_ROOT, SERVER_ENTRY, runCommand, runProbe } from '../helpers/proc';
import { tempDir } from '../helpers/tmp';
import { serverEnv, startServerProcess, stopProcess, waitFor } from '../helpers/proc';
import { freePort } from '../helpers/server';

describe('S-a startup boundary', () => {
  it('accepts the M2 helper layouts and defaults automatic work to off', () => {
    const root = tempDir();
    for (const [data, config] of [['prod', 'no-config.json'], ['dev', 'no-config.json'], ['data', 'none.json'], ['DATA', 'DATA.no-config.json']]) {
      const env = { SP_DATA_DIR: join(root, data), SP_CONFIG_PATH: join(root, config) };
      expect(loadConfig(env).autoEnabled).toBe(false);
      expect(loadConfig({ ...env, SP_AUTO: 'off' }).autoEnabled).toBe(false);
      expect(loadConfig({ ...env, SP_AUTO: 'on' }).autoEnabled).toBe(true);
      expect(() => loadConfig({ ...env, SP_AUTO: 'yes' })).toThrow(/SP_AUTO/);
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects a direct prefix, a symlinked parent and the target of a user-data alias, even before a child exists', () => {
    const root = tempDir();
    const share = join(root, '.local/share');
    mkdirSync(share, { recursive: true });
    symlinkSync(share, join(root, 'alias'));
    symlinkSync(join(root, 'external'), join(share, 'study_paper-prev'));
    const env = { HOME: root, SP_DATA_DIR: join(root, 'scratch'), SP_CONFIG_PATH: join(root, 'scratch.json') };
    for (const path of [join(share, 'study_paper-test'), join(root, 'alias/study_paper/nested'), join(root, 'external/missing')]) {
      for (const key of ['SP_DATA_DIR','SP_CONFIG_PATH']) {
        expect(() => assertStartupPaths({ ...env, [key]: path })).toThrow(key);
      }
    }
    expect(() => assertStartupPaths({ ...env, SP_DATA_DIR: ' ' }, true)).toThrow('SP_DATA_DIR');
  });

  it('npm run dev checks paths before copying assets even when npm install scripts are disabled', async () => {
    const root = tempDir();
    const stamp = join(root, 'copied');
    const npm = join(dirname(process.execPath), 'npm');
    // The inner npm command is a witness: stop at copy:pdfjs, before any server can start.
    const inner = join(root, 'npm');
    writeFileSync(inner, '#!/bin/sh\nprintf "%s" "$*" > "$SP_TEST_STAMP"\nexit 72\n'); chmodSync(inner, 0o700);
    const env = { npm_config_ignore_scripts: 'true', SP_TEST_STAMP: stamp, PATH: root + ':' + process.env.PATH, SP_DATA_DIR: join(root, 'data'), SP_CONFIG_PATH: undefined };
    const missing = await runCommand(npm, ['run', 'dev'], { cwd: REPO_ROOT, env });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('SP_CONFIG_PATH is required');
    expect(existsSync(stamp)).toBe(false);
    const safe = await runCommand(npm, ['run','dev'], { cwd: REPO_ROOT, env: { ...env, SP_CONFIG_PATH: join(root,'config','config.json'), SP_SECRETS_DIR: join(root,'secrets') } });
    expect(safe.status).toBe(72);
    expect(existsSync(stamp)).toBe(true);
  });

  it('refuses before opening even a malformed config; real entry points cannot enable user data by forwarding a flag', async () => {
    const root = tempDir();
    const data = join(root, '.local/share/study_paper-copy');
    const config = join(root, 'bad.json');
    writeFileSync(config, '{');
    const env = { HOME: root, XDG_DATA_HOME: undefined, SP_ENV: 'prod', SP_DATA_DIR: data, SP_CONFIG_PATH: config, SP_LLM: 'mock', SP_NETWORK: 'off' };
    for (const [file, args] of [[SERVER_ENTRY, ['--user-data']], ['scripts/seed-fixture.ts', []], ['scripts/db-restore.ts', ['absent.sqlite']], ['scripts/check-startup-paths.ts', []]] as const) {
      const result = await runProbe(file.startsWith('/') ? file : join(REPO_ROOT, file), env, [...args]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('SP_DATA_DIR points into the user data');
      expect(existsSync(data)).toBe(false);
    }
    for (const key of ['SP_DATA_DIR','SP_CONFIG_PATH']) {
      const result = await runProbe(SERVER_ENTRY, { ...env, [key]: undefined });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(key + ' is required');
    }
    expect(readdirSync(root)).toEqual(['bad.json']);
  });
});

describe('S-a fix round: the server entry through a symbolic link', () => {
  it('starts like a direct start (as in M2) when the repository is reached through a symbolic link', async () => {
    const root = tempDir();
    const link = join(root, 'repo-link');
    symlinkSync(REPO_ROOT, link);
    const p = startServerProcess(serverEnv(root, 'data', await freePort()), join(link, 'apps', 'server', 'src', 'index.ts'));
    await waitFor(() => p.output().includes('listening on') || p.child.exitCode !== null, 'listening or an exit');
    expect(p.output()).toContain('listening on');
    await stopProcess(p.child);
    expect(await p.exit).toBe(0);
  }, 40_000);
});
