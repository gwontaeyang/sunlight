// DOM text of a pdf.js text layer and quote re-anchoring into a DOM Range (PLAN 5.3 web flow).
// The text layer text is built exactly like PageText.text: text nodes in document order, `<br>` = '\n'
// (pdf.js puts a <br> after every hasEOL item). The S0 parity gate (e2e/parity.spec.ts) checks it equals the
// server's page_texts. Overlay layers we add (highlights, flash) are skipped.
import { findExactHits, matchQuote, quoteEqualsN1 } from '@study-paper/shared/anchor/matchQuote';

/** Layers inside a text layer that are not PDF text. */
export const NON_TEXT_LAYER_CLASSES = ['PdfHighlighter__highlight-layer', 'sp-overlay'];

export interface DomSegment {
  /** Text node, or the <br> element for a '\n'. */
  node: Text | Element;
  /** [start, start + len) in DomPageText.text. */
  start: number;
  len: number;
}
export interface DomPageText {
  text: string;
  segments: DomSegment[];
}

const isSkipped = (el: Element) => NON_TEXT_LAYER_CLASSES.some((c) => el.classList?.contains(c));

/** Text of a text layer (text nodes + <br> as '\n'), with the node of every segment. */
export function textLayerText(textLayer: Element): DomPageText {
  let text = '';
  const segments: DomSegment[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const t = node as Text;
      if (t.data.length) {
        segments.push({ node: t, start: text.length, len: t.data.length });
        text += t.data;
      }
    } else if (node.nodeType === 1) {
      const el = node as Element;
      if (el.tagName === 'BR') {
        segments.push({ node: el, start: text.length, len: 1 });
        text += '\n';
      } else if (!isSkipped(el)) el.childNodes.forEach(walk);
    }
  };
  textLayer.childNodes.forEach(walk);
  return { text, segments };
}

/** Offset in DomPageText.text of a DOM boundary point (container, offset); null when outside the layer. */
export function offsetOfPoint(dpt: DomPageText, container: Node, offset: number): number | null {
  if (container.nodeType === 3) {
    const seg = dpt.segments.find((s) => s.node === container);
    if (seg) return seg.start + Math.min(offset, seg.len);
  }
  const doc = container.ownerDocument ?? document;
  const point = doc.createRange();
  try {
    point.setStart(container, offset);
  } catch {
    return null;
  }
  point.collapse(true);
  // First segment whose node starts at or after the point.
  for (const seg of dpt.segments) {
    if (point.comparePoint(seg.node, 0) >= 0) return seg.start;
    // A text node that contains the point partially is handled above; a node before the point is skipped.
  }
  return dpt.text.length;
}

/** [start, end) of a DOM Range in the text layer text (null when the range does not touch this layer). */
export function rangeOffsets(dpt: DomPageText, range: Range): { start: number; end: number } | null {
  const start = offsetOfPoint(dpt, range.startContainer, range.startOffset);
  const end = offsetOfPoint(dpt, range.endContainer, range.endOffset);
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

/** DOM Range for [start, end) of the text layer text. Boundaries on a <br> move to the nearest text node. */
export function rangeFromOffsets(dpt: DomPageText, start: number, end: number): Range | null {
  if (end <= start) return null;
  const texts = dpt.segments.filter((s) => s.node.nodeType === 3);
  const first = texts.find((s) => s.start + s.len > start);
  const last = [...texts].reverse().find((s) => s.start < end);
  if (!first || !last) return null;
  const doc = first.node.ownerDocument ?? document;
  const range = doc.createRange();
  range.setStart(first.node, Math.max(0, start - first.start));
  range.setEnd(last.node, Math.min(last.len, end - last.start));
  return range;
}

/** Text of a Range inside a text layer with <br> as '\n' (Range.toString() drops the line breaks). */
export function rangeTextWithBreaks(range: Range): string {
  const doc = range.startContainer.ownerDocument ?? document;
  const root = range.commonAncestorContainer;
  if (root.nodeType === 3) return range.toString();
  let out = '';
  const walker = doc.createTreeWalker(root, 1 | 4, {
    acceptNode: (n) => (n.nodeType === 1 && isSkipped(n as Element) ? 2 /* REJECT */ : 1 /* ACCEPT */),
  });
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    if (n.nodeType === 3) {
      const t = n as Text;
      const s = n === range.startContainer ? range.startOffset : 0;
      const e = n === range.endContainer ? range.endOffset : t.data.length;
      out += t.data.slice(s, e);
    } else if ((n as Element).tagName === 'BR' && n !== root) out += '\n';
  }
  return out;
}

/**
 * The PLAN 5.3 re-check: the Range text (with its line breaks) must equal the quote under the N1 matching rules
 * (line-end hyphens of the PDF may be kept or dropped; word boundaries count — review M1). Range.toString() is
 * not used: it drops the <br> line breaks and would glue the last word of a line to the first of the next.
 * Never true for a fuzzy match.
 */
export function rangeMatchesQuote(range: Range, quote: string): boolean {
  return quoteEqualsN1(quote, rangeTextWithBreaks(range));
}

export type AnchorResult = { status: 'located'; range: Range; start: number; end: number } | { status: 'page_only'; reason: 'not_found' | 'ambiguous' | 'fuzzy' | 'recheck_failed' | 'no_range' };

/**
 * Re-anchors `quote` in the text layer of `page` (pageOnly search). `hintStart` (the server's position.start)
 * picks one hit when the quote occurs several times on the page. Located only when the Range re-check passes.
 */
export function anchorQuoteInTextLayer(textLayer: Element, page: number, quote: string, hintStart?: number): AnchorResult {
  const dpt = textLayerText(textLayer);
  const pages = [{ page, text: dpt.text }];
  const m = matchQuote(pages, { exact: quote }, { pageHint: page, pageOnly: true });
  let pos: { start: number; end: number } | null = null;
  if (m.status === 'verbatim' && m.position) pos = m.position;
  else if (m.status === 'ambiguous' && hintStart !== undefined) {
    const hit = findExactHits(pages, { exact: quote }, { pageHint: page, pageOnly: true }).find((h) => h.start === hintStart);
    if (hit) pos = hit;
  } else if (m.status === 'fuzzy' && m.position) pos = m.position; // re-check below rejects it (never highlighted)
  if (!pos) return { status: 'page_only', reason: m.status === 'ambiguous' ? 'ambiguous' : 'not_found' };
  const range = rangeFromOffsets(dpt, pos.start, pos.end);
  if (!range) return { status: 'page_only', reason: 'no_range' };
  if (!rangeMatchesQuote(range, quote)) return { status: 'page_only', reason: m.status === 'fuzzy' ? 'fuzzy' : 'recheck_failed' };
  return { status: 'located', range, start: pos.start, end: pos.end };
}
