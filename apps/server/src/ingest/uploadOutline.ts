// A PDF outline is navigation metadata. Estimated headings use layout only and make no claim about the paper's evidence.
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { PDFDocumentProxy, PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api';
import type { NormRect, PageText } from '@study-paper/shared/contracts/domain';
import { SUPPLEMENT_CAPS } from '@study-paper/shared/contracts/supplement';

type Viewport = ReturnType<PDFPageProxy['getViewport']>;
export interface UploadSection {
  title: string;
  number: string | null;
  level: number;
  parentIndex: number | null;
  pdfPage: number;
  pdfOffset: number;
  pdfRect: NormRect;
}
export type OutlineKind = 'bookmarks' | 'estimated' | 'none';
type Position = Pick<UploadSection, 'pdfPage' | 'pdfOffset' | 'pdfRect'>;
interface Line { text: string; offset: number; rect: NormRect; size: number; font: string; bold: boolean; isolated: boolean }
interface StoredLine extends Line { key: string }
interface PageLines { lines: StoredLine[]; viewport: Viewport }
const MAX_SECTIONS = SUPPLEMENT_CAPS.sections;
const MAX_LINES = 12_000;
const MAX_LINES_PER_PAGE = 600;
const MAX_OUTLINE_NODES = 1024;
const MAX_DEPTH = 24;
const MAX_TITLE = 180;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
/** Never retain controls, bidi overrides or a giant metadata/outline string in the UI. */
export function cleanPdfTitle(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max * 4).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max).trim() : '';
}
const keyOf = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
const numberPrefix = /^(\d+(?:\.\d+){0,5}|[IVX]{1,8}|[A-Z])(?:[.)]\s+|\s+(?=[^0-9]))(.+)$/u;
function splitTitle(text: string) {
  const m = numberPrefix.exec(text);
  if (!m || (m[1]!.length === 1 && /^[A-Z]$/.test(m[1]!) && !/^[A-Z][.)]\s/.test(text))) return { number: null, title: text };
  return { number: m[1]!, title: m[2]!.trim() };
}
function position(line: Line): Position {
  return { pdfPage: line.rect.page, pdfOffset: line.offset, pdfRect: line.rect };
}
function union(a: NormRect, b: NormRect): NormRect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { page: a.page, x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export class UploadLayout {
  readonly pages: PageLines[] = [];
  private readonly sizes = new Map<number, number>();
  private readonly fonts = new Map<string, number>();
  private lineCount = 0;

  async add(page: PageText, content: TextContent, viewport: Viewport, check: () => void): Promise<void> {
    const lines: StoredLine[] = [];
    this.pages.push({ viewport, lines });
    let current: Line | null = null;
    let last: NormRect | undefined;
    let index = 0;
    const flush = () => {
      if (!current) return;
      const line = current;
      current = null;
      const text = cleanPdfTitle(line.text, MAX_TITLE + 1);
      const isolated = !last || last.y >= line.rect.y || line.rect.y - (last.y + last.h) >= 0.45 * line.rect.h;
      last = line.rect;
      if (!text || text.length > MAX_TITLE || lines.length >= MAX_LINES_PER_PAGE || this.lineCount >= MAX_LINES) return;
      lines.push({ ...line, text, key: keyOf(text), isolated });
      this.lineCount++;
    };
    for (const item of content.items) {
      if (!('str' in item)) continue;
      if (index > 0 && index % 1024 === 0) { await yieldToLoop(); check(); }
      const stored = page.items[index++]!;
      const r = stored.rect;
      const str = item.str;
      if (str.trim() && r.w > 0 && r.h > 0) {
        const size = Math.round(item.height * 2) / 2;
        const weight = Math.min(str.length, 200);
        this.sizes.set(size, (this.sizes.get(size) ?? 0) + weight);
        this.fonts.set(item.fontName, (this.fonts.get(item.fontName) ?? 0) + weight);
        if (current && (Math.abs(r.y - current.rect.y) > Math.max(r.h, current.rect.h) * 0.65 || r.x - current.rect.x - current.rect.w > 0.10)) flush();
        if (!current) {
          const font = content.styles[item.fontName]?.fontFamily ?? '';
          current = { text: '', offset: stored.start, rect: r, size, font: item.fontName, bold: /bold|black|heavy|demi/i.test(font), isolated: false };
        }
        if (current.text.length <= MAX_TITLE) {
          const gap = r.x - current.rect.x - current.rect.w;
          current.text += (gap > 0.002 && current.text && !/\s$/.test(current.text) ? ' ' : '') + str.slice(0, MAX_TITLE + 1);
        }
        current.rect = union(current.rect, r);
      } else if (current && current.text.length <= MAX_TITLE) {
        current.text += str.slice(0, MAX_TITLE + 1);
      }
      if (item.hasEOL) flush();
    }
    flush();
  }

  async estimate(title: string, check: () => void): Promise<UploadSection[]> {
    const mostCommon = <T>(map: Map<T, number>): T | undefined => {
      let best: T | undefined, high = 0;
      for (const [key, count] of map) if (count > high) { high = count; best = key; }
      return best;
    };
    const body = mostCommon(this.sizes);
    if (!body || body <= 0) return [];
    const bodyFont = mostCommon(this.fonts);
    const documentTitle = keyOf(title);
    // A prominent cover title above a distinct heading should not swallow a page's only real heading.
    const firstNumbered = this.pages[0]?.lines.find(l => l.size >= body && splitTitle(l.text).number !== null);
    const repeated = new Set<string>();
    const margins = new Map<string, number>();
    let visited = 0;
    for (const { lines } of this.pages) for (const line of lines) {
      if (++visited % 512 === 0) { await yieldToLoop(); check(); }
      if (line.rect.y > 0.12 && line.rect.y < 0.88) continue;
      const key = line.key.replace(/\d+/g, '#');
      const page = margins.get(key);
      if (page !== undefined && page !== line.rect.page) repeated.add(key);
      margins.set(key, line.rect.page);
    }
    const sections: UploadSection[] = [];
    const parents: number[] = [];
    for (const { lines } of this.pages) for (const l of lines) {
      if (++visited % 512 === 0) { await yieldToLoop(); check(); }
      if (sections.length >= MAX_SECTIONS) return sections;
      const t = l.text;
      if (t.length > 140 || !/\p{L}/u.test(t) || /[.!?。！？;:]$/.test(t) || t.split(/\s+/u).length > 16) continue;
      if (/^(?:(?:fig(?:ure)?|tab(?:le)?|eq(?:uation)?|algorithm|scheme)\.?\s*\d|(?:그림|표|수식)\s*\d)/iu.test(t)) continue;
      const k = l.key;
      if (k === documentTitle || l.rect.y > 0.94 || l.rect.x > 0.84) continue;
      if ((l.rect.y <= 0.12 || l.rect.y >= 0.88) && repeated.has(k.replace(/\d+/g, '#'))) continue;
      const heading = splitTitle(t);
      // pdf.js often exposes an opaque face id even for bold fonts. A separate face from continuous body text
      // is a supporting weight cue only on a short isolated line. A whole paragraph in italics is insufficient.
      const emphasized = l.bold || l.font !== bodyFont;
      if (l.size < body * 0.96 || !(l.size >= body * 1.15 || (l.isolated && (emphasized || heading.number !== null)))) continue;
      if (!heading.number && !sections.length && l.rect.page === 1 && l.rect.y < 0.30 && l.size >= body * 1.7 &&
          firstNumbered && firstNumbered.rect.y > l.rect.y && l.size > firstNumbered.size) continue;
      const n = heading.number;
      const wanted = n ? (/^[A-Z]$/.test(n) && !/^[IVX]$/.test(n) ? 2 : n.split('.').length) : 1;
      const level = Math.min(wanted, parents.length + 1);
      sections.push({ ...heading, ...position(l), level, parentIndex: level > 1 ? parents[level - 2]! : null });
      parents.length = level - 1;
      parents.push(sections.length - 1);
    }
    return sections;
  }
}

type Outline = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>;
type OutlineNode = Outline[number];
async function bookmarkPosition(doc: PDFDocumentProxy, node: OutlineNode, layout: UploadLayout): Promise<Position | null> {
  const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest;
  if (!Array.isArray(dest) || !dest.length) return null;
  const ref: unknown = dest[0];
  let pageIndex: number;
  if (typeof ref === 'number') pageIndex = ref;
  else if (ref && typeof ref === 'object' && 'num' in ref && typeof ref.num === 'number' && 'gen' in ref && typeof ref.gen === 'number')
    pageIndex = await doc.getPageIndex({ num: ref.num, gen: ref.gen });
  else return null;
  if (!Number.isInteger(pageIndex) || !layout.pages[pageIndex]) return null;
  const { lines, viewport } = layout.pages[pageIndex]!;
  const viewType = dest[1]?.name;
  const top = viewType === 'XYZ' ? dest[3] : (viewType === 'FitH' || viewType === 'FitBH') ? dest[2] : viewType === 'FitR' ? dest[5] : null;
  const left = (viewType === 'XYZ' || viewType === 'FitR') ? dest[2] : null;
  const xy = Number.isFinite(top) ? viewport.convertToViewportPoint(Number.isFinite(left) ? left : viewport.viewBox[0]!, top) : null;
  const y = xy ? clamp(xy[1]! / viewport.height) : 0;
  const x = xy ? clamp(xy[0]! / viewport.width) : 0;
  let matched: Line | undefined, near: Line | undefined;
  const target = keyOf(cleanPdfTitle(node.title, MAX_TITLE));
  for (const line of lines) {
    if (line.key === target && (!matched || Math.abs(line.rect.y - y) < Math.abs(matched.rect.y - y))) matched = line;
    if (!near || Math.abs(line.rect.y - y) < Math.abs(near.rect.y - y)) near = line;
  }
  if (matched && (!xy || Math.abs(matched.rect.y - y) < 0.08)) return position(matched);
  if (xy && near && Math.abs(near.rect.y - y) <= 0.025 && (!Number.isFinite(left) || Math.abs(near.rect.x - x) <= 0.1))
    return position(near);
  const page = pageIndex + 1;
  // Some bookmarks point to the bottom/right edge or beyond it. Keep at least one visible destination pixel.
  const anchorX = Math.min(x, 1 - Math.min(1, 1 / viewport.width));
  const anchorY = Math.min(y, 1 - Math.min(1, 1 / viewport.height));
  return { pdfPage: page, pdfOffset: xy ? (near?.offset ?? 0) : 0,
    pdfRect: { page, x: anchorX, y: anchorY, w: Math.min(0.20, 1 - anchorX), h: Math.min(0.012, 1 - anchorY) } };
}

export async function uploadBookmarks(doc: PDFDocumentProxy, layout: UploadLayout, check: () => void): Promise<UploadSection[]> {
  const roots = await doc.getOutline();
  if (!Array.isArray(roots)) return [];
  const out: UploadSection[] = [];
  let visited = 0;
  async function walk(nodes: Outline, parentIndex: number | null, level: number): Promise<void> {
    for (const node of nodes) {
      if (++visited > MAX_OUTLINE_NODES || out.length >= MAX_SECTIONS) return;
      if (visited % 16 === 0) await yieldToLoop();
      check();
      const title = cleanPdfTitle(node.title, MAX_TITLE);
      // A bookmark folder may have no destination. Temporarily anchor it to page 1 and replace this with the first
      // valid child below; folders without any valid descendant do not become navigable rows.
      const hasChildren = level < MAX_DEPTH && Array.isArray(node.items) && node.items.length > 0;
      let pos: Position | null = null;
      if (title && !node.url && !node.unsafeUrl && node.dest != null) {
        try { pos = await bookmarkPosition(doc, node, layout); } catch { /* broken internal destination */ }
      }
      const folder = title && hasChildren && node.dest == null && !node.url && !node.unsafeUrl;
      if (!pos && !folder) {
        if (hasChildren) await walk(node.items, parentIndex, level + 1);
        continue;
      }
      const i = out.length;
      const placeholder: Position = { pdfPage: 1, pdfOffset: 0, pdfRect: { page: 1, x: 0, y: 0, w: 0, h: 0 } };
      out.push({ ...splitTitle(title), level: parentIndex === null ? 1 : out[parentIndex]!.level + 1, parentIndex, ...(pos ?? placeholder) });
      if (hasChildren) await walk(node.items, i, level + 1);
      if (!pos) {
        const child = out[i + 1];
        if (!child) out.pop();
        else { out[i]!.pdfPage = child.pdfPage; out[i]!.pdfOffset = child.pdfOffset; out[i]!.pdfRect = child.pdfRect; }
      }
    }
  }
  await walk(roots, null, 1);
  return out;
}
