// Citation / anchor jumps (PLAN 5.3 web flow, 8.2 C ↔ D contract). position is a hint, the quote decides:
// scroll to c.position.page → wait for the text layer → re-anchor the quote in the DOM (pageOnly) → re-check
// the Range text against the quote (N1) → 2 s flash and 'located', otherwise no highlight and 'page_only'.
// A citation without position (ambiguous / not_found) does not move the viewer.
// M2 (BRIEF_C C2, C3): equation / section jumps use ONLY the server's pdfPage / pdfRect (useStructure data) — the
// text layer is never searched for a short tag like "(4)" (the same page has body references to it). No pdfPage →
// 'no_anchor' without moving; pdfPage without rect → 'page_only'; with rect → flash + 'located'. Every jump that
// moves the viewer calls beforeJump() first (position stack push, restore gate).
import type { StructureResponse } from '@study-paper/shared/contracts/api';
import type { Anchor, Citation, JumpResult, NormRect } from '@study-paper/shared/contracts/domain';
import { equationById, sectionById } from '../api/structure';
import type { ReaderNavigator } from '../state/readerStore';
import { normRectToCss } from './coords';
import { anchorQuoteInTextLayer, rangeTextWithBreaks } from './domAnchor';
import { rangeNormRects } from './selection';

export const FLASH_MS = 2000;
export const TEXT_LAYER_TIMEOUT_MS = 8000;

/** Minimal surface of pdf.js PDFViewer used here. */
export interface ViewerLike {
  pagesCount: number;
  scrollPageIntoView(o: { pageNumber: number }): void;
  getPageView(index: number): { div: HTMLElement } | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function pageDiv(viewer: ViewerLike, page: number): HTMLElement | null {
  return viewer.getPageView(page - 1)?.div ?? null;
}

/** Resolves with the text layer of `page` once pdf.js finished rendering it (endOfContent appended). */
export async function waitForTextLayer(viewer: ViewerLike, page: number, timeoutMs = TEXT_LAYER_TIMEOUT_MS): Promise<Element | null> {
  const t0 = Date.now();
  for (;;) {
    const layer = pageDiv(viewer, page)?.querySelector('.textLayer');
    if (layer?.querySelector('.endOfContent')) return layer;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(50);
  }
}

export type FlashTestId = 'citation-flash' | 'rd-eq-flash' | 'rd-section-flash';

/** Draws a temporary overlay of NormRects on a page (removed after FLASH_MS). Returns the overlay element. */
export function flashRects(pageEl: HTMLElement, rects: readonly NormRect[], text: string, ms = FLASH_MS, testId: FlashTestId = 'citation-flash'): HTMLElement {
  pageEl.querySelectorAll(':scope > .sp-flash').forEach((e) => e.remove());
  const overlay = pageEl.ownerDocument.createElement('div');
  overlay.className = 'sp-overlay sp-flash';
  overlay.setAttribute('data-testid', testId);
  overlay.setAttribute('data-flash-text', text);
  for (const r of rects) {
    const part = pageEl.ownerDocument.createElement('div');
    part.className = 'sp-flash-part';
    Object.assign(part.style, normRectToCss(r));
    overlay.appendChild(part);
  }
  pageEl.appendChild(overlay);
  setTimeout(() => overlay.remove(), ms);
  return overlay;
}

function scrollIntoViewCentered(el: Element | null | undefined) {
  if (el && typeof (el as HTMLElement).scrollIntoView === 'function') (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A NormRect cut to the page box (x + w ≤ 1, y + h ≤ 1). */
export function clampToPage(r: NormRect): NormRect {
  const x = clamp01(r.x);
  const y = clamp01(r.y);
  return { page: r.page, x, y, w: clamp01(r.x + r.w) - x, h: clamp01(r.y + r.h) - y };
}

/** Width of the equation flash band (page fraction): about one column of a two-column paper. */
export const EQ_BAND_WIDTH = 0.42;
/**
 * Flash band of an equation: pdfRect is the text item that holds the tag "(n)" (at the right end of the line), so the
 * band reaches left by up to one column width — never past the page's left edge, and for a tag in the right half
 * never into the left half (the other column).
 */
export function equationBand(rect: NormRect): NormRect {
  const r = clampToPage(rect);
  const right = r.x + r.w;
  const columnStart = r.x >= 0.5 ? 0.5 : 0;
  const left = Math.max(columnStart, Math.min(r.x, right - EQ_BAND_WIDTH));
  return { page: r.page, x: left, y: r.y, w: right - left, h: r.h };
}

export interface NavigatorDeps {
  getViewer(): ViewerLike | null;
  /** papers.structure of the open paper (useStructure data); undefined while it loads or without structure. */
  getStructure?(): StructureResponse | undefined;
  /** Called right before a jump moves the viewer: push the position stack, mark the restore gate. */
  beforeJump?(): void;
  /** Pops the position stack and moves there; false when it is empty. */
  back?(): boolean;
}

export function createNavigator({ getViewer, getStructure, beforeJump, back }: NavigatorDeps): ReaderNavigator {
  const moving = () => beforeJump?.();

  /** Structure jump (equation / section): server page + optional server rect. */
  function structureJump(page: number | null, rect: NormRect | null, testId: FlashTestId, band: (r: NormRect) => NormRect): JumpResult {
    if (page === null) return 'no_anchor';
    const viewer = getViewer();
    if (!viewer) return 'page_only';
    if (page < 1 || page > viewer.pagesCount) return 'no_anchor';
    moving();
    viewer.scrollPageIntoView({ pageNumber: page });
    const pageEl = pageDiv(viewer, page);
    if (!rect || rect.page !== page || !pageEl) return 'page_only';
    const overlay = flashRects(pageEl, [band(rect)], '', FLASH_MS, testId);
    scrollIntoViewCentered(overlay.firstElementChild);
    return 'located';
  }

  async function locateQuote(page: number, quote: string, hintStart?: number): Promise<'located' | 'page_only'> {
    const viewer = getViewer();
    if (!viewer || page < 1 || page > viewer.pagesCount) return 'page_only';
    moving();
    viewer.scrollPageIntoView({ pageNumber: page });
    const layer = await waitForTextLayer(viewer, page);
    const pageEl = pageDiv(viewer, page);
    if (!layer || !pageEl) return 'page_only';
    const r = anchorQuoteInTextLayer(layer, page, quote, hintStart);
    if (r.status !== 'located') return 'page_only';
    const rects = rangeNormRects(r.range, pageEl, page);
    if (!rects.length) return 'page_only';
    const overlay = flashRects(pageEl, rects, rangeTextWithBreaks(r.range));
    scrollIntoViewCentered(overlay.firstElementChild);
    return 'located';
  }

  return {
    async jumpToCitation(c: Citation) {
      if (c.kind !== 'quote' || !c.quote || !c.position) return 'page_only';
      return locateQuote(c.position.page, c.quote, c.position.start);
    },
    jumpToAnchor(a: Anchor) {
      const viewer = getViewer();
      if (!viewer) return;
      const page = a.rects[0]?.page ?? a.position?.page;
      if (!page || page > viewer.pagesCount) return;
      if (!a.rects.length) {
        if (a.quote) void locateQuote(page, a.quote.exact, a.position?.start);
        return;
      }
      moving();
      viewer.scrollPageIntoView({ pageNumber: page });
      const pageEl = pageDiv(viewer, page);
      if (!pageEl) return;
      const overlay = flashRects(pageEl, a.rects.filter((r) => r.page === page), a.quote?.exact ?? '');
      scrollIntoViewCentered(overlay.firstElementChild);
    },
    async jumpToEquation(id: string) {
      const eq = equationById(getStructure?.(), id);
      if (!eq) return 'no_anchor';
      return structureJump(eq.pdfPage, eq.pdfRect, 'rd-eq-flash', equationBand);
    },
    async jumpToSection(id: string) {
      const s = sectionById(getStructure?.(), id);
      if (!s) return 'no_anchor';
      return structureJump(s.pdfPage, s.pdfRect, 'rd-section-flash', clampToPage);
    },
    jumpToPage(page: number) {
      const viewer = getViewer();
      if (!viewer || !Number.isInteger(page) || page < 1 || page > viewer.pagesCount) return;
      moving();
      viewer.scrollPageIntoView({ pageNumber: page });
    },
    back: () => back?.() ?? false,
  };
}
