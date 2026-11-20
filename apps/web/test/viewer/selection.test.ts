// Selection → anchor (PLAN 5.3): quote exact + 32-char DOM prefix/suffix, one page only, NormRects of that page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateHighlightRequest } from '@study-paper/shared/contracts/api';
import { AnchorSchema } from '@study-paper/shared/contracts/domain';
import { head, mergeLineRects, selectionFromRange, tail } from '../../src/viewer/selection';

function makePage(n: number, lines: string[]): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page';
  page.dataset.pageNumber = String(n);
  page.innerHTML = `<div class="textLayer">${lines.map((l) => `<span>${l}</span><br>`).join('')}<div class="endOfContent"></div></div>`;
  page.getBoundingClientRect = () => ({ left: 0, top: 1000 * (n - 1), width: 600, height: 800, right: 600, bottom: 1000 * (n - 1) + 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
  document.body.appendChild(page);
  return page;
}
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });

let rects: ReturnType<typeof box>[] = [];
beforeEach(() => {
  document.body.innerHTML = '';
  rects = [box(60, 100, 200, 12), box(258, 100, 80, 12), box(60, 118, 150, 12)];
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => rects as unknown as DOMRectList);
});
afterEach(() => vi.restoreAllMocks());

const textOf = (page: HTMLElement, k: number) => page.querySelectorAll('span')[k]!.firstChild as Text;

describe('selectionFromRange', () => {
  it('builds exact + 32-char prefix/suffix from the text layer DOM and NormRects of the page', () => {
    const page = makePage(1, ['SYNTHETIC TEST PAPER - NOT A REAL PUBLICATION', 'We estimate the robot pose by minimizing the point-to-', 'point residual between consecutive scans.']);
    const r = document.createRange();
    r.setStart(textOf(page, 1), 3);
    r.setEnd(textOf(page, 2), 14);
    const s = selectionFromRange(r);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.page).toBe(1);
    expect(s.anchor.quote.exact).toBe('estimate the robot pose by minimizing the point-to-\npoint residual');
    expect(s.anchor.quote.prefix).toBe('PER - NOT A REAL PUBLICATION\nWe ');
    expect(s.anchor.quote.prefix).toHaveLength(32);
    expect(s.anchor.quote.suffix).toBe(' between consecutive scans.\n');
    expect(s.text).toBe('estimate the robot pose by minimizing the point-to- point residual');
    // same-line boxes merged: 2 lines → 2 rects, normalised to the 600×800 page
    expect(s.anchor.rects).toHaveLength(2);
    const r0 = s.anchor.rects[0]!;
    expect(r0.page).toBe(1);
    for (const [k, v] of [['x', 0.1], ['y', 0.125], ['w', (338 - 60) / 600], ['h', 12 / 800]] as const) expect(r0[k]).toBeCloseTo(v, 10);
    expect(AnchorSchema.safeParse(s.anchor).success).toBe(true);
    expect(CreateHighlightRequest.safeParse({ kind: 'text', color: 1, quote: s.anchor.quote, page: s.page, rects: s.anchor.rects }).success).toBe(true);
  });

  it('refuses a selection spanning two pages', () => {
    const p1 = makePage(1, ['last line of page one']);
    const p2 = makePage(2, ['first line of page two']);
    const r = document.createRange();
    r.setStart(textOf(p1, 0), 5);
    r.setEnd(textOf(p2, 0), 10);
    expect(selectionFromRange(r)).toEqual({ ok: false, reason: 'multi_page' });
  });

  it('empty and whitespace-only selections are ignored', () => {
    const page = makePage(1, ['a   b']);
    const r = document.createRange();
    r.setStart(textOf(page, 0), 1);
    r.setEnd(textOf(page, 0), 4);
    expect(selectionFromRange(r)).toEqual({ ok: false, reason: 'empty' });
    r.setEnd(textOf(page, 0), 1);
    expect(selectionFromRange(r)).toEqual({ ok: false, reason: 'empty' });
  });

  it('a selection outside any page is ignored', () => {
    const div = document.createElement('div');
    div.textContent = 'panel text';
    document.body.appendChild(div);
    const r = document.createRange();
    r.selectNodeContents(div);
    expect(selectionFromRange(r)).toEqual({ ok: false, reason: 'outside' });
  });

  it('page-sized and zero-size client boxes are dropped', () => {
    rects = [box(0, 0, 600, 800), box(10, 10, 0, 12), box(60, 100, 50, 12)];
    const page = makePage(1, ['hello world']);
    const r = document.createRange();
    r.setStart(textOf(page, 0), 0);
    r.setEnd(textOf(page, 0), 5);
    const s = selectionFromRange(r);
    expect(s.ok && s.anchor.rects).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('head / tail never split a surrogate pair', () => {
    expect(tail('ab😀', 1)).toBe('');
    expect(tail('ab😀', 2)).toBe('😀');
    expect(head('😀ab', 1)).toBe('');
    expect(head('😀ab', 3)).toBe('😀a');
  });
  it('mergeLineRects merges touching boxes of one line, keeps lines apart', () => {
    const out = mergeLineRects([
      { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.02 },
      { page: 1, x: 0.3, y: 0.1, w: 0.1, h: 0.02 },
      { page: 1, x: 0.1, y: 0.13, w: 0.2, h: 0.02 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.w).toBeCloseTo(0.3, 10);
  });
});
