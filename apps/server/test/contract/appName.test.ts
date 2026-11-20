// The app's name is Sunlight (INTEGRATION_NOTES 결정 27, 29): the browser tab title of the web app and the first line of
// the README. Only the shown name changes — the repository, the package names and the data directory stay study_paper /
// study-paper (moving the real data path would put the cutover at risk). Owner: supervisor.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataDir, runtimeDir } from '../../src/security/runtimePaths';
import { REPO_ROOT } from '../helpers/proc';

const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf8');

describe('app name Sunlight (결정 27)', () => {
  it('apps/web/index.html has exactly one <title>, and it is Sunlight', () => {
    const titles = [...read('apps', 'web', 'index.html').matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
    expect(titles).toEqual(['Sunlight']);
  });

  it('the README starts with the name Sunlight and says the repository is study_paper', () => {
    const first = read('README.md').split('\n')[0];
    expect(first).toMatch(/^# Sunlight\b/);
    expect(first).toContain('study_paper');
  });

  it('no other rename: package names and the data / runtime directory names stay as they were', () => {
    expect(JSON.parse(read('package.json')).name).toBe('study-paper');
    expect(JSON.parse(read('apps', 'web', 'package.json')).name).toBe('@study-paper/web');
    expect(JSON.parse(read('apps', 'server', 'package.json')).name).toBe('@study-paper/server');
    expect(resolveDataDir({ XDG_DATA_HOME: '/synthetic/xdg' })).toBe('/synthetic/xdg/study_paper');
    expect(runtimeDir({ XDG_RUNTIME_DIR: '/synthetic/run' })).toBe('/synthetic/run/study_paper');
  });
});
