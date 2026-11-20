// Floating explanation card host — M3a DOM spike with a FIXED answer (PLAN_M3 §4 "DOM spike", CP-A). Owner C.
// - The host is a sibling of the PDF scroll container (never inside a text layer): the card is portalled into it and
//   placed from the selection's page + NormRects, so zoom, scrolling, a pdf.js page reset (canvas / text layer
//   re-drawn) and a window resize only move it; a new paper unmounts the viewer and the card with it.
// - Placement (placeFloatingCard): ANCHOR_GAP_PX (--spacing-sl-anchor, 8 px) under the last selected line; above the
//   selection when there is clearly more room there; both axes kept inside the viewer; the body scrolls inside the
//   card while the head (dock · minimise · close) and the follow-up form stay fixed. A selection scrolled out of the
//   viewer docks the card at the viewer's lower right (and "패널 쪽으로" docks it on purpose — the diagnostic dock of
//   §4); it returns under the selection when the selection is back in view / undocked.
// - Opened only in the M3a preview mode (?sl-card=fixed on the reader URL): E / 설명 on a selection then shows this
//   card instead of starting a run. No request is sent from it: the answer is fixed text, "전송" only says so. The
//   real host (thread, stream, panel record) is M3b.
// - Keyboard: the card takes focus when it opens (its dialog element, so Tab reaches dock → minimise → close →
//   input → send); Esc closes it and gives the focus back to the PDF; Ctrl+Enter sends from the input.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { NormRect } from '@study-paper/shared/contracts/domain';
import { Icon } from '../ui/icons';

export const ANCHOR_GAP_PX = 8;
export const CARD_MAX_WIDTH_PX = 408;
/** Below the selection whenever at least this much height is left there (or more than above). */
export const CARD_MIN_BELOW_PX = 160;
/** The URL switch of the M3a preview: /paper/<id>?sl-card=fixed. */
export const CARD_PREVIEW_PARAM = 'sl-card';

export function cardPreviewEnabled(search: string = typeof window !== 'undefined' ? window.location.search : ''): boolean {
  try {
    return new URLSearchParams(search).get(CARD_PREVIEW_PARAM) === 'fixed';
  } catch {
    return false;
  }
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export type CardPlacement = 'below' | 'above' | 'dock';
export interface CardPosition {
  placement: CardPlacement;
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/**
 * Where the card goes in a host of hostW × hostH (px, host coordinates). `sel` = the selection's box in the same
 * coordinates (null = not on screen); `cardH` = the card's natural height; `dock` = docked on purpose.
 */
export function placeFloatingCard(o: { hostW: number; hostH: number; sel: Box | null; cardH: number; dock?: boolean; gap?: number }): CardPosition {
  const gap = o.gap ?? ANCHOR_GAP_PX;
  const width = Math.max(0, Math.min(CARD_MAX_WIDTH_PX, o.hostW - 3 * gap));
  const fullH = Math.max(0, o.hostH - 2 * gap);
  const visible = o.sel !== null && o.sel.bottom > 0 && o.sel.top < o.hostH && o.sel.right > 0 && o.sel.left < o.hostW;
  if (o.dock || !visible || !o.sel) {
    const h = Math.min(o.cardH, fullH);
    return { placement: 'dock', left: Math.max(gap, o.hostW - width - 2 * gap), top: Math.max(gap, o.hostH - h - 2 * gap), width, maxHeight: fullH };
  }
  const sel = o.sel;
  const left = Math.min(Math.max(sel.left, gap), Math.max(gap, o.hostW - width - gap));
  const below = o.hostH - (sel.bottom + gap) - gap;
  const above = sel.top - 2 * gap;
  if (below >= Math.min(CARD_MIN_BELOW_PX, o.cardH) || below >= above) {
    return { placement: 'below', left, top: sel.bottom + gap, width, maxHeight: Math.max(0, below) };
  }
  const h = Math.min(o.cardH, above);
  return { placement: 'above', left, top: sel.top - gap - h, width, maxHeight: Math.max(0, above) };
}

/** The selection's box in host coordinates from its page and NormRects (page padding box = the canvas area). */
export function selectionBox(host: HTMLElement, frame: ParentNode, rects: readonly NormRect[]): Box | null {
  if (!rects.length) return null;
  const page = rects[rects.length - 1]!.page;
  const pageEl = frame.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`);
  if (!pageEl) return null;
  const pb = pageEl.getBoundingClientRect();
  const hb = host.getBoundingClientRect();
  const x0 = pb.left + pageEl.clientLeft - hb.left;
  const y0 = pb.top + pageEl.clientTop - hb.top;
  const w = pageEl.clientWidth;
  const h = pageEl.clientHeight;
  const on = rects.filter((r) => r.page === page);
  return {
    left: x0 + Math.min(...on.map((r) => r.x)) * w,
    top: y0 + Math.min(...on.map((r) => r.y)) * h,
    right: x0 + Math.max(...on.map((r) => r.x + r.w)) * w,
    bottom: y0 + Math.max(...on.map((r) => r.y + r.h)) * h,
  };
}

/** The card's height without its max-height: head + the whole body + the form block (with its margins). */
function naturalHeight(card: HTMLElement | null): number {
  if (!card) return 240;
  let h = 2; // borders
  for (const el of Array.from(card.children) as HTMLElement[]) {
    const cs = getComputedStyle(el);
    const scrolls = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    h += (scrolls ? el.scrollHeight : el.offsetHeight) + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }
  return h;
}

/** The pdf.js viewer events after which the page boxes moved. */
const MOVE_EVENTS = ['scalechanging', 'pagerendered', 'updateviewarea', 'pagesinit'] as const;
interface EventBusLike {
  on(name: string, fn: (...a: unknown[]) => void): void;
  off(name: string, fn: (...a: unknown[]) => void): void;
}

export interface FloatingCardRequest {
  /** One per opening: a new selection opens a new card. */
  id: number;
  rects: readonly NormRect[];
  text: string;
}

export function FloatingCardHost({ request, frame, eventBus, onClose }: { request: FloatingCardRequest | null; frame: HTMLElement | null; eventBus: EventBusLike | null; onClose(): void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => setHostEl(hostRef.current), []);
  return (
    <div ref={hostRef} data-reader-chrome data-testid="rd-card-host" className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {request && hostEl && frame && createPortal(<FloatingCard key={request.id} request={request} host={hostEl} frame={frame} eventBus={eventBus} onClose={onClose} />, hostEl)}
    </div>
  );
}

/** The fixed answer of the M3a preview (no model call, no grounding badges: nothing here was checked). */
const FIXED_LEAD = '고정 답 · 카드의 자리와 조작을 확인하는 미리보기';
const FIXED_BODY = '실제 설명, 원문 근거 확인과 후속 대화는 다음 단계에서 이 자리에 연결됩니다. 지금은 질문을 보내지 않고, 근거 배지도 표시하지 않습니다.';

function FloatingCard({ request, host, frame, eventBus, onClose }: { request: FloatingCardRequest; host: HTMLElement; frame: HTMLElement; eventBus: EventBusLike | null; onClose(): void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const minRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [pos, setPos] = useState<CardPosition | null>(null);
  const [minimised, setMinimised] = useState(false);
  const [docked, setDocked] = useState(false);
  const [draft, setDraft] = useState('');
  const [sentNote, setSentNote] = useState<string | null>(null);

  const place = useCallback(() => {
    const sel = selectionBox(host, frame, request.rects);
    setPos(placeFloatingCard({ hostW: host.clientWidth, hostH: host.clientHeight, sel, cardH: naturalHeight(cardRef.current), dock: docked }));
  }, [host, frame, request.rects, docked]);

  useLayoutEffect(() => {
    place();
  }, [place, minimised]);

  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    const scroller = frame.querySelector('.PdfHighlighter');
    scroller?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    ro?.observe(host);
    if (cardRef.current) ro?.observe(cardRef.current);
    for (const ev of MOVE_EVENTS) eventBus?.on(ev, schedule);
    return () => {
      cancelAnimationFrame(raf);
      scroller?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      for (const ev of MOVE_EVENTS) eventBus?.off(ev, schedule);
    };
  }, [frame, host, eventBus, place]);

  // Focus moves into the card once it is placed (a card still hidden for its first measurement cannot take focus);
  // the portal keeps it in the reader's tab order.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!pos || focusedOnce.current) return;
    focusedOnce.current = true;
    cardRef.current?.focus({ preventScroll: true });
  }, [pos]);

  // the focused card leaves the DOM: the focus falls back to the document, where the reader shortcuts work again
  const close = () => onClose();
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.trim()) return;
    setSentNote('이 미리보기에서는 질문을 보내지 않습니다.');
    setDraft('');
  };

  const placement = pos?.placement ?? 'below';
  if (minimised) {
    return (
      <button
        ref={restoreRef}
        type="button"
        data-testid="rd-float-restore"
        className="pointer-events-auto absolute rounded-full border border-sl-edge bg-sl-raised px-3 py-1 text-sl-ui text-sl-ink shadow-sl-card"
        style={{ left: pos?.left ?? ANCHOR_GAP_PX, top: pos ? (placement === 'above' ? pos.top + pos.maxHeight - 32 : pos.top) : ANCHOR_GAP_PX }}
        onClick={() => {
          setMinimised(false);
          requestAnimationFrame(() => minRef.current?.focus({ preventScroll: true }));
        }}
      >
        설명 다시 보기
      </button>
    );
  }
  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="rd-float-card"
      data-placement={placement}
      className="pointer-events-auto absolute flex flex-col overflow-hidden rounded-sl-card border border-sl-line bg-sl-raised text-sl-ink shadow-sl-card outline-none"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: pos?.width ?? CARD_MAX_WIDTH_PX, maxHeight: pos?.maxHeight, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-sl-line py-2 pr-2.5 pl-3.5">
        <span className="text-sl-accent">
          <Icon name="spark" size={17} />
        </span>
        <strong id={titleId} className="min-w-0 flex-1 truncate text-sl-reading font-semibold">
          선택한 문장 설명
        </strong>
        <button type="button" data-testid="rd-float-dock" aria-pressed={docked} aria-label={docked ? '선택 아래로' : '패널 쪽으로'} title={docked ? '선택 아래로' : '패널 쪽으로'} className="inline-grid size-[26px] place-items-center rounded-sl-control text-sl-muted hover:bg-sl-subtle hover:text-sl-ink" onClick={() => setDocked((d) => !d)}>
          <Icon name="dock" size={16} />
        </button>
        <button
          ref={minRef}
          type="button"
          data-testid="rd-float-min"
          aria-label="최소화"
          title="최소화"
          className="inline-grid size-[26px] place-items-center rounded-sl-control text-sl-muted hover:bg-sl-subtle hover:text-sl-ink"
          onClick={() => {
            setMinimised(true);
            requestAnimationFrame(() => restoreRef.current?.focus({ preventScroll: true }));
          }}
        >
          <Icon name="min" size={16} />
        </button>
        <button type="button" data-testid="rd-float-close" aria-label="닫기" title="닫기 (Esc)" className="inline-grid size-[26px] place-items-center rounded-sl-control text-sl-muted hover:bg-sl-subtle hover:text-sl-ink" onClick={close}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="min-h-0 overflow-auto px-4 pt-3 pb-1" data-testid="rd-float-body">
        <p className="text-sl-reading font-semibold text-sl-ink" data-testid="rd-float-lead">
          {FIXED_LEAD}
        </p>
        <p className="mt-1 text-sl-reading text-sl-body">{FIXED_BODY}</p>
        <blockquote className="mt-3 border-l-2 border-sl-line bg-sl-subtle px-3 py-1.5 text-sl-reading text-sl-muted" data-testid="rd-float-quote">
          <span className="block text-sl-label text-sl-meta">선택한 문장</span>
          {request.text.length > 400 ? `${request.text.slice(0, 400)}…` : request.text}
        </blockquote>
        <p className="mt-2 inline-flex items-center rounded-sl-chip border border-dashed border-sl-edge px-1.5 text-sl-label text-sl-meta">고정 답 · 근거 확인 없음</p>
      </div>
      <form className="m-3 mt-2.5 shrink-0" onSubmit={send}>
        <div className="flex items-center gap-1.5 rounded-sl-control border border-sl-edge bg-sl-surface py-1 pr-1.5 pl-3 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-sl-accent">
          <input
            type="text"
            data-testid="rd-float-input"
            aria-label="후속 질문"
            placeholder="후속 질문을 입력하세요"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sl-reading text-sl-ink outline-none focus-visible:outline-none"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSentNote(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) send(e);
            }}
          />
          <button type="submit" data-testid="rd-float-send" aria-label="후속 질문 전송" title="전송 (Ctrl+Enter)" disabled={!draft.trim()} className="grid size-[30px] shrink-0 place-items-center rounded-[7px] bg-sl-accent text-sl-on-accent disabled:bg-sl-subtle disabled:text-sl-meta">
            <Icon name="send" size={16} />
          </button>
        </div>
        {sentNote && (
          <p role="status" className="mt-1 text-sl-label text-sl-meta" data-testid="rd-float-sent-note">
            {sentNote}
          </p>
        )}
      </form>
    </div>
  );
}
