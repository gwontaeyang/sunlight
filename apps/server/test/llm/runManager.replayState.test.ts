// The eviction leg of the row-state replay rule (PLAN_M2 9절 60 · 67(c), Codex m-M2-R2-1, coordinator notes 추가 지시 8
// B 1 — the HTTP legs, memory and restart, are in test/routes/requestId.replayState.test.ts). A messages.create probe
// carries no paperId; once the paper row is deleted for good llm_calls.paperId is NULL and the stored hash cannot be
// compared. The answer still comes from the row: cancelled → run.error{cancelled}, ok → result_deleted. In memory,
// after an eviction (retention max 0) and after a restart the same; no new row, no adapter call, no answer text.
// Owner B.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import type { RunManagerDeps } from '../../src/llm/runManager';
import { GateAdapter, PRE_DELETE_TEXT } from './gateAdapter';
import { events, makeRunEnv, request, type RunEnv } from './runEnv';

const IDENTITY = { route: 'messages.create', text: 'a follow-up' };
const count = (env: RunEnv) => (env.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls`).get() as { n: number }).n;

async function scenario(end: 'cancelled' | 'ok', leg: 'memory' | 'evicted' | 'restart'): Promise<RunSseEvent[]> {
  const llm = new GateAdapter();
  const deps: Partial<RunManagerDeps> | undefined = leg === 'evicted' ? { retention: { max: 0, ms: 60_000 } } : undefined;
  const env = await makeRunEnv({ adapter: llm, ...(deps ? { deps } : {}) });
  try {
    const crid = randomUUID();
    const gate = end === 'cancelled' ? llm.gateCall(1, { ignoreAbort: true }) : null;
    const h = env.manager.runTask(request({ clientRequestId: crid, identity: IDENTITY }));
    const first = events(h);
    if (gate) {
      await gate.started;
      env.manager.runs.cancel(h.runId); // what the paper deletion does; the call answers its result anyway
      gate.release();
    }
    const ev = await first;
    expect(ev.at(-1)!.event).toBe(end === 'ok' ? 'run.done' : 'run.error');
    env.sqlite.prepare(`DELETE FROM papers WHERE id = ?`).run(SEED_PAPER_ID); // the final deletion (FK SET NULL)
    expect(env.sqlite.prepare(`SELECT status, paperId FROM llm_calls WHERE clientRequestId = ?`).get(crid)).toEqual({ status: end, paperId: null });
    const manager = leg === 'restart' ? env.restart() : env.manager;
    const before = { rows: count(env), calls: llm.calls.length };
    const probe = manager.runs.findExisting({ clientRequestId: crid, identity: IDENTITY });
    expect(probe, leg).not.toBeNull();
    const again = await events(probe!);
    expect({ rows: count(env), calls: llm.calls.length }, leg).toEqual(before);
    expect(JSON.stringify(again), leg).not.toContain(PRE_DELETE_TEXT.trim());
    return again;
  } finally {
    env.close();
  }
}

describe('paper deleted for good (paperId NULL), messages.create-shaped probe without paperId', () => {
  for (const leg of ['memory', 'evicted', 'restart'] as const) {
    it(`cancelled row → run.error{cancelled} (${leg})`, async () => {
      const again = await scenario('cancelled', leg);
      expect(again.map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
      expect(again[1]).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
      expect('partialText' in (again[1]!.data as object)).toBe(false);
    });
    it(`ok row → run.error{result_deleted} (${leg})`, async () => {
      const again = await scenario('ok', leg);
      expect(again.map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
      expect(again[1]).toMatchObject({ event: 'run.error', data: { code: 'result_deleted' } });
    });
  }
});
