// Vendored TipContainer (C-I10-04 clamp, C-FX-01): a tip is moved up to end at the visible bottom of the viewer only
// while its selection / highlight overlaps the visible range. A tip that stays open while the user scrolls away
// (wheel scrolling does not close it) keeps following its selection on the next re-render — for example the
// papers.get cache update after a position PUT — instead of sticking to the visible bottom over another page.
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TipContainer } from '../../src/vendor/pdf-highlighter/components/TipContainer';
import { PdfHighlighterContext } from '../../src/vendor/pdf-highlighter/contexts/PdfHighlighterContext';

const TIP_H = 40;
const PAD = 5; // VERTICAL_PADDING of the vendored file
const PAGE_TOP = 3000; // page offsetTop in the scroll content
const VISIBLE_H = 900; // viewer.container.clientHeight

let restoreHeight: () => void = () => {};
beforeEach(() => {
  // happy-dom has no layout: give the tip container a height so the placement arithmetic is not degenerate
  const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('PdfHighlighter__tip-container') ? TIP_H : 0;
    },
  });
  restoreHeight = () => (d ? Object.defineProperty(HTMLElement.prototype, 'offsetHeight', d) : delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight);
});
afterEach(() => {
  cleanup();
  restoreHeight();
});

/** A tip for a selection box at page-relative `top` with `height`, in a viewer scrolled to `scrollTop`. */
function harness(box: { top: number; height: number }, scrollTop: number) {
  const pageNode = document.createElement('div');
  Object.defineProperty(pageNode, 'offsetTop', { value: PAGE_TOP });
  Object.defineProperty(pageNode, 'offsetLeft', { value: 0 });
  pageNode.getBoundingClientRect = () => ({ left: 0, width: 800, top: 0, height: 1100, right: 800, bottom: 1100, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const container = { scrollTop, clientHeight: VISIBLE_H };
  const viewer = { getPageView: () => ({ div: pageNode }), container };
  const tip = { position: { boundingRect: { top: box.top, left: 100, width: 200, height: box.height, pageNumber: 1 }, rects: [] }, content: React.createElement('div', null, 'popover') };
  const ctx = { getTip: () => tip } as never;
  const ref = { current: () => {} };
  const el = () => React.createElement(PdfHighlighterContext.Provider, { value: ctx }, React.createElement(TipContainer as never, { viewer, updateTipPositionRef: ref }));
  const r = render(el());
  const top = () => Number((r.container.querySelector('.PdfHighlighter__tip-container') as HTMLElement).style.top.replace('px', ''));
  return { container, top, rerender: () => r.rerender(el()) };
}

describe('TipContainer placement (vendored; C-I10-04 clamp only while the selection is on screen, C-FX-01)', () => {
  it('scrolled up after opening: the re-rendered tip stays at its highlight, below the visible range', () => {
    // highlight at content y 3400..3420, visible 3000..3900 → the tip sits above it
    const h = harness({ top: 400, height: 20 }, 3000);
    expect(h.top()).toBe(3400 - TIP_H - PAD);
    h.container.scrollTop = 1000; // wheel up two screens: visible 1000..1900, the highlight is below it
    h.rerender();
    expect(h.top()).toBe(3400 - TIP_H - PAD); // not 1900 - TIP_H - PAD (the visible bottom)
    expect(h.top()).toBeGreaterThan(1000 + VISIBLE_H);
  });

  it('scrolled down after opening: the tip goes below the highlight as upstream does (never clamped)', () => {
    const h = harness({ top: 400, height: 20 }, 3000);
    h.container.scrollTop = 5000; // the highlight (3400..3420) is above the visible range
    h.rerender();
    expect(h.top()).toBe(3420 + PAD);
  });

  it('a large area that spans the visible height keeps the clamp: the menu ends at the visible bottom', () => {
    // selection 3010..3890 inside visible 3000..3900: no room above, below would pass the visible bottom
    const h = harness({ top: 10, height: 880 }, 3000);
    expect(h.top()).toBe(3000 + VISIBLE_H - TIP_H - PAD);
  });

  it('a selection whose top is on screen and bottom below it is still on screen: clamped', () => {
    // visible 3000..3900, selection 3500..4500
    const h = harness({ top: 500, height: 1000 }, 3000);
    expect(h.top()).toBe(3500 - TIP_H - PAD); // room above: upstream placement, already inside
    h.container.scrollTop = 3480; // visible 3480..4380; no room above (3455 < 3480), below (4505) passes the bottom
    h.rerender();
    expect(h.top()).toBe(3480 + VISIBLE_H - TIP_H - PAD);
  });

  it('a highlight just below the visible bottom (tip partly inside) is off screen: not pulled up', () => {
    // visible 3000..3900, highlight 3905..3925: the tip above it (3860..3900 + padding) would cross the bottom
    const h = harness({ top: 905, height: 20 }, 3000);
    expect(h.top()).toBe(3905 - TIP_H - PAD);
  });
});
