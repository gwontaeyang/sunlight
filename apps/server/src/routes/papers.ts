// Owner A. Routes: 'papers.import', 'papers.list', 'papers.get', 'papers.patch', 'papers.delete', 'papers.pdf',
// 'papers.retryIngest' (M1); 'papers.structure', 'papers.upgradeStructure', 'papers.capture' (M2); 'papers.upload' (M3).
// lastJob = the latest INGEST job; the upgrade job is structureUpgrade.job only.
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { LastPositionDto, type PaperDetailDto, type PaperSummaryDto, type StructureResponse } from '@study-paper/shared/contracts/api';
import { NormRectSchema, type NormRect } from '@study-paper/shared/contracts/domain';
import { collections, equations, figures, files, paperReferences, papers, sections } from '../db/schema';
import { notFound, routeBody, routeJson, routeParams, type AppDeps, type RouteModule } from '../deps';
import { createPdfUploader } from '../ingest/upload';
import { resetStoredCooldown } from '../ingest/cooldownStore';
import { aiAvailability } from '../ingest/readiness';
import { DELETE_WAIT_MS, ingestService, INGEST_KINDS, latestJob, PDF_FILE, peekIngest, UPGRADE_KINDS } from '../ingest/pipeline';
import { structureUpgradeState } from '../ingest/structureUpgradeState';
import { clearPaperResultRaw } from '../resultRetention';

type PaperRow = typeof papers.$inferSelect;

const jsonArray = (s: string | null): string[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

export function toPaperSummary(p: PaperRow): PaperSummaryDto {
  return {
    id: p.id,
    source: p.source,
    arxivId: p.arxivId,
    arxivVersion: p.arxivVersion,
    title: p.title,
    authors: jsonArray(p.authorsJson),
    year: p.year,
    status: p.status,
    ingestStatus: p.ingestStatus,
    state: { readable: p.readableAt !== null, contextReady: p.contextReadyAt !== null, structureReady: p.structureReadyAt !== null },
    ai: aiAvailability(p),
    pageCount: p.pageCount,
    collectionId: p.collectionId,
    tags: jsonArray(p.tagsJson),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastOpenedAt: p.lastOpenedAt,
    // M2: the same decision as PaperDetailDto.structureUpgrade.available (structureUpgradeState).
    structureSource: p.structureSource,
    supplementVersion: p.supplementVersion,
    structureUpgradeAvailable: structureUpgradeState(p, null).available,
  };
}

export function toPaperDetail(p: PaperRow, lastJob: PaperDetailDto['lastJob'] = null, upgradeJob: PaperDetailDto['lastJob'] = null): PaperDetailDto {
  let lastPosition: PaperDetailDto['lastPosition'] = null;
  try {
    // M2 form ({page, zoom, mode, top}); an M1 value ({page, zoom}) parses with mode 'custom', top 0.
    const parsed = p.lastPositionJson ? LastPositionDto.safeParse(JSON.parse(p.lastPositionJson)) : null;
    lastPosition = parsed?.success ? parsed.data : null;
  } catch {
    lastPosition = null;
  }
  return {
    ...toPaperSummary(p),
    abstract: p.abstract,
    doi: p.doi,
    venue: p.venue,
    primaryCategory: p.primaryCategory,
    publishedAt: p.publishedAt,
    codeUrl: p.codeUrl,
    projectUrl: p.projectUrl,
    citationCount: p.citationCount,
    structureSource: p.structureSource,
    contextMode: p.contextMode,
    ingestWarnings: jsonArray(p.ingestWarningsJson),
    readableAt: p.readableAt,
    contextReadyAt: p.contextReadyAt,
    structureReadyAt: p.structureReadyAt,
    lastPosition,
    lastJob,
    structureUpgrade: structureUpgradeState(p, upgradeJob),
  };
}

function livePaper(deps: AppDeps, id: string): PaperRow {
  const row = deps.db.select().from(papers).where(eq(papers.id, id)).get();
  if (!row || row.deletingAt !== null) throw notFound('paper');
  return row;
}

const detail = (deps: AppDeps, row: PaperRow) => toPaperDetail(row, latestJob(deps, row.id, INGEST_KINDS), latestJob(deps, row.id, UPGRADE_KINDS));

/**
 * PLAN 4.1 deletion: deletingAt (tombstone: the paper is 404 / unlisted / not importable from here on) → cancel the
 * paper's ingest jobs and LLM runs → wait (<= deleteWaitMs, default 5 s) until they have stopped → delete the rows
 * in one transaction (cascade; citation triggers) → remove the directory.
 *
 * M1.1 M6: the rows and the directory are removed only after every writer has stopped, so a still-running writer
 * can never re-create papers/<id>/ after the API answered. When a writer is slower than the wait, the API still
 * answers 204 (the tombstone already hides the paper) and the final cleanup runs as soon as the writers end;
 * startup recovery finishes it if the server stops first (papers with deletingAt, orphan directories). Writers
 * additionally re-check their abort signal right before publishing into the directory.
 */
async function deletePaper(deps: AppDeps, id: string): Promise<'deleted' | 'deferred'> {
  // S (PLAN_M2 3.4 rule 6): stored run results (glossary suggestions) go in the tombstone transaction.
  deps.sqlite.transaction(() => {
    deps.db.update(papers).set({ deletingAt: Date.now() }).where(eq(papers.id, id)).run();
    clearPaperResultRaw(deps.sqlite, id);
  })();
  const ingest = peekIngest(deps);
  const waitMs = ingest?.deleteWaitMs ?? DELETE_WAIT_MS;
  const ingestEnded = ingest?.abortPaper(id) ?? Promise.resolve();
  const runIds = (deps.sqlite.prepare(`SELECT runId FROM llm_calls WHERE paperId = ? AND status IN ('queued', 'running')`).all(id) as { runId: string }[]).map((r) => r.runId);
  const handles = runIds.map((r) => deps.runs.get(r)).filter((h) => h !== null);
  for (const h of handles) h.cancel();
  const writersEnded = Promise.all([ingestEnded, ...handles.map((h) => h.done)]).then(() => true as const);
  let timer: NodeJS.Timeout | undefined;
  const ok = await Promise.race([writersEnded, new Promise<false>((r) => (timer = setTimeout(() => r(false), waitMs)))]);
  clearTimeout(timer);
  if (ok) {
    finalizeDelete(deps, id);
    return 'deleted';
  }
  console.error(`[papers] delete ${id}: ingest job / LLM run still running after ${waitMs} ms; cleanup continues when they end`);
  void writersEnded.then(() => finalizeDelete(deps, id));
  return 'deferred';
}

function finalizeDelete(deps: AppDeps, id: string): void {
  try {
    deps.sqlite.transaction(() => {
      // S: BEFORE the DELETE (its FK SET NULL would clear paperId first): results written after the tombstone.
      clearPaperResultRaw(deps.sqlite, id);
      deps.db.delete(papers).where(and(eq(papers.id, id), isNotNull(papers.deletingAt))).run();
    })();
  } catch (e) {
    console.error(`[papers] delete ${id}: could not delete the rows (startup recovery retries): ${(e as Error).message}`);
    return;
  }
  try {
    rmSync(deps.paths.paperDir(id), { recursive: true, force: true });
  } catch (e) {
    console.error(`[papers] delete ${id}: could not remove the directory (startup recovery retries): ${(e as Error).message}`);
  }
}

const rectOf = (json: string | null): NormRect | null => {
  if (!json) return null;
  try {
    const r = NormRectSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
};

/**
 * papers.structure: the structure rows of the paper in ordinal order (equations with and without a number; figures in
 * insertion = document order), empty arrays + structureSource when it has none. ReferenceDto.inLibraryPaperId is
 * decided on read: a Library paper (not being deleted, any version) with the reference's arxivId — never stored
 * (PLAN_M2 3.2), so a paper imported later shows up too.
 */
function readStructure(deps: AppDeps, paper: PaperRow): StructureResponse {
  const id = paper.id;
  const secs = deps.db.select().from(sections).where(eq(sections.paperId, id)).orderBy(asc(sections.ordinal)).all();
  const eqs = deps.db.select().from(equations).where(eq(equations.paperId, id)).orderBy(asc(equations.ordinal)).all();
  const figs = deps.db.select().from(figures).where(eq(figures.paperId, id)).orderBy(asc(sql`rowid`)).all(); // insertion = document order
  const refs = deps.db.select().from(paperReferences).where(eq(paperReferences.paperId, id)).orderBy(asc(paperReferences.ordinal)).all();
  const arxivIds = [...new Set(refs.map((r) => r.arxivId).filter((a): a is string => a !== null))];
  const library = new Map(
    arxivIds.length === 0
      ? []
      : deps.db
          .select({ id: papers.id, arxivId: papers.arxivId })
          .from(papers)
          .where(and(inArray(papers.arxivId, arxivIds), isNull(papers.deletingAt)))
          .all()
          .map((p) => [p.arxivId!, p.id] as const),
  );
  return {
    structureSource: paper.structureSource,
    sections: secs.map((s) => ({ id: s.id, parentId: s.parentId, htmlId: s.htmlId, number: s.number, title: s.title, level: s.level, ordinal: s.ordinal, pdfPage: s.pdfPage, pdfOffset: s.pdfOffset, pdfRect: rectOf(s.pdfRectJson) })),
    equations: eqs.map((e) => ({ id: e.id, sectionId: e.sectionId, htmlId: e.htmlId, number: e.number, ordinal: e.ordinal, latexRaw: e.latexRaw, latex: e.latex.slice(0, 4000), katexOk: e.katexOk, pdfPage: e.pdfPage, pdfOffset: e.pdfOffset, pdfRect: rectOf(e.pdfRectJson) })),
    figures: figs.map((f) => ({ id: f.id, sectionId: f.sectionId, htmlId: f.htmlId, kind: f.kind, number: f.number, caption: f.caption, pdfPage: f.pdfPage })),
    references: refs.map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      label: r.label,
      rawText: r.rawText,
      title: r.title,
      authors: jsonArray(r.authorsJson),
      year: r.year,
      venue: r.venue,
      doi: r.doi,
      arxivId: r.arxivId,
      citationCount: r.citationCount,
      inLibraryPaperId: r.arxivId ? (library.get(r.arxivId) ?? null) : null,
      htmlId: r.htmlId,
    })),
  };
}

export const papersRoutes: RouteModule = (deps) => {
  // SP_ARXIV_COOLDOWN_RESET=1 applies when the server starts (createApp builds the route modules once, after the
  // startup recovery and before listen), not only when the ingest service is first created (BRIEF_A A1). Idempotent.
  if (deps.config.arxivCooldownReset) resetStoredCooldown(deps.sqlite, 'arxiv');
  const upload = createPdfUploader(deps);
  return { ...papersHandlers(deps), 'papers.upload': async (c) => routeJson(c, 'papers.upload', await upload(c.req.raw)) };
};

const papersHandlers: RouteModule = (deps) => ({
  'papers.import': async (c) => {
    const body = await routeBody(c, 'papers.import');
    return routeJson(c, 'papers.import', ingestService(deps).importArxiv(body.input));
  },
  'papers.list': (c) => {
    const rows = deps.db.select().from(papers).orderBy(desc(papers.createdAt)).all();
    return routeJson(c, 'papers.list', { papers: rows.filter((p) => p.deletingAt === null).map(toPaperSummary) });
  },
  'papers.get': (c) => {
    const { id } = routeParams(c, 'papers.get');
    return routeJson(c, 'papers.get', detail(deps, livePaper(deps, id)));
  },
  'papers.patch': async (c) => {
    const { id } = routeParams(c, 'papers.patch');
    const body = await routeBody(c, 'papers.patch');
    livePaper(deps, id);
    if (body.collectionId) {
      const col = deps.db.select({ id: collections.id }).from(collections).where(eq(collections.id, body.collectionId)).get();
      if (!col) throw notFound('collection');
    }
    const set: Partial<typeof papers.$inferInsert> = { updatedAt: Date.now() };
    if (body.title !== undefined) set.title = body.title;
    if (body.status !== undefined) set.status = body.status;
    if (body.collectionId !== undefined) set.collectionId = body.collectionId;
    if (body.tags !== undefined) set.tagsJson = JSON.stringify([...new Set(body.tags.map((t) => t.trim()).filter((t) => t.length > 0))]);
    deps.db.update(papers).set(set).where(eq(papers.id, id)).run();
    return routeJson(c, 'papers.patch', detail(deps, livePaper(deps, id)));
  },
  'papers.delete': async (c) => {
    const { id } = routeParams(c, 'papers.delete');
    livePaper(deps, id);
    await deletePaper(deps, id);
    return c.body(null, 204);
  },
  'papers.pdf': (c) => {
    const { id } = routeParams(c, 'papers.pdf');
    livePaper(deps, id);
    const file = join(deps.paths.paperDir(id), PDF_FILE);
    if (!existsSync(file)) throw notFound('pdf');
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(statSync(file).size) } });
  },
  'papers.structure': (c) => {
    const { id } = routeParams(c, 'papers.structure');
    return routeJson(c, 'papers.structure', readStructure(deps, livePaper(deps, id)));
  },
  'papers.retryIngest': (c) => {
    const { id } = routeParams(c, 'papers.retryIngest');
    return routeJson(c, 'papers.retryIngest', ingestService(deps).retry(id));
  },
  'papers.upgradeStructure': (c) => {
    const { id } = routeParams(c, 'papers.upgradeStructure');
    return routeJson(c, 'papers.upgradeStructure', ingestService(deps).upgradeStructure(id));
  },
  /** A capture PNG of the paper: only a `files` row of kind 'capture' of THIS paper; the path comes from paths.ts. */
  'papers.capture': (c) => {
    const { id, fileId } = routeParams(c, 'papers.capture');
    livePaper(deps, id);
    const row = deps.db.select({ id: files.id }).from(files).where(and(eq(files.id, fileId), eq(files.paperId, id), eq(files.kind, 'capture'))).get();
    if (!row) throw notFound('capture');
    const file = deps.paths.captureFile(id, row.id);
    if (!existsSync(file)) throw notFound('capture');
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(statSync(file).size) } });
  },
});
