// runs.findExisting — request id first (runContract rule 1a, PLAN_M2 D27/D31; BRIEF_S S6). Owner: supervisor.
// Golden hashes: computed by the tag-m1 code (plan_probes/r3b_identity_golden.mts → probe_output_r3b_identity.txt).
// They are constants here on purpose — never recomputed with M2 code.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import { HttpError } from '../../src/deps';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { legacyPayloadHash, payloadHash, PAYLOAD_HASH_V2 } from '../../src/llm/runManager';
import type { RunProbe, RunTaskInput } from '../../src/llm/runContract';
import { createIdentity, messageIdentity } from '../../src/routes/threads';
import { makeTestPngBase64 } from '../helpers/png';
import { startTestServer, type TestServer } from '../helpers/server';

const THREAD = '22222222-2222-4222-8222-222222222222';
const anchor = { kind: 'text' as const, quote: { exact: 'robust kernel', prefix: 'and a ', suffix: '.' }, position: { page: 1, start: 10, end: 23 }, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }] };
const GOLDEN = {
  chat: { hash: '4edfc26187099cb6f0e20a92b00b99198d398364a84069976f405d9396f882c5', task: 'chat' as const, threadId: undefined, identity: (deep?: boolean) => createIdentity(SEED_PAPER_ID, { kind: 'chat', question: 'golden question', ...(deep === undefined ? {} : { deep }) }, 'golden question') },
  explain: { hash: '75caefcc6d74406d9af69ba8c5f7ca4b96a349080535e2467aa061c434fe7a8b', task: 'explain_selection' as const, threadId: undefined, identity: (deep?: boolean) => createIdentity(SEED_PAPER_ID, { kind: 'explain', anchor, text: 'robust kernel', ...(deep === undefined ? {} : { deep }) }, undefined) },
  message: { hash: '2f8381ee1f691677bb5538e21d19d4b8e3cb067e5791afd3b74b2cd2472ae333', task: 'chat' as const, threadId: THREAD, identity: (deep?: boolean) => messageIdentity(THREAD, { text: 'golden follow-up', ...(deep === undefined ? {} : { deep }) }) },
  regenerate: { hash: '6a766d4eae7978b833219befdc4bd15466c57a50d0ba783533498ef1db07e74d', task: 'chat' as const, threadId: THREAD, identity: (deep?: boolean) => messageIdentity(THREAD, { text: 'golden follow-up', regenerate: true, ...(deep === undefined ? {} : { deep }) }) },
};

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer({ env: 'prod', seed: true });
});
afterAll(async () => {
  await s.close();
});
beforeEach(() => {
  s.deps.sqlite.prepare(`DELETE FROM llm_calls`).run();
});

function insertRow(o: { hash: string | null; task?: string; paperId?: string | null; threadId?: string | null; status?: string; errorCode?: string | null }): { runId: string; crid: string } {
  const runId = crypto.randomUUID();
  const crid = crypto.randomUUID();
  s.deps.sqlite
    .prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, threadId, model, effort, status, errorCode, acceptedAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?, 'opus', 'low', ?, ?, 1, 2)`)
    .run(runId, crid, o.hash, o.task ?? 'chat', o.paperId === undefined ? SEED_PAPER_ID : o.paperId, o.threadId ?? null, o.status ?? 'error', o.errorCode !== undefined ? o.errorCode : o.status === 'ok' ? null : 'cli_error');
  return { runId, crid };
}
const find = (p: RunProbe) => s.deps.runs.findExisting(p);
function conflict(f: () => unknown): HttpError {
  try {
    f();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('expected an HttpError');
}
async function events(h: { subscribe(): AsyncIterable<RunSseEvent> }): Promise<RunSseEvent[]> {
  const out: RunSseEvent[] = [];
  for await (const e of h.subscribe()) out.push(e);
  return out;
}

describe('findExisting', () => {
  it('unknown id → null', () => {
    expect(find({ clientRequestId: crypto.randomUUID(), paperId: SEED_PAPER_ID, identity: { route: 'x' } })).toBeNull();
  });

  it('M1 v1 row + the same legacy request (task given / omitted) → 409 payload_version with its runId; other inputs → plain 409', () => {
    const inputs = { selection: 'robust kernel', page: '1', question: undefined };
    const v1 = legacyPayloadHash({ task: 'explain_selection', clientRequestId: 'x', paperId: SEED_PAPER_ID, inputs } as RunTaskInput);
    const { runId, crid } = insertRow({ hash: v1, task: 'explain_selection' });
    const identity = createIdentity(SEED_PAPER_ID, { kind: 'explain', text: 'robust kernel' }, undefined);
    for (const legacy of [{ inputs, task: 'explain_selection' as const }, { inputs }]) {
      const e = conflict(() => find({ clientRequestId: crid, paperId: SEED_PAPER_ID, identity, legacy }));
      expect(e).toMatchObject({ status: 409, code: 'conflict', details: { reason: 'payload_version', runId } });
    }
    const other = conflict(() => find({ clientRequestId: crid, paperId: SEED_PAPER_ID, identity, legacy: { inputs: { ...inputs, selection: 'other' } } }));
    expect(other.status).toBe(409);
    expect(other.details).toBeUndefined();
    // without legacy the v1 row cannot be compared → plain 409
    expect(conflict(() => find({ clientRequestId: crid, paperId: SEED_PAPER_ID, identity })).details).toBeUndefined();
  });

  it('messages.create form: legacy task omitted → the row task; v1 hash includes the thread', () => {
    const inputs = { question: 'next', regenerate: undefined };
    const v1 = legacyPayloadHash({ task: 'chat', clientRequestId: 'x', paperId: SEED_PAPER_ID, threadId: THREAD, inputs } as RunTaskInput);
    const { runId, crid } = insertRow({ hash: v1, threadId: null });
    const e = conflict(() => find({ clientRequestId: crid, threadId: THREAD, identity: messageIdentity(THREAD, { text: 'next' }), legacy: { inputs } }));
    expect(e.details).toEqual({ reason: 'payload_version', runId });
  });

  it('unprefixed v2 row (M1.1) → attach (replay); v2: row → same identity attaches, another identity is a 409', async () => {
    const identity = GOLDEN.chat.identity();
    for (const stored of [GOLDEN.chat.hash, PAYLOAD_HASH_V2 + GOLDEN.chat.hash]) {
      const { runId, crid } = insertRow({ hash: stored, status: 'ok' });
      const h = find({ clientRequestId: crid, paperId: SEED_PAPER_ID, identity });
      expect(h).not.toBeNull();
      expect(h!.runId).toBe(runId);
      expect(h!.attached).toBe(true);
      expect((await events(h!))[0]).toMatchObject({ event: 'run.accepted', data: { runId } });
      expect(conflict(() => find({ clientRequestId: crid, paperId: SEED_PAPER_ID, identity: { ...identity, question: 'other' } })).status).toBe(409);
    }
  });

  it('probe.paperId omitted → the row paperId is used; a row whose paper is gone (NULL) replays by its row status without comparison (PLAN_M2 9절 67(c)): ok → result_deleted, cancelled → cancelled', async () => {
    const identity = GOLDEN.message.identity();
    const { runId, crid } = insertRow({ hash: PAYLOAD_HASH_V2 + GOLDEN.message.hash, status: 'ok' });
    expect(find({ clientRequestId: crid, threadId: THREAD, identity })!.runId).toBe(runId);
    // with a wrong explicit paperId the hash differs
    expect(conflict(() => find({ clientRequestId: crid, paperId: crypto.randomUUID(), threadId: THREAD, identity })).status).toBe(409);
    const gone = insertRow({ hash: PAYLOAD_HASH_V2 + GOLDEN.message.hash, paperId: null, status: 'ok' });
    const h = find({ clientRequestId: gone.crid, threadId: THREAD, identity: { anything: 'not compared' } });
    expect((await events(h!)).map((e) => e.event === 'run.error' ? e.data.code : e.event)).toEqual(['run.accepted', 'result_deleted']);
    // a cancelled row of a deleted paper answers its own status, not result_deleted (B-F3R1-01, m-M2-R2-1)
    const cancelled = insertRow({ hash: PAYLOAD_HASH_V2 + GOLDEN.message.hash, paperId: null, status: 'cancelled', errorCode: 'cancelled' });
    const hc = find({ clientRequestId: cancelled.crid, threadId: THREAD, identity: { anything: 'not compared' } });
    expect(hc!.runId).toBe(cancelled.runId);
    const ce = await events(hc!);
    expect(ce.map((e) => e.event === 'run.error' ? e.data.code : e.event)).toEqual(['run.accepted', 'cancelled']);
    expect(ce.some((e) => e.event === 'run.delta' || e.event === 'run.done')).toBe(false);
  });

  it('the request image is part of the hash; a stored capture (storedImagePngBase64) is not', () => {
    const a = makeTestPngBase64({ width: 10, height: 10 });
    const b = makeTestPngBase64({ width: 11, height: 10 });
    const base: RunTaskInput = { task: 'figure_area', clientRequestId: 'x', paperId: SEED_PAPER_ID, inputs: {}, identity: { route: 'threads.create', kind: 'figure' } };
    expect(payloadHash({ ...base, storedImagePngBase64: a })).toBe(payloadHash(base));
    expect(payloadHash({ ...base, imagePngBase64: a })).not.toBe(payloadHash(base));
    const { crid } = insertRow({ hash: payloadHash({ ...base, imagePngBase64: a }), task: 'figure_area', status: 'ok' });
    expect(find({ clientRequestId: crid, paperId: SEED_PAPER_ID, identity: base.identity!, imagePngBase64: a })).not.toBeNull();
    expect(conflict(() => find({ clientRequestId: crid, paperId: SEED_PAPER_ID, identity: base.identity!, imagePngBase64: b })).status).toBe(409);
  });

  it('imagePngBase64 and storedImagePngBase64 together throw — in payloadHash and in runTask for a new request id', () => {
    const a = makeTestPngBase64({ width: 10, height: 10 });
    const base: RunTaskInput = { task: 'figure_area', clientRequestId: crypto.randomUUID(), paperId: SEED_PAPER_ID, inputs: {}, identity: { route: 'threads.create', kind: 'figure' } };
    const both = { ...base, imagePngBase64: a, storedImagePngBase64: a };
    expect(() => payloadHash(both)).toThrow(/exclusive/);
    const before = (s.deps.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls`).get() as { n: number }).n;
    expect(() => s.deps.runTask({ ...both, startRows: { insert: () => ({}) } })).toThrow(/exclusive/);
    expect((s.deps.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls`).get() as { n: number }).n).toBe(before);
  });

  describe('deep and the M1 golden hashes (m-R2-3)', () => {
    for (const [name, g] of Object.entries(GOLDEN)) {
      it(`${name}: deep absent / false keep the golden hash; deep:true is another request`, async () => {
        const input = (deep?: boolean): RunTaskInput => ({ task: g.task, clientRequestId: 'x', paperId: SEED_PAPER_ID, ...(g.threadId ? { threadId: g.threadId } : {}), inputs: {}, identity: g.identity(deep) });
        expect(payloadHash(input())).toBe(PAYLOAD_HASH_V2 + g.hash);
        expect(payloadHash(input(false))).toBe(PAYLOAD_HASH_V2 + g.hash);
        expect(payloadHash(input(true))).not.toBe(PAYLOAD_HASH_V2 + g.hash);
        for (const stored of [g.hash, PAYLOAD_HASH_V2 + g.hash]) {
          const { runId, crid } = insertRow({ hash: stored, task: g.task, status: 'ok' });
          const probe = (deep?: boolean): RunProbe => ({ clientRequestId: crid, paperId: SEED_PAPER_ID, ...(g.threadId ? { threadId: g.threadId } : {}), identity: g.identity(deep) });
          expect(find(probe())!.runId).toBe(runId);
          expect(find(probe(false))!.runId).toBe(runId);
          expect(conflict(() => find(probe(true))).status).toBe(409);
        }
        // a row stored with deep:true and a probe without deep → 409
        const deepRow = insertRow({ hash: payloadHash(input(true)), task: g.task, status: 'ok' });
        expect(conflict(() => find({ clientRequestId: deepRow.crid, paperId: SEED_PAPER_ID, ...(g.threadId ? { threadId: g.threadId } : {}), identity: g.identity() })).status).toBe(409);
        expect(find({ clientRequestId: deepRow.crid, paperId: SEED_PAPER_ID, ...(g.threadId ? { threadId: g.threadId } : {}), identity: g.identity(true) })!.runId).toBe(deepRow.runId);
      });
    }
  });

  it('agrees with runTask (lookupExisting) on a live run: the same id attaches to the same run', async () => {
    const crid = crypto.randomUUID();
    const res = await s.req(`/api/papers/${SEED_PAPER_ID}/threads`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'chat', question: 'q live', clientRequestId: crid }) });
    expect(res.status).toBe(200);
    const runId = (s.deps.sqlite.prepare(`SELECT runId FROM llm_calls WHERE clientRequestId = ?`).get(crid) as { runId: string }).runId;
    const h = find({ clientRequestId: crid, paperId: SEED_PAPER_ID, identity: createIdentity(SEED_PAPER_ID, { kind: 'chat', question: 'q live' }, 'q live') });
    expect(h!.runId).toBe(runId);
    expect(conflict(() => find({ clientRequestId: crid, paperId: SEED_PAPER_ID, identity: createIdentity(SEED_PAPER_ID, { kind: 'chat', question: 'other' }, 'other') })).status).toBe(409);
  });
});
