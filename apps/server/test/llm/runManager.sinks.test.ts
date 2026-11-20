// Card sink (PLAN_M2 3.4, BRIEF_B B5): run.done only after the card commit, a failed commit → one persist_failed and a
// card in `error`, a deleted owner gets nothing, a new request id during generation → 409 card_generating (also for a
// unique-index conflict), a stale `generating` row is replaced, replays after evict / restart, replace-on-success
// (success / failure / cancel) and the userNote carry-over. Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMockFile, readMockManifest, readMockOutput } from '@study-paper/shared/mock-outputs';
import { paperCards } from '../../src/db/schema';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { HttpError } from '../../src/deps';
import { PROMPT_VERSION } from '../../src/llm/runManager';
import { defineIdentity } from '../../src/study/glossary';
import { startCardRows, type CardStartHooks } from '../../src/study/paperCards';
import { ControlledAdapter } from '../helpers/server';
import { events, makeRunEnv, terminalOf, type RunEnv } from './runEnv';

const faults = vi.hoisted(() => ({ commit: false, suggestion: false }));
vi.mock('../../src/study/paperCards', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/study/paperCards')>();
  return {
    ...m,
    commitCard: ((...a: Parameters<typeof m.commitCard>) => {
      if (faults.commit) throw new Error('injected commit failure');
      return m.commitCard(...a);
    }) as typeof m.commitCard,
  };
});
vi.mock('../../src/study/glossary', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/study/glossary')>();
  return {
    ...m,
    commitSuggestion: ((...a: Parameters<typeof m.commitSuggestion>) => {
      if (faults.suggestion) throw new Error('injected commit failure');
      return m.commitSuggestion(...a);
    }) as typeof m.commitSuggestion,
  };
});
afterEach(() => {
  faults.commit = false;
  faults.suggestion = false;
});

type Sql = RunEnv['sqlite'];
const INVALID = readMockFile(readMockManifest().m2.blocksInvalid.notation_missing_key!.file);
const card = (sqlite: Sql, id: string) => sqlite.prepare(`SELECT id, status, errorCode, llmCallId FROM paper_cards WHERE id = ?`).get(id) as { id: string; status: string; errorCode: string | null; llmCallId: string } | undefined;
const items = (sqlite: Sql, id: string) => (sqlite.prepare(`SELECT count(*) AS n FROM paper_card_items WHERE cardId = ?`).get(id) as { n: number }).n;
const count = (sqlite: Sql, table: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function startCard(env: RunEnv, o: { crid?: string; hooks?: CardStartHooks } = {}) {
  const rows = startCardRows(SEED_PAPER_ID, 'notation', PROMPT_VERSION, o.hooks);
  let cardId = '';
  const h = env.manager.runTask({
    task: 'notation_card',
    clientRequestId: o.crid ?? randomUUID(),
    paperId: SEED_PAPER_ID,
    inputs: {},
    identity: { route: 'cards.generate', paperId: SEED_PAPER_ID, kind: 'notation' },
    startRows: {
      insert: (tx, runId) => {
        const r = rows.insert(tx, runId);
        cardId = r.artifactId!;
        return r;
      },
    },
  });
  return { h, cardId: () => cardId };
}
const refusal = (f: () => unknown): HttpError => {
  try {
    f();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('not refused');
};

describe('card sink: commit, failure, owner gone', () => {
  it('run.done comes after the commit: when it arrives the card is complete with its 11 items; accepted carries artifactId', async () => {
    const env = await makeRunEnv({ adapter: new ControlledAdapter() });
    const { h, cardId } = startCard(env);
    const seen: string[] = [];
    for await (const e of h.subscribe()) {
      if (e.event === 'run.accepted') expect(e.data.artifactId).toBe(cardId());
      if (e.event === 'run.done') {
        seen.push(card(env.sqlite, cardId())!.status);
        expect(items(env.sqlite, cardId())).toBe(11);
      }
    }
    expect(seen).toEqual(['complete']);
    env.close();
  });

  it('a failing commit → exactly one persist_failed, the card is `error` with errorCode persist_failed, no items', async () => {
    const env = await makeRunEnv({ adapter: new ControlledAdapter() });
    faults.commit = true;
    const { h, cardId } = startCard(env);
    const ev = await events(h);
    expect(terminalOf(ev)).toHaveLength(1);
    expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'persist_failed' } });
    expect(card(env.sqlite, cardId())).toMatchObject({ status: 'error', errorCode: 'persist_failed' });
    expect(items(env.sqlite, cardId())).toBe(0);
    env.close();
  });

  it('the card row deleted, or the paper tombstoned, while the call runs → nothing is inserted', async () => {
    for (const remove of ['card', 'tombstone'] as const) {
      const llm = new ControlledAdapter();
      const env = await makeRunEnv({ adapter: llm });
      const hold = llm.holdNext();
      const { h, cardId } = startCard(env);
      const all = events(h);
      await hold.started;
      if (remove === 'card') env.sqlite.prepare(`DELETE FROM paper_cards WHERE id = ?`).run(cardId());
      else env.sqlite.prepare(`UPDATE papers SET deletingAt = 1 WHERE id = ?`).run(SEED_PAPER_ID);
      hold.release();
      const ev = await all;
      expect(terminalOf(ev), remove).toHaveLength(1);
      expect(count(env.sqlite, 'paper_card_items'), remove).toBe(0);
      expect((env.sqlite.prepare(`SELECT count(*) AS n FROM citations WHERE ownerType = 'paper_card_item'`).get() as { n: number }).n, remove).toBe(0);
      env.close();
    }
  });
});

describe('a card in progress and a new request id (D22)', () => {
  it('409 card_generating with the first run and its card; no row, no adapter call', async () => {
    const llm = new ControlledAdapter();
    const env = await makeRunEnv({ adapter: llm });
    const hold = llm.holdNext();
    const first = startCard(env);
    const all = events(first.h);
    await hold.started;
    const before = { calls: count(env.sqlite, 'llm_calls'), cards: count(env.sqlite, 'paper_cards'), adapter: llm.calls.length };
    const e = refusal(() => startCard(env));
    expect([e.status, e.code]).toEqual([409, 'conflict']);
    expect(e.details).toEqual({ reason: 'card_generating', runId: first.h.runId, cardId: first.cardId() });
    expect({ calls: count(env.sqlite, 'llm_calls'), cards: count(env.sqlite, 'paper_cards'), adapter: llm.calls.length }).toEqual(before);
    hold.release();
    await all;
    env.close();
  });

  it('a unique-index conflict at the INSERT (a concurrent start injected) → the same 409, not 500 / "clientRequestId was already used"', async () => {
    const llm = new ControlledAdapter();
    const env = await makeRunEnv({ adapter: llm });
    // a live run of another start (its row and its generating card appear between the check and the INSERT)
    env.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, task, paperId, model, effort, status, acceptedAt) VALUES ('other-run', ?, 'notation_card', ?, 'fable', 'high', 'running', 1)`).run(randomUUID(), SEED_PAPER_ID);
    const before = { calls: count(env.sqlite, 'llm_calls'), cards: count(env.sqlite, 'paper_cards') };
    const e = refusal(() =>
      startCard(env, {
        hooks: { beforeInsert: (tx) => void tx.insert(paperCards).values({ id: 'other-card', paperId: SEED_PAPER_ID, kind: 'notation', status: 'generating', llmCallId: 'other-run', createdAt: 1 }).run() },
      }),
    );
    expect([e.status, e.details]).toEqual([409, { reason: 'card_generating', runId: 'other-run', cardId: 'other-card' }]);
    expect({ calls: count(env.sqlite, 'llm_calls'), cards: count(env.sqlite, 'paper_cards') }).toEqual(before); // the start rolled back
    expect(llm.calls).toHaveLength(0);
    env.close();
  });

  it('a generating row whose run is already terminal does not block: it is replaced and a new run starts', async () => {
    const env = await makeRunEnv({ adapter: new ControlledAdapter() });
    env.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, task, paperId, model, effort, status, acceptedAt) VALUES ('dead-run', ?, 'notation_card', ?, 'fable', 'high', 'interrupted', 1)`).run(randomUUID(), SEED_PAPER_ID);
    env.sqlite.prepare(`INSERT INTO paper_cards (id, paperId, kind, status, llmCallId, createdAt) VALUES ('stale', ?, 'notation', 'generating', 'dead-run', 1)`).run(SEED_PAPER_ID);
    const { h, cardId } = startCard(env);
    expect((await events(h)).at(-1)!.event).toBe('run.done');
    expect(card(env.sqlite, 'stale')?.status ?? 'gone').not.toBe('generating');
    expect(card(env.sqlite, cardId())!.status).toBe('complete');
    env.close();
  });
});

describe('replay of a finished card run', () => {
  it('the same id after an eviction and after a restart → run.accepted + run.done from the stored output, no new call', async () => {
    const llm = new ControlledAdapter();
    const env = await makeRunEnv({ adapter: llm, deps: { retention: { max: 0, ms: 60_000 } } });
    const crid = randomUUID();
    const first = startCard(env, { crid });
    const ev = await events(first.h);
    const done = ev.at(-1)!;
    for (const manager of [env.manager, env.restart({ adapter: llm })]) {
      const again = manager.runTask({ task: 'notation_card', clientRequestId: crid, paperId: SEED_PAPER_ID, inputs: {}, identity: { route: 'cards.generate', paperId: SEED_PAPER_ID, kind: 'notation' }, startRows: startCardRows(SEED_PAPER_ID, 'notation', PROMPT_VERSION) });
      const r = await events(again);
      expect(r.map((e) => e.event)).toEqual(['run.accepted', 'run.done']);
      expect(r[0]).toMatchObject({ data: { runId: first.h.runId, artifactId: first.cardId() } });
      expect((r[1]!.data as { parsed: unknown }).parsed).toEqual((done.data as { parsed: unknown }).parsed);
    }
    expect(llm.calls).toHaveLength(1);
    env.close();
  });
});

describe('replace-on-success', () => {
  it('success: the previous card goes, its run is superseded (replay says so); notation userNote carries over by key, confirmed starts false', async () => {
    const env = await makeRunEnv({ adapter: new ControlledAdapter() });
    const a = startCard(env);
    await events(a.h);
    env.sqlite.prepare(`UPDATE paper_card_items SET userNote = 'my note', confirmed = 1 WHERE cardId = ? AND key = 'units'`).run(a.cardId());
    const b = startCard(env);
    expect((await events(b.h)).at(-1)!.event).toBe('run.done');
    expect(card(env.sqlite, a.cardId())).toBeUndefined();
    expect(env.sqlite.prepare(`SELECT status, errorCode FROM llm_calls WHERE runId = ?`).get(a.h.runId)).toEqual({ status: 'ok', errorCode: 'superseded' });
    expect(env.sqlite.prepare(`SELECT userNote, confirmed FROM paper_card_items WHERE cardId = ? AND key = 'units'`).get(b.cardId())).toEqual({ userNote: 'my note', confirmed: 0 });
    const crid = (env.sqlite.prepare(`SELECT clientRequestId FROM llm_calls WHERE runId = ?`).get(a.h.runId) as { clientRequestId: string }).clientRequestId;
    const replay = await events(startCard(env, { crid }).h);
    expect(replay.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'superseded' } });
    env.close();
  });

  it('failure (parse_failed) and cancel: the previous complete card stays as it was', async () => {
    const llm = new ControlledAdapter();
    const env = await makeRunEnv({ adapter: llm });
    const a = startCard(env);
    await events(a.h);
    llm.queueOutputs(INVALID, INVALID);
    const failed = startCard(env);
    expect((await events(failed.h)).at(-1)).toMatchObject({ event: 'run.error', data: { code: 'parse_failed' } });
    expect(card(env.sqlite, a.cardId())).toMatchObject({ status: 'complete' });
    expect(items(env.sqlite, a.cardId())).toBe(11);
    // the failed row is removed when the next generation starts
    const hold = llm.holdNext();
    const cancelled = startCard(env);
    expect(card(env.sqlite, failed.cardId())).toBeUndefined();
    const all = events(cancelled.h);
    await hold.started;
    cancelled.h.cancel();
    expect((await all).at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
    expect(card(env.sqlite, a.cardId())).toMatchObject({ status: 'complete' });
    expect(card(env.sqlite, cancelled.cardId())).toMatchObject({ status: 'error', errorCode: 'cancelled' });
    expect(env.sqlite.prepare(`SELECT errorCode FROM llm_calls WHERE runId = ?`).get(a.h.runId)).toEqual({ errorCode: null });
    void readMockOutput;
    env.close();
  });
});

// The suggestion sink (glossary_define, D29): its owner-deleted and cancel paths are in glossary.define.replay.test.ts
// (tombstone, deletion, disconnect before run.done); the commit failure is here (review B-R1-06 b).
describe('suggestion sink: a failing commit', () => {
  it('exactly one persist_failed, resultRaw stays NULL, and the replay (memory, eviction, restart) says persist_failed with no new call', async () => {
    const llm = new ControlledAdapter();
    const env = await makeRunEnv({ adapter: llm, deps: { retention: { max: 5, ms: 60_000 } } });
    const crid = randomUUID();
    const req = () => ({ task: 'glossary_define' as const, clientRequestId: crid, paperId: SEED_PAPER_ID, inputs: { term: 'robust kernel' }, identity: defineIdentity(SEED_PAPER_ID, { term: 'robust kernel' }) });
    faults.suggestion = true;
    const ev = await events(env.manager.runTask(req()));
    faults.suggestion = false;
    expect(terminalOf(ev)).toEqual([expect.objectContaining({ event: 'run.error', data: expect.objectContaining({ code: 'persist_failed' }) })]);
    expect(env.sqlite.prepare(`SELECT status, errorCode, resultRaw FROM llm_calls WHERE clientRequestId = ?`).get(crid)).toEqual({ status: 'error', errorCode: 'persist_failed', resultRaw: null });
    const replays = [await events(env.manager.runTask(req())), await events(env.restart({ adapter: llm }).runTask(req()))];
    for (const r of replays) {
      expect(terminalOf(r)).toHaveLength(1);
      expect(terminalOf(r)[0]).toMatchObject({ event: 'run.error', data: { code: 'persist_failed' } });
    }
    expect(llm.calls).toHaveLength(1);
    expect(count(env.sqlite, 'llm_calls')).toBe(1);
    env.close();
  });
});
