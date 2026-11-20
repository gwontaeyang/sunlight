// Coordinate conversions between DOM / pdf.js viewport pixels, the highlighter's "scaled" rects and NormRect
// (PLAN 5.3: 0..1 of the page's default viewport, origin top-left, 1-based page, zoom-independent).
// Every rect is converted with ITS OWN page box/viewport (review M11).
import type { NormRect } from '@study-paper/shared/contracts/domain';
import type { Scaled, ScaledPosition } from '../vendor/pdf-highlighter';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface BoxLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Edges → NormRect with clamped edges (x + w <= 1, y + h <= 1 as NormRectSchema requires). */
function fromEdges(page: number, l: number, t: number, r: number, b: number): NormRect {
  const x = clamp01(Math.min(l, r));
  const y = clamp01(Math.min(t, b));
  return { page, x, y, w: clamp01(Math.max(l, r)) - x, h: clamp01(Math.max(t, b)) - y };
}

/** Highlighter "scaled" rect (x1..y2 in a width×height frame of its own page) → NormRect. */
export function scaledToNormRect(r: Scaled, fallbackPage = 1): NormRect {
  const page = r.pageNumber || fallbackPage;
  return fromEdges(page, r.x1 / r.width, r.y1 / r.height, r.x2 / r.width, r.y2 / r.height);
}

/** All rects of a highlighter position (bounding rect when there are none), each with its own page. */
export function toNormRects(position: ScaledPosition): NormRect[] {
  const rects = position.rects.length ? position.rects : [position.boundingRect];
  return rects.map((r) => scaledToNormRect(r, position.boundingRect.pageNumber));
}

/** NormRect → highlighter "scaled" rect in a 1×1 frame (scaledToViewport multiplies by the page viewport). */
export function normRectToScaled(r: NormRect): Scaled {
  return { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h, width: 1, height: 1, pageNumber: r.page };
}

/** Bounding scaled rect of NormRects on the first rect's page. */
export function boundingScaled(rects: readonly NormRect[]): Scaled {
  const page = rects[0]?.page ?? 1;
  const on = rects.filter((r) => r.page === page);
  if (!on.length) return { x1: 0, y1: 0, x2: 0, y2: 0, width: 1, height: 1, pageNumber: page };
  return {
    x1: Math.min(...on.map((r) => r.x)),
    y1: Math.min(...on.map((r) => r.y)),
    x2: Math.max(...on.map((r) => r.x + r.w)),
    y2: Math.max(...on.map((r) => r.y + r.h)),
    width: 1,
    height: 1,
    pageNumber: page,
  };
}

/** A client (or viewport-pixel) rect inside a page box → NormRect of that page. */
export function boxToNormRect(rect: BoxLike, pageBox: BoxLike, page: number): NormRect {
  const l = (rect.left - pageBox.left) / pageBox.width;
  const t = (rect.top - pageBox.top) / pageBox.height;
  return fromEdges(page, l, t, l + rect.width / pageBox.width, t + rect.height / pageBox.height);
}

/** NormRect → pixel box relative to a page box of the given size (any zoom). */
export function normRectToBox(r: NormRect, pageSize: { width: number; height: number }): BoxLike {
  return { left: r.x * pageSize.width, top: r.y * pageSize.height, width: r.w * pageSize.width, height: r.h * pageSize.height };
}

/** CSS for an element positioned inside its page box (percentages: stays aligned at every zoom). */
export function normRectToCss(r: NormRect): { left: string; top: string; width: string; height: string } {
  const pct = (v: number) => `${v * 100}%`;
  return { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) };
}
