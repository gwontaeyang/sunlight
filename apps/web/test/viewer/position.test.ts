// Reading position (BRIEF_C C6): debounced save (fake timers), keepalive flush, restore priority (a jump wins),
// a stored page past the end, and the DOM read / apply round trip on a fake pdf.js viewer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LastPositionDto } from '@study-paper/shared/contracts/api';
import { LastPositionDto as LastPositionSchema } from '@study-paper/shared/contracts/api';
import {
  createPositionSaver,
  createPositionSlots,
  initialScale,
  POSITION_PUT_TIMEOUT_MS,
  POSITION_SAVE_DELAY_MS,
  readViewerPosition,
  RestoreGate,
  restoreTarget,
  scrollToViewerPosition,
  type PositionViewerLike,
} from '../../src/viewer/position';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/** Pages of 990 px with 10 px gaps, laid out from the container top (y = 100) and moved by scrollTop. */
function fakeViewer(pages = 5, pageH = 990, zoom = 1): PositionViewerLike {
  const container = document.body.appendChild(document.createElement('div'));
  let scrollTop = 0;
  Object.defineProperty(container, 'scrollTop', { get: () => scrollTop, set: (v: number) => (scrollTop = Math.max(0, v)) });
  container.getBoundingClientRect = () => ({ top: 100, bottom: 900, left: 0, right: 800, width: 800, height: 800, x: 0, y: 100, toJSON() {} }) as DOMRect;
  const divs = Array.from({ length: pages }, (_, i) => {
    const d = document.createElement('div');
    d.getBoundingClientRect = () => {
      const top = 100 + i * (pageH + 10) - scrollTop;
      return { top, bottom: top + pageH, left: 0, right: 700, width: 700, height: pageH, x: 0, y: top, toJSON() {} } as DOMRect;
    };
    return d;
  });
  return { container, pagesCount: pages, currentScale: zoom, getPageView: (i) => (divs[i] ? { div: divs[i]! } : undefined) };
}

const pos = (p: Partial<LastPositionDto> = {}): LastPositionDto => ({ page: 2, zoom: 1.25, mode: 'custom', top: 0.3, ...p });

/** Lets the promise callbacks of settled saves run (a few microtask turns). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('createPositionSaver (debounce)', () => {
  it('sends once, 1.5 s after the last change, with the position read at that change', () => {
    vi.useFakeTimers();
    let current = pos({ page: 1 });
    const save = vi.fn();
    const saver = createPositionSaver({ read: () => current, save });
    saver.start(null);
    saver.touch();
    vi.advanceTimersByTime(1000);
    current = pos({ page: 2 });
    saver.touch(); // restarts the 1.5 s
    vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(pos({ page: 2 }), { keepalive: false });
    expect(LastPositionSchema.parse(save.mock.calls[0]![0])).toEqual(pos({ page: 2 }));
  });

  it('does nothing before start(); the stored (restored) position is not sent again', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = createPositionSaver({ read: () => pos(), save });
    saver.touch();
    vi.advanceTimersByTime(5000);
    saver.flush(true);
    expect(save).not.toHaveBeenCalled();
    saver.start(pos({ top: 0.3004 })); // same within 1e-3
    saver.touch();
    vi.advanceTimersByTime(5000);
    expect(save).not.toHaveBeenCalled();
  });

  it('flush(true) (tab hidden / closed) sends the last value with keepalive right away; flush(false) only a pending one', () => {
    vi.useFakeTimers();
    let current = pos({ page: 3 });
    const save = vi.fn();
    const saver = createPositionSaver({ read: () => current, save });
    saver.start(null);
    saver.flush(false);
    expect(save).not.toHaveBeenCalled(); // nothing pending
    saver.touch();
    saver.flush(true);
    expect(save).toHaveBeenCalledWith(pos({ page: 3 }), { keepalive: true });
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledTimes(1); // the timer was cancelled
    current = pos({ page: 4 });
    saver.touch();
    saver.flush(false);
    expect(save).toHaveBeenLastCalledWith(pos({ page: 4 }), { keepalive: false });
  });

  it('the position is read at touch(): a flush after the DOM is gone (unmount) sends that value, never a fresh read', () => {
    vi.useFakeTimers();
    let current: LastPositionDto | null = pos({ page: 2, top: 0.4 });
    const read = vi.fn(() => current);
    const save = vi.fn();
    const saver = createPositionSaver({ read, save });
    saver.start(null);
    saver.touch();
    expect(read).toHaveBeenCalledTimes(1);
    // React detached the viewer: every rect is 0 (readViewerPosition answers null, a raw read would say "last page")
    current = pos({ page: 12, top: 0 });
    read.mockClear();
    saver.flush(false);
    expect(read).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(pos({ page: 2, top: 0.4 }), { keepalive: false });
  });

  it('a touch whose read fails keeps the last measured position pending', () => {
    vi.useFakeTimers();
    let current: LastPositionDto | null = pos({ page: 3 });
    const save = vi.fn();
    const saver = createPositionSaver({ read: () => current, save });
    saver.start(null);
    saver.touch();
    current = null;
    saver.touch();
    vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(pos({ page: 3 }), { keepalive: false });
  });

  it('a failing save does not throw and the next change retries', async () => {
    vi.useFakeTimers();
    let current = pos({ page: 1 });
    const save = vi.fn().mockRejectedValueOnce(new Error('501')).mockResolvedValue(undefined);
    const saver = createPositionSaver({ read: () => current, save });
    saver.start(null);
    saver.touch();
    vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS);
    current = pos({ page: 2 });
    saver.touch();
    vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS);
    await settle(); // one PUT at a time (m-M2-1): page 2 goes once the failed page 1 PUT has settled
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(pos({ page: 2 }), { keepalive: false });
  });
});

/** A save whose requests stay open until the test answers them, in any order. */
function heldSave() {
  const requests: { p: LastPositionDto; keepalive: boolean; ok: () => void; fail: () => void }[] = [];
  const save = (p: LastPositionDto, o: { keepalive: boolean }) =>
    new Promise<void>((resolve, reject) => {
      requests.push({ p, keepalive: o.keepalive, ok: resolve, fail: () => reject(new Error('offline')) });
    });
  return { requests, save };
}

// Codex m-M2-1 (AD 추가 지시 4 "C 수정 2"): the confirmed position is kept apart from the one being sent and the one
// waiting; one PUT at a time, the waiting one replaced by the newest; "saved" only after success; a failed newest
// position is sent again on the next touch / flush; keepalive on unmount.
describe('createPositionSaver (one PUT at a time, saved only after success — m-M2-1)', () => {
  it('a failed save is not remembered as saved: the same position is sent again on the next touch / flush (Codex probe 1)', async () => {
    const p = pos({ page: 4, top: 0.5, zoom: 1 });
    let calls = 0;
    const saver = createPositionSaver({
      read: () => p,
      save: () => {
        calls++;
        return Promise.reject(new Error('offline'));
      },
    });
    saver.start(null);
    saver.touch();
    saver.flush(false);
    await settle();
    expect(calls).toBe(1);
    saver.touch();
    saver.flush(false);
    await settle();
    expect(calls).toBe(2); // the probe saw 1: the rejected position counted as saved
    expect(saver.confirmed).toBeNull();
  });

  it('two positions never race: the second PUT waits for the first, so a late first answer cannot overwrite the newer page (Codex probe 2)', async () => {
    let p = pos({ page: 2, top: 0.5, zoom: 1 });
    let stored = 0; // what the server holds: the page of the request it processed last
    const { requests, save } = heldSave();
    const saver = createPositionSaver({ read: () => p, save: (v, o) => save(v, o).then(() => void (stored = v.page)) });
    saver.start(null);
    saver.touch();
    saver.flush(false);
    p = { ...p, page: 3 };
    saver.touch();
    saver.flush(false);
    expect(requests.map((r) => r.p.page)).toEqual([2]); // the probe saw [2, 3] in flight together
    expect(saver.sending?.page).toBe(2);
    requests[0]!.ok();
    await settle();
    expect(saver.confirmed?.page).toBe(2);
    expect(requests.map((r) => r.p.page)).toEqual([2, 3]); // the waiting one goes once the first settled
    requests[1]!.ok();
    await settle();
    expect(stored).toBe(3); // the probe ended with 2
    expect(saver.confirmed?.page).toBe(3);
    expect(saver.sending).toBeNull();
  });

  it('only the newest waiting position is sent: positions replaced while a PUT is in flight are never sent', async () => {
    vi.useFakeTimers();
    let p = pos({ page: 2 });
    const { requests, save } = heldSave();
    const saver = createPositionSaver({ read: () => p, save });
    saver.start(null);
    saver.touch();
    vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS); // page 2 in flight
    for (const page of [3, 4, 5]) {
      p = pos({ page });
      saver.touch();
      vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS);
    }
    expect(requests.map((r) => r.p.page)).toEqual([2]);
    requests[0]!.ok();
    await settle();
    expect(requests.map((r) => r.p.page)).toEqual([2, 5]);
    expect(requests[1]!.keepalive).toBe(false);
  });

  it('"saved" only after success; after a failure the server value is unknown (confirmed null, C2-R1-03), never the failed one', async () => {
    const start = pos({ page: 1 });
    let p = pos({ page: 2 });
    const { requests, save } = heldSave();
    const onSaved = vi.fn();
    const saver = createPositionSaver({ read: () => p, save, onSaved });
    saver.start(start);
    expect(saver.confirmed).toEqual(start);
    saver.touch();
    saver.flush(false);
    expect(saver.confirmed).toEqual(start); // in flight is not saved
    expect(onSaved).not.toHaveBeenCalled();
    requests[0]!.fail();
    await settle();
    expect(saver.confirmed).toBeNull(); // the server may hold page 1 or page 2 (an answer lost after the store)
    expect(saver.sending).toBeNull();
    expect(onSaved).not.toHaveBeenCalled(); // e.g. the papers.get cache keeps the stored value
    p = pos({ page: 3 });
    saver.touch();
    saver.flush(false);
    requests[1]!.ok();
    await settle();
    expect(saver.confirmed).toEqual(pos({ page: 3 }));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(pos({ page: 3 }));
  });

  it('a failed newest position waits for the next touch / flush: no automatic retry, and a flush with nothing pending sends it again', async () => {
    vi.useFakeTimers();
    const p = pos({ page: 6 });
    const { requests, save } = heldSave();
    const saver = createPositionSaver({ read: () => p, save });
    saver.start(null);
    saver.touch();
    vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS);
    requests[0]!.fail();
    await settle();
    vi.advanceTimersByTime(60_000);
    expect(requests).toHaveLength(1); // no retry loop on its own
    saver.flush(false); // nothing pending (no touch), but the newest position is not saved
    expect(requests).toHaveLength(2);
    expect(requests[1]!.p).toEqual(p);
    requests[1]!.ok();
    await settle();
    saver.flush(false);
    saver.flush(true);
    expect(requests).toHaveLength(2); // saved now: nothing to send again
  });

  it('a newer position waiting behind a failed PUT is sent right after the failure', async () => {
    let p = pos({ page: 2 });
    const { requests, save } = heldSave();
    const saver = createPositionSaver({ read: () => p, save });
    saver.start(null);
    saver.touch();
    saver.flush(false);
    p = pos({ page: 3 });
    saver.touch();
    saver.flush(false);
    requests[0]!.fail();
    await settle();
    expect(requests.map((r) => r.p.page)).toEqual([2, 3]);
    requests[1]!.ok();
    await settle();
    expect(saver.confirmed?.page).toBe(3);
  });

  it('a waiting position equal to the one in flight is not sent twice', async () => {
    const p = pos({ page: 2 });
    const { requests, save } = heldSave();
    const saver = createPositionSaver({ read: () => p, save });
    saver.start(null);
    saver.touch();
    saver.flush(false);
    saver.touch();
    saver.flush(false);
    requests[0]!.ok();
    await settle();
    expect(requests).toHaveLength(1);
  });

  it('a keepalive flush while a PUT is in flight: the newest waits and then goes with keepalive', async () => {
    let p = pos({ page: 2 });
    const { requests, save } = heldSave();
    const saver = createPositionSaver({ read: () => p, save });
    saver.start(null);
    saver.touch();
    saver.flush(false);
    p = pos({ page: 3 });
    saver.touch();
    saver.flush(true);
    expect(requests).toHaveLength(1);
    requests[0]!.ok();
    await settle();
    expect(requests[1]).toMatchObject({ p: pos({ page: 3 }), keepalive: true });
  });

  it('unmount flush = keepalive without reading the (detached) DOM: the value read at the last touch is sent', () => {
    vi.useFakeTimers();
    let current: LastPositionDto | null = pos({ page: 2, top: 0.4 });
    const read = vi.fn(() => current);
    const save = vi.fn();
    const saver = createPositionSaver({ read, save });
    saver.start(null);
    saver.touch();
    current = pos({ page: 12, top: 0 }); // what a read on a detached DOM would answer
    read.mockClear();
    saver.flush(true, false);
    expect(read).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(pos({ page: 2, top: 0.4 }), { keepalive: true });
    const idle = createPositionSaver({ read, save: vi.fn() });
    idle.start(null);
    idle.flush(true, false); // nothing pending, nothing failed: no read, no request
    expect(read).not.toHaveBeenCalled();
  });

  it('a save that throws synchronously counts as failed and is sent again on the next flush', () => {
    const p = pos({ page: 7 });
    const save = vi.fn().mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const saver = createPositionSaver({ read: () => p, save });
    saver.start(null);
    saver.touch();
    expect(() => saver.flush(false)).not.toThrow();
    expect(saver.confirmed).toBeNull();
    saver.flush(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(saver.confirmed).toEqual(p); // a save that returns nothing (no promise) succeeded
  });
});

// Review C2-R1-03 / C2-R1-04: after a failed PUT the server value is unknown (the answer may have been lost after the
// store), and a PUT that never settles does not hold up the paper.
describe('createPositionSaver (failure = unknown, PUT deadline — C2-R1-03 / C2-R1-04)', () => {
  it('back at the confirmed place while a PUT fails: that place is sent right after the failure (C2-R1-03)', async () => {
    let p = pos({ page: 5 });
    const { requests, save } = heldSave();
    const saver = createPositionSaver({ read: () => p, save });
    saver.start(pos({ page: 1 }));
    saver.touch();
    saver.flush(false); // page 5 in flight
    p = pos({ page: 1 });
    saver.touch();
    saver.flush(false); // back to page 1 (= the confirmed one), waits
    requests[0]!.fail(); // the server may have stored page 5 and lost the answer
    await settle();
    saver.flush(true);
    await settle();
    expect(requests.map((r) => r.p.page)).toEqual([5, 1]); // before the fix: [5] — page 1 was never sent
  });

  it('a failure that leaves the user on the old confirmed place: the next flush sends it, the same failure is not retried on its own (C2-R1-03)', async () => {
    vi.useFakeTimers();
    let p = pos({ page: 4 });
    const { requests, save } = heldSave();
    const saver = createPositionSaver({ read: () => p, save });
    saver.start(pos({ page: 1 }));
    saver.touch();
    vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS); // page 4 in flight
    requests[0]!.fail();
    await settle();
    p = pos({ page: 1 });
    saver.touch();
    vi.advanceTimersByTime(POSITION_SAVE_DELAY_MS); // back at page 1: not "already stored" any more
    expect(requests.map((r) => r.p.page)).toEqual([4, 1]);
    requests[1]!.ok();
    await settle();
    expect(saver.confirmed).toEqual(pos({ page: 1 }));
    vi.advanceTimersByTime(60_000);
    saver.flush(true);
    expect(requests).toHaveLength(2);
  });

  it('a PUT that never settles counts as failed after the deadline: the next flush sends, its late answer is ignored (C2-R1-04)', async () => {
    vi.useFakeTimers();
    let p = pos({ page: 2 });
    const { requests, save } = heldSave();
    const onSaved = vi.fn();
    const saver = createPositionSaver({ read: () => p, save, onSaved });
    saver.start(null);
    saver.touch();
    saver.flush(false); // page 2 hangs
    p = pos({ page: 3 });
    saver.touch();
    saver.flush(true); // the tab is hidden: page 3 waits behind the hung PUT
    vi.advanceTimersByTime(POSITION_PUT_TIMEOUT_MS - 1);
    expect(saver.sending?.page).toBe(2);
    expect(requests).toHaveLength(1);
    vi.advanceTimersByTime(1); // before the fix: page 2 held the paper for good
    expect(saver.sending?.page).toBe(3); // the waiting newest went right away, still with keepalive
    expect(requests.map((r) => [r.p.page, r.keepalive])).toEqual([
      [2, false],
      [3, true],
    ]);
    requests[0]!.ok(); // the late answer of the timed-out PUT
    await settle();
    expect(saver.confirmed).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(saver.sending?.page).toBe(3);
    requests[1]!.ok();
    await settle();
    expect(saver.confirmed?.page).toBe(3);
    expect(onSaved).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POSITION_PUT_TIMEOUT_MS * 2); // a settled PUT leaves no deadline behind
    expect(saver.confirmed?.page).toBe(3);
  });

  it('a hung PUT of an unchanged place: after the deadline the next flush sends it again (C2-R1-04)', async () => {
    vi.useFakeTimers();
    const p = pos({ page: 6 });
    const { requests, save } = heldSave();
    const saver = createPositionSaver({ read: () => p, save });
    saver.start(null);
    saver.touch();
    saver.flush(false);
    saver.flush(true); // pagehide while it hangs: same place, nothing new
    vi.advanceTimersByTime(POSITION_PUT_TIMEOUT_MS);
    expect(saver.sending).toBeNull();
    expect(requests).toHaveLength(1); // no retry on its own
    saver.flush(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.p).toEqual(p);
  });
});

// Review C2-R1-01: the save state is per paper (createPositionSlots), shared by a reader that was left and the one
// opened again, so the order holds across the two and the new reader starts from the newest place.
describe('createPositionSlots (one paper, readers left and opened again — C2-R1-01)', () => {
  it('old reader: A in flight + B waiting; the reopened reader sends C → requests [A, C], the server ends on C, a later pagehide sends nothing', async () => {
    const slots = createPositionSlots();
    const { requests, save } = heldSave();
    const server: number[] = [];
    const via = (v: LastPositionDto, o: { keepalive: boolean }) => save(v, o).then(() => void server.push(v.page));
    const cache: (LastPositionDto | null)[] = [null];
    const onSaved = (v: LastPositionDto) => void cache.push(v);
    let cur = pos({ page: 2 });
    const left = createPositionSaver({ read: () => cur, save: via, onSaved, slot: slots.get('paper') });
    left.start(null);
    left.touch();
    left.flush(false); // A = page 2 in flight
    cur = pos({ page: 3 });
    left.touch();
    left.flush(true, false); // unmount: B = page 3 waits
    await settle();
    // the reader opened again while A is still open starts from B (the cache still says null)
    const base = slots.get('paper').restoreBase(cache.at(-1)!);
    expect(base?.page).toBe(3);
    let cur2 = pos({ page: 7 });
    const reopened = createPositionSaver({ read: () => cur2, save: via, onSaved, slot: slots.get('paper') });
    reopened.start(base);
    reopened.touch();
    reopened.flush(false); // C = page 7 replaces B
    await settle();
    expect(requests.map((r) => r.p.page)).toEqual([2]);
    requests[0]!.ok();
    await settle();
    expect(requests.map((r) => r.p.page)).toEqual([2, 7]); // the probe saw [2, 7, 3]
    requests[1]!.ok();
    await settle();
    expect(server).toEqual([2, 7]);
    expect(server.at(-1)).toBe(7); // the probe ended with 3
    expect(reopened.confirmed?.page).toBe(7);
    expect(cache.at(-1)?.page).toBe(7);
    cur2 = pos({ page: 7 });
    reopened.flush(true); // pagehide at page 7: already stored
    await settle();
    expect(requests).toHaveLength(2);
  });

  it('reopened after the old PUT settled: restore from papers.get, the stored place is not re-sent; other papers never wait', async () => {
    const slots = createPositionSlots();
    const { requests, save } = heldSave();
    const left = createPositionSaver({ read: () => pos({ page: 2 }), save, slot: slots.get('a') });
    left.start(null);
    left.touch();
    left.flush(true, false);
    const other = createPositionSaver({ read: () => pos({ page: 9 }), save, slot: slots.get('b') });
    other.start(null);
    other.touch();
    other.flush(false);
    expect(requests.map((r) => r.p.page)).toEqual([2, 9]); // paper b does not wait for paper a
    requests[0]!.ok();
    await settle();
    const stored = pos({ page: 2 });
    expect(slots.get('a').restoreBase(stored)).toBe(stored);
    const reopened = createPositionSaver({ read: () => stored, save, slot: slots.get('a') });
    reopened.start(stored);
    reopened.flush(true);
    expect(requests).toHaveLength(2);
  });

  it('reopened after the old PUTs failed: restore from papers.get (the confirmed place), which is sent on the next flush since the server value is unknown', async () => {
    const slots = createPositionSlots();
    const { requests, save } = heldSave();
    const left = createPositionSaver({ read: () => pos({ page: 2 }), save, slot: slots.get('a') });
    left.start(pos({ page: 1 }));
    left.touch();
    left.flush(false);
    requests[0]!.fail();
    await settle();
    left.flush(true, false); // unmount: the failed place goes again and fails again
    requests[1]!.fail();
    await settle();
    const cached = pos({ page: 1 }); // the cache kept the confirmed place
    const base = slots.get('a').restoreBase(cached);
    expect(base).toBe(cached);
    const reopened = createPositionSaver({ read: () => cached, save, slot: slots.get('a') });
    reopened.start(base);
    expect(reopened.confirmed).toBeNull();
    reopened.flush(true, false); // e.g. left again at once: the restored place is sent, not the old failed page 2
    expect(requests.map((r) => r.p.page)).toEqual([2, 2, 1]);
  });
});

describe('restore', () => {
  it('a jump before the restore wins: take() is false and the restore runs only once', () => {
    const g = new RestoreGate();
    g.markJumped();
    expect(g.take()).toBe(false);
    expect(g.done).toBe(true);
    const h = new RestoreGate();
    expect(h.take()).toBe(true);
    expect(h.take()).toBe(false);
    h.markJumped();
    expect(h.take()).toBe(false);
  });

  it('a stored page past the end goes to the last page; top is kept; no stored position → nothing', () => {
    expect(restoreTarget(pos({ page: 9, top: 0.4 }), 5)).toEqual({ page: 5, top: 0.4 });
    expect(restoreTarget(pos({ page: 2, top: 0.4 }), 5)).toEqual({ page: 2, top: 0.4 });
    expect(restoreTarget(null, 5)).toBeNull();
    expect(restoreTarget(pos(), 0)).toBeNull();
    // M1 values ({page, zoom}) parse with mode 'custom' and top 0
    expect(restoreTarget(LastPositionSchema.parse({ page: 3, zoom: 1 }), 5)).toEqual({ page: 3, top: 0 });
  });

  it('initial scale: page-width mode or no position → page width; custom → the zoom (clamped)', () => {
    expect(initialScale(null)).toBe('page-width');
    expect(initialScale(pos({ mode: 'page-width', zoom: 2 }))).toBe('page-width');
    expect(initialScale(pos({ zoom: 1.5 }))).toBe(1.5);
    expect(initialScale(pos({ zoom: 9 }))).toBe(4);
  });
});

describe('viewer position (DOM)', () => {
  it('reads the page at the container top and the fraction of it above the top', () => {
    const v = fakeViewer(5, 990, 1.25);
    expect(readViewerPosition(v)).toEqual({ page: 1, top: 0, zoom: 1.25 });
    v.container.scrollTop = 1000 + 495; // half of page 2 above the top
    expect(readViewerPosition(v)).toEqual({ page: 2, top: 0.5, zoom: 1.25 });
    v.container.scrollTop = 4 * 1000 + 900;
    expect(readViewerPosition(v)!.page).toBe(5);
    expect(readViewerPosition(null)).toBeNull();
  });

  it('apply → read is a round trip (same page and top)', () => {
    const v = fakeViewer(5);
    for (const p of [
      { page: 3, top: 0.25 },
      { page: 1, top: 0 },
      { page: 5, top: 0.1 },
    ]) {
      v.container.scrollTop = 0;
      expect(scrollToViewerPosition(v, p)).toBe(true);
      const r = readViewerPosition(v)!;
      expect(r.page).toBe(p.page);
      expect(Math.abs(r.top - p.top)).toBeLessThan(1e-3);
    }
  });

  it('no position while the layout cannot be measured: container detached, or a page box of height 0', () => {
    const v = fakeViewer(12);
    v.container.scrollTop = 1500;
    expect(readViewerPosition(v)!.page).toBe(2);
    v.container.remove(); // an unmount: React removed the DOM before the passive effect cleanup
    expect(readViewerPosition(v)).toBeNull();
    const w = fakeViewer(12);
    for (let i = 0; i < 12; i++) w.getPageView(i)!.div.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    w.container.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    expect(readViewerPosition(w)).toBeNull(); // would otherwise be {page: 12, top: 0}
  });

  it('a page outside the document is not applied', () => {
    const v = fakeViewer(3);
    expect(scrollToViewerPosition(v, { page: 4, top: 0 })).toBe(false);
    expect(scrollToViewerPosition(v, { page: 0, top: 0 })).toBe(false);
    expect(v.container.scrollTop).toBe(0);
  });
});
