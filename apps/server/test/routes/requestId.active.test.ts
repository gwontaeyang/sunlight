// B-CX-1 through the routes (Codex M-M2-1, coordinator notes 추가 지시 4): the paper is deleted while a run is still
// running and the deletion is deferred (the call ignores the abort). A resend of that run's request id — through the
// routes' request-id-first probe — answers run.accepted + run.error{result_deleted} at once: no run.delta of the text
// streamed before the deletion, no new row, no adapter call. After the run ended and after a restart the same id is
// again a replay (accepted + one run.error, no delta). Owner B.
// B-CX-2: the deletion cancelled the run, so the result the call answers anyway is not stored — the first stream ends
// like the cancel path (run.error{cancelled}, no run.done), llm_calls is cancelled (not ok) with the call's usage, and
// the later replays answer the cancel path's code.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { startTestServer, type TestServer } from '../helpers/server';
import { GateAdapter } from '../llm/gateAdapter';

interface Res {
  status: number;
  events: SseEvent[];
}
let s: TestServer;
afterEach(async () => {
  await s?.close();
});
async function post(path: string, body: unknown): Promise<Res> {
  const r = await s.req(`/api${path}`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const type = String(r.headers['content-type'] ?? '');
  const events = type.includes('event-stream')
    ? r.text
        .split('\n\n')
        .filter((f) => f.trim())
        .map((f) => parseSseEvent(/^event: (.*)$/m.exec(f)![1]!, JSON.parse(/^data: (.*)$/m.exec(f)![1]!)))
    : [];
  return { status: r.status, events };
}
const del = (path: string) => s.req(`/api${path}`, { method: 'DELETE', headers: { 'X-SP-Token': s.token } });
const count = (table: string) => (s.deps.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const resultDeleted = (r: Res) => r.status === 200 && r.events.map((e) => e.event).join() === 'run.accepted,run.error' && (r.events[1]!.data as { code: string }).code === 'result_deleted';

const ROUTES = {
  card: { path: `/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, body: (id: string) => ({ clientRequestId: id }) },
  message: { path: `/papers/${SEED_M2_PAPER_ID}/threads`, body: (id: string) => ({ kind: 'chat', question: 'q', clientRequestId: id }) },
  suggestion: { path: `/papers/${SEED_M2_PAPER_ID}/glossary/define`, body: (id: string) => ({ term: 'robust kernel', clientRequestId: id }) },
} as const;

describe('paper deleted (deferred) while the run is still running → the same request id answers result_deleted, never the streamed text', () => {
  for (const sink of ['card', 'message', 'suggestion'] as const) {
    it(sink, async () => {
      const llm = new GateAdapter();
      s = await startTestServer({ env: 'prod', papers: ['m1', 'm2'], llm, deleteWaitMs: 100 });
      const gate = llm.gateCall(1, { ignoreAbort: true });
      const id = randomUUID();
      const route = ROUTES[sink];
      const first = post(route.path, route.body(id));
      await gate.started;
      expect((await del(`/papers/${SEED_M2_PAPER_ID}`)).status).toBe(204);
      expect(s.deps.sqlite.prepare(`SELECT deletingAt IS NOT NULL AS t FROM papers WHERE id = ?`).get(SEED_M2_PAPER_ID)).toEqual({ t: 1 }); // deferred
      const before = { rows: count('llm_calls'), calls: llm.calls.length };
      const during = await post(route.path, route.body(id)); // answered while the call is still held
      expect(during.events.filter((e) => e.event === 'run.delta')).toEqual([]);
      expect(resultDeleted(during)).toBe(true);
      expect({ rows: count('llm_calls'), calls: llm.calls.length }).toEqual(before);
      gate.release();
      const initial = await first;
      expect(initial.events.filter((e) => e.event === 'run.done')).toEqual([]);
      expect(initial.events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
      expect(s.deps.sqlite.prepare(`SELECT status, errorCode, outputTokens FROM llm_calls WHERE clientRequestId = ?`).get(id)).toEqual({ status: 'cancelled', errorCode: 'cancelled', outputTokens: 45 });
      for (const phase of ['ended', 'restart'] as const) {
        if (phase === 'restart') s = await s.restart();
        const again = await post(route.path, route.body(id));
        expect(again.events.map((e) => e.event), phase).toEqual(['run.accepted', 'run.error']);
        expect(again.events[1], phase).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
      }
    });
  }
});
