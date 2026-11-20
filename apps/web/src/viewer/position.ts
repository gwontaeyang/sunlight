// Reading position (PLAN_M2 3.8, BRIEF_C C6). Owner C.
// - read / apply the viewer position {page, top, zoom} from the DOM (top = fraction of the page height at the top
//   of the scroll container; the same formula both ways, so a position read and applied again lands within a pixel)
// - restore PaperDetailDto.lastPosition once after the pages are initialised (a page past the end → the last page);
//   a jump that happens first (citation / equation / link) wins over the restore
// - save scroll / zoom changes with papers.position after a 1.5 s pause; the last value is flushed when the tab is
//   hidden or closed and when the reader unmounts (api.call with keepalive, PLAN_M2 R5). The position is read when it
//   changes (pdf.js updateviewarea), not when it is sent: an unmount flush runs after React detached the DOM, where
//   every rect is 0 and a read would answer "last page, top 0" (fix round 1, C-R1-02)
// - one PUT at a time per paper, the waiting one replaced by the newest; "saved" only after the PUT succeeded; a failed
//   newest position is sent again on the next touch / flush (Codex m-M2-1, PLAN_M2 9절 58). The state is per paper and
//   shared by the readers of that paper in the tab, so a reader opened again while the old one's PUT is in flight
//   keeps the order and starts from the newest place (C2-R1-01); after a failure the server's value counts as unknown
//   (C2-R1-03); a PUT open longer than 10 s counts as failed (C2-R1-04). The server contract (papers.position, last
//   write wins) is unchanged — the order comes from the client
import type { LastPositionDto } from '@study-paper/shared/contracts/api';
import type { StackPosition } from './positionStack';

export const POSITION_SAVE_DELAY_MS = 1500;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/** Minimal pdf.js PDFViewer surface used for positions. */
export interface PositionViewerLike {
  container: HTMLElement;
  pagesCount: number;
  currentScale: number;
  getPageView(index: number): { div: HTMLElement } | undefined;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Page whose box contains the top edge of the container (first page whose bottom is below it); binary search. */
export function topPage(viewer: PositionViewerLike): { page: number; el: HTMLElement } | null {
  const n = viewer.pagesCount;
  if (!n) return null;
  const cTop = viewer.container.getBoundingClientRect().top;
  let lo = 1;
  let hi = n;
  let found = n;
  // At most ceil(log2(300)) = 9 rect reads for the largest accepted PDF.
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const div = viewer.getPageView(mid - 1)?.div;
    if (!div) return null;
    if (div.getBoundingClientRect().bottom > cTop + 0.5) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  const el = viewer.getPageView(found - 1)?.div;
  return el ? { page: found, el } : null;
}

/**
 * The current position of the viewer, or null before the pages exist and whenever the layout cannot be measured
 * (container detached from the document, or a page box of height 0 — e.g. during an unmount).
 */
export function readViewerPosition(viewer: PositionViewerLike | null): StackPosition | null {
  if (!viewer || !viewer.container.isConnected) return null;
  const tp = topPage(viewer);
  if (!tp) return null;
  const cTop = viewer.container.getBoundingClientRect().top;
  const r = tp.el.getBoundingClientRect();
  if (!(r.height > 0)) return null;
  const top = clamp((cTop - r.top) / r.height, 0, 1);
  return { page: tp.page, top: round4(top), zoom: viewer.currentScale };
}

/** Scrolls so that `top` of `page` is at the top of the container. False when the page does not exist. */
export function scrollToViewerPosition(viewer: PositionViewerLike | null, p: { page: number; top: number }): boolean {
  if (!viewer || p.page < 1 || p.page > viewer.pagesCount) return false;
  const div = viewer.getPageView(p.page - 1)?.div;
  if (!div) return false;
  const r = div.getBoundingClientRect();
  const cTop = viewer.container.getBoundingClientRect().top;
  viewer.container.scrollTop += r.top + clamp(p.top, 0, 1) * r.height - cTop;
  return true;
}

/** Scale value for the viewer when the paper opens: the stored mode / zoom, else page width. */
export function initialScale(last: LastPositionDto | null | undefined): number | 'page-width' {
  if (!last || last.mode === 'page-width') return 'page-width';
  return clamp(last.zoom, ZOOM_MIN, ZOOM_MAX);
}

/** Where to scroll for a stored position: page clamped to 1…pagesCount (past the end → the last page). */
export function restoreTarget(last: LastPositionDto | null | undefined, pagesCount: number): { page: number; top: number } | null {
  if (!last || pagesCount < 1) return null;
  return { page: clamp(Math.floor(last.page), 1, pagesCount), top: clamp(last.top, 0, 1) };
}

/** "A jump wins over the restore": jumps mark it, the restore runs only if nothing jumped before it. */
export class RestoreGate {
  private jumped = false;
  private ran = false;
  markJumped(): void {
    this.jumped = true;
  }
  /** True exactly once, and only when no jump happened first. Marks the restore as done either way. */
  take(): boolean {
    if (this.ran) return false;
    this.ran = true;
    return !this.jumped;
  }
  get done(): boolean {
    return this.ran;
  }
}

export function samePositionDto(a: LastPositionDto | null, b: LastPositionDto | null): boolean {
  if (!a || !b) return a === b;
  return a.page === b.page && a.mode === b.mode && Math.abs(a.zoom - b.zoom) < 1e-3 && Math.abs(a.top - b.top) < 1e-3;
}

/** A position PUT that has not settled after this long counts as failed (C2-R1-04): it no longer holds up the paper. */
export const POSITION_PUT_TIMEOUT_MS = 10_000;

type SaveFn = (p: LastPositionDto, o: { keepalive: boolean }) => void | Promise<unknown>;
type TimerFns = { setT: (fn: () => void, ms: number) => unknown; clearT: (t: unknown) => void };
/** How one reader sends: its PUT, its cache update and its timers. */
interface Sender extends TimerFns {
  save: SaveFn;
  onSaved?: (p: LastPositionDto) => void;
  timeoutMs: number;
}

/**
 * The save state of one paper, shared by every reader of that paper in the tab (C2-R1-01). Three positions are kept
 * apart (Codex m-M2-1): `confirmed` = what the server holds (the start value or the last PUT that succeeded; null after
 * a failure — a PUT whose answer was lost may still have been stored, C2-R1-03), the one being sent, and `latest` =
 * the newest position that should be stored. One PUT at a time: a newer position waits as `latest` (a still newer one
 * replaces it, also one from a reader opened again while the old reader's PUT is in flight) and goes when the PUT in
 * flight settles, so a late answer can never leave an older page on the server. A position is "saved" only after its
 * PUT succeeded; a failed newest position stays unsaved and is sent again on the next touch / flush (no retry loop on
 * its own). A position equal to the confirmed one or to the one in flight is not sent. A PUT that does not settle
 * within the sender's timeout counts as failed (C2-R1-04); its late answer is ignored.
 */
export function createPositionSlot() {
  let confirmed: LastPositionDto | null = null;
  /** The last PUT failed: the server may hold the old confirmed position or the failed one. */
  let unknown = false;
  let sending: LastPositionDto | null = null;
  /** Identity of the PUT in flight: an answer of a PUT that already timed out is ignored. */
  let flight: object | null = null;
  let latest: LastPositionDto | null = null;
  let latestSender: Sender | null = null;
  /** The next PUT of `latest` goes with keepalive (it was set by a flush while the page is going away). */
  let latestKeepalive = false;

  const pump = () => {
    if (sending || !latest || !latestSender || samePositionDto(latest, confirmed)) return;
    const p = latest;
    const s = latestSender;
    const keepalive = latestKeepalive;
    latestKeepalive = false;
    sending = p;
    const token = {};
    flight = token;
    let deadline: unknown = null;
    const done = (ok: boolean) => {
      if (flight !== token) return;
      flight = null;
      if (deadline !== null) s.clearT(deadline);
      deadline = null;
      settled(p, ok, s);
    };
    let r: void | Promise<unknown>;
    try {
      r = s.save(p, { keepalive });
    } catch {
      done(false);
      return;
    }
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      deadline = s.setT(() => {
        deadline = null;
        done(false);
      }, s.timeoutMs);
      (r as Promise<unknown>).then(
        () => done(true),
        () => done(false),
      );
    } else done(true);
  };
  const settled = (p: LastPositionDto, ok: boolean, s: Sender) => {
    sending = null;
    if (ok) {
      confirmed = p;
      unknown = false;
      try {
        s.onSaved?.(p);
      } catch {
        /* a cache update must not stop the saver */
      }
    } else {
      confirmed = null;
      unknown = true;
    }
    // A newer position that waited behind this PUT goes now. The same position after a failure waits for the next
    // touch / flush.
    if (!samePositionDto(latest, p)) pump();
  };

  return {
    /**
     * A reader of this paper starts saving; `current` = the position it restored. While a PUT of an earlier reader is
     * in flight, that PUT and the newest waiting position go on (the reader restored the newest one, restoreBase).
     * Otherwise `current` is what the server holds — unless the last PUT failed: then the server's value is unknown
     * and `current` is sent on the next flush.
     */
    begin(current: LastPositionDto | null, sender: Sender) {
      if (sending) return;
      latestKeepalive = false;
      if (unknown) {
        latest = current;
        latestSender = sender;
      } else {
        latest = null;
        latestSender = null;
        confirmed = current;
      }
    },
    /** Where a reader opened now should start: the newest position still being saved, else `stored` (papers.get). */
    restoreBase(stored: LastPositionDto | null): LastPositionDto | null {
      return sending ? (latest ?? sending) : stored;
    },
    /** Makes `p` the newest position to store (null = keep the current one, e.g. a failed one) and sends if idle. */
    want(p: LastPositionDto | null, keepalive: boolean, sender: Sender) {
      if (p) latest = p;
      if (latest) latestSender = sender;
      // a page going away upgrades the waiting PUT to keepalive; a new debounced position (page alive) clears it
      if (keepalive) latestKeepalive = true;
      else if (p) latestKeepalive = false;
      pump();
    },
    get confirmed() {
      return confirmed;
    },
    get sending() {
      return sending;
    },
  };
}
export type PositionSlot = ReturnType<typeof createPositionSlot>;

/** One slot per key (paper id); module-level in the reader, so a reader opened again shares the old reader's state. */
export function createPositionSlots() {
  const slots = new Map<string, PositionSlot>();
  return {
    get(key: string): PositionSlot {
      let s = slots.get(key);
      if (!s) slots.set(key, (s = createPositionSlot()));
      return s;
    },
  };
}

export interface PositionSaverDeps {
  /** The position to store now (null = nothing to store). */
  read(): LastPositionDto | null;
  /** One PUT. A promise that rejects (or a synchronous throw) = not saved; anything else = saved. */
  save: SaveFn;
  /** Called once the server confirmed `p` (e.g. to update the cached papers.get) — never for a failed save. */
  onSaved?(p: LastPositionDto): void;
  /** The paper's shared save state (createPositionSlots); default = a slot of this saver alone. */
  slot?: PositionSlot;
  delayMs?: number;
  /** A PUT still open after this long counts as failed (default POSITION_PUT_TIMEOUT_MS). */
  putTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * Debounced saver of one reader: touch() on every scroll / zoom change reads the position right then (the DOM is
 * live); it is handed to the paper's slot once nothing changed for delayMs. flush() hands over that pending value
 * without reading the DOM again (an unmount flush runs on a detached DOM); only a flush with `readNow` and nothing
 * pending (tab hidden / closed, DOM still live) reads now. Inactive until start() (after the restore, so the default
 * top of page 1 never overwrites a stored position). The slot keeps the confirmed / sending / waiting positions and
 * sends one PUT at a time (createPositionSlot).
 */
export function createPositionSaver(d: PositionSaverDeps) {
  const delay = d.delayMs ?? POSITION_SAVE_DELAY_MS;
  const setT = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = d.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const slot = d.slot ?? createPositionSlot();
  const sender: Sender = { save: d.save, onSaved: d.onSaved, setT, clearT, timeoutMs: d.putTimeoutMs ?? POSITION_PUT_TIMEOUT_MS };
  let timer: unknown = null;
  let active = false;
  /** Read at touch(), waiting for the debounce. */
  let pendingRead: LastPositionDto | null = null;

  const cancel = () => {
    if (timer !== null) clearT(timer);
    timer = null;
  };
  return {
    /** Starts saving; `current` = the position restored (already stored — not re-sent, see PositionSlot.begin). */
    start(current: LastPositionDto | null) {
      active = true;
      slot.begin(current, sender);
    },
    touch() {
      if (!active) return;
      // a position that cannot be measured keeps the last good one pending
      pendingRead = d.read() ?? pendingRead;
      cancel();
      timer = setT(() => {
        timer = null;
        const p = pendingRead;
        pendingRead = null;
        slot.want(p, false, sender);
      }, delay);
    },
    /**
     * Sends a pending change (or an unsaved failed one) now, with keepalive when the page is going away. With
     * `readNow` (default: = keepalive — tab hidden / closed, the DOM is live) and nothing pending, the current position
     * is read; an unmount flush passes false (the DOM is detached).
     */
    flush(keepalive: boolean, readNow: boolean = keepalive) {
      if (!active) return;
      const wasPending = timer !== null;
      cancel();
      const p = wasPending ? pendingRead : readNow ? d.read() : null;
      pendingRead = null;
      slot.want(p, keepalive, sender);
    },
    cancel,
    get active() {
      return active;
    },
    /** What the server holds: the start value or the last position whose PUT succeeded (null = none / unknown). */
    get confirmed() {
      return slot.confirmed;
    },
    /** The position of the PUT in flight (null = none). */
    get sending() {
      return slot.sending;
    },
  };
}
export type PositionSaver = ReturnType<typeof createPositionSaver>;
