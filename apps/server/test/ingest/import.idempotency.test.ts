// papers.import idempotency (PLAN 4.1 `resolve`, version rule). No network.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportPaperResponse } from '@study-paper/shared/contracts/api';
import { openSqlite } from '../../src/db/client';
import { jobs, papers } from '../../src/db/schema';
import { ingestService } from '../../src/ingest/pipeline';
import { startTestServer, type TestServer } from '../helpers/server';
import { FakeArxivSource, freshId, importAndWait, useSource, waitJob } from './helpers';

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer({ env: 'prod' });
});
afterAll(async () => {
  await s.close();
});

async function post(input: string, clientRequestId: string = crypto.randomUUID()) {
  const r = await s.req('/api/papers/import', { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ input, clientRequestId }) });
  return { status: r.status, body: JSON.parse(r.text) as ImportPaperResponse };
}
const count = (arxivId: string) => {
  const ps = s.deps.db.select().from(papers).where(eq(papers.arxivId, arxivId)).all();
  const js = ps.length ? s.deps.db.select().from(jobs).where(eq(jobs.paperId, ps[0]!.id)).all() : [];
  return { papers: ps.length, jobs: js.length };
};

describe('papers.import idempotency', () => {
  it('the same id twice at once → 1 paper, 1 job, same answer', async () => {
    const id = freshId();
    const src = new FakeArxivSource({ [id]: { version: 1, pdfDelayMs: 30 } });
    useSource(s.deps, src);
    const [a, b] = await Promise.all([post(id), post(`https://arxiv.org/abs/${id}`)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ paperId: a.body.paperId, jobId: a.body.jobId, existing: false });
    expect(b.body).toEqual(a.body);
    expect(count(id)).toEqual({ papers: 1, jobs: 1 });
    await waitJob(s.deps, a.body.jobId!);
    expect(src.calls).toEqual({ metadata: 1, pdf: 1 });
  });

  it('a repeated request with the same clientRequestId does not start a second job', async () => {
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }));
    const crid = crypto.randomUUID();
    const a = await post(id, crid);
    await waitJob(s.deps, a.body.jobId!);
    const b = await post(id, crid);
    expect(b.body).toMatchObject({ paperId: a.body.paperId, jobId: null, existing: true });
    expect(count(id)).toEqual({ papers: 1, jobs: 1 });
  });

  it('another version of an imported paper → existing with both versions, nothing fetched', async () => {
    const id = freshId();
    const src = new FakeArxivSource({ [id]: { version: 3 } });
    useSource(s.deps, src);
    const { res } = await importAndWait(s.deps, `${id}v2`);
    expect(s.deps.db.select({ v: papers.arxivVersion }).from(papers).where(eq(papers.id, res.paperId)).get()).toEqual({ v: 2 });
    const before = { ...src.calls };
    expect((await post(`${id}v3`)).body).toEqual({ paperId: res.paperId, jobId: null, existing: true, existingVersion: 2, requestedVersion: 3 });
    expect((await post(id)).body).toEqual({ paperId: res.paperId, jobId: null, existing: true, existingVersion: 2 });
    expect((await post(`${id}v2`)).body).toEqual({ paperId: res.paperId, jobId: null, existing: true, existingVersion: 2, requestedVersion: 2 });
    expect(src.calls).toEqual(before);
    expect(count(id)).toEqual({ papers: 1, jobs: 1 });
  });

  it('another version while the first import is still running → existing + the running job', async () => {
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 2, pdfDelayMs: 30 } }));
    const a = (await post(`${id}v1`)).body;
    const b = (await post(`${id}v2`)).body;
    expect(b).toEqual({ paperId: a.paperId, jobId: a.jobId, existing: true, existingVersion: 1, requestedVersion: 2 });
    await waitJob(s.deps, a.jobId!);
    expect(count(id)).toEqual({ papers: 1, jobs: 1 });
  });

  it('losing the UNIQUE race to another connection answers with the winner (no 500)', async () => {
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }));
    const other = openSqlite(s.deps.paths.dbFile);
    const sqlite = s.deps.sqlite as unknown as { transaction: (fn: () => void) => () => void };
    const original = sqlite.transaction;
    sqlite.transaction = (fn) => {
      sqlite.transaction = original; // only the first transaction (the paper + job insert)
      other.prepare(`INSERT INTO papers (id, source, arxivId, arxivVersion, title, ingestStatus, createdAt, updatedAt) VALUES ('winner-paper', 'arxiv', ?, 1, 'w', 'done', 1, 1)`).run(id);
      return original.call(s.deps.sqlite, fn);
    };
    try {
      const r = await post(id);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ paperId: 'winner-paper', jobId: null, existing: true, existingVersion: 1 });
      expect(count(id)).toEqual({ papers: 1, jobs: 0 });
    } finally {
      sqlite.transaction = original;
      other.close();
    }
  });

  it('invalid input → 400 and nothing is created', async () => {
    const r = await post('not-an-id');
    expect(r.status).toBe(400);
    expect(ingestService(s.deps).activeJobs()).toBe(0);
  });
});
