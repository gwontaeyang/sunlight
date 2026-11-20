// Glossary (PLAN_M2 3.4 rule 6, D9, D29). Owner B.
//
// - glossary.define is a run (task glossary_define); its adopted output is stored as the run's result
//   (llm_calls.resultRaw) and NEVER as a term. The decision whether that stored suggestion may be used is S's
//   suggestionAvailable (resultRetention.ts) only.
// - glossary.create stores what the user accepted or typed. The server re-parses the definition (SP-Markup,
//   markup + badge) and matches its citations against the paper; a request cannot carry grounding state (D9).
// - origin (3 values) checks the TERM and the DEFINITION against a usable suggestion (Codex M-R3-3):
//   AI origin needs all of (1) llmCallId = a successful run of the same paper whose task is glossary_define,
//   explain_selection or chat; (2) its suggestion is usable — glossary_define: suggestionAvailable, explain/chat: the
//   run's answer message; (3) normalizeTerm(request term) = normalizeTerm(suggested term). Then the definition equal
//   to the suggestion's after NFC + whitespace collapsing + trim → 'llm', else 'llm_edited'. Anything else → 'manual'.
// - Term normalization (termNorm, the duplicate 409, the origin comparison) is the contracts' normalizeTerm only.
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { GlossaryTermDto } from '@study-paper/shared/contracts/api';
import type { BlockError } from '@study-paper/shared/contracts/blocks';
import { normalizeTerm, type Citation, type GlossaryOrigin, type ParsedBlocks } from '@study-paper/shared/contracts/domain';
import { MAX_ANSWER_WORK, WorkBudget, type PageTextLike } from '@study-paper/shared/anchor/matchQuote';
import { validateBlocks } from '@study-paper/shared/markup/blockSchemas';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { ISSUE_INPUT_TOO_LONG, parseBlocks } from '@study-paper/shared/markup/parseBlocks';
import type { Db } from '../db/client';
import { glossaryTerms, llmCalls, messages, pageTexts, papers, threads } from '../db/schema';
import { HttpError, notFound } from '../deps';
import { resolveCitations, type EquationIndexRow } from '../llm/citations';
import { equationIndex, readCitations, writeCitations } from '../llm/citationStore';
import type { RunTx } from '../llm/runContract';
import { suggestionAvailable } from '../resultRetention';

/** Payload identity of glossary.define (optional fields enter only when present). */
export function defineIdentity(paperId: string, body: { term: string; selection?: string }): Record<string, unknown> {
  return { route: 'glossary.define', paperId, term: body.term, ...(body.selection !== undefined ? { selection: body.selection } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// The suggestion run (runManager's suggestion sink)

export type PreparedSuggestion = { ok: true; parsed: ParsedBlocks; citations: Citation[] } | { ok: false; errors: BlockError[]; repairable: boolean; parsed: ParsedBlocks };

/** Parses + validates a glossary_define output against the requested term and matches the definition's citations. */
export function prepareSuggestion(text: string, requestedTerm: string, pages: readonly PageTextLike[], index: readonly EquationIndexRow[]): PreparedSuggestion {
  const parsed = parseBlocks(text, 'glossary_define');
  const v = validateBlocks('glossary_define', parsed, { requestedTerm });
  if (!v.ok) return { ok: false, errors: v.errors, repairable: !parsed.issues.includes(ISSUE_INPUT_TOO_LONG), parsed };
  return { ok: true, parsed, citations: resolveCitations(parseAnswer(v.items[0]!.bodyMd, { final: true }), pages, index, { budget: new WorkBudget(MAX_ANSWER_WORK) }) };
}

/**
 * The one <term> element of a stored glossary_define output, read with parseBlocks (the same grammar as the run's
 * validation — never a separate regex: review B-R1-03). null when there is not exactly one with a name.
 */
export function storedSuggestionTerm(text: string): { name: string; body: string } | null {
  const terms = parseBlocks(text, 'glossary_define').items.filter((i) => i.tag === 'term');
  const t = terms[0];
  return terms.length === 1 && t && t.attrs.name !== undefined ? { name: t.attrs.name, body: t.body } : null;
}

/** The stored suggestion re-parsed (replay, origin); null when it no longer validates for that term. */
export function reparseSuggestion(text: string, requestedTerm: string): ParsedBlocks | null {
  const parsed = parseBlocks(text, 'glossary_define');
  return validateBlocks('glossary_define', parsed, { requestedTerm }).ok ? parsed : null;
}

/**
 * Stores the adopted output on the run's row (inside the terminal transaction) — only while the paper exists and is
 * not tombstoned (the deletion's transaction already cleared resultRaw; a late run must not write it back).
 */
export function commitSuggestion(tx: RunTx, runId: string, paperId: string | null, text: string): boolean {
  if (!paperId) return false;
  const paper = tx.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, paperId)).get();
  if (!paper || paper.deletingAt !== null) return false;
  tx.update(llmCalls).set({ resultRaw: text }).where(eq(llmCalls.runId, runId)).run();
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Terms

type TermRow = typeof glossaryTerms.$inferSelect;
type Reader = Db | RunTx;

const normDef = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

export function toTermDto(db: Reader, t: TermRow): GlossaryTermDto {
  return { id: t.id, paperId: t.paperId, term: t.term, definitionKo: t.definitionKo, origin: t.origin, createdAt: t.createdAt, citations: readCitations(db, 'glossary_term', t.id) };
}

export function listTerms(db: Db, paperId: string): GlossaryTermDto[] {
  return db.select().from(glossaryTerms).where(eq(glossaryTerms.paperId, paperId)).orderBy(asc(glossaryTerms.createdAt)).all().map((t) => toTermDto(db, t));
}

/** Matches a definition (SP-Markup, markup + badge) against the paper: one work budget per definition. */
export function matchDefinition(db: Reader, paperId: string, definitionKo: string | null): Citation[] {
  if (!definitionKo) return [];
  const parsed = parseAnswer(definitionKo, { final: true });
  if (parsed.citations.length === 0) return [];
  const pages = db.select({ page: pageTexts.page, text: pageTexts.text }).from(pageTexts).where(eq(pageTexts.paperId, paperId)).orderBy(asc(pageTexts.page)).all();
  return resolveCitations(parsed, pages, equationIndex(db, paperId), { budget: new WorkBudget(MAX_ANSWER_WORK) });
}

/** AI-origin tasks (PLAN_M2 3.4 rule 6 ①). */
const AI_TASKS = new Set(['glossary_define', 'explain_selection', 'chat']);

/** The suggestion of a run for `term` ({term, definition}), or null when there is none that may be used. */
function suggestionOf(db: Reader, run: typeof llmCalls.$inferSelect, term: string, sourceMessageId: string | undefined, now: number): { term: string; definition: string } | null {
  if (run.task === 'glossary_define') {
    const paper = run.paperId ? db.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, run.paperId)).get() : undefined;
    if (!suggestionAvailable(run, paper, now)) return null;
    const t = storedSuggestionTerm(run.resultRaw!);
    return t ? { term: t.name, definition: t.body } : null;
  }
  const msg = db.select({ id: messages.id, contentMd: messages.contentMd, status: messages.status }).from(messages).where(and(eq(messages.llmCallId, run.runId), eq(messages.role, 'assistant'))).get();
  if (!msg || msg.status !== 'complete') return null;
  if (sourceMessageId !== undefined && sourceMessageId !== msg.id) return null;
  const want = normalizeTerm(term);
  const g = parseAnswer(msg.contentMd, { final: true }).glossary.find((x) => normalizeTerm(x.term) === want);
  return g ? { term: g.term, definition: g.definition } : null;
}

/** origin of a term created with these values (see the header). */
export function originOf(db: Reader, paperId: string, req: { term: string; definitionKo?: string | null; llmCallId?: string; sourceMessageId?: string }, now = Date.now()): GlossaryOrigin {
  if (!req.llmCallId) return 'manual';
  const run = db.select().from(llmCalls).where(eq(llmCalls.runId, req.llmCallId)).get();
  if (!run || run.paperId !== paperId || run.status !== 'ok' || !AI_TASKS.has(run.task)) return 'manual';
  const s = suggestionOf(db, run, req.term, req.sourceMessageId, now);
  if (!s || normalizeTerm(s.term) !== normalizeTerm(req.term)) return 'manual';
  return normDef(req.definitionKo ?? '') === normDef(s.definition) ? 'llm' : 'llm_edited';
}

const duplicate = () => new HttpError(409, 'conflict', 'this term is already in the glossary');

function isUniqueViolation(e: unknown): boolean {
  for (let x = e as { code?: string; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) {
    if (x.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}

/** glossary.create: the server matches the definition; origin from the run (never from the request). */
export function createTerm(db: Db, paperId: string, body: { term: string; definitionKo?: string; llmCallId?: string; sourceMessageId?: string }): GlossaryTermDto {
  const termNorm = normalizeTerm(body.term);
  if (!termNorm) throw new HttpError(400, 'validation', 'term is empty');
  const origin = originOf(db, paperId, body);
  const citations = matchDefinition(db, paperId, body.definitionKo ?? null);
  const id = randomUUID();
  try {
    db.transaction((tx) => {
      const paper = tx.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, paperId)).get();
      if (!paper || paper.deletingAt !== null) throw notFound('paper');
      if (tx.select({ id: glossaryTerms.id }).from(glossaryTerms).where(and(eq(glossaryTerms.paperId, paperId), eq(glossaryTerms.termNorm, termNorm))).get()) throw duplicate();
      const llmCallId = body.llmCallId && origin !== 'manual' ? body.llmCallId : null;
      // The source link is kept only for a message of THIS paper, and for an AI origin only for the run's own
      // assistant message (review B-R1-09); anything else is stored as null.
      const src = body.sourceMessageId
        ? tx.select({ role: messages.role, llmCallId: messages.llmCallId, paperId: threads.paperId }).from(messages).innerJoin(threads, eq(threads.id, messages.threadId)).where(eq(messages.id, body.sourceMessageId)).get()
        : undefined;
      const sourceMessageId = src && src.paperId === paperId && (origin === 'manual' || (src.role === 'assistant' && src.llmCallId === llmCallId)) ? body.sourceMessageId! : null;
      tx.insert(glossaryTerms).values({ id, paperId, term: body.term.trim(), termNorm, definitionKo: body.definitionKo ?? null, origin, sourceMessageId, llmCallId, createdAt: Date.now() }).run();
      writeCitations(tx, 'glossary_term', id, citations);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicate();
    throw e;
  }
  return toTermDto(db, db.select().from(glossaryTerms).where(eq(glossaryTerms.id, id)).get()!);
}

/** glossary.patch: a new term → manual (409 on a duplicate); a new definition → citations again, llm → llm_edited. */
export function patchTerm(db: Db, id: string, body: { term?: string; definitionKo?: string | null }): GlossaryTermDto {
  const t = db.select().from(glossaryTerms).where(eq(glossaryTerms.id, id)).get();
  if (!t) throw notFound('glossary term');
  const paper = db.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, t.paperId)).get();
  if (!paper || paper.deletingAt !== null) throw notFound('glossary term');
  const termChanged = body.term !== undefined && body.term.trim() !== t.term;
  const defChanged = body.definitionKo !== undefined && body.definitionKo !== t.definitionKo;
  const termNorm = termChanged ? normalizeTerm(body.term!) : t.termNorm;
  if (termChanged && !termNorm) throw new HttpError(400, 'validation', 'term is empty');
  const definitionKo = defChanged ? (body.definitionKo ?? null) : t.definitionKo;
  const citations = defChanged ? matchDefinition(db, t.paperId, definitionKo) : null;
  const origin: GlossaryOrigin = termChanged ? 'manual' : defChanged && t.origin === 'llm' ? 'llm_edited' : t.origin;
  try {
    db.transaction((tx) => {
      if (termChanged && tx.select({ id: glossaryTerms.id }).from(glossaryTerms).where(and(eq(glossaryTerms.paperId, t.paperId), eq(glossaryTerms.termNorm, termNorm))).all().some((x) => x.id !== id)) throw duplicate();
      tx.update(glossaryTerms)
        .set({ term: termChanged ? body.term!.trim() : t.term, termNorm, definitionKo, origin, ...(origin === 'manual' ? { llmCallId: null } : {}) })
        .where(eq(glossaryTerms.id, id))
        .run();
      if (citations) writeCitations(tx, 'glossary_term', id, citations);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicate();
    throw e;
  }
  return toTermDto(db, db.select().from(glossaryTerms).where(eq(glossaryTerms.id, id)).get()!);
}

export function deleteTerm(db: Db, id: string): void {
  const t = db.select({ id: glossaryTerms.id }).from(glossaryTerms).where(eq(glossaryTerms.id, id)).get();
  if (!t) throw notFound('glossary term');
  db.delete(glossaryTerms).where(eq(glossaryTerms.id, id)).run(); // citations by trigger
}
