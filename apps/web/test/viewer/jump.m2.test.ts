// M2 navigator (BRIEF_C C2, C3): equation / section jumps from the server's pdfPage / pdfRect only — three results,
// the position stack push before a move (never for no_anchor), flashes kept inside the page and the column, and the
// store's behaviour without a registered navigator.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EquationDto, SectionDto, StructureResponse } from '@study-paper/shared/contracts/api';
import type { NormRect } from '@study-paper/shared/contracts/domain';
import { createNavigator, EQ_BAND_WIDTH, equationBand, FLASH_MS, type ViewerLike } from '../../src/viewer/jump';
import { useReaderStore } from '../../src/state/readerStore';

function makePage(n: number): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page';
  page.dataset.pageNumber = String(n);
  // a body reference "(1)" in the text layer: structure jumps must never search for it
  page.innerHTML = '<div class="textLayer"><span>see (1) and (2)</span><div class="endOfContent"></div></div>';
  document.body.appendChild(page);
  return page;
}
function fakeViewer(pages: HTMLElement[]) {
  const scrollPageIntoView = vi.fn<(o: { pageNumber: number }) => void>();
  const viewer: ViewerLike = { pagesCount: pages.length, scrollPageIntoView, getPageView: (i: number) => (pages[i] ? { div: pages[i]! } : undefined) };
  return Object.assign(viewer, { scrollPageIntoView });
}

const rect = (page: number, x: number, y: number, w: number, h: number): NormRect => ({ page, x, y, w, h });
const eq = (id: string, number: string | null, pdfPage: number | null, pdfRect: NormRect | null): EquationDto => ({
  id,
  sectionId: null,
  htmlId: null,
  number,
  ordinal: 1,
  latexRaw: 'x',
  latex: 'x',
  katexOk: true,
  pdfPage,
  pdfOffset: pdfPage ? 10 : null,
  pdfRect,
});
const sec = (id: string, number: string, pdfPage: number | null, pdfRect: NormRect | null): SectionDto => ({ id, parentId: null, htmlId: null, number, title: id, level: 1, ordinal: 1, pdfPage, pdfOffset: pdfPage ? 0 : null, pdfRect });

const STRUCTURE: StructureResponse = {
  structureSource: 'latexml',
  sections: [sec('s-located', 'II-A', 2, rect(2, 0.12, 0.2, 0.2, 0.02)), sec('s-page', 'II', 1, null), sec('s-none', 'II-B', null, null)],
  equations: [
    eq('e-located', '1', 1, rect(1, 0.45, 0.3, 0.05, 0.015)),
    eq('e-right', '2', 2, rect(2, 0.86, 0.5, 0.05, 0.015)),
    eq('e-page', '3', 2, null),
    eq('e-none', 'A.1', null, null),
    eq('e-out', '9', 7, rect(7, 0.5, 0.5, 0.1, 0.1)),
  ],
  figures: [],
  references: [],
};

beforeEach(() => {
  document.body.innerHTML = '';
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  useReaderStore.getState().registerNavigator(null);
});

function setup({ structure }: { structure: StructureResponse | undefined } = { structure: STRUCTURE }) {
  const pages = [makePage(1), makePage(2)];
  const viewer = fakeViewer(pages);
  const beforeJump = vi.fn();
  const nav = createNavigator({ getViewer: () => viewer, getStructure: () => structure, beforeJump });
  return { pages, viewer, beforeJump, nav };
}
const pct = (el: HTMLElement) => ['left', 'top', 'width', 'height'].map((k) => parseFloat(el.style[k as 'left']) / 100);

describe('jumpToEquation', () => {
  it('pdfRect → scroll to pdfPage, flash rd-eq-flash on that page, push first, located', async () => {
    const { pages, viewer, beforeJump, nav } = setup();
    await expect(nav.jumpToEquation('e-located')).resolves.toBe('located');
    expect(beforeJump).toHaveBeenCalledTimes(1);
    expect(beforeJump.mock.invocationCallOrder[0]!).toBeLessThan(viewer.scrollPageIntoView.mock.invocationCallOrder[0]!);
    expect(viewer.scrollPageIntoView).toHaveBeenCalledWith({ pageNumber: 1 });
    const flash = pages[0]!.querySelector<HTMLElement>('[data-testid="rd-eq-flash"]')!;
    expect(flash).not.toBeNull();
    expect(pages[1]!.querySelector('[data-testid="rd-eq-flash"]')).toBeNull();
    // the band contains the tag rect
    const [l, t, w, h] = pct(flash.querySelector<HTMLElement>('.sp-flash-part')!);
    expect(l!).toBeLessThanOrEqual(0.45);
    expect(l! + w!).toBeCloseTo(0.5, 6);
    expect(t!).toBeCloseTo(0.3, 6);
    expect(h!).toBeCloseTo(0.015, 6);
    expect(document.querySelectorAll('[data-testid="citation-flash"]')).toHaveLength(0);
  });

  it('pdfPage without rect → page_only (moved, pushed, no flash)', async () => {
    const { viewer, beforeJump, nav } = setup();
    await expect(nav.jumpToEquation('e-page')).resolves.toBe('page_only');
    expect(viewer.scrollPageIntoView).toHaveBeenCalledWith({ pageNumber: 2 });
    expect(beforeJump).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.sp-flash')).toBeNull();
  });

  it('no pdfPage (A.1), an unknown id, no structure, a page outside the PDF → no_anchor without moving or pushing', async () => {
    const { viewer, beforeJump, nav } = setup();
    for (const id of ['e-none', 'missing', 'e-out']) await expect(nav.jumpToEquation(id), id).resolves.toBe('no_anchor');
    const empty = setup({ structure: undefined }); // structure not loaded / no structure
    await expect(empty.nav.jumpToEquation('e-located')).resolves.toBe('no_anchor');
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled();
    expect(empty.viewer.scrollPageIntoView).not.toHaveBeenCalled();
    expect(beforeJump).not.toHaveBeenCalled();
    expect(document.querySelector('.sp-flash')).toBeNull();
  });

  it('never searches the text layer: the body reference "(1)" is not highlighted', async () => {
    const { pages, nav } = setup();
    await nav.jumpToEquation('e-located');
    const parts = pages[0]!.querySelectorAll('.sp-flash-part');
    expect(parts).toHaveLength(1);
    expect(pages[0]!.querySelector('.textLayer span')!.closest('.sp-flash')).toBeNull();
  });

  it('the flash disappears after 2 s', async () => {
    vi.useFakeTimers();
    const { pages, nav } = setup();
    await nav.jumpToEquation('e-located');
    expect(pages[0]!.querySelector('.sp-flash')).not.toBeNull();
    vi.advanceTimersByTime(FLASH_MS + 10);
    expect(pages[0]!.querySelector('.sp-flash')).toBeNull();
  });
});

describe('equationBand (flash inside the page and the column)', () => {
  const inPage = (r: NormRect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9;
  it('reaches left by up to one column width, never past the left edge', () => {
    const b = equationBand(rect(1, 0.3, 0.2, 0.05, 0.02));
    expect(b.x).toBe(0);
    expect(b.x + b.w).toBeCloseTo(0.35, 9);
    const c = equationBand(rect(1, 0.6, 0.2, 0.3, 0.02));
    expect(c.x).toBeCloseTo(0.5, 9); // right-column tag: never into the left column
    expect(inPage(b) && inPage(c)).toBe(true);
  });
  it('a right-column tag stays in the right half; the band is at most EQ_BAND_WIDTH (or the rect) wide', () => {
    const b = equationBand(rect(2, 0.86, 0.5, 0.05, 0.015));
    expect(b.x).toBeGreaterThanOrEqual(0.5);
    expect(b.w).toBeLessThanOrEqual(EQ_BAND_WIDTH + 1e-9);
  });
  it('a rect running off the page is cut to the page box', () => {
    for (const r of [rect(1, 0.95, 0.98, 0.2, 0.1), rect(1, -0.1, -0.1, 0.3, 0.3), rect(1, 0.5, 0.5, 0.6, 0.6)]) expect(inPage(equationBand(r))).toBe(true);
  });
});

describe('jumpToSection', () => {
  it('heading rect → rd-section-flash with that rect, located; page only; no anchor', async () => {
    const { pages, viewer, beforeJump, nav } = setup();
    await expect(nav.jumpToSection('s-located')).resolves.toBe('located');
    const part = pages[1]!.querySelector<HTMLElement>('[data-testid="rd-section-flash"] .sp-flash-part')!;
    expect(pct(part).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.12, 0.2, 0.2, 0.02]);
    await expect(nav.jumpToSection('s-page')).resolves.toBe('page_only');
    await expect(nav.jumpToSection('s-none')).resolves.toBe('no_anchor');
    expect(viewer.scrollPageIntoView.mock.calls).toEqual([[{ pageNumber: 2 }], [{ pageNumber: 1 }]]);
    expect(beforeJump).toHaveBeenCalledTimes(2);
  });
});

describe('jumpToPage / back / M1 jumps push the stack', () => {
  it('jumpToPage pushes and scrolls; an invalid page does nothing', () => {
    const { viewer, beforeJump, nav } = setup();
    nav.jumpToPage(2);
    nav.jumpToPage(0);
    nav.jumpToPage(3);
    expect(viewer.scrollPageIntoView.mock.calls).toEqual([[{ pageNumber: 2 }]]);
    expect(beforeJump).toHaveBeenCalledTimes(1);
  });
  it('jumpToAnchor and jumpToCitation push before they move; a citation without position does not', async () => {
    const { beforeJump, nav } = setup();
    nav.jumpToAnchor({ kind: 'area', rects: [rect(2, 0.1, 0.1, 0.2, 0.2)] });
    expect(beforeJump).toHaveBeenCalledTimes(1);
    await nav.jumpToCitation({ ordinal: 1, kind: 'quote', status: 'ambiguous', score: 0, quote: 'x', candidates: 2 });
    expect(beforeJump).toHaveBeenCalledTimes(1);
  });
  it('back() delegates to the stack owner; false without one', () => {
    const back = vi.fn(() => true);
    expect(createNavigator({ getViewer: () => null, back }).back()).toBe(true);
    expect(createNavigator({ getViewer: () => null }).back()).toBe(false);
  });
});

describe('store without a registered navigator (defaults for D)', () => {
  it('jumps resolve page_only, back() is false, jumpToPage is a no-op', async () => {
    useReaderStore.getState().registerNavigator(null);
    await expect(useReaderStore.getState().jumpToEquation('e-located')).resolves.toBe('page_only');
    await expect(useReaderStore.getState().jumpToSection('s-located')).resolves.toBe('page_only');
    expect(useReaderStore.getState().back()).toBe(false);
    expect(() => useReaderStore.getState().jumpToPage(1)).not.toThrow();
  });
  it('a navigator registered without a viewer yet: page_only for an anchored equation, no_anchor without a page', async () => {
    const nav = createNavigator({ getViewer: () => null, getStructure: () => STRUCTURE });
    await expect(nav.jumpToEquation('e-located')).resolves.toBe('page_only');
    await expect(nav.jumpToEquation('e-none')).resolves.toBe('no_anchor');
  });
});
