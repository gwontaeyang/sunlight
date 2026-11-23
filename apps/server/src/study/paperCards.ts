// Paper cards (PLAN 7.3, PLAN_M2 3.4): notation / assumptions (SP-Blocks) and summary (SP-Markup, one item). Owner B.
//
// - A card row is created `generating` in the run's start transaction (startCardRows) — at most one per (paper, kind)
//   (partial unique index paper_cards_generating_uq). A NEW request id while that card's run is queued|running is a
//   409 conflict with details {reason:'card_generating', runId, cardId} (D22) — decided by a lookup inside the start
//   transaction, and a unique-index violation there is turned into the same 409 (never a 500 or "clientRequestId was
//   already used"). A generating row whose run is already terminal becomes `interrupted` and a new card starts.
//   Failed rows (parse_failed, error, interrupted) of that kind are deleted when the next generation starts.
// - Results are written only by the run's terminal transaction (commitCard / failCard, called by runManager's card
//   sink): replace-on-success — the previous cards of the kind are deleted only when the new one commits, their runs
//   get errorCode 'superseded', and notation items take over the previous item's userNote by key (confirmed starts
//   false). A parse_failed card stores no item and no citation — only rawOutput and errorCode.
// - Item titles come only from the server tables (validateBlocks), labels / attrs only from whitelisted enums.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { CardItemDto, PaperCardDto } from '@study-paper/shared/contracts/api';
import type { BlockError } from '@study-paper/shared/contracts/blocks';
import type { Citation, GroundingLabel, PaperCardKind, ParsedAnswer, ParsedBlocks } from '@study-paper/shared/contracts/domain';
import { LlmErrorCode, type TaskId } from '@study-paper/shared/contracts/tasks';
import { MAX_ANSWER_WORK, WorkBudget } from '@study-paper/shared/anchor/matchQuote';
import { validateBlocks, type ValidatedItem } from '@study-paper/shared/markup/blockSchemas';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { ISSUE_INPUT_TOO_LONG, parseBlocks, SP_BLOCKS_INPUT_MAX_CHARS } from '@study-paper/shared/markup/parseBlocks';
import type { Db } from '../db/client';
import { llmCalls, paperCardItems, paperCards, papers } from '../db/schema';
import { HttpError } from '../deps';
import { resolveCitations, type EquationIndexRow, type GroundingPages } from '../llm/citations';
import { headingIssues } from '../llm/headings';
import { readCitations, writeCitations } from '../llm/citationStore';
import type { RunStartRows, RunTx } from '../llm/runContract';

export const CARD_TASK: Record<PaperCardKind, TaskId> = { notation: 'notation_card', assumptions: 'assumptions_card', summary: 'summary' };
export const CARD_KIND_OF_TASK: Partial<Record<TaskId, PaperCardKind>> = { notation_card: 'notation', assumptions_card: 'assumptions', summary: 'summary' };
export const isCardTask = (task: TaskId): boolean => CARD_KIND_OF_TASK[task] !== undefined;

/** Payload identity of cards.generate (one pure function: findExisting's probe and runTask use the same value). */
export function cardIdentity(paperId: string, kind: PaperCardKind): Record<string, unknown> {
  return { route: 'cards.generate', paperId, kind };
}

// ---------------------------------------------------------------------------------------------------------------
// Start (inside the run's start transaction)

export interface CardStartHooks {
  /** Tests: runs after the generating-row check, right before the INSERT (e.g. to inject a unique-index conflict). */
  beforeInsert?(tx: RunTx): void;
}

const LIVE = new Set(['queued', 'running']);

function cardGenerating(tx: RunTx, paperId: string, kind: PaperCardKind): { id: string; llmCallId: string | null } | undefined {
  return tx.select({ id: paperCards.id, llmCallId: paperCards.llmCallId }).from(paperCards).where(and(eq(paperCards.paperId, paperId), eq(paperCards.kind, kind), eq(paperCards.status, 'generating'))).get();
}

/** The 409 of a card being generated (D22), or null when the generating row's run is not live. */
function generatingConflict(tx: RunTx, row: { id: string; llmCallId: string | null }): HttpError | null {
  const status = row.llmCallId ? tx.select({ status: llmCalls.status }).from(llmCalls).where(eq(llmCalls.runId, row.llmCallId)).get()?.status : undefined;
  if (row.llmCallId && status !== undefined && LIVE.has(status)) {
    return new HttpError(409, 'conflict', 'a card of this kind is being generated', { reason: 'card_generating', runId: row.llmCallId, cardId: row.id });
  }
  return null;
}

function isUniqueViolation(e: unknown): boolean {
  for (let x = e as { code?: string; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) {
    if (x.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}

/** startRows of cards.generate: the `generating` card row (→ run.accepted.artifactId). */
export function startCardRows(paperId: string, kind: PaperCardKind, promptVersion: string, hooks: CardStartHooks = {}): RunStartRows {
  return {
    insert: (tx) => {
      const current = cardGenerating(tx, paperId, kind);
      if (current) {
        const conflict = generatingConflict(tx, current);
        if (conflict) throw conflict;
        tx.update(paperCards).set({ status: 'interrupted', errorCode: null }).where(eq(paperCards.id, current.id)).run();
      }
      // failed attempts of this kind go now (the last complete card stays until a new one commits)
      tx.delete(paperCards)
        .where(and(eq(paperCards.paperId, paperId), eq(paperCards.kind, kind), inArray(paperCards.status, ['parse_failed', 'error', 'interrupted'])))
        .run();
      hooks.beforeInsert?.(tx);
      const cardId = randomUUID();
      try {
        // llmCallId is linked by the run owner right after its llm_calls row exists (same transaction; FK)
        tx.insert(paperCards).values({ id: cardId, paperId, kind, status: 'generating', rawOutput: null, llmCallId: null, promptVersion, createdAt: Date.now() }).run();
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        const other = cardGenerating(tx, paperId, kind);
        const conflict = other ? generatingConflict(tx, other) : null;
        throw conflict ?? new HttpError(409, 'conflict', 'a card of this kind is being generated', other?.llmCallId ? { reason: 'card_generating', runId: other.llmCallId, cardId: other.id } : undefined);
      }
      return { artifactId: cardId };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Output → items (outside the transaction)

export interface PreparedCardItem {
  ordinal: number;
  key: string | null;
  category: string | null;
  label: GroundingLabel | null;
  title: string | null;
  bodyMd: string;
  attrs: Record<string, string>;
  citations: Citation[];
}

export type PreparedCard =
  | { ok: true; items: PreparedCardItem[]; parsed: ParsedBlocks | ParsedAnswer }
  | { ok: false; errors: BlockError[]; repairable: boolean; parsed: ParsedBlocks };

/**
 * A summary output (SP-Markup) parsed for storage and replay: over SP_BLOCKS_INPUT_MAX_CHARS it is not parsed at all
 * (null — the run ends parse_failed with no repair, like SP-Blocks; review B-R1-02), otherwise parseAnswer plus one
 * fixed issue per missing heading (PLAN_M2 3.4: stored as it is, issue only).
 */
function parseSummary(text: string): ParsedAnswer | null {
  if (text.length > SP_BLOCKS_INPUT_MAX_CHARS) return null;
  const parsed = parseAnswer(text, { final: true });
  return { ...parsed, issues: [...parsed.issues, ...headingIssues('summary', text)] };
}

/**
 * Parses, validates and matches a card output. Every item shares ONE WorkBudget (PLAN_M2 3.4 rule 4: one card = one
 * MAX_ANSWER_WORK). An invalid SP-Blocks output → {ok:false} (repairable unless the input was too long to parse).
 */
export function prepareCard(task: TaskId, text: string, pages: GroundingPages, index: readonly EquationIndexRow[]): PreparedCard {
  const budget = new WorkBudget(MAX_ANSWER_WORK);
  if (task === 'summary') {
    const parsed = parseSummary(text);
    if (!parsed) return { ok: false, errors: [{ code: 'body_too_long' }], repairable: false, parsed: { items: [], outsideText: '', issues: [ISSUE_INPUT_TOO_LONG] } };
    const citations = resolveCitations(parsed, pages, index, { budget });
    return { ok: true, parsed, items: [{ ordinal: 1, key: 'summary', category: null, label: null, title: null, bodyMd: text, attrs: {}, citations }] };
  }
  if (task !== 'notation_card' && task !== 'assumptions_card') throw new Error(`not a card task: ${task}`);
  const parsed = parseBlocks(text, task);
  const v = validateBlocks(task, parsed);
  if (!v.ok) return { ok: false, errors: v.errors, repairable: !parsed.issues.includes(ISSUE_INPUT_TOO_LONG), parsed };
  return { ok: true, parsed, items: v.items.map((it: ValidatedItem) => ({ ...it, citations: resolveCitations(parseAnswer(it.bodyMd, { labels: 'strip' }), pages, index, { budget }) })) };
}

/** Re-parses a stored card output (replay of a finished run) — the same parse as the run's (no matching). */
export function reparseCard(task: TaskId, text: string): ParsedBlocks | ParsedAnswer | null {
  if (task === 'summary') return parseSummary(text);
  if (task !== 'notation_card' && task !== 'assumptions_card') return null;
  const parsed = parseBlocks(text, task);
  return validateBlocks(task, parsed).ok ? parsed : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Terminal writes (inside the run's terminal transaction)

/** The card row may still receive its result: it exists, is generating, and its paper is not being deleted. */
export function cardAlive(tx: RunTx | Db, cardId: string): boolean {
  const r = tx
    .select({ status: paperCards.status, deletingAt: papers.deletingAt })
    .from(paperCards)
    .innerJoin(papers, eq(papers.id, paperCards.paperId))
    .where(eq(paperCards.id, cardId))
    .get();
  return r !== undefined && r.status === 'generating' && r.deletingAt === null;
}

/**
 * Stores a successful card (replace-on-success). Returns the runIds of the replaced cards (marked superseded), or
 * null when the card can no longer take its result (deleted, paper being deleted) — nothing is written then.
 */
export function commitCard(tx: RunTx, cardId: string, text: string, items: readonly PreparedCardItem[]): string[] | null {
  if (!cardAlive(tx, cardId)) return null;
  const card = tx.select({ paperId: paperCards.paperId, kind: paperCards.kind }).from(paperCards).where(eq(paperCards.id, cardId)).get()!;
  const previous = tx
    .select({ id: paperCards.id, status: paperCards.status, llmCallId: paperCards.llmCallId })
    .from(paperCards)
    .where(and(eq(paperCards.paperId, card.paperId), eq(paperCards.kind, card.kind), ne(paperCards.id, cardId)))
    .orderBy(desc(paperCards.createdAt))
    .all();
  // userNote carries over by key from the latest complete card (notation; other kinds have no stable key)
  const notes = new Map<string, string>();
  const prevComplete = previous.find((p) => p.status === 'complete');
  if (prevComplete && card.kind === 'notation') {
    for (const it of tx.select({ key: paperCardItems.key, userNote: paperCardItems.userNote }).from(paperCardItems).where(eq(paperCardItems.cardId, prevComplete.id)).all()) {
      if (it.key !== null && it.userNote !== null) notes.set(it.key, it.userNote);
    }
  }
  tx.update(paperCards).set({ status: 'complete', rawOutput: text, errorCode: null }).where(eq(paperCards.id, cardId)).run();
  for (const it of items) {
    const id = randomUUID();
    tx.insert(paperCardItems)
      .values({ id, cardId, ordinal: it.ordinal, key: it.key, category: it.category, label: it.label, title: it.title, bodyMd: it.bodyMd, attrsJson: JSON.stringify(it.attrs), confirmed: false, userNote: it.key !== null ? (notes.get(it.key) ?? null) : null })
      .run();
    writeCitations(tx, 'paper_card_item', id, it.citations);
  }
  const superseded: string[] = [];
  for (const p of previous) {
    if (p.llmCallId) {
      const old = tx.select({ status: llmCalls.status, errorDetail: llmCalls.errorDetail }).from(llmCalls).where(eq(llmCalls.runId, p.llmCallId)).get();
      if (old?.status === 'ok') {
        tx.update(llmCalls)
          .set({ errorCode: 'superseded', errorDetail: `${old.errorDetail ? `${old.errorDetail}\n` : ''}superseded by card ${cardId}`.slice(0, 2048) })
          .where(eq(llmCalls.runId, p.llmCallId))
          .run();
        superseded.push(p.llmCallId);
      }
    }
  }
  if (previous.length) tx.delete(paperCards).where(inArray(paperCards.id, previous.map((p) => p.id))).run(); // items cascade, citations by trigger
  return superseded;
}

/** Records a failed card (no items): parse_failed keeps the last output in rawOutput; the code goes to errorCode. */
export function failCard(tx: RunTx, cardId: string, code: LlmErrorCode, lastOutput: string): void {
  const row = tx.select({ status: paperCards.status }).from(paperCards).where(eq(paperCards.id, cardId)).get();
  if (!row || row.status !== 'generating') return;
  tx.update(paperCards)
    .set({ status: code === 'parse_failed' ? 'parse_failed' : 'error', errorCode: code, rawOutput: code === 'parse_failed' ? lastOutput : null })
    .where(eq(paperCards.id, cardId))
    .run();
}

// ---------------------------------------------------------------------------------------------------------------
// Reads

type CardRow = typeof paperCards.$inferSelect;
type ItemRow = typeof paperCardItems.$inferSelect;

const parseAttrs = (s: string): Record<string, string> => {
  try {
    const v = JSON.parse(s) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
  } catch {
    /* unreadable → no attrs */
  }
  return {};
};

export function toCardItemDto(db: Db | RunTx, it: ItemRow): CardItemDto {
  const label = it.label === 'P' || it.label === 'N' || it.label === 'G' ? it.label : null;
  return { id: it.id, ordinal: it.ordinal, key: it.key, category: it.category, label, title: it.title, bodyMd: it.bodyMd, attrs: parseAttrs(it.attrsJson), confirmed: it.confirmed, userNote: it.userNote, citations: readCitations(db, 'paper_card_item', it.id) };
}

function toCardDto(db: Db, c: CardRow): PaperCardDto {
  const items = db.select().from(paperCardItems).where(eq(paperCardItems.cardId, c.id)).orderBy(asc(paperCardItems.ordinal)).all();
  const code = LlmErrorCode.safeParse(c.errorCode);
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    rawOutput: c.status === 'parse_failed' ? c.rawOutput : null,
    errorCode: code.success ? code.data : null,
    runId: c.llmCallId,
    items: c.status === 'complete' ? items.map((it) => toCardItemDto(db, it)) : [],
    createdAt: c.createdAt,
  };
}

/** cards.list: per kind the latest complete card + the newest card that is newer than it and not complete. */
export function listCards(db: Db, paperId: string): PaperCardDto[] {
  const rows = db.select().from(paperCards).where(eq(paperCards.paperId, paperId)).orderBy(desc(paperCards.createdAt), desc(sql`rowid`)).all();
  const out: CardRow[] = [];
  for (const kind of ['notation', 'assumptions', 'summary'] as const) {
    const ofKind = rows.filter((r) => r.kind === kind); // newest first
    const ci = ofKind.findIndex((r) => r.status === 'complete');
    const newer = ofKind.slice(0, ci < 0 ? ofKind.length : ci).find((r) => r.status !== 'complete');
    if (ci >= 0) out.push(ofKind[ci]!);
    if (newer) out.push(newer);
  }
  return out.map((c) => toCardDto(db, c));
}
