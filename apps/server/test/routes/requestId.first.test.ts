// Request id first (runContract rule 1a, PLAN_M2 D27, BRIEF_B B5) through the four routes that start runs. A known id
// is answered from its run BEFORE the owner lookup: deleted results replay run.accepted + run.error{result_deleted}
// (never 404 / context_not_ready), right after the deletion (the finished run is still in memory) and after a restart
// alike; a different payload is 409; M1 rows keep their 409 payload_version; deep enters the identity only when true.
// Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { SEED_M2_PAPER_ID, SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { payloadHash, PAYLOAD_HASH_V2 } from '../../src/llm/runManager';
import { createIdentity, messageIdentity } from '../../src/routes/threads';
import { makeTestPngBase64 } from '../helpers/png';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';

interface Res {
  status: number;
  json: unknown;
  events: SseEvent[];
}
let s: TestServer;
let llm: ControlledAdapter;
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
  return { status: r.status, json: type.includes('json') ? (JSON.parse(r.text) as unknown) : undefined, events };
}
const del = (path: string) => s.req(`/api${path}`, { method: 'DELETE', headers: { 'X-SP-Token': s.token } });
const count = (table: string) => (s.deps.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const accepted = (r: Res) => r.events[0]!.data as { runId: string; threadId?: string; messageId?: string };
const resultDeleted = (r: Res) => r.status === 200 && r.events.map((e) => e.event).join() === 'run.accepted,run.error' && (r.events[1]!.data as { code: string }).code === 'result_deleted';
async function start(papers: ('m1' | 'm2')[] = ['m1', 'm2'], deleteWaitMs?: number) {
  llm = new ControlledAdapter();
  s = await startTestServer({ env: 'prod', papers, llm, ...(deleteWaitMs !== undefined ? { deleteWaitMs } : {}) });
}
async function restart() {
  s = await s.restart();
}
/** Runs `check` right after the deletion and again after a restart: the same answer, nothing new. */
async function twice(f: () => Promise<Res>, check: (r: Res) => void) {
  for (const phase of ['memory', 'restart'] as const) {
    if (phase === 'restart') await restart();
    const before = { rows: count('llm_calls'), calls: llm.calls.length };
    check(await f());
    expect({ rows: count('llm_calls'), calls: llm.calls.length }, phase).toEqual(before);
  }
}

describe('owner deleted → result_deleted (memory and after a restart); another payload → 409; a new id → 404', () => {
  it('threads.create', async () => {
    await start();
    const T = randomUUID();
    const body = { kind: 'chat', question: 'q', clientRequestId: T };
    const r = await post(`/papers/${SEED_PAPER_ID}/threads`, body);
    expect((await del(`/threads/${accepted(r).threadId}`)).status).toBe(204);
    await twice(() => post(`/papers/${SEED_PAPER_ID}/threads`, body), (x) => expect(resultDeleted(x)).toBe(true));
    expect((await post(`/papers/${SEED_PAPER_ID}/threads`, { ...body, question: 'other' })).status).toBe(409);
  });

  it('messages.create: thread deleted → still compared (other text → 409, same → result_deleted); paper deleted → result_deleted without comparison; a new id → 404', async () => {
    await start(['m1', 'm2']);
    const chat = await post(`/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'chat', question: 'q', clientRequestId: randomUUID() });
    const tid = accepted(chat).threadId!;
    const M = randomUUID();
    expect((await post(`/threads/${tid}/messages`, { text: 'follow', clientRequestId: M })).events.at(-1)!.event).toBe('run.done');
    const M2 = randomUUID();
    expect((await post(`/threads/${tid}/messages`, { text: 'second', clientRequestId: M2 })).events.at(-1)!.event).toBe('run.done');
    expect((await del(`/threads/${tid}`)).status).toBe(204);
    await twice(() => post(`/threads/${tid}/messages`, { text: 'follow', clientRequestId: M }), (x) => expect(resultDeleted(x)).toBe(true));
    expect((await post(`/threads/${tid}/messages`, { text: 'other', clientRequestId: M })).status).toBe(409);
    expect((await post(`/threads/${tid}/messages`, { text: 'follow', clientRequestId: randomUUID() })).status).toBe(404);
    // the paper too: no comparison is possible any more (paperId NULL) → result_deleted even for another text
    expect((await del(`/papers/${SEED_M2_PAPER_ID}`)).status).toBe(204);
    await twice(() => post(`/threads/${tid}/messages`, { text: 'anything', clientRequestId: M2 }), (x) => expect(resultDeleted(x)).toBe(true));
  });

  it('cards.generate and glossary.define: paper tombstoned (deferred deletion) and deleted', async () => {
    await start(['m1', 'm2'], 100);
    const C = randomUUID();
    expect((await post(`/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, { clientRequestId: C })).events.at(-1)!.event).toBe('run.done');
    const D = randomUUID();
    expect((await post(`/papers/${SEED_M2_PAPER_ID}/glossary/define`, { term: 'robust kernel', clientRequestId: D })).events.at(-1)!.event).toBe('run.done');
    const hold = llm.holdNext({ ignoreAbort: true });
    const stuck = post(`/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'chat', question: 'stuck', clientRequestId: randomUUID() });
    await hold.started;
    expect((await del(`/papers/${SEED_M2_PAPER_ID}`)).status).toBe(204);
    expect(s.deps.sqlite.prepare(`SELECT deletingAt IS NOT NULL AS t FROM papers WHERE id = ?`).get(SEED_M2_PAPER_ID)).toEqual({ t: 1 });
    expect(resultDeleted(await post(`/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, { clientRequestId: C }))).toBe(true);
    expect(resultDeleted(await post(`/papers/${SEED_M2_PAPER_ID}/glossary/define`, { term: 'robust kernel', clientRequestId: D }))).toBe(true);
    expect((await post(`/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, { clientRequestId: randomUUID() })).status).toBe(404);
    hold.release();
    await stuck;
    await twice(() => post(`/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, { clientRequestId: C }), (x) => expect(resultDeleted(x)).toBe(true));
    await twice(() => post(`/papers/${SEED_M2_PAPER_ID}/glossary/define`, { term: 'robust kernel', clientRequestId: D }), (x) => expect(resultDeleted(x)).toBe(true));
    expect((await post(`/papers/${SEED_M2_PAPER_ID}/glossary/define`, { term: 'other', clientRequestId: D })).status).toBe(409);
  });

  it('threads.create and messages.create: paper tombstoned (deferred deletion) → result_deleted; after the deletion finishes, in memory and after a restart, the same (review B-R1-06 a)', async () => {
    await start(['m1', 'm2'], 100);
    const T = randomUUID();
    const create = { kind: 'chat', question: 'tomb q', clientRequestId: T };
    const chat = await post(`/papers/${SEED_M2_PAPER_ID}/threads`, create);
    expect(chat.events.at(-1)!.event).toBe('run.done');
    const tid = accepted(chat).threadId!;
    const M = randomUUID();
    const follow = { text: 'tomb follow', clientRequestId: M };
    expect((await post(`/threads/${tid}/messages`, follow)).events.at(-1)!.event).toBe('run.done');
    const hold = llm.holdNext({ ignoreAbort: true });
    const stuck = post(`/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'chat', question: 'stuck', clientRequestId: randomUUID() });
    await hold.started;
    expect((await del(`/papers/${SEED_M2_PAPER_ID}`)).status).toBe(204);
    expect(s.deps.sqlite.prepare(`SELECT deletingAt IS NOT NULL AS t FROM papers WHERE id = ?`).get(SEED_M2_PAPER_ID)).toEqual({ t: 1 });
    const before = { rows: count('llm_calls'), calls: llm.calls.length };
    expect(resultDeleted(await post(`/papers/${SEED_M2_PAPER_ID}/threads`, create))).toBe(true);
    expect(resultDeleted(await post(`/threads/${tid}/messages`, follow))).toBe(true);
    expect({ rows: count('llm_calls'), calls: llm.calls.length }).toEqual(before);
    // a new id during the tombstone → 404 (the paper is gone for new work)
    expect((await post(`/papers/${SEED_M2_PAPER_ID}/threads`, { ...create, clientRequestId: randomUUID() })).status).toBe(404);
    hold.release();
    await stuck;
    await twice(() => post(`/papers/${SEED_M2_PAPER_ID}/threads`, create), (x) => expect(resultDeleted(x)).toBe(true));
    await twice(() => post(`/threads/${tid}/messages`, follow), (x) => expect(resultDeleted(x)).toBe(true));
  });

  it('a failed run whose thread was deleted replays its code without partialText', async () => {
    await start(['m1']);
    const T = randomUUID();
    const hold = llm.holdNext();
    const req = post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'q', clientRequestId: T });
    await hold.started;
    const runId = (s.deps.sqlite.prepare(`SELECT runId FROM llm_calls WHERE clientRequestId = ?`).get(T) as { runId: string }).runId;
    s.deps.runs.cancel(runId);
    hold.release();
    const r = await req;
    expect(r.events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
    expect((await del(`/threads/${accepted(r).threadId}`)).status).toBe(204);
    await twice(
      () => post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'q', clientRequestId: T }),
      (x) => {
        expect(x.events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
        expect('partialText' in (x.events.at(-1)!.data as object)).toBe(false);
      },
    );
  });
});

describe('older rows and deep', () => {
  it('M1 v1 rows → 409 payload_version with that runId (threads.create and messages.create)', async () => {
    await start(['m1']);
    const chat = await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'base', clientRequestId: randomUUID() });
    const tid = accepted(chat).threadId!;
    const V = randomUUID();
    const W = randomUUID();
    const v1 = (task: string, threadId: string | null, inputs: Record<string, string | undefined>) =>
      payloadHash({ task: task as 'chat', clientRequestId: 'x', paperId: SEED_PAPER_ID, ...(threadId ? { threadId } : {}), inputs });
    s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, model, effort, status, acceptedAt) VALUES ('m1-a', ?, ?, 'chat', ?, 'opus', 'medium', 'ok', 1)`).run(V, v1('chat', null, { selection: undefined, page: undefined, question: 'old' }), SEED_PAPER_ID);
    s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, threadId, model, effort, status, acceptedAt) VALUES ('m1-b', ?, ?, 'chat', ?, ?, 'opus', 'medium', 'ok', 1)`).run(W, v1('chat', tid, { question: 'old follow-up', regenerate: undefined }), SEED_PAPER_ID, tid);
    const a = await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'old', clientRequestId: V });
    expect([a.status, (a.json as { error: { details: unknown } }).error.details]).toEqual([409, { reason: 'payload_version', runId: 'm1-a' }]);
    const b = await post(`/threads/${tid}/messages`, { text: 'old follow-up', clientRequestId: W });
    expect([b.status, (b.json as { error: { details: unknown } }).error.details]).toEqual([409, { reason: 'payload_version', runId: 'm1-b' }]);
  });

  it('M1 v2 hashes (prefixed and unprefixed): deep absent / false → attach (200, no new row); deep: true → 409', async () => {
    await start(['m1']);
    const chat = await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'base', clientRequestId: randomUUID() });
    const tid = accepted(chat).threadId!;
    const msgRun = accepted(chat).runId;
    for (const prefixed of [true, false]) {
      const C = randomUUID();
      const M = randomUUID();
      const body = { kind: 'chat' as const, question: 'stored by M1' };
      const createHash = payloadHash({ task: 'chat', clientRequestId: C, paperId: SEED_PAPER_ID, inputs: {}, identity: createIdentity(SEED_PAPER_ID, body, body.question) });
      const msgHash = payloadHash({ task: 'chat', clientRequestId: M, paperId: SEED_PAPER_ID, threadId: tid, inputs: {}, identity: messageIdentity(tid, { text: 'stored follow-up' }) });
      const strip = (h: string) => (prefixed ? h : h.slice(PAYLOAD_HASH_V2.length));
      s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, model, effort, status, errorCode, acceptedAt, finishedAt) VALUES (?, ?, ?, 'chat', ?, 'opus', 'low', 'error', 'cancelled', 1, 2)`).run(`c-${prefixed}`, C, strip(createHash), SEED_PAPER_ID);
      s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, threadId, model, effort, status, errorCode, acceptedAt, finishedAt) VALUES (?, ?, ?, 'chat', ?, ?, 'opus', 'low', 'error', 'cancelled', 1, 2)`).run(`m-${prefixed}`, M, strip(msgHash), SEED_PAPER_ID, tid);
      const rows = count('llm_calls');
      for (const deep of [undefined, false]) {
        const a = await post(`/papers/${SEED_PAPER_ID}/threads`, { ...body, ...(deep !== undefined ? { deep } : {}), clientRequestId: C });
        expect([a.status, accepted(a).runId]).toEqual([200, `c-${prefixed}`]);
        const b = await post(`/threads/${tid}/messages`, { text: 'stored follow-up', ...(deep !== undefined ? { deep } : {}), clientRequestId: M });
        expect([b.status, accepted(b).runId]).toEqual([200, `m-${prefixed}`]);
      }
      expect(count('llm_calls')).toBe(rows);
      expect((await post(`/papers/${SEED_PAPER_ID}/threads`, { ...body, deep: true, clientRequestId: C })).status).toBe(409);
      expect((await post(`/threads/${tid}/messages`, { text: 'stored follow-up', deep: true, clientRequestId: M })).status).toBe(409);
    }
    void msgRun;
  });
});

describe('deep and the S6 golden literals (route level, review B-R1-06 c)', () => {
  // The tag-m1 hashes of BRIEF_S S6 (test/contract/runs.findExisting.test.ts GOLDEN — computed by the m1 code,
  // never recomputed here): chat 'golden question' on SEED_PAPER_ID, follow-up 'golden follow-up' in THREAD.
  const GOLDEN_CHAT = '4edfc26187099cb6f0e20a92b00b99198d398364a84069976f405d9396f882c5';
  const GOLDEN_MESSAGE = '2f8381ee1f691677bb5538e21d19d4b8e3cb067e5791afd3b74b2cd2472ae333';
  const THREAD = '22222222-2222-4222-8222-222222222222';
  it('rows stored with the literal hashes (v2: prefixed and unprefixed): deep absent / false → attach (200, no new row); deep: true → 409', async () => {
    await start(['m1']);
    s.deps.sqlite.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES (?, ?, 'chat', 'golden', 1, 1)`).run(THREAD, SEED_PAPER_ID);
    for (const prefix of [PAYLOAD_HASH_V2, '']) {
      const C = randomUUID();
      const M = randomUUID();
      s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, model, effort, status, errorCode, acceptedAt, finishedAt) VALUES (?, ?, ?, 'chat', ?, 'opus', 'low', 'error', 'cancelled', 1, 2)`).run(`gc-${prefix}`, C, prefix + GOLDEN_CHAT, SEED_PAPER_ID);
      s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, threadId, model, effort, status, errorCode, acceptedAt, finishedAt) VALUES (?, ?, ?, 'chat', ?, ?, 'opus', 'low', 'error', 'cancelled', 1, 2)`).run(`gm-${prefix}`, M, prefix + GOLDEN_MESSAGE, SEED_PAPER_ID, THREAD);
      const rows = count('llm_calls');
      for (const deep of [undefined, false]) {
        const a = await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'golden question', ...(deep !== undefined ? { deep } : {}), clientRequestId: C });
        expect([a.status, accepted(a).runId], `${prefix} ${deep}`).toEqual([200, `gc-${prefix}`]);
        const b = await post(`/threads/${THREAD}/messages`, { text: 'golden follow-up', ...(deep !== undefined ? { deep } : {}), clientRequestId: M });
        expect([b.status, accepted(b).runId], `${prefix} ${deep}`).toEqual([200, `gm-${prefix}`]);
      }
      expect(count('llm_calls')).toBe(rows);
      expect((await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'golden question', deep: true, clientRequestId: C })).status).toBe(409);
      expect((await post(`/threads/${THREAD}/messages`, { text: 'golden follow-up', deep: true, clientRequestId: M })).status).toBe(409);
    }
  });
});

describe('a figure thread follow-up', () => {
  it('the same id and body → the same run (no 409: the stored image is not hashed); after the thread is deleted → result_deleted', async () => {
    await start(['m1']);
    const fig = await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'figure', anchor: { kind: 'area', rects: [{ page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.3 }] }, imagePng: makeTestPngBase64({ width: 40, height: 30 }), clientRequestId: randomUUID() });
    const tid = accepted(fig).threadId!;
    const Q = randomUUID();
    const q1 = await post(`/threads/${tid}/messages`, { text: 'and this?', clientRequestId: Q });
    expect(llm.calls.at(-1)!.tail[0]!.type).toBe('image');
    const q2 = await post(`/threads/${tid}/messages`, { text: 'and this?', clientRequestId: Q });
    expect([q2.status, accepted(q2).runId]).toEqual([200, accepted(q1).runId]);
    expect((await del(`/threads/${tid}`)).status).toBe(204);
    await twice(() => post(`/threads/${tid}/messages`, { text: 'and this?', clientRequestId: Q }), (x) => expect(resultDeleted(x)).toBe(true));
  });
});
