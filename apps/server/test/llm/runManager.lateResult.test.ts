// B-CX-2 (Codex M-M2-2, coordinator notes 추가 지시 4, PLAN_M2 9절 57): a result that arrives after its owner went or
// after a cancel request is not a success.
// - The sink's commit says `stored` or `owner_deleted` (commitCard null, commitSuggestion false, message owner missing).
//   owner_deleted → llm_calls is not `ok` (status `cancelled`, errorCode `result_deleted`) with the call's usage kept,
//   and the terminal is run.error{result_deleted, retryable:false} — no run.done. The first stream, an attach while it
//   runs and a replay after it ended (in memory and after a restart) all answer result_deleted.
// - A result after runs.cancel (the paper deletion's cancel included) is not stored: the run ends exactly like the
//   existing cancel path (the adapter's cancel error) — same terminal, same message / card status, same llm_calls status —
//   and the late call's usage is recorded.
// - Shutdown (lifecycle.begin → abortAll, then drain) is a cancel request too: a result that arrives while the server
//   drains is not stored either and ends exactly like the M1 shutdown path (cancelled / cancelled, contract
//   shutdown.test.ts), with its usage recorded (B-F2-03 — pinned until the coordinator decides otherwise).
// - Both for a first call and for the repair call of an SP-Blocks run.
// Owner B.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import { readMockFile, readMockManifest, readMockOutput } from '@study-paper/shared/mock-outputs';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { EMPTY_USAGE, type LlmAdapter, type LlmEvent } from '../../src/llm/adapter';
import { PROMPT_VERSION } from '../../src/llm/runManager';
import type { RunTaskInput } from '../../src/llm/runContract';
import { defineIdentity } from '../../src/study/glossary';
import { startCardRows } from '../../src/study/paperCards';
import { ControlledAdapter } from '../helpers/server';
import { GateAdapter, PRE_DELETE_TEXT, USAGE } from './gateAdapter';
import { events, makeRunEnv, request, terminalOf, threadRows, type RunEnv } from './runEnv';

type Sink = 'card' | 'message' | 'suggestion';
type Removal = 'tombstone' | 'owner';
const INVALID = readMockFile(readMockManifest().m2.blocksInvalid.notation_missing_key!.file);
const RESULT_DELETED = { event: 'run.error', data: { code: 'result_deleted', message: 'the result of this request no longer exists', retryable: false } };

function inputOf(sink: Sink) {
  const crid = randomUUID();
  if (sink === 'card') {
    const rows = startCardRows(SEED_PAPER_ID, 'notation', PROMPT_VERSION);
    const ids: { cardId?: string } = {};
    const input: RunTaskInput = {
      task: 'notation_card',
      clientRequestId: crid,
      paperId: SEED_PAPER_ID,
      inputs: {},
      identity: { route: 'cards.generate', paperId: SEED_PAPER_ID, kind: 'notation' },
      startRows: {
        insert: (tx, runId) => {
          const r = rows.insert(tx, runId);
          ids.cardId = r.artifactId;
          return r;
        },
      },
    };
    return { input, ids: () => ({ cardId: ids.cardId, threadId: undefined, messageId: undefined }) };
  }
  if (sink === 'message') {
    const rows = threadRows();
    const input = request({ clientRequestId: crid, identity: { route: 'test.explain' }, startRows: rows });
    return { input, ids: () => ({ cardId: undefined, threadId: rows.ids.threadId, messageId: rows.ids.messageId }) };
  }
  const input: RunTaskInput = { task: 'glossary_define', clientRequestId: crid, paperId: SEED_PAPER_ID, inputs: { term: 'robust kernel' }, identity: defineIdentity(SEED_PAPER_ID, { term: 'robust kernel' }) };
  return { input, ids: () => ({ cardId: undefined, threadId: undefined, messageId: undefined }) };
}
type Started = ReturnType<typeof inputOf>;

function remove(env: RunEnv, sink: Sink, how: Removal, t: Started): void {
  if (how === 'tombstone') env.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(Date.now(), SEED_PAPER_ID);
  else if (sink === 'card') env.sqlite.prepare(`DELETE FROM paper_cards WHERE id = ?`).run(t.ids().cardId!);
  else if (sink === 'message') env.sqlite.prepare(`DELETE FROM threads WHERE id = ?`).run(t.ids().threadId!);
}

type CallState = { status: string; errorCode: string | null; inputTokens: number | null; outputTokens: number | null; resultRaw: string | null; parentRunId: string | null };
const callRows = (env: RunEnv, runId: string) =>
  env.sqlite.prepare(`SELECT status, errorCode, inputTokens, outputTokens, resultRaw, parentRunId FROM llm_calls WHERE runId = ? OR parentRunId = ? ORDER BY parentRunId IS NOT NULL`).all(runId, runId) as CallState[];
const cardState = (env: RunEnv, id: string | undefined) =>
  id === undefined ? undefined : (env.sqlite.prepare(`SELECT status, errorCode, rawOutput, (SELECT count(*) FROM paper_card_items WHERE cardId = c.id) AS items FROM paper_cards c WHERE id = ?`).get(id) as { status: string; errorCode: string | null; rawOutput: string | null; items: number } | undefined);
const messageState = (env: RunEnv, id: string | undefined) => (id === undefined ? undefined : (env.sqlite.prepare(`SELECT status, contentMd FROM messages WHERE id = ?`).get(id) as { status: string; contentMd: string } | undefined));
const itemCount = (env: RunEnv) => (env.sqlite.prepare(`SELECT count(*) AS n FROM paper_card_items`).get() as { n: number }).n;
const noDone = (ev: RunSseEvent[]) => expect(ev.filter((e) => e.event === 'run.done')).toEqual([]);
const onlyDeleted = (ev: RunSseEvent[]) => {
  expect(ev.map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
  expect(ev[1]).toEqual(RESULT_DELETED);
};

/** Starts the run, waits for its gated call, applies `between`, attaches with the same id, releases; returns all. */
async function race(o: { sink: Sink; ignoreAbort: boolean; repair?: boolean; between: (env: RunEnv, t: Started, runId: string) => void }) {
  const llm = new GateAdapter();
  const env = await makeRunEnv({ adapter: llm });
  if (o.repair) llm.queueOutputs(INVALID);
  const gate = llm.gateCall(o.repair ? 2 : 1, { ignoreAbort: o.ignoreAbort });
  const t = inputOf(o.sink);
  const h = env.manager.runTask(t.input);
  const first = events(h);
  await gate.started;
  o.between(env, t, h.runId);
  const attached = events(env.manager.runTask(t.input));
  gate.release();
  const initial = await first;
  const attach = await attached;
  const replayMemory = await events(env.manager.runTask(t.input));
  const replayRestart = await events(env.restart().runTask(t.input));
  return { env, llm, t, runId: h.runId, initial, attach, replayMemory, replayRestart };
}

const OWNER_CASES: [Sink, Removal, boolean][] = [
  ['card', 'tombstone', false],
  ['card', 'owner', false],
  ['card', 'tombstone', true],
  ['message', 'tombstone', false],
  ['message', 'owner', false],
  ['suggestion', 'tombstone', false],
];

describe('owner deleted while the call runs (no cancel), the result arrives → result_deleted everywhere, not ok, usage kept', () => {
  for (const [sink, how, repair] of OWNER_CASES) {
    it(`${sink}${repair ? ' (repair call)' : ''} — ${how === 'tombstone' ? 'paper tombstoned' : 'owner row deleted'}`, async () => {
      const r = await race({ sink, ignoreAbort: true, repair, between: (env, t) => remove(env, sink, how, t) });
      const { env } = r;
      // the first stream: one terminal, result_deleted, no run.done (the streamed delta was sent before the deletion)
      expect(terminalOf(r.initial)).toEqual([RESULT_DELETED]);
      noDone(r.initial);
      // an attach while it ran, and the replays after it ended: the same terminal, no streamed text
      for (const ev of [r.attach, r.replayMemory, r.replayRestart]) onlyDeleted(ev);
      // the DB: no row is ok; the usage of the call that produced the late result is kept
      const rows = callRows(env, r.runId);
      expect(rows).toHaveLength(repair ? 2 : 1);
      for (const row of rows) expect(row).toMatchObject({ status: 'cancelled', errorCode: 'result_deleted', resultRaw: null });
      expect(rows.at(-1)).toMatchObject({ inputTokens: USAGE.inputTokens, outputTokens: USAGE.outputTokens });
      expect(itemCount(env)).toBe(0);
      const ids = r.t.ids();
      if (sink === 'card' && how === 'tombstone') expect(cardState(env, ids.cardId)).toEqual({ status: 'error', errorCode: 'result_deleted', rawOutput: null, items: 0 });
      if (sink === 'message' && how === 'tombstone') expect(messageState(env, ids.messageId)?.status).not.toBe('complete');
      expect(r.llm.calls).toHaveLength(repair ? 2 : 1);
      env.close();
    });
  }
});

const CANCEL_CASES: [Sink, boolean][] = [
  ['card', false],
  ['card', true],
  ['message', false],
  ['suggestion', false],
];

describe('runs.cancel, then the result arrives anyway → the same end as the cancel path (owner still there); usage kept', () => {
  for (const [sink, repair] of CANCEL_CASES) {
    it(`${sink}${repair ? ' (repair call)' : ''}`, async () => {
      const cancel = (env: RunEnv, _t: Started, runId: string) => expect(env.manager.runs.cancel(runId)).toBe('cancelled');
      const honest = await race({ sink, ignoreAbort: false, repair, between: cancel });
      const late = await race({ sink, ignoreAbort: true, repair, between: cancel });
      const term = (ev: RunSseEvent[]) => terminalOf(ev);
      expect(term(honest.initial)).toEqual([{ event: 'run.error', data: { code: 'cancelled', message: 'cancelled', retryable: false, partialText: PRE_DELETE_TEXT } }]);
      // the first stream and the attach (the owner is still there: the live log) end like the cancel path
      expect(term(late.initial)).toEqual(term(honest.initial));
      expect(term(late.attach)).toEqual(term(honest.initial));
      noDone(late.initial);
      noDone(late.attach);
      // replays after the run ended: the same answer as the cancel path's
      expect(term(late.replayMemory)).toEqual(term(honest.replayMemory));
      expect(term(late.replayRestart)).toEqual(term(honest.replayRestart));
      expect(term(late.replayMemory)[0]).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
      // DB: the same statuses as the cancel path; the late call's usage is recorded
      const strip = (rows: CallState[]) => rows.map(({ status, errorCode, resultRaw }) => ({ status, errorCode, resultRaw }));
      expect(strip(callRows(late.env, late.runId))).toEqual(strip(callRows(honest.env, honest.runId)));
      for (const row of callRows(late.env, late.runId)) expect(row).toMatchObject({ status: 'cancelled', errorCode: 'cancelled', resultRaw: null });
      expect(callRows(late.env, late.runId).at(-1)).toMatchObject({ inputTokens: USAGE.inputTokens, outputTokens: USAGE.outputTokens });
      expect(cardState(late.env, late.t.ids().cardId)).toEqual(cardState(honest.env, honest.t.ids().cardId));
      expect(messageState(late.env, late.t.ids().messageId)).toEqual(messageState(honest.env, honest.t.ids().messageId));
      if (sink === 'card') expect(cardState(late.env, late.t.ids().cardId)).toMatchObject({ status: 'error', errorCode: 'cancelled', items: 0 });
      if (sink === 'message') expect(messageState(late.env, late.t.ids().messageId)).toEqual({ status: 'cancelled', contentMd: PRE_DELETE_TEXT });
      expect(itemCount(late.env)).toBe(0);
      honest.env.close();
      late.env.close();
    });
  }

  it('the paper deletion cancel (tombstone + runs.cancel): the first stream ends cancelled like the cancel path, an attach meanwhile result_deleted', async () => {
    const between = (env: RunEnv, t: Started, runId: string) => {
      remove(env, 'card', 'tombstone', t);
      expect(env.manager.runs.cancel(runId)).toBe('cancelled');
    };
    const honest = await race({ sink: 'card', ignoreAbort: false, between });
    const late = await race({ sink: 'card', ignoreAbort: true, between });
    expect(terminalOf(late.initial)).toEqual(terminalOf(honest.initial));
    expect(terminalOf(late.initial)[0]).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
    onlyDeleted(late.attach);
    expect(terminalOf(late.replayMemory)).toEqual(terminalOf(honest.replayMemory));
    expect(terminalOf(late.replayRestart)).toEqual(terminalOf(honest.replayRestart));
    expect(callRows(late.env, late.runId)[0]).toMatchObject({ status: 'cancelled', errorCode: 'cancelled', outputTokens: USAGE.outputTokens });
    expect(itemCount(late.env)).toBe(0);
    honest.env.close();
    late.env.close();
  });
});

describe('shutdown (lifecycle abort + drain), then the result arrives anyway → the same end as the shutdown cancel path; usage kept (B-F2-03)', () => {
  for (const [sink, repair] of CANCEL_CASES) {
    it(`${sink}${repair ? ' (repair call)' : ''}`, async () => {
      const drains: Promise<{ name: string; ok: boolean; activeAfter: number }[]>[] = [];
      const shutdown = (env: RunEnv) => {
        env.lifecycle.begin();
        drains.push(env.lifecycle.drain(10_000) as Promise<{ name: string; ok: boolean; activeAfter: number }[]>);
      };
      const honest = await race({ sink, ignoreAbort: false, repair, between: shutdown });
      const late = await race({ sink, ignoreAbort: true, repair, between: shutdown });
      for (const reports of await Promise.all(drains)) expect(reports).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'llm-runs', ok: true, activeAfter: 0 })]));
      const term = (ev: RunSseEvent[]) => terminalOf(ev);
      expect(term(honest.initial)).toEqual([{ event: 'run.error', data: { code: 'cancelled', message: 'cancelled', retryable: false, partialText: PRE_DELETE_TEXT } }]);
      // the first stream, the attach during the drain and the replays: the same answer as the shutdown cancel path
      for (const k of ['initial', 'attach', 'replayMemory', 'replayRestart'] as const) {
        expect(term(late[k]), k).toEqual(term(honest[k]));
        noDone(late[k]);
      }
      // DB: cancelled / cancelled like M1's shutdown contract, the stored result is nothing; the late call's usage is kept
      const strip = (rows: CallState[]) => rows.map(({ status, errorCode, resultRaw }) => ({ status, errorCode, resultRaw }));
      expect(strip(callRows(late.env, late.runId))).toEqual(strip(callRows(honest.env, honest.runId)));
      for (const row of callRows(late.env, late.runId)) expect(row).toMatchObject({ status: 'cancelled', errorCode: 'cancelled', resultRaw: null });
      expect(callRows(late.env, late.runId).at(-1)).toMatchObject({ inputTokens: USAGE.inputTokens, outputTokens: USAGE.outputTokens });
      expect(cardState(late.env, late.t.ids().cardId)).toEqual(cardState(honest.env, honest.t.ids().cardId));
      expect(messageState(late.env, late.t.ids().messageId)).toEqual(messageState(honest.env, honest.t.ids().messageId));
      if (sink === 'card') expect(cardState(late.env, late.t.ids().cardId)).toMatchObject({ status: 'error', errorCode: 'cancelled', items: 0 });
      if (sink === 'message') expect(messageState(late.env, late.t.ids().messageId)).toEqual({ status: 'cancelled', contentMd: PRE_DELETE_TEXT });
      expect(itemCount(late.env)).toBe(0);
      honest.env.close();
      late.env.close();
    });
  }
});

// The two run-manager scenarios of the Codex probe (codex_probes/m2_review_probe.test.ts), expectations reversed as
// decided (추가 지시 4 B-CX-2).
describe('Codex probe scenarios, reversed', () => {
  it('late card completion after tombstone (ControlledAdapter.holdNext ignoreAbort): no run.done anywhere, the run is not ok', async () => {
    const adapter = new ControlledAdapter();
    const env = await makeRunEnv({ adapter });
    const hold = adapter.holdNext({ ignoreAbort: true });
    const id = randomUUID();
    const input = { task: 'notation_card' as const, clientRequestId: id, paperId: SEED_PAPER_ID, inputs: {}, identity: { route: 'cards.generate', paperId: SEED_PAPER_ID, kind: 'notation' }, startRows: startCardRows(SEED_PAPER_ID, 'notation', PROMPT_VERSION) };
    const h = env.manager.runTask(input);
    const first = events(h);
    await hold.started;
    env.sqlite.prepare('UPDATE papers SET deletingAt=1 WHERE id=?').run(SEED_PAPER_ID);
    const activeReplay = events(env.manager.runTask(input));
    hold.release();
    const result = await first;
    const row = env.sqlite.prepare('SELECT status FROM llm_calls WHERE runId=?').get(h.runId) as { status: string };
    const cards = env.sqlite.prepare('SELECT status FROM paper_cards').all() as { status: string }[];
    const active = await activeReplay;
    const replay = await events(env.manager.runTask(input));
    expect(result.at(-1)).toEqual(RESULT_DELETED);
    expect(active.at(-1)).toEqual(RESULT_DELETED);
    expect(row.status).not.toBe('ok');
    expect(cards.map((c) => c.status)).not.toContain('generating');
    expect(replay.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'result_deleted' } });
    env.close();
  });

  it('completion after explicit abort (tombstone + runs.cancel, the adapter ignores the abort): no run.done, the first stream ends cancelled, the attach result_deleted without deltas', async () => {
    let resume!: () => void;
    let begun!: () => void;
    const wait = new Promise<void>((r) => (resume = r));
    const started = new Promise<void>((r) => (begun = r));
    const adapter: LlmAdapter = {
      mode: 'mock',
      async *run(): AsyncGenerator<LlmEvent> {
        yield { type: 'started', modelResolved: 'mock', cliVersion: 'mock' };
        yield { type: 'text', delta: 'PRE_DELETE_MODEL_TEXT' };
        begun();
        await wait;
        yield { type: 'result', text: readMockOutput('notation_card'), usage: EMPTY_USAGE };
      },
      health: async () => ({ cliFound: true, cliVersion: 'mock', loggedIn: null, detail: null }),
    };
    const env = await makeRunEnv({ adapter });
    const input = { task: 'notation_card' as const, clientRequestId: randomUUID(), paperId: SEED_PAPER_ID, inputs: {}, identity: { route: 'cards.generate', paperId: SEED_PAPER_ID, kind: 'notation' }, startRows: startCardRows(SEED_PAPER_ID, 'notation', PROMPT_VERSION) };
    const h = env.manager.runTask(input);
    const initial = events(h);
    await started;
    env.sqlite.prepare('UPDATE papers SET deletingAt=1 WHERE id=?').run(SEED_PAPER_ID);
    const cancelled = env.manager.runs.cancel(h.runId);
    const activeReplay = events(env.manager.runTask(input));
    resume();
    const a = await initial;
    const b = await activeReplay;
    expect(cancelled).toBe('cancelled');
    noDone(a);
    expect(a.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled', partialText: 'PRE_DELETE_MODEL_TEXT' } });
    noDone(b);
    expect(b.filter((x) => x.event === 'run.delta')).toEqual([]);
    expect(b.at(-1)).toEqual(RESULT_DELETED);
    expect(env.sqlite.prepare('SELECT status, errorCode FROM llm_calls WHERE runId = ?').get(h.runId)).toEqual({ status: 'cancelled', errorCode: 'cancelled' });
    env.close();
  });
});

describe('a normal result still commits before run.done', () => {
  it('message, card and suggestion: run.done, ok rows, nothing else changed', async () => {
    for (const sink of ['message', 'card', 'suggestion'] as const) {
      const env = await makeRunEnv({ adapter: new GateAdapter() });
      const t = inputOf(sink);
      const h = env.manager.runTask(t.input);
      const ev = await events(h);
      expect(terminalOf(ev).map((e) => e.event), sink).toEqual(['run.done']);
      expect(callRows(env, h.runId), sink).toEqual([expect.objectContaining({ status: 'ok', errorCode: null, outputTokens: USAGE.outputTokens })]);
      if (sink === 'card') expect(cardState(env, t.ids().cardId)?.status).toBe('complete');
      if (sink === 'message') expect(messageState(env, t.ids().messageId)?.status).toBe('complete');
      env.close();
    }
  });
});
