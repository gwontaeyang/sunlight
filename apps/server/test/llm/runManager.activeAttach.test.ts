// B-CX-1 (Codex M-M2-1, coordinator notes 추가 지시 4, PLAN_M2 9절 56): a resend of a request id whose run is STILL
// RUNNING is checked like a finished one — the payload comparison first (different → 409), then the paper tombstone
// and the result owner (message / card row). When they are gone the in-memory log is not opened: the answer is
// run.accepted + run.error{result_deleted, retryable:false}, so text streamed before the deletion never reaches a new
// subscriber. runTask (lookupExisting) and the routes' findExisting probe share the one decision (existingHandle).
// Owner B.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { HttpError } from '../../src/deps';
import { PROMPT_VERSION } from '../../src/llm/runManager';
import type { RunTaskInput } from '../../src/llm/runContract';
import { defineIdentity } from '../../src/study/glossary';
import { startCardRows } from '../../src/study/paperCards';
import type { LlmAdapter, LlmEvent } from '../../src/llm/adapter';
import { GateAdapter, PRE_DELETE_TEXT } from './gateAdapter';
import { events, makeRunEnv, request, threadRows, type RunEnv } from './runEnv';

type Sink = 'card' | 'message' | 'suggestion';
type Removal = 'tombstone' | 'owner';

function inputOf(sink: Sink): { input: RunTaskInput; threadId: () => string | undefined; cardId: () => string | undefined } {
  const crid = randomUUID();
  if (sink === 'card') {
    const rows = startCardRows(SEED_PAPER_ID, 'notation', PROMPT_VERSION);
    let cardId: string | undefined;
    const input: RunTaskInput = {
      task: 'notation_card',
      clientRequestId: crid,
      paperId: SEED_PAPER_ID,
      inputs: {},
      identity: { route: 'cards.generate', paperId: SEED_PAPER_ID, kind: 'notation' },
      startRows: {
        insert: (tx, runId) => {
          const r = rows.insert(tx, runId);
          cardId = r.artifactId;
          return r;
        },
      },
    };
    return { input, threadId: () => undefined, cardId: () => cardId };
  }
  if (sink === 'message') {
    const rows = threadRows();
    const input = request({ clientRequestId: crid, identity: { route: 'test.explain', selection: 'We estimate the robot pose' }, startRows: rows });
    return { input, threadId: () => rows.ids.threadId, cardId: () => undefined };
  }
  const input: RunTaskInput = { task: 'glossary_define', clientRequestId: crid, paperId: SEED_PAPER_ID, inputs: { term: 'robust kernel' }, identity: defineIdentity(SEED_PAPER_ID, { term: 'robust kernel' }) };
  return { input, threadId: () => undefined, cardId: () => undefined };
}

function remove(env: RunEnv, sink: Sink, how: Removal, t: ReturnType<typeof inputOf>): void {
  if (how === 'tombstone') env.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(Date.now(), SEED_PAPER_ID);
  else if (sink === 'card') env.sqlite.prepare(`DELETE FROM paper_cards WHERE id = ?`).run(t.cardId()!);
  else if (sink === 'message') env.sqlite.prepare(`DELETE FROM threads WHERE id = ?`).run(t.threadId()!); // messages cascade
}

const resultDeletedOnly = (ev: RunSseEvent[], runId: string) => {
  expect(ev.map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
  expect(ev[0]!.data).toMatchObject({ runId });
  expect(ev[1]!.data).toEqual({ code: 'result_deleted', message: 'the result of this request no longer exists', retryable: false });
};

const CASES: [Sink, Removal][] = [
  ['card', 'tombstone'],
  ['card', 'owner'],
  ['message', 'tombstone'],
  ['message', 'owner'],
  ['suggestion', 'tombstone'],
];

describe('a running run whose result is gone: the same request id gets result_deleted, never the streamed text', () => {
  for (const [sink, how] of CASES) {
    it(`${sink} — ${how === 'tombstone' ? 'paper tombstoned' : `${sink} owner row deleted`} while the call runs: runTask and findExisting answer accepted + result_deleted`, async () => {
      const llm = new GateAdapter();
      const env = await makeRunEnv({ adapter: llm });
      const gate = llm.gateCall(1, { ignoreAbort: true });
      const t = inputOf(sink);
      const h = env.manager.runTask(t.input);
      const first = events(h);
      await gate.started;
      // before the deletion: an attach is the live log (it already holds the streamed delta)
      const before: RunSseEvent[] = [];
      for await (const e of env.manager.runTask(t.input).subscribe()) {
        before.push(e);
        if (e.event === 'run.delta') break;
      }
      expect(before.at(-1)).toEqual({ event: 'run.delta', data: { text: PRE_DELETE_TEXT } });
      remove(env, sink, how, t);
      const viaRunTask = events(env.manager.runTask(t.input));
      const viaProbe = events(env.manager.runs.findExisting({ clientRequestId: t.input.clientRequestId, paperId: SEED_PAPER_ID, identity: t.input.identity! })!);
      gate.release();
      resultDeletedOnly(await viaRunTask, h.runId);
      resultDeletedOnly(await viaProbe, h.runId);
      await first;
      expect(llm.calls).toHaveLength(1);
      env.close();
    });
  }

  it('the payload comparison stays first: a different payload under the same id → 409 even while the paper is tombstoned', async () => {
    const llm = new GateAdapter();
    const env = await makeRunEnv({ adapter: llm });
    const gate = llm.gateCall(1, { ignoreAbort: true });
    const t = inputOf('card');
    const h = env.manager.runTask(t.input);
    const first = events(h);
    await gate.started;
    remove(env, 'card', 'tombstone', t);
    const other = { ...t.input, identity: { route: 'cards.generate', paperId: SEED_PAPER_ID, kind: 'assumptions' } };
    let refused: unknown;
    try {
      env.manager.runTask(other);
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).status).toBe(409);
    expect(() => env.manager.runs.findExisting({ clientRequestId: t.input.clientRequestId, paperId: SEED_PAPER_ID, identity: other.identity })).toThrow(HttpError);
    gate.release();
    await first;
    env.close();
  });

  it('the owner still there: an attach while running follows the live log (delta included)', async () => {
    const llm = new GateAdapter();
    const env = await makeRunEnv({ adapter: llm });
    const gate = llm.gateCall(1, { ignoreAbort: true });
    const t = inputOf('message');
    const h = env.manager.runTask(t.input);
    const first = events(h);
    await gate.started;
    const attached = events(env.manager.runTask(t.input));
    gate.release();
    const a = await attached;
    expect(a.filter((e) => e.event === 'run.delta')[0]).toEqual({ event: 'run.delta', data: { text: PRE_DELETE_TEXT } });
    expect(a.at(-1)!.event).toBe('run.done');
    expect((await first).at(-1)!.event).toBe('run.done');
    env.close();
  });
});

// Codex probe "completion after explicit abort still emits done" (codex_probes/m2_review_probe.test.ts), attach part:
// after the tombstone and runs.cancel, an attach to the still-running run gets no delta and ends result_deleted.
it('Codex probe (attach part): tombstone + runs.cancel, the adapter ignores the abort → the attach has no run.delta and ends result_deleted', async () => {
  const { readMockOutput } = await import('@study-paper/shared/mock-outputs');
  const { EMPTY_USAGE } = await import('../../src/llm/adapter');
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
  const t = inputOf('card');
  const h = env.manager.runTask(t.input);
  const initial = events(h);
  await started;
  env.sqlite.prepare('UPDATE papers SET deletingAt = 1 WHERE id = ?').run(SEED_PAPER_ID);
  expect(env.manager.runs.cancel(h.runId)).toBe('cancelled');
  const activeReplay = events(env.manager.runTask(t.input));
  resume();
  const b = await activeReplay;
  expect(b.filter((x) => x.event === 'run.delta')).toEqual([]);
  resultDeletedOnly(b, h.runId);
  await initial;
  env.close();
});
