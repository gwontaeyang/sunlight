// Owner A. Contract cases of the papers route module (see ../helpers/routeCases.ts). No network: every case
// that can start an ingest job installs an in-memory arXiv source first.
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import type { ImportPaperResponse, PaperDetailDto, StructureResponse } from '@study-paper/shared/contracts/api';
import { storeCapture } from '../../src/captures';
import { highlights, papers } from '../../src/db/schema';
import { SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID, SEED_PAPER_ID, SEED_UPGRADE_PAPER_ID, seedFixture } from '../../src/dev/seedFixture';
import { ingestService } from '../../src/ingest/pipeline';
import { FakeArxivSource, freshId, importAndWait, paperRow, useSource, waitJob } from '../ingest/helpers';
import { makeTestPng } from '../helpers/png';
import type { CaseContext, RouteCase } from '../helpers/routeCases';

const MISSING = '00000000-0000-4000-8000-00000000dead';
const SYN_M2_HTML = readFileSync(new URL('../fixtures/synthetic-m2.html', import.meta.url), 'utf8');

/** Adds M2 seeds to the shared gate server (seedFixture recreates only the listed papers). */
async function seedM2(ctx: CaseContext, list: ('upgrade' | 'links' | 'm2')[]): Promise<void> {
  const { db, sqlite, paths } = ctx.server.deps;
  await seedFixture(db, sqlite, paths, Date.now(), { papers: list });
}

/** A stored capture of a paper (S's storeCapture + its files row): the file id. */
function capture(ctx: CaseContext, paperId: string): string {
  const stored = storeCapture(ctx.server.deps, paperId, makeTestPng({ width: 20, height: 12 }).toString('base64'));
  ctx.server.deps.db.transaction((tx) => stored.insertRow(tx));
  return stored.fileId;
}

/** In-memory arXiv serving `id` (latest v2) with the synthetic PDF. */
function fake(ctx: CaseContext, id: string, failAt?: 'supplement'): void {
  useSource(ctx.server.deps, new FakeArxivSource({ [id]: { version: 2 } }), {
    beforeStep: failAt
      ? (step) => {
          if (step === failAt) throw new Error(`injected failure at ${step}`);
        }
      : undefined,
  });
}

export const cases: RouteCase[] = [
  {
    route: 'papers.upload', name: 'stores and indexes a local PDF before returning', expect: 'ok',
    raw: () => ({ body: readFileSync(new URL('../fixtures/synthetic-m2.pdf', import.meta.url)), contentType: 'application/pdf', headers: { 'X-SP-Filename': 'synthetic-m2.pdf' } }),
    check: (r, ctx) => {
      const res = r.json as { paperId: string; jobId: string | null; existing: boolean };
      expect(res).toMatchObject({ jobId: null, existing: false });
      expect(paperRow(ctx.server.deps, res.paperId)).toMatchObject({ source: 'upload', ingestStatus: 'done', supplementVersion: 2 });
    },
  },
  {
    route: 'papers.upload', name: 'rejects a PDF filename on a non-PDF body', expect: 'validation',
    raw: { body: Buffer.from('plain text'), contentType: 'application/pdf', headers: { 'X-SP-Filename': 'paper.pdf' } },
  },
  // papers.import
  {
    route: 'papers.import',
    name: 'new arXiv id starts a job that reaches structure_ready',
    expect: 'ok',
    setup: (ctx) => {
      ctx.vars.arxivId = freshId();
      fake(ctx, ctx.vars.arxivId);
    },
    body: (ctx: CaseContext) => ({ input: `https://arxiv.org/abs/${ctx.vars.arxivId}`, clientRequestId: crypto.randomUUID() }),
    check: async (r, ctx) => {
      const res = r.json as ImportPaperResponse;
      expect(res.existing).toBe(false);
      expect(res.jobId).toBeTruthy();
      const job = await waitJob(ctx.server.deps, res.jobId!);
      expect(job.status).toBe('done');
      expect(paperRow(ctx.server.deps, res.paperId)).toMatchObject({ arxivVersion: 2, ingestStatus: 'done', structureSource: 'none' });
    },
  },
  {
    route: 'papers.import',
    name: 'already imported id → existing, no job',
    expect: 'ok',
    setup: async (ctx) => {
      ctx.vars.arxivId = freshId();
      fake(ctx, ctx.vars.arxivId);
      ctx.vars.paperId = (await importAndWait(ctx.server.deps, ctx.vars.arxivId)).res.paperId;
    },
    body: (ctx: CaseContext) => ({ input: `${ctx.vars.arxivId}v1`, clientRequestId: crypto.randomUUID() }),
    check: (r, ctx) => expect(r.json).toEqual({ paperId: ctx.vars.paperId, jobId: null, existing: true, existingVersion: 2, requestedVersion: 1 }),
  },
  { route: 'papers.import', name: 'not an arXiv id', expect: 'validation', body: () => ({ input: 'https://example.com/abs/2209.15397', clientRequestId: crypto.randomUUID() }) },
  { route: 'papers.import', name: 'missing clientRequestId', expect: 'validation', body: { input: '2209.15397' } },

  // papers.list / papers.get / papers.pdf
  { route: 'papers.list', name: 'lists the seed paper', expect: 'ok', check: (r) => expect((r.json as { papers: { id: string }[] }).papers.map((p) => p.id)).toContain(SEED_PAPER_ID) },
  { route: 'papers.get', name: 'seed paper detail (no job → lastJob null)', expect: 'ok', params: { id: SEED_PAPER_ID }, check: (r) => expect((r.json as PaperDetailDto).lastJob).toBeNull() },
  {
    route: 'papers.get',
    name: 'failed import keeps the failed step and error in lastJob',
    expect: 'ok',
    setup: async (ctx) => {
      ctx.vars.arxivId = freshId();
      fake(ctx, ctx.vars.arxivId, 'supplement');
      ctx.vars.paperId = (await importAndWait(ctx.server.deps, ctx.vars.arxivId)).res.paperId;
    },
    params: (ctx) => ({ id: ctx.vars.paperId! }),
    check: (r) => {
      const d = r.json as PaperDetailDto;
      expect(d.ingestStatus).toBe('failed');
      expect(d.state).toEqual({ readable: true, contextReady: false, structureReady: false });
      expect(d.lastJob?.status).toBe('failed');
      expect(d.lastJob?.steps.find((s) => s.step === 'supplement')).toMatchObject({ status: 'error', detail: 'injected failure at supplement' });
      expect(d.lastJob?.error).toContain('injected failure at supplement');
    },
  },
  { route: 'papers.get', name: 'unknown paper', expect: 'not_found', params: { id: MISSING } },
  { route: 'papers.get', name: 'over-long id', expect: 'validation', params: { id: 'x'.repeat(65) } },
  { route: 'papers.pdf', name: 'seed PDF bytes', expect: 'ok', params: { id: SEED_PAPER_ID }, check: (r) => expect(r.body.subarray(0, 5).toString('latin1')).toBe('%PDF-') },
  { route: 'papers.pdf', name: 'unknown paper', expect: 'not_found', params: { id: MISSING } },

  // papers.patch
  {
    route: 'papers.patch',
    name: 'status and tags',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: { status: 'reading', tags: ['slam', ' slam ', 'icp'] },
    check: (r) => expect(r.json).toMatchObject({ status: 'reading', tags: ['slam', 'icp'] }),
  },
  { route: 'papers.patch', name: 'unknown paper', expect: 'not_found', params: { id: MISSING }, body: { status: 'done' } },
  { route: 'papers.patch', name: 'unknown collection', expect: 'not_found', params: { id: SEED_PAPER_ID }, body: { collectionId: MISSING } },
  { route: 'papers.patch', name: 'invalid status', expect: 'validation', params: { id: SEED_PAPER_ID }, body: { status: 'bogus' } },

  // papers.delete
  {
    route: 'papers.delete',
    name: 'imported paper with a highlight → rows and directory gone',
    expect: 'ok',
    setup: async (ctx) => {
      ctx.vars.arxivId = freshId();
      fake(ctx, ctx.vars.arxivId);
      ctx.vars.paperId = (await importAndWait(ctx.server.deps, ctx.vars.arxivId)).res.paperId;
      ctx.server.deps.db
        .insert(highlights)
        .values({ id: crypto.randomUUID(), paperId: ctx.vars.paperId, kind: 'text', color: 1, quoteExact: 'robust kernel', page: 1, rectsJson: '[]', createdAt: 1, updatedAt: 1 })
        .run();
    },
    params: (ctx) => ({ id: ctx.vars.paperId! }),
    check: (_r, ctx) => {
      const { deps } = ctx.server;
      expect(deps.db.select().from(papers).where(eq(papers.id, ctx.vars.paperId!)).get()).toBeUndefined();
      expect(deps.db.select().from(highlights).where(eq(highlights.paperId, ctx.vars.paperId!)).all()).toEqual([]);
    },
  },
  { route: 'papers.delete', name: 'unknown paper', expect: 'not_found', params: { id: MISSING } },

  // papers.retryIngest
  {
    route: 'papers.retryIngest',
    name: 'failed at supplement → retry from supplement reaches structure_ready',
    expect: 'ok',
    setup: async (ctx) => {
      ctx.vars.arxivId = freshId();
      fake(ctx, ctx.vars.arxivId, 'supplement');
      ctx.vars.paperId = (await importAndWait(ctx.server.deps, ctx.vars.arxivId)).res.paperId;
      fake(ctx, ctx.vars.arxivId); // the failure is gone
    },
    params: (ctx) => ({ id: ctx.vars.paperId! }),
    check: async (r, ctx) => {
      const { jobId } = r.json as { jobId: string };
      const job = await waitJob(ctx.server.deps, jobId);
      expect(job.status).toBe('done');
      expect(JSON.parse(job.stepsJson)).toEqual([
        { step: 'resolve', status: 'skipped', detail: 'done in an earlier job' },
        { step: 'metadata', status: 'skipped', detail: 'done in an earlier job' },
        { step: 'pdf', status: 'skipped', detail: 'done in an earlier job' },
        { step: 'text', status: 'skipped', detail: 'done in an earlier job' },
        { step: 'html', status: 'skipped', detail: `html_not_found: arXiv has no HTML for ${ctx.vars.arxivId}v2` },
        { step: 'structure', status: 'skipped', detail: 'no HTML' },
        { step: 'anchor', status: 'skipped', detail: 'no structure' },
        { step: 'supplement', status: 'ok', detail: 'v1, contextMode=pdf' },
      ]);
      expect(paperRow(ctx.server.deps, ctx.vars.paperId!)?.structureReadyAt).not.toBeNull();
    },
  },
  { route: 'papers.retryIngest', name: 'structure_ready paper → 409', expect: 'conflict', params: { id: SEED_PAPER_ID } },
  { route: 'papers.retryIngest', name: 'unknown paper', expect: 'not_found', params: { id: MISSING } },
  // papers.structure (S10: minimal read handler)
  {
    route: 'papers.structure',
    name: 'the seed paper: its sections and equations in ordinal order, figures/references empty',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    check: (r) => {
      const res = r.json as StructureResponse;
      expect(res.structureSource).toBe('latexml');
      expect(res.sections.map((x) => [x.number, x.title, x.pdfPage, x.pdfRect])).toEqual([
        ['I', 'Introduction', 1, null],
        ['II', 'Method', 2, null],
      ]);
      expect(res.equations.map((x) => x.number)).toEqual(['1', '2']);
      expect(res.figures).toEqual([]);
      expect(res.references).toEqual([]);
    },
  },
  { route: 'papers.structure', name: 'unknown paper → 404', expect: 'not_found', params: { id: MISSING } },
  {
    route: 'papers.structure',
    name: 'SEED_M2: four sections, numbered and unnumbered equations, [2] in the Library (decided on read)',
    expect: 'ok',
    setup: (ctx) => seedM2(ctx, ['links', 'm2']),
    params: { id: SEED_M2_PAPER_ID },
    check: (r) => {
      const res = r.json as StructureResponse;
      expect(res.sections.map((x) => x.number)).toEqual(['I', 'II', 'II-A', 'II-B']);
      expect(res.equations.map((x) => x.number)).toEqual(['1', '2', '3', '4', null, 'A.1', 'A.1']);
      expect(res.references.map((x) => x.inLibraryPaperId)).toEqual([null, SEED_LINKS_PAPER_ID, null]);
    },
  },

  // papers.upgradeStructure (M2)
  {
    route: 'papers.upgradeStructure',
    name: 'the M1 seed SEED_UPGRADE → a job that publishes v2; lastJob stays the ingest job',
    expect: 'ok',
    setup: async (ctx) => {
      await seedM2(ctx, ['upgrade']);
      useSource(ctx.server.deps, new FakeArxivSource({ '2301.00002': { version: 1, html: SYN_M2_HTML } }));
    },
    params: { id: SEED_UPGRADE_PAPER_ID },
    check: async (r, ctx) => {
      const { jobId } = r.json as { jobId: string };
      await ingestService(ctx.server.deps).whenDone(jobId);
      expect(paperRow(ctx.server.deps, SEED_UPGRADE_PAPER_ID)).toMatchObject({ supplementVersion: 2, structureSource: 'latexml', ingestStatus: 'done' });
      const d = JSON.parse((await ctx.server.req(`/api/papers/${SEED_UPGRADE_PAPER_ID}`, { headers: { 'X-SP-Token': ctx.server.token } })).text) as PaperDetailDto;
      expect(d.lastJob?.kind).toBe('import_arxiv');
      expect(d.structureUpgrade).toMatchObject({ available: false, job: { id: jobId, status: 'done' } });
    },
  },
  { route: 'papers.upgradeStructure', name: 'not a target (an upload paper) → 409', expect: 'conflict', params: { id: SEED_PAPER_ID } },
  { route: 'papers.upgradeStructure', name: 'unknown paper → 404', expect: 'not_found', params: { id: MISSING } },
  { route: 'papers.upgradeStructure', name: 'over-long id → 400', expect: 'validation', params: { id: 'x'.repeat(65) } },

  // papers.capture (M2)
  {
    route: 'papers.capture',
    name: 'a capture of the paper → image/png with the stored bytes',
    expect: 'ok',
    setup: (ctx) => {
      ctx.vars.fileId = capture(ctx, SEED_PAPER_ID);
    },
    params: (ctx) => ({ id: SEED_PAPER_ID, fileId: ctx.vars.fileId! }),
    check: (r) => expect(r.body.equals(makeTestPng({ width: 20, height: 12 }))).toBe(true),
  },
  {
    route: 'papers.capture',
    name: 'a capture of ANOTHER paper → 404 (never served through this paper)',
    expect: 'not_found',
    setup: async (ctx) => {
      await seedM2(ctx, ['links']);
      ctx.vars.fileId = capture(ctx, SEED_LINKS_PAPER_ID);
    },
    params: (ctx) => ({ id: SEED_PAPER_ID, fileId: ctx.vars.fileId! }),
  },
  {
    route: 'papers.capture',
    name: 'a files row that is not a capture (the PDF) → 404',
    expect: 'not_found',
    setup: (ctx) => {
      ctx.vars.fileId = (ctx.server.deps.sqlite.prepare(`SELECT id FROM files WHERE paperId = ? AND kind = 'pdf'`).get(SEED_PAPER_ID) as { id: string }).id;
    },
    params: (ctx) => ({ id: SEED_PAPER_ID, fileId: ctx.vars.fileId! }),
  },
  { route: 'papers.capture', name: 'unknown file id → 404', expect: 'not_found', params: { id: SEED_PAPER_ID, fileId: MISSING } },
  { route: 'papers.capture', name: 'a file id that is not an id (path characters) → 400', expect: 'validation', params: { id: SEED_PAPER_ID, fileId: 'x'.repeat(65) } },
];
