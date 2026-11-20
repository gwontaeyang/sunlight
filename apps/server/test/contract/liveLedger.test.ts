// Live CLI ledger (BRIEF_S S6b v3.4, PLAN_M2 D25; coordinator note 1 (a)(b)). Owner: supervisor.
// Real spawns are counted with the fake CLI (onSpawn); concurrency, crash, STOP and lock cases run in separate
// processes (test/fixtures/ledger-probe.ts). Order is asserted with the events file, never with wall-clock time.
// SP_LIVE_LEDGER is set inside each in-process test and removed afterwards (vitestSetup clears the shell's value).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmEvent } from '../../src/llm/adapter';
import { ClaudeCliAdapter } from '../../src/llm/claudeCli';
import { allowRateWarning, guardLiveRun, initLiveLedger, rateLimitVerdict, readLiveLedger, readRateWarningApproval, readRateWarnings, stopLiveLedger, unlockLiveLedger, watchLiveRun, type LiveCaps } from '../../src/llm/liveLedger';
import { collect, fakeClaudeBin, makeRequest, paperPrefix } from '../llm/fakeCli';
import { runProbe, waitFor, type ProbeResult } from '../helpers/proc';
import { tempDir } from '../helpers/tmp';

const PROBE = join(__dirname, '..', 'fixtures', 'ledger-probe.ts');
afterEach(() => {
  delete process.env.SP_LIVE_LEDGER;
});
function ledger(caps: LiveCaps): string {
  const dir = join(tempDir('sp-ledger-'), 'ledger');
  initLiveLedger(dir, caps);
  return dir;
}
const probe = (dir: string, mode: string, o: Record<string, unknown>) => runProbe(PROBE, { SP_LIVE_LEDGER: dir }, [mode, JSON.stringify(o)], 120_000);
const out = (r: ProbeResult) => {
  if (r.status !== 0) throw new Error(`probe failed (${r.status} ${r.signal}): ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
};
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const noop = () => true;
const reserve = (dir: string, model: 'opus' | 'haiku', n: number) => {
  process.env.SP_LIVE_LEDGER = dir;
  for (let i = 0; i < n; i++) expect(guardLiveRun(model, { runId: `pre${i}`, task: 'chat' }, noop).ok).toBe(true);
};

describe('guardLiveRun and the adapter', () => {
  it('total 25 with 24 used: the first adapter call spawns, the second (a "repair") spawns nothing → budget_exhausted; used.total = 25', async () => {
    const dir = ledger({ total: 25, perModel: { opus: 25 } });
    reserve(dir, 'opus', 24);
    const bin = fakeClaudeBin(tempDir());
    const pids: number[] = [];
    const run = async () => {
      const a = new ClaudeCliAdapter({ claudeBin: bin, cwd: tempDir(), env: { ...process.env }, onSpawn: (p) => pids.push(p), log: () => {} });
      const evs: LlmEvent[] = [];
      for await (const e of a.run(makeRequest({ model: 'opus' }))) evs.push(e);
      return evs.at(-1)!;
    };
    expect((await run()).type).toBe('result');
    expect(await run()).toMatchObject({ type: 'error', code: 'budget_exhausted', retryable: false });
    expect(pids).toHaveLength(1);
    expect(readLiveLedger(dir).used).toEqual({ total: 25, perModel: { opus: 25 } });
  });

  it('per-model caps: the 19th Opus, a zero-cap Fable and an unlisted model never spawn', () => {
    const dir = ledger({ total: 25, perModel: { opus: 18, fable: 0 } });
    reserve(dir, 'opus', 18);
    let calls = 0;
    expect(guardLiveRun('opus', { runId: 'r19', task: 'notation_card' }, () => ++calls)).toEqual({ ok: false, reason: 'model_cap' });
    expect(guardLiveRun('fable', { runId: 'rf', task: 'notation_card' }, () => ++calls)).toEqual({ ok: false, reason: 'model_cap' });
    expect(guardLiveRun('sonnet', { runId: 'rs', task: 'translate_selection' }, () => ++calls)).toEqual({ ok: false, reason: 'model_cap' });
    expect(calls).toBe(0);
    expect(readLiveLedger(dir).used).toEqual({ total: 18, perModel: { opus: 18 } });
  });

  it('total cap with a free model slot → total_cap, the model slot stays used', () => {
    const dir = ledger({ total: 1, perModel: { haiku: 5 } });
    reserve(dir, 'haiku', 1);
    expect(guardLiveRun('haiku', { runId: 'x', task: 'chat' }, noop)).toEqual({ ok: false, reason: 'total_cap' });
    expect(readLiveLedger(dir).used).toEqual({ total: 1, perModel: { haiku: 2 } });
  });

  it('spawnFn throws → the error propagates, the lock is released, the reservation stays', () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    process.env.SP_LIVE_LEDGER = dir;
    expect(() => guardLiveRun('haiku', { runId: 'x', task: 'chat' }, () => { throw new Error('spawn exploded'); })).toThrow('spawn exploded');
    expect(existsSync(join(dir, 'lock'))).toBe(false);
    expect(readLiveLedger(dir).used.total).toBe(1);
    expect(guardLiveRun('haiku', { runId: 'y', task: 'chat' }, noop).ok).toBe(true);
  });

  it("runChild's early exits (aborted, no cwd, jsonSchema + prefix) reserve nothing", async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    process.env.SP_LIVE_LEDGER = dir;
    const bin = fakeClaudeBin(tempDir());
    const ac = new AbortController();
    ac.abort();
    const aborted = await collect({ claudeBin: bin, cwd: tempDir(), env: { ...process.env } }, makeRequest({ signal: ac.signal }));
    expect(aborted.terminal).toMatchObject({ code: 'cancelled' });
    const noCwd = await collect({ claudeBin: bin, env: { ...process.env } }, makeRequest());
    expect(noCwd.terminal).toMatchObject({ code: 'cli_error' });
    await expect(collect({ claudeBin: bin, cwd: tempDir(), env: { ...process.env } }, makeRequest({ prefix: paperPrefix(), jsonSchema: { type: 'object' } }))).rejects.toThrow(/jsonSchema/);
    expect(readLiveLedger(dir).used).toEqual({ total: 0, perModel: {} });
  });

  it('no caps.json → no_caps, spawn 0; SP_LIVE_LEDGER unset → the guard does not intervene and touches no file', () => {
    const dir = join(tempDir(), 'empty-ledger');
    mkdirSync(dir);
    process.env.SP_LIVE_LEDGER = dir;
    let calls = 0;
    expect(guardLiveRun('haiku', { runId: 'x', task: 'chat' }, () => ++calls)).toEqual({ ok: false, reason: 'no_caps' });
    delete process.env.SP_LIVE_LEDGER;
    expect(guardLiveRun('haiku', { runId: 'x', task: 'chat' }, () => ++calls)).toEqual({ ok: true, value: 1 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('SP_LIVE_LEDGER names a missing directory → no_caps (not a lock/spawn error), spawn 0; the adapter ends budget_exhausted without a child', async () => {
    const dir = join(tempDir(), 'no-such-ledger');
    process.env.SP_LIVE_LEDGER = dir;
    let calls = 0;
    expect(guardLiveRun('haiku', { runId: 'x', task: 'chat' }, () => ++calls)).toEqual({ ok: false, reason: 'no_caps' });
    expect(calls).toBe(0);
    const r = await collect({ claudeBin: fakeClaudeBin(tempDir()), cwd: tempDir(), env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'ok' }, log: () => {} }, makeRequest());
    expect(r.terminal).toMatchObject({ type: 'error', code: 'budget_exhausted', message: 'live ledger: no_caps', retryable: false });
    expect(r.pids).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it('initLiveLedger: same caps again is fine, other caps throw; readLiveLedger / unlockLiveLedger shapes', () => {
    const dir = ledger({ total: 3, perModel: { haiku: 3 } });
    expect(() => initLiveLedger(dir, { total: 3, perModel: { haiku: 3 } })).not.toThrow();
    // the same caps written in another key order (or with an explicit 0 for an unlisted model) are the same caps
    const two = ledger({ total: 3, perModel: { opus: 1, haiku: 2 } });
    expect(() => initLiveLedger(two, { total: 3, perModel: { haiku: 2, opus: 1 } })).not.toThrow();
    expect(() => initLiveLedger(two, { perModel: { opus: 1, haiku: 2 }, total: 3 })).not.toThrow();
    expect(() => initLiveLedger(two, { total: 3, perModel: { haiku: 2, opus: 1, fable: 0 } })).not.toThrow();
    expect(() => initLiveLedger(two, { total: 3, perModel: { haiku: 1, opus: 2 } })).toThrow(/other caps/);
    expect(() => initLiveLedger(dir, { total: 4, perModel: { haiku: 3 } })).toThrow(/other caps/);
    expect(() => initLiveLedger(join(dir, 'x'), { total: 1, perModel: { gpt: 1 } } as never)).toThrow();
    expect(readLiveLedger(dir)).toEqual({ caps: { total: 3, perModel: { haiku: 3 } }, used: { total: 0, perModel: {} }, stopped: null, stopRequested: null, lock: null });
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: 1, at: 2, nonce: 'n' }));
    expect(readLiveLedger(dir).lock).toEqual({ pid: 1, at: 2 });
    expect(unlockLiveLedger(dir).removed).toEqual([`lock: ${JSON.stringify({ pid: 1, at: 2, nonce: 'n' })}`]);
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });
});

describe('stopLiveLedger is idempotent', () => {
  it('two stops on the same dir: both stopped, one STOP, the first reason kept', () => {
    const dir = ledger({ total: 1, perModel: { haiku: 1 } });
    expect(stopLiveLedger(dir, 'first')).toEqual({ status: 'stopped' });
    expect(stopLiveLedger(dir, 'second')).toEqual({ status: 'stopped' });
    expect(readdirSync(dir).filter((f) => f === 'STOP')).toHaveLength(1);
    expect(readLiveLedger(dir)).toMatchObject({ stopped: 'first', stopRequested: 'first' });
  });
});

describe('rate limits stop the ledger', () => {
  const run = (dir: string, scenario: string, onEvent?: (e: LlmEvent) => void) => {
    process.env.SP_LIVE_LEDGER = dir;
    const short = scenario === 'rate_rejected_hang' ? { timeouts: { startupMs: 10_000, firstContentMs: 800, idleMs: 800, totalMs: 5_000 } } : {};
    return collect({ claudeBin: fakeClaudeBin(tempDir()), cwd: tempDir(), env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario }, log: () => {} }, makeRequest(short), onEvent);
  };

  it('rate_limit (terminal rate_limited): STOP once although two signals fire; the terminal code stays rate_limited; the next call spawns nothing', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    const first = await run(dir, 'rate_limit');
    expect(first.terminal).toMatchObject({ type: 'error', code: 'rate_limited' });
    expect(readdirSync(dir).filter((f) => f === 'STOP')).toHaveLength(1);
    // the first signal (the rejected rate_limit event) wrote both files; the terminal's second stop changed nothing
    expect(readLiveLedger(dir).stopped).toBe('rate_limit: rejected');
    expect(readLiveLedger(dir).stopRequested).toBe('rate_limit: rejected');
    const next = await run(dir, 'ok');
    expect(next.terminal).toMatchObject({ type: 'error', code: 'budget_exhausted', message: 'live ledger: stopped' });
    expect(next.pids).toEqual([]);
  });

  it('ok_limit_warning: a SUCCESS whose rate limit status is allowed_warning still stops the ledger', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    const r = await run(dir, 'ok_limit_warning');
    expect(r.terminal.type).toBe('result');
    expect(existsSync(join(dir, 'STOP'))).toBe(true);
    expect((await run(dir, 'ok')).pids).toEqual([]);
  });

  for (const scenario of ['rate_rejected_exit', 'rate_warning_exit', 'rate_rejected_hang']) {
    it(`${scenario}: STOP_REQUESTED/STOP exist before the terminal event; the next call spawns nothing`, async () => {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      let seenAtRateLimit: { requested: boolean; stop: boolean } | null = null;
      const r = await run(dir, scenario, (e) => {
        if (e.type === 'rate_limit') seenAtRateLimit = { requested: existsSync(join(dir, 'STOP_REQUESTED')), stop: existsSync(join(dir, 'STOP')) };
      });
      expect(seenAtRateLimit).toEqual({ requested: true, stop: true });
      expect(r.terminal.type).toBe('error');
      expect(r.events.findIndex((e) => e.type === 'rate_limit')).toBeLessThan(r.events.indexOf(r.terminal));
      const next = await run(dir, 'ok');
      expect(next.terminal).toMatchObject({ code: 'budget_exhausted' });
      expect(next.pids).toEqual([]);
    }, 30_000);
  }
});

// INTEGRATION_NOTES 결정 26: the coordinator-approved exception. The approval is written by hand here (the file
// format of the ledger header) so that these cases fail on a ledger without the exception: there every
// allowed_warning stops it.
describe('rate-limit warning exception (ALLOW_RATE_WARNING, 결정 26)', () => {
  const APPROVAL = { approvedBy: 'coordinator (test)', reason: 'synthetic approval', at: '2026-11-18T00:00:00.000Z' };
  const approve = (dir: string, content: unknown = APPROVAL) => writeFileSync(join(dir, 'ALLOW_RATE_WARNING'), typeof content === 'string' ? content : JSON.stringify(content));
  const rl = (status: string | null) => ({ status, rateLimitType: 'seven_day', resetsAt: 4102444800, sevenDayUtilization: status === 'allowed' ? 0.12 : 0.54 });
  const result = (status: string | null): LlmEvent => ({ type: 'result', text: 'x', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, costUsdApiEquivEst: 0, durationMs: 1, durationApiMs: 1 } as never, rateLimit: rl(status) });
  const warnLines = (dir: string) => lines(join(dir, 'rate_warnings.jsonl')).map((l) => JSON.parse(l) as Record<string, unknown>);
  /** The events through watchLiveRun (SP_LIVE_LEDGER = dir): every event comes out unchanged. */
  async function watch(dir: string, evs: LlmEvent[], runId = 'run-w'): Promise<LlmEvent[]> {
    process.env.SP_LIVE_LEDGER = dir;
    const seen: LlmEvent[] = [];
    async function* src() {
      for (const e of evs) yield e;
    }
    for await (const e of watchLiveRun(src(), { runId })) seen.push(e);
    expect(seen).toEqual(evs);
    return seen;
  }
  const stopState = (dir: string) => ({ stop: existsSync(join(dir, 'STOP')), requested: existsSync(join(dir, 'STOP_REQUESTED')), reason: readLiveLedger(dir).stopped });

  it('approval + allowed_warning (event, then the result carrying it): no STOP, one warning line (the event) with status, utilization, resetsAt and runId', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    approve(dir);
    await watch(dir, [{ type: 'rate_limit', rateLimit: rl('allowed_warning') }, result('allowed_warning')], 'run-a');
    expect(stopState(dir)).toEqual({ stop: false, requested: false, reason: null });
    expect(warnLines(dir)).toEqual([{ at: expect.any(String), source: 'event', status: 'allowed_warning', utilization: 0.54, resetsAt: 4102444800, rateLimitType: 'seven_day', runId: 'run-a' }]);
    expect(readRateWarnings(dir)).toHaveLength(1);
  });

  it('approval + a result alone with allowed_warning (no event): recorded once from the result, no STOP', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    approve(dir);
    await watch(dir, [result('allowed_warning')]);
    expect(stopState(dir).stop).toBe(false);
    expect(warnLines(dir).map((w) => w.source)).toEqual(['result']);
  });

  it('approval + two allowed_warning events in one run (seven_day, then five_hour) + the result: one line PER EVENT (not once per run), each with its rateLimitType; no STOP (INT-WARNOK-R1-02)', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    approve(dir);
    const five = { ...rl('allowed_warning'), rateLimitType: 'five_hour', resetsAt: 4102400000 };
    await watch(dir, [{ type: 'rate_limit', rateLimit: rl('allowed_warning') }, { type: 'rate_limit', rateLimit: five }, { ...result('allowed_warning'), rateLimit: five } as LlmEvent], 'run-m');
    expect(stopState(dir)).toEqual({ stop: false, requested: false, reason: null });
    expect(warnLines(dir).map((w) => [w.source, w.rateLimitType, w.resetsAt, w.utilization, w.runId])).toEqual([
      ['event', 'seven_day', 4102444800, 0.54, 'run-m'],
      ['event', 'five_hour', 4102400000, 0.54, 'run-m'],
    ]);
  });

  it('no approval: allowed_warning stops the ledger as before (no warning line)', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    await watch(dir, [{ type: 'rate_limit', rateLimit: rl('allowed_warning') }, result('allowed_warning')]);
    expect(stopState(dir)).toEqual({ stop: true, requested: true, reason: 'rate_limit: allowed_warning' });
    expect(existsSync(join(dir, 'rate_warnings.jsonl'))).toBe(false);
  });

  it('approval + rejected, approval + another status that is not allowed: STOP (the approval covers exactly allowed_warning)', async () => {
    for (const status of ['rejected', 'allowed_warning_soon', 'unknown']) {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      approve(dir);
      await watch(dir, [{ type: 'rate_limit', rateLimit: rl(status) }]);
      expect(stopState(dir), status).toEqual({ stop: true, requested: true, reason: `rate_limit: ${status}` });
      expect(existsSync(join(dir, 'rate_warnings.jsonl')), status).toBe(false);
    }
  });

  it('approval + a warning, then a terminal rate_limited error: STOP (rate_limited), the warning stays recorded', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    approve(dir);
    await watch(dir, [{ type: 'rate_limit', rateLimit: rl('allowed_warning') }, { type: 'error', code: 'rate_limited', message: 'm', retryable: false, partialText: '' }]);
    expect(stopState(dir)).toEqual({ stop: true, requested: true, reason: 'rate_limited' });
    expect(warnLines(dir)).toHaveLength(1);
  });

  it('a damaged approval (not exactly {approvedBy, reason, at}) is no approval → STOP', async () => {
    for (const bad of ['not json', { approvedBy: '', reason: 'r', at: 'a' }, { ...APPROVAL, extra: 1 }, { approvedBy: 'x' }]) {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      approve(dir, bad);
      await watch(dir, [{ type: 'rate_limit', rateLimit: rl('allowed_warning') }]);
      expect(stopState(dir).stop, JSON.stringify(bad)).toBe(true);
      expect(readRateWarningApproval(dir), JSON.stringify(bad)).toBeNull();
    }
  });

  it('approval but the warning cannot be recorded (rate_warnings.jsonl is a directory) → STOP as without the approval', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    approve(dir);
    mkdirSync(join(dir, 'rate_warnings.jsonl'));
    await watch(dir, [{ type: 'rate_limit', rateLimit: rl('allowed_warning') }]);
    expect(stopState(dir)).toEqual({ stop: true, requested: true, reason: 'rate_limit: allowed_warning (the allowed warning could not be recorded)' });
  });

  it('allowed and absent statuses never stop or record, approval or not', async () => {
    for (const withApproval of [false, true]) {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      if (withApproval) approve(dir);
      await watch(dir, [{ type: 'rate_limit', rateLimit: rl('allowed') }, { type: 'rate_limit', rateLimit: rl(null) }, result('allowed')]);
      expect(stopState(dir).stop).toBe(false);
      expect(existsSync(join(dir, 'rate_warnings.jsonl'))).toBe(false);
    }
  });

  it('rateLimitVerdict: continue / warning_allowed / stop', () => {
    expect(rateLimitVerdict(undefined, true)).toBe('continue');
    expect(rateLimitVerdict(rl(null), false)).toBe('continue');
    expect(rateLimitVerdict(rl('allowed'), false)).toBe('continue');
    expect(rateLimitVerdict(rl('allowed_warning'), true)).toBe('warning_allowed');
    expect(rateLimitVerdict(rl('allowed_warning'), false)).toBe('stop');
    expect(rateLimitVerdict(rl('rejected'), true)).toBe('stop');
  });

  it('allowRateWarning: only into an initialised ledger; the first approval stays; a damaged one throws; caps unchanged', () => {
    const none = join(tempDir('sp-ledger-'), 'ledger');
    mkdirSync(none);
    expect(() => allowRateWarning(none, APPROVAL)).toThrow(/no caps/);
    expect(existsSync(join(none, 'ALLOW_RATE_WARNING'))).toBe(false);
    const dir = ledger({ total: 25, perModel: { haiku: 3, opus: 12 } });
    expect(allowRateWarning(dir, APPROVAL)).toEqual(APPROVAL);
    expect(allowRateWarning(dir, { ...APPROVAL, reason: 'second' })).toEqual(APPROVAL);
    expect(readRateWarningApproval(dir)).toEqual(APPROVAL);
    expect(readLiveLedger(dir).caps).toEqual({ total: 25, perModel: { haiku: 3, opus: 12 } });
    expect(() => allowRateWarning(dir, { ...APPROVAL, approvedBy: '' })).toThrow();
    const damaged = ledger({ total: 1, perModel: { haiku: 1 } });
    approve(damaged, '{');
    expect(() => allowRateWarning(damaged, APPROVAL)).toThrow(/damaged/);
  });

  describe('through the real adapter and the fake CLI', () => {
    const run = (dir: string, scenario: string, runId: string, extraEnv: Record<string, string> = {}) => {
      process.env.SP_LIVE_LEDGER = dir;
      return collect({ claudeBin: fakeClaudeBin(tempDir()), cwd: tempDir(), env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, ...extraEnv }, log: () => {} }, makeRequest({ runId }));
    };

    it('approval + ok_limit_warning (a warning, then the result): result, no STOP, the warning recorded with the request runId, and the next call spawns', async () => {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      approve(dir);
      const r = await run(dir, 'ok_limit_warning', 'run-fake-1');
      expect(r.terminal.type).toBe('result');
      expect(stopState(dir).stop).toBe(false);
      expect(warnLines(dir)).toMatchObject([{ source: 'event', status: 'allowed_warning', runId: 'run-fake-1', resetsAt: 4102444800 }]);
      const next = await run(dir, 'ok_limit_warning', 'run-fake-2');
      expect(next.pids).toHaveLength(1);
      expect(readLiveLedger(dir).used.total).toBe(2);
      expect(warnLines(dir).map((w) => w.runId)).toEqual(['run-fake-1', 'run-fake-2']);
    }, 30_000);

    it('approval + warning_rate_limited (a warning, then a terminal rate_limited): STOP, the next call spawns nothing', async () => {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      approve(dir);
      const r = await run(dir, 'warning_rate_limited', 'run-fake-3');
      expect(r.terminal).toMatchObject({ type: 'error', code: 'rate_limited' });
      expect(stopState(dir)).toMatchObject({ stop: true, reason: 'rate_limited' });
      expect((await run(dir, 'ok', 'run-fake-4')).pids).toEqual([]);
    }, 30_000);

    // INTEGRATION_NOTES 결정 29 (RCW-01): a transient CLI error (api_error_status 500) after an allowed_warning event
    // is cli_error, not rate_limited — with the approval the ledger stays usable (a resumable stop of the run)
    it('approval + warning_error_result (a warning, then an error result with api_error_status 500): terminal cli_error, no STOP, the warning recorded, and the next call spawns (결정 29)', async () => {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      approve(dir);
      const r = await run(dir, 'warning_error_result', 'run-fake-6');
      expect(r.terminal).toMatchObject({ type: 'error', code: 'cli_error', detail: 'result subtype=error_during_execution api_error_status=500' });
      expect(stopState(dir)).toEqual({ stop: false, requested: false, reason: null });
      expect(warnLines(dir)).toMatchObject([{ source: 'event', status: 'allowed_warning', runId: 'run-fake-6' }]);
      const next = await run(dir, 'ok_limit_warning', 'run-fake-7');
      expect(next.terminal.type).toBe('result');
      expect(next.pids).toHaveLength(1);
      expect(readLiveLedger(dir).used.total).toBe(2);
    }, 30_000);

    it('no approval + warning_error_result: STOP at the allowed_warning event (as before), the terminal is still cli_error; the next call spawns nothing', async () => {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      const r = await run(dir, 'warning_error_result', 'run-fake-8');
      expect(r.terminal).toMatchObject({ type: 'error', code: 'cli_error' });
      expect(stopState(dir)).toEqual({ stop: true, requested: true, reason: 'rate_limit: allowed_warning' });
      expect(existsSync(join(dir, 'rate_warnings.jsonl'))).toBe(false);
      expect((await run(dir, 'ok', 'run-fake-9')).pids).toEqual([]);
    }, 30_000);

    it('approval + a rejected event, then an error result with api_error_status 500: STOP at the event, the terminal is rate_limited', async () => {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      approve(dir);
      const r = await run(dir, 'warning_error_result', 'run-fake-10', { FAKE_CLAUDE_LIMIT_STATUS: 'rejected' });
      expect(r.terminal).toMatchObject({ type: 'error', code: 'rate_limited' });
      expect(stopState(dir)).toEqual({ stop: true, requested: true, reason: 'rate_limit: rejected' });
      expect(existsSync(join(dir, 'rate_warnings.jsonl'))).toBe(false);
      expect((await run(dir, 'ok', 'run-fake-11')).pids).toEqual([]);
    }, 30_000);

    it('approval + an allowed_warning event, then an error result with api_error_status 429: terminal rate_limited, STOP (rate_limited)', async () => {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      approve(dir);
      const r = await run(dir, 'warning_error_result', 'run-fake-12', { FAKE_CLAUDE_API_ERROR_STATUS: '429' });
      expect(r.terminal).toMatchObject({ type: 'error', code: 'rate_limited' });
      expect(stopState(dir)).toEqual({ stop: true, requested: true, reason: 'rate_limited' });
      expect(warnLines(dir)).toHaveLength(1);
    }, 30_000);

    it('approval + rate_rejected_exit: STOP at the rejected event', async () => {
      const dir = ledger({ total: 5, perModel: { haiku: 5 } });
      approve(dir);
      await run(dir, 'rate_rejected_exit', 'run-fake-5');
      expect(stopState(dir)).toMatchObject({ stop: true, reason: 'rate_limit: rejected' });
      expect(existsSync(join(dir, 'rate_warnings.jsonl'))).toBe(false);
    }, 30_000);
  });
});

describe('separate processes', () => {
  it('concurrency: 8 processes × 3 calls, cap 10 → exactly 10 succeed and spawnFn ran 10 times', async () => {
    const dir = ledger({ total: 10, perModel: { haiku: 24 } });
    const events = join(dir, '..', 'events');
    const go = join(dir, '..', 'go');
    const ps = Array.from({ length: 8 }, (_, i) => probe(dir, 'guard', { who: `p${i}`, model: 'haiku', count: 3, go, events, lockWaitMs: 20_000 }));
    await new Promise((r) => setTimeout(r, 1500)); // let the processes start (they wait for `go`)
    writeFileSync(go, '1');
    const results = (await Promise.all(ps)).flatMap((r) => out(r).results as string[]);
    expect(results.filter((x) => x === 'ok')).toHaveLength(10);
    expect(results.filter((x) => x !== 'ok').every((x) => x === 'total_cap')).toBe(true);
    expect(lines(events).filter((l) => l.startsWith('spawn'))).toHaveLength(10);
    expect(readLiveLedger(dir).used.total).toBe(10);
  }, 120_000);

  it('crash + stale lock: A is killed inside spawnFn (lock held) → its reservation stays; B breaks the stale lock and proceeds (breaks.log 1 line)', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    const marker = join(dir, '..', 'a-in');
    const a = runProbe(PROBE, { SP_LIVE_LEDGER: dir }, ['guard', JSON.stringify({ who: 'A', model: 'haiku', count: 1, barrier: { marker, release: join(dir, '..', 'never') } })]);
    await waitFor(() => existsSync(marker), 'A inside spawnFn', 60_000);
    const pid = Number(readFileSync(marker, 'utf8'));
    expect(readLiveLedger(dir).lock?.pid).toBe(pid);
    process.kill(pid, 'SIGKILL');
    await a;
    expect(readLiveLedger(dir).used.total).toBe(1);
    const b = out(await probe(dir, 'guard', { who: 'B', model: 'haiku', count: 1 }));
    expect(b.results).toEqual(['ok']);
    expect(lines(join(dir, 'breaks.log'))).toHaveLength(1);
    expect(JSON.parse(lines(join(dir, 'breaks.log'))[0]!)).toMatchObject({ pid });
    expect(readLiveLedger(dir).used.total).toBe(2);
  }, 120_000);

  it('8 processes against one dead-pid lock → breaks.log exactly 1 line, no cap exceeded', async () => {
    const dir = ledger({ total: 6, perModel: { haiku: 24 } });
    // a pid that surely no longer exists: one above the max pid is invalid → ESRCH
    const maxPid = Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim());
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: maxPid + 1, at: 1, nonce: 'stale' }));
    const go = join(dir, '..', 'go');
    const ps = Array.from({ length: 8 }, (_, i) => probe(dir, 'guard', { who: `p${i}`, model: 'haiku', count: 2, go, lockWaitMs: 20_000 }));
    await new Promise((r) => setTimeout(r, 1500));
    writeFileSync(go, '1');
    const results = (await Promise.all(ps)).flatMap((r) => out(r).results as string[]);
    expect(lines(join(dir, 'breaks.log'))).toHaveLength(1);
    expect(results.filter((x) => x === 'ok')).toHaveLength(6);
    expect(readLiveLedger(dir).used.total).toBe(6);
  }, 120_000);

  it('a live holder: B (lockWaitMs 50) → ledger_locked, no spawn, no reservation; a leftover lock.break → ledger_locked until unlock', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    const marker = join(dir, '..', 'a-in');
    const release = join(dir, '..', 'a-go');
    const events = join(dir, '..', 'events');
    const a = probe(dir, 'guard', { who: 'A', model: 'haiku', count: 1, barrier: { marker, release }, events });
    await waitFor(() => existsSync(marker), 'A inside spawnFn', 60_000);
    expect(out(await probe(dir, 'guard', { who: 'B', model: 'haiku', count: 1, lockWaitMs: 50, events })).results).toEqual(['ledger_locked']);
    expect(readLiveLedger(dir).used.total).toBe(1);
    writeFileSync(release, '1');
    expect(out(await a).results).toEqual(['ok']);
    expect(lines(events)).toEqual(['spawn A stopRequested=false stop=false']);
    // a stale lock.break left behind (and a stale lock): never broken automatically
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: 2 ** 30, at: 1, nonce: 'x' }));
    writeFileSync(join(dir, 'lock.break'), JSON.stringify({ pid: 2 ** 30, at: 1, nonce: 'y' }));
    process.env.SP_LIVE_LEDGER = dir;
    expect(guardLiveRun('haiku', { runId: 'z', task: 'chat' }, noop, { lockWaitMs: 50 })).toEqual({ ok: false, reason: 'ledger_locked' });
    expect(unlockLiveLedger(dir).removed).toHaveLength(2);
    expect(guardLiveRun('haiku', { runId: 'z', task: 'chat' }, noop).ok).toBe(true);
  }, 120_000);

  it('STOP barrier: while A holds the lock in spawnFn, B (long wait) writes STOP_REQUESTED but not STOP; releasing A → A spawned, then STOP; C is refused', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    const marker = join(dir, '..', 'a-in');
    const release = join(dir, '..', 'a-go');
    const events = join(dir, '..', 'events');
    const a = probe(dir, 'guard', { who: 'A', model: 'haiku', count: 1, barrier: { marker, release }, events });
    await waitFor(() => existsSync(marker), 'A inside spawnFn', 60_000);
    let bDone = false;
    const b = probe(dir, 'stop', { reason: 'test stop', lockWaitMs: 60_000, events }).then((r) => ((bDone = true), r));
    await waitFor(() => existsSync(join(dir, 'STOP_REQUESTED')), 'STOP_REQUESTED', 60_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(dir, 'STOP'))).toBe(false);
    expect(bDone).toBe(false);
    writeFileSync(release, '1');
    expect(out(await a).results).toEqual(['ok']);
    expect(out(await b)).toEqual({ status: 'stopped' });
    expect(existsSync(join(dir, 'STOP'))).toBe(true);
    expect(out(await probe(dir, 'guard', { who: 'C', model: 'haiku', count: 1, events })).results).toEqual(['stopped']);
    expect(lines(events)).toEqual(['spawn A stopRequested=false stop=false', 'stop stopped']);
  }, 120_000);

  it('stop request while the lock is held (lock timeout): stop_pending, ≤ 1 spawn after STOP_REQUESTED (the holder), 0 after STOP; the retry confirms STOP', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    const marker = join(dir, '..', 'a-in');
    const release = join(dir, '..', 'a-go');
    const events = join(dir, '..', 'events');
    const a = probe(dir, 'guard', { who: 'A', model: 'haiku', count: 1, barrier: { marker, release }, events });
    await waitFor(() => existsSync(marker), 'A inside spawnFn', 60_000);
    const b = probe(dir, 'stop', { reason: 'rate limit seen', lockWaitMs: 50, waitForStop: true, events });
    await waitFor(() => lines(events).includes('stop stop_pending'), 'B returned stop_pending', 60_000);
    expect(existsSync(join(dir, 'STOP_REQUESTED'))).toBe(true);
    expect(existsSync(join(dir, 'STOP'))).toBe(false);
    const c = probe(dir, 'guard', { who: 'C', model: 'haiku', count: 1, lockWaitMs: 60_000, events });
    await new Promise((r) => setTimeout(r, 1000));
    writeFileSync(release, '1');
    expect(out(await a).results).toEqual(['ok']);
    expect(out(await c).results).toEqual(['stopped']);
    expect(out(await b)).toEqual({ status: 'stop_pending' });
    expect(existsSync(join(dir, 'STOP'))).toBe(true);
    expect(out(await probe(dir, 'guard', { who: 'D', model: 'haiku', count: 1, events })).results).toEqual(['stopped']);
    const ev = lines(events);
    const spawns = ev.filter((l) => l.startsWith('spawn'));
    expect(spawns).toEqual(['spawn A stopRequested=false stop=false']);
    expect(ev.indexOf('stop-confirmed')).toBeGreaterThan(ev.indexOf('spawn A stopRequested=false stop=false'));
    expect(spawns.filter((l) => l.includes('stopRequested=true')).length).toBeLessThanOrEqual(1);
    expect(spawns.filter((l) => l.includes('stop=true'))).toHaveLength(0);
  }, 120_000);

  it('end of the retry: B (stop_pending, nothing else to do) exits on its own (unref); STOP_REQUESTED alone still refuses C', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    const marker = join(dir, '..', 'a-in');
    const release = join(dir, '..', 'a-go');
    const a = probe(dir, 'guard', { who: 'A', model: 'haiku', count: 1, barrier: { marker, release } });
    await waitFor(() => existsSync(marker), 'A inside spawnFn', 60_000);
    const b = await probe(dir, 'stop', { reason: 'x', lockWaitMs: 50 });
    expect(b.status).toBe(0);
    expect(out(b)).toEqual({ status: 'stop_pending' });
    expect(existsSync(join(dir, 'STOP'))).toBe(false);
    expect(existsSync(join(dir, 'STOP_REQUESTED'))).toBe(true);
    writeFileSync(release, '1');
    await a;
    expect(out(await probe(dir, 'guard', { who: 'C', model: 'haiku', count: 1 })).results).toEqual(['stopped']);
  }, 120_000);

  it('a pending in-process retry stops once another process confirms STOP (one STOP, no exception); stopLiveLedger is idempotent', async () => {
    const dir = ledger({ total: 5, perModel: { haiku: 5 } });
    const marker = join(dir, '..', 'a-in');
    const release = join(dir, '..', 'a-go');
    const a = probe(dir, 'guard', { who: 'A', model: 'haiku', count: 1, barrier: { marker, release } });
    await waitFor(() => existsSync(marker), 'A inside spawnFn', 60_000);
    expect(stopLiveLedger(dir, 'in-process', { lockWaitMs: 50 })).toEqual({ status: 'stop_pending' });
    expect(stopLiveLedger(dir, 'again', { lockWaitMs: 0 })).toEqual({ status: 'stop_pending' }); // no second timer
    writeFileSync(release, '1');
    await a;
    expect(out(await probe(dir, 'stop', { reason: 'other process', lockWaitMs: 5_000 }))).toEqual({ status: 'stopped' });
    await new Promise((r) => setTimeout(r, 2_500)); // the in-process retry sees STOP and ends
    expect(readdirSync(dir).filter((f) => f === 'STOP')).toHaveLength(1);
    expect(readLiveLedger(dir).stopRequested).toBe('in-process');
    expect(stopLiveLedger(dir, 'third')).toEqual({ status: 'stopped' });
  }, 120_000);

  it('the lock file is never seen empty or half-written (1,000 acquire/release cycles while another process reads it)', async () => {
    const dir = ledger({ total: 0, perModel: {} });
    // S-6: the cycles start only after the reader process says its read loop is running, and the reader keeps reading
    // until the cycles are done (process start-up under load no longer decides whether the two overlap).
    const sig = tempDir('sp-watchlock-');
    const started = join(sig, 'reader-started');
    const churnDone = join(sig, 'churn-done');
    const watch = probe(dir, 'watchlock', { ms: 90_000, started, until: churnDone });
    let watchExited = false;
    void watch.then(() => (watchExited = true));
    await waitFor(() => existsSync(started) || watchExited, 'the reader process started reading the lock', 60_000);
    if (!existsSync(started)) {
      // The reader ended before its first read: show why (exit status and its output) instead of a bare false.
      const r = await watch;
      throw new Error(`the reader process exited before it started reading (${r.status} ${r.signal}): stdout=${r.stdout} stderr=${r.stderr}`);
    }
    expect(existsSync(started)).toBe(true);
    out(await probe(dir, 'churn', { n: 1000 }));
    writeFileSync(churnDone, '1');
    const w = out(await watch);
    expect(w.stoppedBy).toBe('until'); // the reader covered every cycle
    expect(w.bad).toBe(0);
    expect(w.reads as number).toBeGreaterThan(0);
  }, 120_000);
});
