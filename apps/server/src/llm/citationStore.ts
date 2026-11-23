// Stored citations of the three M2 owners (message, paper_card_item, glossary_term). Owner B.
// Stored per citation: ordinal, kind, quote / eqNumber, status, score, position, candidates (count), equationId
// (resolved | no_anchor) and detail (uncheckedReason of an unchecked quote). The equation fields are attached on READ
// from `equations` (PLAN_M2 D7): latex / katexOk of equationId (a latex longer than EQUATION_LATEX_MAX is left out —
// a second guard so one over-long row can never make threads.get / cards.list fail their response schema), and
// eqCandidates of an ambiguous reference (the paper's numbered equations with the same eqNumberKey, ≤ 8).
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Citation, CitationOwnerType } from '@study-paper/shared/contracts/domain';
import { eqNumberKey, isPdfOnlyUpload, UncheckedReason } from '@study-paper/shared/contracts/domain';
import type { Db } from '../db/client';
import { citations as citationsTable, equations, glossaryTerms, messages, pageTexts, paperCardItems, paperCards, papers, sections, threads } from '../db/schema';
import { candidateFields, equationFields, equationRowsByKey, type EquationIndexRow, type GroundingPages } from './citations';
import type { RunTx } from './runContract';

type Reader = Db | RunTx;

/** The paper an owner belongs to (for eqCandidates); null when the owner row is gone. */
function ownerPaperId(db: Reader, ownerType: CitationOwnerType, ownerId: string): string | null {
  if (ownerType === 'message') {
    const r = db.select({ paperId: threads.paperId }).from(messages).innerJoin(threads, eq(threads.id, messages.threadId)).where(eq(messages.id, ownerId)).get();
    return r?.paperId ?? null;
  }
  if (ownerType === 'paper_card_item') {
    const r = db.select({ paperId: paperCards.paperId }).from(paperCardItems).innerJoin(paperCards, eq(paperCards.id, paperCardItems.cardId)).where(eq(paperCardItems.id, ownerId)).get();
    return r?.paperId ?? null;
  }
  if (ownerType === 'glossary_term') return db.select({ paperId: glossaryTerms.paperId }).from(glossaryTerms).where(eq(glossaryTerms.id, ownerId)).get()?.paperId ?? null;
  return null;
}

export function groundingPages(db: Reader, paperId: string): GroundingPages {
  const row = db.select({ source: papers.source, structureSource: papers.structureSource }).from(papers).where(eq(papers.id, paperId)).get();
  if (row && isPdfOnlyUpload(row.source, row.structureSource)) return null;
  return db.select({ page: pageTexts.page, text: pageTexts.text }).from(pageTexts)
    .where(eq(pageTexts.paperId, paperId)).orderBy(asc(pageTexts.page)).all();
}

/** The numbered equations of a paper as index rows (with ids, LaTeX and section numbers) — what the runs match against. */
export function equationIndex(db: Reader, paperId: string): EquationIndexRow[] {
  return db
    .select({ id: equations.id, number: equations.number, pdfPage: equations.pdfPage, latex: equations.latex, katexOk: equations.katexOk, sectionNumber: sections.number })
    .from(equations)
    .leftJoin(sections, eq(sections.id, equations.sectionId))
    .where(and(eq(equations.paperId, paperId), isNotNull(equations.number)))
    .orderBy(asc(equations.ordinal))
    .all()
    .map((r) => ({ id: r.id, number: r.number, pdfPage: r.pdfPage, latex: r.latex, katexOk: r.katexOk, sectionNumber: r.sectionNumber ?? null }));
}

/** Stored citations of one owner (ordinal order) as the Citation DTO, equation fields attached from `equations`. */
export function readCitations(db: Reader, ownerType: CitationOwnerType, ownerId: string): Citation[] {
  const rows = db
    .select()
    .from(citationsTable)
    .where(and(eq(citationsTable.ownerType, ownerType), eq(citationsTable.ownerId, ownerId)))
    .orderBy(asc(citationsTable.ordinal))
    .all();
  if (rows.length === 0) return [];
  // Distinct ids: one equation cited many times is one bound variable (review B-R2-04).
  const eqIds = [...new Set(rows.map((c) => c.equationId).filter((x): x is string => x !== null))];
  const byId = new Map<string, EquationIndexRow>();
  if (eqIds.length) {
    for (const e of db.select({ id: equations.id, number: equations.number, pdfPage: equations.pdfPage, latex: equations.latex, katexOk: equations.katexOk }).from(equations).where(inArray(equations.id, eqIds)).all()) byId.set(e.id, e);
  }
  // Ambiguous references: the paper's index grouped by eqNumberKey once, then one lookup each (review B-R2-04).
  let index: Map<string, EquationIndexRow[]> | null = null;
  const rowsOf = (eqNumber: string): readonly EquationIndexRow[] => {
    if (index === null) {
      const paperId = ownerPaperId(db, ownerType, ownerId);
      index = equationRowsByKey(paperId ? equationIndex(db, paperId) : []);
    }
    return index.get(eqNumberKey(eqNumber)) ?? [];
  };
  return rows.map((c): Citation => {
    const position = c.page !== null && c.startOffset !== null && c.endOffset !== null && c.startOffset < c.endOffset ? { page: c.page, start: c.startOffset, end: c.endOffset } : undefined;
    const status = c.status as Citation['status'];
    const equationRef = c.kind === 'equation' && (status === 'resolved' || status === 'no_anchor');
    const row = equationRef && c.equationId ? byId.get(c.equationId) : undefined;
    const reason = c.kind === 'quote' && status === 'unchecked' ? UncheckedReason.safeParse(c.detail) : null;
    let candidates = {};
    if (c.kind === 'equation' && status === 'ambiguous' && c.eqNumber !== null) {
      candidates = candidateFields(rowsOf(c.eqNumber));
    }
    return {
      ordinal: c.ordinal,
      kind: c.kind,
      ...(c.quote !== null ? { quote: c.quote } : {}),
      ...(c.eqNumber !== null ? { eqNumber: c.eqNumber } : {}),
      status,
      score: c.score,
      ...(position && (status === 'verbatim' || status === 'fuzzy') ? { position } : {}),
      ...(c.candidates !== null ? { candidates: c.candidates } : {}),
      // equationId is kept even when the equation row is gone (re-ingest never happens; a dangling id shows no LaTeX)
      ...(equationRef && c.equationId ? { equationId: c.equationId, ...(row ? equationFields({ ...row, id: c.equationId }) : {}) } : {}),
      ...candidates,
      ...(reason?.success ? { uncheckedReason: reason.data } : {}),
    };
  });
}

/** Replaces the citations of one owner (inside the caller's transaction). */
export function writeCitations(tx: RunTx, ownerType: CitationOwnerType, ownerId: string, cites: readonly Citation[]): void {
  tx.delete(citationsTable).where(and(eq(citationsTable.ownerType, ownerType), eq(citationsTable.ownerId, ownerId))).run();
  for (const c of cites) {
    tx.insert(citationsTable)
      .values({
        id: randomUUID(),
        ownerType,
        ownerId,
        ordinal: c.ordinal,
        kind: c.kind,
        quote: c.quote ?? null,
        eqNumber: c.eqNumber ?? null,
        status: c.status,
        score: c.score,
        page: c.position?.page ?? null,
        startOffset: c.position?.start ?? null,
        endOffset: c.position?.end ?? null,
        candidates: c.candidates ?? null,
        equationId: c.kind === 'equation' && (c.status === 'resolved' || c.status === 'no_anchor') ? (c.equationId ?? null) : null,
        detail: c.kind === 'quote' && c.status === 'unchecked' ? (c.uncheckedReason ?? null) : null,
      })
      .run();
  }
}
