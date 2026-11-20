// Owner A. Routes: 'notes.list', 'notes.create', 'notes.patch', 'notes.delete' (M2).
// A note belongs to one paper; its highlightId / sectionId must be rows of that same paper (400 otherwise). At most
// NOTES_PER_PAPER notes per paper (409). bodyMd is stored as given (the web renders it with SpMarkdown, mode plain).
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { NoteDto } from '@study-paper/shared/contracts/api';
import { highlights, notes, papers, sections } from '../db/schema';
import { HttpError, notFound, routeBody, routeJson, routeParams, type AppDeps, type RouteModule } from '../deps';

export const NOTES_PER_PAPER = 2_000;

function livePaper(deps: AppDeps, id: string): void {
  const row = deps.db.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, id)).get();
  if (!row || row.deletingAt !== null) throw notFound('paper');
}

function liveNote(deps: AppDeps, id: string): typeof notes.$inferSelect {
  const n = deps.db.select().from(notes).where(eq(notes.id, id)).get();
  if (!n) throw notFound('note');
  livePaper(deps, n.paperId);
  return n;
}

const toDto = (n: typeof notes.$inferSelect): NoteDto => ({ id: n.id, paperId: n.paperId, highlightId: n.highlightId, sectionId: n.sectionId, bodyMd: n.bodyMd, createdAt: n.createdAt, updatedAt: n.updatedAt });

export const notesRoutes: RouteModule = (deps) => ({
  'notes.list': (c) => {
    const { id } = routeParams(c, 'notes.list');
    livePaper(deps, id);
    const rows = deps.db.select().from(notes).where(eq(notes.paperId, id)).orderBy(asc(notes.createdAt), asc(sql`rowid`)).all();
    return routeJson(c, 'notes.list', { notes: rows.map(toDto) });
  },
  'notes.create': async (c) => {
    const { id } = routeParams(c, 'notes.create');
    const body = await routeBody(c, 'notes.create');
    const now = Date.now();
    const noteId = randomUUID();
    deps.sqlite.transaction(() => {
      livePaper(deps, id);
      if (body.highlightId !== undefined && !deps.db.select({ id: highlights.id }).from(highlights).where(and(eq(highlights.id, body.highlightId), eq(highlights.paperId, id))).get()) {
        throw new HttpError(400, 'validation', 'highlightId is not a highlight of this paper');
      }
      if (body.sectionId !== undefined && !deps.db.select({ id: sections.id }).from(sections).where(and(eq(sections.id, body.sectionId), eq(sections.paperId, id))).get()) {
        throw new HttpError(400, 'validation', 'sectionId is not a section of this paper');
      }
      const n = deps.db.select({ n: sql<number>`count(*)` }).from(notes).where(eq(notes.paperId, id)).get()?.n ?? 0;
      if (n >= NOTES_PER_PAPER) throw new HttpError(409, 'conflict', `this paper already has ${NOTES_PER_PAPER} notes`);
      deps.db.insert(notes).values({ id: noteId, paperId: id, highlightId: body.highlightId ?? null, sectionId: body.sectionId ?? null, bodyMd: body.bodyMd, createdAt: now, updatedAt: now }).run();
    })();
    return routeJson(c, 'notes.create', toDto(deps.db.select().from(notes).where(eq(notes.id, noteId)).get()!));
  },
  'notes.patch': async (c) => {
    const { id } = routeParams(c, 'notes.patch');
    const body = await routeBody(c, 'notes.patch');
    liveNote(deps, id);
    deps.db.update(notes).set({ bodyMd: body.bodyMd, updatedAt: Date.now() }).where(eq(notes.id, id)).run();
    return routeJson(c, 'notes.patch', toDto(deps.db.select().from(notes).where(eq(notes.id, id)).get()!));
  },
  'notes.delete': (c) => {
    const { id } = routeParams(c, 'notes.delete');
    liveNote(deps, id);
    deps.db.delete(notes).where(eq(notes.id, id)).run();
    return c.body(null, 204);
  },
});
