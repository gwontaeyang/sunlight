// Owner B. Routes: 'threads.list', 'threads.get', 'threads.delete', 'threads.create', 'messages.create'.
// threads.create always makes a new thread (re-opening the thread of the same selection is the web's job).
// The thread, its user message, the assistant message and the llm_calls row are inserted in the run's start
// transaction (runContract rule 2) — a repeated clientRequestId attaches to its run before anything is written.
// Payload identity (rule 1, review M3): the request body as sent (normalised, without clientRequestId) + the path
// parameter; values the server derives from the DB (history, the task of a regenerate, context) are not part of it.
// Regenerate is replace-on-success (review M4): the old turn stays until the new answer is stored.
//
// M2 (PLAN_M2 3.4–3.7, runContract rule 1a):
// - Request id first: right after the body schema, runs.findExisting(probe) — before the thread / paper lookup, the
//   readiness check, the kind table, the capture write and the row inserts. A known id answers from its run (attach,
//   replay, result_deleted, superseded) or 409; nothing else happens.
// - threads.create kind table (contracts/api.ts CreateThreadRequest comment) in ONE function, checkKind: a field a
//   kind does not take is a 400 (never ignored). deep is allowed only where the server-side task supportsDeep.
// - Captures (figure / equation with imagePng): inspectPng → storeCapture only for a new run → the files row and
//   threads.imageFileId in the run's start transaction; discard() when runTask throws or attached to another start.
//   Follow-ups and regenerates re-attach the stored PNG as storedImagePngBase64 (not part of the payload hash).
// - translate needs a readable paper only (no PDF / supplement prefix); its thread takes no follow-up question, only
//   "다시 생성". figure / equation follow-ups are task chat with the stored image.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'hono';
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { streamSSE } from 'hono/streaming';
import type { CreateThreadRequest, MessageDto, PostMessageRequest, ThreadDto } from '@study-paper/shared/contracts/api';
import { AnchorSchema, MessageStatsSchema, type Anchor, type ThreadKind } from '@study-paper/shared/contracts/domain';
import { Effort, supportsDeep, TASK_SPECS, TaskId } from '@study-paper/shared/contracts/tasks';
import { matchQuote } from '@study-paper/shared/anchor/matchQuote';
import { normalizeN1 } from '@study-paper/shared/anchor/normalize';
import { inspectPng } from '@study-paper/shared/image/png';
import { storeCapture, type StoredCapture } from '../captures';
import { equations, figures, files, glossaryTerms, llmCalls, messages, pageTexts, papers, sections, threads } from '../db/schema';
import { HttpError, notFound, routeBody, routeJson, routeParams, type AppDeps, type RouteModule } from '../deps';
import { readCitations as readOwnerCitations } from '../llm/citationStore';
import type { RunHandle } from '../llm/runContract';
import type { RunTaskRequest, Tx } from '../llm/runManager';
import { FIELD_LIMITS, fitHistory, type HistoryTurn } from '../llm/taskSerialize';

type CreateThreadBody = Omit<CreateThreadRequest, 'clientRequestId'>;

const TASK_BY_KIND: Partial<Record<string, TaskId>> = { explain: 'explain_selection', chat: 'chat' };

type ThreadRow = typeof threads.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

const parseJson = <T>(s: string | null, f: (v: unknown) => T, fallback: T): T => {
  if (!s) return fallback;
  try {
    return f(JSON.parse(s));
  } catch {
    return fallback;
  }
};
const parseAnchor = (s: string | null): Anchor | null => parseJson(s, (v) => AnchorSchema.parse(v), null);

export function toThreadDto(t: ThreadRow): ThreadDto {
  return { id: t.id, paperId: t.paperId, kind: t.kind, title: t.title, anchor: parseAnchor(t.anchorJson), highlightId: t.highlightId, equationId: t.equationId, sectionId: t.sectionId, imageFileId: t.imageFileId, createdAt: t.createdAt, updatedAt: t.updatedAt };
}

export function toMessageDto(deps: AppDeps, m: MessageRow): MessageDto {
  return {
    id: m.id,
    threadId: m.threadId,
    role: m.role,
    contentMd: m.contentMd,
    status: m.status,
    stats: parseJson(m.statsJson, (v) => MessageStatsSchema.parse(v), null),
    issues: parseJson(m.issuesJson, (v) => (Array.isArray(v) ? v.map(String) : []), [] as string[]),
    citations: m.role === 'assistant' ? readOwnerCitations(deps.db, 'message', m.id) : [],
    llmCallId: m.llmCallId,
    effort: m.llmCallId ? effortOf(deps, m.llmCallId) : null,
    createdAt: m.createdAt,
  };
}

/** llm_calls.effort of a run (MessageDto.effort); null when the row is gone or holds an unknown value. */
function effortOf(deps: AppDeps, runId: string): MessageDto['effort'] {
  const row = deps.db.select({ effort: llmCalls.effort }).from(llmCalls).where(eq(llmCalls.runId, runId)).get();
  const parsed = Effort.safeParse(row?.effort);
  return parsed.success ? parsed.data : null;
}

/** sha256 of the N1-normalised quote (PLAN 2.5: same selection → same hash). */
export const quoteHash = (quote: string) => createHash('sha256').update(normalizeN1(quote).text).digest('hex');

const oneLine = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

const threadMessages = (tx: Tx | AppDeps['db'], threadId: string) => tx.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(asc(messages.createdAt), asc(sql`rowid`)).all();

/** Section label (number + title) of a page, from the structure index (undefined when there is none). */
function sectionOf(tx: Tx, paperId: string, page: number | undefined): string | undefined {
  if (page === undefined) return undefined;
  const s = tx
    .select({ number: sections.number, title: sections.title })
    .from(sections)
    .where(and(eq(sections.paperId, paperId), lte(sections.pdfPage, page)))
    .orderBy(desc(sections.pdfPage), desc(sections.ordinal))
    .get();
  return s ? `${s.number ? `${s.number} ` : ''}${s.title}` : undefined;
}

const anchorPage = (a: Anchor | null): number | undefined => a?.position?.page ?? a?.rects[0]?.page;

/** SSE response for a run. A disconnect cancels a cancelOnDisconnect task only when no other stream follows it. */
const followers = new Map<string, number>();
export function streamRun(c: Context, handle: RunHandle, task: TaskId) {
  return streamSSE(c, async (stream) => {
    const id = handle.runId;
    followers.set(id, (followers.get(id) ?? 0) + 1);
    let open = true;
    const leave = (disconnected: boolean) => {
      if (!open) return;
      open = false;
      const n = (followers.get(id) ?? 1) - 1;
      if (n > 0) followers.set(id, n);
      else {
        followers.delete(id);
        if (disconnected && TASK_SPECS[task].cancelOnDisconnect) handle.cancel();
      }
    };
    stream.onAbort(() => leave(true));
    try {
      for await (const ev of handle.subscribe()) {
        if (stream.aborted) break;
        await stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) });
      }
    } finally {
      leave(false);
    }
  });
}

/** 404 for a missing / tombstoned paper, 409 context_not_ready until the paper context is ready. */
function requirePaperReady(deps: AppDeps, paperId: string) {
  const paper = deps.db.select({ id: papers.id, contextReadyAt: papers.contextReadyAt, deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, paperId)).get();
  if (!paper || paper.deletingAt !== null) throw notFound('paper');
  if (paper.contextReadyAt === null) throw new HttpError(409, 'context_not_ready', 'paper context is not ready yet');
}

/** translate (PLAN_M2 3.6): readable is enough — no PDF / supplement prefix. */
function requirePaperReadable(deps: AppDeps, paperId: string) {
  const paper = deps.db.select({ readableAt: papers.readableAt, deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, paperId)).get();
  if (!paper || paper.deletingAt !== null) throw notFound('paper');
  if (paper.readableAt === null) throw new HttpError(409, 'context_not_ready', 'the paper is not readable yet');
}

/** The task of a stored run (decides cancelOnDisconnect of an attached stream). */
function taskOfRun(deps: AppDeps, runId: string, fallback: TaskId): TaskId {
  const t = TaskId.safeParse(deps.db.select({ task: llmCalls.task }).from(llmCalls).where(eq(llmCalls.runId, runId)).get()?.task);
  return t.success ? t.data : fallback;
}

/** The task of a thread kind's first turn (also what "다시 생성" of that turn runs again). */
const FIRST_TASK: Record<ThreadKind, TaskId> = { explain: 'explain_selection', chat: 'chat', translate: 'translate_selection', figure: 'figure_area', equation: 'equation_deep' };

const bad = (msg: string) => new HttpError(400, 'validation', msg);

/** A normalised threads.create request after the kind table (PLAN_M2 3.5–3.7). */
interface CheckedCreate {
  task: TaskId;
  selection?: string;
  question?: string;
  /** area anchor of figure / equation captures (exactly one rect). */
  area?: Anchor;
  imagePng?: string;
  equationId?: string;
}

/**
 * The threads.create kind table (the comment above CreateThreadRequest in contracts/api.ts) — the ONE place it is
 * enforced. Anything outside the table is a 400, never ignored.
 */
export function checkKind(body: CreateThreadBody): CheckedCreate {
  const kind = body.kind;
  const has = { anchor: body.anchor !== undefined, text: body.text !== undefined, question: body.question !== undefined, imagePng: body.imagePng !== undefined, equationId: body.equationId !== undefined, deep: body.deep === true };
  const forbid = (...fields: (keyof typeof has)[]) => {
    for (const f of fields) if (has[f]) throw bad(`${f} is not allowed for a ${kind} thread`);
  };
  const task = FIRST_TASK[kind];
  if (has.deep && !supportsDeep(task)) throw bad(`deep is not available for a ${kind} thread`);
  const question = body.question?.trim() ? body.question : undefined;
  const textSelection = () => {
    if (body.anchor !== undefined && body.anchor.kind !== 'text') throw bad(`a ${kind} thread needs a text selection`);
    const selection = body.anchor?.quote?.exact ?? body.text;
    if (!selection?.trim()) throw bad(`${kind} needs a text selection (anchor.quote or text)`);
    return selection;
  };
  const areaOf = () => {
    if (body.anchor?.kind !== 'area' || body.anchor.rects.length !== 1) throw bad(`a ${kind} capture needs an area anchor with exactly one rect`);
    if (!body.imagePng) throw bad(`a ${kind} capture needs imagePng`);
    const check = inspectPng(body.imagePng);
    if (!check.ok) throw bad(`invalid capture PNG (${check.reason})`);
    return body.anchor;
  };
  switch (kind) {
    case 'explain':
      forbid('imagePng', 'equationId', 'deep');
      return { task, selection: textSelection(), ...(question ? { question } : {}) };
    case 'chat': {
      forbid('imagePng', 'equationId');
      if (!question) throw bad('chat needs a question');
      if (body.anchor !== undefined && body.anchor.kind !== 'text') throw bad('a chat thread takes a text selection only');
      const selection = body.anchor?.quote?.exact ?? body.text;
      return { task, question, ...(selection ? { selection } : {}) };
    }
    case 'translate':
      forbid('question', 'imagePng', 'equationId', 'deep');
      return { task, selection: textSelection() };
    case 'figure':
      forbid('equationId', 'deep', 'text');
      return { task, area: areaOf(), imagePng: body.imagePng!, ...(question ? { question } : {}) };
    case 'equation': {
      forbid('deep', 'text');
      if (has.equationId === (has.imagePng || has.anchor)) throw bad('an equation thread needs equationId or an area capture (exactly one of them)');
      if (has.equationId) return { task, equationId: body.equationId!, ...(question ? { question } : {}) };
      return { task, area: areaOf(), imagePng: body.imagePng!, ...(question ? { question } : {}) };
    }
  }
}

/** Page text around a located quote (translate paragraphs, explain context). */
function around(tx: Tx, paperId: string, anchor: Anchor | null, page: number | undefined, chars: number): { before?: string; after?: string } {
  const quote = anchor?.quote;
  if (!quote) return {};
  const pages = tx.select({ page: pageTexts.page, text: pageTexts.text }).from(pageTexts).where(eq(pageTexts.paperId, paperId)).orderBy(asc(pageTexts.page)).all();
  const m = matchQuote(pages, quote, page !== undefined ? { pageHint: page } : {});
  if (!m.position) return {};
  const text = pages.find((p) => p.page === m.position!.page)?.text ?? '';
  return { before: text.slice(Math.max(0, m.position.start - chars), m.position.start), after: text.slice(m.position.end, m.position.end + chars) };
}

/** translate: the paper's glossary (≤ 30 terms; taskSerialize caps the characters). */
function glossaryKnown(tx: Tx, paperId: string): string | undefined {
  const rows = tx.select({ term: glossaryTerms.term, definition: glossaryTerms.definitionKo }).from(glossaryTerms).where(eq(glossaryTerms.paperId, paperId)).orderBy(asc(glossaryTerms.createdAt)).limit(FIELD_LIMITS.glossaryTerms).all();
  return rows.length ? JSON.stringify(rows) : undefined;
}

/** figure: captions anchored to the area's page (≤ 3). */
function nearbyCaptions(tx: Tx, paperId: string, page: number): string | undefined {
  const rows = tx.select({ caption: figures.caption }).from(figures).where(and(eq(figures.paperId, paperId), eq(figures.pdfPage, page))).limit(FIELD_LIMITS.captions).all();
  return rows.length ? JSON.stringify(rows.map((r) => r.caption)) : undefined;
}

/** equation_deep inputs of an indexed equation: the LaTeX block and its neighbours (text + previous / next numbers). */
function equationInputs(tx: Tx, equationId: string): { equation: string; neighbors: string } | null {
  const e = tx.select().from(equations).where(eq(equations.id, equationId)).get();
  if (!e || e.number === null) return null;
  const numbered = tx.select({ number: equations.number, ordinal: equations.ordinal }).from(equations).where(and(eq(equations.paperId, e.paperId), isNotNull(equations.number))).orderBy(asc(equations.ordinal)).all();
  const i = numbered.findIndex((x) => x.ordinal === e.ordinal && x.number === e.number);
  return {
    equation: JSON.stringify({ n: e.number, htmlId: e.htmlId, latex: e.latex }),
    neighbors: JSON.stringify({ before: e.contextBefore, after: e.contextAfter, prev: i > 0 ? numbered[i - 1]!.number : null, next: i >= 0 && i + 1 < numbered.length ? numbered[i + 1]!.number : null }),
  };
}

/** The stored capture of a thread as base64 (follow-ups and regenerates re-attach it); undefined when there is none. */
function storedCapture(deps: AppDeps, fileId: string | null): string | undefined {
  if (!fileId) return undefined;
  const f = deps.db.select({ relPath: files.relPath, kind: files.kind }).from(files).where(eq(files.id, fileId)).get();
  if (!f || f.kind !== 'capture') return undefined;
  const path = join(deps.paths.root, f.relPath);
  return existsSync(path) ? readFileSync(path).toString('base64') : undefined;
}

/** Starts a run whose start may also commit a capture: the capture is discarded on every path where it did not. */
export function startWithCapture(deps: Pick<AppDeps, 'runTask'>, input: RunTaskRequest, capture: StoredCapture | null): RunHandle {
  let handle: RunHandle;
  try {
    handle = deps.runTask(input);
  } catch (e) {
    capture?.discard();
    throw e;
  }
  if (handle.attached) capture?.discard(); // a concurrent resend won the start: this capture was never committed
  return handle;
}

/**
 * The thread of threads.get / threads.delete — only while its paper exists and is not tombstoned (PLAN_M2 3.4
 * "tombstone = no result", 9절 56; review B-I10-03): during a deferred deletion its messages are as gone as the
 * list routes and the run resends already say, so 404 `thread` (the deletion removes the row).
 */
function liveThread(deps: AppDeps, id: string): typeof threads.$inferSelect {
  const t = deps.db.select().from(threads).where(eq(threads.id, id)).get();
  if (!t) throw notFound('thread');
  const paper = deps.db.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, t.paperId)).get();
  if (!paper || paper.deletingAt !== null) throw notFound('thread');
  return t;
}

/** The title (and user message) of a first turn without a question and without a selection: the kind's fixed label. */
function fixedTitle(kind: ThreadKind, eqNumber: string | null): string {
  return oneLine(eqNumber !== null ? `식 (${eqNumber})` : kind === 'figure' ? '그림·표 설명' : kind === 'equation' ? '수식 깊이 읽기' : kind, 80) || kind;
}

/**
 * The first turn of this thread was made without a question: threads.create stored `question ?? selection ?? title`
 * as its user message, so a question-less one is the selection (same quoteHash) or the fixed label. Compared with
 * the label, not with the stored title — a short question is its own title.
 */
function questionlessFirstTurn(db: Tx | AppDeps['db'], thread: typeof threads.$inferSelect, userText: string): boolean {
  const first = FIRST_TASK[thread.kind as ThreadKind];
  if (first === 'chat' || first === 'translate_selection') return false; // chat: always a question; translate: none, no history
  if (thread.quoteHash !== null && quoteHash(userText) === thread.quoteHash) return true;
  const eqNumber = thread.equationId ? (db.select({ number: equations.number }).from(equations).where(eq(equations.id, thread.equationId)).get()?.number ?? null) : null;
  return userText === fixedTitle(thread.kind as ThreadKind, eqNumber);
}

export const threadsRoutes: RouteModule = (deps) => ({
  'threads.list': (c) => {
    const { id: paperId } = routeParams(c, 'threads.list');
    const paper = deps.db.select({ id: papers.id, deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, paperId)).get();
    if (!paper || paper.deletingAt !== null) throw notFound('paper');
    const rows = deps.db.select().from(threads).where(eq(threads.paperId, paperId)).orderBy(desc(threads.updatedAt), desc(threads.createdAt)).all();
    const out = rows.map((t) => {
      const last = deps.db
        .select({ statsJson: messages.statsJson })
        .from(messages)
        .where(and(eq(messages.threadId, t.id), eq(messages.role, 'assistant'), eq(messages.status, 'complete')))
        .orderBy(desc(messages.createdAt), desc(sql`rowid`))
        .get();
      const lastMessage = deps.db
        .select({ status: messages.status })
        .from(messages)
        .where(eq(messages.threadId, t.id))
        .orderBy(desc(messages.createdAt), desc(sql`rowid`))
        .get();
      return { ...toThreadDto(t), lastStats: parseJson(last?.statsJson ?? null, (v) => MessageStatsSchema.parse(v), null), lastMessageStatus: lastMessage?.status ?? null };
    });
    return routeJson(c, 'threads.list', { threads: out });
  },

  'threads.get': (c) => {
    const { id } = routeParams(c, 'threads.get');
    const t = liveThread(deps, id);
    return routeJson(c, 'threads.get', { thread: toThreadDto(t), messages: threadMessages(deps.db, id).map((m) => toMessageDto(deps, m)) });
  },

  'threads.delete': (c) => {
    const { id } = routeParams(c, 'threads.delete');
    liveThread(deps, id);
    // Stop the thread's runs (no more tokens); they find their owner gone and write nothing (rule 4).
    const live = deps.db.select({ runId: llmCalls.runId }).from(llmCalls).where(and(eq(llmCalls.threadId, id), inArray(llmCalls.status, ['queued', 'running']))).all();
    for (const r of live) deps.runs.cancel(r.runId);
    deps.db.delete(threads).where(eq(threads.id, id)).run(); // messages cascade, citations by trigger
    return c.body(null, 204);
  },

  'threads.create': async (c) => {
    const { id: paperId } = routeParams(c, 'threads.create');
    const body = await routeBody(c, 'threads.create');
    const question = body.question?.trim() ? body.question : undefined;
    const identity = createIdentity(paperId, body, question);
    // ① request id first (rule 1a): a known id ends here — no lookup, no capture, no row
    const m1Task = TASK_BY_KIND[body.kind];
    const m1Selection = body.anchor?.quote?.exact ?? body.text;
    const m1Page = anchorPage(body.anchor ?? null);
    const existing = deps.runs.findExisting({
      clientRequestId: body.clientRequestId,
      paperId,
      identity,
      ...(body.imagePng !== undefined ? { imagePngBase64: body.imagePng } : {}),
      // M1 rows: the v1 hash of what the M1 handler put in `inputs` (explain / chat only)
      ...(m1Task ? { legacy: { task: m1Task, inputs: { selection: m1Selection, page: m1Page !== undefined ? String(m1Page) : undefined, question } } } : {}),
    });
    if (existing) return streamRun(c, existing, taskOfRun(deps, existing.runId, FIRST_TASK[body.kind]));
    // ② owner, readiness, kind table, equation lookup
    if (body.kind === 'translate') requirePaperReadable(deps, paperId);
    else requirePaperReady(deps, paperId);
    const checked = checkKind(body);
    const task = checked.task;
    let eqInputs: { equation: string; neighbors: string } | null = null;
    let eqNumber: string | null = null;
    if (checked.equationId) {
      const e = deps.db.select({ paperId: equations.paperId, number: equations.number }).from(equations).where(eq(equations.id, checked.equationId)).get();
      if (!e || e.paperId !== paperId) throw notFound('equation');
      if (e.number === null) throw bad('only numbered equations can be read in depth');
      eqNumber = e.number;
    }
    const anchor: Anchor | null = checked.area ?? body.anchor ?? (checked.selection ? { kind: 'text', quote: { exact: checked.selection }, rects: [] } : null);
    const page = anchorPage(anchor);
    // ③ a new run: only now the capture file is written
    const capture = checked.imagePng ? storeCapture({ paths: deps.paths, sqlite: deps.sqlite }, paperId, checked.imagePng) : null;
    const title = question !== undefined || checked.selection !== undefined ? oneLine(question ?? checked.selection!, 80) || body.kind : fixedTitle(body.kind, eqNumber);
    const userText = question ?? checked.selection ?? title;

    const input: RunTaskRequest = {
      task,
      clientRequestId: body.clientRequestId,
      paperId,
      inputs: {
        ...(checked.selection !== undefined && task !== 'translate_selection' ? { selection: checked.selection, page: page !== undefined ? String(page) : undefined } : {}),
        ...(task === 'translate_selection' ? { selection: checked.selection } : {}),
        ...(checked.area ? { area_page: String(checked.area.rects[0]!.page) } : {}),
        question,
      },
      identity,
      ...(body.imagePng !== undefined ? { imagePngBase64: body.imagePng } : {}),
      ...(body.deep === true ? { deep: true } : {}),
      startRows: {
        insert: (tx) => {
          const now = Date.now();
          const threadId = randomUUID();
          const userId = randomUUID();
          const assistantId = randomUUID();
          capture?.insertRow(tx); // ④ the files row with the run's rows (limits + paper re-check inside)
          if (checked.equationId) {
            eqInputs = equationInputs(tx, checked.equationId);
            if (!eqInputs) throw notFound('equation');
          }
          tx.insert(threads)
            .values({ id: threadId, paperId, kind: body.kind, title, anchorJson: anchor ? JSON.stringify(anchor) : null, quoteHash: checked.selection ? quoteHash(checked.selection) : null, equationId: checked.equationId ?? null, imageFileId: capture?.fileId ?? null, createdAt: now, updatedAt: now })
            .run();
          tx.insert(messages).values({ id: userId, threadId, role: 'user', contentMd: userText, status: 'complete', clientRequestId: body.clientRequestId, createdAt: now }).run();
          tx.insert(messages).values({ id: assistantId, threadId, role: 'assistant', contentMd: '', status: 'streaming', createdAt: now + 1 }).run();
          return { threadId, messageId: assistantId, extraInputs: firstTurnExtras(tx, task, paperId, anchor, page, checked.area, eqInputs), ...(page !== undefined ? { pageHint: page } : {}) };
        },
      },
    };
    return streamRun(c, startWithCapture(deps, input, capture), task);
  },

  'messages.create': async (c) => {
    const { id: threadId } = routeParams(c, 'messages.create');
    const body = await routeBody(c, 'messages.create');
    // ① request id first (rule 1a): also for a deleted thread (its run replays result_deleted)
    const existing = deps.runs.findExisting({ clientRequestId: body.clientRequestId, threadId, identity: messageIdentity(threadId, body), legacy: { inputs: { question: body.text, regenerate: body.regenerate ? '1' : undefined } } });
    if (existing) return streamRun(c, existing, taskOfRun(deps, existing.runId, 'chat'));
    if (body.regenerate === true && body.deep === true) throw bad('regenerate keeps the effort of the original turn: deep is not allowed with regenerate');
    const thread = deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
    if (!thread) throw notFound('thread');
    if (thread.kind === 'translate') requirePaperReadable(deps, thread.paperId);
    else requirePaperReady(deps, thread.paperId);
    if (thread.kind === 'translate' && body.regenerate !== true) throw bad('a translation takes no follow-up question (only regenerate)');
    const anchor = parseAnchor(thread.anchorJson);
    const selection = anchor?.quote?.exact;
    const page = anchorPage(anchor);
    // Regenerating the first turn re-runs the thread's first task; everything else is a chat turn.
    // (Decided from the current rows; not part of the payload identity, so a retry attaches whatever the rows.)
    const current = threadMessages(deps.db, threadId);
    const lastAssistant = current.map((m) => m.role).lastIndexOf('assistant');
    const turnStart = lastAssistant > 0 && current[lastAssistant - 1]!.role === 'user' ? lastAssistant - 1 : lastAssistant;
    const task: TaskId = thread.kind === 'translate' ? 'translate_selection' : body.regenerate && turnStart === 0 ? FIRST_TASK[thread.kind] : 'chat';
    if (body.deep === true && !supportsDeep(task)) throw bad(`deep is not available for this turn (${task})`);
    // regenerate inherits the original turn's effort: deep when that run ran at the task's deepEffort
    let deep = body.deep === true;
    if (body.regenerate === true && lastAssistant >= 0) {
      const runId = current[lastAssistant]!.llmCallId;
      const effort = runId ? deps.db.select({ effort: llmCalls.effort }).from(llmCalls).where(eq(llmCalls.runId, runId)).get()?.effort : undefined;
      deep = TASK_SPECS[task].deepEffort !== undefined && effort === TASK_SPECS[task].deepEffort;
    }
    const stored = storedCapture(deps, thread.imageFileId);
    // A first-turn regenerate re-runs the first request as it was: a thread made without a question stored the
    // selection (paper text) or the kind's fixed label as its user message — not a question (review B-I10-02).
    const noQuestion = task !== 'chat' && task !== 'translate_selection' && body.regenerate === true && turnStart === 0 && current[0]?.role === 'user' && questionlessFirstTurn(deps.db, thread, current[0].contentMd);

    const input: RunTaskRequest = {
      task,
      clientRequestId: body.clientRequestId,
      paperId: thread.paperId,
      threadId,
      inputs: { question: task === 'translate_selection' || noQuestion ? undefined : body.text, regenerate: body.regenerate ? '1' : undefined },
      identity: messageIdentity(threadId, body),
      ...(stored !== undefined ? { storedImagePngBase64: stored } : {}),
      ...(deep ? { deep: true } : {}),
      startRows: {
        insert: (tx) => {
          let msgs = threadMessages(tx, threadId);
          if (msgs.some((m) => m.status === 'streaming')) throw new HttpError(409, 'conflict', 'a reply in this thread is still being generated');
          // The first user message of a thread made without a question is the selection (sent as <selection
          // trust="paper">) or the kind's fixed label: not the user's words, so not a user turn (review B-F3R1-02).
          const notATurn = msgs[0]?.role === 'user' && questionlessFirstTurn(tx, thread, msgs[0].contentMd) ? msgs[0].id : null;
          // Regenerate: the last turn is NOT deleted here; the run deletes it when it stores the new answer and
          // keeps it on any other end (replace-on-success). The new turn is left out of the history.
          let replaces: string[] = [];
          // A question-less first-turn regenerate keeps the replaced first user message (selection or fixed label)
          // as the new one, whatever body.text says: otherwise a different text (the web's title fallback, '다시 생성',
          // a direct call) would make the thread look asked, and later turns would send it as user words (B-F3R2-01).
          // body.text stays the payload identity (messageIdentity), so a resend compares as before.
          let userText = body.text;
          if (body.regenerate) {
            const i = msgs.map((m) => m.role).lastIndexOf('assistant');
            if (i < 0) throw new HttpError(409, 'conflict', 'nothing to regenerate in this thread');
            replaces = [msgs[i]!.id, ...(i > 0 && msgs[i - 1]!.role === 'user' ? [msgs[i - 1]!.id] : [])];
            if (noQuestion && notATurn !== null && replaces.includes(notATurn)) userText = msgs[0]!.contentMd;
            msgs = msgs.filter((m) => !replaces.includes(m.id));
          }
          const turns: HistoryTurn[] = msgs.filter((m) => m.id !== notATurn && m.status === 'complete' && m.contentMd.trim() !== '').map((m) => ({ role: m.role, text: m.contentMd }));
          const now = Date.now();
          const userId = randomUUID();
          const assistantId = randomUUID();
          // a regenerate's new turn is pending until its run commits (startup recovery deletes a pending turn)
          const pending = body.regenerate ? 1 : 0;
          tx.insert(messages).values({ id: userId, threadId, role: 'user', contentMd: userText, status: 'complete', clientRequestId: body.clientRequestId, createdAt: now, pendingReplace: pending }).run();
          tx.insert(messages).values({ id: assistantId, threadId, role: 'assistant', contentMd: '', status: 'streaming', createdAt: now + 1, pendingReplace: pending }).run();
          tx.update(threads).set({ updatedAt: now }).where(eq(threads.id, threadId)).run();
          const history = fitHistory(turns);
          const area = anchor?.kind === 'area' ? anchor : undefined;
          const eqIn = task === 'equation_deep' && thread.equationId ? equationInputs(tx, thread.equationId) : null;
          const extras =
            task === 'chat'
              ? { selection, page: page !== undefined ? String(page) : undefined, section: sectionOf(tx, thread.paperId, page), ...(area ? { area_page: String(area.rects[0]!.page) } : {}) }
              : { ...(task === 'explain_selection' ? { selection, page: page !== undefined ? String(page) : undefined } : {}), ...(task === 'translate_selection' ? { selection } : {}), ...(area ? { area_page: String(area.rects[0]!.page) } : {}), ...firstTurnExtras(tx, task, thread.paperId, anchor, page, area, eqIn) };
          return {
            threadId,
            messageId: assistantId,
            extraInputs: { ...extras, ...(history.length && task !== 'translate_selection' ? { history: JSON.stringify(history) } : {}) },
            ...(page !== undefined ? { pageHint: page } : {}),
            ...(body.regenerate ? { replaces, discardOnFailure: [userId, assistantId] } : {}),
          };
        },
      },
    };
    return streamRun(c, deps.runTask(input), task);
  },
});

/** Inputs a first turn derives inside the start transaction (section, context, paragraphs, captions, equation). */
function firstTurnExtras(tx: Tx, task: TaskId, paperId: string, anchor: Anchor | null, page: number | undefined, area: Anchor | undefined, eqIn: { equation: string; neighbors: string } | null): Record<string, string | undefined> {
  if (task === 'explain_selection') {
    const a = around(tx, paperId, anchor, page, FIELD_LIMITS.context);
    return { section: sectionOf(tx, paperId, page), context_before: a.before, context_after: a.after };
  }
  if (task === 'chat') return { section: sectionOf(tx, paperId, page) };
  if (task === 'translate_selection') {
    const a = around(tx, paperId, anchor, page, FIELD_LIMITS.paragraph);
    return { paragraph_before: a.before, paragraph_after: a.after, glossary_known: glossaryKnown(tx, paperId) };
  }
  if (task === 'figure_area') return { section: sectionOf(tx, paperId, page), ...(area ? { nearby_captions: nearbyCaptions(tx, paperId, area.rects[0]!.page) } : {}) };
  if (task === 'equation_deep') return eqIn ? { equation: eqIn.equation, neighbors: eqIn.neighbors } : {};
  return {};
}

/**
 * Payload identity of threads.create: every body field that changes the meaning or the storage of the request
 * (kind, the full anchor incl. position / prefix / suffix / rects, text, question, image, equation), normalised
 * the way the route reads them. clientRequestId itself is the key, not part of the payload.
 */
export function createIdentity(paperId: string, body: CreateThreadBody, question: string | undefined): Record<string, unknown> {
  return {
    route: 'threads.create',
    paperId,
    kind: body.kind,
    anchor: body.anchor ?? null,
    text: body.text ?? null,
    question: question ?? null,
    imagePng: body.imagePng ? createHash('sha256').update(body.imagePng).digest('hex') : null,
    equationId: body.equationId ?? null,
    // deep is a key ONLY when true (runContract.ts header, PLAN_M2 D31): absent/false keep the M1 hash byte-identical.
    ...(body.deep === true ? { deep: true } : {}),
  };
}

/**
 * Payload identity of messages.create (the one function — findExisting's probe and runTask use the same value).
 * deep is a key only when true (D31), so requests without deep keep the M1 hash.
 */
export function messageIdentity(threadId: string, body: Omit<PostMessageRequest, 'clientRequestId'>): Record<string, unknown> {
  return { route: 'messages.create', threadId, text: body.text, regenerate: body.regenerate === true, ...(body.deep === true ? { deep: true } : {}) };
}
