import { describe, expect, it } from 'vitest';
import { PageTextItemSchema, PageTextSchema } from '../src/contracts/domain';
import { buildPageText, isTextItem, itemRect, type ViewportLike } from '../src/anchor/pageText';

/** pdf.js-like default viewport at scale 1: PDF user space (origin bottom-left) → top-left origin. */
const viewport = (w = 612, h = 792): ViewportLike => ({ width: w, height: h, convertToViewportPoint: (x, y) => [x, h - y] });
const item = (str: string, x: number, y: number, width: number, height = 11, hasEOL = false) => ({ str, hasEOL, transform: [height, 0, 0, height, x, y], width, height });

describe('buildPageText', () => {
  it('joins item strings with a newline only after hasEOL items and records [start, len) per item', () => {
    const pt = buildPageText(3, [item('We estimate the', 72, 700, 90), item(' pose', 162, 700, 25, 11, true), item('next line', 72, 682, 50, 11, true)], viewport());
    expect(pt.page).toBe(3);
    expect(pt.text).toBe('We estimate the pose\nnext line\n');
    expect(pt.items.map((i) => [i.start, i.len])).toEqual([
      [0, 15],
      [15, 5],
      [21, 9],
    ]);
    for (const [k, s] of ['We estimate the', ' pose', 'next line'].entries()) expect(pt.text.slice(pt.items[k]!.start, pt.items[k]!.start + pt.items[k]!.len)).toBe(s);
    expect(PageTextSchema.safeParse(pt).success).toBe(true);
  });
  it('skips marked-content entries (no str) without shifting offsets', () => {
    const pt = buildPageText(1, [{ type: 'beginMarkedContent' }, item('a', 0, 0, 5), { type: 'endMarkedContent' }, item('b', 5, 0, 5)], viewport());
    expect(pt.text).toBe('ab');
    expect(pt.items).toHaveLength(2);
    expect(pt.items[1]!.start).toBe(1);
  });
  it('keeps UTF-16 offsets for surrogate pairs and ligature glyphs (raw text, disableNormalization)', () => {
    const pt = buildPageText(1, [item('𝐱ﬁ', 0, 700, 10), item('é', 10, 700, 5)], viewport());
    expect(pt.text).toBe('𝐱ﬁé');
    expect(pt.items.map((i) => [i.start, i.len])).toEqual([
      [0, 3],
      [3, 1],
    ]);
  });
  it('isTextItem accepts only objects with a string str', () => {
    expect(isTextItem(item('x', 0, 0, 1))).toBe(true);
    expect(isTextItem({ type: 'beginMarkedContent' })).toBe(false);
    expect(isTextItem(null)).toBe(false);
  });
});

describe('itemRect', () => {
  it('normalises to 0..1 of the viewport with a top-left origin, 1-based page kept', () => {
    const r = itemRect(2, item('x', 72, 700, 61.2, 11), viewport());
    expect(r.page).toBe(2);
    expect(r.x).toBeCloseTo(72 / 612, 10);
    expect(r.w).toBeCloseTo(61.2 / 612, 10);
    expect(r.y).toBeCloseTo((792 - 711) / 792, 10); // top edge = baseline + height
    expect(r.h).toBeCloseTo(11 / 792, 10);
  });
  it('is independent of the viewport scale', () => {
    const s = 2.5;
    const scaled: ViewportLike = { width: 612 * s, height: 792 * s, convertToViewportPoint: (x, y) => [x * s, (792 - y) * s] };
    expect(itemRect(1, item('x', 100, 300, 40), scaled)).toEqual(itemRect(1, item('x', 100, 300, 40), viewport()));
  });
  it('clamps items that stick out of the page', () => {
    const r = itemRect(1, item('x', -10, 790, 700, 20), viewport());
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.w).toBe(1);
  });
  it('an item crossing the right/bottom edge stays inside the page (x + w <= 1, schema-valid)', () => {
    const r = itemRect(1, item('x', 600, -5, 50, 11), viewport());
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
    expect(r.x).toBeCloseTo(600 / 612, 10);
    expect(PageTextItemSchema.safeParse({ start: 0, len: 1, rect: r }).success).toBe(true);
  });
});
