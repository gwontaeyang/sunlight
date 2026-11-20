// Live E2E plan and checks (BRIEF_INTEGRATION I9). Owner: supervisor.
// Pins the call plan and budget, nextAction per error code, the F1r branch, the server-environment check per mode,
// the argument rules, the eight pass conditions, the server-log reader and the import boundary of the live script.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LlmErrorCode, type ModelAlias } from '@study-paper/shared/contracts/tasks';
import type { Citation } from '@study-paper/shared/contracts/domain';
import { initLiveLedger, readLiveLedger } from '../../src/llm/liveLedger';
import { EQUATION_DEEP_HEADINGS } from '../../src/llm/headings';
import { REPO_ROOT } from '../helpers/proc';
import { fetchReferences, stripComments } from '../helpers/sourceScan';
import {
  afterCall,
  afterSkip,
  CALL_IDS,
  classifyErrorCode,
  decideNext,
  describeOutcome,
  EXTERNAL_HAIKU_CALLS,
  FASTLIO2_STATED_KEYS,
  IMMEDIATE_STOP_CODES,
  importInput,
  initialRunState,
  ledgerStopBeforeCall,
  LIVE_CALL_PLAN,
  LIVE_CAPS,
  LIVE_PAPERS,
  nextAction,
  plannedPerModel,
  RESERVE,
  SOFT_ERROR_CODES,
  STOP_ERROR_CODES,
  stepAfterCall,
  stepAtEnd,
  stepBeforeCall,
  type CallOutcome,
  type LedgerView,
  type PlannedCall,
  type RunState,
  type Selector,
} from '../../../../scripts/lib/liveE2ePlan';
import {
  callRecordFile,
  callRecordOf,
  CallRecordSchema,
  callsNotDone,
  captureFile,
  checkArgs,
  checkPathArg,
  checkFirstPaperImport,
  checkPlanSelections,
  checkPostCheckArgs,
  checkPreconditions,
  checkServerEnv,
  checkSmokeDataArg,
  cond1Notation,
  cond2EquationDeep,
  cond3Chips,
  cond4CapturePrefix,
  cond5TranslateNoPrefix,
  cond6DeepEffort,
  cond7Argv,
  cond8EarlierRuns,
  cond8Evaluate,
  cond8NoChildren,
  cond8OfVerdict,
  evaluateExitCode,
  evaluateStoppedReason,
  evaluateTarget,
  f1ResumeSource,
  f1ResumeVerdict,
  resolveF1Resume,
  type EquationDeepAttempt,
  execsFile,
  judgeArgv,
  liveE2eRunFile,
  LiveE2eResultSchema,
  parseEnviron,
  parseNetworkLog,
  parseProcStat,
  postCheckFile,
  postCheckVerdict,
  RECORD_KEYS,
  runExitCode,
  startedMarkerFile,
  STUB_CLAUDE,
  SYMBOL_TABLE_HEADING,
  isTableDelimiterRow,
  symbolTableRows,
  type CallRow,
  type LiveArgs,
  type PaperFacts,
  type RunMeta,
  type ServerFacts,
  type StartedMarker,
} from '../../../../scripts/lib/liveE2eChecks';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('call plan and budget', () => {
  it('the table: ids, order, task / model / effort / paper / path exactly as BRIEF_INTEGRATION I9', () => {
    const rows = LIVE_CALL_PLAN.map((c) => `${c.id} ${c.task} ${c.model} ${c.effort} ${c.paper} ${c.path}${c.conditional ? ' conditional' : ''}`);
    expect(rows).toEqual([
      'O1 explain_selection opus low kiss api',
      'O2 figure_area opus medium kiss screen',
      'O3 chat opus low kiss api',
      'O4 chat opus high kiss api',
      'O5 chat opus low kiss api',
      'O6 summary opus medium kiss api',
      'O7 glossary_define opus low kiss api',
      'O8 explain_selection opus low fastlio2 api',
      'O9 figure_area opus medium fastlio2 screen',
      'F1 equation_deep opus high fastlio2 api',
      'O10 chat opus high fastlio2 api',
      'F2 notation_card opus high fastlio2 api',
      'F3 equation_deep opus high kiss screen',
      'F4 assumptions_card opus high kiss api',
      'F1r equation_deep opus high fastlio2 api conditional',
      'S1 translate_selection sonnet low kiss api',
      'S2 translate_selection sonnet low kiss api',
      'S3 translate_selection sonnet low fastlio2 api',
    ]);
    expect(LIVE_CALL_PLAN.map((c) => c.id)).toEqual([...CALL_IDS]);
    expect(LIVE_CALL_PLAN.find((c) => c.id === 'F1')!.target).toEqual({ kind: 'equation_tab', eqNumber: '10' });
    expect(LIVE_CALL_PLAN.find((c) => c.id === 'O10')!.target).toMatchObject({ kind: 'followup', of: 'F1', deep: true });
    expect(LIVE_CALL_PLAN.filter((c) => c.path === 'screen').map((c) => [c.id, (c.target as { choice: string }).choice])).toEqual([
      ['O2', 'figure'],
      ['O9', 'figure'],
      ['F3', 'equation'],
    ]);
  });

  it('sums: haiku 3 (test:live) · opus 14 · fable 0 · sonnet 3 planned + reserve opus 4 · sonnet 1 = the caps, 25 in all', () => {
    expect(LIVE_CAPS).toEqual({ total: 25, perModel: { haiku: 3, opus: 18, fable: 0, sonnet: 4 } });
    expect(plannedPerModel()).toEqual({ haiku: EXTERNAL_HAIKU_CALLS, opus: 14, fable: 0, sonnet: 3 });
    expect(RESERVE).toEqual({ opus: 4, sonnet: 1 });
    const planned = plannedPerModel();
    for (const m of ['haiku', 'opus', 'fable', 'sonnet'] as const) expect(planned[m] + (RESERVE[m] ?? 0), m).toBe(LIVE_CAPS.perModel[m]);
    expect(Object.values(planned).reduce((s, n) => s + n, 0) + Object.values(RESERVE).reduce((s, n) => s + (n ?? 0), 0)).toBe(LIVE_CAPS.total);
  });

  it('selections and areas are positions only (no paper text in the plan)', () => {
    for (const c of LIVE_CALL_PLAN) {
      const t = c.target;
      if (t.kind === 'explain' || t.kind === 'translate') {
        expect(t.selection.page, c.id).toBeGreaterThanOrEqual(1);
        expect(t.selection.end, c.id).toBeGreaterThan(t.selection.start);
      }
      if (t.kind === 'capture') for (const v of [...t.area.from, ...t.area.to]) expect(v >= 0 && v <= 1, c.id).toBe(true);
    }
  });

  it('FASTLIO2_STATED_KEYS: exactly the six keys the coordinator confirmed (perturbation_side is a not-stated candidate)', () => {
    expect([...FASTLIO2_STATED_KEYS]).toEqual(['frame_notation', 'transform_direction', 'rotation_param', 'state_vector', 'gravity_sign', 'error_definition']);
    expect(FASTLIO2_STATED_KEYS).not.toContain('perturbation_side');
  });

  it('O2 captures Fig. 1 of KISS-ICP from y 0.207 (the figure top ≈ 0.2097 is not clipped, the author line ≈ 0.201 stays out)', () => {
    expect(LIVE_CALL_PLAN.find((c) => c.id === 'O2')!.target).toEqual({ kind: 'capture', choice: 'figure', area: { page: 1, from: [0.08, 0.207], to: [0.92, 0.525] } });
  });

  it('every selection carries the sha256 of its fixture text (64 hex), checked before the first call', () => {
    const sels = LIVE_CALL_PLAN.filter((c) => c.target.kind === 'explain' || c.target.kind === 'translate');
    expect(sels.map((c) => c.id)).toEqual(['O1', 'O8', 'S1', 'S2', 'S3']);
    for (const c of sels) expect((c.target as { selection: { sha256: string } }).selection.sha256, c.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('checkPlanSelections (range + sha256 of every selection, before the first call)', () => {
  const page = 'abcdefghij'.repeat(20); // synthetic page text (200 chars)
  const sha = (x: string) => createHash('sha256').update(x, 'utf8').digest('hex');
  const mk = (id: 'O1' | 'S1', start: number, end: number, sha256: string): PlannedCall => ({ ...LIVE_CALL_PLAN.find((c) => c.id === id)!, target: { kind: id === 'O1' ? 'explain' : 'translate', selection: { page: 1, start, end, sha256 } } });
  const text = (_k: string, p: number) => (p === 1 ? page : null);
  it('pass: inside the page and the hash of the stored text matches', () => {
    expect(checkPlanSelections([mk('O1', 10, 30, sha(page.slice(10, 30))), mk('S1', 0, 200, sha(page))], text)).toEqual([]);
  });
  it('fail: outside the page, an empty range, a text whose hash differs, a page without text — each names the call', () => {
    expect(checkPlanSelections([mk('O1', 190, 201, sha(page.slice(190)))], text).join()).toMatch(/O1: .*outside/);
    expect(checkPlanSelections([mk('O1', 30, 30, sha(''))], text).join()).toMatch(/O1: .*outside/);
    expect(checkPlanSelections([mk('S1', 10, 30, sha(page.slice(11, 31)))], text).join()).toMatch(/S1: .*sha256 differs/);
    expect(checkPlanSelections([{ ...mk('S1', 1, 2, sha('b')), target: { kind: 'translate', selection: { page: 9, start: 1, end: 2, sha256: sha('b') } } }], text).join()).toMatch(/S1: .*no stored text/);
  });
  it('the problems never carry the page text', () => {
    const p = checkPlanSelections([mk('S1', 10, 30, sha('x'))], text).join();
    expect(p).not.toContain(page.slice(10, 30));
  });
});

describe('ledgerStopBeforeCall (before every call: STOP / STOP_REQUESTED → the run stops, exit 3)', () => {
  it('stopped or stop requested → a reason; neither, or no ledger (dry-mock) → null', () => {
    expect(ledgerStopBeforeCall(null)).toBeNull();
    expect(ledgerStopBeforeCall({ stopped: null, stopRequested: null })).toBeNull();
    expect(ledgerStopBeforeCall({ stopped: 'rate_limit: allowed_warning', stopRequested: null })).toMatch(/STOP: rate_limit/);
    expect(ledgerStopBeforeCall({ stopped: null, stopRequested: 'rate_limit: allowed_warning' })).toMatch(/STOP_REQUESTED/);
  });
});

const ledger = (o: { used?: Partial<Record<ModelAlias | 'total', number>>; stopped?: boolean; stopRequested?: boolean; caps?: LedgerView['caps'] } = {}): LedgerView => {
  const used = o.used ?? {};
  const perModel: Record<string, number> = {};
  for (const m of ['haiku', 'opus', 'fable', 'sonnet'] as const) if (used[m] !== undefined) perModel[m] = used[m]!;
  return { caps: o.caps === undefined ? { total: 25, perModel: { ...LIVE_CAPS.perModel } } : o.caps, used: { total: used.total ?? Object.values(perModel).reduce((s, n) => s + n, 0), perModel }, stopped: o.stopped ? 'STOP' : null, stopRequested: o.stopRequested ? 'REQ' : null };
};
const O3 = { id: 'O3' as const, model: 'opus' as const };

describe('nextAction (the I9 table, per code)', () => {
  it('every LlmErrorCode is in exactly one row (soft · budget · stop · immediate)', () => {
    const rows = [...SOFT_ERROR_CODES, ...STOP_ERROR_CODES, ...IMMEDIATE_STOP_CODES, 'budget_exhausted'];
    expect([...rows].sort()).toEqual([...LlmErrorCode.options].sort());
    expect(new Set(rows).size).toBe(rows.length);
    for (const code of LlmErrorCode.options) {
      const cls = classifyErrorCode(code);
      const want = (SOFT_ERROR_CODES as readonly string[]).includes(code) ? 'soft' : (STOP_ERROR_CODES as readonly string[]).includes(code) ? 'stop' : (IMMEDIATE_STOP_CODES as readonly string[]).includes(code) ? 'immediate' : 'budget';
      expect(cls, code).toBe(want);
    }
  });

  it('per code after a successful O1: soft → next (counted), twice in a row → stop; stop / immediate codes → stop', () => {
    for (const code of LlmErrorCode.options) {
      if (code === 'budget_exhausted') continue;
      const v = nextAction(O3, { kind: 'run_error', code }, 0, ledger({ used: { haiku: 3, opus: 3 } }));
      if ((SOFT_ERROR_CODES as readonly string[]).includes(code)) {
        expect(v, code).toMatchObject({ action: 'next', consecutiveSoft: 1 });
        expect(nextAction(O3, { kind: 'run_error', code }, 1, null), code).toMatchObject({ action: 'stop' });
      } else expect(v, code).toMatchObject({ action: 'stop' });
    }
    expect(nextAction(O3, { kind: 'done' }, 1, null)).toEqual({ action: 'next', consecutiveSoft: 0, reason: 'run.done' });
  });

  it('HTTP 4xx/5xx, schema mismatch, client timeout, a stream without terminal, a client error → stop', () => {
    const outs: CallOutcome[] = [{ kind: 'http_error', status: 409, code: 'conflict' }, { kind: 'http_error', status: 500 }, { kind: 'schema_mismatch', detail: 'x' }, { kind: 'client_timeout' }, { kind: 'no_terminal' }, { kind: 'client_error', detail: 'menu did not open' }];
    for (const o of outs) expect(nextAction(O3, o, 0, ledger()), o.kind).toMatchObject({ action: 'stop' });
  });

  it('O1 (the first LLM call) not ending with run.done stops the run whatever the code', () => {
    const O1 = { id: 'O1' as const, model: 'opus' as const };
    for (const code of LlmErrorCode.options) expect(nextAction(O1, { kind: 'run_error', code }, 0, ledger({ used: { opus: 1 } })), code).toMatchObject({ action: 'stop' });
    expect(nextAction(O1, { kind: 'client_timeout' }, 0, null)).toMatchObject({ action: 'stop' });
    expect(nextAction(O1, { kind: 'done' }, 0, null)).toMatchObject({ action: 'next' });
  });

  it('budget_exhausted is told apart with the ledger: STOP / STOP_REQUESTED / total cap / no caps / no ledger → stop; the model cap → skip that model (soft count kept)', () => {
    const be: CallOutcome = { kind: 'run_error', code: 'budget_exhausted' };
    expect(nextAction(O3, be, 1, ledger({ stopped: true }))).toMatchObject({ action: 'stop' });
    expect(nextAction(O3, be, 1, ledger({ stopRequested: true }))).toMatchObject({ action: 'stop' });
    expect(nextAction(O3, be, 1, ledger({ used: { haiku: 3, opus: 18, fable: 0, sonnet: 4 } }))).toMatchObject({ action: 'stop' });
    expect(nextAction(O3, be, 1, ledger({ caps: null }))).toMatchObject({ action: 'stop' });
    expect(nextAction(O3, be, 1, null)).toMatchObject({ action: 'stop' });
    expect(nextAction({ id: 'F4', model: 'opus' }, be, 1, ledger({ used: { haiku: 3, opus: 18 } }))).toEqual({ action: 'skip_model', model: 'opus', consecutiveSoft: 1, reason: expect.stringContaining('opus cap') });
    // budget_exhausted that the ledger does not explain (neither cap reached, no STOP)
    expect(nextAction(O3, be, 0, ledger({ used: { haiku: 3, opus: 2 } }))).toMatchObject({ action: 'stop' });
  });
});

/**
 * Simulated run: every call spawns one child of its model on the ledger; `repairs` adds the SP-Blocks repair calls of
 * those ids (same model); `outcomes` overrides the end of a call; `f1Passes` decides condition 2 of F1.
 */
function simulate(o: { priorOpus?: number; repairs?: Partial<Record<string, number>>; outcomes?: Partial<Record<string, CallOutcome>>; f1Passes?: boolean; caps?: Partial<Record<ModelAlias, number>>; sel?: Selector; warnAfter?: string; rejectedAfter?: string; stopAtEnd?: boolean } = {}) {
  const caps = { total: 25, perModel: { ...LIVE_CAPS.perModel, ...o.caps } };
  const used: Record<string, number> = { haiku: 3, opus: o.priorOpus ?? 0 };
  // warnAfter: that call ends with run.done, but its CLI reported a rate_limit allowed_warning → watchLiveRun stops the
  // ledger (STOP_REQUESTED) without changing the run's state. rejectedAfter: the same with a rejected status (STOP and
  // STOP_REQUESTED, as watchLiveRun leaves them whatever the approval). stopAtEnd: the ledger stops after the last
  // executed call was judged (seen only by the check when the loop ends)
  let stopRequested: string | null = null;
  let stopped: string | null = null;
  const view = (): LedgerView => ({ caps, used: { total: Object.values(used).reduce((s, n) => s + n, 0), perModel: { ...used } }, stopped, stopRequested });
  let state: RunState = initialRunState();
  let exitCode: 3 | null = null;
  const trace: string[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const l = view();
    // the loop of live-e2e.ts run: the same stepBeforeCall / stepAfterCall (decideNext, then the ledger before the call)
    const d = stepBeforeCall(state, o.sel ?? {}, (l.caps!.perModel.opus ?? 0) - (l.used.perModel.opus ?? 0), l);
    if (d.kind === 'end') break;
    if (d.kind === 'stop') {
      trace.push(`${d.call.id}:ledger_stopped`);
      state = d.state;
      exitCode = d.exitCode;
      break;
    }
    if (d.kind === 'skip') {
      if (d.record !== 'not_selected') trace.push(`${d.call.id}:${d.record}`);
      state = afterSkip(state);
      continue;
    }
    const c: PlannedCall = d.call;
    let outcome: CallOutcome = o.outcomes?.[c.id] ?? { kind: 'done' };
    // the ledger: a call whose model is at its cap is refused (budget_exhausted, no spawn)
    if ((used[c.model] ?? 0) >= (caps.perModel[c.model] ?? 0)) outcome = { kind: 'run_error', code: 'budget_exhausted' };
    else {
      used[c.model] = (used[c.model] ?? 0) + 1;
      for (let r = 0; r < (o.repairs?.[c.id] ?? 0) && (used[c.model] ?? 0) < (caps.perModel[c.model] ?? 0); r++) used[c.model]! += 1;
    }
    if (o.warnAfter === c.id) stopRequested = 'rate_limit: allowed_warning';
    if (o.rejectedAfter === c.id) stopRequested = stopped = 'rate_limit: rejected';
    const v = nextAction(c, outcome, state.consecutiveSoft, view());
    trace.push(`${c.id}:${v.action}`);
    if (c.id === 'F1') state.f1Passed = o.f1Passes ?? false;
    const after = stepAfterCall(state, v);
    state = after.state;
    if (after.exitCode !== null) {
      exitCode = after.exitCode;
      break;
    }
  }
  // the loop ended without a stop (the plan's end, or only skips left): one more look at the ledger (stepAtEnd)
  if (exitCode === null) {
    if (o.stopAtEnd) stopRequested = 'rate_limit: rejected';
    const end = stepAtEnd(state, view());
    if (end.exitCode !== null) trace.push('end:ledger_stopped');
    state = end.state;
    exitCode = end.exitCode;
  }
  return { trace, used, state, exitCode };
}

describe('decideNext: the plan walk and F1r', () => {
  it('F1 fails, no SP-Blocks repair: F1r runs after F4 (opus 14 used, 4 left), then S1–S3; opus ends at 15', () => {
    const r = simulate({ f1Passes: false });
    expect(r.trace.slice(13, 18)).toEqual(['F4:next', 'F1r:next', 'S1:next', 'S2:next', 'S3:next']);
    expect(r.used).toEqual({ haiku: 3, opus: 15, sonnet: 3 });
  });

  it('F1 fails, one repair (F2): F1r still runs (opus 15 → 16)', () => {
    const r = simulate({ f1Passes: false, repairs: { F2: 1 } });
    expect(r.trace).toContain('F1r:next');
    expect(r.used.opus).toBe(16);
  });

  it('F1 fails, two prior Opus calls and two repairs (F2 and F4): no Opus left → F1r skipped_no_budget, the sonnet calls go on', () => {
    const r = simulate({ f1Passes: false, priorOpus: 2, repairs: { F2: 1, F4: 1 }, outcomes: { F2: { kind: 'run_error', code: 'parse_failed' } } });
    expect(r.trace).toContain('F1r:skipped_no_budget');
    expect(r.trace.slice(-3)).toEqual(['S1:next', 'S2:next', 'S3:next']);
    expect(r.used.opus).toBe(18);
  });

  it('three repairs leave one Opus for F1r on a fresh ledger; a prior O1 spends that slot on resume', () => {
    const repairs = { O7: 1, F2: 1, F4: 1 };
    const fresh = simulate({ f1Passes: false, repairs });
    const resumed = simulate({ f1Passes: false, repairs, priorOpus: 1 });
    expect(fresh.trace).toContain('F1r:next');
    expect(resumed.trace).toContain('F1r:skipped_no_budget');
    for (const run of [fresh, resumed]) expect(run.used).toEqual({ haiku: 3, opus: 18, sonnet: 3 });
  });

  it('F1 passes: no F1r (skipped_not_needed)', () => {
    const r = simulate({ f1Passes: true });
    expect(r.trace).toContain('F1r:skipped_not_needed');
    expect(r.used.opus).toBe(14);
  });

  it('a model-cap refusal (opus cap 13): that model is skipped, the other models go on (sonnet S1–S3 run)', () => {
    const r = simulate({ caps: { opus: 13 }, f1Passes: false });
    expect(r.trace).toContain('F4:skip_model');
    expect(r.trace).toContain('F1r:skipped_no_budget');
    expect(r.trace.slice(-3)).toEqual(['S1:next', 'S2:next', 'S3:next']);
    expect(r.state.stopped).toBeNull();
  });

  it('two soft failures in a row stop the run; a done in between resets the count', () => {
    const stop = simulate({ outcomes: { O6: { kind: 'run_error', code: 'total_timeout' }, O7: { kind: 'run_error', code: 'parse_failed' } } });
    expect(stop.trace.at(-1)).toBe('O7:stop');
    expect(stop.state.stopped).toMatch(/second soft failure/);
    const go = simulate({ outcomes: { O6: { kind: 'run_error', code: 'total_timeout' }, O8: { kind: 'run_error', code: 'parse_failed' } } });
    expect(go.state.stopped).toBeNull();
  });

  it('a done call whose CLI warned (ledger STOP_REQUESTED, run state unchanged): the run stops right after that call (M-M2-R4-1), the next call is not sent, exit 3', () => {
    const r = simulate({ warnAfter: 'O1' });
    expect(r.trace).toEqual(['O1:stop']);
    expect(r.exitCode).toBe(3);
    expect(r.used).toEqual({ haiku: 3, opus: 1 });
    expect(r.state.stopped).toMatch(/after call O1 \(STOP_REQUESTED: rate_limit: allowed_warning\)/);
    // after S2 (the case where condition 5 would otherwise see 2 translate rows): S3 not sent, still exit 3
    const late = simulate({ warnAfter: 'S2', f1Passes: true });
    expect(late.trace.slice(-2)).toEqual(['S1:next', 'S2:stop']);
    expect(late.exitCode).toBe(3);
    expect(simulate({ f1Passes: true }).exitCode).toBeNull();
  });

  // Codex r4 M-M2-R4-1: a STOP made by the LAST executed call has no next call whose pre-check would see it
  it('the last plan call S3 ends run.done but the ledger stopped (rejected): exit 3, the stop reason names S3 — not the end of a clean run', () => {
    const r = simulate({ rejectedAfter: 'S3', f1Passes: true });
    expect(r.trace.slice(-3)).toEqual(['S1:next', 'S2:next', 'S3:stop']);
    expect(r.exitCode).toBe(3);
    expect(r.state.stopped).toBe('the ledger is stopped after call S3 (STOP: rate_limit: rejected); its outcome run.done is not judged');
    // STOP_REQUESTED only (STOP not confirmed yet): the same
    const req = simulate({ warnAfter: 'S3', f1Passes: true });
    expect([req.trace.at(-1), req.exitCode]).toEqual(['S3:stop', 3]);
    expect(req.state.stopped).toMatch(/after call S3 \(STOP_REQUESTED: /);
  });

  it('--only O1 (the rest are not_selected skips): the stop made by O1 ends the run with exit 3', () => {
    const r = simulate({ sel: { only: 'O1' }, rejectedAfter: 'O1' });
    expect(r.trace).toEqual(['O1:stop']);
    expect(r.exitCode).toBe(3);
    expect(r.state.stopped).toMatch(/after call O1 \(STOP: rate_limit: rejected\)/);
  });

  it('a stop seen only when the loop ends (after the last call was judged, or behind skips): stepAtEnd → exit 3', () => {
    const r = simulate({ sel: { only: 'O1' }, stopAtEnd: true });
    expect(r.trace).toEqual(['O1:next', 'end:ledger_stopped']);
    expect(r.exitCode).toBe(3);
    expect(r.state.stopped).toBe('the ledger is stopped at the end of the run (STOP_REQUESTED: rate_limit: rejected); no call was left to send');
    const all = simulate({ f1Passes: true, stopAtEnd: true });
    expect([all.trace.at(-1), all.exitCode]).toEqual(['end:ledger_stopped', 3]);
    // control: a clean ledger at the end leaves the run to its verdict
    expect(simulate({ sel: { only: 'O1' } })).toMatchObject({ exitCode: null, state: { stopped: null } });
  });

  it('nextAction reads the ledger before the outcome: STOP / STOP_REQUESTED → stop for every outcome; a clean ledger or none (dry-mock) → the outcome decides', () => {
    const O1 = { id: 'O1' as const, model: 'opus' as const };
    const outs: CallOutcome[] = [{ kind: 'done' }, { kind: 'run_error', code: 'parse_failed' }, { kind: 'run_error', code: 'budget_exhausted' }, { kind: 'run_error', code: 'rate_limited' }, { kind: 'http_error', status: 500 }];
    for (const c of [O1, O3])
      for (const out of outs) {
        expect(nextAction(c, out, 0, ledger({ stopped: true })), `${c.id} ${out.kind}`).toEqual({ action: 'stop', reason: `the ledger is stopped after call ${c.id} (STOP: STOP); its outcome ${describeOutcome(out)} is not judged` });
        expect(nextAction(c, out, 0, ledger({ stopRequested: true })).reason, `${c.id} ${out.kind}`).toMatch(new RegExp(`^the ledger is stopped after call ${c.id} \\(STOP_REQUESTED: REQ\\)`));
      }
    // STOP wins over STOP_REQUESTED in the reason
    expect(nextAction(O3, { kind: 'done' }, 0, ledger({ stopped: true, stopRequested: true })).reason).toMatch(/\(STOP: STOP\)/);
    expect(nextAction(O3, { kind: 'done' }, 0, ledger())).toEqual({ action: 'next', consecutiveSoft: 0, reason: 'run.done' });
    expect(nextAction(O3, { kind: 'done' }, 0, null)).toEqual({ action: 'next', consecutiveSoft: 0, reason: 'run.done' });
  });

  it('stepAtEnd: a run already stopped keeps its reason (no second exit code); STOP / STOP_REQUESTED → exit 3; clean or no ledger → unchanged', () => {
    const s = { ...initialRunState(), pos: LIVE_CALL_PLAN.length };
    expect(stepAtEnd(s, null)).toEqual({ state: s, exitCode: null });
    expect(stepAtEnd(s, { stopped: null, stopRequested: null })).toEqual({ state: s, exitCode: null });
    expect(stepAtEnd(s, { stopped: 'rate_limit: rejected', stopRequested: 'rate_limit: rejected' })).toEqual({ state: { ...s, stopped: 'the ledger is stopped at the end of the run (STOP: rate_limit: rejected); no call was left to send' }, exitCode: 3 });
    expect(stepAtEnd(s, { stopped: null, stopRequested: 'x' }).exitCode).toBe(3);
    const done = { ...s, stopped: 'O7: second soft failure in a row' };
    expect(stepAtEnd(done, { stopped: 'x', stopRequested: null })).toEqual({ state: done, exitCode: null });
  });

  it('evaluateStoppedReason (evaluate): the stored stop reason is kept; none stored but the ledger stopped → a reason (exit 3, never a pass); clean or no ledger → null', () => {
    const pass = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, name: `c${id}`, result: 'pass' as const, evidence: {} }));
    expect(evaluateStoppedReason('stored', { stopped: 'rate_limit: rejected', stopRequested: null })).toBe('stored');
    expect(evaluateStoppedReason('stored', null)).toBe('stored');
    const found = evaluateStoppedReason(null, { stopped: 'rate_limit: rejected', stopRequested: 'rate_limit: rejected' });
    expect(found).toBe('the ledger is stopped (STOP: rate_limit: rejected); the run record had no stop reason');
    expect(evaluateExitCode(found, pass)).toBe(3);
    expect(evaluateStoppedReason(null, { stopped: null, stopRequested: 'x' })).toMatch(/STOP_REQUESTED: x/);
    expect(evaluateStoppedReason(null, { stopped: null, stopRequested: null })).toBeNull();
    expect(evaluateStoppedReason(null, null)).toBeNull();
    expect(evaluateExitCode(evaluateStoppedReason(null, null), pass)).toBe(0);
  });

  it('stepBeforeCall / stepAfterCall (the functions the run loop calls) give exit code 3 for a stop', () => {
    const ledger = (stopped: string | null, stopRequested: string | null) => ({ stopped, stopRequested });
    const s0 = initialRunState();
    expect(stepBeforeCall(s0, {}, 6, null)).toMatchObject({ kind: 'call', call: { id: 'O1' } });
    expect(stepBeforeCall(s0, {}, 6, ledger(null, null))).toMatchObject({ kind: 'call', call: { id: 'O1' } });
    const req = stepBeforeCall(s0, {}, 6, ledger(null, 'rate_limit: allowed_warning'));
    expect(req).toMatchObject({ kind: 'stop', call: { id: 'O1' }, exitCode: 3 });
    expect(req.kind === 'stop' && req.state.stopped).toMatch(/STOP_REQUESTED.*next call O1 not sent/);
    expect(stepBeforeCall(s0, {}, 6, ledger('rate_limited', null))).toMatchObject({ kind: 'stop', exitCode: 3 });
    // a skip or the end is decided before the ledger (no call to stop)
    expect(stepBeforeCall(s0, { only: 'O2' }, 6, ledger('x', null))).toMatchObject({ kind: 'skip', record: 'not_selected' });
    expect(stepBeforeCall({ ...s0, pos: LIVE_CALL_PLAN.length }, {}, 6, ledger('x', null))).toEqual({ kind: 'end' });
    const c = LIVE_CALL_PLAN[0]!;
    expect(stepAfterCall(s0, nextAction(c, { kind: 'done' }, 0, null))).toMatchObject({ exitCode: null, state: { pos: 1, stopped: null } });
    expect(stepAfterCall(s0, nextAction(c, { kind: 'run_error', code: 'rate_limited' }, 0, null))).toMatchObject({ exitCode: 3, state: { pos: 1, stopped: 'O1 (the first LLM call) did not end with run.done (run.error rate_limited)' } });
  });

  it('--only and --from select the calls; --only F1r always runs it', () => {
    expect(simulate({ sel: { only: 'O1' } }).trace).toEqual(['O1:next']);
    expect(simulate({ sel: { only: 'F1r' } }).trace).toEqual(['F1r:next']);
    expect(simulate({ sel: { from: 'S1' } }).trace).toEqual(['S1:next', 'S2:next', 'S3:next']);
    expect(simulate({ sel: { only: 'F1r' }, priorOpus: 18 }).trace).toEqual(['F1r:skipped_no_budget']);
    // A resume without F1's verdict uses the remaining Opus budget.
    expect(simulate({ sel: { from: 'F2' } }).trace).toContain('F1r:next');
  });
});

// ------------------------------------------------------------------------------------------------------------------

const HOME = '/home/u';
const ROOT = '/scratch/live-dry';
const FAKE = '/repo/apps/server/test/fixtures/fake-claude.mjs';
const argsOf = (mode: LiveArgs['mode'], command: LiveArgs['command'] = 'run', o: Partial<LiveArgs> = {}): LiveArgs =>
  mode === 'live'
    ? { mode, command, baseUrl: 'http://127.0.0.1:4570', data: '/w/m2-live-e2e', out: '/w/m2-int/scratch/live_e2e', ledger: '/w/ledger-live-e2e', serverLog: '/w/m2-int/scratch/live_e2e/server.log', ...o }
    : { mode, command, baseUrl: 'http://127.0.0.1:4570', data: `${ROOT}/live-dry-data-2`, out: `${ROOT}/out-2`, scratchRoot: ROOT, serverLog: `${ROOT}/out-2/server.log`, ...(mode === 'dry-fake' ? { ledger: `${ROOT}/ledger-dry-2` } : {}), ...o };
const wrapper = `#!/bin/sh\nexport FAKE_CLAUDE_SCENARIO=ok\nexec "/opt/node22/bin/node" "${FAKE}" "$@"\n`;
function factsOf(mode: LiveArgs['mode'], command: LiveArgs['command'] = 'run'): ServerFacts {
  const common = { SP_DATA_DIR: mode === 'live' ? '/w/m2-live-e2e' : `${ROOT}/live-dry-data-2`, SP_PORT: '4570', SP_CONFIG_PATH: '/w/none.json', HOME, PATH: '/usr/bin' };
  if (mode === 'live') return { pid: 10, alive: true, environ: { ...common, SP_ENV: 'prod', SP_LLM: 'cli', SP_LIVE_LEDGER: '/w/ledger-live-e2e', SP_NETWORK_MAX_REQUESTS: '12' }, configFileExists: false, claudeBin: null, pathFirst: null };
  if (mode === 'dry-mock') return { pid: 10, alive: true, environ: { ...common, SP_ENV: command === 'import' ? 'dev' : 'prod', SP_LLM: 'mock', SP_NETWORK: 'off', ...(command === 'import' ? { SP_ARXIV_OFFLINE_DIR: `${ROOT}/offline` } : {}) }, configFileExists: false, claudeBin: null, pathFirst: null };
  return {
    pid: 10,
    alive: true,
    environ: { ...common, SP_ENV: 'prod', SP_LLM: 'cli', SP_NETWORK: 'off', SP_LIVE_LEDGER: `${ROOT}/ledger-dry-2`, SP_CLAUDE_BIN: `${ROOT}/fake-2/claude`, PATH: `${ROOT}/stub:/usr/bin` },
    configFileExists: false,
    claudeBin: { realpath: `${ROOT}/fake-2/claude`, content: wrapper },
    pathFirst: { dir: `${ROOT}/stub`, realDir: `${ROOT}/stub`, claudeContent: STUB_CLAUDE },
  };
}
const withEnv = (f: ServerFacts, patch: Record<string, string | undefined>): ServerFacts => {
  const environ = { ...f.environ! };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete environ[k];
    else environ[k] = v;
  }
  return { ...f, environ };
};

describe('checkServerEnv (per mode, each cell pass / fail)', () => {
  it('4594 requires a dry mode and the same port in the server environment', () => {
    for (const mode of ['dry-mock', 'dry-fake', 'live'] as const) {
      const args = argsOf(mode, 'run', { baseUrl: 'http://127.0.0.1:4594' });
      const problems = checkArgs(args, HOME);
      const server = checkServerEnv(args, withEnv(factsOf(mode), { SP_PORT: '4594' }), FAKE);
      if (mode === 'live') {
        expect(problems.join()).toMatch(/4570/);
        expect(server.join()).toMatch(/SP_PORT/);
      } else {
        expect(problems).toEqual([]);
        expect(server).toEqual([]);
      }
      expect(checkServerEnv(args, factsOf(mode), FAKE).join()).toMatch(/must equal SP_PORT/);
    }
  });

  it('the good environment of each mode passes', () => {
    expect(checkServerEnv(argsOf('live'), factsOf('live'), FAKE)).toEqual([]);
    expect(checkServerEnv(argsOf('dry-mock', 'import'), factsOf('dry-mock', 'import'), FAKE)).toEqual([]);
    expect(checkServerEnv(argsOf('dry-mock', 'run'), factsOf('dry-mock', 'run'), FAKE)).toEqual([]);
    expect(checkServerEnv(argsOf('dry-fake'), factsOf('dry-fake'), FAKE)).toEqual([]);
  });

  it('dry-fake refusals: no SP_CLAUDE_BIN · wrapper outside the scratch root · wrapper exec of another file · no stub first on PATH · ledger mismatch · network on', () => {
    const f = factsOf('dry-fake');
    const a = argsOf('dry-fake');
    const refused = (x: ServerFacts) => expect(checkServerEnv(a, x, FAKE).length).toBeGreaterThan(0);
    refused(withEnv(f, { SP_CLAUDE_BIN: undefined }));
    refused({ ...f, claudeBin: { realpath: '/bin/true', content: '\u007fELF' } });
    refused({ ...f, claudeBin: { realpath: `${ROOT}/fake-2/claude`, content: wrapper.replace(FAKE, '/elsewhere/fake-claude.mjs') } });
    refused({ ...f, claudeBin: { realpath: `${ROOT}/fake-2/claude`, content: `#!/bin/sh\nexec claude "$@"\n` } });
    refused({ ...f, pathFirst: null });
    refused({ ...f, pathFirst: { dir: '/usr/bin', realDir: '/usr/bin', claudeContent: null } });
    refused({ ...f, pathFirst: { dir: `${ROOT}/stub`, realDir: `${ROOT}/stub`, claudeContent: '#!/bin/sh\nexec /usr/bin/claude "$@"\n' } });
    refused(withEnv(f, { SP_LIVE_LEDGER: `${ROOT}/ledger-dry-9` }));
    refused(withEnv(f, { SP_NETWORK: undefined }));
    refused(withEnv(f, { SP_ENV: 'dev' }));
  });

  it('dry-fake: each remaining cell has its own fail input (SP_LLM ≠ cli · relative SP_CLAUDE_BIN)', () => {
    const f = factsOf('dry-fake');
    const a = argsOf('dry-fake');
    expect(checkServerEnv(a, withEnv(f, { SP_LLM: 'mock' }), FAKE).join()).toMatch(/SP_LLM must be cli/);
    expect(checkServerEnv(a, withEnv(f, { SP_LLM: undefined }), FAKE).join()).toMatch(/SP_LLM must be cli/);
    expect(checkServerEnv(a, withEnv(f, { SP_CLAUDE_BIN: 'fake-2/claude' }), FAKE).join()).toMatch(/SP_CLAUDE_BIN must be an absolute path/);
    expect(checkServerEnv(a, withEnv(f, { SP_NETWORK: 'on' }), FAKE).join()).toMatch(/SP_NETWORK must be off/);
  });

  it('dry-mock: each cell has its own fail input (SP_LLM ≠ mock · SP_NETWORK ≠ off · SP_CLAUDE_BIN present · SP_LIVE_LEDGER present · run with SP_ENV ≠ prod)', () => {
    const f = factsOf('dry-mock');
    const a = argsOf('dry-mock');
    expect(checkServerEnv(a, withEnv(f, { SP_LLM: 'cli' }), FAKE).join()).toMatch(/SP_LLM must be mock/);
    expect(checkServerEnv(a, withEnv(f, { SP_NETWORK: undefined }), FAKE).join()).toMatch(/SP_NETWORK must be off/);
    expect(checkServerEnv(a, withEnv(f, { SP_NETWORK: 'on' }), FAKE).join()).toMatch(/SP_NETWORK must be off/);
    expect(checkServerEnv(a, withEnv(f, { SP_CLAUDE_BIN: `${ROOT}/fake-2/claude` }), FAKE).join()).toMatch(/SP_CLAUDE_BIN must be unset/);
    expect(checkServerEnv(a, withEnv(f, { SP_LIVE_LEDGER: `${ROOT}/ledger-dry-1` }), FAKE).join()).toMatch(/SP_LIVE_LEDGER must be unset/);
    expect(checkServerEnv(a, withEnv(f, { SP_ENV: 'dev' }), FAKE).join()).toMatch(/SP_ENV must be prod/);
    expect(checkServerEnv(a, withEnv(f, { SP_ENV: undefined }), FAKE).join()).toMatch(/SP_ENV must be prod/);
  });

  it('common: SP_DATA_DIR or SP_LIVE_LEDGER under the server HOME\'s ~/.local/share/study_paper* is refused even when it equals the argument', () => {
    const real = `${HOME}/.local/share/study_paper`;
    const m = factsOf('dry-mock');
    expect(checkServerEnv(argsOf('dry-mock', 'run', { data: real }), withEnv(m, { SP_DATA_DIR: real }), FAKE).join()).toMatch(/SP_DATA_DIR points into the real data directory/);
    const fk = factsOf('dry-fake');
    const ledgerReal = `${HOME}/.local/share/study_paper-x/ledger-dry-2`;
    expect(checkServerEnv(argsOf('dry-fake', 'run', { ledger: ledgerReal }), withEnv(fk, { SP_LIVE_LEDGER: ledgerReal }), FAKE).join()).toMatch(/SP_LIVE_LEDGER points into the real data directory/);
    // the same check without the real dir passes (the cell is what fails above)
    expect(checkServerEnv(argsOf('dry-fake', 'run', { ledger: `${ROOT}/ledger-dry-2` }), fk, FAKE)).toEqual([]);
  });

  it('live refusals: SP_CLAUDE_BIN present · SP_NETWORK=off · offline dir · FAKE_CLAUDE_* · network cap missing or > 12 · ledger mismatch · mock LLM', () => {
    const f = factsOf('live');
    const a = argsOf('live');
    for (const patch of [{ SP_CLAUDE_BIN: '/x/claude' }, { SP_NETWORK: 'off' }, { SP_ARXIV_OFFLINE_DIR: '/x' }, { FAKE_CLAUDE_SCENARIO: 'ok' }, { SP_NETWORK_MAX_REQUESTS: undefined }, { SP_NETWORK_MAX_REQUESTS: '13' }, { SP_NETWORK_MAX_REQUESTS: '1.5' }, { SP_LIVE_LEDGER: '/w/ledger-other' }, { SP_LLM: 'mock' }, { SP_ENV: 'dev' }]) {
      expect(checkServerEnv(a, withEnv(f, patch), FAKE).length, JSON.stringify(patch)).toBeGreaterThan(0);
    }
    expect(checkServerEnv(a, withEnv(f, { SP_NETWORK_MAX_REQUESTS: '0' }), FAKE)).toEqual([]); // a resumed run: no arXiv request needed
  });

  it('common refusals: the SP_CONFIG_PATH file exists or is unset · SP_E2E · other data dir · other port · no pid / dead pid', () => {
    const f = factsOf('dry-mock');
    const a = argsOf('dry-mock');
    expect(checkServerEnv(a, { ...f, configFileExists: true }, FAKE).join()).toMatch(/SP_CONFIG_PATH/);
    expect(checkServerEnv(a, { ...f, configFileExists: null }, FAKE).join()).toMatch(/SP_CONFIG_PATH/);
    expect(checkServerEnv(a, withEnv(f, { SP_E2E: '1' }), FAKE).join()).toMatch(/SP_E2E/);
    expect(checkServerEnv(a, withEnv(f, { SP_DATA_DIR: `${ROOT}/other` }), FAKE).join()).toMatch(/SP_DATA_DIR/);
    expect(checkServerEnv(a, withEnv(f, { SP_PORT: '4571' }), FAKE).join()).toMatch(/SP_PORT/);
    expect(checkServerEnv(a, { ...f, pid: null }, FAKE).join()).toMatch(/server.pid/);
    expect(checkServerEnv(a, { ...f, alive: false }, FAKE).join()).toMatch(/not running/);
    // dry-mock: a ledger or a claude bin on the server is refused; import needs dev + an offline dir under the root
    expect(checkServerEnv(a, withEnv(f, { SP_LIVE_LEDGER: `${ROOT}/ledger-dry-1` }), FAKE).length).toBeGreaterThan(0);
    expect(checkServerEnv(argsOf('dry-mock', 'import'), withEnv(factsOf('dry-mock', 'import'), { SP_ARXIV_OFFLINE_DIR: '/elsewhere' }), FAKE).length).toBeGreaterThan(0);
    expect(checkServerEnv(argsOf('dry-mock', 'import'), withEnv(factsOf('dry-mock', 'import'), { SP_ENV: 'prod' }), FAKE).length).toBeGreaterThan(0);
  });

  it('execsFile accepts only `export K=V` lines and one final exec of node + the fake + "$@"', () => {
    expect(execsFile(wrapper, FAKE)).toBe(true);
    expect(execsFile(`#!/bin/sh\nexport FAKE_CLAUDE_DELAY_MS=5000\nexport FAKE_CLAUDE_SCENARIO=ok\nexec "/n/bin/node" "${FAKE}" "$@"\n`, FAKE)).toBe(true);
    expect(execsFile(`#!/bin/sh\nclaude "$@"\nexec "/n/bin/node" "${FAKE}" "$@"\n`, FAKE)).toBe(false);
    expect(execsFile(`#!/bin/sh\nexec "/n/bin/node" "${FAKE}" "$@"\nexec claude\n`, FAKE)).toBe(false);
    expect(execsFile(`#!/bin/sh\nexport X=$(claude)\nexec "/n/bin/node" "${FAKE}" "$@"\n`, FAKE)).toBe(false);
    expect(execsFile(`#!/bin/sh\nexec "/n/bin/python" "${FAKE}" "$@"\n`, FAKE)).toBe(false);
  });
});

describe('checkArgs', () => {
  it('live: ledger / data basenames, no scratch root; dry: scratch root required, every path under it, never the live / B names; never the real data dir', () => {
    expect(checkArgs(argsOf('live'), HOME)).toEqual([]);
    expect(checkArgs(argsOf('live', 'run', { ledger: '/w/ledger-x' }), HOME).join()).toMatch(/ledger-live-e2e/);
    expect(checkArgs(argsOf('live', 'run', { data: '/w/data' }), HOME).join()).toMatch(/m2-live-e2e/);
    expect(checkArgs(argsOf('live', 'run', { scratchRoot: ROOT }), HOME).join()).toMatch(/scratch-root/);
    expect(checkArgs(argsOf('dry-fake'), HOME)).toEqual([]);
    expect(checkArgs(argsOf('dry-mock'), HOME)).toEqual([]);
    expect(checkArgs(argsOf('dry-fake', 'run', { scratchRoot: undefined }), HOME).join()).toMatch(/scratch-root/);
    expect(checkArgs(argsOf('dry-fake', 'run', { out: '/tmp/out' }), HOME).join()).toMatch(/under --scratch-root/);
    expect(checkArgs(argsOf('dry-fake', 'run', { ledger: `${ROOT}/ledger-live-e2e` }), HOME).length).toBeGreaterThan(0);
    expect(checkArgs(argsOf('dry-fake', 'run', { ledger: `${ROOT}/ledger-b` }), HOME).length).toBeGreaterThan(0);
    expect(checkArgs(argsOf('dry-fake', 'run', { data: `${ROOT}/m2-live-e2e` }), HOME).length).toBeGreaterThan(0);
    expect(checkArgs(argsOf('dry-mock', 'run', { ledger: `${ROOT}/ledger-dry-1` }), HOME).join()).toMatch(/no --ledger/);
    expect(checkArgs(argsOf('dry-fake', 'run', { data: `${HOME}/.local/share/study_paper`, scratchRoot: `${HOME}/.local/share` }), HOME).join()).toMatch(/real data directory/);
    expect(checkArgs(argsOf('live', 'run', { data: `${HOME}/.local/share/study_paper-pre-m2/m2-live-e2e` }), HOME).join()).toMatch(/real data directory/);
    expect(checkArgs(argsOf('dry-mock', 'run', { baseUrl: 'http://127.0.0.1:4310' }), HOME).join()).toMatch(/4570/);
    expect(checkArgs(argsOf('dry-mock', 'run', { only: 'X9' }), HOME).join()).toMatch(/call id/);
    expect(checkArgs(argsOf('dry-mock', 'run', { only: 'O1', from: 'O2' }), HOME).join()).toMatch(/exclusive/);
  });

  it('post-check --out: absolute, never the real data directory (not even looked at), an existing directory', () => {
    const looked: string[] = [];
    const isDir = (p: string) => {
      looked.push(p);
      return p === `${ROOT}/out-2`;
    };
    expect(checkPostCheckArgs(`${ROOT}/out-2`, HOME, isDir)).toEqual([]);
    expect(checkPostCheckArgs('out-2', HOME, isDir).join()).toMatch(/absolute/);
    expect(checkPostCheckArgs(`${HOME}/.local/share/study_paper`, HOME, isDir).join()).toMatch(/real data directory/);
    expect(checkPostCheckArgs(`${HOME}/.local/share/study_paper-pre-m2/out`, HOME, isDir).join()).toMatch(/real data directory/);
    expect(looked).toEqual([`${ROOT}/out-2`]); // the refused paths were never passed to isDir
    expect(checkPostCheckArgs(`${ROOT}/out-9`, HOME, isDir).join()).toMatch(/existing directory/);
    // the same path rules as every other command's path arguments
    expect(checkPathArg('--out', `${HOME}/.local/share/study_paper/x`, HOME)).toEqual(checkArgs(argsOf('dry-mock', 'run', { out: `${HOME}/.local/share/study_paper/x`, scratchRoot: `${HOME}/.local/share/study_paper` }), HOME).filter((p) => p.startsWith('--out ') && /real data/.test(p)));
  });

  it('a ledger with other caps is refused (init of an existing ledger)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-live-e2e-ledger-'));
    tmpDirs.push(dir);
    const ledgerDir = join(dir, 'ledger-dry-x');
    initLiveLedger(ledgerDir, { total: 25, perModel: { ...LIVE_CAPS.perModel } });
    expect(() => initLiveLedger(ledgerDir, { total: 25, perModel: { ...LIVE_CAPS.perModel } })).not.toThrow();
    expect(() => initLiveLedger(ledgerDir, { total: 24, perModel: { ...LIVE_CAPS.perModel } })).toThrow(/other caps/);
    const previousCaps = { total: 25, perModel: { haiku: 3, opus: 12, fable: 6, sonnet: 4 } };
    expect(() => initLiveLedger(ledgerDir, previousCaps)).toThrow(/other caps/);
    const oldLedger = join(dir, 'old-ledger');
    initLiveLedger(oldLedger, previousCaps);
    expect(() => readLiveLedger(oldLedger, LIVE_CAPS)).toThrow(/caps/);
    expect(readLiveLedger(ledgerDir).caps).toEqual(LIVE_CAPS);
  });
});

// ------------------------------------------------------------------------------------------------------------------

const q = (ordinal: number, quote: string, status: Citation['status'] = 'verbatim'): Citation => ({ ordinal, kind: 'quote', quote, status, score: 1 });
const eq = (ordinal: number, eqNumber: string, status: Citation['status'] = 'resolved'): Citation => ({ ordinal, kind: 'equation', eqNumber, status, score: 1 });
const row = (o: Partial<CallRow>): CallRow => ({ runId: 'r', task: 'chat', model: 'opus', effort: 'low', status: 'ok', errorCode: null, prefixFingerprint: null, cacheReadTokens: null, cacheCreationTokens: null, inputTokens: null, outputTokens: null, ttftMs: null, durationMs: null, parentRunId: null, rateLimitJson: null, acceptedAt: 0, ...o });
const EQ_DEEP_OK = '## 기호 표\n\n| 기호 | 뜻 |\n|---|---|\n| x | 상태 |\n\n## 단계별 유도\n<eq n="10"/> 에서 시작한다.\n\n## 쓰인 가정\n가정.\n\n## 확인 질문\n질문.';

describe('real data directory and path relations by real path (M-M2-R2-2 · INT-I10-04 (2))', () => {
  // a fake HOME with its real data directory; links made on disk in a mkdtemp root (nothing of the user's is created)
  const root = mkdtempSync(join(tmpdir(), 'sp-live-paths-'));
  tmpDirs.push(root);
  const home = join(root, 'home');
  const realData = join(home, '.local', 'share', 'study_paper');
  mkdirSync(realData, { recursive: true });
  const scratch = join(root, 'scratch');
  for (const d of ['data', 'out', 'ok', 'elsewhere']) mkdirSync(join(d === 'elsewhere' ? root : scratch, d), { recursive: true });
  symlinkSync(realData, join(scratch, 'direct')); // a direct link to the real data directory
  symlinkSync(join(home, '.local', 'share'), join(scratch, 'share')); // a parent link
  symlinkSync(join(home, '.local', 'share', 'study_paper-later'), join(scratch, 'later')); // target does not exist yet
  symlinkSync(join(scratch, 'out'), join(scratch, 'alias-out')); // an alias of --out
  symlinkSync(join(scratch, 'data'), join(scratch, 'alias-data')); // an alias of --data
  symlinkSync(join(root, 'elsewhere'), join(scratch, 'escape')); // leaves the scratch root
  const xdg = join(root, 'xdg');
  const accountProbe = join(userInfo().homedir, '.local', 'share', 'study_paper-fix4-probe-never-created', 'x'); // a name only

  it('checkPathArg: HOME changed · XDG_DATA_HOME · direct link · parent link · link to a target not made yet → refused; a plain scratch dir passes', () => {
    const table: [string, string, Record<string, string | undefined> | string, boolean][] = [
      ['HOME moved to the scratch: the account home still counts', accountProbe, home, true],
      ['$XDG_DATA_HOME/study_paper*', join(xdg, 'study_paper-x', 'd'), { HOME: home, XDG_DATA_HOME: xdg }, true],
      ['a direct link to the real data directory', join(scratch, 'direct'), home, true],
      ['under a link to its parent', join(scratch, 'share', 'study_paper', 'db'), home, true],
      ['a dangling link to a study_paper* name not made yet', join(scratch, 'later', 'd'), home, true],
      ['a plain scratch directory', join(scratch, 'ok'), home, false],
      ['a path that does not exist yet under the scratch', join(scratch, 'ok', 'new', 'deeper'), home, false],
    ];
    for (const [label, path, env, refused] of table) expect(checkPathArg('--data', path, env).some((p) => /real data directory/.test(p)), label).toBe(refused);
  });

  it('checkArgs: --data / --out / --ledger apart and under --scratch-root, as written and by real path', () => {
    const base = { mode: 'dry-fake' as const, command: 'run' as const, baseUrl: 'http://127.0.0.1:4570', scratchRoot: scratch, data: join(scratch, 'data'), out: join(scratch, 'out'), ledger: join(scratch, 'ledger-dry-1'), serverLog: join(scratch, 'out', 'server.log') };
    expect(checkArgs(base, home)).toEqual([]);
    const refusedBy = (patch: Partial<LiveArgs>, re: RegExp) => expect(checkArgs({ ...base, ...patch }, home).join('\n'), JSON.stringify(patch)).toMatch(re);
    refusedBy({ data: join(scratch, 'alias-out') }, /--data and --out must not contain each other/); // the data dir is --out by another name
    refusedBy({ out: join(scratch, 'alias-data', 'out-new') }, /--data and --out must not contain each other/); // not made yet, inside --data
    refusedBy({ ledger: join(scratch, 'data', 'ledger-dry-1') }, /--data and --ledger must not contain each other/);
    refusedBy({ data: join(scratch, 'out', 'data') }, /--data and --out/); // the other direction: --data inside --out
    refusedBy({ out: join(scratch, 'escape', 'out') }, /--out must be under --scratch-root/); // under the root by name only
    refusedBy({ data: join(scratch, 'direct') }, /--data points into the real data directory/);
    expect(checkArgs({ ...base, data: join(xdg, 'study_paper', 'd'), scratchRoot: root }, { HOME: home, XDG_DATA_HOME: xdg }).join()).toMatch(/--data points into the real data directory/);
    // live: SMOKE_DATA apart from --data and --ledger (OUT under SMOKE_DATA is the planned layout)
    const live = { mode: 'live' as const, data: join(scratch, 'ok', 'm2-live-e2e'), ledger: join(scratch, 'ok', 'ledger-live-e2e') };
    expect(checkSmokeDataArg(live, join(scratch, 'ok', 'm2-int'), home)).toEqual([]);
    expect(checkSmokeDataArg(live, join(scratch, 'ok', 'm2-live-e2e', 'smoke'), home).join()).toMatch(/--smoke-data and --data/);
    expect(checkSmokeDataArg(live, join(scratch, 'direct'), home).join()).toMatch(/real data directory/);
  });

  it('live: --ledger and --data share one parent directory by real path (INT-I10-07)', () => {
    const w = join(scratch, 'ok');
    symlinkSync(w, join(scratch, 'w-alias'));
    const live = (data: string, ledger: string): LiveArgs => ({ mode: 'live', command: 'run', baseUrl: 'http://127.0.0.1:4570', data, ledger, out: join(w, 'm2-int', 'scratch', 'live_e2e'), serverLog: join(w, 'm2-int', 'scratch', 'live_e2e', 'server.log') });
    const sameRoot = /--ledger and --data must be in the same directory/;
    expect(checkArgs(live(join(w, 'm2-live-e2e'), join(w, 'ledger-live-e2e')), home)).toEqual([]);
    expect(checkArgs(live(join(w, 'm2-live-e2e'), join(scratch, 'w-alias', 'ledger-live-e2e')), home)).toEqual([]); // the same directory by another name
    expect(checkArgs(live(join(w, 'm2-live-e2e'), join(scratch, 'out', 'ledger-live-e2e')), home).join()).toMatch(sameRoot);
    expect(checkArgs(live(join(w, 'again', 'm2-live-e2e'), join(w, 'ledger-live-e2e')), home).join()).toMatch(sameRoot);
  });

  it('post-check --out: a link into the real data directory is refused and never looked at', () => {
    const looked: string[] = [];
    const isDir = (p: string) => (looked.push(p), true);
    expect(checkPostCheckArgs(join(scratch, 'direct'), home, isDir).join()).toMatch(/real data directory/);
    expect(checkPostCheckArgs(join(scratch, 'share', 'study_paper-pre-m2', 'out'), home, isDir).join()).toMatch(/real data directory/);
    expect(looked).toEqual([]);
    expect(checkPostCheckArgs(join(scratch, 'out'), home, isDir)).toEqual([]);
  });

  it('checkServerEnv: SP_DATA_DIR by a link into the server HOME\'s (or XDG) real data directory is refused; SP_DATA_DIR = --data by real path', () => {
    const a: LiveArgs = { mode: 'dry-mock', command: 'run', baseUrl: 'http://127.0.0.1:4570', scratchRoot: scratch, data: join(scratch, 'direct'), out: join(scratch, 'out') };
    const f = withEnv(factsOf('dry-mock'), { SP_DATA_DIR: join(scratch, 'direct'), HOME: home });
    expect(checkServerEnv(a, f, FAKE).join()).toMatch(/SP_DATA_DIR points into the real data directory/);
    const fx = withEnv(factsOf('dry-mock'), { SP_DATA_DIR: join(xdg, 'study_paper', 'd'), HOME: home, XDG_DATA_HOME: xdg });
    expect(checkServerEnv({ ...a, data: join(xdg, 'study_paper', 'd') }, fx, FAKE).join()).toMatch(/SP_DATA_DIR points into the real data directory/);
    // a plain data directory passes; another name for it (an alias) is still not "equal to --data"
    const okFacts = withEnv(factsOf('dry-mock'), { SP_DATA_DIR: join(scratch, 'data'), HOME: home });
    const okArgs = { ...a, data: join(scratch, 'data') };
    expect(checkServerEnv(okArgs, okFacts, FAKE)).toEqual([]);
    expect(checkServerEnv(okArgs, withEnv(okFacts, { SP_DATA_DIR: join(scratch, 'alias-data') }), FAKE).join()).toMatch(/SP_DATA_DIR must equal --data/);
  });
});

describe('pass conditions (each with a pass and a fail input)', () => {
  const keys = ['frame_notation', 'transform_direction', 'rotation_param', 'quaternion_convention', 'perturbation_side', 'error_definition', 'state_vector', 'jacobian_convention', 'gravity_sign', 'time_notation', 'units'];
  it('1. notation card: 11 keys + label P ≥ 1; all N → fail; a key missing → fail; no card → not evaluated', () => {
    expect(cond1Notation(keys.map((key, i) => ({ key, label: i === 0 ? 'P' : 'N', badge: 'not_stated' }))).result).toBe('pass');
    expect(cond1Notation(keys.map((key) => ({ key, label: 'N', badge: 'not_stated' }))).result).toBe('fail');
    expect(cond1Notation(keys.slice(1).map((key) => ({ key, label: 'P', badge: 'grounded_quote' }))).result).toBe('fail');
    expect(cond1Notation(null).result).toBe('not_evaluated');
  });

  it('2. equation_deep: headings · <eq n="10"/> resolved · symbol rows; F1 or F1r passing is enough', () => {
    expect(symbolTableRows(EQ_DEEP_OK)).toBe(1);
    expect(symbolTableRows('## 기호 표\n\n| a | b |\n|---|---|\n\n## 단계별 유도')).toBe(0);
    expect(cond2EquationDeep([{ id: 'F1', text: EQ_DEEP_OK, citations: [eq(1, '10')] }], '10').result).toBe('pass');
    expect(cond2EquationDeep([{ id: 'F1', text: EQ_DEEP_OK, citations: [eq(1, '10', 'no_anchor')] }], '10').result).toBe('fail');
    expect(cond2EquationDeep([{ id: 'F1', text: EQ_DEEP_OK.replace('## 확인 질문', '## 기타'), citations: [eq(1, '10')] }], '10').result).toBe('fail');
    expect(cond2EquationDeep([{ id: 'F1', text: EQ_DEEP_OK, citations: null }], '10').result).toBe('fail');
    expect(cond2EquationDeep([{ id: 'F1', text: 'x', citations: [] }, { id: 'F1r', text: EQ_DEEP_OK, citations: [eq(1, '10')] }], '10').result).toBe('pass');
    expect(cond2EquationDeep([], '10').result).toBe('not_evaluated');
  });

  it('2. the symbol-table heading comes from B (EQUATION_DEEP_HEADINGS), and every GFM table form counts its rows', () => {
    expect(SYMBOL_TABLE_HEADING).toBe(EQUATION_DEEP_HEADINGS[0]);
    const h = `## ${EQUATION_DEEP_HEADINGS[0]}`;
    const after = '\n\n## 단계별 유도\n본문';
    // pass inputs: centred / short delimiters, no outer pipes, trailing closing hashes on the heading
    expect(symbolTableRows(`${h}\n\n| 기호 | 뜻 |\n|:-:|:-:|\n| x | 상태 |\n| R | 회전 |${after}`)).toBe(2);
    expect(symbolTableRows(`${h}\n\n| 기호 | 뜻 |\n|--|--|\n| x | 상태 |${after}`)).toBe(1);
    expect(symbolTableRows(`${h}\n\n기호 | 뜻\n--- | ---\nx | 상태${after}`)).toBe(1);
    expect(symbolTableRows(`${h} ##\n| 기호 | 뜻 |\n| :--- | ---: |\n| x | 상태 |`)).toBe(1);
    expect(symbolTableRows(`${h}\r\n\r\n| a | b |\r\n|---|---|\r\n| x | y |\r\n`)).toBe(1);
    // each pass input is a valid GFM delimiter row
    for (const d of ['|:-:|:-:|', '|--|--|', '--- | ---', '| :--- | ---: |', '|-|']) expect(isTableDelimiterRow(d), d).toBe(true);
    // fail inputs: no table, header only, a delimiter without a pipe (a thematic break), rows after a blank line,
    // a table under another heading only
    for (const d of ['---', '| a | b |', '|---|x|', '']) expect(isTableDelimiterRow(d), d).toBe(false);
    expect(symbolTableRows(`${h}\n\n표 없음.${after}`)).toBe(0);
    expect(symbolTableRows(`${h}\n\n| 기호 | 뜻 |\n|---|---|\n\n| x | 상태 |${after}`)).toBe(0);
    expect(symbolTableRows(`${h}\n\n기호\n---\nx${after}`)).toBe(0);
    expect(symbolTableRows(`## 단계별 유도\n\n| a | b |\n|---|---|\n| x | y |`)).toBe(0);
    // condition 2 with a table form the old separator rule missed
    const alt = EQ_DEEP_OK.replace('|---|---|', '|:-:|:-:|');
    expect(cond2EquationDeep([{ id: 'F1', text: alt, citations: [eq(1, '10')] }], '10').result).toBe('pass');
  });

  it('the live script does not copy the heading strings of B (no 기호 표 literal in scripts/)', () => {
    for (const f of ['scripts/live-e2e.ts', 'scripts/lib/liveE2eChecks.ts', 'scripts/lib/liveE2ePlan.ts']) {
      const code = stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
      for (const heading of EQUATION_DEEP_HEADINGS) expect(code, `${f}: ${heading}`).not.toContain(heading);
    }
  });

  it('3. chips: parsed = stored for every owner; a count or quote mismatch fails', () => {
    expect(cond3Chips([{ owner: 'm', parsed: [{ ordinal: 1, kind: 'quote', quote: 'a b' }], stored: [q(1, 'a b')] }], []).result).toBe('pass');
    expect(cond3Chips([{ owner: 'm', parsed: [{ ordinal: 1, kind: 'quote', quote: 'a b' }, { ordinal: 2, kind: 'equation', eqNumber: '3' }], stored: [q(1, 'a b')] }], []).result).toBe('fail');
    expect(cond3Chips([{ owner: 'm', parsed: [{ ordinal: 1, kind: 'quote', quote: 'a b' }], stored: [q(1, 'a c')] }], []).result).toBe('fail');
    expect(cond3Chips([], []).result).toBe('not_evaluated');
  });

  it('3. a done call whose stored answer is missing (O7 term not stored): not_evaluated with missingOwners, never a pass', () => {
    const ok = [{ owner: 'O1:message', parsed: [{ ordinal: 1, kind: 'quote' as const, quote: 'a b' }], stored: [q(1, 'a b')] }];
    const c = cond3Chips(ok, ['O7:term']);
    expect(c.result).toBe('not_evaluated');
    expect(c.evidence).toMatchObject({ owners: 1, unpaired: [], missingOwners: ['O7:term'] });
    expect(runExitCode([c])).toBe(1);
    // an unpaired owner still fails, whatever is missing
    expect(cond3Chips([{ owner: 'm', parsed: [{ ordinal: 1, kind: 'quote', quote: 'a b' }], stored: [] }], ['O7:term']).result).toBe('fail');
    expect(cond3Chips([], ['O7:term']).evidence).toMatchObject({ owners: 0, missingOwners: ['O7:term'] });
  });

  it('live_e2e.json calls carry termId and termStoreError of calls/O7.json (null for the other calls)', () => {
    const base = { id: 'O7', task: 'glossary_define', model: 'opus', effort: 'medium', path: 'api', outcome: 'run.done', decision: 'next: run.done', clientMs: 10, runId: 'r', repairs: 0, capture: null };
    const failed = callRecordOf({ ...base, termStoreError: 'HTTP 409' });
    expect(CallRecordSchema.parse(failed)).toMatchObject({ termId: null, termStoreError: 'HTTP 409' });
    expect(callRecordOf({ ...base, termId: 't1' })).toMatchObject({ termId: 't1', termStoreError: null });
    expect(callRecordOf({ ...base, id: 'O1', task: 'explain' })).toMatchObject({ termId: null, termStoreError: null });
    expect(Object.keys(CallRecordSchema.shape)).toEqual(expect.arrayContaining(['termId', 'termStoreError']));
  });

  it('4. O2 has the fingerprint of O1 and reads the cache', () => {
    expect(cond4CapturePrefix(row({ prefixFingerprint: 'fp' }), row({ prefixFingerprint: 'fp', cacheReadTokens: 10 })).result).toBe('pass');
    expect(cond4CapturePrefix(row({ prefixFingerprint: 'fp' }), row({ prefixFingerprint: 'fp2', cacheReadTokens: 10 })).result).toBe('fail');
    expect(cond4CapturePrefix(row({ prefixFingerprint: 'fp' }), row({ prefixFingerprint: 'fp', cacheReadTokens: 0 })).result).toBe('fail');
    expect(cond4CapturePrefix(row({ prefixFingerprint: null }), row({ prefixFingerprint: null, cacheReadTokens: 5 })).result).toBe('fail');
    expect(cond4CapturePrefix(null, row({})).result).toBe('not_evaluated');
  });

  it('5. translations have no fingerprint; 6. deep runs are high', () => {
    expect(cond5TranslateNoPrefix([row({}), row({}), row({})], 3).result).toBe('pass');
    expect(cond5TranslateNoPrefix([row({}), row({ prefixFingerprint: 'fp' }), row({})], 3).result).toBe('fail');
    expect(cond5TranslateNoPrefix([], 3).result).toBe('not_evaluated');
    // fewer translate runs than the plan selected (stopped after S2): not evaluated, never a pass
    expect(cond5TranslateNoPrefix([row({}), row({})], 3).result).toBe('not_evaluated');
    expect(cond5TranslateNoPrefix([row({})], 1).result).toBe('pass'); // --only S1
    expect(cond6DeepEffort([row({ effort: 'high' }), row({ effort: 'high' })], 2).result).toBe('pass');
    expect(cond6DeepEffort([row({ effort: 'high' }), row({ effort: 'low' })], 2).result).toBe('fail');
    expect(cond6DeepEffort([row({ effort: 'high' })], 2).result).toBe('not_evaluated');
  });

  it('7. argv: a selection, a question or a 200-char base64 run in a child argv fails; lengths only are kept', () => {
    const user = 'Our odometry estimation approach relies on point-to-point ICP';
    const clean = ['claude', '-p', '--model', 'opus', '--system-prompt', '고정된 시스템 프롬프트'].join('\0');
    expect(judgeArgv(clean, [user])).toEqual({ argvChars: clean.length, userTextHit: false, base64Hit: false });
    expect(judgeArgv(`${clean}\0${user}`, [user]).userTextHit).toBe(true);
    expect(judgeArgv(`${clean}\0${'QUJD'.repeat(50)}`, []).base64Hit).toBe(true);
    expect(cond7Argv([{ pid: 1, callId: 'O1', ...judgeArgv(clean, [user]) }]).result).toBe('pass');
    expect(cond7Argv([{ pid: 1, callId: 'O1', ...judgeArgv(`${clean}\0${'A'.repeat(200)}`, [user]) }]).result).toBe('fail');
    expect(cond7Argv([{ pid: 1, callId: 'O3', ...judgeArgv(`${clean}\0${user}`, [user]) }]).result).toBe('fail');
    expect(cond7Argv([]).result).toBe('not_evaluated');
  });

  it('8. after the stop no child is alive; run exit = 0 only when 1–7 pass', () => {
    expect(cond8NoChildren([{ pid: 1, alive: false }]).result).toBe('pass');
    expect(cond8NoChildren([{ pid: 1, alive: true }]).result).toBe('fail');
    expect(cond8NoChildren(null).result).toBe('not_evaluated');
    const pass = (id: number) => ({ id, name: '', result: 'pass' as const, evidence: {} });
    expect(runExitCode([1, 2, 3, 4, 5, 6, 7].map(pass).concat([{ id: 8, name: '', result: 'not_evaluated' as never, evidence: {} }]))).toBe(0);
    expect(runExitCode([...[1, 2, 3, 4, 5, 6].map(pass), { id: 7, name: '', result: 'not_evaluated', evidence: {} }])).toBe(1);
  });

  it('preconditions: both v2 + latexml, FAST-LIO2 numbered equations exactly 1…19', () => {
    const ok: PaperFacts = { found: true, arxivVersion: 2, supplementVersion: 2, structureSource: 'latexml', numberedEquations: ['1', '2'] };
    const fast: PaperFacts = { found: true, arxivVersion: 1, supplementVersion: 2, structureSource: 'latexml', numberedEquations: Array.from({ length: 19 }, (_, i) => String(i + 1)) };
    expect(checkPreconditions({ kiss: ok, fastlio2: fast }).ok).toBe(true);
    expect(checkPreconditions({ kiss: { ...ok, supplementVersion: 1 }, fastlio2: fast }).ok).toBe(false);
    expect(checkPreconditions({ kiss: ok, fastlio2: { ...fast, structureSource: 'none' } }).ok).toBe(false);
    expect(checkPreconditions({ kiss: ok, fastlio2: { ...fast, numberedEquations: fast.numberedEquations.slice(1) } }).ok).toBe(false);
    expect(checkPreconditions({ kiss: ok, fastlio2: { ...fast, numberedEquations: [...fast.numberedEquations, '20'] } }).ok).toBe(false);
    expect(checkPreconditions({ kiss: { ...ok, found: false }, fastlio2: fast }).ok).toBe(false);
  });

  it('import asks for the planned version (<id>v<N>) and the preconditions check it (INT-I10-03)', () => {
    expect(importInput('kiss')).toBe(`${LIVE_PAPERS.kiss.arxivId}v2`);
    expect(importInput('fastlio2')).toBe(`${LIVE_PAPERS.fastlio2.arxivId}v1`);
    const ok: PaperFacts = { found: true, arxivVersion: 2, supplementVersion: 2, structureSource: 'latexml', numberedEquations: ['1'] };
    const fast: PaperFacts = { found: true, arxivVersion: 1, supplementVersion: 2, structureSource: 'latexml', numberedEquations: Array.from({ length: 19 }, (_, i) => String(i + 1)) };
    expect(checkPreconditions({ kiss: { ...ok, arxivVersion: 3 }, fastlio2: fast }).problems.join()).toMatch(/kiss: arxivVersion 3 \(must be 2/);
    expect(checkPreconditions({ kiss: ok, fastlio2: { ...fast, arxivVersion: 2 } }).problems.join()).toMatch(/fastlio2: arxivVersion 2 \(must be 1/);
    // the script sends importInput, never the bare id
    const src = stripComments(readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8'));
    expect(src).toMatch(/'papers\.import', \{ body: \{ input: importInput\(key\)/);
    expect(src).not.toMatch(/input: paper\.arxivId/);
  });

  it('the first paper gates the second: job.done + its own preconditions + ≤ 6 arXiv requests, else FAST-LIO2 is not requested (exit 2)', () => {
    const ok: PaperFacts = { found: true, arxivVersion: 2, supplementVersion: 2, structureSource: 'latexml', numberedEquations: [] };
    expect(checkFirstPaperImport('job.done', ok, 6)).toEqual([]);
    expect(checkFirstPaperImport('job.error', ok, 3).join()).toMatch(/ended with job\.error/);
    expect(checkFirstPaperImport(null, ok, 3).join()).toMatch(/no terminal event/);
    expect(checkFirstPaperImport('job.done', { ...ok, arxivVersion: 1 }, 3).join()).toMatch(/arxivVersion 1/); // a v1 index
    expect(checkFirstPaperImport('job.done', { ...ok, supplementVersion: 1 }, 3).join()).toMatch(/supplementVersion/);
    expect(checkFirstPaperImport('job.done', { ...ok, found: false }, 3).join()).toMatch(/not imported/);
    expect(checkFirstPaperImport('job.done', ok, 7).join()).toMatch(/7 arXiv requests/);
    // already imported by an earlier import of the same data (existing: true, no job → no terminal): its preconditions
    // and the request count decide, the missing terminal does not (FIX4-R1-02); a job that ran still needs job.done
    expect(checkFirstPaperImport(null, ok, 0, true)).toEqual([]);
    expect(checkFirstPaperImport(null, { ...ok, structureSource: 'pdf' }, 0, true).join()).toMatch(/structureSource pdf/);
    expect(checkFirstPaperImport(null, { ...ok, arxivVersion: 1 }, 0, true).join()).toMatch(/arxivVersion 1/);
    expect(checkFirstPaperImport('job.error', ok, 3, true).join()).toMatch(/ended with job\.error/);
    // wired before the second paper, and the plan selections are checked at the end of import (before test:live)
    const src = stripComments(readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8'));
    const imp = src.slice(src.indexOf('async function cmdImport'), src.indexOf('async function cmdRun'));
    expect(imp.length).toBeGreaterThan(0);
    expect(imp).toMatch(/if \(key === 'kiss'\) \{\s*const first = checkFirstPaperImport\(/);
    expect(imp).toMatch(/checkFirstPaperImport\([^;]*, r\.existing && r\.jobId === null\);/);
    expect(imp).toMatch(/checkPlanSelections\(LIVE_CALL_PLAN/);
  });
});

describe('post-check verdict from the run records (M-M2-R2-6 · INT-I10-02)', () => {
  const meta = (o: Partial<RunMeta> = {}): RunMeta => ({ run: 2, mode: 'dry-fake', startedAt: 1, data: '/d', serverPid: 10, selector: { from: null, only: null }, callsStarted: 1, endedAt: 9, ...o });
  const marker = (id: string, run = 2): StartedMarker => ({ id, run, requestId: 'r', startedAt: 2 });

  it('a run killed during its first call (marker, no record, no end) → unverified, never "no call"', () => {
    const v = postCheckVerdict(meta({ endedAt: undefined }), [marker('O1')], new Set(), [], []);
    expect(v.result).toBe('unverified');
    expect(v.reason).toMatch(/child state unverified/);
    expect(postCheckVerdict(meta({ endedAt: undefined, callsStarted: 0 }), [], new Set(), [], []).result).toBe('unverified'); // killed before a marker: still not "no call"
  });

  it('a started marker without its finished record → unverified; an earlier run\'s marker is not this run\'s', () => {
    expect(postCheckVerdict(meta({ callsStarted: 2 }), [marker('O1'), marker('O2')], new Set(['O1']), [], []).unfinished).toEqual(['O2']);
    expect(postCheckVerdict(meta({ callsStarted: 2 }), [marker('O1'), marker('O2')], new Set(['O1']), [], []).result).toBe('unverified');
    expect(postCheckVerdict(meta(), [marker('O1'), marker('O3', 1)], new Set(['O1']), [], []).result).toBe('pass');
  });

  it('"no call" only on the explicit pre-call refusal; no run record at all → unverified', () => {
    expect(postCheckVerdict(meta({ callsStarted: 0, refusedBeforeCall: 'preconditions failed' }), [], new Set(), [], []).result).toBe('no_call');
    expect(postCheckVerdict(null, [], new Set(), [], []).result).toBe('unverified');
  });

  it('a child alive (recorded) or a process left in <data>/claude-cwd (records or not) → fail', () => {
    expect(postCheckVerdict(meta(), [marker('O1')], new Set(['O1']), [{ pid: 5, alive: true }], []).result).toBe('fail');
    expect(postCheckVerdict(meta({ callsStarted: 0, refusedBeforeCall: 'x' }), [], new Set(), [], [77]).result).toBe('fail');
    expect(postCheckVerdict(null, [], new Set(), [], [77]).result).toBe('fail');
    expect(postCheckVerdict(meta(), [marker('O1')], new Set(['O1']), [{ pid: 5, alive: false }], []).result).toBe('pass');
  });

  it('condition 8 from the verdict: pass / fail as they are, no call and unverified are not_evaluated (never a pass)', () => {
    const v = (m: RunMeta | null, alive = false) => postCheckVerdict(m, [], new Set(), alive ? [{ pid: 1, alive: true }] : [], []);
    expect(cond8OfVerdict(v(meta()), 0).result).toBe('pass');
    expect(cond8OfVerdict(v(meta(), true), 1).result).toBe('fail');
    expect(cond8OfVerdict(v(null), 0).result).toBe('not_evaluated');
    expect(cond8OfVerdict(v(meta({ callsStarted: 0, refusedBeforeCall: 'x' })), 0).result).toBe('not_evaluated');
  });

  it('record file names: <id>.json and <id>.started.json of plan ids only (not an earlier run\'s kept copies)', () => {
    expect(['O1.json', 'F1r.json', 'O1.started.json', 'O1.r1.json', 'O1.started.r1.json', 'X.json', 'children.json'].map(callRecordFile)).toEqual(['O1', 'F1r', null, null, null, null, null]);
    expect(['O1.started.json', 'S3.started.json', 'O1.json', 'O1.started.r1.json', 'Z.started.json'].map(startedMarkerFile)).toEqual(['O1', 'S3', null, null, null]);
  });
});

describe('conditions 7 and 8 over every run of --out (INT-I10-01)', () => {
  const pass = (id: number) => ({ id, name: '', result: 'pass' as const, evidence: {} });
  const meta = (run: number, o: Partial<RunMeta> = {}): RunMeta => ({ run, mode: 'dry-fake', startedAt: run, data: '/d', serverPid: 10, selector: { from: null, only: null }, callsStarted: 3, endedAt: run + 1, ...o });

  it('a resume after a failed first run keeps the failure: run 1 post-check fail or unverified → condition 8 fail → exit 1', () => {
    for (const first of ['fail', 'unverified'] as const) {
      const c8 = cond8EarlierRuns(2, [meta(1), meta(2)], new Map([[1, first]]));
      expect(c8.result, first).toBe('fail');
      expect(c8.evidence.blocking).toEqual([{ run: 1, verdict: first }]);
      expect(runExitCode([...[1, 2, 3, 4, 5, 6, 7].map(pass), c8]), first).toBe(1);
    }
  });

  it('an earlier run that started calls but has no post-check blocks too; one that explicitly made no call does not', () => {
    expect(cond8EarlierRuns(2, [meta(1), meta(2)], new Map()).result).toBe('fail');
    expect(cond8EarlierRuns(2, [meta(1, { callsStarted: 0, refusedBeforeCall: 'preconditions' }), meta(2)], new Map()).result).toBe('not_evaluated');
  });

  it('earlier runs that passed (or made no call): condition 8 stays for post-check of this run, exit 0 when 1–7 pass', () => {
    const c8 = cond8EarlierRuns(3, [meta(1), meta(2), meta(3)], new Map<number, 'pass' | 'no_call'>([[1, 'pass'], [2, 'no_call']]));
    expect(c8.result).toBe('not_evaluated');
    expect(runExitCode([...[1, 2, 3, 4, 5, 6, 7].map(pass), c8])).toBe(0);
    expect(cond8EarlierRuns(1, [meta(1)], new Map()).result).toBe('not_evaluated'); // the first run: nothing earlier
  });

  it('condition 7 over the samples of every run: a hit in run 1 fails the final judgement after a clean run 2', () => {
    const clean = { argvChars: 10, userTextHit: false, base64Hit: false };
    const c7 = cond7Argv([{ run: 1, pid: 5, callId: 'O1', ...clean, userTextHit: true }, { run: 2, pid: 9, callId: 'O2', ...clean }]);
    expect(c7.result).toBe('fail');
    expect(c7.evidence).toMatchObject({ runs: [1, 2], hits: [{ run: 1, callId: 'O1', userTextHit: true }] });
    expect(cond7Argv([{ run: 1, pid: 5, callId: 'O1', ...clean }, { run: 2, pid: 5, callId: 'O2', ...clean }]).evidence).toMatchObject({ children: 2 }); // pid reused across runs = 2 children
  });

  it('callsNotDone: the planned calls without run.done — soft failures, skips and missing records; F1r only when it was needed (INT-I10-05)', () => {
    const done = (id: string) => ({ id, outcome: 'run.done' });
    const all = LIVE_CALL_PLAN.filter((c) => !c.conditional).map((c) => done(c.id));
    expect(callsNotDone(LIVE_CALL_PLAN, [...all, { id: 'F1r', skipped: 'skipped_not_needed' }])).toEqual([]);
    expect(callsNotDone(LIVE_CALL_PLAN, all)).toEqual([]); // F1r without a record: not needed by this --out
    const withFailures = all.map((r) => (r.id === 'O3' ? { id: 'O3', outcome: 'run.error total_timeout' } : r.id === 'F4' ? { id: 'F4', outcome: 'run.error parse_failed' } : r)).filter((r) => r.id !== 'S3');
    expect(callsNotDone(LIVE_CALL_PLAN, [...withFailures, { id: 'S3', skipped: 'skipped_model_cap' }])).toEqual(['O3', 'F4', 'S3']);
    expect(callsNotDone(LIVE_CALL_PLAN, all.filter((r) => r.id !== 'O7'))).toEqual(['O7']);
    expect(callsNotDone(LIVE_CALL_PLAN, [...all, { id: 'F1r', outcome: 'run.error parse_failed' }])).toEqual(['F1r']);
    expect(callsNotDone(LIVE_CALL_PLAN, [...all, { id: 'F1r', skipped: 'skipped_no_budget' }])).toEqual(['F1r']);
    // live_e2e.json carries it at the top level (the schema refuses a result without it)
    expect(Object.keys(LiveE2eResultSchema.shape)).toContain('callsNotDone');
    expect(LiveE2eResultSchema.shape.callsNotDone.safeParse(undefined).success).toBe(false);
  });

  it('a run without a readable record blocks: a gap or torn run.<k>.json, and post_check.0.json (FIX4-R1-03)', () => {
    const one = [1, 2, 3, 4, 5, 6, 7].map(pass);
    // run 2 torn by a kill (its run.2.json unreadable → not in metas): the resume (run 3) does not forget it
    const gap = cond8EarlierRuns(3, [meta(1), meta(3)], new Map([[1, 'pass']]));
    expect(gap.result).toBe('fail');
    expect(gap.evidence.blocking).toEqual([{ run: 2, verdict: 'no run record' }]);
    expect(runExitCode([...one, gap])).toBe(1);
    // post-check that found no run record at all (post_check.0.json)
    const zero = cond8EarlierRuns(2, [meta(1), meta(2)], new Map([[0, 'unverified'], [1, 'pass']]));
    expect(zero.result).toBe('fail');
    expect(zero.evidence.blocking).toEqual([{ run: 0, verdict: 'unverified' }]);
    // evaluate: a later torn run file (index known from the listing) and a gap block too
    expect(cond8Evaluate(1, [meta(1)], new Map([[1, 'pass']]), [1, 2]).result).toBe('fail');
    expect(cond8Evaluate(3, [meta(1), meta(3)], new Map([[1, 'pass'], [3, 'pass']]), [1, 3]).result).toBe('fail');
    expect(cond8Evaluate(2, [meta(1), meta(2)], new Map([[1, 'pass'], [2, 'pass']]), [1, 2]).result).toBe('pass');
    // records replace the old one by rename (never truncated in place); run.<n>.json and per-run files appear whole
    const src = stripComments(readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8'));
    const wj = src.slice(src.indexOf('function writeJson('), src.indexOf('function writeExclusive('));
    expect(wj).toMatch(/writeFileSync\(tmp, [^;]*\);\s*renameSync\(tmp, file\);/);
    expect(wj).toMatch(/linkSync\(tmp, file\);/);
    const claim = src.slice(src.indexOf('function claimRunMeta('), src.indexOf('function runFileIndices('));
    expect(claim).toMatch(/writeJsonExclusive\(join\(out, `run\.\$\{n\}\.json`\), m\)/);
    expect(claim).not.toMatch(/flag: 'wx'/);
    expect(src).not.toMatch(/const writeJson = /);
  });

  it('evaluate includes run n\'s own post-check: fail / unverified / none → condition 8 fail → exit 1; pass → 0 (FIX4-R1-01)', () => {
    const one = [1, 2, 3, 4, 5, 6, 7].map(pass);
    // the case evaluate exists for: the run died after its last record, post-check said unverified
    for (const own of ['fail', 'unverified'] as const) {
      const c8 = cond8Evaluate(1, [meta(1)], new Map([[1, own]]));
      expect(c8.result, own).toBe('fail');
      expect(c8.evidence).toMatchObject({ run: 1, postCheck: own, blocking: [{ run: 1, verdict: own }] });
      expect(runExitCode([...one, c8]), own).toBe(1);
    }
    const none = cond8Evaluate(1, [meta(1)], new Map());
    expect(none.result).toBe('fail'); // started calls, no post-check of its own
    expect(none.evidence).toMatchObject({ postCheck: 'no post-check' });
    expect(runExitCode([...one, none])).toBe(1);
    const ok = cond8Evaluate(2, [meta(1), meta(2)], new Map([[1, 'pass'], [2, 'pass']]));
    expect(ok.result).toBe('pass');
    expect(runExitCode([...one, ok])).toBe(0);
    // other runs still block, earlier and later (a later resume killed before its first call)
    expect(cond8Evaluate(2, [meta(1), meta(2)], new Map([[1, 'unverified'], [2, 'pass']])).result).toBe('fail');
    expect(cond8Evaluate(2, [meta(1), meta(2), meta(3, { callsStarted: 0, endedAt: undefined })], new Map([[1, 'pass'], [2, 'pass'], [3, 'unverified']])).result).toBe('fail');
    expect(cond8Evaluate(2, [meta(1), meta(2), meta(3, { callsStarted: 0, refusedBeforeCall: 'x' })], new Map([[1, 'pass'], [2, 'pass']])).result).toBe('pass');
    // run keeps cond8EarlierRuns (its own post-check comes after it); evaluate uses cond8Evaluate
    const src = stripComments(readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8'));
    expect(src).toMatch(/x\.judge === 'evaluate' \? cond8Evaluate\(x\.run, runMetas\(a\.out\), postCheckResults\(a\.out\), runFileIndices\(a\.out\)\) : cond8EarlierRuns\(/);
    const ev = src.slice(src.indexOf('async function cmdEvaluate'), src.indexOf('async function equationAttempt'));
    expect(ev).toMatch(/evaluate\(api, a, \{ judge: 'evaluate',/);
    const run = src.slice(src.indexOf('async function runInvocation'), src.indexOf('function finishResult'));
    expect(run).toMatch(/evaluate\(api, a, \{ judge: 'run',/);
  });

  it('evaluate judges the last run that started a call, not a later resume refused before its first call (FIX4-R1-06)', () => {
    const refused = meta(3, { callsStarted: 0, refusedBeforeCall: 'the ledger is stopped', selector: { from: null, only: 'O7' } });
    expect(evaluateTarget([meta(1), meta(2, { selector: { from: 'O5', only: null } }), refused])?.run).toBe(2);
    expect(evaluateTarget([refused, meta(2), meta(1)])?.run).toBe(2); // order of the listing does not matter
    expect(evaluateTarget([meta(1, { callsStarted: 0, endedAt: undefined })])).toBeNull(); // killed before its first call
    expect(evaluateTarget([])).toBeNull();
    const src = stripComments(readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8'));
    const ev = src.slice(src.indexOf('async function cmdEvaluate'), src.indexOf('async function equationAttempt'));
    expect(ev).toMatch(/const latest = evaluateTarget\(metas\);/);
    expect(ev).not.toMatch(/metas\[metas\.length - 1\]/);
  });

  it('per-run file names', () => {
    expect([liveE2eRunFile(2), postCheckFile(2)]).toEqual(['live_e2e.2.json', 'post_check.2.json']);
  });

  it('F1\'s equation lookup failing leaves the verdict unknown: the run stops (critical, exit 3), never f1Passed = false → F1r (FIX4-R1-05)', () => {
    const src = stripComments(readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8'));
    const run = src.slice(src.indexOf('async function runInvocation'), src.indexOf('function finishResult'));
    expect(run).toMatch(/if \(attempt === null\) f1Unknown = true;\s*else f1Passed = equationDeepVerdict\(/);
    expect(run).toMatch(/const critical = fresh === null \|\| !ledgerOk \|\| f1Unknown;/);
    expect(run).not.toMatch(/attempt \? equationDeepVerdict\([^)]*\)\.ok : false/);
    // the lookup comes before the verdict that decides the next call
    expect(run.indexOf('f1Unknown = true')).toBeLessThan(run.indexOf('const v: Verdict = critical'));
    // and a stop after F1 never sends F1r: the run ends with exit 3 on a stop verdict
    const after = stepAfterCall(initialRunState(), { action: 'stop', reason: 'a lookup after the call failed' });
    expect(after.exitCode).toBe(3);
  });

  it('a resume takes F1\'s verdict from the record or looks it up again; a failed lookup stops before any call, never F1r (FIX4-R2-01)', () => {
    const f1r = LIVE_CALL_PLAN.findIndex((c) => c.id === 'F1r');
    const rec = { id: 'F1', run: 1, runId: 'run-f1', threadId: 'th-f1', outcome: 'run.done' };
    const from: Selector = { from: 'O10' };
    // a boolean in the record wins; no record → null (not passed)
    expect(f1ResumeSource({ ...rec, f1Passed: true }, from)).toEqual({ kind: 'known', f1Passed: true });
    expect(f1ResumeSource(null, from)).toEqual({ kind: 'known', f1Passed: null });
    // no f1Passed but F1's thread and run → looked up again, only when this invocation decides F1r from it
    expect(f1ResumeSource(rec, from)).toEqual({ kind: 'lookup', threadId: 'th-f1', runId: 'run-f1' });
    expect(f1ResumeSource({ ...rec, minimal: true }, { from: 'F1r' })).toEqual({ kind: 'lookup', threadId: 'th-f1', runId: 'run-f1' });
    expect(f1ResumeSource(rec, { from: 'F1' })).toEqual({ kind: 'known', f1Passed: null }); // F1 is sent again
    expect(f1ResumeSource(rec, { only: 'F1r' })).toEqual({ kind: 'known', f1Passed: null }); // always sent
    expect(f1ResumeSource(rec, { only: 'O10' })).toEqual({ kind: 'known', f1Passed: null }); // F1r not selected
    expect(f1ResumeSource({ ...rec, runId: null }, from)).toEqual({ kind: 'known', f1Passed: null }); // F1 made no run
    // the looked-up verdict decides F1r; a failed lookup is a stop (no f1Passed, no call)
    const pass = f1ResumeVerdict({ id: 'F1', text: EQ_DEEP_OK, citations: [eq(1, '10')] }, '10');
    const fail = f1ResumeVerdict({ id: 'F1', text: null, citations: null }, '10');
    const lost = f1ResumeVerdict(new Error('GET threads.get: HTTP 500'), '10');
    expect([pass, fail]).toEqual([{ f1Passed: true }, { f1Passed: false }]);
    expect(lost).toMatchObject({ stop: expect.stringMatching(/F1's verdict is unknown .*HTTP 500.*no call sent/) });
    expect('f1Passed' in lost).toBe(false);
    const at = (f1Passed: boolean | null): RunState => ({ ...initialRunState(), pos: f1r, f1Passed });
    expect(decideNext(at(true), from, 6)).toMatchObject({ kind: 'skip', record: 'skipped_not_needed' });
    expect(decideNext(at(false), from, 6)).toMatchObject({ kind: 'call', call: { id: 'F1r' } });
    // wiring: the lookup and its stop come before the sampler and the loop (exit 3, callsStarted 0); after a call, no
    // llm_calls rows → no lookup and no f1Passed; the run id falls back to the terminal's
    const src = stripComments(readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8'));
    const run = src.slice(src.indexOf('async function runInvocation'), src.indexOf('function finishResult'));
    // (FIX4-R3-01: the source → lookup → verdict chain is resolveF1Resume; its lookup arguments are pinned below)
    expect(run).toMatch(/const f1Resume = await resolveF1Resume\(prior\('F1'\), sel, \(CALL_BY_ID\.F1\.target as \{ eqNumber: string \}\)\.eqNumber, \(threadId, runId\) => equationAttempt\(api, 'F1', threadId, runId\)\);\s*if \('stop' in f1Resume\) throw new Exit\(3, f1Resume\.stop\);\s*state\.f1Passed = f1Resume\.f1Passed;/);
    expect(run.indexOf('throw new Exit(3, f1Resume.stop)')).toBeGreaterThan(-1);
    expect(run.indexOf('throw new Exit(3, f1Resume.stop)')).toBeLessThan(run.indexOf('sampler.start()'));
    expect(run).not.toMatch(/priorF1\.f1Passed/);
    expect(run).toMatch(/const attempt = fresh === null \? null : await lookup\('equation attempt', \(\) => equationAttempt\(api, c\.id as 'F1' \| 'F1r', threadId, primary\?\.runId \?\? res\.runId\), null\);/);
  });

  it('the resume\'s F1 lookup uses the record\'s own threadId and runId, once; known verdicts look nothing up; a throwing or rejecting lookup stops (FIX4-R3-01)', async () => {
    const rec = { id: 'F1', run: 1, runId: 'run-f1', threadId: 'th-f1', outcome: 'run.done' };
    const from: Selector = { from: 'O10' };
    const seen: [string, string][] = [];
    const stub = (attempt: EquationDeepAttempt | Error | 'sync-throw') => (threadId: string, runId: string): Promise<EquationDeepAttempt> => {
      seen.push([threadId, runId]);
      if (attempt === 'sync-throw') throw new Error('GET threads.get: HTTP 404');
      if (attempt instanceof Error) return Promise.reject(attempt);
      return Promise.resolve(attempt);
    };
    const ok: EquationDeepAttempt = { id: 'F1', text: EQ_DEEP_OK, citations: [eq(1, '10')] };
    expect(await resolveF1Resume(rec, from, '10', stub(ok))).toEqual({ f1Passed: true });
    expect(seen).toEqual([['th-f1', 'run-f1']]);
    seen.length = 0;
    expect(await resolveF1Resume(rec, from, '10', stub({ id: 'F1', text: null, citations: null }))).toEqual({ f1Passed: false });
    expect(seen).toEqual([['th-f1', 'run-f1']]);
    // known: the record's boolean, or null (no record / F1 sent again / --only F1r) — no lookup at all
    seen.length = 0;
    expect(await resolveF1Resume({ ...rec, f1Passed: false }, from, '10', stub(ok))).toEqual({ f1Passed: false });
    expect(await resolveF1Resume(null, from, '10', stub(ok))).toEqual({ f1Passed: null });
    expect(await resolveF1Resume(rec, { from: 'F1' }, '10', stub(ok))).toEqual({ f1Passed: null });
    expect(await resolveF1Resume(rec, { only: 'F1r' }, '10', stub(ok))).toEqual({ f1Passed: null });
    expect(seen).toEqual([]);
    // a failed lookup (rejected, or thrown before its promise) → stop, never f1Passed
    for (const failure of [new Error('GET threads.get: HTTP 500'), 'sync-throw'] as const) {
      seen.length = 0;
      const v = await resolveF1Resume(rec, from, '10', stub(failure));
      expect(v).toMatchObject({ stop: expect.stringMatching(/F1's verdict is unknown .*HTTP (500|404).*no call sent/) });
      expect('f1Passed' in v).toBe(false);
      expect(seen).toEqual([['th-f1', 'run-f1']]);
    }
  });

  it('the capture PNG of a screen call is per run: a resend never replaces the earlier run\'s PNG (FIX4-R1-04)', () => {
    expect([captureFile('O2', 1), captureFile('O2', 2), captureFile('F3', 3)]).toEqual(['captures/O2.1.png', 'captures/O2.2.png', 'captures/F3.3.png']);
    const src = stripComments(readFileSync(join(REPO_ROOT, 'scripts', 'live-e2e.ts'), 'utf8'));
    expect(src).toMatch(/const file = join\(a\.out, captureFile\(c\.id, meta\.run\)\);\s*writeFileSync\(file, png, \{ flag: 'wx' \}\);/);
    expect(src).not.toMatch(/'captures', `\$\{c\.id\}\.png`/);
  });
});

describe('server log, /proc parsing, result schema', () => {
  it('parseNetworkLog reads the guard lines only (synthetic log)', () => {
    const log = ['[study_paper] listening on http://127.0.0.1:4570', '[study_paper] network request 1/12 host=export.arxiv.org', 'noise network request 9/9 host=x', '[study_paper] network request 2/12 host=arxiv.org', '[study_paper] network request 3/12 host=arxiv.org\r'].join('\n');
    expect(parseNetworkLog(log)).toEqual({ used: 3, max: 12, requests: [{ k: 1, host: 'export.arxiv.org' }, { k: 2, host: 'arxiv.org' }, { k: 3, host: 'arxiv.org' }] });
    expect(parseNetworkLog('')).toEqual({ used: 0, max: null, requests: [] });
  });

  it('parseProcStat survives a comm with spaces and parentheses; parseEnviron splits NUL pairs', () => {
    const stat = '4242 (node (a) b) S 1000 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 7 0 123456 1 2';
    expect(parseProcStat(stat)).toEqual({ ppid: 1000, starttime: 123456 });
    expect(parseEnviron('A=1\0B=x=y\0\0')).toEqual({ A: '1', B: 'x=y' });
  });

  it('live_e2e.json carries every record item of I9', () => {
    expect(RECORD_KEYS.sort()).toEqual(
      ['timings', 'chatLowVsDeep', 'v2PrefixCache', 'quoteStatus', 'uncheckedQuotes', 'eqStatus', 'eqResolvedRatio', 'cardLabels', 'cardBadges', 'unverifiedRatio', 'pEquationOnly', 'fastlio2StatedKeys', 'deepTasks', 'fable', 'repairs', 'translateInputTokens', 'sevenDayUtilization', 'arxivRequests', 'ledgerUsed'].sort(),
    );
    expect(() => LiveE2eResultSchema.parse({})).toThrow();
    const { deepTasks, fable } = LiveE2eResultSchema.shape.records.shape;
    expect(deepTasks.parse(undefined)).toEqual([]); // pre-fix9 report
    expect(fable.parse([{ id: 'F1', durationMs: 610_000, over600s: true }])).toEqual([{ id: 'F1', durationMs: 610_000, over600s: true }]);
  });
});

describe('import boundary of the live script', () => {
  const files = ['scripts/live-e2e.ts', ...readdirSync(join(REPO_ROOT, 'scripts/lib')).filter((f) => f.endsWith('.ts')).map((f) => `scripts/lib/${f}`)];
  it('scripts/live-e2e.ts and scripts/lib/*.ts import from e2e/** only e2e/actions.ts, and never test hooks', () => {
    for (const f of files) {
      const code = stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
      const e2eImports = [...code.matchAll(/from ['"]([^'"]*e2e\/[^'"]*)['"]/g)].map((m) => m[1]);
      for (const imp of e2eImports) expect(imp, f).toMatch(/(^|\/)e2e\/actions$/);
      expect(code, f).not.toMatch(/__sp|e2e\/helpers/);
    }
  });

  it('e2e/actions.ts has no network or process entry (sourceScan) and no test hook', () => {
    const src = readFileSync(join(REPO_ROOT, 'e2e/actions.ts'), 'utf8');
    expect(fetchReferences(src, 'actions.ts')).toEqual([]);
    const code = stripComments(src);
    for (const re of [/['"`](node:)?(http|https|http2|net|tls|dgram|dns(\/promises)?|child_process)['"`]/, /undici/, /__sp/]) expect(code).not.toMatch(re);
  });
});
