// threads.get and threads.delete while the thread's paper is tombstoned (deletingAt set, the deletion deferred) or
// gone: 404 `thread`, like threads.list · cards.list · glossary.list and the run resends of that window (PLAN_M2 3.4
// "tombstone = no result", 9절 56 — review B-I10-03, coordinator notes 추가 지시 8 B 2). Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { startTestServer, type TestServer } from '../helpers/server';
import { GateAdapter } from '../llm/gateAdapter';

let s: TestServer;
afterEach(async () => {
  await s?.close();
});
const H = () => ({ 'X-SP-Token': s.token });
async function newThread(): Promise<string> {
  const r = await s.req(`/api/papers/${SEED_M2_PAPER_ID}/threads`, { method: 'POST', headers: { ...H(), 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'chat', question: 'q', clientRequestId: randomUUID() }) });
  expect(r.status).toBe(200);
  const tid = /"threadId":"([^"]+)"/.exec(r.text)?.[1];
  expect(tid).toBeTruthy();
  return tid!;
}
const get = (tid: string) => s.req(`/api/threads/${tid}`, { headers: H() });
const del = (tid: string) => s.req(`/api/threads/${tid}`, { method: 'DELETE', headers: H() });
const threadRows = (tid: string) => (s.deps.sqlite.prepare(`SELECT count(*) AS n FROM threads WHERE id = ?`).get(tid) as { n: number }).n;
const setTombstone = (at: number | null) => s.deps.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(at, SEED_M2_PAPER_ID);
function is404Thread(r: { status: number; text: string }) {
  expect(r.status).toBe(404);
  expect(JSON.parse(r.text)).toMatchObject({ error: { code: 'not_found', message: 'thread not found' } });
}

describe('threads.get / threads.delete on a tombstoned paper → 404 thread', () => {
  it('tombstone set: get and delete 404 (the thread row is left for the deletion); tombstone cleared: 200 again', async () => {
    s = await startTestServer({ env: 'prod', papers: ['m2'] });
    const tid = await newThread();
    expect((await get(tid)).status).toBe(200);
    setTombstone(Date.now());
    is404Thread(await get(tid));
    is404Thread(await del(tid));
    expect(threadRows(tid)).toBe(1);
    expect((await s.req(`/api/papers/${SEED_M2_PAPER_ID}/threads`, { headers: H() })).status).toBe(404); // the list route agrees
    setTombstone(null);
    const back = await get(tid);
    expect(back.status).toBe(200);
    expect(JSON.parse(back.text).messages.length).toBe(2);
  });

  it('a real deferred deletion (a held run ignores the abort): get and delete 404 while deferred, still 404 once the paper is gone', async () => {
    const llm = new GateAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm, deleteWaitMs: 50 });
    const tid = await newThread();
    const gate = llm.gateCall(2, { ignoreAbort: true });
    const held = s.req(`/api/threads/${tid}/messages`, { method: 'POST', headers: { ...H(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'more', clientRequestId: randomUUID() }) });
    await gate.started;
    expect((await s.req(`/api/papers/${SEED_M2_PAPER_ID}`, { method: 'DELETE', headers: H() })).status).toBe(204);
    expect(s.deps.sqlite.prepare(`SELECT deletingAt IS NOT NULL AS t FROM papers WHERE id = ?`).get(SEED_M2_PAPER_ID)).toEqual({ t: 1 });
    is404Thread(await get(tid));
    is404Thread(await del(tid));
    gate.release();
    await held;
    for (let n = 0; n < 500 && threadRows(tid) > 0; n++) await new Promise((r) => setTimeout(r, 10));
    expect(threadRows(tid)).toBe(0);
    is404Thread(await get(tid));
    is404Thread(await del(tid));
  });
});
