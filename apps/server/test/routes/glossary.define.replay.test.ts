// glossary.define replays (PLAN_M2 3.4 rule 6, D29, BRIEF_B B5): the suggestion is the run's stored result
// (llm_calls.resultRaw) — the same request id replays the same `parsed` after a disconnect, an eviction or a restart
// (one adapter call, one llm_calls row); usable only while S's suggestionAvailable says so (30 days at use time, paper
// present and not tombstoned) — else result_deleted; a run finishing after the tombstone never writes it back.
// Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import { readMockOutput } from '@study-paper/shared/mock-outputs';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { HttpError } from '../../src/deps';
import type { LlmAdapter, LlmEvent, LlmRunRequest } from '../../src/llm/adapter';
import { EMPTY_USAGE } from '../../src/llm/adapter';
import { clearPaperResultRaw } from '../../src/resultRetention';
import { defineIdentity } from '../../src/study/glossary';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';
import { events, makeRunEnv, type RunEnv } from '../llm/runEnv';

const DAY = 86_400_000;
afterEach(() => {
  vi.useRealTimers();
});

const defineReq = (crid: string, term = 'robust kernel') => ({ task: 'glossary_define' as const, clientRequestId: crid, paperId: SEED_PAPER_ID, inputs: { term }, identity: defineIdentity(SEED_PAPER_ID, { term }) });
const parsedOf = (ev: RunSseEvent[]) => {
  const d = ev.at(-1)!;
  if (d.event !== 'run.done') throw new Error(`not done: ${JSON.stringify(d)}`);
  return d.data.parsed;
};
const resultDeleted = (ev: RunSseEvent[]) => ev.map((e) => e.event).join() === 'run.accepted,run.error' && (ev[1]!.data as { code: string }).code === 'result_deleted';
const rows = (env: RunEnv) => (env.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls`).get() as { n: number }).n;

describe('replay of the stored suggestion', () => {
  it('right after run.done, after an eviction and after a restart: the same parsed, one adapter call, one row', async () => {
    const llm = new ControlledAdapter();
    const env = await makeRunEnv({ adapter: llm, deps: { retention: { max: 1, ms: 60_000 } } });
    const crid = randomUUID();
    const first = await events(env.manager.runTask(defineReq(crid)));
    const parsed = parsedOf(first);
    expect((parsed as unknown as { items: { attrs: { name: string } }[] }).items[0]!.attrs.name).toBe('robust kernel');
    // in memory
    expect(parsedOf(await events(env.manager.runTask(defineReq(crid))))).toEqual(parsed);
    // evicted (another finished run pushes it out of a retention of 1)
    await events(env.manager.runTask(defineReq(randomUUID(), 'residual')));
    const evicted = await events(env.manager.runTask(defineReq(crid)));
    expect(evicted.map((e) => e.event)).toEqual(['run.accepted', 'run.done']);
    expect(parsedOf(evicted)).toEqual(parsed);
    // restarted
    const restarted = await events(env.restart({ adapter: llm }).runTask(defineReq(crid)));
    expect(parsedOf(restarted)).toEqual(parsed);
    expect(llm.calls).toHaveLength(2); // the first define + the 'residual' one
    expect(rows(env)).toBe(2);
    env.close();
  });

  it('the stored term name is read with parseBlocks (review B-R1-03): `<term name="x" >` and a fenced decoy line replay the same after an eviction and a restart', async () => {
    const outputs = ['<term name="robust kernel" >큰 잔차의 가중치를 줄이는 손실 함수.</term>', '```\n<term name="other">decoy</term>\n```\n<term name="robust kernel">큰 잔차의 가중치를 줄이는 손실 함수.</term>'];
    for (const out of outputs) {
      const llm = new ControlledAdapter();
      const env = await makeRunEnv({ adapter: llm, deps: { retention: { max: 0, ms: 60_000 } } });
      llm.queueOutputs(out);
      const crid = randomUUID();
      const first = await events(env.manager.runTask(defineReq(crid)));
      const parsed = parsedOf(first);
      expect(llm.calls).toHaveLength(1); // valid at once (no repair)
      const evicted = await events(env.manager.runTask(defineReq(crid)));
      expect(evicted.map((e) => e.event), out).toEqual(['run.accepted', 'run.done']);
      expect(parsedOf(evicted)).toEqual(parsed);
      expect(parsedOf(await events(env.restart({ adapter: llm }).runTask(defineReq(crid))))).toEqual(parsed);
      expect(llm.calls).toHaveLength(1);
      env.close();
    }
  });

  it('the same id with another term → 409', async () => {
    const env = await makeRunEnv({ adapter: new ControlledAdapter() });
    const crid = randomUUID();
    await events(env.manager.runTask(defineReq(crid)));
    expect(() => env.manager.runTask(defineReq(crid, 'residual'))).toThrow(HttpError);
    env.close();
  });

  it('30 days at use time (Date faked, no restart, no sweep): − 1 ms → replay; exactly and + 1 ms → result_deleted with resultRaw still stored — in memory and after an eviction', async () => {
    for (const retention of [undefined, { max: 0, ms: 60_000 }]) {
      const llm = new ControlledAdapter();
      const env = await makeRunEnv({ adapter: llm, ...(retention ? { deps: { retention } } : {}) });
      const crid = randomUUID();
      const first = await events(env.manager.runTask(defineReq(crid)));
      const finishedAt = (env.sqlite.prepare(`SELECT finishedAt AS f FROM llm_calls WHERE clientRequestId = ?`).get(crid) as { f: number }).f;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(finishedAt + 30 * DAY - 1);
      expect(parsedOf(await events(env.manager.runTask(defineReq(crid))))).toEqual(parsedOf(first));
      for (const t of [finishedAt + 30 * DAY, finishedAt + 30 * DAY + 1]) {
        vi.setSystemTime(t);
        expect(resultDeleted(await events(env.manager.runTask(defineReq(crid)))), `${t - finishedAt} ${JSON.stringify(retention)}`).toBe(true);
      }
      vi.useRealTimers();
      expect(env.sqlite.prepare(`SELECT resultRaw IS NOT NULL AS kept FROM llm_calls WHERE clientRequestId = ?`).get(crid)).toEqual({ kept: 1 });
      expect(llm.calls).toHaveLength(1);
      env.close();
    }
  });

  it('a run that finishes after the tombstone writes no resultRaw and replays result_deleted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let startedResolve!: () => void;
    const started = new Promise<void>((r) => (startedResolve = r));
    // an adapter that ignores the abort and answers after the paper was tombstoned
    const late: LlmAdapter = {
      mode: 'mock',
      async *run(_req: LlmRunRequest): AsyncGenerator<LlmEvent> {
        yield { type: 'started', modelResolved: 'mock', cliVersion: 'mock' };
        startedResolve();
        await gate;
        const out = readMockOutput('glossary_define');
        yield { type: 'text', delta: out };
        yield { type: 'result', text: out, usage: EMPTY_USAGE };
      },
      health: async () => ({ cliFound: true, cliVersion: 'mock', loggedIn: null, detail: null }),
    };
    const env = await makeRunEnv({ adapter: late });
    const crid = randomUUID();
    const h = env.manager.runTask(defineReq(crid));
    const all = events(h);
    await started;
    env.sqlite.transaction(() => {
      env.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(Date.now(), SEED_PAPER_ID);
      clearPaperResultRaw(env.sqlite, SEED_PAPER_ID);
    })();
    release();
    // B-CX-2 (coordinator notes 추가 지시 4, Codex M-M2-2): the late result is not a success — terminal result_deleted
    // (no run.done), the row is cancelled + result_deleted (not ok), resultRaw stays NULL
    const ev = await all;
    expect(ev.filter((e) => e.event === 'run.done')).toEqual([]);
    expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'result_deleted', retryable: false } });
    expect(env.sqlite.prepare(`SELECT status, errorCode, resultRaw FROM llm_calls WHERE runId = ?`).get(h.runId)).toEqual({ status: 'cancelled', errorCode: 'result_deleted', resultRaw: null });
    expect(resultDeleted(await events(env.manager.runTask(defineReq(crid))))).toBe(true);
    env.close();
  });
});

describe('HTTP: deletion and disconnects', () => {
  let s: TestServer;
  afterEach(async () => {
    await s?.close();
  });
  const define = async (crid: string, term = 'robust kernel') => {
    const r = await s.req(`/api/papers/${SEED_PAPER_ID}/glossary/define`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ term, clientRequestId: crid }) });
    return { status: r.status, text: r.text };
  };
  const lastEvent = (text: string) => /event: (run\.[a-z_]+)\ndata: (.*)\n\n$/.exec(text);

  it('paper deleted (204): the same id → result_deleted and resultRaw NULL — immediately and while the deletion is deferred', async () => {
    const llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m1'], llm, deleteWaitMs: 100 });
    const crid = randomUUID();
    expect(lastEvent((await define(crid)).text)![1]).toBe('run.done');
    // a held run that ignores the abort keeps the deletion deferred
    const hold = llm.holdNext({ ignoreAbort: true });
    const stuck = s.req(`/api/papers/${SEED_PAPER_ID}/threads`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'chat', question: 'stuck', clientRequestId: randomUUID() }) });
    await hold.started;
    const del = await s.req(`/api/papers/${SEED_PAPER_ID}`, { method: 'DELETE', headers: { 'X-SP-Token': s.token } });
    expect(del.status).toBe(204);
    expect(s.deps.sqlite.prepare(`SELECT deletingAt IS NOT NULL AS t FROM papers WHERE id = ?`).get(SEED_PAPER_ID)).toEqual({ t: 1 });
    expect(s.deps.sqlite.prepare(`SELECT resultRaw FROM llm_calls WHERE clientRequestId = ?`).get(crid)).toEqual({ resultRaw: null });
    const m = lastEvent((await define(crid)).text)!;
    expect([m[1], (JSON.parse(m[2]!) as { code: string }).code]).toEqual(['run.error', 'result_deleted']);
    hold.release();
    await stuck;
    expect(llm.calls).toHaveLength(2);
  });

  it('a disconnect before run.done cancels the run (cancelOnDisconnect); the same id replays run.error{cancelled}, no new call', async () => {
    const llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m1'], llm });
    const crid = randomUUID();
    const hold = llm.holdNext();
    const ac = new AbortController();
    const req = fetch(`http://127.0.0.1:${s.port}/api/papers/${SEED_PAPER_ID}/glossary/define`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ term: 'robust kernel', clientRequestId: crid }), signal: ac.signal }).then((r) => r.text()).catch(() => '');
    await hold.started;
    ac.abort();
    await req;
    const deadline = Date.now() + 5_000;
    while ((s.deps.sqlite.prepare(`SELECT status FROM llm_calls WHERE clientRequestId = ?`).get(crid) as { status: string }).status !== 'cancelled' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    hold.release();
    const again = lastEvent((await define(crid)).text)!;
    expect([again[1], (JSON.parse(again[2]!) as { code: string }).code]).toEqual(['run.error', 'cancelled']);
    expect(llm.calls).toHaveLength(1);
    expect(s.deps.sqlite.prepare(`SELECT resultRaw FROM llm_calls WHERE clientRequestId = ?`).get(crid)).toEqual({ resultRaw: null });
  });
});
