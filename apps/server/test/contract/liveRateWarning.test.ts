// The coordinator-approved rate-limit warning exception (INTEGRATION_NOTES 결정 26) in the scripts: smoke-live
// (`npm run test:live`) and live-e2e with the fake CLI, init --allow-rate-warning, the runbook's RATE_WARNING_OK, and
// the warnings in live_e2e.json. Owner: supervisor. Synthetic paths only (mkdtemp roots; a fake HOME for the runbook);
// every claude is the fake CLI, and a stub `claude` that exits 97 is first on PATH.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ClaudeCliAdapter } from '../../src/llm/claudeCli';
import type { LlmEvent } from '../../src/llm/adapter';
import { initLiveLedger, readLiveLedger, readRateWarningApproval, readRateWarnings } from '../../src/llm/liveLedger';
import { fakeClaudeBin, makeRequest } from '../llm/fakeCli';
import { REPO_ROOT, runCommand, runProbe } from '../helpers/proc';
import { stripComments } from '../helpers/sourceScan';
import { checkRateWarningFlag, evaluateExitCode, evaluateStoppedReason, LiveE2eResultSchema, rateLimitWarningsOf, rateWarningApprovalFields, rateWarningResultFields, runExitCode } from '../../../../scripts/lib/liveE2eChecks';
import { afterSkip, CALL_BY_ID, CALL_IDS, initialRunState, LIVE_CAPS, nextAction, stepAfterCall, stepAtEnd, stepBeforeCall, type CallId, type CallOutcome, type RunState, type Selector } from '../../../../scripts/lib/liveE2ePlan';

const SMOKE = join(REPO_ROOT, 'scripts', 'smoke-live.ts');
const LIVE_E2E = join(REPO_ROOT, 'scripts', 'live-e2e.ts');
const RUNBOOK = join(REPO_ROOT, 'scripts', 'live-runbook.sh');
const SYNTHETIC_PDF = join(REPO_ROOT, 'apps', 'server', 'test', 'fixtures', 'synthetic.pdf');
const APPROVAL = { approvedBy: 'coordinator (test)', reason: 'synthetic approval', at: '2026-11-18T00:00:00.000Z' };
const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.SP_LIVE_LEDGER;
});
function root(prefix: string): string {
  const r = mkdtempSync(join(tmpdir(), prefix));
  roots.push(r);
  return r;
}
/** A stub `claude` (exit 97) in its own directory: first on every PATH below. */
function stubDir(r: string): string {
  const d = join(r, 'stub');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'claude'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  return d;
}

describe('smoke-live (npm run test:live) with the fake CLI: a warning, then the result (결정 26)', () => {
  /** A data dir with the synthetic PDF standing in for fixtures/2209.15397v2.pdf, a ledger of 3 haiku, the fake CLI. */
  async function smoke(scenario: string, approved: boolean) {
    const r = root('sp-smoke-warn-');
    const data = join(r, 'data');
    mkdirSync(join(data, 'fixtures'), { recursive: true });
    mkdirSync(join(data, 'claude-cwd'));
    copyFileSync(SYNTHETIC_PDF, join(data, 'fixtures', '2209.15397v2.pdf'));
    const ledger = join(r, 'ledger');
    initLiveLedger(ledger, { total: 3, perModel: { haiku: 3 } });
    if (approved) writeFileSync(join(ledger, 'ALLOW_RATE_WARNING'), JSON.stringify(APPROVAL));
    const bin = fakeClaudeBin(join(r));
    const res = await runProbe(SMOKE, { SP_LIVE: '1', SP_LIVE_LEDGER: ledger, SP_DATA_DIR: data, SP_CLAUDE_BIN: bin, FAKE_CLAUDE_SCENARIO: scenario, PATH: `${stubDir(r)}:${process.env.PATH}`, XDG_RUNTIME_DIR: join(r, 'run') }, [], 120_000);
    // the warnings file is read by the test that needs it (warnings()), so the other assertions do not depend on it
    return { res, ledger, state: readLiveLedger(ledger), warnings: () => readRateWarnings(ledger) };
  }

  it('approval: every call reports allowed_warning and the script goes on — 3 calls, no STOP, 3 warnings recorded', async () => {
    const { res, state, warnings } = await smoke('ok_limit_warning', true);
    expect(res.stdout).toMatch(/\[1-no-pdf\] rate_limit_info\.status=allowed_warning → continuing/);
    expect(res.stdout).not.toMatch(/→ stopping/);
    expect(res.stdout).toMatch(/smoke-live: 3 call\(s\)/);
    expect(state.used).toEqual({ total: 3, perModel: { haiku: 3 } });
    expect(state.stopped).toBeNull();
    expect(warnings().map((w) => [w.status, w.runId])).toEqual([
      ['allowed_warning', 'smoke-1-no-pdf'],
      ['allowed_warning', 'smoke-2-paper-cold'],
      ['allowed_warning', 'smoke-3-paper-warm-image'],
    ]);
  }, 180_000);

  it('no approval: the first call stops the script (exit 1) and the ledger (STOP) — 1 call', async () => {
    const { res, state, ledger } = await smoke('ok_limit_warning', false);
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stdout).toMatch(/\[1-no-pdf\] rate_limit_info\.status=allowed_warning → stopping/);
    expect(res.stdout).toMatch(/smoke-live: 1 call\(s\)/);
    expect(state.used.total).toBe(1);
    expect(state.stopped).toBe('rate_limit: allowed_warning');
    expect(existsSync(join(ledger, 'rate_warnings.jsonl'))).toBe(false);
  }, 180_000);

  it('approval + a successful result whose status is another non-allowed value (rejected): the script stops at once (exit 1, "→ stopping", never "→ continuing"), 1 call, STOP (INT-WARNOK-R1-03)', async () => {
    const { res, state, ledger } = await smoke('ok_limit_rejected', true);
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stdout).toMatch(/\[1-no-pdf\] rate_limit_info\.status=rejected → stopping/);
    expect(res.stdout).not.toMatch(/→ continuing/);
    expect(res.stdout).toMatch(/smoke-live: 1 call\(s\)/);
    expect(state.used.total).toBe(1);
    expect(state.stopped).toBe('rate_limit: rejected');
    expect(existsSync(join(ledger, 'rate_warnings.jsonl'))).toBe(false);
  }, 180_000);

  it('approval + a terminal rate_limited after the warning: the script stops after the first call (exit 1), STOP', async () => {
    const { res, state } = await smoke('warning_rate_limited', true);
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stdout).toMatch(/error rate_limited/);
    expect(state.used.total).toBe(1);
    expect(state.stopped).toBe('rate_limited');
  }, 180_000);

  it('approval + a transient CLI error after the warning (api_error_status 500): the script stops after the first call (exit 1) with cli_error, the ledger is NOT stopped, the warning recorded (결정 29, RCW-01)', async () => {
    const { res, state, warnings } = await smoke('warning_error_result', true);
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stdout).toMatch(/\[1-no-pdf\] error cli_error/);
    expect(res.stdout).not.toMatch(/error rate_limited/);
    expect(state.used.total).toBe(1);
    expect(state.stopped).toBeNull();
    expect(state.stopRequested).toBeNull();
    expect(warnings().map((w) => [w.status, w.runId])).toEqual([['allowed_warning', 'smoke-1-no-pdf']]);
  }, 180_000);

  it('no approval + the same scenario: the ledger stops at the warning event (as before); the terminal is cli_error', async () => {
    const { res, state, ledger } = await smoke('warning_error_result', false);
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stdout).toMatch(/\[1-no-pdf\] error cli_error/);
    expect(state.used.total).toBe(1);
    expect(state.stopped).toBe('rate_limit: allowed_warning');
    expect(existsSync(join(ledger, 'rate_warnings.jsonl'))).toBe(false);
  }, 180_000);
});

describe('live-e2e run loop with the fake CLI: a warning, then the result (결정 26)', () => {
  // The loop functions of scripts/live-e2e.ts (stepBeforeCall reads the ledger before every call; nextAction after it)
  // around one real adapter call of O1 against the fake CLI and a LIVE_CAPS ledger.
  async function afterO1(approved: boolean, scenario = 'ok_limit_warning') {
    const r = root('sp-loop-warn-');
    const ledger = join(r, 'ledger-dry-loop');
    initLiveLedger(ledger, { total: LIVE_CAPS.total, perModel: { ...LIVE_CAPS.perModel } });
    if (approved) writeFileSync(join(ledger, 'ALLOW_RATE_WARNING'), JSON.stringify(APPROVAL));
    process.env.SP_LIVE_LEDGER = ledger;
    let state = initialRunState();
    const first = stepBeforeCall(state, {}, LIVE_CAPS.perModel.opus, readLiveLedger(ledger));
    expect(first).toMatchObject({ kind: 'call', call: { id: 'O1' } });
    const adapter = new ClaudeCliAdapter({ claudeBin: fakeClaudeBin(r), cwd: r, env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario }, log: () => {} });
    let terminal: LlmEvent | null = null;
    for await (const e of adapter.run(makeRequest({ runId: 'run-o1', model: CALL_BY_ID.O1.model, task: CALL_BY_ID.O1.task }))) if (e.type === 'result' || e.type === 'error') terminal = e;
    if (scenario === 'ok_limit_warning') expect(terminal?.type).toBe('result');
    const outcome: CallOutcome = terminal?.type === 'error' ? { kind: 'run_error', code: terminal.code } : { kind: 'done' };
    const v = nextAction(CALL_BY_ID.O1, outcome, 0, readLiveLedger(ledger));
    const after = stepAfterCall(state, v);
    state = after.state;
    return { ledger, terminal, verdict: v, exitCode: after.exitCode, next: stepBeforeCall(state, {}, LIVE_CAPS.perModel.opus, readLiveLedger(ledger)) };
  }

  it('approval: O2 is sent next; the ledger used 1 of 25, the warning recorded with O1\'s run id', async () => {
    const { ledger, next } = await afterO1(true);
    expect(next).toMatchObject({ kind: 'call', call: { id: 'O2' } });
    expect(readLiveLedger(ledger).used).toEqual({ total: 1, perModel: { opus: 1 } });
    expect(readRateWarnings(ledger).map((w) => w.runId)).toEqual(['run-o1']);
  }, 30_000);

  it('no approval: the run stops right after O1 (exit 3, M-M2-R4-1), O2 is never sent — one call', async () => {
    const { ledger, verdict, exitCode, next } = await afterO1(false);
    expect(verdict).toMatchObject({ action: 'stop', reason: expect.stringMatching(/^the ledger is stopped after call O1 \(STOP: rate_limit: allowed_warning\)/) });
    expect(exitCode).toBe(3);
    expect(next).toEqual({ kind: 'end' });
    expect(readLiveLedger(ledger).used.total).toBe(1);
  }, 30_000);

  // 결정 29 (RCW-01): O1 ends with a transient CLI error (api_error_status 500) under an allowed_warning
  it('approval + warning_error_result at O1: run.error cli_error → the run stops (exit 3) but the ledger is not stopped — a resume (--from O1) sends O1 again', async () => {
    const { ledger, terminal, verdict, exitCode } = await afterO1(true, 'warning_error_result');
    expect(terminal).toMatchObject({ type: 'error', code: 'cli_error' });
    expect(verdict.action).toBe('stop');
    expect(exitCode).toBe(3);
    const view = readLiveLedger(ledger);
    expect([view.stopped, view.stopRequested, view.used.total]).toEqual([null, null, 1]);
    expect(stepBeforeCall(initialRunState(), { from: 'O1' }, LIVE_CAPS.perModel.opus, view)).toMatchObject({ kind: 'call', call: { id: 'O1' } });
    // a cli_error of a later call stops that run the same way (exit 3), never the ledger
    expect(stepAfterCall(initialRunState(), nextAction(CALL_BY_ID.O2, { kind: 'run_error', code: 'cli_error' }, 0, view)).exitCode).toBe(3);
  }, 30_000);

  it('no approval + warning_error_result at O1: the ledger stopped at the warning event — a resume is refused before its first call (exit 3)', async () => {
    const { ledger, terminal, exitCode } = await afterO1(false, 'warning_error_result');
    expect(terminal).toMatchObject({ type: 'error', code: 'cli_error' });
    expect(exitCode).toBe(3);
    expect(stepBeforeCall(initialRunState(), { from: 'O1' }, LIVE_CAPS.perModel.opus, readLiveLedger(ledger))).toMatchObject({ kind: 'stop', exitCode: 3 });
  }, 30_000);
});

describe('live-e2e run loop: a stop made by the LAST executed call (Codex r4 M-M2-R4-1, 결정 33)', () => {
  // One real adapter call of the last selected call against the fake CLI and an approved LIVE_CAPS ledger, then the loop
  // functions of scripts/live-e2e.ts to its end (nextAction · stepAfterCall · stepBeforeCall over the skips · stepAtEnd)
  // and evaluate's stop reason (evaluateStoppedReason · evaluateExitCode) with conditions 1–7 all pass: a run whose
  // ledger stopped must never come out as a pass.
  const PASS = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, name: `c${id}`, result: 'pass' as const, evidence: {} }));
  async function lastCall(o: { call: CallId; sel: Selector; scenario: string; setup?: (ledger: string) => void; afterCall?: (ledger: string) => void; beforeEnd?: (ledger: string) => void }) {
    const r = root('sp-loop-last-');
    const ledger = join(r, 'ledger-dry-last');
    initLiveLedger(ledger, { total: LIVE_CAPS.total, perModel: { ...LIVE_CAPS.perModel } });
    writeFileSync(join(ledger, 'ALLOW_RATE_WARNING'), JSON.stringify(APPROVAL));
    o.setup?.(ledger);
    process.env.SP_LIVE_LEDGER = ledger;
    const opusLeft = () => {
      const l = readLiveLedger(ledger);
      return (l.caps?.perModel.opus ?? 0) - (l.used.perModel.opus ?? 0);
    };
    let state: RunState = { ...initialRunState(), pos: CALL_IDS.indexOf(o.call), f1Passed: true };
    expect(stepBeforeCall(state, o.sel, opusLeft(), readLiveLedger(ledger))).toMatchObject({ kind: 'call', call: { id: o.call } });
    const c = CALL_BY_ID[o.call];
    const adapter = new ClaudeCliAdapter({ claudeBin: fakeClaudeBin(r), cwd: r, env: { ...process.env, FAKE_CLAUDE_SCENARIO: o.scenario }, log: () => {} });
    let terminal: LlmEvent | null = null;
    for await (const e of adapter.run(makeRequest({ runId: `run-${o.call}`, model: c.model, task: c.task }))) if (e.type === 'result' || e.type === 'error') terminal = e;
    o.afterCall?.(ledger);
    const outcome: CallOutcome = terminal?.type === 'error' ? { kind: 'run_error', code: terminal.code } : { kind: 'done' };
    const verdict = nextAction(c, outcome, 0, readLiveLedger(ledger));
    const after = stepAfterCall(state, verdict);
    state = after.state;
    let exitCode = after.exitCode;
    const steps: string[] = [];
    while (exitCode === null) {
      const s = stepBeforeCall(state, o.sel, opusLeft(), readLiveLedger(ledger));
      if (s.kind === 'end') break;
      if (s.kind !== 'skip') throw new Error(`${o.call} is the last executed call, got ${s.kind} ${s.call.id}`);
      if (s.record !== 'not_selected') steps.push(s.record);
      state = afterSkip(state);
    }
    if (exitCode === null) {
      o.beforeEnd?.(ledger);
      const end = stepAtEnd(state, readLiveLedger(ledger));
      state = end.state;
      exitCode = end.exitCode;
    }
    const view = readLiveLedger(ledger);
    return {
      ledger,
      terminal,
      verdict,
      steps,
      view,
      runExit: exitCode ?? runExitCode(PASS),
      stoppedReason: state.stopped,
      // evaluate later: the reason stored in run.<n>.json, and a record without one (made before this fix)
      evaluateExit: evaluateExitCode(evaluateStoppedReason(state.stopped, view), PASS),
      evaluateExitNoStored: evaluateExitCode(evaluateStoppedReason(null, view), PASS),
    };
  }

  it('the last plan call S3: a rejected status + a successful result → STOP, the run exits 3 with the reason naming S3; evaluate keeps 3', async () => {
    const x = await lastCall({ call: 'S3', sel: {}, scenario: 'ok_limit_rejected' });
    expect(x.terminal?.type).toBe('result');
    expect(x.view.stopped).toBe('rate_limit: rejected');
    expect(x.verdict.action).toBe('stop');
    expect(x.runExit).toBe(3);
    expect(x.stoppedReason).toBe('the ledger is stopped after call S3 (STOP: rate_limit: rejected); its outcome run.done is not judged');
    expect([x.evaluateExit, x.evaluateExitNoStored]).toEqual([3, 3]);
  }, 30_000);

  it('--only O1 with the same fake: exit 3, the reason names O1', async () => {
    const x = await lastCall({ call: 'O1', sel: { only: 'O1' }, scenario: 'ok_limit_rejected' });
    expect(x.terminal?.type).toBe('result');
    expect(x.runExit).toBe(3);
    expect(x.stoppedReason).toMatch(/^the ledger is stopped after call O1 \(STOP: rate_limit: rejected\)/);
    expect([x.evaluateExit, x.evaluateExitNoStored]).toEqual([3, 3]);
  }, 30_000);

  it('STOP_REQUESTED only (STOP not confirmed yet) after the last call: exit 3', async () => {
    const x = await lastCall({ call: 'S3', sel: {}, scenario: 'ok', afterCall: (l) => writeFileSync(join(l, 'STOP_REQUESTED'), 'rate_limit: rejected') });
    expect([x.view.stopped, x.view.stopRequested]).toEqual([null, 'rate_limit: rejected']);
    expect(x.runExit).toBe(3);
    expect(x.stoppedReason).toMatch(/after call S3 \(STOP_REQUESTED: rate_limit: rejected\)/);
    expect([x.evaluateExit, x.evaluateExitNoStored]).toEqual([3, 3]);
  }, 30_000);

  it('an approved warning that cannot be recorded (rate_warnings.jsonl is a directory) on the last call: the ledger stops, exit 3', async () => {
    const x = await lastCall({ call: 'S3', sel: {}, scenario: 'ok_limit_warning', setup: (l) => mkdirSync(join(l, 'rate_warnings.jsonl')) });
    expect(x.terminal?.type).toBe('result');
    expect(x.view.stopped).toMatch(/could not be recorded/);
    expect(x.runExit).toBe(3);
    expect(x.stoppedReason).toMatch(/^the ledger is stopped after call S3 /);
  }, 30_000);

  it('a stop that appears after the last call was judged (--only O1, then only not_selected skips): the check when the loop ends → exit 3', async () => {
    const x = await lastCall({ call: 'O1', sel: { only: 'O1' }, scenario: 'ok_limit_warning', beforeEnd: (l) => writeFileSync(join(l, 'STOP_REQUESTED'), 'rate_limit: rejected') });
    expect(x.verdict.action).toBe('next');
    expect(x.runExit).toBe(3);
    expect(x.stoppedReason).toBe('the ledger is stopped at the end of the run (STOP_REQUESTED: rate_limit: rejected); no call was left to send');
    expect(x.evaluateExit).toBe(3);
  }, 30_000);

  it('control: an approved allowed_warning on the last call S3 (and on --only O1) → no stop, the run goes on to its normal verdict (0 with conditions 1–7 pass)', async () => {
    for (const [call, sel] of [['S3', {}], ['O1', { only: 'O1' }]] as const) {
      const x = await lastCall({ call, sel, scenario: 'ok_limit_warning' });
      expect(x.terminal?.type, call).toBe('result');
      expect([x.view.stopped, x.view.stopRequested], call).toEqual([null, null]);
      expect(x.verdict, call).toEqual({ action: 'next', consecutiveSoft: 0, reason: 'run.done' });
      expect([x.runExit, x.stoppedReason, x.evaluateExit, x.evaluateExitNoStored], call).toEqual([0, null, 0, 0]);
      expect(readRateWarnings(x.ledger).map((w) => w.runId), call).toEqual([`run-${call}`]);
    }
  }, 60_000);

  // The CLI wiring (before/after calls, loop end and publication) is exercised in liveLedgerJudgment.test.ts.
});

describe('rateLimitWarningsOf: the ledger lines → live_e2e.json rateLimitWarnings', () => {
  it('labels each warning with its call (own run, a repair via parentRunId, H<k> of test:live) or null', () => {
    const w = (runId: string | null) => ({ at: 't', source: 'event' as const, status: 'allowed_warning', utilization: 0.54, resetsAt: 4102444800, rateLimitType: 'seven_day', runId });
    const out = rateLimitWarningsOf([w('smoke-2-paper-cold'), w('r-o1'), w('r-o7-repair'), w('r-other'), w(null)], [{ id: 'O1', runId: 'r-o1' }, { id: 'O7', runId: 'r-o7' }], [{ runId: 'r-o7-repair', parentRunId: 'r-o7' }, { runId: 'r-other', parentRunId: null }]);
    expect(out.map((x) => x.call)).toEqual(['H2', 'O1', 'O7', null, null]);
    expect(out[1]).toEqual({ call: 'O1', runId: 'r-o1', status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.54, resetsAt: 4102444800, at: 't' });
    // rateLimitType is carried as it is (a five_hour warning is not read as seven_day); missing → null
    const five = rateLimitWarningsOf([{ ...w('r-o1'), rateLimitType: 'five_hour', resetsAt: 4102400000 }, { ...w('r-o1'), rateLimitType: null }], [{ id: 'O1', runId: 'r-o1' }], []);
    expect(five.map((x) => [x.rateLimitType, x.resetsAt])).toEqual([['five_hour', 4102400000], [null, 4102444800]]);
  });
});

describe('run.<n>.json and live_e2e.json rate-warning fields from a real ledger directory (결정 26 item 4, INT-WARNOK-R1-01)', () => {
  const LINE = (runId: string) => JSON.stringify({ at: '2026-11-18T01:00:00.000Z', source: 'event', status: 'allowed_warning', utilization: 0.54, resetsAt: 4102444800, rateLimitType: 'seven_day', runId });
  function ledgerDir(o: { approval?: string; warnings?: string[] } = {}): string {
    const dir = join(root('sp-rwf-'), 'ledger');
    initLiveLedger(dir, { total: LIVE_CAPS.total, perModel: { ...LIVE_CAPS.perModel } });
    if (o.approval !== undefined) writeFileSync(join(dir, 'ALLOW_RATE_WARNING'), o.approval);
    if (o.warnings) writeFileSync(join(dir, 'rate_warnings.jsonl'), o.warnings.map((l) => `${l}\n`).join(''));
    return dir;
  }
  const calls = [{ id: 'O1', runId: 'r-o1' }, { id: 'O7', runId: 'r-o7' }];
  const rows = [{ runId: 'r-o7-repair', parentRunId: 'r-o7' }];
  const shape = LiveE2eResultSchema.pick({ rateWarningAllowed: true, rateWarningApproval: true, rateLimitWarnings: true });

  it('approval present: true + its content, and the warnings mapped to their calls (own run, a repair via its parent)', () => {
    for (const mode of ['live', 'dry-fake'] as const) {
      const dir = ledgerDir({ approval: JSON.stringify(APPROVAL), warnings: [LINE('r-o1'), LINE('r-o7-repair')] });
      expect(rateWarningApprovalFields(mode, dir), mode).toEqual({ rateWarningAllowed: true, rateWarningApproval: APPROVAL });
      const f = rateWarningResultFields(mode, dir, calls, rows);
      expect(f.rateWarningAllowed, mode).toBe(true);
      expect(f.rateWarningApproval, mode).toEqual(APPROVAL);
      expect(f.rateLimitWarnings.map((w) => [w.call, w.runId, w.status, w.utilization, w.resetsAt]), mode).toEqual([
        ['O1', 'r-o1', 'allowed_warning', 0.54, 4102444800],
        ['O7', 'r-o7-repair', 'allowed_warning', 0.54, 4102444800],
      ]);
      expect(shape.parse(f), mode).toEqual(f); // what live_e2e.json's schema accepts
    }
  });

  it('no approval, or a damaged one: false / null (warnings, if any, are still listed); no warnings file → []', () => {
    expect(rateWarningResultFields('live', ledgerDir(), calls, rows)).toEqual({ rateWarningAllowed: false, rateWarningApproval: null, rateLimitWarnings: [] });
    for (const damaged of ['{not json', JSON.stringify({ approvedBy: 'x' }), JSON.stringify({ ...APPROVAL, extra: 1 }), '']) {
      const dir = ledgerDir({ approval: damaged, warnings: [LINE('r-o1')] });
      expect(rateWarningApprovalFields('dry-fake', dir), damaged).toEqual({ rateWarningAllowed: false, rateWarningApproval: null });
      expect(rateWarningResultFields('dry-fake', dir, calls, rows).rateLimitWarnings.map((w) => w.call), damaged).toEqual(['O1']);
    }
  });

  it('dry-mock (no ledger) or no --ledger: false / null / [] even when the given directory carries an approval and warnings', () => {
    const dir = ledgerDir({ approval: JSON.stringify(APPROVAL), warnings: [LINE('r-o1')] });
    expect(rateWarningApprovalFields('dry-mock', dir)).toEqual({ rateWarningAllowed: false, rateWarningApproval: null });
    expect(rateWarningResultFields('dry-mock', dir, calls, rows)).toEqual({ rateWarningAllowed: false, rateWarningApproval: null, rateLimitWarnings: [] });
    expect(rateWarningResultFields('live', undefined, calls, rows)).toEqual({ rateWarningAllowed: false, rateWarningApproval: null, rateLimitWarnings: [] });
  });

  it('live-e2e.ts takes the fields from these helpers: the run record of cmdRun and the result of evaluate (no second way to compute them)', () => {
    const code = stripComments(readFileSync(LIVE_E2E, 'utf8'));
    expect(code).toMatch(/const meta = claimRunMeta\(a\.out, \{[^;]*\.\.\.rateWarningApprovalFields\(a\.mode, a\.ledger\) \}\);/);
    expect(code).toMatch(/return \{\s*mode: a\.mode,\s*\.\.\.rateWarningResultFields\(a\.mode, a\.ledger, calls, x\.rows\),/);
    expect(code.match(/\b(rateWarningAllowed|rateWarningApproval|rateLimitWarnings)\b|readRateWarnings\(|rateLimitWarningsOf\(/g)).toEqual(['rateWarningAllowed', 'rateWarningApproval']); // only the stdout line of init
  });
});

describe('live-e2e.ts init --allow-rate-warning (결정 26)', () => {
  it('the flag rule: init in live or dry-fake only', () => {
    expect(checkRateWarningFlag('init', 'live', true)).toEqual([]);
    expect(checkRateWarningFlag('init', 'dry-fake', true)).toEqual([]);
    expect(checkRateWarningFlag('init', 'dry-mock', true)).toHaveLength(1);
    for (const c of ['run', 'import', 'check-args', 'evaluate', 'post-check'] as const) expect(checkRateWarningFlag(c, 'live', true), c).toHaveLength(1);
    expect(checkRateWarningFlag('run', 'dry-mock', false)).toEqual([]);
  });

  function dry() {
    const r = root('sp-init-warn-');
    const scratch = join(r, 'scratch');
    mkdirSync(scratch);
    const ledger = join(scratch, 'ledger-dry-1');
    const args = (mode: string, extra: string[] = []) => ['--mode', mode, '--base-url', 'http://127.0.0.1:4570', '--data', join(scratch, 'data'), '--out', join(scratch, 'out'), '--scratch-root', scratch, ...(mode === 'dry-mock' ? [] : ['--ledger', ledger]), ...extra];
    const env = { HOME: join(r, 'home'), XDG_DATA_HOME: undefined };
    return { r, scratch, ledger, args, env };
  }

  it('dry-fake: the ledger gets LIVE_CAPS and the approval (approvedBy · reason · at); caps unchanged; stdout says so', async () => {
    const d = dry();
    const res = await runProbe(LIVE_E2E, d.env, ['init', ...d.args('dry-fake', ['--allow-rate-warning'])]);
    expect(res.status, res.stderr).toBe(0);
    const approval = readRateWarningApproval(d.ledger);
    expect(approval).toMatchObject({ approvedBy: expect.stringMatching(/coordinator/), reason: expect.stringMatching(/allowed_warning/) });
    expect(Number.isNaN(Date.parse(approval!.at))).toBe(false);
    expect(readLiveLedger(d.ledger).caps).toEqual({ total: LIVE_CAPS.total, perModel: LIVE_CAPS.perModel });
    expect(JSON.parse(res.stdout.trim().split('\n').pop()!)).toMatchObject({ init: 'ok', rateWarningAllowed: true, rateWarningApproval: approval });
  }, 60_000);

  it('without the flag: no approval; and init without the flag on a ledger that has one is refused (exit 2)', async () => {
    const d = dry();
    const plain = await runProbe(LIVE_E2E, d.env, ['init', ...d.args('dry-fake')]);
    expect(plain.status, plain.stderr).toBe(0);
    expect(existsSync(join(d.ledger, 'ALLOW_RATE_WARNING'))).toBe(false);
    expect(JSON.parse(plain.stdout.trim().split('\n').pop()!)).toMatchObject({ rateWarningAllowed: false, rateWarningApproval: null });
    writeFileSync(join(d.ledger, 'ALLOW_RATE_WARNING'), JSON.stringify(APPROVAL));
    const again = await runProbe(LIVE_E2E, d.env, ['init', ...d.args('dry-fake')]);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/carries ALLOW_RATE_WARNING/);
    // with the flag on that ledger: the first approval stays
    const withFlag = await runProbe(LIVE_E2E, d.env, ['init', ...d.args('dry-fake', ['--allow-rate-warning'])]);
    expect(withFlag.status, withFlag.stderr).toBe(0);
    expect(readRateWarningApproval(d.ledger)).toEqual(APPROVAL);
  }, 60_000);

  it('refused (exit 2, nothing created): dry-mock, any other command, the flag twice', async () => {
    const d = dry();
    for (const argv of [
      ['init', ...d.args('dry-mock', ['--allow-rate-warning'])],
      ['run', ...d.args('dry-fake', ['--allow-rate-warning', '--server-log', join(d.scratch, 'log')])],
      ['check-args', ...d.args('dry-fake', ['--allow-rate-warning', '--server-log', join(d.scratch, 'log')])],
      ['init', ...d.args('dry-fake', ['--allow-rate-warning', '--allow-rate-warning'])],
    ]) {
      const res = await runProbe(LIVE_E2E, d.env, argv);
      expect(res.status, `${argv.join(' ')}: ${res.stderr}`).toBe(2);
      expect(existsSync(d.ledger), argv.join(' ')).toBe(false);
    }
  }, 120_000);

  it('live: init with the flag writes the approval into ledger-live-e2e (synthetic directories, no request)', async () => {
    const r = root('sp-init-live-');
    const w = join(r, 'w');
    const res = await runProbe(LIVE_E2E, { HOME: join(r, 'home'), XDG_DATA_HOME: undefined }, ['init', '--mode', 'live', '--base-url', 'http://127.0.0.1:4570', '--data', join(w, 'm2-live-e2e'), '--out', join(w, 'out'), '--ledger', join(w, 'ledger-live-e2e'), '--allow-rate-warning']);
    expect(res.status, res.stderr).toBe(0);
    expect(readRateWarningApproval(join(w, 'ledger-live-e2e'))?.reason).toMatch(/^RATE_WARNING_OK=1 \(live\)/);
  }, 60_000);
});

describe('live-runbook.sh RATE_WARNING_OK (결정 26)', () => {
  /** The runbook sandbox of liveE2eScript.test.ts: fake HOME, node stub that refuses the server entry, npm stub. */
  function sandbox() {
    const r = root('sp-runbook-warn-');
    const home = join(r, 'home');
    mkdirSync(join(home, '.local', 'share', 'study_paper'), { recursive: true });
    const scratch = join(r, 'scratch');
    mkdirSync(scratch);
    const stubs = join(r, 'stubs');
    mkdirSync(stubs);
    const marks = join(r, 'marks');
    writeFileSync(join(stubs, 'node'), `#!/bin/sh\nfor a in "$@"; do case "$a" in *apps/server/src/index.ts) echo "server $*" >> "${marks}"; exit 1;; esac; done\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(stubs, 'npm'), `#!/bin/sh\necho "npm $*" >> "${marks}"\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(stubs, 'claude'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    const env: Record<string, string | undefined> = { HOME: home, XDG_DATA_HOME: undefined, PATH: `${stubs}:${join(process.execPath, '..')}:/usr/bin:/bin`, MODE: undefined, DATA: undefined, OUT: undefined, LEDGER: undefined, SMOKE_DATA: undefined, SCRATCH_ROOT: undefined, FAKE_BIN: undefined, STUB_DIR: undefined, RESUME: undefined, RUN_ARGS: undefined, NET_MAX: undefined, SP_DATA_DIR: undefined, RATE_WARNING_OK: undefined, EVALUATE: undefined };
    const fake = (n: string, extra: Record<string, string> = {}) => ({ ...env, MODE: 'dry-fake', DATA: join(scratch, `data-${n}`), OUT: join(scratch, `out-${n}`), SCRATCH_ROOT: scratch, LEDGER: join(scratch, `ledger-dry-${n}`), FAKE_BIN: join(scratch, 'fake', 'claude'), STUB_DIR: join(scratch, 'stub'), ...extra });
    const readMarks = () => (existsSync(marks) ? readFileSync(marks, 'utf8') : '');
    return { scratch, env, fake, readMarks };
  }
  const lastLine = (s: string) => s.trim().split('\n').pop()!;

  it('dry-fake + RATE_WARNING_OK=1: init writes the approval; the last line says rate_warning_ok=1. Unset: no approval, rate_warning_ok=0', async () => {
    const s = sandbox();
    const on = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: s.fake('1', { RATE_WARNING_OK: '1' }), timeoutMs: 120_000 });
    expect(on.stdout).toMatch(/"rateWarningAllowed":true/);
    expect(readRateWarningApproval(join(s.scratch, 'ledger-dry-1'))).not.toBeNull();
    expect(lastLine(on.stderr)).toMatch(/^runbook: stage=server exit=1 .* post_check_exit=none rate_warning_ok=1$/);
    const off = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: s.fake('2'), timeoutMs: 120_000 });
    expect(existsSync(join(s.scratch, 'ledger-dry-2', 'caps.json'))).toBe(true);
    expect(existsSync(join(s.scratch, 'ledger-dry-2', 'ALLOW_RATE_WARNING'))).toBe(false);
    expect(lastLine(off.stderr)).toMatch(/ rate_warning_ok=0$/);
  }, 240_000);

  it('refused before anything is made (exit 2, no build, no server, no ledger): dry-mock + RATE_WARNING_OK=1, a value other than 0 / 1', async () => {
    const s = sandbox();
    const mock = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: { ...s.env, MODE: 'dry-mock', DATA: join(s.scratch, 'd'), OUT: join(s.scratch, 'o'), SCRATCH_ROOT: s.scratch, RATE_WARNING_OK: '1' } });
    expect(mock.status).toBe(2);
    expect(mock.stderr).toMatch(/RATE_WARNING_OK=1: live or dry-fake only/);
    expect(lastLine(mock.stderr)).toMatch(/ rate_warning_ok=0$/);
    const bad = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: s.fake('3', { RATE_WARNING_OK: 'yes' }) });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/RATE_WARNING_OK must be 0 or 1/);
    expect(existsSync(join(s.scratch, 'o'))).toBe(false);
    expect(existsSync(join(s.scratch, 'ledger-dry-3'))).toBe(false);
    expect(s.readMarks()).toBe('');
  }, 120_000);

  it('RESUME: RATE_WARNING_OK must equal the ledger approval (no init on resume) — a mismatch is exit 2 before the server', async () => {
    const s = sandbox();
    const ledger = join(s.scratch, 'ledger-dry-4');
    initLiveLedger(ledger, { total: LIVE_CAPS.total, perModel: { ...LIVE_CAPS.perModel } });
    mkdirSync(join(s.scratch, 'out-4'));
    const mismatch = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: s.fake('4', { RESUME: '1', RUN_ARGS: '--from O2', RATE_WARNING_OK: '1' }), timeoutMs: 120_000 });
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toMatch(/RESUME: RATE_WARNING_OK=1 but the ledger approval \(ALLOW_RATE_WARNING\) is 0/);
    expect(s.readMarks()).toBe('');
    writeFileSync(join(ledger, 'ALLOW_RATE_WARNING'), JSON.stringify(APPROVAL));
    const unsetOnApproved = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: s.fake('4', { RESUME: '1', RUN_ARGS: '--from O2' }), timeoutMs: 120_000 });
    expect(unsetOnApproved.status).toBe(2);
    expect(unsetOnApproved.stderr).toMatch(/RESUME: RATE_WARNING_OK=0 but the ledger approval \(ALLOW_RATE_WARNING\) is 1/);
    const same = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: s.fake('4', { RESUME: '1', RUN_ARGS: '--from O2', RATE_WARNING_OK: '1' }), timeoutMs: 120_000 });
    expect(same.stderr).not.toMatch(/RESUME: RATE_WARNING_OK/);
    expect(s.readMarks()).toMatch(/^server /); // went on to the server (the stub refuses it)
    expect(lastLine(same.stderr)).toMatch(/ rate_warning_ok=1$/);
  }, 240_000);

  it('not RESUME, a ledger that already carries the approval, RATE_WARNING_OK unset: exit 2 before OUT, build and init (nothing made); the same command with RATE_WARNING_OK=1 then goes on (INT-WARNOK-R1-04 a)', async () => {
    const s = sandbox();
    const ledger = join(s.scratch, 'ledger-dry-5');
    initLiveLedger(ledger, { total: LIVE_CAPS.total, perModel: { ...LIVE_CAPS.perModel } });
    writeFileSync(join(ledger, 'ALLOW_RATE_WARNING'), JSON.stringify(APPROVAL));
    const refused = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: s.fake('5'), timeoutMs: 120_000 });
    expect(refused.status, refused.stderr).toBe(2);
    expect(refused.stderr).toMatch(/RATE_WARNING_OK=0 but \S+ledger-dry-5 already carries the approval \(ALLOW_RATE_WARNING\)/);
    expect(refused.stderr).not.toMatch(/ledger refused/); // the runbook refused, not init (init never ran)
    expect(lastLine(refused.stderr)).toMatch(/^runbook: stage=check-args exit=2 .* rate_warning_ok=1$/);
    expect(existsSync(join(s.scratch, 'out-5'))).toBe(false);
    expect(s.readMarks()).toBe(''); // no npm run build, no server
    const again = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: s.fake('5', { RATE_WARNING_OK: '1' }), timeoutMs: 120_000 });
    expect(again.stderr).not.toMatch(/already carries the approval|test ! -e/);
    expect(existsSync(join(s.scratch, 'out-5'))).toBe(true);
    expect(s.readMarks()).toMatch(/^npm run build\nserver /); // went on to build and the server (the stub refuses it)
    expect(readRateWarningApproval(ledger)).toEqual(APPROVAL); // the first approval stays
    expect(lastLine(again.stderr)).toMatch(/^runbook: stage=server exit=1 .* rate_warning_ok=1$/);
  }, 240_000);

  it('a damaged approval file in the ledger: exit 2 at check-args whatever RATE_WARNING_OK or RESUME says — no OUT, no build, no server (INT-WARNOK-R2-02)', async () => {
    const s = sandbox();
    const ledger = join(s.scratch, 'ledger-dry-7');
    initLiveLedger(ledger, { total: LIVE_CAPS.total, perModel: { ...LIVE_CAPS.perModel } });
    writeFileSync(join(ledger, 'ALLOW_RATE_WARNING'), '{not json');
    expect(readRateWarningApproval(ledger)).toBeNull(); // damaged = present but not a valid approval
    for (const extra of [{}, { RATE_WARNING_OK: '1' }, { RATE_WARNING_OK: '0' }] as Record<string, string>[]) {
      const r = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: s.fake('7', extra), timeoutMs: 120_000 });
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/\S+ledger-dry-7 has a damaged approval \(ALLOW_RATE_WARNING\) — use a new ledger \(nothing made\)/);
      expect(r.stderr).not.toMatch(/ledger refused|init it with/); // the runbook refused, not init (init never ran)
      expect(lastLine(r.stderr)).toMatch(/^runbook: stage=check-args exit=2 .* rate_warning_ok=0$/);
      expect(existsSync(join(s.scratch, 'out-7'))).toBe(false);
      expect(s.readMarks()).toBe(''); // no npm run build, no server
    }
    mkdirSync(join(s.scratch, 'out-7'));
    const resume = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: s.fake('7', { RESUME: '1', RUN_ARGS: '--from O2' }), timeoutMs: 120_000 });
    expect(resume.status, resume.stderr).toBe(2);
    expect(resume.stderr).toMatch(/has a damaged approval \(ALLOW_RATE_WARNING\)/);
    expect(s.readMarks()).toBe('');
    expect(readFileSync(join(ledger, 'ALLOW_RATE_WARNING'), 'utf8')).toBe('{not json'); // left as it was
  }, 360_000);

  it('dry-mock with a leftover LEDGER that carries an approval: the last line says rate_warning_ok=0 (dry-mock has no ledger) (INT-WARNOK-R1-04 b)', async () => {
    const s = sandbox();
    const ledger = join(s.scratch, 'ledger-left');
    initLiveLedger(ledger, { total: LIVE_CAPS.total, perModel: { ...LIVE_CAPS.perModel } });
    writeFileSync(join(ledger, 'ALLOW_RATE_WARNING'), JSON.stringify(APPROVAL));
    const mock = await runCommand('/bin/bash', [RUNBOOK], { cwd: REPO_ROOT, env: { ...s.env, MODE: 'dry-mock', DATA: join(s.scratch, 'd6'), OUT: join(s.scratch, 'o6'), SCRATCH_ROOT: s.scratch, LEDGER: ledger }, timeoutMs: 120_000 });
    expect(s.readMarks()).toMatch(/server /); // got past check-args and the build to the server (the stub refuses it)
    expect(lastLine(mock.stderr)).toMatch(/^runbook: stage=server exit=1 .* rate_warning_ok=0$/);
  }, 120_000);

  it('the init line carries the flag only through INIT_ARGS, which only RATE_WARNING_OK=1 sets', () => {
    const src = readFileSync(RUNBOOK, 'utf8');
    expect(src).toMatch(/npx tsx scripts\/live-e2e\.ts init "\$\{ARGS\[@\]\}" "\$\{INIT_ARGS\[@\]\}"/);
    expect(src.match(/--allow-rate-warning/g)).toHaveLength(2); // the header line and the one assignment
    expect(src).toMatch(/if \[ "\$RWOK" = 1 \]; then INIT_ARGS=\(--allow-rate-warning\); fi/);
  });
});
