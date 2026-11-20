// Outline model (BRIEF_C C7): section tree, current section, reading states. Owner C. Pure functions only.
// Current section (PLAN §5.3 "절 판정", web form; two-column rule = C 수정 3, C-I10-01). Only the server's position of
// each heading is used (pdfPage, pdfRect — y 0 and the left column when the heading has a page but no rect); the web
// never computes text offsets, and unanchored sections (pdfPage null) are skipped.
// - Column of a box: full width (read like the left column) when it reaches FULL_WIDTH_MARGIN past the page middle on
//   both sides (x < 0.5 − m and x + w > 0.5 + m — a centred one-column heading or a full-width line); otherwise by its
//   centre: x + w/2 < 0.5 → left, else right. A right column that starts a little left of the middle (twoside margins,
//   C3-R1-01) stays right. One-column pages and full-width headings keep the plain rule below.
// - Viewport (`currentSectionAt`, page p, top t ∈ [0, 1]): every anchored heading gets a threshold on the scroll axis
//   (p − 1) + τ. Left / full width: τ = y (the heading has reached the viewport top — the plain rule). Right column:
//   τ = L + (1 − L)·y, where L is τ of the last left / full-width heading on the same page that comes before it in
//   ordinal order (0 when there is none). So the right column of a page is read after its left column's headings,
//   in its own y order, still on that page; with no left heading before it on the page τ = y as before.
//   current = the heading with the largest ordinal whose threshold ≤ (p − 1) + t. The set of passed headings only
//   grows as t grows, so scrolling down never moves the current section back in document order. When the anchors
//   follow reading order (page, column, y) the thresholds strictly increase with the ordinal, so every anchored
//   heading is current on an interval; a heading anchored out of that order can be overtaken (it is then skipped).
// - Selection (`sectionAtRect` with the selection's first rect in reading order — `selectionSectionId`, used for the
//   sectionId of a note or a question on a selection, C-I10-01): the heading with the largest ordinal whose
//   (page, column, y) is at or before the rect's (page, column, y) in reading order — right column text above its
//   first heading still belongs to the left column's last section. The rect's y is its vertical centre y + h/2
//   (C3-R3-01): a selection rect is the browser's text box of the selected glyphs (text layer, selection.ts) and a
//   heading's pdfRect is the server's item box (top = baseline − font size, shared/anchor/pageText.ts); their tops
//   differ by a fraction of an em in either direction with the font the browser picks (measured: DOM top 0.0009 above
//   the item in a stored highlight, 0.0011–0.0016 below it in e2e Chrome), so comparing the top would put a selection
//   of the heading line itself in the previous section. The centre of the heading line's box is below the heading's
//   item top, the centre of the line above it is above that top (half a line pitch, ≥ ~0.006 of the page, against a
//   top difference of ~0.002). A selection rect covers only the selected part of
//   a line, so in a one-column paper a selection in the right half of a line has its centre right of the middle: the
//   rect's column is used only when the paper shows two columns, i.e. some anchored heading is in the right column
//   (C3-R2-01); otherwise every rect counts as the left column and the selection follows the plain (page, y) rule,
//   like the viewport. The first rect of a selection is chosen with the same column. Limits (the structure carries no
//   per-page column layout — the server's page judgement would be a contract change, an M3 candidate): a two-column
//   paper whose anchored headings are all in the left column is read by (page, y) only; a one-column paper with a
//   centred heading narrower than 2·FULL_WIDTH_MARGIN whose centre is right of the middle counts as two columns; in a
//   two-column paper the right half of a full-width line (a caption) is read as the right column.
import type { SectionDto } from '@study-paper/shared/contracts/api';
import type { Anchor, NormRect, ReadingState } from '@study-paper/shared/contracts/domain';

export interface OutlineNode {
  section: SectionDto;
  children: OutlineNode[];
}

/** Sections as a tree (parentId), children in ordinal order. A missing or cyclic parent makes the node a root. */
export function buildOutlineTree(sections: readonly SectionDto[]): OutlineNode[] {
  const sorted = [...sections].sort((a, b) => a.ordinal - b.ordinal);
  const byId = new Map(sorted.map((s) => [s.id, s] as const));
  const nodes = new Map(sorted.map((s) => [s.id, { section: s, children: [] as OutlineNode[] }] as const));
  // A parent chain longer than the section count is a cycle (bounded walk per node).
  const rootedParent = (s: SectionDto): string | null => {
    const p = s.parentId;
    if (p === null || p === s.id || !byId.has(p)) return null;
    let cur: string | null = p;
    for (let i = 0; cur !== null && i <= sorted.length; i++) {
      if (cur === s.id) return null;
      cur = byId.get(cur)?.parentId ?? null;
    }
    return cur === null ? p : null;
  };
  const roots: OutlineNode[] = [];
  for (const s of sorted) {
    const parent = rootedParent(s);
    const node = nodes.get(s.id)!;
    if (parent === null) roots.push(node);
    else nodes.get(parent)!.children.push(node);
  }
  return roots;
}

type Column = 0 | 1; // 0 = left or full width, 1 = right

/** How far (page width) a box must reach past the page middle on each side to count as full width. */
export const FULL_WIDTH_MARGIN = 0.03;

/** Column of a box (see the header): full width when it spans the middle by the margin on both sides, else its centre. */
export function columnOf(r: Pick<NormRect, 'x' | 'w'>): Column {
  if (r.x < 0.5 - FULL_WIDTH_MARGIN && r.x + r.w > 0.5 + FULL_WIDTH_MARGIN) return 0; // full width
  return r.x + r.w / 2 < 0.5 ? 0 : 1;
}

interface Placed {
  id: string;
  ordinal: number;
  page: number;
  column: Column;
  y: number;
}

/** Anchored headings in ordinal order with their (page, column, y). */
function placed(sections: readonly SectionDto[]): Placed[] {
  const out: Placed[] = [];
  for (const s of [...sections].sort((a, b) => a.ordinal - b.ordinal)) {
    if (s.pdfPage === null) continue;
    const r = s.pdfRect && s.pdfRect.page === s.pdfPage ? s.pdfRect : null;
    out.push({ id: s.id, ordinal: s.ordinal, page: s.pdfPage, column: r ? columnOf(r) : 0, y: r ? r.y : 0 });
  }
  return out;
}

/** The current section for a viewport top (page, top fraction), or null before the first anchored heading. */
export function currentSectionAt(sections: readonly SectionDto[], pos: { page: number; top: number } | null): string | null {
  if (!pos) return null;
  const at = pos.page - 1 + pos.top;
  let current: string | null = null;
  let bestOrdinal = -Infinity;
  // L per page: τ of the last left / full-width heading met so far (ordinal order) on that page
  const lastLeft = new Map<number, number>();
  for (const h of placed(sections)) {
    let tau: number;
    if (h.column === 0) {
      tau = h.y;
      lastLeft.set(h.page, tau);
    } else {
      const l = lastLeft.get(h.page) ?? 0;
      tau = l + (1 - l) * h.y;
    }
    if (h.page - 1 + tau <= at && h.ordinal >= bestOrdinal) {
      bestOrdinal = h.ordinal;
      current = h.id;
    }
  }
  return current;
}

/** Whether the paper shows two columns: some anchored heading is in the right column (see the header, C3-R2-01). */
function isTwoColumn(hs: readonly Placed[]): boolean {
  return hs.some((h) => h.column === 1);
}

/** The column of a selection rect: its own column in a two-column paper, else the left column. */
function rectColumn(twoColumn: boolean, r: Pick<NormRect, 'x' | 'w'>): Column {
  return twoColumn ? columnOf(r) : 0;
}

/** The y of a selection rect in reading order: its vertical centre (see the header, C3-R3-01). */
function rectY(r: Pick<NormRect, 'y' | 'h'>): number {
  return r.y + r.h / 2;
}

/** The section of a selection: the last heading at or before its first rect in reading order (page, column, y). */
export function sectionAtRect(sections: readonly SectionDto[], rect: NormRect | null | undefined): string | null {
  if (!rect) return null;
  const hs = placed(sections);
  const col = rectColumn(isTwoColumn(hs), rect);
  const y = rectY(rect);
  let current: string | null = null;
  let bestOrdinal = -Infinity;
  for (const h of hs) {
    const before = h.page < rect.page || (h.page === rect.page && (h.column < col || (h.column === col && h.y <= y)));
    if (before && h.ordinal >= bestOrdinal) {
      bestOrdinal = h.ordinal;
      current = h.id;
    }
  }
  return current;
}

/**
 * sectionId for a note or a question on a selection: the section of its first rect in reading order (page, column, centre y —
 * the stored rects are sorted by y, so a selection running from the bottom of the left column into the right column
 * starts at its left rect; the column as in sectionAtRect). null for other kinds, without a structure or before the first heading.
 */
export function selectionSectionId(kind: string, sections: readonly SectionDto[] | undefined, anchor: Anchor): string | null {
  if ((kind !== 'note' && kind !== 'ask') || !sections) return null;
  const two = isTwoColumn(placed(sections));
  let first: NormRect | null = null;
  for (const r of anchor.rects) {
    if (!first) {
      first = r;
      continue;
    }
    const c = rectColumn(two, r);
    const cf = rectColumn(two, first);
    if (r.page < first.page || (r.page === first.page && (c < cf || (c === cf && rectY(r) < rectY(first))))) first = r;
  }
  return sectionAtRect(sections, first);
}

export const READING_STATES: readonly ReadingState[] = ['unread', 'skimmed', 'understood', 'reimplementable'];
export const READING_STATE_KO: Record<ReadingState, string> = { unread: '안 읽음', skimmed: '훑음', understood: '이해', reimplementable: '재구현 가능' };

/** The next state of the 4-step toggle (재구현 가능 → 안 읽음). */
export function nextReadingState(s: ReadingState): ReadingState {
  return READING_STATES[(READING_STATES.indexOf(s) + 1) % READING_STATES.length]!;
}

/** "이해 이상 n / 전체 m": sections understood or reimplementable, out of all sections. */
export function progressSummary(sections: readonly SectionDto[], states: ReadonlyMap<string, ReadingState>): { understood: number; total: number } {
  let understood = 0;
  for (const s of sections) {
    const st = states.get(s.id);
    if (st === 'understood' || st === 'reimplementable') understood++;
  }
  return { understood, total: sections.length };
}
