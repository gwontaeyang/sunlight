// Navigator (PLAN 5.3 web flow / 8.2 contract) against a fake pdf.js viewer in happy-dom.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Citation } from '@study-paper/shared/contracts/domain';
import { quoteEqualsN1 } from '@study-paper/shared/anchor/matchQuote';
import { createNavigator, FLASH_MS, type ViewerLike } from '../../src/viewer/jump';

const PAGE_TEXT = [
  ['SYNTHETIC TEST PAPER - NOT A REAL PUBLICATION'],
  ['We estimate the robot pose by minimizing the point-to-'],
  ['point residual between consecutive scans. The data asso-'],
  ['ciation uses a fixed threshold of 0.5 m and a robust kernel.'],
  ['The robust kernel down-weights outliers.'],
];
const TEXT = PAGE_TEXT.map((l) => l.join('') + '\n').join('');

function makePage(n: number, rendered = true): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page';
  page.dataset.pageNumber = String(n);
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  if (rendered) {
    layer.innerHTML = PAGE_TEXT.map((l) => l.map((t) => `<span>${t}</span>`).join('') + '<br>').join('') + '<div class="endOfContent"></div>';
  }
  page.appendChild(layer);
  page.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
  document.body.appendChild(page);
  return page;
}

function fakeViewer(pages: HTMLElement[]) {
  const scrollPageIntoView = vi.fn<(o: { pageNumber: number }) => void>();
  const viewer: ViewerLike = { pagesCount: pages.length, scrollPageIntoView, getPageView: (i: number) => (pages[i] ? { div: pages[i]! } : undefined) };
  return Object.assign(viewer, { scrollPageIntoView });
}

const citation = (c: Partial<Citation>): Citation => ({ ordinal: 1, kind: 'quote', status: 'verbatim', score: 1, quote: '', ...c }) as Citation;

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  document.body.innerHTML = '';
  // happy-dom has no layout: every Range gets one 100×12 box at (10, 20) of the page.
  rectsSpy = vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(
    () => [{ left: 10, top: 20, width: 100, height: 12, right: 110, bottom: 32, x: 10, y: 20, toJSON() {} }] as unknown as DOMRectList,
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  rectsSpy.mockRestore();
  vi.useRealTimers();
});

describe('jumpToCitation', () => {
  it('verbatim quote: scrolls to position.page, flashes the re-checked Range, resolves located', async () => {
    const pages = [makePage(1), makePage(2)];
    const viewer = fakeViewer(pages);
    const nav = createNavigator({ getViewer: () => viewer });
    const quote = 'The data association uses a fixed threshold of 0.5 m';
    const start = TEXT.indexOf('The data');
    await expect(nav.jumpToCitation(citation({ quote, position: { page: 2, start, end: start + 60 } }))).resolves.toBe('located');
    expect(viewer.scrollPageIntoView).toHaveBeenCalledWith({ pageNumber: 2 });
    const flash = pages[1]!.querySelector<HTMLElement>('[data-testid="citation-flash"]')!;
    expect(flash).not.toBeNull();
    expect(quoteEqualsN1(quote, flash.getAttribute('data-flash-text')!)).toBe(true);
    expect(flash.querySelectorAll('.sp-flash-part')).toHaveLength(1);
    expect((flash.firstElementChild as HTMLElement).style.left).toBe(`${(10 / 600) * 100}%`);
    expect(pages[0]!.querySelector('[data-testid="citation-flash"]')).toBeNull();
  });

  it('the flash is removed after 2 s', async () => {
    vi.useFakeTimers();
    const pages = [makePage(1)];
    const nav = createNavigator({ getViewer: () => fakeViewer(pages) });
    const p = nav.jumpToCitation(citation({ quote: 'The robust kernel down-weights outliers.', position: { page: 1, start: 0, end: 5 } }));
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe('located');
    expect(pages[0]!.querySelector('.sp-flash')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(FLASH_MS + 10);
    expect(pages[0]!.querySelector('.sp-flash')).toBeNull();
  });

  it('a repeated quote uses the server position.start to pick the occurrence', async () => {
    const pages = [makePage(1)];
    const nav = createNavigator({ getViewer: () => fakeViewer(pages) });
    const second = TEXT.lastIndexOf('robust kernel');
    await expect(nav.jumpToCitation(citation({ quote: 'robust kernel', position: { page: 1, start: second, end: second + 13 } }))).resolves.toBe('located');
  });

  it('ambiguous / not_found citations (no position) do not move the viewer', async () => {
    const pages = [makePage(1)];
    const viewer = fakeViewer(pages);
    const nav = createNavigator({ getViewer: () => viewer });
    await expect(nav.jumpToCitation(citation({ quote: 'robust kernel', status: 'ambiguous', score: 0, candidates: 3 }))).resolves.toBe('page_only');
    await expect(nav.jumpToCitation(citation({ quote: 'invented', status: 'not_found', score: 0 }))).resolves.toBe('page_only');
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled();
    expect(document.querySelector('.sp-flash')).toBeNull();
  });

  it('fuzzy citation: moves to the page, never flashes (re-check fails) → page_only', async () => {
    const pages = [makePage(1)];
    const viewer = fakeViewer(pages);
    const nav = createNavigator({ getViewer: () => viewer });
    const r = await nav.jumpToCitation(citation({ status: 'fuzzy', score: 0.9, quote: 'We estimate the robot pose by maximizing the point-to-point residual', position: { page: 1, start: 47, end: 117 } }));
    expect(r).toBe('page_only');
    expect(viewer.scrollPageIntoView).toHaveBeenCalledWith({ pageNumber: 1 });
    expect(document.querySelector('.sp-flash')).toBeNull();
  });

  it('a verbatim citation whose DOM text differs (re-check / search fails) → page_only without highlight', async () => {
    const pages = [makePage(1)];
    (pages[0]!.querySelector('span')!.firstChild as Text).data = 'SYNTHETIC TEST PAPER - NOT A REAL PUBLICATIOM';
    const nav = createNavigator({ getViewer: () => fakeViewer(pages) });
    await expect(nav.jumpToCitation(citation({ quote: 'SYNTHETIC TEST PAPER - NOT A REAL PUBLICATION', position: { page: 1, start: 0, end: 45 } }))).resolves.toBe('page_only');
    expect(document.querySelector('.sp-flash')).toBeNull();
  });

  it('waits for the text layer to finish rendering (endOfContent) before anchoring', async () => {
    const pages = [makePage(1, false)];
    const nav = createNavigator({ getViewer: () => fakeViewer(pages) });
    const p = nav.jumpToCitation(citation({ quote: 'The robust kernel down-weights outliers.', position: { page: 1, start: 0, end: 5 } }));
    await new Promise((r) => setTimeout(r, 120));
    pages[0]!.querySelector('.textLayer')!.innerHTML = PAGE_TEXT.map((l) => `<span>${l.join('')}</span><br>`).join('') + '<div class="endOfContent"></div>';
    await expect(p).resolves.toBe('located');
  });

  it('no registered viewer / page out of range → page_only', async () => {
    await expect(createNavigator({ getViewer: () => null }).jumpToCitation(citation({ quote: 'x', position: { page: 1, start: 0, end: 1 } }))).resolves.toBe('page_only');
    const nav = createNavigator({ getViewer: () => fakeViewer([makePage(1)]) });
    await expect(nav.jumpToCitation(citation({ quote: 'x', position: { page: 5, start: 0, end: 1 } }))).resolves.toBe('page_only');
  });
});

describe('jumpToAnchor', () => {
  it('scrolls to rects[0].page and flashes the stored rects', () => {
    const pages = [makePage(1), makePage(2)];
    const viewer = fakeViewer(pages);
    createNavigator({ getViewer: () => viewer }).jumpToAnchor({
      kind: 'text',
      quote: { exact: 'robust kernel' },
      rects: [
        { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.02 },
        { page: 2, x: 0.1, y: 0.23, w: 0.2, h: 0.02 },
      ],
    });
    expect(viewer.scrollPageIntoView).toHaveBeenCalledWith({ pageNumber: 2 });
    const parts = pages[1]!.querySelectorAll<HTMLElement>('.sp-flash-part');
    expect(parts).toHaveLength(2);
    expect(parts[0]!.style.top).toBe('20%');
  });
});
