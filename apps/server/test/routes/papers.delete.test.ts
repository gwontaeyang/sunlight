// papers.delete (PLAN 4.1): cancel the paper's ingest job and LLM runs, wait, delete rows (cascade + citation
// triggers), remove the directory. No network.
import { existsSync, readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { citations, highlights, jobs, llmCalls, messages, pageTexts, papers, threads } from '../../src/db/schema';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import type { AtomicFileHandle } from '../../src/ingest/files';
import { ingestService } from '../../src/ingest/pipeline';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { waitFor } from '../helpers/proc';
import { startTestServer, type TestServer } from '../helpers/server';
import { collectJobEvents, FakeArxivSource, freshId, useSource } from '../ingest/helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const del = (s: TestServer, id: string) => s.req(`/api/papers/${id}`, { method: 'DELETE', headers: { 'X-SP-Token': s.token } });
const orphanCitations = (s: TestServer) =>
  (
    s.deps.sqlite
      .prepare(
        `SELECT count(*) AS n FROM citations c WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE c.ownerType = 'message' AND m.id = c.ownerId)
         AND NOT EXISTS (SELECT 1 FROM paper_card_items i WHERE c.ownerType = 'paper_card_item' AND i.id = c.ownerId)
         AND NOT EXISTS (SELECT 1 FROM review_cards r WHERE c.ownerType = 'review_card' AND r.id = c.ownerId)
         AND NOT EXISTS (SELECT 1 FROM explain_backs e WHERE c.ownerType = 'explain_back' AND e.id = c.ownerId)
         AND NOT EXISTS (SELECT 1 FROM glossary_terms g WHERE c.ownerType = 'glossary_term' AND g.id = c.ownerId)`,
      )
      .get() as { n: number }
  ).n;

describe('papers.delete', () => {
  it('cancels a running import, then deletes rows, files and the directory', async () => {
    const s = await startTestServer({ env: 'prod' });
    servers.push(s);
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1, pdfDelayMs: 300 } }));
    const res = ingestService(s.deps).importArxiv(id);
    const events = collectJobEvents(s.deps, res.jobId!);
    await new Promise((r) => setTimeout(r, 100)); // the PDF download is in progress
    expect(ingestService(s.deps).activeJobs()).toBe(1);
    const t0 = Date.now();
    const r = await del(s, res.paperId);
    expect(r.status).toBe(204);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((await events).at(-1)).toMatchObject({ event: 'job.error', data: { code: 'cancelled' } });
    expect(ingestService(s.deps).activeJobs()).toBe(0);
    expect(s.deps.db.select().from(papers).where(eq(papers.id, res.paperId)).all()).toEqual([]);
    expect(s.deps.db.select().from(jobs).where(eq(jobs.paperId, res.paperId)).all()).toEqual([]);
    expect(existsSync(s.deps.paths.paperDir(res.paperId))).toBe(false);
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
    // The id can be imported again afterwards.
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }));
    expect(ingestService(s.deps).importArxiv(id)).toMatchObject({ existing: false });
  });

  it('cancels a running LLM run, waits for it, and leaves no orphan citation', async () => {
    const s = await startTestServer({ env: 'prod', seed: true, llm: new MockLlmAdapter({ chunkDelayMs: 100 }) });
    servers.push(s);
    // A finished explain thread with citations, plus one still streaming.
    const done = await s.req(`/api/papers/${SEED_PAPER_ID}/threads`, {
      method: 'POST',
      headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'explain', text: 'robust kernel', clientRequestId: crypto.randomUUID() }),
    });
    expect(done.status).toBe(200);
    const before = s.deps.db.select().from(citations).all().length;
    expect(before).toBeGreaterThan(0);
    s.deps.db.insert(highlights).values({ id: crypto.randomUUID(), paperId: SEED_PAPER_ID, kind: 'text', color: 1, quoteExact: 'robust kernel', page: 2, rectsJson: '[]', createdAt: 1, updatedAt: 1 }).run();

    const events: SseEvent[] = [];
    const streaming = (async () => {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/papers/${SEED_PAPER_ID}/threads`, {
        method: 'POST',
        headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'explain', text: 'the residual', clientRequestId: crypto.randomUUID() }),
      });
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (ev && data) events.push(parseSseEvent(ev, JSON.parse(data)));
        }
      }
    })();
    await waitFor(() => events.some((e) => e.event === 'run.delta'), 'first delta');
    const accepted = events[0] as Extract<SseEvent, { event: 'run.accepted' }>;
    const r = await del(s, SEED_PAPER_ID);
    expect(r.status).toBe(204);
    await streaming;
    expect(events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
    // The run's own row survives (usage history) with paperId SET NULL and a terminal status.
    expect(s.deps.db.select({ status: llmCalls.status, paperId: llmCalls.paperId }).from(llmCalls).where(eq(llmCalls.runId, accepted.data.runId)).get()).toEqual({ status: 'cancelled', paperId: null });
    for (const t of [threads, highlights, pageTexts] as const) expect(s.deps.db.select().from(t).where(eq(t.paperId, SEED_PAPER_ID)).all()).toEqual([]);
    expect(s.deps.db.select().from(messages).all()).toEqual([]);
    expect(s.deps.db.select().from(citations).all()).toEqual([]);
    expect(orphanCitations(s)).toBe(0);
    expect(existsSync(s.deps.paths.paperDir(SEED_PAPER_ID))).toBe(false);
  });

  it('a paper being deleted is invisible (404) and cannot be imported again until deletion ends', async () => {
    const s = await startTestServer({ env: 'prod' });
    servers.push(s);
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1, pdfDelayMs: 300 } }));
    const res = ingestService(s.deps).importArxiv(id);
    const pending = del(s, res.paperId);
    await waitFor(() => s.deps.db.select({ d: papers.deletingAt }).from(papers).where(eq(papers.id, res.paperId)).get()?.d != null, 'deletingAt set');
    expect((await s.req(`/api/papers/${res.paperId}`, { headers: { 'X-SP-Token': s.token } })).status).toBe(404);
    expect((await del(s, res.paperId)).status).toBe(404);
    expect(() => ingestService(s.deps).importArxiv(id)).toThrow(expect.objectContaining({ status: 409 }));
    expect((await pending).status).toBe(204);
  });
  // M1.1 review M6: a writer stuck in fsync/close past the delete wait must not re-create papers/<id>/ after 204.
  for (const where of ['sync', 'close'] as const) {
    it(`a writer slow in ${where} past the wait: 204, tombstone hides the paper, the directory never comes back, cleanup after the writer ends`, async () => {
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
            if (where === 'sync') await gate;
            await fh.sync();
          },
          async close() {
            if (where === 'close') await gate;
            await fh.close();
          },
        };
      };
      useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), { openFile, deleteWaitMs: 150 });
      const res = ingestService(s.deps).importArxiv(id);
      const events = collectJobEvents(s.deps, res.jobId!);
      await waitFor(() => entered, 'writer reached fsync');
      const t0 = Date.now();
      expect((await del(s, res.paperId)).status).toBe(204);
      expect(Date.now() - t0).toBeLessThan(2_000);
      // Answered while the writer still runs: hidden, not importable ("being deleted"), rows kept as the tombstone.
      expect(ingestService(s.deps).activeJobs()).toBe(1);
      expect((await s.req(`/api/papers/${res.paperId}`, { headers: { 'X-SP-Token': s.token } })).status).toBe(404);
      expect(((await s.req('/api/papers', { headers: { 'X-SP-Token': s.token } })).text)).not.toContain(res.paperId);
      expect(() => ingestService(s.deps).importArxiv(id)).toThrow(expect.objectContaining({ status: 409 }));
      expect(s.deps.db.select({ d: papers.deletingAt }).from(papers).where(eq(papers.id, res.paperId)).get()?.d).not.toBeNull();
      expect(existsSync(s.deps.paths.paperDir(res.paperId))).toBe(false);

      release();
      expect((await events).at(-1)).toMatchObject({ event: 'job.error', data: { code: 'cancelled' } });
      await waitFor(() => s.deps.db.select().from(papers).where(eq(papers.id, res.paperId)).get() === undefined, 'deferred cleanup');
      expect(existsSync(s.deps.paths.paperDir(res.paperId))).toBe(false);
      expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
      expect(s.deps.db.select().from(jobs).where(eq(jobs.paperId, res.paperId)).all()).toEqual([]);
      // Importable again once the cleanup is done.
      useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), { openFile: undefined, deleteWaitMs: undefined });
      expect(ingestService(s.deps).importArxiv(id)).toMatchObject({ existing: false });
    });
  }
});

describe('papers.delete clears stored run results (M2, PLAN_M2 3.4 rule 6 — the S tombstone transaction)', () => {
  const insertResult = (s: TestServer, paperId: string) => {
    const runId = crypto.randomUUID();
    s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, task, paperId, model, effort, status, acceptedAt, resultRaw) VALUES (?, 'glossary_define', ?, 'opus', 'low', 'ok', ?, 'stored suggestion')`).run(runId, paperId, Date.now());
    return runId;
  };
  const resultRaw = (s: TestServer, runId: string) => (s.deps.sqlite.prepare(`SELECT resultRaw FROM llm_calls WHERE runId = ?`).get(runId) as { resultRaw: string | null } | undefined)?.resultRaw;

  it('right after the 204 the llm_calls.resultRaw of the paper is NULL — immediate deletion', async () => {
    const s = await startTestServer({ env: 'prod', seed: true });
    servers.push(s);
    const runId = insertResult(s, SEED_PAPER_ID);
    expect((await del(s, SEED_PAPER_ID)).status).toBe(204);
    expect(resultRaw(s, runId) ?? null).toBeNull();
  });

  it('… and for a deferred deletion (a writer still running after the wait): NULL at the 204, before the final cleanup', async () => {
    const s = await startTestServer({ env: 'prod' });
    servers.push(s);
    const id = freshId();
    // The writer is held in fsync until the test releases it (no timing window): the delete wait must run out → deferred.
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
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), { openFile, deleteWaitMs: 20 });
    const res = ingestService(s.deps).importArxiv(id);
    const done = ingestService(s.deps).whenDone(res.jobId!);
    await waitFor(() => entered, 'writer reached fsync');
    const runId = insertResult(s, res.paperId);
    expect((await del(s, res.paperId)).status).toBe(204);
    expect(ingestService(s.deps).activeJobs()).toBe(1); // the writer is still held
    expect(s.deps.sqlite.prepare(`SELECT deletingAt IS NOT NULL AS t FROM papers WHERE id = ?`).get(res.paperId)).toEqual({ t: 1 }); // deferred: the row is still there
    expect(resultRaw(s, runId)).toBeNull();
    release();
    await done;
    await waitFor(() => s.deps.db.select().from(papers).where(eq(papers.id, res.paperId)).get() === undefined, 'deferred cleanup');
    expect(s.deps.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls WHERE runId = ? AND resultRaw IS NOT NULL`).get(runId)).toEqual({ n: 0 });
  });
});
