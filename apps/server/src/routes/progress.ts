// Owner A. Routes: 'progress.list', 'progress.put', 'papers.position' (M2, PLAN_M2 3.8).
// - progress.put upserts (paperId, sectionId) → state; the section must be one of THIS paper's sections (404 otherwise).
// - papers.position stores the last reading position ({page, zoom, mode, top}) and lastOpenedAt; a page beyond the
//   paper's pageCount is 400, a paper without pages yet 409.
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ProgressDto } from '@study-paper/shared/contracts/api';
import { papers, readingProgress, sections } from '../db/schema';
import { HttpError, notFound, routeBody, routeJson, routeParams, type AppDeps, type RouteModule } from '../deps';

function livePaper(deps: AppDeps, id: string) {
  const row = deps.db.select({ id: papers.id, deletingAt: papers.deletingAt, pageCount: papers.pageCount }).from(papers).where(eq(papers.id, id)).get();
  if (!row || row.deletingAt !== null) throw notFound('paper');
  return row;
}

const toDto = (r: typeof readingProgress.$inferSelect): ProgressDto => ({ sectionId: r.sectionId, state: r.state, updatedAt: r.updatedAt });

export const progressRoutes: RouteModule = (deps) => ({
  'progress.list': (c) => {
    const { id } = routeParams(c, 'progress.list');
    livePaper(deps, id);
    const rows = deps.db
      .select({ p: readingProgress })
      .from(readingProgress)
      .innerJoin(sections, eq(sections.id, readingProgress.sectionId))
      .where(eq(readingProgress.paperId, id))
      .orderBy(asc(sections.ordinal))
      .all()
      .map((r) => r.p);
    return routeJson(c, 'progress.list', { progress: rows.map(toDto) });
  },
  'progress.put': async (c) => {
    const { id, sectionId } = routeParams(c, 'progress.put');
    const body = await routeBody(c, 'progress.put');
    livePaper(deps, id);
    const sec = deps.db.select({ id: sections.id }).from(sections).where(and(eq(sections.id, sectionId), eq(sections.paperId, id))).get();
    if (!sec) throw notFound('section');
    const now = Date.now();
    deps.db
      .insert(readingProgress)
      .values({ paperId: id, sectionId, state: body.state, updatedAt: now })
      .onConflictDoUpdate({ target: [readingProgress.paperId, readingProgress.sectionId], set: { state: body.state, updatedAt: now } })
      .run();
    const row = deps.db.select().from(readingProgress).where(and(eq(readingProgress.paperId, id), eq(readingProgress.sectionId, sectionId))).get()!;
    return routeJson(c, 'progress.put', toDto(row));
  },
  'papers.position': async (c) => {
    const { id } = routeParams(c, 'papers.position');
    const body = await routeBody(c, 'papers.position');
    const paper = livePaper(deps, id);
    if (paper.pageCount === null) throw new HttpError(409, 'conflict', 'the paper has no pages yet');
    if (body.page > paper.pageCount) throw new HttpError(400, 'validation', `page ${body.page} is beyond the last page (${paper.pageCount})`);
    const now = Date.now();
    const r = deps.db
      .update(papers)
      .set({ lastPositionJson: JSON.stringify({ page: body.page, zoom: body.zoom, mode: body.mode, top: body.top }), lastOpenedAt: now })
      .where(and(eq(papers.id, id), sql`${papers.deletingAt} IS NULL`))
      .run();
    if (r.changes !== 1) throw notFound('paper');
    return c.body(null, 204);
  },
});
