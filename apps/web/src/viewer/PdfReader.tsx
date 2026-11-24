// PDF viewer on the vendored highlighter + pdf.js 6.5.438. Owner C.
// M1: render (pdf.js renders only visible pages), text selection → readerStore.selection, selection toolbar,
// shortcuts, stored highlights (draw, recolor, delete), zoom, citation / anchor jumps through the readerStore navigator.
// M2 (BRIEF_C): area capture (Ctrl+drag → capture menu, AreaCapture.ts), equation / section / page jumps, the position
// stack ("뒤로", Alt+←), PDF links (links.ts: citation numbers → references panel, internal → stack + pdf.js, external
// → confirm), the full selection toolbar (설명 / 번역 / 하이라이트 / 질문 / 노트 / 용어집) and shortcuts, position
// restore and save (position.ts), the current section for the outline, focus carry-over (a pointerdown on the PDF
// blurs a panel input so the shortcuts work again).
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useLocation, useSearch } from 'wouter';
import { useSelectionQuestions } from '../review/SelectionQuestions';
import type { HighlightDto, LastPositionDto, PaperDetailDto, StructureResponse } from '@study-paper/shared/contracts/api';
import type { NormRect, ReaderActionKind } from '@study-paper/shared/contracts/domain';
import type { CaptureSize } from '@study-paper/shared/image/capture';
import { api, pdfSource } from '../api/client';
import { qk } from '../api/queryKeys';
import { useStructure } from '../api/structure';
import { isE2e } from '../api/token';
import { AI_UNSUPPORTED } from '../library/readiness';
import { useReaderStore } from '../state/readerStore';
import { PdfHighlighter, PdfLoader, useHighlightContainerContext } from '../vendor/pdf-highlighter';
import type { PdfHighlighterUtils, PdfSelection, ViewportHighlight } from '../vendor/pdf-highlighter';
import { CAPTURE_ERROR_TEXT, CAPTURE_SMALL_PX, CaptureError, captureArea, captureSizeFor } from './AreaCapture';
import { normRectToCss, scaledToNormRect } from './coords';
import { COLOR_VALUES, HIGHLIGHT_COLORS, readLastColor, toViewerHighlight, useHighlightMutations, useHighlights, writeLastColor, type ViewerHighlight } from './highlights';
import { createNavigator } from './jump';
import { handleLinkClick, openExternal } from './links';
import { cardPreviewEnabled, FloatingCardHost, type FloatingCardRequest } from './FloatingCard';
import { ReaderBarSlot } from './ReaderChrome';
import { createPositionSaver, createPositionSlots, initialScale, POSITION_PUT_TIMEOUT_MS, readViewerPosition, restoreTarget, RestoreGate, scrollToViewerPosition, ZOOM_MAX, ZOOM_MIN, type PositionViewerLike } from './position';
import { PositionStack, type StackPosition } from './positionStack';
import { currentSectionAt, selectionSectionId } from './sections';
import { SELECTION_NOTICES, selectionFromRange } from './selection';
import { isEditable, useReaderShortcuts, type HighlightColorValue, type ReaderShortcutAction } from './shortcuts';
import { Icon } from '../ui/icons';
import './reader.css';

/**
 * The position save state of each paper, shared by the readers of that paper in this tab: PUTs go one at a time in
 * order, also across reader mounts, and a reader opened again starts from the newest place still being saved (m-M2-1,
 * C2-R1-01).
 */
const positionSlots = createPositionSlots();
const NOTICE_CONTEXT_NOT_READY = '색인 준비 중입니다. 설명은 준비가 끝난 뒤 쓸 수 있습니다.';
const NOTICE_NOT_READABLE = 'PDF 본문을 아직 읽을 수 없습니다.';
/** Current-section updates while scrolling (BRIEF_C C7). */
export const SECTION_THROTTLE_MS = 200;

/** Selection-toolbar actions published to the panels (D). */
type SelectionActionKind = Extract<ReaderActionKind, 'explain' | 'translate' | 'ask' | 'glossary' | 'note'>;
/** What each action needs: translate → readable; explain / ask / glossary → the AI context; note → nothing. */
export const ACTION_NEEDS: Record<SelectionActionKind, 'readable' | 'context' | 'none'> = { explain: 'context', ask: 'context', glossary: 'context', translate: 'readable', note: 'none' };

/** A finished Ctrl+drag selection waiting for the capture menu. */
interface PendingArea {
  rect: NormRect;
  size: CaptureSize;
}

interface ReaderUi {
  highlights: readonly HighlightDto[];
  busy: boolean;
  area: PendingArea | null;
  captureBusy: boolean;
  explain(): void;
  makeQuestions(): void;
  act(kind: SelectionActionKind): void;
  highlight(color: HighlightColorValue | 'last'): void;
  capture(what: 'figure' | 'equation' | 'highlight'): void;
  recolor(id: string, color: HighlightColorValue): void;
  remove(id: string): void;
}
const ReaderUiContext = createContext<ReaderUi | null>(null);
const useReaderUi = () => {
  const ui = useContext(ReaderUiContext);
  if (!ui) throw new Error('ReaderUiContext missing');
  return ui;
};

/** Exposes viewer internals to Playwright only (parity.spec.ts, reader.spec.ts): the page has <meta name="sp-e2e">. */
function exposeForE2e(key: '__spViewer' | '__spReader', value: unknown) {
  if (isE2e()) (window as unknown as Record<string, unknown>)[key] = value;
}

export function PdfReader({ paperId, initialPosition = null }: { paperId: string; initialPosition?: LastPositionDto | null }) {
  const source = useMemo(() => pdfSource(paperId), [paperId]);
  // The stored position of the first papers.get only (later polls never move the reader).
  const [initial] = useState(initialPosition);
  return (
    <div className="absolute inset-0" data-testid="pdf-reader">
      <PdfLoader
        document={source}
        workerSrc={workerSrc}
        onError={(e) => console.error('[PdfReader] PDF load failed:', e.message)}
        errorMessage={(e) => (
          <div role="alert" className="p-4 text-sm text-red-700" data-testid="pdf-error">
            PDF를 불러오지 못했습니다: {e.message}
          </div>
        )}
        beforeLoad={(p) => <div className="p-4 text-sl-ui text-sl-muted">PDF 불러오는 중… {p.total ? `${Math.floor((p.loaded / p.total) * 100)}%` : ''}</div>}
      >
        {(pdfDocument) => <ReaderViewer key={paperId} paperId={paperId} pdfDocument={pdfDocument} initialPosition={initial} />}
      </PdfLoader>
    </div>
  );
}

/**
 * pdf.js sizes every text-layer span (--scale-x) from a width measured on a hidden canvas whose `lang` is the
 * PDF's language or "" — while the span inherits `lang` from the page (<html lang="ko">). Chrome resolves the
 * generic font (`sans-serif`, `serif`) per language, so the span was drawn in another font than the one measured
 * and came out 4–8 % too wide: selection, highlight and citation-flash rects ran past the glyphs, into the next
 * column of a two-column paper. Giving the viewer element the same language as the canvas ("" unless pdf.js sets
 * the PDF's /Lang there itself) makes the measured and the drawn font the same. Only `.pdfViewer` gets it: the
 * Korean UI around it (toolbar, tips) keeps `ko`.
 */
export function matchTextLayerLang(viewerEl: Element | null | undefined) {
  if (viewerEl && !viewerEl.hasAttribute('lang')) viewerEl.setAttribute('lang', '');
}

/** pdf.js PDFViewer as used by the reader (positions + its event bus). */
type ReaderPdfViewer = PositionViewerLike & {
  currentScaleValue: string;
  currentPageNumber: number;
  scrollPageIntoView(o: { pageNumber: number }): void;
  eventBus: { on(name: string, fn: (...a: unknown[]) => void): void; off(name: string, fn: (...a: unknown[]) => void): void };
};

function ReaderViewer({ paperId, pdfDocument, initialPosition }: { paperId: string; pdfDocument: PDFDocumentProxy; initialPosition: LastPositionDto | null }) {
  const utilsRef = useRef<PdfHighlighterUtils | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // M3a: the floating card host (sibling of the PDF scroll container) and its preview switch (?sl-card=fixed).
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const setFrame = useCallback((el: HTMLDivElement | null) => {
    frameRef.current = el;
    setFrameEl(el);
  }, []);
  const [cardPreview] = useState(() => cardPreviewEnabled());
  const [cardReq, setCardReq] = useState<FloatingCardRequest | null>(null);
  const cardSeq = useRef(0);
  useEffect(() => {
    const el = frameRef.current?.querySelector('.pdfViewer');
    if (!el) return;
    matchTextLayerLang(el);
    // PDFViewer.setDocument() removes `lang` again (and may set the PDF's own): re-apply whenever it is removed.
    const mo = new MutationObserver(() => matchTextLayerLang(el));
    mo.observe(el, { attributes: true, attributeFilter: ['lang'] });
    return () => mo.disconnect();
  }, []);
  const setSelection = useReaderStore((s) => s.setSelection);
  const requestAction = useReaderStore((s) => s.requestAction);
  const registerNavigator = useReaderStore((s) => s.registerNavigator);
  const setCanGoBack = useReaderStore((s) => s.setCanGoBack);
  const qc = useQueryClient();
  const [location] = useLocation();
  const sourceHighlight = new URLSearchParams(useSearch()).get('highlight');
  const jumpedHighlight = useRef<string | null>(null);
  const questions = useSelectionQuestions(paperId);
  const openQuestions = questions.open;
  const [notice, setNotice] = useState<string | null>(null);
  // The place to restore: the stored one (papers.get), or the newest one still being saved by a reader of this paper
  // that was just left (its PUT has not settled, so the cached papers.get does not carry it yet — C2-R1-01).
  const [startPosition] = useState(() => positionSlots.get(paperId).restoreBase(initialPosition));
  const [scale, setScale] = useState<number | 'page-width'>(() => initialScale(startPosition));
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const [area, setArea] = useState<PendingArea | null>(null);
  const areaRef = useRef(area);
  areaRef.current = area;
  const [captureBusy, setCaptureBusy] = useState(false);
  const [external, setExternal] = useState<{ url: string; host: string } | null>(null);
  const highlightsQ = useHighlights(paperId);
  const { create, patch, remove } = useHighlightMutations(paperId);
  const dtos = useMemo(() => highlightsQ.data?.highlights ?? [], [highlightsQ.data]);
  const viewerHighlights = useMemo(() => dtos.map(toViewerHighlight), [dtos]);
  const structureQ = useStructure(paperId);
  const structureRef = useRef<StructureResponse | undefined>(undefined);
  structureRef.current = structureQ.data;

  // The pdf.js viewer once the vendored highlighter created it (published outside render, see utilsCallback).
  const [viewer, setViewer] = useState<ReaderPdfViewer | null>(null);
  // M3a: the page shown in the top bar ("3 / 8") and the page-number box.
  const [pageNo, setPageNo] = useState(1);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const barSlot = useContext(ReaderBarSlot);
  const viewerSeen = useRef<unknown>(null);
  const getViewer = useCallback(() => (utilsRef.current?.getViewer() as unknown as ReaderPdfViewer | null) ?? null, []);

  // Position stack ("뒤로") and the restore gate (a jump before the restore wins).
  const stack = useMemo(() => new PositionStack((b) => setCanGoBack(b)), [setCanGoBack]);
  const gate = useMemo(() => new RestoreGate(), []);
  useEffect(() => () => setCanGoBack(false), [setCanGoBack]);

  const applyPosition = useCallback(
    (p: StackPosition) => {
      const v = getViewer();
      if (!v) return;
      if (Math.abs(p.zoom - v.currentScale) > 1e-3) {
        const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, p.zoom));
        setScale(z);
        v.currentScaleValue = String(z);
      }
      scrollToViewerPosition(v, p);
      // pdf.js may lay the pages out again after a zoom change: apply once more on the next frame.
      requestAnimationFrame(() => scrollToViewerPosition(getViewer(), p));
    },
    [getViewer],
  );
  const beforeJump = useCallback(() => {
    gate.markJumped();
    const p = readViewerPosition(getViewer());
    if (p) stack.push(p);
  }, [gate, getViewer, stack]);
  const goBack = useCallback(() => {
    const p = stack.pop();
    if (!p) return false;
    applyPosition(p);
    return true;
  }, [stack, applyPosition]);

  const clearArea = useCallback(() => {
    if (!areaRef.current) return;
    setArea(null);
    utilsRef.current?.resetAreaSelection();
  }, []);
  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    clearArea();
    utilsRef.current?.setTip(null);
  }, [setSelection, clearArea]);

  // Navigator for D (jumps, back) and e2e handles.
  useEffect(() => {
    const nav = createNavigator({ getViewer, getStructure: () => structureRef.current, beforeJump, back: goBack });
    registerNavigator(nav);
    exposeForE2e('__spReader', useReaderStore);
    return () => {
      if (useReaderStore.getState().navigator === nav) registerNavigator(null);
    };
  }, [registerNavigator, getViewer, beforeJump, goBack]);

  // A review card carries the persisted highlight id, including after the reader remounts.
  useEffect(() => {
    if (!viewer || !sourceHighlight || jumpedHighlight.current === sourceHighlight || !highlightsQ.data) return;
    const source = highlightsQ.data.highlights.find(h => h.id === sourceHighlight);
    if (!source) { setNotice('복습 카드의 원문 위치를 찾지 못했습니다.'); return; }
    const jump = () => {
      if (jumpedHighlight.current === sourceHighlight || !viewer.pagesCount) return;
      jumpedHighlight.current = sourceHighlight;
      useReaderStore.getState().jumpToAnchor({ kind: source.kind, rects: source.rects, quote: source.quote ?? undefined });
    };
    viewer.eventBus.on('pagesinit', jump);
    jump();
    return () => viewer.eventBus.off('pagesinit', jump);
  }, [viewer, sourceHighlight, highlightsQ.data]);

  // Position restore / save and the current section — once the pdf.js viewer exists.
  useEffect(() => {
    if (!viewer) return;
    const readDto = (): LastPositionDto | null => {
      const p = readViewerPosition(viewer);
      return p ? { page: p.page, zoom: p.zoom, mode: scaleRef.current === 'page-width' ? 'page-width' : 'custom', top: p.top } : null;
    };
    const saver = createPositionSaver({
      read: readDto,
      slot: positionSlots.get(paperId),
      // the deadline also aborts the request itself (the saver counts it as failed after the same time, C2-R1-04)
      save: (body, o) => api.call('papers.position', { params: { id: paperId }, body, keepalive: o.keepalive, signal: AbortSignal.timeout(POSITION_PUT_TIMEOUT_MS) }),
      // The cached papers.get must carry the saved position: reopening the paper in this tab renders from the cache
      // first, and PdfReader keeps the lastPosition of its first render (C-R1-01). Only a position the server confirmed
      // goes there (m-M2-1): a failed PUT must not look saved.
      onSaved: (body) => qc.setQueryData<PaperDetailDto>(qk.paper(paperId), (old) => (old ? { ...old, lastPosition: body } : old)),
    });
    let sectionTimer: ReturnType<typeof setTimeout> | null = null;
    const updateSection = () => {
      const sections = structureRef.current?.sections;
      if (!sections) return;
      const id = currentSectionAt(sections, readViewerPosition(viewer));
      if (useReaderStore.getState().currentSectionId !== id) useReaderStore.getState().setCurrentSectionId(id);
    };
    const onViewArea = () => {
      saver.touch();
      if (sectionTimer) return;
      updateSection();
      sectionTimer = setTimeout(() => {
        sectionTimer = null;
        updateSection();
      }, SECTION_THROTTLE_MS);
    };
    let inited = false;
    let raf = 0;
    const onPagesInit = () => {
      if (inited) return;
      inited = true;
      raf = requestAnimationFrame(() => {
        if (gate.take()) {
          const target = restoreTarget(startPosition, viewer.pagesCount);
          if (target) scrollToViewerPosition(viewer, target);
        }
        saver.start(startPosition);
        updateSection();
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saver.flush(true);
    };
    const onPageHide = () => saver.flush(true);
    viewer.eventBus.on('pagesinit', onPagesInit);
    viewer.eventBus.on('updateviewarea', onViewArea);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    if (viewer.pagesCount > 0) onPagesInit();
    return () => {
      viewer.eventBus.off('pagesinit', onPagesInit);
      viewer.eventBus.off('updateviewarea', onViewArea);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      cancelAnimationFrame(raf);
      if (sectionTimer) clearTimeout(sectionTimer);
      // keepalive: leaving the reader may be the last chance to send; the DOM is already detached, so no fresh read
      saver.flush(true, false);
    };
  }, [viewer, paperId, gate, startPosition, qc]);

  // M3a: the current page for the top bar.
  useEffect(() => {
    if (!viewer) return;
    const onPage = (...a: unknown[]) => {
      const n = (a[0] as { pageNumber?: number } | undefined)?.pageNumber;
      if (typeof n === 'number') setPageNo(n);
    };
    const onInit = () => setPageNo(viewer.currentPageNumber || 1);
    viewer.eventBus.on('pagechanging', onPage);
    viewer.eventBus.on('pagesinit', onInit);
    if (viewer.pagesCount > 0) onInit();
    return () => {
      viewer.eventBus.off('pagechanging', onPage);
      viewer.eventBus.off('pagesinit', onInit);
    };
  }, [viewer]);

  // The current section once the structure arrives (no scroll needed).
  useEffect(() => {
    const v = getViewer();
    if (!v || !structureQ.data || !v.pagesCount) return;
    useReaderStore.getState().setCurrentSectionId(currentSectionAt(structureQ.data.sections, readViewerPosition(v)));
  }, [structureQ.data, getViewer, viewer]);

  // PDF links: one capture-phase click / auxclick handler that runs before pdf.js (links.ts).
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onClick = (e: MouseEvent) =>
      handleLinkClick(e, {
        references: () => structureRef.current?.references ?? [],
        focusReference: (referenceOrdinal) => useReaderStore.getState().focusPanel({ tab: 'references', referenceOrdinal }),
        beforeInternalJump: beforeJump,
        confirmExternal: (url, host) => setExternal({ url, host }),
      });
    frame.addEventListener('click', onClick, true);
    frame.addEventListener('auxclick', onClick, true); // middle click: same confirmation (links.ts)
    return () => {
      frame.removeEventListener('click', onClick, true);
      frame.removeEventListener('auxclick', onClick, true);
    };
  }, [beforeJump]);

  const onSelection = useCallback(
    (sel: PdfSelection) => {
      if (sel.type === 'area') {
        // Ctrl+drag: the rect on the page where the drag started, cut to that page (scaledToNormRect clamps).
        const rect = scaledToNormRect(sel.position.boundingRect);
        setSelection(null);
        setNotice(null);
        void pdfDocument.getPage(rect.page).then(
          (page) => {
            const size = rect.w > 0 && rect.h > 0 ? captureSizeFor(page, rect) : null;
            if (!size) {
              // an output side under 8 px: the selection is ignored (no menu)
              utilsRef.current?.resetAreaSelection();
              utilsRef.current?.setTip(null);
              return;
            }
            setArea({ rect, size });
          },
          () => utilsRef.current?.setTip(null),
        );
        return;
      }
      if (sel.type !== 'text') return;
      clearArea();
      const domSel = window.getSelection();
      const range = domSel && domSel.rangeCount ? domSel.getRangeAt(0) : null;
      const r = range ? selectionFromRange(range) : ({ ok: false, reason: 'empty' } as const);
      if (r.ok) {
        setSelection({ anchor: r.anchor, text: r.text });
        setNotice(null);
      } else {
        setSelection(null);
        setNotice(SELECTION_NOTICES[r.reason] || null);
        if (r.reason === 'multi_page') utilsRef.current?.setTip(null);
      }
    },
    [setSelection, pdfDocument, clearArea],
  );

  const doHighlight = useCallback(
    (color: HighlightColorValue | 'last') => {
      const sel = useReaderStore.getState().selection;
      if (!sel || sel.anchor.kind !== 'text' || !sel.anchor.quote || !sel.anchor.rects.length) return;
      const page = sel.anchor.rects[0]!.page;
      if (sel.anchor.rects.some((r) => r.page !== page)) {
        setNotice(SELECTION_NOTICES.multi_page);
        return;
      }
      const c = color === 'last' ? readLastColor() : color;
      writeLastColor(c);
      create.mutate(
        { kind: 'text', color: c, quote: sel.anchor.quote, page, rects: sel.anchor.rects },
        { onSuccess: clearSelection, onError: (e) => setNotice(`하이라이트를 저장하지 못했습니다: ${e.message}`) },
      );
    },
    [create, clearSelection],
  );

  /** Explain / translate / ask / glossary / note with the current selection (ask and note also without one). */
  const doAct = useCallback(
    (kind: SelectionActionKind) => {
      const { selection, paperState } = useReaderStore.getState();
      if (!selection && kind !== 'ask' && kind !== 'note') return;
      const need = ACTION_NEEDS[kind];
      if (need === 'context' && !paperState.contextReady) {
        setNotice(paperState.aiBlockedReason ?? NOTICE_CONTEXT_NOT_READY);
        return;
      }
      if (need === 'readable' && !paperState.readable) {
        setNotice(NOTICE_NOT_READABLE);
        return;
      }
      if (kind === 'explain' && cardPreview && selection?.anchor.kind === 'text' && selection.anchor.rects.length) {
        // M3a preview: the fixed-answer card under the selection, no run (FloatingCard.tsx)
        setCardReq({ id: ++cardSeq.current, rects: selection.anchor.rects, text: selection.text });
      } else if (!selection) {
        requestAction({ kind });
      } else {
        // a note / question on a selection belongs to the selection's section, not the viewport's (C-I10-01)
        const sectionId = selectionSectionId(kind, structureRef.current?.sections, selection.anchor);
        requestAction({ kind, anchor: selection.anchor, text: selection.text, ...(sectionId ? { sectionId } : {}) });
      }
      utilsRef.current?.setTip(null);
    },
    [requestAction, cardPreview],
  );
  const doExplain = useCallback(() => doAct('explain'), [doAct]);

  const makeQuestions = useCallback(() => {
    const { selection, paperState } = useReaderStore.getState();
    if (!paperState.readable || !selection) return;
    const { quote, rects, kind } = selection.anchor;
    const page = rects[0]?.page;
    if (kind !== 'text' || !quote?.exact.trim() || !page) return;
    openQuestions({ page, quote, rects });
    clearSelection();
  }, [openQuestions, clearSelection]);

  const doCapture = useCallback(
    async (what: 'figure' | 'equation' | 'highlight') => {
      const a = areaRef.current;
      if (!a) return;
      const { paperState } = useReaderStore.getState();
      if (what !== 'highlight' && !paperState.contextReady) {
        setNotice(paperState.aiBlockedReason ?? NOTICE_CONTEXT_NOT_READY);
        return;
      }
      setCaptureBusy(true);
      try {
        const page = await pdfDocument.getPage(a.rect.page);
        const cap = await captureArea(page, a.rect);
        if (!cap) return; // smaller than the server accepts: ignored
        if (what === 'highlight') {
          create.mutate(
            { kind: 'area', color: readLastColor(), page: a.rect.page, rects: [a.rect], imagePng: cap.pngBase64 },
            { onError: (e) => setNotice(`영역 하이라이트를 저장하지 못했습니다: ${e.message}`) },
          );
        } else {
          requestAction({ kind: what, anchor: { kind: 'area', rects: [a.rect] }, imagePng: cap.pngBase64, capture: { widthPx: cap.widthPx, heightPx: cap.heightPx } });
        }
      } catch (e) {
        setNotice(e instanceof CaptureError ? CAPTURE_ERROR_TEXT[e.code] : `영역을 캡처하지 못했습니다: ${(e as Error).message}`);
      } finally {
        setCaptureBusy(false);
        setArea(null);
        utilsRef.current?.resetAreaSelection();
        utilsRef.current?.setTip(null);
      }
    },
    [pdfDocument, create, requestAction],
  );

  const onShortcut = useCallback(
    (a: ReaderShortcutAction) => {
      if (a.kind === 'highlight') doHighlight(a.color);
      else if (a.kind === 'reviewQuestions') makeQuestions();
      else if (a.kind === 'back') useReaderStore.getState().back();
      else if (a.kind === 'escape') {
        setCardReq(null);
        clearSelection();
        setNotice(null);
        setExternal(null);
      } else doAct(a.kind);
    },
    [doAct, doHighlight, clearSelection, makeQuestions],
  );
  useReaderShortcuts(() => ({ path: questions.active ? '' : location, hasSelection: !!useReaderStore.getState().selection, activeElement: document.activeElement }), onShortcut);

  const ui = useMemo<ReaderUi>(
    () => ({
      highlights: dtos,
      busy: create.isPending,
      area,
      captureBusy,
      explain: doExplain,
      makeQuestions,
      act: doAct,
      highlight: doHighlight,
      capture: (w) => void doCapture(w),
      recolor: (id, color) => {
        writeLastColor(color);
        patch.mutate({ id, color }, { onError: (e) => setNotice(`색을 바꾸지 못했습니다: ${e.message}`) });
      },
      remove: (id) => {
        utilsRef.current?.setTip(null);
        remove.mutate(id, { onError: (e) => setNotice(`삭제하지 못했습니다: ${e.message}`) });
      },
    }),
    [dtos, create.isPending, area, captureBusy, doExplain, doAct, doHighlight, makeQuestions, doCapture, patch, remove],
  );

  // Stable props for the vendored highlighter (its listeners re-register when these change).
  const selectionTip = useMemo(() => <SelectionToolbar />, []);
  const openHighlight = useCallback(
    (h: ViewportHighlight<ViewerHighlight>) => {
      setSelection(null);
      utilsRef.current?.setTip({ position: h.position, content: <HighlightPopover id={h.id} /> });
    },
    [setSelection],
  );
  const highlightContainer = useMemo(() => <HighlightContainer onOpen={openHighlight} />, [openHighlight]);
  const utilsCallback = useCallback((u: PdfHighlighterUtils) => {
    utilsRef.current = u;
    exposeForE2e('__spViewer', u);
    // Called while the highlighter renders: publish a new viewer outside that render.
    const v = u.getViewer();
    if (v && viewerSeen.current !== v) {
      viewerSeen.current = v;
      queueMicrotask(() => setViewer(v as unknown as ReaderPdfViewer));
    }
  }, []);
  const enableAreaSelection = useCallback((e: MouseEvent) => e.ctrlKey, []);

  const zoomBy = (factor: number) => {
    const current = utilsRef.current?.getViewer()?.currentScale ?? 1;
    setScale(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(current * factor * 100) / 100)));
  };

  const pagesCount = viewer?.pagesCount || pdfDocument.numPages;
  const submitPage = (e: FormEvent) => {
    e.preventDefault();
    const n = Number((pageDraft ?? '').trim());
    setPageDraft(null);
    if (Number.isInteger(n) && n >= 1 && n <= pagesCount && n !== pageNo) useReaderStore.getState().jumpToPage(n);
    (document.activeElement as HTMLElement | null)?.blur();
  };
  const barButton = 'inline-grid size-8 place-items-center rounded-sl-control text-sl-muted hover:bg-sl-subtle hover:text-sl-ink';
  // Zoom and page controls, drawn in the centred top bar (ReaderBarSlot) — or over the PDF when there is no bar.
  const barControls = (
    <>
      <button type="button" className={barButton} aria-label="축소" title="축소" data-testid="zoom-out" onClick={() => zoomBy(1 / 1.25)}>
        <Icon name="minus" size={18} />
      </button>
      <span className="inline-flex h-7 min-w-[64px] items-center justify-center rounded-[6px] border border-sl-line px-2 text-sl-label text-sl-muted tabular-nums" data-testid="zoom-level">
        {scale === 'page-width' ? '폭 맞춤' : `${Math.round(scale * 100)}%`}
      </span>
      <button type="button" className={barButton} aria-label="확대" title="확대" data-testid="zoom-in" onClick={() => zoomBy(1.25)}>
        <Icon name="plus" size={18} />
      </button>
      <button type="button" className={barButton} aria-label="폭에 맞추기" title="폭에 맞추기" data-testid="zoom-fit" onClick={() => setScale('page-width')}>
        <Icon name="fit" size={18} />
      </button>
      <span className="mx-1 h-[17px] w-px bg-sl-line" aria-hidden="true" />
      <form className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-sl-edge px-1.5 text-sl-label text-sl-muted tabular-nums focus-within:outline-2 focus-within:outline-sl-accent" onSubmit={submitPage} data-testid="rd-page">
        <input
          className="w-7 bg-transparent text-right text-sl-ink outline-none focus-visible:outline-none"
          inputMode="numeric"
          aria-label={`쪽 번호 (1–${pagesCount})`}
          data-testid="rd-page-input"
          value={pageDraft ?? String(pageNo)}
          onFocus={(e) => {
            setPageDraft(String(pageNo));
            e.currentTarget.select();
          }}
          onChange={(e) => setPageDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
          onBlur={() => setPageDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setPageDraft(null);
              e.currentTarget.blur();
            }
          }}
        />
        <span aria-hidden="true">/</span>
        <span data-testid="rd-page-count">{pagesCount}</span>
      </form>
    </>
  );

  return (
    <ReaderUiContext.Provider value={ui}>
      <div
        ref={setFrame}
        className="absolute inset-0 [container-type:inline-size]"
        onPointerDownCapture={(e) => {
          // Focus carry-over: typing in a panel input left the focus there, so E / H did not fire after selecting
          // text in the PDF. A pointerdown on the PDF releases an editable element outside the viewer.
          if (!(e.target as Element).closest?.('.pdfViewer')) return;
          const active = document.activeElement as HTMLElement | null;
          // an input of the floating card counts as outside the PDF too (the card sits in this frame)
          if (active && active !== document.body && isEditable(active) && (!frameRef.current?.contains(active) || active.closest('[data-testid="rd-card-host"]'))) active.blur();
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest?.('.PdfHighlighter__tip-container, [data-reader-chrome]')) return;
          setSelection(null);
          setNotice(null);
          if (areaRef.current) setArea(null);
        }}
      >
        <PdfHighlighter
          pdfDocument={pdfDocument}
          highlights={viewerHighlights}
          pdfScaleValue={scale}
          onSelection={onSelection}
          selectionTip={selectionTip}
          enableAreaSelection={enableAreaSelection}
          utilsRef={utilsCallback}
          style={{ height: '100%' }}
        >
          {highlightContainer}
        </PdfHighlighter>
        <FloatingCardHost request={cardReq} frame={frameEl} eventBus={viewer?.eventBus ?? null} onClose={() => setCardReq(null)} />
        {barSlot ? createPortal(barControls, barSlot) : <div data-reader-chrome className="absolute top-2 right-3 z-10 flex items-center gap-0.5 rounded-sl-control bg-sl-raised px-1 py-0.5 shadow-sl-card">{barControls}</div>}
        {questions.dialog}
        {notice && (
          <div data-reader-chrome role="status" data-testid="selection-notice" className="absolute top-3 left-1/2 z-10 max-w-[90%] -translate-x-1/2 rounded-sl-control bg-sl-ink px-3.5 py-1.5 text-sl-ui text-sl-surface shadow-sl-card">
            {notice}
          </div>
        )}
        {external && (
          <div data-reader-chrome role="dialog" aria-label="외부 링크 열기" data-testid="rd-link-confirm" className="absolute top-10 left-1/2 z-20 w-96 max-w-[90%] -translate-x-1/2 rounded-sl-card border border-sl-line bg-sl-raised p-3 text-sl-ui shadow-sl-card">
            <p className="mb-1">
              외부 사이트를 새 탭에서 엽니다: <strong data-testid="rd-link-host">{external.host}</strong>
            </p>
            <p className="mb-2 text-sl-label break-all text-sl-muted">{external.url}</p>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-sl-control border border-sl-edge px-2.5 py-0.5" data-testid="rd-link-cancel" onClick={() => setExternal(null)}>
                취소
              </button>
              <button
                type="button"
                className="rounded-sl-control bg-sl-accent px-2.5 py-0.5 text-sl-on-accent"
                data-testid="rd-link-open"
                onClick={() => {
                  openExternal(external.url);
                  setExternal(null);
                }}
              >
                열기
              </button>
            </div>
          </div>
        )}
        {highlightsQ.isError && (
          <div data-reader-chrome className="absolute bottom-2 left-2 z-10 rounded-sl-control bg-sl-raised px-2 py-1 text-sl-label text-sl-muted shadow-sl-card" data-testid="highlights-error">
            하이라이트를 불러오지 못했습니다
          </div>
        )}
      </div>
    </ReaderUiContext.Provider>
  );
}

/** Toolbar shown at the selection (vendored tip); for an area selection, the capture menu. Reads live state. */
function SelectionToolbar() {
  const ui = useReaderUi();
  const selection = useReaderStore((s) => s.selection);
  const contextReady = useReaderStore((s) => s.paperState.contextReady);
  const readable = useReaderStore((s) => s.paperState.readable);
  const blockedReason = useReaderStore((s) => s.paperState.aiBlockedReason ?? null);
  // M1.1 M5: a paper the current LLM cannot use (contextMode 'text') shows why, not "색인 준비 중".
  const unsupported = blockedReason?.startsWith(AI_UNSUPPORTED) ? blockedReason : null;
  const pendingText = unsupported ? AI_UNSUPPORTED : '색인 준비 중';
  const aiTitle = (label: string) => (contextReady ? label : (unsupported ?? '색인 준비 중'));
  if (ui.area) return <CaptureMenu area={ui.area} busy={ui.captureBusy} contextReady={contextReady} blockedReason={blockedReason} />;
  if (!selection) return null;
  // M3a: the pill toolbar of concept_CD (icon + name + key), the explain button marked as the main action.
  const tool = 'flex min-h-[29px] items-center gap-1 rounded-[18px] px-2 whitespace-nowrap text-sl-body hover:bg-sl-subtle disabled:opacity-40 disabled:hover:bg-transparent';
  const kbd = 'hidden text-sl-label text-sl-meta xl:inline';
  return (
    <div
      data-testid="selection-toolbar"
      className="flex max-w-[calc(100cqw-16px)] flex-wrap items-center gap-0.5 rounded-[28px] border border-sl-line bg-sl-raised p-1 text-sl-ui shadow-sl-card"
      onMouseDown={(e) => e.preventDefault() /* keep the text selection */}
    >
      <button type="button" data-testid="toolbar-explain" className={`${tool} bg-sl-accent-soft text-sl-accent hover:bg-sl-accent-soft`} disabled={!contextReady} title={aiTitle('설명 (E)')} onClick={ui.explain}>
        <Icon name="spark" size={15} />
        설명
        <kbd className={kbd}>E</kbd>
      </button>
      <button type="button" data-testid="rd-toolbar-translate" className={tool} disabled={!readable} title="번역 (T)" onClick={() => ui.act('translate')}>
        <Icon name="translate" size={15} />
        번역
        <kbd className={kbd}>T</kbd>
      </button>
      <button type="button" data-testid="rd-make-cards" className={tool} disabled={!readable} title="문제 만들기 (Q)" onClick={ui.makeQuestions}>
        문제 만들기<kbd className={kbd}>Q</kbd>
      </button>
      {!contextReady && (
        <span className="px-1 text-sl-label text-sl-meta" data-testid="toolbar-context-pending" title={unsupported ?? undefined}>
          {pendingText}
        </span>
      )}
      <span className="mx-0.5 h-4 w-px bg-sl-line" aria-hidden="true" />
      <span className="flex items-center gap-1 px-1" title="하이라이트 (H · 1–5)">
        <Icon name="highlighter" size={15} className="block shrink-0 text-sl-muted" />
        {COLOR_VALUES.map((c) => (
          <button
            key={c}
            type="button"
            data-testid={`toolbar-color-${c}`}
            className="sl-swatch size-4"
            style={{ background: HIGHLIGHT_COLORS[c].swatch }}
            title={`${HIGHLIGHT_COLORS[c].name} 하이라이트 (${c})`}
            aria-label={`${HIGHLIGHT_COLORS[c].name} 하이라이트`}
            disabled={ui.busy}
            onClick={() => ui.highlight(c)}
          >
            {c}
          </button>
        ))}
      </span>
      <span className="mx-0.5 h-4 w-px bg-sl-line" aria-hidden="true" />
      <button type="button" data-testid="rd-toolbar-ask" className={tool} disabled={!contextReady} title={aiTitle('질문 (C)')} onClick={() => ui.act('ask')}>
        <Icon name="question" size={15} />
        질문
        <kbd className={kbd}>C</kbd>
      </button>
      <button type="button" data-testid="rd-toolbar-note" className={tool} title="노트 (N)" onClick={() => ui.act('note')}>
        <Icon name="note" size={15} />
        노트
      </button>
      <button type="button" data-testid="rd-toolbar-glossary" className={tool} disabled={!contextReady} title={aiTitle('용어집 (G)')} onClick={() => ui.act('glossary')}>
        <Icon name="glossary" size={15} />
        용어집
      </button>
    </div>
  );
}

/** Menu after a Ctrl+drag: figure / equation (AI: need the context) and area highlight. */
function CaptureMenu({ area, busy, contextReady, blockedReason }: { area: PendingArea; busy: boolean; contextReady: boolean; blockedReason: string | null }) {
  const ui = useReaderUi();
  const small = Math.max(area.size.width, area.size.height) < CAPTURE_SMALL_PX;
  const aiTitle = contextReady ? undefined : (blockedReason ?? '색인 준비 중');
  const btn = 'rounded-sl-control px-2.5 py-1 text-left text-sl-body hover:bg-sl-subtle disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div data-testid="rd-capture-menu" className="flex flex-col gap-0.5 rounded-[12px] border border-sl-line bg-sl-raised p-1.5 text-sl-ui shadow-sl-card" onMouseDown={(e) => e.preventDefault()} data-width={area.size.width} data-height={area.size.height}>
      <button type="button" className={btn} data-testid="rd-capture-figure" disabled={busy || !contextReady} title={aiTitle} onClick={() => ui.capture('figure')}>
        그림·표 설명
      </button>
      <button type="button" className={btn} data-testid="rd-capture-equation" disabled={busy || !contextReady} title={aiTitle} onClick={() => ui.capture('equation')}>
        수식 깊이 읽기
      </button>
      <button type="button" className={btn} data-testid="rd-capture-highlight" disabled={busy} onClick={() => ui.capture('highlight')}>
        영역 하이라이트
      </button>
      {!contextReady && (
        <span className="px-2.5 text-sl-label text-sl-meta" data-testid="rd-capture-ai-blocked">
          {blockedReason ?? '색인 준비 중'}
        </span>
      )}
      {small && (
        <span className="px-2.5 text-sl-label text-amber-800" data-testid="rd-capture-small">
          영역이 작아 읽기 어려울 수 있음
        </span>
      )}
      {busy && <span className="px-2.5 text-sl-label text-sl-meta">캡처 중…</span>}
    </div>
  );
}

/** Color change / delete for a clicked highlight (comment editing lives in D's highlight tab). */
function HighlightPopover({ id }: { id: string }) {
  const ui = useReaderUi();
  const h = ui.highlights.find((x) => x.id === id);
  if (!h) return null;
  return (
    <div data-testid="highlight-popover" className="flex items-center gap-1 rounded-[28px] border border-sl-line bg-sl-raised px-2 py-1 text-sl-ui shadow-sl-card">
      {COLOR_VALUES.map((c) => (
        <button
          key={c}
          type="button"
          data-testid={`highlight-color-${c}`}
          aria-pressed={h.color === c}
          className="sl-swatch size-5"
          style={{ background: HIGHLIGHT_COLORS[c].swatch }}
          title={HIGHLIGHT_COLORS[c].name}
          aria-label={HIGHLIGHT_COLORS[c].name}
          onClick={() => ui.recolor(id, c)}
        >
          {c}
        </button>
      ))}
      <button type="button" data-testid="rd-highlight-delete" className="ml-1 inline-flex items-center gap-1 rounded-[18px] px-2 py-0.5 text-red-700 hover:bg-red-50" onClick={() => ui.remove(id)}>
        <Icon name="trash" size={14} />
        삭제
      </button>
    </div>
  );
}

/**
 * One stored highlight on one page. Rendered by the vendored HighlightLayer in a separate React root, so it
 * only uses the highlighter contexts and the props passed here (no app providers). Text and area highlights are
 * drawn the same way — percentages of the page box from the stored NormRects (coords.ts) — so both stay aligned at
 * every zoom; an area highlight gets an outline.
 * A click that ends a drag is not a click on the highlight (C-I10-02): a Ctrl+drag that starts and ends inside an area
 * highlight gets its click on this part right after the mouseup, and opening the popover would replace the capture
 * menu just shown. So Ctrl held, or the pointer moved more than CLICK_SLOP_PX since the press on this part → no popover.
 */
const CLICK_SLOP_PX = 4;
function HighlightContainer({ onOpen }: { onOpen(h: ViewportHighlight<ViewerHighlight>): void }) {
  const { highlight } = useHighlightContainerContext<ViewerHighlight>();
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const layerPage = highlight.position.rects[0]?.pageNumber ?? highlight.position.boundingRect.pageNumber;
  const dto = highlight.dto;
  const rects = dto.rects.filter((r) => r.page === layerPage);
  const area = dto.kind === 'area';
  const color = HIGHLIGHT_COLORS[dto.color as HighlightColorValue];
  return (
    <div className="sp-hl" data-testid="highlight" data-highlight-id={dto.id} data-color={dto.color} data-page={layerPage} data-kind={dto.kind}>
      {rects.map((r, i) => (
        <div
          key={i}
          className={area ? 'sp-hl-part sp-hl-area' : 'sp-hl-part'}
          data-testid="highlight-part"
          style={{ ...normRectToCss(r), background: color.fill, ...(area ? { outlineColor: color.swatch } : {}) }}
          onPointerDown={(e) => {
            pressedAt.current = { x: e.clientX, y: e.clientY };
          }}
          onClick={(e) => {
            e.stopPropagation();
            const p = pressedAt.current;
            pressedAt.current = null;
            if (e.ctrlKey || (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP_PX)) return;
            onOpen(highlight);
          }}
        />
      ))}
    </div>
  );
}
