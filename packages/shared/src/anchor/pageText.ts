// PageText builder (PLAN 5.3). Server (ingest) and web use the same function and the same pdfjs-dist version.
// Owner C.
import type { NormRect, PageText, PageTextItem } from '../contracts/domain';

/** Structural subset of a pdf.js TextItem. TextMarkedContent entries (no `str`) are skipped. */
export interface PdfTextItemLike {
  str: string;
  hasEOL: boolean;
  transform: number[];
  width: number;
  height: number;
}
/** Structural subset of a pdf.js PageViewport at scale 1 with no user rotation. */
export interface ViewportLike {
  width: number;
  height: number;
  /** pdf.js 6 PageViewport API (convertToViewportRectangle no longer exists). */
  convertToViewportPoint(x: number, y: number): number[];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function isTextItem(item: unknown): item is PdfTextItemLike {
  return typeof item === 'object' && item !== null && typeof (item as { str?: unknown }).str === 'string';
}

/**
 * text = items.map(i => i.str + (i.hasEOL ? '\n' : '')).join('').
 * Each item keeps its [start, start+len) range in `text` (len excludes the EOL newline) and a NormRect.
 */
export function buildPageText(page: number, rawItems: readonly unknown[], viewport: ViewportLike): PageText {
  let text = '';
  const items: PageTextItem[] = [];
  for (const raw of rawItems) {
    if (!isTextItem(raw)) continue;
    const start = text.length;
    text += raw.str;
    items.push({ start, len: raw.str.length, rect: itemRect(page, raw, viewport) });
    if (raw.hasEOL) text += '\n';
  }
  return { page, text, items };
}

export function itemRect(page: number, item: PdfTextItemLike, viewport: ViewportLike): NormRect {
  const x = item.transform[4] ?? 0;
  const y = item.transform[5] ?? 0;
  const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(x, y);
  const [x2 = 0, y2 = 0] = viewport.convertToViewportPoint(x + item.width, y + item.height);
  // Clamp the edges (not x and w separately) so x + w <= 1 and y + h <= 1 (NormRectSchema).
  const left = clamp01(Math.min(x1, x2) / viewport.width);
  const right = clamp01(Math.max(x1, x2) / viewport.width);
  const top = clamp01(Math.min(y1, y2) / viewport.height);
  const bottom = clamp01(Math.max(y1, y2) / viewport.height);
  return { page, x: left, y: top, w: right - left, h: bottom - top };
}

/** pdf.js getTextContent options used everywhere. disableNormalization keeps the raw glyph text so the
 * server text equals the browser text-layer DOM text (S0 spike 2); N1 handles ligatures/NFKC at match time. */
export const TEXT_CONTENT_OPTIONS = { disableNormalization: true, includeMarkedContent: false } as const;
