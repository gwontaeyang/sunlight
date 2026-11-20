// The run owner ignores the adapter's rate_limit event (BRIEF_S S6b/S9 v3.4). Owner: supervisor. Fake CLI + the real
// ClaudeCliAdapter through makeRunEnv (B's helper, imported only); no SP_LIVE_LEDGER.
import { describe, expect, it } from 'vitest';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import { SSE_EVENT_NAMES } from '@study-paper/shared/contracts/sse';
import { collect, fakeClaudeBin, makeRequest } from '../llm/fakeCli';
import { events, makeRunEnv, request, terminalOf } from '../llm/runEnv';
import { tempDir } from '../helpers/tmp';

const RUN_EVENTS = SSE_EVENT_NAMES.filter((n) => n.startsWith('run.'));

/** Event names without run.queued, with each run of consecutive run.delta folded into one. */
function shape(ev: RunSseEvent[]): string[] {
  const out: string[] = [];
  for (const e of ev) {
    if (e.event === 'run.queued') continue;
    if (e.event === 'run.delta' && out.at(-1) === 'run.delta') continue;
    out.push(e.event);
  }
  return out;
}

async function runScenario(scenario: string): Promise<{ ev: RunSseEvent[]; row: { status: string; errorCode: string | null } }> {
  const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: scenario } });
  try {
    const ev = await events(env.manager.runTask(request()));
    const rowsAll = env.sqlite.prepare(`SELECT status, errorCode FROM llm_calls`).all() as { status: string; errorCode: string | null }[];
    expect(rowsAll, scenario).toHaveLength(1);
    return { ev, row: rowsAll[0]! };
  } finally {
    env.close();
  }
}

describe('runManager and the rate_limit adapter event', () => {
  it('the adapter really yields exactly one rate_limit event in both scenarios (so the run tests below are not vacuous)', async () => {
    const dir = tempDir('sp-rl-adapter-');
    const bin = fakeClaudeBin(dir);
    for (const [scenario, status] of [['ok_limit_warning', 'allowed_warning'], ['rate_rejected_exit', 'rejected']] as const) {
      const c = await collect({ claudeBin: bin, cwd: dir, env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario }, log: () => {} }, makeRequest());
      const rl = c.events.filter((e) => e.type === 'rate_limit');
      expect(rl, scenario).toHaveLength(1);
      expect(rl[0], scenario).toMatchObject({ type: 'rate_limit', rateLimit: { status } });
    }
  }, 60_000);

  it('ok_limit_warning → the same event-name sequence as ok (queued dropped, deltas folded) and exactly one run.done; row ok', async () => {
    const ok = await runScenario('ok');
    const warn = await runScenario('ok_limit_warning');
    for (const e of warn.ev) expect(RUN_EVENTS, `ok_limit_warning: ${e.event}`).toContain(e.event);
    expect(shape(ok.ev)).toEqual(expect.arrayContaining(['run.accepted', 'run.started', 'run.delta', 'run.done']));
    expect(shape(warn.ev)).toEqual(shape(ok.ev));
    expect(terminalOf(warn.ev).map((e) => e.event)).toEqual(['run.done']);
    expect(warn.ev.filter((e) => e.event === 'run.retrying')).toEqual([]);
    expect(warn.row).toEqual({ status: 'ok', errorCode: null });
  }, 60_000);

  it('rate_rejected_exit → exactly one run.error{cli_error} (not rate_limited), no event from rate_limit; row error/cli_error', async () => {
    const r = await runScenario('rate_rejected_exit');
    for (const e of r.ev) expect(RUN_EVENTS, `rate_rejected_exit: ${e.event}`).toContain(e.event);
    const term = terminalOf(r.ev);
    expect(term.map((e) => e.event)).toEqual(['run.error']);
    expect(term[0]).toMatchObject({ data: { code: 'cli_error' } });
    expect(r.ev.map((e) => e.event).filter((n) => n !== 'run.queued')).toEqual(['run.accepted', 'run.started', 'run.error']);
    expect(r.row).toEqual({ status: 'error', errorCode: 'cli_error' });
  }, 60_000);
});
