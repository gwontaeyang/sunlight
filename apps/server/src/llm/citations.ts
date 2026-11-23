// Citation matching and statistics for a finished answer (PLAN 5.3, 5.4). Owner B.
// Quotes: shared matchQuote (owner C) → verbatim | fuzzy | ambiguous | not_found, searched from the
// selection's page first (pageHint); `unchecked` when the answer's work budget or an input cap ran out.
// Equation refs: the `equations` index → resolved (one row with a PDF position) | no_anchor (one row, no
// position) | ambiguous (several rows) | not_found.
// A [[P]] block counts as grounded ("논문 근거", blocks.p) only with a verbatim quote; a block whose only evidence is a
// resolved/no_anchor equation reference is counted apart (blocks.pEquationOnly — PLAN_M2 D18); fuzzy and ambiguous
// never ground a claim. The decision is contracts/grounding.ts (evidenceOf). Every stats group sums to its denominator.
// M2 (PLAN_M2 3.3): the index = the paper's equations with a number (rows without one are ignored); a resolved /
// no_anchor reference carries the row's equationId, an ambiguous one its candidates (≤ EQ_CANDIDATES_MAX), both only
// when the index rows have ids. latex / katexOk come from the row (a latex longer than EQUATION_LATEX_MAX is left out).
// An unchecked quote says why (uncheckedReason): quote_too_long / text_too_long (the matcher's input caps) /
// work_budget. The matcher itself is unchanged (shared/anchor is frozen).
import type { Citation, MessageStats, ParsedAnswer, UncheckedReason } from '@study-paper/shared/contracts/domain';
import { EQ_CANDIDATES_MAX, EQUATION_LATEX_MAX, eqNumberKey, normalizeEqNumber } from '@study-paper/shared/contracts/domain';
import { evidenceOf } from '@study-paper/shared/contracts/grounding';
import { MAX_ANSWER_WORK, MAX_NEEDLE_CHARS, MAX_TEXT_CHARS, matchQuote, WorkBudget, type PageTextLike } from '@study-paper/shared/anchor/matchQuote';
import { normalizeN1 } from '@study-paper/shared/anchor/normalize';

/** One row of the equation index. `number` and `pdfPage` are required; the other fields are optional (M2). */
export interface EquationIndexRow {
  number: string | null;
  pdfPage: number | null;
  /** equations.id (stored as citations.equationId). */
  id?: string;
  latex?: string;
  katexOk?: boolean;
  /** sections.number of the equation's section (eqCandidates). */
  sectionNumber?: string | null;
}

export interface ResolveOptions {
  /** Page searched first (the page of the selection the question is about). */
  pageHint?: number;
  /** A work budget shared with other contents (one card = one budget for all its items). Default: a new one. */
  budget?: WorkBudget;
}

/** Why a quote stayed unchecked: the matcher's input caps, else the work budget. */
export function uncheckedReasonOf(quote: string, pages: readonly PageTextLike[]): UncheckedReason {
  if (normalizeN1(quote).text.trim().length > MAX_NEEDLE_CHARS) return 'quote_too_long';
  if (pages.reduce((n, p) => n + p.text.length, 0) > MAX_TEXT_CHARS) return 'text_too_long';
  return 'work_budget';
}

/** The equation fields of a resolved / no_anchor reference to `row` (only what the row has). */
export function equationFields(row: EquationIndexRow): Pick<Citation, 'equationId' | 'latex' | 'katexOk'> {
  if (row.id === undefined) return {};
  return { equationId: row.id, ...(row.latex !== undefined && row.latex.length <= EQUATION_LATEX_MAX ? { latex: row.latex } : {}), ...(row.katexOk !== undefined ? { katexOk: row.katexOk } : {}) };
}

/** eqCandidates of an ambiguous reference (only when every matching row has an id). */
export function candidateFields(rows: readonly EquationIndexRow[]): Pick<Citation, 'eqCandidates'> {
  if (rows.length === 0 || rows.some((r) => r.id === undefined)) return {};
  return { eqCandidates: rows.slice(0, EQ_CANDIDATES_MAX).map((r) => ({ equationId: r.id!, sectionNumber: r.sectionNumber ?? null, pdfPage: r.pdfPage })) };
}

/** Index rows with a number, grouped by eqNumberKey (index order kept inside each group). */
export function equationRowsByKey(rows: readonly EquationIndexRow[]): Map<string, EquationIndexRow[]> {
  const out = new Map<string, EquationIndexRow[]>();
  for (const e of rows) {
    if (e.number === null) continue;
    const key = eqNumberKey(e.number);
    const list = out.get(key);
    if (list) list.push(e);
    else out.set(key, [e]);
  }
  return out;
}

/** The contracts' one equation-number normalization, re-exported for this module's importers; compare with eqNumberKey. */
export { normalizeEqNumber };

/** null means exact source verification is unavailable for this paper, even if its PDF yielded text. */
export type GroundingPages = readonly PageTextLike[] | null;

export function resolveCitations(parsed: ParsedAnswer, pages: GroundingPages, equations: readonly EquationIndexRow[], opts: ResolveOptions = {}): Citation[] {
  if (pages === null) {
    return parsed.citations.map((c): Citation => c.kind === 'quote'
      ? { ordinal: c.ordinal, kind: 'quote', quote: c.quote ?? '', status: 'unchecked', uncheckedReason: 'uploaded_pdf', score: 0 }
      : { ordinal: c.ordinal, kind: 'equation', eqNumber: c.eqNumber ?? '', status: 'unindexed', score: 0 });
  }
  const pageHint = opts.pageHint !== undefined && pages.some((p) => p.page === opts.pageHint) ? opts.pageHint : undefined;
  // One work budget for the whole answer (review N3): exact + fuzzy matching of all its quotes; what does not fit
  // is `unchecked` (shared/anchor/matchQuote.ts header).
  const budget = opts.budget ?? new WorkBudget(MAX_ANSWER_WORK);
  const indexed = equations.filter((e) => e.number !== null);
  // One map per answer, built on the first equation reference: each reference is one lookup, not a pass over the
  // index. parseAnswer caps references at MAX_EQ_REFS_PER_MESSAGE (40) per content (S-2); RawCitations passed in
  // directly have no cap, so the lookup stays one per reference (review B-R2-04).
  let byKey: Map<string, EquationIndexRow[]> | null = null;
  const rowsOf = (eqNumber: string): readonly EquationIndexRow[] => {
    byKey ??= equationRowsByKey(indexed);
    return byKey.get(eqNumberKey(eqNumber)) ?? [];
  };
  return parsed.citations.map((c): Citation => {
    if (c.kind === 'quote') {
      const m = matchQuote(pages, { exact: c.quote ?? '' }, pageHint !== undefined ? { pageHint, budget } : { budget });
      const status = m.status;
      const located = (status === 'verbatim' || status === 'fuzzy') && m.position !== undefined;
      return {
        ordinal: c.ordinal,
        kind: 'quote',
        quote: c.quote ?? '',
        status,
        score: Math.max(0, Math.min(1, m.score)),
        ...(located ? { position: m.position } : {}),
        ...(status === 'ambiguous' && m.candidates !== undefined ? { candidates: m.candidates } : {}),
        ...(status === 'unchecked' ? { uncheckedReason: uncheckedReasonOf(c.quote ?? '', pages) } : {}),
      };
    }
    const rows = rowsOf(c.eqNumber ?? '');
    // No equation index at all (M1 papers, uploads): the number cannot be checked → unindexed, not "not found".
    const status = indexed.length === 0 ? 'unindexed' : rows.length === 0 ? 'not_found' : rows.length > 1 ? 'ambiguous' : rows[0]!.pdfPage === null ? 'no_anchor' : 'resolved';
    return {
      ordinal: c.ordinal,
      kind: 'equation',
      eqNumber: c.eqNumber ?? '',
      status,
      score: status === 'resolved' || status === 'no_anchor' ? 1 : 0,
      ...(status === 'ambiguous' ? { candidates: rows.length, ...candidateFields(rows) } : {}),
      ...(status === 'resolved' || status === 'no_anchor' ? equationFields(rows[0]!) : {}),
    };
  });
}

/** messages.statsJson (PLAN 5.4). */
export function computeStats(parsed: ParsedAnswer, citations: readonly Citation[]): MessageStats {
  const byOrdinal = new Map(citations.map((c) => [c.ordinal, c]));
  const stats: MessageStats = {
    blocks: { p: 0, pEquationOnly: 0, pUnverified: 0, n: 0, g: 0, unlabeled: 0 },
    quotes: { verbatim: 0, fuzzy: 0, ambiguous: 0, notFound: 0 },
    eqRefs: { resolved: 0, noAnchor: 0, ambiguous: 0, notFound: 0, unindexed: 0 },
  };
  for (const b of parsed.blocks) {
    if (b.label === 'P') {
      const evidence = evidenceOf(b.citationOrdinals.map((o) => byOrdinal.get(o)).filter((c): c is Citation => c !== undefined));
      if (evidence === 'quote') stats.blocks.p++;
      else if (evidence === 'equation_ref') stats.blocks.pEquationOnly++;
      else stats.blocks.pUnverified++;
    } else if (b.label === 'N') stats.blocks.n++;
    else if (b.label === 'G') stats.blocks.g++;
    else stats.blocks.unlabeled++;
  }
  for (const c of citations) {
    if (c.kind === 'quote') {
      if (c.status === 'verbatim') stats.quotes.verbatim++;
      else if (c.status === 'fuzzy') stats.quotes.fuzzy++;
      else if (c.status === 'ambiguous') stats.quotes.ambiguous++;
      else if (c.status === 'unchecked') stats.quotes.unchecked = (stats.quotes.unchecked ?? 0) + 1;
      else stats.quotes.notFound++;
    } else if (c.status === 'resolved') stats.eqRefs.resolved++;
    else if (c.status === 'no_anchor') stats.eqRefs.noAnchor++;
    else if (c.status === 'ambiguous') stats.eqRefs.ambiguous++;
    else if (c.status === 'unindexed') stats.eqRefs.unindexed++;
    else stats.eqRefs.notFound++;
  }
  return stats;
}
