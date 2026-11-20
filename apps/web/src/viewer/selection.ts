// Text selection → readerStore selection (PLAN 5.3: quote = exact + 32-char prefix/suffix from the text layer
// DOM, rects as NormRect of the selection's page; the web never computes offsets — the server does).
// M1 supports selections inside one page only (CreateHighlightRequest: every rect on `page`).
import type { Anchor, NormRect, TextQuoteSelector } from '@study-paper/shared/contracts/domain';
import { LIMITS } from '@study-paper/shared/contracts/api';
import { boxToNormRect } from './coords';
import { rangeOffsets, textLayerText } from './domAnchor';

export const CONTEXT_CHARS = 32;
export const MAX_RECTS = 500;

export type SelectionResult =
  | { ok: true; page: number; anchor: Anchor & { kind: 'text'; quote: TextQuoteSelector }; text: string }
  | { ok: false; reason: 'empty' | 'multi_page' | 'too_long' | 'outside' };

export const SELECTION_NOTICES: Record<Exclude<SelectionResult, { ok: true }>['reason'], string> = {
  empty: '',
  outside: '',
  multi_page: '한 페이지 안에서 선택하세요. 여러 페이지에 걸친 선택은 아직 지원하지 않습니다.',
  too_long: `선택이 너무 깁니다 (${LIMITS.selectionChars}자 이하).`,
};

/** The `.page` element (pdf.js page view) that contains a node, with its 1-based page number. */
export function pageOf(node: Node | null): { el: HTMLElement; page: number } | null {
  const el = (node?.nodeType === 1 ? (node as Element) : node?.parentElement)?.closest<HTMLElement>('.page[data-page-number]');
  if (!el) return null;
  const page = Number(el.dataset.pageNumber);
  return Number.isInteger(page) && page >= 1 ? { el, page } : null;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** Last `n` UTF-16 units of s without splitting a surrogate pair. */
export function tail(s: string, n: number): string {
  let out = s.slice(Math.max(0, s.length - n));
  if (out.length && isLow(out.charCodeAt(0))) out = out.slice(1);
  return out;
}
/** First `n` UTF-16 units of s without splitting a surrogate pair. */
export function head(s: string, n: number): string {
  let out = s.slice(0, n);
  if (out.length && isHigh(out.charCodeAt(out.length - 1))) out = out.slice(0, -1);
  return out;
}

/** Display text of a quote: PDF line breaks become spaces. */
export const displayText = (exact: string) => exact.replace(/[ \t]*\n[ \t]*/g, ' ').trim();

/**
 * Client boxes of the TEXT inside a Range (one sub-range per text node). Range.getClientRects() would also add
 * the border box of every fully selected span, which differs from the glyph box of partially selected text, so
 * full and partial selections would get different heights.
 */
export function textClientRects(range: Range): DOMRect[] {
  const root = range.commonAncestorContainer;
  if (root.nodeType === 3) return Array.from(range.getClientRects());
  const doc = range.startContainer.ownerDocument ?? document;
  const out: DOMRect[] = [];
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n) || n.parentElement?.closest('.PdfHighlighter__highlight-layer, .sp-overlay')) continue;
    const sub = doc.createRange();
    sub.selectNodeContents(n);
    if (n === range.startContainer) sub.setStart(n, range.startOffset);
    if (n === range.endContainer) sub.setEnd(n, range.endOffset);
    if (sub.collapsed) continue;
    out.push(...Array.from(sub.getClientRects()));
  }
  return out;
}

/** Text boxes of a Range on one page as NormRects (zero-size and page-sized boxes dropped, same line merged). */
export function rangeNormRects(range: Range, pageEl: Element, page: number): NormRect[] {
  const pageBox = pageEl.getBoundingClientRect();
  const out: NormRect[] = [];
  for (const r of textClientRects(range)) {
    if (r.width <= 0 || r.height <= 0 || r.width >= pageBox.width || r.height >= pageBox.height) continue;
    if (r.right <= pageBox.left || r.left >= pageBox.right || r.bottom <= pageBox.top || r.top >= pageBox.bottom) continue;
    out.push(boxToNormRect(r, pageBox, page));
  }
  return mergeLineRects(out);
}

/** Merges rects of the same line that touch or overlap (the text layer yields one box per span). */
export function mergeLineRects(rects: NormRect[]): NormRect[] {
  const sorted = [...rects].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const out: NormRect[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    const sameLine = prev && prev.page === r.page && Math.abs(prev.y + prev.h / 2 - (r.y + r.h / 2)) < Math.min(prev.h, r.h) / 2;
    if (prev && sameLine && r.x <= prev.x + prev.w + 0.01) {
      const x = Math.min(prev.x, r.x);
      const y = Math.min(prev.y, r.y);
      const right = Math.max(prev.x + prev.w, r.x + r.w);
      const bottom = Math.max(prev.y + prev.h, r.y + r.h);
      out[out.length - 1] = { page: r.page, x, y, w: right - x, h: bottom - y };
    } else out.push({ ...r });
  }
  return out;
}

/** Builds the reader selection from a DOM Range inside the pdf.js viewer. */
export function selectionFromRange(range: Range): SelectionResult {
  if (range.collapsed) return { ok: false, reason: 'empty' };
  const startPage = pageOf(range.startContainer);
  const endPage = pageOf(range.endContainer);
  if (!startPage || !endPage) return { ok: false, reason: 'outside' };
  if (startPage.page !== endPage.page) return { ok: false, reason: 'multi_page' };
  const textLayer = startPage.el.querySelector('.textLayer');
  if (!textLayer) return { ok: false, reason: 'outside' };
  const dpt = textLayerText(textLayer);
  const off = rangeOffsets(dpt, range);
  if (!off || off.end <= off.start) return { ok: false, reason: 'empty' };
  const exact = dpt.text.slice(off.start, off.end);
  if (!exact.trim()) return { ok: false, reason: 'empty' };
  if (exact.length > LIMITS.selectionChars) return { ok: false, reason: 'too_long' };
  const rects = rangeNormRects(range, startPage.el, startPage.page);
  if (!rects.length) return { ok: false, reason: 'empty' };
  if (rects.length > MAX_RECTS) return { ok: false, reason: 'too_long' };
  const prefix = tail(dpt.text.slice(0, off.start), CONTEXT_CHARS);
  const suffix = head(dpt.text.slice(off.end), CONTEXT_CHARS);
  const quote: TextQuoteSelector = { exact, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
  return { ok: true, page: startPage.page, anchor: { kind: 'text', quote, rects }, text: displayText(exact) };
}
