// Review B3 / M2 / M4 at the run-manager level: run.done only after the result transaction committed, exactly one
// terminal event on any failure between the adapter's result and the commit, output before a safe init never
// reaches the stream, and a regenerate (replaces / discardOnFailure) never destroys the old turn before success.
// Real run manager + ClaudeCliAdapter + fake-claude (strict). Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import { openSqlite, toDrizzle } from '../../src/db/client';
import { messages } from '../../src/db/schema';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import type { RunTaskRequest } from '../../src/llm/runManager';
import { startupRecovery } from '../../src/startupRecovery';
import { events, makeRunEnv, request, terminalOf, threadRows, waitFor, type RunEnv } from './runEnv';

// Fault switches for the result path (parse → citation matching). Off = the real implementation.
const faults = vi.hoisted(() => ({ parse: false, resolve: false }));
vi.mock('@study-paper/shared/markup/parseAnswer', async (importOriginal) => {
  const m = await importOriginal<typeof import('@study-paper/shared/markup/parseAnswer')>();
  return {
    ...m,
    parseAnswer: ((...a: Parameters<typeof m.parseAnswer>) => {
      if (faults.parse) throw new Error('injected parse failure');
      return m.parseAnswer(...a);
    }) as typeof m.parseAnswer,
  };
});
vi.mock('../../src/llm/citations', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/llm/citations')>();
  return {
    ...m,
    resolveCitations: ((...a: Parameters<typeof m.resolveCitations>) => {
      if (faults.resolve) throw new Error('injected citation failure');
      return m.resolveCitations(...a);
    }) as typeof m.resolveCitations,
  };
});

afterEach(() => {
  faults.parse = false;
  faults.resolve = false;
});

type Sql = RunEnv['sqlite'];
const callRow = (sqlite: Sql, runId: string) => sqlite.prepare(`SELECT status, errorCode, errorDetail FROM llm_calls WHERE runId = ?`).get(runId) as { status: string; errorCode: string | null; errorDetail: string | null };
const msgRow = (sqlite: Sql, id: string) => sqlite.prepare(`SELECT status, contentMd FROM messages WHERE id = ?`).get(id) as { status: string; contentMd: string } | undefined;
const citationCount = (sqlite: Sql, ownerId: string) => (sqlite.prepare(`SELECT count(*) AS n FROM citations WHERE ownerType = 'message' AND ownerId = ?`).get(ownerId) as { n: number }).n;

/** Runs one request and checks the stream: accepted first, exactly one terminal, nothing after it. */
async function runOnce(env: RunEnv, req: RunTaskRequest): Promise<{ runId: string; ev: RunSseEvent[] }> {
  const h = env.manager.runTask(req);
  const ev = await events(h);
  await h.done;
  expect(ev[0]!.event).toBe('run.accepted');
  expect(terminalOf(ev)).toHaveLength(1);
  expect(ev.at(-1)).toBe(terminalOf(ev)[0]);
  return { runId: h.runId, ev };
}

/** "Reload": a fresh connection to the same file (+ startup recovery, as a server start would do). */
function reload(env: RunEnv): Sql {
  const sqlite = openSqlite(env.paths.dbFile);
  startupRecovery(sqlite, env.paths);
  return sqlite;
}

describe('B3: run.done only after the result is stored', () => {
  it.each([
    ['a throwing parser', (): void => void (faults.parse = true)],
    ['a throwing citation resolution', (): void => void (faults.resolve = true)],
  ] as const)('%s → one run.error persist_failed with the answer as partialText; rows terminal (error) after reload', async (_name, inject) => {
    const env = await makeRunEnv();
    inject();
    const rows = threadRows();
    const { runId, ev } = await runOnce(env, request({ startRows: rows }));
    expect(ev.some((e) => e.event === 'run.done')).toBe(false);
    expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'persist_failed', partialText: expect.stringContaining('합성 답변') } });
    const db = reload(env);
    expect(callRow(db, runId)).toMatchObject({ status: 'error', errorCode: 'persist_failed', errorDetail: expect.stringContaining('injected') });
    expect(msgRow(db, rows.ids.messageId!)).toMatchObject({ status: 'error', contentMd: expect.stringContaining('합성 답변') });
    expect(citationCount(db, rows.ids.messageId!)).toBe(0);
    db.close();
    env.close();
  });

  it('a throwing lookup (page_texts unreadable) → one persist_failed', async () => {
    const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: 'slow' } });
    const rows = threadRows();
    const h = env.manager.runTask(request({ startRows: rows }));
    const ev: RunSseEvent[] = [];
    const reading = (async () => {
      for await (const e of h.subscribe()) ev.push(e);
    })();
    await waitFor(() => ev.some((e) => e.event === 'run.delta'), 'first delta'); // the context was read already
    env.sqlite.exec(`ALTER TABLE page_texts RENAME TO page_texts_hidden`);
    await h.done;
    await reading;
    env.sqlite.exec(`ALTER TABLE page_texts_hidden RENAME TO page_texts`);
    expect(terminalOf(ev)).toHaveLength(1);
    expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'persist_failed' } });
    const db = reload(env);
    expect(callRow(db, h.runId)).toMatchObject({ status: 'error', errorCode: 'persist_failed' });
    expect(msgRow(db, rows.ids.messageId!)?.status).toBe('error');
    db.close();
    env.close();
  });

  it('a failing transaction (citation insert aborted by a trigger) → rolled back entirely, one persist_failed', async () => {
    const env = await makeRunEnv();
    env.sqlite.exec(`CREATE TEMP TRIGGER fail_citations BEFORE INSERT ON citations BEGIN SELECT RAISE(ABORT, 'injected citation insert failure'); END`);
    const rows = threadRows();
    const req = request({ startRows: rows });
    const { runId, ev } = await runOnce(env, req);
    expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'persist_failed', retryable: false } });
    const db = reload(env);
    // The 'ok' update of llm_calls and the message update were rolled back with the failed insert.
    expect(callRow(db, runId)).toMatchObject({ status: 'error', errorCode: 'persist_failed', errorDetail: expect.stringContaining('injected citation insert failure') });
    expect(msgRow(db, rows.ids.messageId!)?.status).toBe('error');
    expect(citationCount(db, rows.ids.messageId!)).toBe(0);
    // A repeat of the request after a restart replays the same failure (never a success).
    const replay = await events(env.restart({ db: toDrizzle(db) }).runTask({ ...req, startRows: threadRows() }));
    expect(replay.map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
    expect(replay[1]).toMatchObject({ data: { code: 'persist_failed' } });
    db.close();
    env.close();
  });

  it('a closed DB before the result → one run.error (nothing stored); after a restart the rows are interrupted', async () => {
    const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: 'slow' } });
    const rows = threadRows();
    const h = env.manager.runTask(request({ startRows: rows }));
    const ev: RunSseEvent[] = [];
    const reading = (async () => {
      for await (const e of h.subscribe()) ev.push(e);
    })();
    await waitFor(() => ev.some((e) => e.event === 'run.delta'), 'first delta');
    env.sqlite.close();
    await h.done;
    await reading;
    expect(terminalOf(ev)).toHaveLength(1);
    expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'persist_failed', partialText: expect.stringContaining('합성 답변') } });
    const db = reload(env);
    expect(callRow(db, h.runId).status).toBe('interrupted');
    expect(msgRow(db, rows.ids.messageId!)?.status).toBe('interrupted');
    db.close();
  });
});

describe('M2: no output before a safe system:init reaches the run', () => {
  it.each(['no_init', 'result_before_init', 'content_before_init', 'duplicate_init', 'unsafe_init'])('%s → one run.error unsafe_cli_state, no delta/done, message error without text', async (scenario) => {
    const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: scenario } });
    const rows = threadRows();
    const { runId, ev } = await runOnce(env, request({ startRows: rows }));
    expect(ev.some((e) => e.event === 'run.delta' || e.event === 'run.done' || e.event === 'run.response_started')).toBe(false);
    expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'unsafe_cli_state', retryable: false } });
    expect((ev.at(-1)!.data as { partialText?: string }).partialText ?? '').toBe('');
    expect(callRow(env.sqlite, runId)).toMatchObject({ status: 'error', errorCode: 'unsafe_cli_state' });
    expect(msgRow(env.sqlite, rows.ids.messageId!)).toEqual({ status: 'error', contentMd: '' });
    env.close();
  });

  it('killed_mid → one run.error cli_error with the partial text', async () => {
    const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: 'killed_mid' } });
    const { ev } = await runOnce(env, request());
    expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cli_error', partialText: expect.any(String) } });
    env.close();
  });
});

describe('M4: a regenerate replaces the old turn only when it succeeds', () => {
  /** A thread with one finished turn (user + assistant with a citation) made by a real run. */
  async function finishedTurn(env: RunEnv) {
    const rows = threadRows();
    const req = request({ startRows: rows });
    const first = await runOnce(env, req);
    expect(first.ev.at(-1)!.event).toBe('run.done');
    const threadId = rows.ids.threadId!;
    const oldAssistant = rows.ids.messageId!;
    const oldUser = (env.sqlite.prepare(`SELECT id FROM messages WHERE threadId = ? AND role = 'user'`).get(threadId) as { id: string }).id;
    expect(citationCount(env.sqlite, oldAssistant)).toBeGreaterThan(0);
    const oldText = msgRow(env.sqlite, oldAssistant)!.contentMd;
    return { req, threadId, oldUser, oldAssistant, oldText, firstEvents: first.ev };
  }
  /** startRows of a regenerate as messages.create builds them: new turn after the old one, replaces + discardOnFailure. */
  function regenerateRows(threadId: string, replaces: string[]) {
    const ids = { userId: randomUUID(), assistantId: randomUUID() };
    return {
      ids,
      startRows: {
        insert: (tx: Parameters<NonNullable<RunTaskRequest['startRows']>['insert']>[0]) => {
          const now = Date.now();
          tx.insert(messages).values({ id: ids.userId, threadId, role: 'user', contentMd: 'q again', status: 'complete', createdAt: now }).run();
          tx.insert(messages).values({ id: ids.assistantId, threadId, role: 'assistant', contentMd: '', status: 'streaming', createdAt: now + 1 }).run();
          return { threadId, messageId: ids.assistantId, replaces, discardOnFailure: [ids.userId, ids.assistantId] };
        },
      },
    };
  }
  const threadMsgs = (sqlite: Sql, threadId: string) => sqlite.prepare(`SELECT id, role, status FROM messages WHERE threadId = ? ORDER BY createdAt, rowid`).all(threadId) as { id: string; role: string; status: string }[];

  it('success: both turns exist while streaming; the old turn and its citations go in the commit', async () => {
    const env = await makeRunEnv();
    const t = await finishedTurn(env);
    env.fakeEnv.FAKE_CLAUDE_SCENARIO = 'slow';
    const r = regenerateRows(t.threadId, [t.oldAssistant, t.oldUser]);
    const h = env.manager.runTask(request({ threadId: t.threadId, startRows: r.startRows }));
    const ev: RunSseEvent[] = [];
    const reading = (async () => {
      for await (const e of h.subscribe()) ev.push(e);
    })();
    await waitFor(() => ev.some((e) => e.event === 'run.delta'), 'first delta');
    expect(threadMsgs(env.sqlite, t.threadId).map((m) => m.id)).toEqual([t.oldUser, t.oldAssistant, r.ids.userId, r.ids.assistantId]);
    expect(citationCount(env.sqlite, t.oldAssistant)).toBeGreaterThan(0);
    await h.done;
    await reading;
    expect(ev.at(-1)!.event).toBe('run.done');
    expect(threadMsgs(env.sqlite, t.threadId)).toEqual([
      { id: r.ids.userId, role: 'user', status: 'complete' },
      { id: r.ids.assistantId, role: 'assistant', status: 'complete' },
    ]);
    expect(citationCount(env.sqlite, t.oldAssistant)).toBe(0);
    expect(citationCount(env.sqlite, r.ids.assistantId)).toBeGreaterThan(0);
    env.close();
  });

  it.each([
    ['an adapter failure', 'no_result_exit', null],
    ['a failed result transaction', 'ok', 'trigger'],
    ['a cancel', 'hang_after_init', 'cancel'],
  ] as const)('%s: the new turn goes, the old turn + citations stay and its request still replays', async (_name, scenario, how) => {
    const env = await makeRunEnv({ deps: { retention: { max: 0, ms: 60_000 } } });
    const t = await finishedTurn(env);
    env.fakeEnv.FAKE_CLAUDE_SCENARIO = scenario;
    const r = regenerateRows(t.threadId, [t.oldAssistant, t.oldUser]);
    const before = citationCount(env.sqlite, t.oldAssistant);
    if (how === 'trigger') env.sqlite.exec(`CREATE TEMP TRIGGER fail_citations BEFORE INSERT ON citations BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const h = env.manager.runTask(request({ threadId: t.threadId, startRows: r.startRows }));
    if (how === 'cancel') {
      await waitFor(() => env.sqlite.prepare(`SELECT modelResolved FROM llm_calls WHERE runId = ?`).get(h.runId) !== undefined && (env.sqlite.prepare(`SELECT modelResolved FROM llm_calls WHERE runId = ?`).get(h.runId) as { modelResolved: string | null }).modelResolved !== null, 'started');
      env.manager.runs.cancel(h.runId);
    }
    const ev = await events(h);
    await h.done;
    expect(terminalOf(ev)).toHaveLength(1);
    expect(ev.at(-1)!.event).toBe('run.error');
    expect(threadMsgs(env.sqlite, t.threadId)).toEqual([
      { id: t.oldUser, role: 'user', status: 'complete' },
      { id: t.oldAssistant, role: 'assistant', status: 'complete' },
    ]);
    expect(msgRow(env.sqlite, t.oldAssistant)!.contentMd).toBe(t.oldText);
    expect(citationCount(env.sqlite, t.oldAssistant)).toBe(before);
    // The old request (evicted from memory: max 0) is replayed from the DB with its text and citations.
    const replay = await events(env.manager.runTask({ ...t.req, startRows: threadRows() }));
    expect(replay.map((e) => e.event)).toEqual(['run.accepted', 'run.done']);
    expect(replay[1]!.data).toMatchObject({ text: t.oldText, citations: (t.firstEvents.at(-1)!.data as { citations: unknown[] }).citations });
    env.close();
  });

  it.each([
    ['still retained in memory', {}],
    ['after eviction', { retention: { max: 0, ms: 60_000 } }],
  ] as const)('N4: after a successful regenerate (%s) the old id replays superseded, the new id its answer — also after a restart', async (_name, deps) => {
    const env = await makeRunEnv({ deps });
    const t = await finishedTurn(env);
    const r = regenerateRows(t.threadId, [t.oldAssistant, t.oldUser]);
    const regenReq = request({ threadId: t.threadId, startRows: r.startRows });
    const regen = await runOnce(env, regenReq);
    const newDone = regen.ev.at(-1)!;
    expect(newDone.event).toBe('run.done');
    const oldRunId = (t.firstEvents[0]!.data as { runId: string }).runId;
    expect(env.sqlite.prepare(`SELECT status, errorCode, errorDetail FROM llm_calls WHERE runId = ?`).get(oldRunId)).toMatchObject({ status: 'ok', errorCode: 'superseded', errorDetail: expect.stringContaining(regen.runId) });
    const check = async (m: RunEnv['manager']) => {
      const oldReplay = await events(m.runTask({ ...t.req, startRows: threadRows() }));
      expect(oldReplay.map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
      expect(oldReplay[0]!.data).toMatchObject({ runId: oldRunId });
      expect(oldReplay[1]).toMatchObject({ data: { code: 'superseded', retryable: false } });
      const newReplay = await events(m.runTask({ ...regenReq, startRows: threadRows() }));
      expect(newReplay.at(-1)).toEqual(newDone);
    };
    await check(env.manager);
    await check(env.restart());
    expect(env.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls`).get()).toEqual({ n: 2 }); // no replay started a run
    env.close();
  });

  it('a restart during the regenerate: the old turn and its citations stay; the new turn is interrupted; both requests replay', async () => {
    const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: 'ok' } });
    const t = await finishedTurn(env);
    env.fakeEnv.FAKE_CLAUDE_SCENARIO = 'hang_after_init';
    const r = regenerateRows(t.threadId, [t.oldAssistant, t.oldUser]);
    const regenReq = request({ threadId: t.threadId, startRows: r.startRows });
    const h = env.manager.runTask(regenReq);
    await waitFor(() => (env.sqlite.prepare(`SELECT modelResolved FROM llm_calls WHERE runId = ?`).get(h.runId) as { modelResolved: string | null }).modelResolved !== null, 'started');
    // The process "dies": its DB handle is gone, so nothing the dying run does can be written.
    env.sqlite.close();
    h.cancel();
    await h.done;
    const db = reload(env);
    expect(threadMsgs(db, t.threadId)).toEqual([
      { id: t.oldUser, role: 'user', status: 'complete' },
      { id: t.oldAssistant, role: 'assistant', status: 'complete' },
      { id: r.ids.userId, role: 'user', status: 'complete' },
      { id: r.ids.assistantId, role: 'assistant', status: 'interrupted' },
    ]);
    expect(citationCount(db, t.oldAssistant)).toBeGreaterThan(0);
    const m2 = env.restart({ db: toDrizzle(db) });
    const oldReplay = await events(m2.runTask({ ...t.req, startRows: threadRows(SEED_PAPER_ID) }));
    expect(oldReplay.at(-1)).toMatchObject({ event: 'run.done', data: { text: t.oldText } });
    const newReplay = await events(m2.runTask({ ...regenReq, startRows: threadRows() }));
    expect(newReplay.map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
    expect(newReplay[1]).toMatchObject({ data: { retryable: true } });
    db.close();
  });
});
