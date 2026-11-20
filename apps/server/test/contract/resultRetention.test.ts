// Stored run results (PLAN_M2 D29, 3.4 rule 6; BRIEF_S S5). Owner: supervisor. No restarts: Date is faked.
import { open } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmCalls, papers } from '../../src/db/schema';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import type { AtomicFileHandle } from '../../src/ingest/files';
import { ingestService } from '../../src/ingest/pipeline';
import { Lifecycle } from '../../src/lifecycle';
import {
  clearPaperResultRaw,
  isSuggestionExpired,
  RESULT_RAW_RETENTION_MS,
  RESULT_SWEEP_BATCH,
  RESULT_SWEEP_INTERVAL_MS,
  startResultSweep,
  suggestionAvailable,
  suggestionExpiryCutoff,
  sweepResultRaw,
} from '../../src/resultRetention';
import { startupRecovery } from '../../src/startupRecovery';
import { waitFor } from '../helpers/proc';
import { startTestServer, type TestServer } from '../helpers/server';
import { FakeArxivSource, freshId, useSource } from '../ingest/helpers';

const DAY = 86_400_000;
/** setImmediate is real in these tests (only Date and the interval are faked): let queued batches run. */
const flushImmediates = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};
const T0 = Date.UTC(2026, 0, 1);
const servers: TestServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function server(): Promise<TestServer> {
  const s = await startTestServer({ env: 'prod', seed: true });
  servers.push(s);
  return s;
}
function insertRun(s: TestServer, o: { runId?: string; paperId?: string | null; finishedAt?: number | null; resultRaw?: string | null } = {}): string {
  const runId = o.runId ?? crypto.randomUUID();
  s.deps.sqlite
    .prepare(`INSERT INTO llm_calls (runId, task, paperId, model, effort, status, acceptedAt, finishedAt, resultRaw) VALUES (?, 'glossary_define', ?, 'opus', 'low', 'ok', 1, ?, ?)`)
    .run(runId, o.paperId === undefined ? SEED_PAPER_ID : o.paperId, o.finishedAt === undefined ? T0 : o.finishedAt, o.resultRaw === undefined ? '<term name="ICP">x</term>' : o.resultRaw);
  return runId;
}
const rawOf = (s: TestServer, runId: string) => (s.deps.sqlite.prepare(`SELECT resultRaw FROM llm_calls WHERE runId = ?`).get(runId) as { resultRaw: string | null } | undefined)?.resultRaw;
const del = (s: TestServer, id: string) => s.req(`/api/papers/${id}`, { method: 'DELETE', headers: { 'X-SP-Token': s.token } });

describe('use-time decision (pure)', () => {
  it('isSuggestionExpired: 30 days − 1 ms false / exactly 30 days true / + 1 ms true / null true', () => {
    expect(RESULT_RAW_RETENTION_MS).toBe(30 * DAY);
    expect(isSuggestionExpired(T0, T0 + 30 * DAY - 1)).toBe(false);
    expect(isSuggestionExpired(T0, T0 + 30 * DAY)).toBe(true);
    expect(isSuggestionExpired(T0, T0 + 30 * DAY + 1)).toBe(true);
    expect(isSuggestionExpired(null, T0)).toBe(true);
    expect(suggestionExpiryCutoff(T0 + 30 * DAY)).toBe(T0);
  });

  it('suggestionAvailable table', () => {
    const now = T0 + DAY;
    const row = { resultRaw: 'x', paperId: 'p', finishedAt: T0 };
    const paper = { deletingAt: null };
    expect(suggestionAvailable(row, paper, now)).toBe(true);
    expect(suggestionAvailable({ ...row, resultRaw: null }, paper, now)).toBe(false);
    expect(suggestionAvailable({ ...row, paperId: null }, paper, now)).toBe(false);
    expect(suggestionAvailable(row, undefined, now)).toBe(false);
    expect(suggestionAvailable(row, { deletingAt: T0 }, now)).toBe(false);
    expect(suggestionAvailable(row, paper, T0 + 30 * DAY)).toBe(false);
    expect(suggestionAvailable({ ...row, finishedAt: null }, paper, now)).toBe(false);
  });
});

describe('sweepResultRaw / startResultSweep', () => {
  it('at the three instants the sweep clears exactly the rows isSuggestionExpired calls expired; rows and other columns stay', async () => {
    const s = await server();
    for (const [label, now] of [['-1ms', T0 + 30 * DAY - 1], ['exact', T0 + 30 * DAY], ['+1ms', T0 + 30 * DAY + 1]] as const) {
      s.deps.sqlite.prepare(`DELETE FROM llm_calls`).run();
      const fresh = insertRun(s, { finishedAt: T0 + 1 });
      const edge = insertRun(s, { finishedAt: T0 });
      const before = s.deps.sqlite.prepare(`SELECT runId, task, paperId, finishedAt, status FROM llm_calls ORDER BY runId`).all();
      sweepResultRaw(s.deps.sqlite, now);
      for (const [id, fin] of [[fresh, T0 + 1], [edge, T0]] as const) expect(rawOf(s, id) === null, `${label} ${fin}`).toBe(isSuggestionExpired(fin, now));
      expect(s.deps.sqlite.prepare(`SELECT runId, task, paperId, finishedAt, status FROM llm_calls ORDER BY runId`).all()).toEqual(before);
    }
  });

  it('also clears rows without a paper and rows of a tombstoned paper; respects the batch limit', async () => {
    const s = await server();
    const orphan = insertRun(s, { paperId: null });
    s.deps.db.update(papers).set({ deletingAt: T0 }).where(eq(papers.id, SEED_PAPER_ID)).run();
    const tomb = insertRun(s, { finishedAt: Date.now() });
    expect(sweepResultRaw(s.deps.sqlite, Date.now(), 1)).toBe(1);
    expect(sweepResultRaw(s.deps.sqlite, Date.now())).toBe(1);
    expect([rawOf(s, orphan), rawOf(s, tomb)]).toEqual([null, null]);
  });

  it('a tick (fake 1 h) clears expired rows; 501 rows expired after a tick are all cleared by the next tick; after lifecycle.begin no DB call', async () => {
    const s = await server();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);
    const lifecycle = new Lifecycle();
    const prepare = vi.spyOn(s.deps.sqlite, 'prepare');
    startResultSweep({ sqlite: s.deps.sqlite, lifecycle });
    const fresh = insertRun(s, { finishedAt: T0 });
    const old = insertRun(s, { finishedAt: T0 - 30 * DAY });
    await vi.advanceTimersByTimeAsync(RESULT_SWEEP_INTERVAL_MS);
    expect(rawOf(s, old)).toBeNull();
    expect(rawOf(s, fresh)).not.toBeNull();
    // 501 rows that expire right after that tick: the next tick empties the whole backlog.
    const ins = s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, task, paperId, model, effort, status, acceptedAt, finishedAt, resultRaw) VALUES (?, 'glossary_define', ?, 'opus', 'low', 'ok', 1, ?, 'x')`);
    for (let i = 0; i < RESULT_SWEEP_BATCH + 1; i++) ins.run(crypto.randomUUID(), SEED_PAPER_ID, Date.now() - 30 * DAY + 1);
    vi.setSystemTime(Date.now() + 1);
    const left = () => (s.deps.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls WHERE resultRaw IS NOT NULL`).get() as { n: number }).n;
    expect(left()).toBe(RESULT_SWEEP_BATCH + 2);
    await vi.advanceTimersByTimeAsync(RESULT_SWEEP_INTERVAL_MS);
    await flushImmediates(); // the setImmediate batches of the same tick (no second interval)
    expect(left()).toBe(1); // only `fresh` remains (it expires later)
    // After the lifecycle stops: further intervals never touch the DB.
    lifecycle.begin();
    prepare.mockClear();
    vi.setSystemTime(T0 + 365 * DAY);
    await vi.advanceTimersByTimeAsync(RESULT_SWEEP_INTERVAL_MS * 3);
    expect(prepare).not.toHaveBeenCalled();
    expect(rawOf(s, fresh)).not.toBeNull();
    prepare.mockRestore();
  });

  it('a tick in progress stops before its next batch when the lifecycle stops', async () => {
    const s = await server();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);
    const lifecycle = new Lifecycle();
    const ins = s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, task, paperId, model, effort, status, acceptedAt, finishedAt, resultRaw) VALUES (?, 'glossary_define', ?, 'opus', 'low', 'ok', 1, ?, 'x')`);
    for (let i = 0; i < RESULT_SWEEP_BATCH * 3; i++) ins.run(crypto.randomUUID(), SEED_PAPER_ID, T0 - 31 * DAY);
    startResultSweep({ sqlite: s.deps.sqlite, lifecycle });
    vi.advanceTimersByTime(RESULT_SWEEP_INTERVAL_MS); // runs the interval callback: first batch only (the rest is setImmediate)
    lifecycle.begin();
    await flushImmediates();
    await vi.advanceTimersByTimeAsync(RESULT_SWEEP_INTERVAL_MS * 2);
    expect((s.deps.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls WHERE resultRaw IS NOT NULL`).get() as { n: number }).n).toBe(RESULT_SWEEP_BATCH * 2);
  });
});

describe('paper deletion clears stored results', () => {
  it('papers.delete: resultRaw is NULL right after the 204', async () => {
    const s = await server();
    const run = insertRun(s, { finishedAt: Date.now() });
    expect(clearPaperResultRaw(s.deps.sqlite, 'no-such-paper')).toBe(0);
    expect((await del(s, SEED_PAPER_ID)).status).toBe(204);
    expect(rawOf(s, run)).toBeNull();
  });

  it('deferred delete: NULL at the 204 while the tombstone row stays; a value written after the tombstone is cleared by finalizeDelete', async () => {
    const s = await startTestServer({ env: 'prod' });
    servers.push(s);
    const id = freshId();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const openFile = async (path: string): Promise<AtomicFileHandle> => {
      const fh = await open(path, 'wx', 0o600);
      return {
        write: (b, o, l) => fh.write(b, o, l),
        async sync() {
          entered = true;
          await gate;
          await fh.sync();
        },
        close: () => fh.close(),
      };
    };
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), { openFile, deleteWaitMs: 150 });
    const res = ingestService(s.deps).importArxiv(id);
    await waitFor(() => entered, 'writer reached fsync');
    const run = insertRun(s, { paperId: res.paperId, finishedAt: Date.now() });
    expect((await del(s, res.paperId)).status).toBe(204);
    expect(s.deps.db.select({ d: papers.deletingAt }).from(papers).where(eq(papers.id, res.paperId)).get()?.d).not.toBeNull();
    expect(rawOf(s, run)).toBeNull();
    // A late writer stores a result after the tombstone; the final cleanup still removes it.
    s.deps.db.update(llmCalls).set({ resultRaw: 'late' }).where(eq(llmCalls.runId, run)).run();
    release();
    await waitFor(() => s.deps.db.select().from(papers).where(eq(papers.id, res.paperId)).get() === undefined, 'deferred cleanup');
    expect(rawOf(s, run)).toBeNull();
  });

  it('a DB with only the tombstone (row deletion never finished) → startupRecovery clears it', async () => {
    const s = await server();
    const run = insertRun(s, { finishedAt: Date.now() });
    s.deps.db.update(papers).set({ deletingAt: Date.now() }).where(eq(papers.id, SEED_PAPER_ID)).run();
    expect(rawOf(s, run)).not.toBeNull();
    startupRecovery(s.deps.sqlite, s.deps.paths);
    expect(rawOf(s, run)).toBeNull();
    expect(s.deps.sqlite.prepare(`SELECT paperId FROM llm_calls WHERE runId = ?`).get(run)).toEqual({ paperId: null });
  });
});
