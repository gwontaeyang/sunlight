// Live E2E script and runbook as processes (BRIEF_INTEGRATION I9; INTEGRATION_NOTES 결정 15). Owner: supervisor.
// Synthetic paths only: a fake HOME under a mkdtemp root stands for the account, so "the real data directory" here is
// <fake HOME>/.local/share/study_paper — the user's directory is never named. `node` and `npm` of the runbook are stubs
// first on PATH that record what was started (the server entry, the build) and start nothing, so a refused run that
// would have gone on is visible as a marker line, and no server ever listens.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, runCommand, runProbe } from '../helpers/proc';
import { stripComments } from '../helpers/sourceScan';
import { cond8EarlierRuns, cond8Evaluate, evaluateExitCode, runExitCode, summaryLine, type Condition, type PostCheckResult, type RunMeta } from '../../../../scripts/lib/liveE2eChecks';

const RUNBOOK = join(REPO_ROOT, 'scripts', 'live-runbook.sh');
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  home: string;
  /** <home>/.local/share/study_paper (exists, empty). */
  realData: string;
  scratch: string;
  stubs: string;
  marks: string;
  env: Record<string, string | undefined>;
}

/** A fake HOME with its real data directory, a scratch root, and PATH stubs for `node` (server entry only) and `npm`. */
function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'sp-live-runbook-'));
  tmpDirs.push(root);
  const home = join(root, 'home');
  const realData = join(home, '.local', 'share', 'study_paper');
  mkdirSync(realData, { recursive: true });
  const scratch = join(root, 'scratch');
  mkdirSync(scratch);
  const stubs = join(root, 'stubs');
  mkdirSync(stubs);
  const marks = join(root, 'marks');
  // node: the server entry is recorded and refused (exit 1, nothing opened); everything else is the real node
  writeFileSync(join(stubs, 'node'), `#!/bin/sh\nfor a in "$@"; do case "$a" in *apps/server/src/index.ts) echo "server $*" >> "${marks}"; exit 1;; esac; done\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(stubs, 'npm'), `#!/bin/sh\necho "npm $*" >> "${marks}"\nexit 0\n`, { mode: 0o755 });
  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_DATA_HOME: undefined,
    PATH: `${stubs}:${join(process.execPath, '..')}:/usr/bin:/bin`,
    MODE: undefined,
    DATA: undefined,
    OUT: undefined,
    LEDGER: undefined,
    SMOKE_DATA: undefined,
    SCRATCH_ROOT: undefined,
    FAKE_BIN: undefined,
    STUB_DIR: undefined,
    RESUME: undefined,
    RUN_ARGS: undefined,
    NET_MAX: undefined,
    SP_DATA_DIR: undefined,
  };
  return { root, home, realData, scratch, stubs, marks, env };
}

const marks = (s: Sandbox) => (existsSync(s.marks) ? readFileSync(s.marks, 'utf8') : '');
const listing = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : null);

describe('live-runbook.sh: the side-effect-free argument check comes first (M-M2-R2-1 · INT-I10-04 (1))', () => {
  it('bash -n passes', async () => {
    const r = await runCommand('/bin/bash', ['-n', RUNBOOK], { cwd: REPO_ROOT });
    expect(r.status, r.stderr).toBe(0);
  });

  it('a refused dry-mock run (DATA in the real data directory): exit 2, no OUT, nothing in DATA, no build, no server', async () => {
    const s = sandbox();
    const out = join(s.scratch, 'out-1');
    const r = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: { ...s.env, MODE: 'dry-mock', DATA: s.realData, OUT: out, SCRATCH_ROOT: s.scratch } });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/real data directory/);
    expect(r.stderr).toMatch(/runbook: stage=check-args exit=2/);
    expect(existsSync(out)).toBe(false);
    expect(listing(s.realData)).toEqual([]);
    expect(marks(s)).toBe('');
  });

  it('accepted arguments go on to the build and the server (the stubs record both), so the check is not a blanket refusal', async () => {
    const s = sandbox();
    const out = join(s.scratch, 'out-ok');
    const data = join(s.scratch, 'data-ok');
    const r = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: { ...s.env, MODE: 'dry-mock', DATA: data, OUT: out, SCRATCH_ROOT: s.scratch } });
    expect(r.status).not.toBe(0); // the server stub exits 1
    expect(r.stdout).toMatch(/"checkArgs":"ok"/);
    expect(marks(s)).toMatch(/^npm run build\nserver .*apps\/server\/src\/index\.ts\n$/);
    expect(listing(s.realData)).toEqual([]);
  });

  it('live: SMOKE_DATA in the real data directory is refused before anything else', async () => {
    const s = sandbox();
    const w = join(s.scratch, 'w');
    const r = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: { ...s.env, MODE: 'live', DATA: join(w, 'm2-live-e2e'), OUT: join(w, 'out'), LEDGER: join(w, 'ledger-live-e2e'), SMOKE_DATA: join(s.realData, 'smoke') } });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/--smoke-data .*real data directory/);
    expect(existsSync(w)).toBe(false);
    expect(marks(s)).toBe('');
  });

  it('live, not RESUME, with an existing LEDGER: refused unless NET_MAX is given explicitly (INT-I10-07)', async () => {
    const s = sandbox();
    const w = join(s.scratch, 'w');
    mkdirSync(join(w, 'ledger-live-e2e'), { recursive: true });
    const env = { ...s.env, MODE: 'live', DATA: join(w, 'm2-live-e2e'), OUT: join(w, 'm2-int', 'scratch', 'live_e2e'), LEDGER: join(w, 'ledger-live-e2e'), SMOKE_DATA: join(w, 'm2-int') };
    const refused = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env });
    expect(refused.status, refused.stderr).toBe(2);
    expect(refused.stderr).toMatch(/already exists — a run that is not RESUME needs NET_MAX/);
    expect(existsSync(join(w, 'm2-int'))).toBe(false);
    expect(marks(s)).toBe('');
    // NET_MAX given: the guard lets it through (the build stub is reached)
    const given = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: { ...env, NET_MAX: '4' } });
    expect(given.stderr).not.toMatch(/needs NET_MAX/);
    expect(marks(s)).toMatch(/^npm run build\n/);
  });

  it('a refused RESUME run: exit 2, OUT and DATA unchanged (no server.log), no server', async () => {
    const s = sandbox();
    const out = join(s.scratch, 'out-2');
    mkdirSync(out);
    writeFileSync(join(out, 'keep.json'), '{}\n');
    for (const env of [
      { MODE: 'dry-mock', DATA: s.realData, OUT: out, SCRATCH_ROOT: s.scratch, RESUME: '1', RUN_ARGS: '--from O2' },
      { MODE: 'dry-fake', DATA: s.realData, OUT: out, SCRATCH_ROOT: s.scratch, LEDGER: join(s.scratch, 'ledger-dry-1'), FAKE_BIN: join(s.scratch, 'fake', 'claude'), STUB_DIR: join(s.scratch, 'stub'), RESUME: '1', RUN_ARGS: '--from O2' },
    ]) {
      const r = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: { ...s.env, ...env } });
      expect(r.status, `${env.MODE}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/real data directory/);
      expect(listing(out)).toEqual(['keep.json']);
      expect(listing(s.realData)).toEqual([]);
      expect(existsSync(join(s.scratch, 'ledger-dry-1'))).toBe(false);
      expect(marks(s)).toBe('');
    }
  });
});

describe('live-e2e.ts post-check from the run records (M-M2-R2-6 · INT-I10-02)', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts', 'live-e2e.ts');
  const outDir = (files: Record<string, unknown>) => {
    const root = mkdtempSync(join(tmpdir(), 'sp-live-postcheck-'));
    tmpDirs.push(root);
    const out = join(root, 'out');
    for (const [rel, v] of Object.entries(files)) {
      mkdirSync(join(out, rel, '..'), { recursive: true });
      writeFileSync(join(out, rel), typeof v === 'string' ? v : `${JSON.stringify(v)}\n`);
    }
    mkdirSync(out, { recursive: true });
    return { root, out };
  };
  const meta = (root: string, o: Record<string, unknown>) => ({ run: 1, mode: 'dry-fake', startedAt: 1, data: join(root, 'data'), serverPid: 999999, selector: { from: null, only: null }, callsStarted: 1, ...o });
  const postCheck = (out: string) => runProbe(SCRIPT, { HOME: join(out, '..') }, ['post-check', '--out', out]);
  const json = (s: string) => JSON.parse(s.trim().split('\n').pop()!) as Record<string, unknown>;

  it('the state SIGKILL leaves during the first call (run record not ended, O1 marker, no record, no children file) → exit 1 "child state unverified"', async () => {
    const { root, out } = outDir({});
    writeFileSync(join(out, 'run.1.json'), JSON.stringify(meta(root, {})));
    mkdirSync(join(out, 'calls'));
    writeFileSync(join(out, 'calls', 'O1.started.json'), JSON.stringify({ id: 'O1', run: 1, requestId: 'r', startedAt: 2 }));
    const r = await postCheck(out);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/child state unverified/);
    expect(json(r.stdout).postCheck).toBe('unverified');
    expect((JSON.parse(readFileSync(join(out, 'post_check.1.json'), 'utf8')) as { condition: { result: string } }).condition.result).toBe('not_evaluated');
  });

  it('an empty calls/ and no children file are no longer "no call" without the run\'s own record (Codex probe: was exit 0)', async () => {
    const { out } = outDir({});
    mkdirSync(join(out, 'calls'));
    const r = await postCheck(out);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no run record/);
  });

  it('the explicit pre-call refusal → no call (exit 0); the full record of every started call → pass (exit 0)', async () => {
    const a = outDir({});
    writeFileSync(join(a.out, 'run.1.json'), JSON.stringify(meta(a.root, { callsStarted: 0, endedAt: 3, refusedBeforeCall: 'preconditions failed' })));
    const ra = await postCheck(a.out);
    expect(ra.status, ra.stderr).toBe(0);
    expect(json(ra.stdout).postCheck).toBe('no_call');
    const b = outDir({});
    writeFileSync(join(b.out, 'run.1.json'), JSON.stringify(meta(b.root, { endedAt: 3 })));
    mkdirSync(join(b.out, 'calls'));
    writeFileSync(join(b.out, 'calls', 'O1.started.json'), JSON.stringify({ id: 'O1', run: 1, requestId: 'r', startedAt: 2 }));
    writeFileSync(join(b.out, 'calls', 'O1.json'), JSON.stringify({ id: 'O1', run: 1, outcome: 'run.done', runId: 'x', threadId: null }));
    writeFileSync(join(b.out, 'children.1.jsonl'), `${JSON.stringify({ run: 1, pid: 999998, starttime: 1, firstCall: 'O1' })}\n`);
    const rb = await postCheck(b.out);
    expect(rb.status, rb.stderr).toBe(0);
    expect(json(rb.stdout).postCheck).toBe('pass');
  });

  it('torn records (FIX4-R1-03): an empty calls/<id>.json → unverified (exit 1, not a JSON error); an empty latest run.<n>.json → that run is judged, not the earlier one', async () => {
    const a = outDir({});
    writeFileSync(join(a.out, 'run.1.json'), JSON.stringify(meta(a.root, { endedAt: 3 })));
    mkdirSync(join(a.out, 'calls'));
    writeFileSync(join(a.out, 'calls', 'O1.started.json'), JSON.stringify({ id: 'O1', run: 1, requestId: 'r', startedAt: 2 }));
    writeFileSync(join(a.out, 'calls', 'O1.json'), ''); // killed between truncate and write
    const ra = await postCheck(a.out);
    expect(ra.status, ra.stderr).toBe(1);
    expect(json(ra.stdout)).toMatchObject({ postCheck: 'unverified', run: 1 });
    expect(existsSync(join(a.out, 'post_check.1.json'))).toBe(true);
    const b = outDir({});
    writeFileSync(join(b.out, 'run.1.json'), JSON.stringify(meta(b.root, { callsStarted: 0, endedAt: 3, refusedBeforeCall: 'x' })));
    writeFileSync(join(b.out, 'run.2.json'), '{"run": 2, "mo'); // run 2 torn
    const rb = await postCheck(b.out);
    expect(rb.status, rb.stderr).toBe(1);
    expect(json(rb.stdout)).toMatchObject({ postCheck: 'unverified', run: 2 });
    expect(readdirSync(b.out).filter((n) => n.startsWith('post_check'))).toEqual(['post_check.2.json']);
  });

  it('independent of the records: a process still working in <data>/claude-cwd fails post-check', async () => {
    const { root, out } = outDir({});
    const cwd = join(root, 'data', 'claude-cwd');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(out, 'run.1.json'), JSON.stringify(meta(root, { callsStarted: 0, endedAt: 3, refusedBeforeCall: 'no call selected' })));
    const left = spawn('/bin/sleep', ['60'], { cwd, stdio: 'ignore' });
    try {
      const r = await postCheck(out);
      expect(r.status, r.stderr).toBe(1);
      expect(json(r.stdout)).toMatchObject({ postCheck: 'fail', leftover: 1 });
    } finally {
      left.kill('SIGKILL');
    }
  });
});

describe('per-run evidence is never overwritten (INT-I10-01)', () => {
  it('post-check writes post_check.<n>.json for the latest run; a re-check of the same run goes to another file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-live-perrun-'));
    tmpDirs.push(root);
    const out = join(root, 'out');
    mkdirSync(out);
    const meta = (run: number) => ({ run, mode: 'dry-fake', startedAt: 1, data: join(root, 'data'), serverPid: 999999, selector: { from: null, only: null }, callsStarted: 0, endedAt: 2, refusedBeforeCall: 'x' });
    writeFileSync(join(out, 'run.1.json'), JSON.stringify(meta(1)));
    const script = join(REPO_ROOT, 'scripts', 'live-e2e.ts');
    expect((await runProbe(script, { HOME: root }, ['post-check', '--out', out])).status).toBe(0);
    writeFileSync(join(out, 'run.2.json'), JSON.stringify(meta(2)));
    expect((await runProbe(script, { HOME: root }, ['post-check', '--out', out])).status).toBe(0);
    const first2 = readFileSync(join(out, 'post_check.2.json'), 'utf8');
    expect((await runProbe(script, { HOME: root }, ['post-check', '--out', out])).status).toBe(0);
    expect(listing(out)!.filter((n) => n.startsWith('post_check'))).toEqual(['post_check.1.json', 'post_check.2.json', 'post_check.2.re1.json']);
    expect(readFileSync(join(out, 'post_check.2.json'), 'utf8')).toBe(first2);
  });

  it('EVALUATE: the runbook judges from evaluate\'s summary line and shows the judged run\'s post-check (FIX4-R1-01)', async () => {
    const src = readFileSync(RUNBOOK, 'utf8');
    // no post-check of its own: evaluate's exit (which now includes the judged run's post-check) is the runbook's exit
    expect(src).toMatch(/EV=\$\(npx tsx scripts\/live-e2e\.ts evaluate "\$\{ARGS\[@\]\}"\) \|\| RC=\$\?/);
    expect(src).toMatch(/\$\{EVALUATE:\+ post_check=\$\{pcr:-none\}\}" >&2; \}/);
    const s = sandbox();
    const base = { ...s.env, MODE: 'dry-mock', DATA: join(s.scratch, 'd'), OUT: join(s.scratch, 'o'), SCRATCH_ROOT: s.scratch, RESUME: '1' };
    mkdirSync(join(s.scratch, 'o'));
    const r = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: { ...base, EVALUATE: '1' } });
    expect(r.stderr.trim().split('\n').pop()).toMatch(/^runbook: stage=server exit=1 run=none calls_not_done=none run_exit=none post_check_exit=none rate_warning_ok=0 post_check=none$/); // rate_warning_ok: 결정 26
    const plain = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: base });
    expect(plain.stderr.trim().split('\n').pop()).not.toMatch(/post_check=/); // the field only on EVALUATE
  });

  it('EVALUATE: the summary line carries the judged run\'s post-check, and eval_fields + on_exit\'s read turn it into the last line\'s fields (FIX4-R2-02)', async () => {
    const meta = (run: number): RunMeta => ({ run, mode: 'dry-fake', startedAt: 1, data: '/d', serverPid: 1, selector: { from: null, only: null }, callsStarted: 2, endedAt: 2 });
    const others: Condition[] = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, name: `c${id}`, result: 'pass', evidence: {} }));
    const line = (c8: Condition) => {
      const conditions = [...others, c8];
      return JSON.stringify(summaryLine(2, runExitCode(conditions), null, { conditions, callsNotDone: ['O7', 'F2'] }));
    };
    const ev = (own: PostCheckResult | null) => cond8Evaluate(2, [meta(1), meta(2)], new Map<number, PostCheckResult>([[1, 'pass'], ...(own ? [[2, own] as [number, PostCheckResult]] : [])]));
    const [pass, unverified, none] = [line(ev('pass')), line(ev('unverified')), line(ev(null))];
    const runJudged = line(cond8EarlierRuns(2, [meta(1), meta(2)], new Map([[1, 'pass']])));
    expect(JSON.parse(pass)).toMatchObject({ run: 'pass', runIndex: 2, postCheck: 'pass', callsNotDone: '2:O7,F2' });
    expect(JSON.parse(unverified)).toMatchObject({ run: 'conditions_failed', postCheck: 'unverified' });
    expect(JSON.parse(none)).toMatchObject({ run: 'conditions_failed', postCheck: 'no_post_check' }); // one field, no space
    expect(JSON.parse(runJudged)).not.toHaveProperty('postCheck'); // `run`: its own post-check comes after it
    // finishResult prints exactly this line
    const src = stripComments(readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8'));
    expect(src.slice(src.indexOf('function finishResult'), src.indexOf('async function cmdEvaluate'))).toMatch(/console\.log\(JSON\.stringify\(summaryLine\(run, code, stoppedReason, out\)\)\);/);
    // the runbook's own eval_fields definition and on_exit's read, run by bash on those lines
    const rb = readFileSync(RUNBOOK, 'utf8');
    const def = rb.split('\n').find((l) => l.startsWith('eval_fields() {'));
    const read = /read -r n nd pcr <<< "\$\(eval_fields "\$\{EVAL_LINE:-\}"\)"/.exec(rb)?.[0];
    expect(def).toBeDefined();
    expect(read).toBeDefined();
    const fields = async (evalLine: string) => {
      const r = await runCommand('/bin/bash', ['-c', `${def}\nEVAL_LINE=$1\n${read}\nprintf '%s|%s|%s\\n' "$n" "$nd" "$pcr"`, 'bash', evalLine], { cwd: REPO_ROOT, env: { PATH: `${join(process.execPath, '..')}:/usr/bin:/bin` } });
      expect(r.status).toBe(0);
      return r.stdout.trim();
    };
    expect(await fields(pass)).toBe('2|2:O7,F2|pass');
    expect(await fields(unverified)).toBe('2|2:O7,F2|unverified');
    expect(await fields(none)).toBe('2|2:O7,F2|no_post_check');
    expect(await fields('{"runIndex":2,"callsNotDone":0,"postCheck":"no post-check"}')).toBe('2|0|no_post_check'); // a spaced value stays one field
    expect(await fields(runJudged)).toBe('2|2:O7,F2|none');
    expect(await fields('{"runIndex":')).toBe('none|none|none'); // a broken line
    expect(await fields('')).toBe('none|none|none');
  });

  it('the runbook\'s last line names the run index (run=none when no run record was made)', async () => {
    const src = readFileSync(RUNBOOK, 'utf8');
    expect(src).toMatch(/echo "runbook: stage=\$STAGE exit=\$rc run=\$\{n:-none\} calls_not_done=\$nd run_exit=/);
    const s = sandbox();
    const r = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: { ...s.env, MODE: 'dry-mock', DATA: join(s.scratch, 'd'), OUT: join(s.scratch, 'o'), SCRATCH_ROOT: s.scratch } });
    expect(r.stderr.trim().split('\n').pop()).toMatch(/^runbook: stage=server exit=1 run=none calls_not_done=none /); // the server stub: no run
  });
});

describe('live-runbook.sh header: operating rules', () => {
  const header = () => {
    const lines = readFileSync(RUNBOOK, 'utf8').split('\n');
    return lines.slice(0, lines.findIndex((l) => l.startsWith('set -euo pipefail'))).filter((l) => l.startsWith('#'));
  };
  it('a run that started F1 (calls/F1.started.json) and died during F1 or has no / an incomplete calls/F1.json is resumed with --from F1, never a run that did not start F1; F1r alone with --only F1r (FIX4-R3-02, INT4B-R1-01)', () => {
    const rule = header().filter((l) => /F1 도중 죽었거나/.test(l));
    expect(rule).toHaveLength(1);
    expect(rule[0]).toMatch(/F1을 시작했고\(calls\/F1\.started\.json 있음\) F1 도중 죽었거나 F1 기록\(calls\/F1\.json\)이 없거나 불완전하면 RUN_ARGS="--from F1".*F1을 다시 보내 판정.*F1을 시작하지 않은 run에는 쓰지 않음.*F1r만.*"--only F1r"/);
  });
});

describe('live-e2e.ts evaluate: the exit code and the summary line\'s verdict (FIX4-R3-03)', () => {
  const conds = (c8: Condition['result']): Condition[] => [...[1, 2, 3, 4, 5, 6, 7].map((id): Condition => ({ id, name: `c${id}`, result: 'pass', evidence: {} })), { id: 8, name: 'c8', result: c8, evidence: {} }];
  it('a stopped run → 3 whatever the conditions; not stopped → 1 when a condition fails (8 included), 0 when all pass', () => {
    expect(evaluateExitCode('ledger stopped', conds('pass'))).toBe(3);
    expect(evaluateExitCode('ledger stopped', conds('fail'))).toBe(3);
    expect(evaluateExitCode(null, conds('fail'))).toBe(1);
    expect(evaluateExitCode(null, conds('pass'))).toBe(0);
    const failed7 = conds('pass').map((c) => (c.id === 7 ? { ...c, result: 'fail' as const } : c));
    expect(evaluateExitCode(null, failed7)).toBe(1);
  });
  it('the summary line names the verdict of that code: pass · stopped · conditions_failed', () => {
    const line = (stopped: string | null, c8: Condition['result']) => summaryLine(4, evaluateExitCode(stopped, conds(c8)), stopped, { conditions: conds(c8), callsNotDone: [] });
    expect(line(null, 'pass')).toMatchObject({ run: 'pass', runIndex: 4, stoppedReason: null, callsNotDone: 0 });
    expect(line('ledger stopped', 'pass')).toMatchObject({ run: 'stopped', stoppedReason: 'ledger stopped' });
    expect(line(null, 'fail')).toMatchObject({ run: 'conditions_failed', stoppedReason: null });
  });
  it('the CLI header lists lookup failures under exit 3', () => {
    const raw = readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8');
    const src = stripComments(raw);
    const header = raw.slice(0, raw.indexOf('\nimport '));
    expect(header).toMatch(/Exit codes:[\s\S]*3 stopped \([^)]*failed lookup[^)]*after a call[^)]*before a resume's first call/);
    // every lookup whose failure stops the run after a call (critical = fresh === null || !ledgerOk || f1Unknown) is named (INT4B-R1-02)
    expect(src).toMatch(/const critical = fresh === null \|\| !ledgerOk \|\| f1Unknown;/);
    expect(header).toMatch(/3 stopped \([^)]*failed lookup after a call[^)]*llm_calls rows[^)]*the ledger[^)]*F1's \/ F1r's verdict[^)]*before a resume's first call/);
  });
});

describe('README: the live:e2e commands (X-FX-01)', () => {
  it('the README line lists every command live-e2e.ts accepts and says what RESUME=1 EVALUATE=1 does', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8');
    const accepted = /usage: live-e2e\.ts ([a-z|-]+) /.exec(src)?.[1]?.split('|') ?? [];
    expect(accepted).toEqual(expect.arrayContaining(['init', 'import', 'run', 'evaluate', 'post-check', 'check-args']));
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const listed = /`npm run live:e2e -- <([a-z|-]+)>/.exec(readme)?.[1]?.split('|') ?? [];
    expect([...listed].sort()).toEqual([...accepted].sort());
    expect(readme).toMatch(/`RESUME=1 EVALUATE=1`[^\n]*LLM 0/);
  });
});
