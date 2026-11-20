// Owner A. Routes: 'highlights.list', 'highlights.create', 'highlights.patch', 'highlights.delete'.
// Text highlights: the web sends {quote, page, rects}; the server computes `position` (PLAN 5.3 "offset은 server만
// 계산"): matchQuote on the stored page text of that page only, kept only when the result is `verbatim` (one
// location), otherwise null.
// Area highlights (M2, PLAN_M2 3.5): exactly one rect, no quote, position null, and an optional capture PNG: the
// order is check → storeCapture (S: PNG check + file, deletion re-check) → ONE transaction (insertRow re-checks the
// paper is not tombstoned and the per-paper limits, then the highlight row) → on any failure discard() (no file left).
// sectionId (text and area, PLAN 5.3 "절 판정"): the last ANCHORED section (pdfPage + pdfOffset) before the highlight, by
// (page, offset). Headings of earlier pages are always before. On the same page: a located text highlight compares
// offsets (heading offset ≤ start); an area is compared column-aware (review A-R1-07, A-F3-01 — coordinator decision
// 추가 지시 3, PLAN_M2 9절 52). The columns come from the page's text layout, never from the heading's rect width
// (a stored heading rect is the one text item holding its offset — for a centred "I" only that numeral):
//   - pageColumns: a vertical band of width ≥ 0.01 between x 0.35 and 0.65 with ≥ 10 text items of width ≤ 0.6 of
//     the page wholly on each side → two columns, the gutter g = the band's middle; otherwise one column (also a page
//     with almost no text). Deviation from the decided "no item crosses" (A-F3-01 measurement — on 12 of the 27 pages
//     of the two real IEEE papers something crosses the gutter: the running head, the title and authors, a
//     full-width caption or table, a figure label, the arXiv stamp): the band may be crossed by LINES (text items
//     ≥ 0.15 wide — table cells, labels and maths glyphs are not lines) covering at most half of the page's line
//     height (real two-column pages ≤ 40 %). Band positions every 0.0025: the least line-blocked ones, of those the
//     ones crossed by the fewest text items (the decided rule where it holds), and the longest run of them (ties:
//     nearer the page middle) is the band
//   - the band and the item counts alone do not make two columns (review A-F4-01: a one-column page of short lines —
//     a code listing, a man page, a hex dump — often has a band crossed by less than half its line height, at
//     0.36–0.64, with ≥ 10 short items on each side; on real one-column PDFs 25 of 112 pages came out two). Two
//     columns also need lines SIDE BY SIDE at the gutter, an evidence independent of the band search (common rule 9):
//     lines ending within 0.06 left of g and lines starting within 0.06 right of g whose vertical extents overlap —
//     at least 3 such left lines and 3 such right lines (each side counted). Otherwise one column. Measured: the
//     two IEEE papers 27/27 pages two (fewest: FAST-LIO2 p19, 4 pairs); one-column pdfTeX, groff and NVIDIA SLA
//     documents 118/118 pages one. The reach 0.06 sits in the middle of what that sample allows (review A-F5-01):
//     on IEEE reference-list pages (KISS-ICP p8, FAST-LIO2 p18·p19) every right line starts after its [NN] label
//     at g + 0.0396, so a reach below 0.0397 turns them one column (a three-digit label adds ≈ 0.0065); from 0.085
//     the one-column groff decoder trace (foo2zjs p78, its meaning column at g + 0.0829) turns two. Known limits: a
//     one-column page that is mostly a two-column table of wide cells split near one x reads as two; a two-column
//     page with one column of figures, tables, maths fragments or word items only (no 3 lines at the gutter) reads as
//     one — review A-F6-01 measured 5 of 138 pages of 12 independent two-column papers (e.g. knitt2022 p4: left =
//     table + Figures 4·5, 1 pair), and the fewest pairs on a two-column page that passes there is exactly 3. Both
//     are tested; a structural change is the supervisor's (A-F4-04)
//   - on two columns a heading's or an area's column is the side of g its horizontal centre is on; an area that
//     crosses g reaching ≥ 0.05 past it on both sides is full width
//   - H is before A when col(H) < col(A), or (same column, A full width, or one column) and H.y ≤ A.top
// When a section on the same page cannot be compared (text without a position, a heading without a rect, the page's
// text layout missing or over its limit) the answer is unknown → null; with no anchored section at all → null.
// Bounded work (common rule 3, review A-F4-02): this runs inside the area highlight's create transaction. The page's
// itemsJson is measured in SQL first and not even read beyond COLUMN_RULE.maxItemsJsonChars, then at most
// COLUMN_RULE.maxItems items are laid out; pageColumns visits each item at most 4 × (band positions = 117) + 12 times.
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { matchQuote } from '@study-paper/shared/anchor/matchQuote';
import type { HighlightDto } from '@study-paper/shared/contracts/api';
import { NormRectSchema, type NormRect, type TextPositionSelector, type TextQuoteSelector } from '@study-paper/shared/contracts/domain';
import { storeCapture, type StoredCapture } from '../captures';
import { highlights, pageTexts, papers, sections } from '../db/schema';
import { HttpError, notFound, routeBody, routeJson, routeParams, type AppDeps, type RouteModule } from '../deps';

type HighlightRow = typeof highlights.$inferSelect;

export function toHighlightDto(h: HighlightRow): HighlightDto {
  const quote: TextQuoteSelector | null =
    h.quoteExact === null ? null : { exact: h.quoteExact, ...(h.quotePrefix !== null ? { prefix: h.quotePrefix } : {}), ...(h.quoteSuffix !== null ? { suffix: h.quoteSuffix } : {}) };
  const position: TextPositionSelector | null = h.startOffset !== null && h.endOffset !== null ? { page: h.page, start: h.startOffset, end: h.endOffset } : null;
  let rects: NormRect[] = [];
  try {
    rects = JSON.parse(h.rectsJson) as NormRect[];
  } catch {
    rects = [];
  }
  return {
    id: h.id,
    paperId: h.paperId,
    kind: h.kind,
    color: h.color,
    quote,
    position,
    page: h.page,
    rects,
    sectionId: h.sectionId,
    comment: h.comment,
    imageFileId: h.imageFileId,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

function livePaper(deps: AppDeps, id: string) {
  const row = deps.db.select({ id: papers.id, deletingAt: papers.deletingAt, readableAt: papers.readableAt, pageCount: papers.pageCount }).from(papers).where(eq(papers.id, id)).get();
  if (!row || row.deletingAt !== null) throw notFound('paper');
  return row;
}

/** Highlight whose paper still exists (not being deleted). */
function liveHighlight(deps: AppDeps, id: string): HighlightRow {
  const h = deps.db.select().from(highlights).where(eq(highlights.id, id)).get();
  if (!h) throw notFound('highlight');
  livePaper(deps, h.paperId);
  return h;
}

/** Offsets on `page` when the quote is verbatim there (one location after prefix/suffix), else null. */
export function positionOnPage(deps: AppDeps, paperId: string, page: number, quote: TextQuoteSelector): TextPositionSelector | null {
  const row = deps.db.select({ page: pageTexts.page, text: pageTexts.text }).from(pageTexts).where(and(eq(pageTexts.paperId, paperId), eq(pageTexts.page, page))).get();
  if (!row) return null;
  const m = matchQuote([row], quote, { pageHint: page, pageOnly: true });
  return m.status === 'verbatim' && m.position && m.position.page === page ? m.position : null;
}

/** Where a highlight is: a text offset on the page, an area's rect, or nothing known on the page. */
export type HighlightPlace = { page: number; start: number } | { page: number; rect: NormRect } | { page: number };

/** The column rule's constants (coordinator decision 추가 지시 3 A-F3-01; normalised page coordinates). */
export const COLUMN_RULE = {
  /** Only items this wide or narrower count on the two sides (a full-width title or caption line is neither). */
  maxItemWidth: 0.6,
  /** The gutter band is looked for between these x … */
  bandFrom: 0.35,
  bandTo: 0.65,
  /** … with this width, at positions this far apart. */
  minBandWidth: 0.01,
  bandStep: 0.0025,
  /** Items wholly on each side of the band. */
  minItemsPerSide: 10,
  /** Share of the page's line height the lines crossing the band may cover (see the header). */
  maxBlockedShare: 0.5,
  /** A text item at least this wide is a line (or a long part of one) — table cells, figure labels and math glyphs are not. */
  minLineWidth: 0.15,
  /**
   * Side-by-side evidence: lines ending / starting this close to the gutter … Measured margins (review A-F5-01):
   * reference-list pages need ≥ 0.0397, a one-column decoder trace turns two from 0.085 (see the header).
   */
  sideReach: 0.06,
  /** … at least this many on each side overlapping a line of the other side vertically. */
  minSidePairs: 3,
  /** An area reaching this far past the gutter on both sides is full width. */
  fullWidthReach: 0.05,
  /**
   * More items than this on one page → the layout is not computed (unknown). Real pages: ≤ 1,045 (FAST-LIO2 p5;
   * one-column pdfTeX / groff documents ≤ 333). Worst shape at the cap (every item a line crossing every band
   * position): ≈ 20 ms for JSON.parse + pageColumns — the work bound is tested by item visits, not time.
   */
  maxItems: 4_000,
  /**
   * A page's itemsJson longer than this is not parsed (unknown): maxItems × 160 characters — an item as pdfText
   * writes it is ≤ 160 (7-digit start, 5-digit len, 4-digit page, four 22-character numbers); real ones ≤ 140.
   */
  maxItemsJsonChars: 640_000,
} as const;

/** A page's text layout: one column, or two with the gutter's x. */
export type PageColumns = { kind: 'one' } | { kind: 'two'; gutter: number };
/** What the layout reads of a page_texts item. */
export type LayoutItem = { len: number; rect: { x: number; y: number; w: number; h: number } };

/** Merged [a, b] intervals (input sorted by a; touching ones join). */
function mergeIntervals(iv: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** How many of `items` overlap (open intervals) some interval of `merged` vertically — O(log n) each. */
function overlapping(items: readonly LayoutItem[], merged: readonly [number, number][]): number {
  let n = 0;
  for (const i of items) {
    const top = i.rect.y;
    const bottom = i.rect.y + i.rect.h;
    // the last merged interval starting before this item's bottom is the only one that can overlap it
    let lo = 0;
    let hi = merged.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (merged[mid]![0] < bottom) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (k >= 0 && merged[k]![1] > top) n++;
  }
  return n;
}

/** Total length of the union of [a, b] intervals sorted by a. */
function unionLength(iv: readonly (readonly [number, number])[]): number {
  let total = 0;
  let s = -Infinity;
  let e = -Infinity;
  for (const [a, b] of iv) {
    if (a > e) {
      if (e > s) total += e - s;
      s = a;
      e = b;
    } else if (b > e) e = b;
  }
  if (e > s) total += e - s;
  return total;
}

/** Band positions looked at: every COLUMN_RULE.bandStep from bandFrom while the band ends by bandTo (117). */
export const BAND_POSITIONS = Math.floor(Math.round(((COLUMN_RULE.bandTo - COLUMN_RULE.minBandWidth - COLUMN_RULE.bandFrom) / COLUMN_RULE.bandStep) * 1e6) / 1e6) + 1;

/**
 * One or two columns from a page's text items (see the header). Work: each item is visited at most
 * 4 × BAND_POSITIONS + 12 times (plus the sort, n log n, and the binary searches, log n per side line); items ≤
 * COLUMN_RULE.maxItems (the caller checks). `work` (tests) counts the visits.
 */
export function pageColumns(items: readonly LayoutItem[], work?: { itemVisits: number }): PageColumns {
  const R = COLUMN_RULE;
  const visit = (n: number) => {
    if (work) work.itemVisits += n;
  };
  visit(items.length);
  const text = items.filter((i) => i.len > 0);
  // vertical extents of the lines in y order — the page's line height and what crosses a band
  visit(2 * text.length);
  const tall = text.filter((i) => i.rect.h > 0 && i.rect.w >= R.minLineWidth).sort((a, b) => a.rect.y - b.rect.y);
  visit(2 * tall.length); // the map and the union
  const height = unionLength(tall.map((i) => [i.rect.y, i.rect.y + i.rect.h] as const));
  if (!(height > 0)) return { kind: 'one' };
  const positions = BAND_POSITIONS;
  const at = (k: number) => R.bandFrom + k * R.bandStep;
  const used = text.filter((i) => i.rect.w <= R.maxItemWidth);
  const crosses = (i: LayoutItem, a: number) => i.rect.x < a + R.minBandWidth && i.rect.x + i.rect.w > a;
  const blocked: number[] = [];
  const crossing: number[] = [];
  for (let k = 0; k < positions; k++) {
    const a = at(k);
    const across = tall.filter((i) => crosses(i, a));
    visit(tall.length + 2 * across.length + used.length);
    blocked.push(unionLength(across.map((i) => [i.rect.y, i.rect.y + i.rect.h] as const)) / height);
    crossing.push(used.filter((i) => crosses(i, a)).length);
  }
  const least = Math.min(...blocked);
  if (least > R.maxBlockedShare) return { kind: 'one' };
  // of the least-blocked positions, those crossed by the fewest items (the decided "no item crosses" when it holds);
  // the longest run of them (ties: the one nearer the page middle) is the band
  let fewest = Infinity;
  for (let k = 0; k < positions; k++) if (blocked[k] === least && crossing[k]! < fewest) fewest = crossing[k]!;
  const chosen = (k: number) => blocked[k] === least && crossing[k] === fewest;
  let band: [number, number] | null = null;
  for (let k = 0; k < positions; ) {
    if (!chosen(k)) {
      k++;
      continue;
    }
    let e = k;
    while (e + 1 < positions && chosen(e + 1)) e++;
    const cand: [number, number] = [at(k), at(e) + R.minBandWidth];
    const len = (r: [number, number]) => r[1] - r[0];
    const off = (r: [number, number]) => Math.abs((r[0] + r[1]) / 2 - 0.5);
    if (!band || len(cand) > len(band) + 1e-12 || (Math.abs(len(cand) - len(band)) <= 1e-12 && off(cand) < off(band))) band = cand;
    k = e + 1;
  }
  const [a, b] = band!;
  visit(2 * used.length);
  const leftSide = used.filter((i) => i.rect.x + i.rect.w <= a + 1e-9).length;
  const rightSide = used.filter((i) => i.rect.x >= b - 1e-9).length;
  if (leftSide < R.minItemsPerSide || rightSide < R.minItemsPerSide) return { kind: 'one' };
  const g = (a + b) / 2;
  visit(2 * tall.length);
  // lines side by side at the gutter (see the header): tall is sorted by y, so both sides are too
  const left = tall.filter((i) => i.rect.x + i.rect.w <= g && i.rect.x + i.rect.w >= g - R.sideReach);
  const right = tall.filter((i) => i.rect.x >= g && i.rect.x <= g + R.sideReach);
  visit(3 * (left.length + right.length)); // the spans (map + merge) and the overlap searches
  const span = (side: readonly LayoutItem[]) => mergeIntervals(side.map((i) => [i.rect.y, i.rect.y + i.rect.h] as const));
  if (overlapping(left, span(right)) < R.minSidePairs || overlapping(right, span(left)) < R.minSidePairs) return { kind: 'one' };
  return { kind: 'two', gutter: g };
}

/** Column index of a rect on a two-column page: 0 left, 1 right, by its horizontal centre. */
const columnOf = (r: NormRect, gutter: number) => (r.x + r.w / 2 < gutter ? 0 : 1);

/** A same-page heading rect is before an area rect on a page with this layout (see the header). */
export function headingBeforeArea(heading: NormRect, area: NormRect, layout: PageColumns): boolean {
  const above = heading.y <= area.y;
  if (layout.kind === 'one') return above;
  const g = layout.gutter;
  if (area.x <= g - COLUMN_RULE.fullWidthReach && area.x + area.w >= g + COLUMN_RULE.fullWidthReach) return above; // full width
  const ch = columnOf(heading, g);
  const ca = columnOf(area, g);
  return ch < ca || (ch === ca && above);
}

/**
 * The stored text layout of one page, or null when unknown (no row, itemsJson over its length limit — measured in
 * SQL, never read or parsed —, unreadable items, over the item limit).
 */
export function storedPageColumns(deps: Pick<AppDeps, 'db'>, paperId: string, page: number): PageColumns | null {
  const row = deps.db
    .select({ items: sql<string | null>`CASE WHEN length(${pageTexts.itemsJson}) <= ${COLUMN_RULE.maxItemsJsonChars} THEN ${pageTexts.itemsJson} ELSE NULL END` })
    .from(pageTexts)
    .where(and(eq(pageTexts.paperId, paperId), eq(pageTexts.page, page)))
    .get();
  if (!row || row.items === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(row.items);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length > COLUMN_RULE.maxItems) return null;
  const items: LayoutItem[] = [];
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  for (const it of raw as unknown[]) {
    const r = (it as { rect?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } } | null)?.rect;
    const len = (it as { len?: unknown } | null)?.len;
    if (!num(len) || !r || !num(r.x) || !num(r.y) || !num(r.w) || !num(r.h)) return null;
    items.push({ len, rect: { x: r.x, y: r.y, w: r.w, h: r.h } });
  }
  return pageColumns(items);
}

/** The section a highlight belongs to (see the header), or null. */
export function sectionAt(deps: Pick<AppDeps, 'db'>, paperId: string, place: HighlightPlace): string | null {
  const rows = deps.db
    .select({ id: sections.id, page: sections.pdfPage, offset: sections.pdfOffset, rect: sections.pdfRectJson })
    .from(sections)
    .where(and(eq(sections.paperId, paperId), isNotNull(sections.pdfPage), isNotNull(sections.pdfOffset)))
    .all();
  let best: { id: string; page: number; offset: number } | null = null;
  let layout: PageColumns | null | undefined; // the area's page, read on the first same-page heading
  const better = (r: { id: string; page: number; offset: number }) => !best || r.page > best.page || (r.page === best.page && r.offset > best.offset);
  for (const r of rows) {
    const page = r.page!;
    const offset = r.offset!;
    if (page > place.page) continue;
    if (page === place.page) {
      if ('start' in place) {
        if (offset > place.start) continue;
      } else if ('rect' in place) {
        let rect: NormRect | null = null;
        try {
          const v = r.rect ? NormRectSchema.safeParse(JSON.parse(r.rect)) : null;
          rect = v?.success ? v.data : null;
        } catch {
          rect = null;
        }
        if (!rect) return null; // a heading on this page we cannot place relative to the area
        if (layout === undefined) layout = storedPageColumns(deps, paperId, place.page);
        if (layout === null) return null; // the page's text layout is unknown
        if (!headingBeforeArea(rect, place.rect, layout)) continue;
      } else return null; // a heading on this page and no position for the highlight
    }
    if (better({ id: r.id, page, offset })) best = { id: r.id, page, offset };
  }
  return best ? (best as { id: string }).id : null;
}

export const highlightsRoutes: RouteModule = (deps) => ({
  'highlights.list': (c) => {
    const { id } = routeParams(c, 'highlights.list');
    livePaper(deps, id);
    const rows = deps.db.select().from(highlights).where(eq(highlights.paperId, id)).orderBy(asc(highlights.page), asc(highlights.startOffset), asc(highlights.createdAt), asc(highlights.id)).all();
    return routeJson(c, 'highlights.list', { highlights: rows.map(toHighlightDto) });
  },
  'highlights.create': async (c) => {
    const { id } = routeParams(c, 'highlights.create');
    const body = await routeBody(c, 'highlights.create');
    const paper = livePaper(deps, id);
    if (paper.readableAt === null || paper.pageCount === null) throw new HttpError(409, 'conflict', 'the paper is not readable yet');
    if (body.page > paper.pageCount) throw new HttpError(400, 'validation', `page ${body.page} is beyond the last page (${paper.pageCount})`);
    // The contract already refuses rects on another page; keep the check next to the write as well.
    if (body.rects.some((r) => r.page !== body.page)) throw new HttpError(400, 'validation', 'every rect must be on `page`');
    if (body.kind === 'area') {
      if (body.rects.length !== 1) throw new HttpError(400, 'validation', 'an area highlight has exactly one rect');
      const rect = body.rects[0]!;
      const now = Date.now();
      const hid = randomUUID();
      // storeCapture checks the PNG (400) and the paper (404) before anything is written.
      const stored: StoredCapture | null = body.imagePng !== undefined ? storeCapture(deps, id, body.imagePng) : null;
      try {
        deps.db.transaction((tx) => {
          stored?.insertRow(tx);
          const p = tx.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, id)).get();
          if (!p || p.deletingAt !== null) throw notFound('paper');
          tx.insert(highlights)
            .values({ id: hid, paperId: id, kind: 'area', color: body.color, quoteExact: null, quotePrefix: null, quoteSuffix: null, page: body.page, startOffset: null, endOffset: null, rectsJson: JSON.stringify([rect]), sectionId: sectionAt(deps, id, { page: body.page, rect }), comment: body.comment ?? null, imageFileId: stored?.fileId ?? null, createdAt: now, updatedAt: now })
            .run();
        });
      } catch (e) {
        stored?.discard();
        throw e;
      }
      return routeJson(c, 'highlights.create', toHighlightDto(deps.db.select().from(highlights).where(eq(highlights.id, hid)).get()!));
    }
    const quote = body.quote!;
    const position = positionOnPage(deps, id, body.page, quote);
    const now = Date.now();
    const row: typeof highlights.$inferInsert = {
      id: randomUUID(),
      paperId: id,
      kind: 'text',
      color: body.color,
      quoteExact: quote.exact,
      quotePrefix: quote.prefix ?? null,
      quoteSuffix: quote.suffix ?? null,
      page: body.page,
      startOffset: position?.start ?? null,
      endOffset: position?.end ?? null,
      rectsJson: JSON.stringify(body.rects),
      sectionId: sectionAt(deps, id, position ? { page: body.page, start: position.start } : { page: body.page }),
      comment: body.comment ?? null,
      imageFileId: null,
      createdAt: now,
      updatedAt: now,
    };
    deps.db.insert(highlights).values(row).run();
    return routeJson(c, 'highlights.create', toHighlightDto(deps.db.select().from(highlights).where(eq(highlights.id, row.id)).get()!));
  },
  'highlights.patch': async (c) => {
    const { id } = routeParams(c, 'highlights.patch');
    const body = await routeBody(c, 'highlights.patch');
    liveHighlight(deps, id);
    const set: Partial<typeof highlights.$inferInsert> = { updatedAt: Date.now() };
    if (body.color !== undefined) set.color = body.color;
    if (body.comment !== undefined) set.comment = body.comment;
    deps.db.update(highlights).set(set).where(eq(highlights.id, id)).run();
    return routeJson(c, 'highlights.patch', toHighlightDto(deps.db.select().from(highlights).where(eq(highlights.id, id)).get()!));
  },
  'highlights.delete': (c) => {
    const { id } = routeParams(c, 'highlights.delete');
    liveHighlight(deps, id);
    deps.db.delete(highlights).where(eq(highlights.id, id)).run();
    return c.body(null, 204);
  },
});
