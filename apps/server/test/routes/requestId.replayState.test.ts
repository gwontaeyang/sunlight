// A resend of a known request id answers from its llm_calls row state (PLAN_M2 9절 60 · 67(c), Codex m-M2-R2-1,
// coordinator notes 추가 지시 8 B 1): a `cancelled` row → run.error{cancelled}; an `ok` row whose owner (thread,
// message, card, suggestion) is gone → run.error{result_deleted}. The same when the paper was deleted for good and
// llm_calls.paperId is NULL — the case a messages.create probe (no paperId in its body) used to answer
// result_deleted without looking at the row. In memory, after an eviction and after a restart alike; never the old
// answer text; no new row, no adapter call. The eviction case is in test/llm/runManager.replayState.test.ts (the
// route server has no retention option). Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { startTestServer, type TestServer } from '../helpers/server';
import { GateAdapter, PRE_DELETE_TEXT } from '../llm/gateAdapter';

interface Res {
  status: number;
  events: SseEvent[];
}
let s: TestServer;
let llm: GateAdapter;
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
const paperRow = () => s.deps.sqlite.prepare(`SELECT deletingAt FROM papers WHERE id = ?`).get(SEED_M2_PAPER_ID) as { deletingAt: number | null } | undefined;
async function waitPaperGone() {
  for (let n = 0; n < 500 && paperRow(); n++) await new Promise((r) => setTimeout(r, 10));
  expect(paperRow()).toBeUndefined();
}
const rowOf = (crid: string) => s.deps.sqlite.prepare(`SELECT status, errorCode, paperId FROM llm_calls WHERE clientRequestId = ?`).get(crid);
/** accepted + one run.error with this code: no delta, no done, no partial text, nothing of the model's answer. */
function replayOf(r: Res, code: string, what: string) {
  expect(r.status, what).toBe(200);
  expect(r.events.map((e) => e.event), what).toEqual(['run.accepted', 'run.error']);
  expect(r.events[1], what).toMatchObject({ event: 'run.error', data: { code } });
  expect('partialText' in (r.events[1]!.data as object), what).toBe(false);
  expect(JSON.stringify(r.events), what).not.toContain(PRE_DELETE_TEXT.trim());
}
/** Right after the run ended (retained in memory) and after a restart: the same answer, nothing new. */
async function memoryAndRestart(f: () => Promise<Res>, code: string, what: string) {
  for (const phase of ['memory', 'restart'] as const) {
    if (phase === 'restart') s = await s.restart();
    const before = { rows: count('llm_calls'), calls: llm.calls.length };
    replayOf(await f(), code, `${what} ${phase}`);
    expect({ rows: count('llm_calls'), calls: llm.calls.length }, `${what} ${phase}`).toEqual(before);
  }
}

describe('the paper deletion cancels a held run (deferred), then the paper row is deleted for good (paperId NULL)', () => {
  // first stream cancelled · resend during the deferral result_deleted · after the deletion (memory, restart) cancelled
  for (const route of ['messages.create', 'threads.create'] as const) {
    it(route, async () => {
      llm = new GateAdapter();
      s = await startTestServer({ env: 'prod', papers: ['m2'], llm, deleteWaitMs: 50 });
      const base = await post(`/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'chat', question: 'base', clientRequestId: randomUUID() });
      expect(base.events.at(-1)!.event).toBe('run.done');
      const tid = (base.events[0]!.data as { threadId: string }).threadId;
      const crid = randomUUID();
      const path = route === 'messages.create' ? `/threads/${tid}/messages` : `/papers/${SEED_M2_PAPER_ID}/threads`;
      const body = route === 'messages.create' ? { text: 'a follow-up', clientRequestId: crid } : { kind: 'chat', question: 'held', clientRequestId: crid };
      const gate = llm.gateCall(2, { ignoreAbort: true });
      const first = post(path, body);
      await gate.started;
      expect((await del(`/papers/${SEED_M2_PAPER_ID}`)).status).toBe(204);
      expect(paperRow()?.deletingAt).not.toBeNull(); // deferred: the held call ignores the abort
      replayOf(await post(path, body), 'result_deleted', 'during the deferral');
      gate.release();
      const initial = await first;
      expect(initial.events.filter((e) => e.event === 'run.done')).toEqual([]);
      expect(initial.events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
      await waitPaperGone();
      expect(rowOf(crid)).toEqual({ status: 'cancelled', errorCode: 'cancelled', paperId: null });
      await memoryAndRestart(() => post(path, body), 'cancelled', route);
    });
  }
});

describe('an ok run, then the paper is deleted for good (paperId NULL) → result_deleted (memory, restart)', () => {
  for (const route of ['messages.create', 'threads.create'] as const) {
    it(route, async () => {
      llm = new GateAdapter();
      s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
      const base = await post(`/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'chat', question: 'base', clientRequestId: randomUUID() });
      const tid = (base.events[0]!.data as { threadId: string }).threadId;
      const crid = randomUUID();
      const path = route === 'messages.create' ? `/threads/${tid}/messages` : `/papers/${SEED_M2_PAPER_ID}/threads`;
      const body = route === 'messages.create' ? { text: 'a follow-up', clientRequestId: crid } : { kind: 'chat', question: 'second', clientRequestId: crid };
      const done = await post(path, body);
      expect(done.events.at(-1)!.event).toBe('run.done');
      const answer = (done.events.at(-1)!.data as { text: string }).text;
      expect((await del(`/papers/${SEED_M2_PAPER_ID}`)).status).toBe(204);
      await waitPaperGone();
      expect(rowOf(crid)).toEqual({ status: 'ok', errorCode: null, paperId: null });
      await memoryAndRestart(async () => {
        const r = await post(path, body);
        expect(JSON.stringify(r.events)).not.toContain(answer.slice(0, 40));
        return r;
      }, 'result_deleted', route);
    });
  }
});
