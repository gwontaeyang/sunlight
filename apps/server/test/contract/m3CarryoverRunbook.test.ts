import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { REPO_ROOT, runCommand } from '../helpers/proc';
import { tempDir } from '../helpers/tmp';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { describe } from 'vitest';

it('rejects even an empty dry-run port in live mode before touching OUT, DATA, or a server', async () => {
  const root = tempDir();
  for (const port of ['', '4594']) {
    const out = join(root, 'out');
    const data = join(root, 'data');
    const r = await runCommand('/bin/bash', ['scripts/live-runbook.sh'], {
      cwd: REPO_ROOT, env: { MODE: 'live', DATA: data, OUT: out, SP_DRY_RUN_PORT: port, LEDGER: undefined, SMOKE_DATA: undefined },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('SP_DRY_RUN_PORT applies only to dry runs');
    expect(r.stderr).toContain('stage=setup exit=2');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(data)).toBe(false);
  }
});

// S-a fix round: test:live gets the config path the startup check asks for, and check-args refuses what test:live
// would refuse (SMOKE_DATA entries or its config file reaching the user data directory) before OUT, build, ledger or
// server — so no arXiv request of the import step is spent on a run that cannot finish.
const SMOKE_CONFIG = '"$SMOKE_DATA.no-config.json"';

it('the test:live line gives SP_DATA_DIR and SP_CONFIG_PATH from SMOKE_DATA', () => {
  const lines = readFileSync(join(REPO_ROOT, 'scripts/live-runbook.sh'), 'utf8').split('\n').filter((l) => /npm run test:live/.test(l) && !l.trim().startsWith('#'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('SP_DATA_DIR="$SMOKE_DATA"');
  expect(lines[0]).toContain('SP_CONFIG_PATH=' + SMOKE_CONFIG);
});

describe('live: check-args applies the startup check of test:live to SMOKE_DATA', () => {
  function sandbox() {
    const root = tempDir();
    const home = join(root, 'home');
    const realData = join(home, '.local', 'share', 'study_paper');
    mkdirSync(realData, { recursive: true });
    const stubs = join(root, 'stubs');
    mkdirSync(stubs);
    const marks = join(root, 'marks');
    writeFileSync(join(stubs, 'node'), `#!/bin/sh\nfor a in "$@"; do case "$a" in *apps/server/src/index.ts) echo "server $*" >> "${marks}"; exit 1;; esac; done\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(stubs, 'npm'), `#!/bin/sh\necho "npm $*" >> "${marks}"\nexit 0\n`, { mode: 0o755 });
    const w = join(root, 'w');
    const env = {
      HOME: home, XDG_DATA_HOME: undefined, PATH: `${stubs}:${join(process.execPath, '..')}:/usr/bin:/bin`, MODE: 'live', DATA: join(w, 'm2-live-e2e'), OUT: join(w, 'out'),
      LEDGER: join(w, 'ledger-live-e2e'), SMOKE_DATA: join(root, 'smoke'), SCRATCH_ROOT: undefined, RESUME: undefined, RUN_ARGS: undefined, NET_MAX: undefined, SP_DATA_DIR: undefined, SP_DRY_RUN_PORT: undefined,
    };
    return { root, realData, marks, w, env };
  }

  it.each(['db', 'config'] as const)('SMOKE_DATA whose %s reaches the user data directory: exit 2 at check-args, nothing made', async (kind) => {
    const s = sandbox();
    mkdirSync(s.env.SMOKE_DATA, { recursive: true });
    if (kind === 'db') {
      mkdirSync(join(s.realData, 'db'));
      symlinkSync(join(s.realData, 'db'), join(s.env.SMOKE_DATA, 'db'));
    } else {
      symlinkSync(join(s.realData, 'config.json'), s.env.SMOKE_DATA + '.no-config.json');
    }
    const r = await runCommand('/bin/bash', ['scripts/live-runbook.sh'], { cwd: REPO_ROOT, env: s.env });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/--smoke-data: test:live would refuse it: .*(resolves into|points into) the user data directory/);
    expect(r.stderr).not.toMatch(/must be a directory named/);
    expect(r.stderr).toContain('runbook: stage=check-args exit=2');
    expect(existsSync(s.w)).toBe(false);
    expect(readdirSync(s.realData, { recursive: true }).map(String).sort()).toEqual(kind === 'db' ? ['db'] : []);
    expect(existsSync(s.marks) ? readFileSync(s.marks, 'utf8') : '').toBe('');
  }, 60_000);
});
