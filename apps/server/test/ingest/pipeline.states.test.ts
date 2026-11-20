// Pipeline states, SSE events, failure/interrupt + retry, startup recovery, offline and network sources.
// No network: in-memory source, offline directory, or a mock fetch.
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobSseEvent } from '@study-paper/shared/contracts/sse';
import { files, jobs, pageTexts, papers } from '../../src/db/schema';
import { IngestError } from '../../src/ingest/errors';
import { sha256Hex } from '../../src/ingest/files';
import { PDFJS_VERSION } from '../../src/ingest/pdfText';
import { configureIngest, ingestService, jobEvents, latestJob, type IngestOptions } from '../../src/ingest/pipeline';
import { buildSupplementV1 } from '../../src/ingest/supplement';
import type { FetchImpl } from '../../src/ingest/safeFetch';
import { startupRecovery } from '../../src/startupRecovery';
import { waitFor } from '../helpers/proc';
import { startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';
import { atomFeed, collectJobEvents, FakeArxivSource, freshId, importAndWait, paperRow, SYNTHETIC_PDF, useSource, waitJob } from './helpers';

const servers: TestServer[] = [];
async function server(env: 'test' | 'prod' = 'test', opts?: IngestOptions): Promise<TestServer> {
  const s = await startTestServer({ env });
  if (opts) configureIngest(s.deps, opts);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const label = (e: JobSseEvent) =>
  e.event === 'job.step' ? `${e.data.step}:${e.data.status}` : e.event === 'job.state' ? `state:${e.data.state}` : e.event === 'job.error' ? `error:${e.data.code}` : 'done';

describe('pipeline states and events', () => {
  it('readable → context_ready → structure_ready, in order, with live SSE events', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 3, title: 'A Synthetic Study' } }));
    const res = ingestService(s.deps).importArxiv(id);
    expect(res).toMatchObject({ existing: false });
    // Subscribed before the first step ran: everything after `resolve` arrives live.
    const events = await collectJobEvents(s.deps, res.jobId!);
    expect(events.map(label)).toEqual([
      'resolve:ok',
      'metadata:running',
      'metadata:ok',
      'pdf:running',
      'pdf:ok',
      'text:running',
      'text:ok',
      'state:readable',
      'html:running',
      'html:skipped',
      'structure:running',
      'structure:skipped',
      'anchor:running',
      'anchor:skipped',
      'supplement:running',
      'supplement:ok',
      'state:context_ready',
      'state:structure_ready',
      'done',
    ]);

    const p = paperRow(s.deps, res.paperId)!;
    expect(p).toMatchObject({ arxivId: id, arxivVersion: 3, title: 'A Synthetic Study', ingestStatus: 'done', pageCount: 2, structureSource: 'none', contextMode: 'pdf', supplementVersion: 1, year: 2022, primaryCategory: 'cs.RO' });
    expect(JSON.parse(p.authorsJson)).toEqual(['Test Author', 'Second Author']);
    expect(p.readableAt! <= p.contextReadyAt! && p.contextReadyAt! <= p.structureReadyAt!).toBe(true);

    const dir = s.deps.paths.paperDir(res.paperId);
    expect(readFileSync(join(dir, 'paper.pdf')).equals(SYNTHETIC_PDF)).toBe(true);
    expect(p.pdfSha256).toBe(sha256Hex(SYNTHETIC_PDF));
    const supplement = readFileSync(join(dir, 'supplement.txt'), 'utf8');
    expect(supplement).toBe(buildSupplementV1({ title: 'A Synthetic Study', authors: ['Test Author', 'Second Author'], arxivId: id, arxivVersion: 3, year: 2022, primaryCategory: 'cs.RO' }));
    expect(p.supplementSha256).toBe(sha256Hex(supplement));
    const pts = s.deps.db.select().from(pageTexts).where(eq(pageTexts.paperId, res.paperId)).orderBy(asc(pageTexts.page)).all();
    expect(pts.map((r) => [r.page, r.pdfjsVersion])).toEqual([
      [1, PDFJS_VERSION],
      [2, PDFJS_VERSION],
    ]);
    expect(s.deps.db.select({ kind: files.kind, relPath: files.relPath }).from(files).where(eq(files.paperId, res.paperId)).all()).toEqual(
      expect.arrayContaining([
        { kind: 'pdf', relPath: `papers/${res.paperId}/paper.pdf` },
        { kind: 'supplement', relPath: `papers/${res.paperId}/supplement.txt` },
      ]),
    );
    const job = s.deps.db.select().from(jobs).where(eq(jobs.id, res.jobId!)).get()!;
    expect(job.status).toBe('done');
    expect(JSON.parse(job.stepsJson).map((x: { step: string; status: string }) => `${x.step}:${x.status}`)).toEqual(['resolve:ok', 'metadata:ok', 'pdf:ok', 'text:ok', 'html:skipped', 'structure:skipped', 'anchor:skipped', 'supplement:ok']);
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
  });

  it('two subscribers mid-job see the same events; a late subscriber gets the replay', async () => {
    const s = await server();
    const id = freshId();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), { beforeStep: (step) => (step === 'text' ? gate : undefined) });
    const res = ingestService(s.deps).importArxiv(id);
    const a = collectJobEvents(s.deps, res.jobId!);
    // metadata + pdf done, text waiting at the gate
    await waitFor(() => (s.deps.db.select({ steps: jobs.stepsJson }).from(jobs).where(eq(jobs.id, res.jobId!)).get()?.steps ?? '').includes('"step":"pdf","status":"ok"'), 'pdf ok');
    const b = collectJobEvents(s.deps, res.jobId!);
    release();
    const [ea, eb] = await Promise.all([a, b]);
    expect(ea.at(-1)!.event).toBe('job.done');
    expect(eb.map(label).slice(0, 3)).toEqual(['resolve:ok', 'metadata:ok', 'pdf:ok']); // replayed stored steps
    expect(eb.filter((e) => e.event === 'job.done')).toHaveLength(1);
    const late = await collectJobEvents(s.deps, res.jobId!);
    expect(late.map(label)).toEqual(['resolve:ok', 'metadata:ok', 'pdf:ok', 'text:ok', 'html:skipped', 'structure:skipped', 'anchor:skipped', 'supplement:ok', 'state:readable', 'state:context_ready', 'state:structure_ready', 'done']);
  });

  it('a failed step is stored with its error; retry runs from that step', async () => {
    const s = await server();
    const id = freshId();
    const notPdf = Buffer.from('<!doctype html><title>captcha</title>');
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1, pdf: notPdf } }));
    const { res, job, paper } = await importAndWait(s.deps, id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/^invalid_pdf: /);
    expect(JSON.parse(job.stepsJson)).toEqual([
      { step: 'resolve', status: 'ok', detail: `${id} (latest)` },
      { step: 'metadata', status: 'ok', detail: `${id}v1` },
      { step: 'pdf', status: 'error', detail: expect.stringContaining('does not start with') },
    ]);
    expect(paper).toMatchObject({ ingestStatus: 'failed', readableAt: null, pdfSha256: null });
    expect(existsSync(join(s.deps.paths.paperDir(res.paperId), 'paper.pdf'))).toBe(false);
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
    const replay = await collectJobEvents(s.deps, res.jobId!);
    expect(replay.at(-1)).toMatchObject({ event: 'job.error', data: { code: 'invalid_pdf' } });

    const fixed = new FakeArxivSource({ [id]: { version: 1 } });
    useSource(s.deps, fixed);
    const { jobId } = ingestService(s.deps).retry(res.paperId);
    const events = await collectJobEvents(s.deps, jobId);
    expect(events.map(label)).toEqual([
      'resolve:skipped',
      'metadata:skipped',
      'pdf:running',
      'pdf:ok',
      'text:running',
      'text:ok',
      'state:readable',
      'html:running',
      'html:skipped',
      'structure:running',
      'structure:skipped',
      'anchor:running',
      'anchor:skipped',
      'supplement:running',
      'supplement:ok',
      'state:context_ready',
      'state:structure_ready',
      'done',
    ]);
    expect(fixed.calls).toEqual({ metadata: 0, pdf: 1 });
    expect(paperRow(s.deps, res.paperId)).toMatchObject({ ingestStatus: 'done', arxivVersion: 1 });
    // structure_ready → retry is refused
    expect(() => ingestService(s.deps).retry(res.paperId)).toThrow(expect.objectContaining({ status: 409, code: 'conflict' }));
  });

  it('lastJob is the newest job even when two jobs share a millisecond', async () => {
    const t = 1_700_000_000_000;
    const s = await server('test', { now: () => t });
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), {
      beforeStep: (step) => {
        if (step === 'supplement') throw new Error('first attempt fails');
      },
    });
    const { res } = await importAndWait(s.deps, id);
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }));
    const { jobId } = ingestService(s.deps).retry(res.paperId);
    await waitJob(s.deps, jobId);
    expect(latestJob(s.deps, res.paperId)).toMatchObject({ id: jobId, kind: 'retry_ingest', status: 'done' });
  });

  it('metadata failure (unknown id) → job error not_found; the paper stays for retry or delete', async () => {
    const s = await server();
    useSource(s.deps, new FakeArxivSource({}));
    const { job, paper } = await importAndWait(s.deps, freshId());
    expect(job.error).toMatch(/^not_found: /);
    expect(paper).toMatchObject({ ingestStatus: 'failed', arxivVersion: null });
  });

  it('a requested version that does not exist fails at metadata', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 2 } }));
    const { job } = await importAndWait(s.deps, `${id}v5`);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/^not_found: /);
  });

  it('text step limits surface as job errors (too_large)', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), { text: { maxPages: 1 } });
    const { job, paper } = await importAndWait(s.deps, id);
    expect(job.error).toMatch(/^too_large: PDF has 2 pages/);
    expect(paper.readableAt).toBeNull();
    configureIngest(s.deps, { text: {} });
  });

  it('shutdown aborts the running job: interrupted row + job.error before drain resolves', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1, pdfDelayMs: 200 } }));
    const res = ingestService(s.deps).importArxiv(id);
    const events = collectJobEvents(s.deps, res.jobId!);
    await new Promise((r) => setTimeout(r, 100));
    const reports = await s.deps.lifecycle.drain(5_000);
    expect(reports).toContainEqual(expect.objectContaining({ name: 'ingest-jobs', ok: true, activeBefore: 1, activeAfter: 0 }));
    expect(s.deps.db.select().from(jobs).where(eq(jobs.id, res.jobId!)).get()).toMatchObject({ status: 'interrupted', error: expect.stringMatching(/^interrupted: /) });
    expect(paperRow(s.deps, res.paperId)?.ingestStatus).toBe('interrupted');
    expect((await events).at(-1)).toMatchObject({ event: 'job.error', data: { code: 'interrupted' } });
    expect(existsSync(join(s.deps.paths.paperDir(res.paperId), 'paper.pdf'))).toBe(false);
    // While stopping, new imports are refused.
    expect(() => ingestService(s.deps).importArxiv(freshId())).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('startup recovery marks a crashed job interrupted; replay ends with job.error; retry resumes', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), {
      beforeStep: (step) => {
        if (step === 'text') throw new IngestError('internal', 'simulated crash point');
      },
    });
    const { res } = await importAndWait(s.deps, id);
    // As if the process died during `text`: rows still say running.
    const steps = [
      { step: 'resolve', status: 'ok' },
      { step: 'metadata', status: 'ok' },
      { step: 'pdf', status: 'ok' },
      { step: 'text', status: 'running' },
    ];
    s.deps.db.update(jobs).set({ status: 'running', error: null, stepsJson: JSON.stringify(steps) }).where(eq(jobs.id, res.jobId!)).run();
    s.deps.db.update(papers).set({ ingestStatus: 'running' }).where(eq(papers.id, res.paperId)).run();
    const report = startupRecovery(s.deps.sqlite, s.deps.paths);
    expect(report.jobs).toBe(1);
    const replay = await collectJobEvents(s.deps, res.jobId!);
    expect(replay.map(label)).toEqual(['resolve:ok', 'metadata:ok', 'pdf:ok', 'text:error', 'error:interrupted']);

    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }));
    const { jobId } = ingestService(s.deps).retry(res.paperId);
    const job = await waitJob(s.deps, jobId);
    expect(JSON.parse(job.stepsJson).map((x: { step: string; status: string }) => `${x.step}:${x.status}`)).toEqual(['resolve:skipped', 'metadata:skipped', 'pdf:skipped', 'text:ok', 'html:skipped', 'structure:skipped', 'anchor:skipped', 'supplement:ok']);
    expect(paperRow(s.deps, res.paperId)).toMatchObject({ ingestStatus: 'done', pageCount: 2 });
  });

  it('a job row left running without a runner replays as interrupted', async () => {
    const s = await server();
    const now = Date.now();
    s.deps.sqlite.prepare(`INSERT INTO papers (id, source, arxivId, title, ingestStatus, createdAt, updatedAt) VALUES ('p-orphan', 'arxiv', '2301.99999', 't', 'running', ?, ?)`).run(now, now);
    s.deps.sqlite.prepare(`INSERT INTO jobs (id, kind, paperId, status, stepsJson, createdAt, updatedAt) VALUES ('j-orphan', 'import_arxiv', 'p-orphan', 'running', '[]', ?, ?)`).run(now, now);
    expect((await collectJobEvents(s.deps, 'j-orphan')).map(label)).toEqual(['error:interrupted']);
    expect(jobEvents(s.deps, 'nope')).toBeNull();
  });
});

describe('offline source (SP_ARXIV_OFFLINE_DIR, not prod)', () => {
  function offlineDir(entries: { id: string; version: number; pdf: string | Buffer }[]): string {
    const dir = tempDir('sp-offline-');
    for (const e of entries) {
      mkdirSync(join(dir, e.id, '..'), { recursive: true });
      writeFileSync(join(dir, `${e.id}.atom.xml`), atomFeed([{ id: e.id, version: e.version }]));
      if (typeof e.pdf === 'string') symlinkSync(e.pdf, join(dir, `${e.id}v${e.version}.pdf`));
      else writeFileSync(join(dir, `${e.id}v${e.version}.pdf`), e.pdf);
    }
    return dir;
  }
  const noNetwork: FetchImpl = () => Promise.reject(new Error('network must not be used'));

  it('ingests from the directory with zero network requests (synthetic PDF)', async () => {
    const id = freshId();
    let fetches = 0;
    const s = await server('test', {
      offlineDir: offlineDir([{ id, version: 1, pdf: SYNTHETIC_PDF }]),
      fetchImpl: (u, i) => {
        fetches++;
        return noNetwork(u, i);
      },
    });
    expect(ingestService(s.deps).sourceKind).toBe('offline');
    const { job, paper } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(paper.structureReadyAt).not.toBeNull();
    expect(fetches).toBe(0);
  });

  it('an id missing from the directory → job error', async () => {
    const s = await server('test', { offlineDir: offlineDir([]), fetchImpl: noNetwork });
    const { job } = await importAndWait(s.deps, freshId());
    expect(job.error).toMatch(/^not_found: offline source has no/);
  });

  it('reads SP_ARXIV_OFFLINE_DIR from the environment; prod ignores it', async () => {
    const dir = offlineDir([]);
    process.env.SP_ARXIV_OFFLINE_DIR = dir;
    try {
      const dev = await server('test');
      expect(ingestService(dev.deps).sourceKind).toBe('offline');
      const prod = await server('prod');
      expect(ingestService(prod.deps).sourceKind).toBe('network');
    } finally {
      delete process.env.SP_ARXIV_OFFLINE_DIR;
    }
  });

  const kiss = join(process.env.SP_DATA_DIR ?? '/nonexistent', 'fixtures', '2209.15397v2.pdf');
  it.skipIf(!existsSync(kiss))('real fixture: KISS-ICP 2209.15397v2 offline → structure_ready, 0 requests', async () => {
    let fetches = 0;
    const s = await server('test', {
      offlineDir: offlineDir([{ id: '2209.15397', version: 2, pdf: kiss }]),
      fetchImpl: (u, i) => {
        fetches++;
        return noNetwork(u, i);
      },
    });
    const { job, paper } = await importAndWait(s.deps, '2209.15397v2');
    expect(job.status).toBe('done');
    expect(paper).toMatchObject({ arxivVersion: 2, pageCount: 8, contextMode: 'pdf', structureSource: 'none' });
    expect(paper.pdfSha256).toBe(sha256Hex(readFileSync(kiss)));
    expect(fetches).toBe(0);
  });
});

describe('network source with a mock fetch', () => {
  it('metadata + pdf = 2 requests >= 3 s apart; re-import = 0; after delete the Atom comes from http_cache', async () => {
    const id = freshId();
    const calls: { url: string; at: number; ua: string }[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({ url, at: Date.now(), ua: (init.headers as Record<string, string>)['User-Agent']! });
      if (url.startsWith('https://export.arxiv.org/api/query')) return new Response(atomFeed([{ id, version: 2 }]), { headers: { 'content-type': 'application/atom+xml' } });
      if (url === `https://arxiv.org/pdf/${id}v2`) return new Response(new Uint8Array(SYNTHETIC_PDF), { headers: { 'content-type': 'application/pdf' } });
      return new Response('nope', { status: 404 });
    };
    const s = await server('prod', { fetchImpl });
    const { job, res } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    // M2: + the html step's request (404 here → no structure, v1)
    expect(calls.map((c) => c.url)).toEqual([`https://export.arxiv.org/api/query?id_list=${id}&max_results=1`, `https://arxiv.org/pdf/${id}v2`, `https://arxiv.org/html/${id}v2`]);
    // A-F4B2-02: the 3 s gap is kept by the host queue at slot start, so it is measured there (the queue's own start
    // record, same Date.now clock). Date.now at fetchImpl also counts safeFetch's own work after the slot opened, which
    // differs per request (2,999 ms once under load). Each fetch runs inside its own slot: at or after that slot's
    // start, and no later than the next slot's start.
    const starts = ingestService(s.deps).queue.starts.filter((x) => x.group === 'arxiv').map((x) => x.at);
    expect(starts).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(calls[i]!.at).toBeGreaterThanOrEqual(starts[i]!);
      if (i < 2) {
        expect(starts[i + 1]! - starts[i]!).toBeGreaterThanOrEqual(3_000);
        expect(calls[i]!.at).toBeLessThanOrEqual(starts[i + 1]!);
      }
    }
    expect(new Set(calls.map((c) => c.ua))).toEqual(new Set(['study_paper/0.0.0']));

    expect(ingestService(s.deps).importArxiv(id)).toEqual({ paperId: res.paperId, jobId: null, existing: true, existingVersion: 2 });
    expect(calls).toHaveLength(3);

    s.deps.db.delete(papers).where(eq(papers.id, res.paperId)).run();
    await importAndWait(s.deps, id);
    expect(calls.map((c) => c.url)).toEqual([`https://export.arxiv.org/api/query?id_list=${id}&max_results=1`, `https://arxiv.org/pdf/${id}v2`, `https://arxiv.org/html/${id}v2`, `https://arxiv.org/pdf/${id}v2`, `https://arxiv.org/html/${id}v2`]);
  }, 20_000);
});
