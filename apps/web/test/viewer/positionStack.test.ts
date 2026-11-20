// Position stack (BRIEF_C C3): 50-entry cap, consecutive duplicates skipped, back order, canGoBack reports.
import { describe, expect, it, vi } from 'vitest';
import { POSITION_STACK_MAX, PositionStack, samePosition } from '../../src/viewer/positionStack';

const at = (page: number, top = 0, zoom = 1) => ({ page, top, zoom });

describe('PositionStack', () => {
  it('pop returns positions newest first (LIFO) and null when empty', () => {
    const s = new PositionStack();
    s.push(at(1, 0.1));
    s.push(at(2, 0.2));
    s.push(at(3, 0.3, 1.5));
    expect(s.pop()).toEqual(at(3, 0.3, 1.5));
    expect(s.pop()).toEqual(at(2, 0.2));
    expect(s.pop()).toEqual(at(1, 0.1));
    expect(s.pop()).toBeNull();
  });

  it(`keeps at most ${POSITION_STACK_MAX} entries, dropping the oldest`, () => {
    const s = new PositionStack();
    for (let p = 1; p <= POSITION_STACK_MAX + 7; p++) s.push(at(p));
    expect(s.size).toBe(POSITION_STACK_MAX);
    expect(s.entries()[0]!.page).toBe(8);
    expect(s.entries().at(-1)!.page).toBe(POSITION_STACK_MAX + 7);
    let n = 0;
    while (s.pop()) n++;
    expect(n).toBe(POSITION_STACK_MAX);
  });

  it('skips a push equal to the top entry (same page, top within 1e-3, same zoom); a different one is kept', () => {
    const s = new PositionStack();
    s.push(at(2, 0.25));
    s.push(at(2, 0.2504));
    expect(s.size).toBe(1);
    s.push(at(2, 0.25, 1.25)); // other zoom
    s.push(at(3, 0.25));
    s.push(at(2, 0.25)); // equal to an older entry, not the top: kept
    expect(s.entries().map((e) => [e.page, e.zoom])).toEqual([
      [2, 1],
      [2, 1.25],
      [3, 1],
      [2, 1],
    ]);
    expect(samePosition(at(1, 0.5), at(1, 0.5009))).toBe(true);
    expect(samePosition(at(1, 0.5), at(1, 0.502))).toBe(false);
  });

  it('reports canGoBack on the transitions only (empty → non-empty → empty)', () => {
    const onChange = vi.fn();
    const s = new PositionStack(onChange);
    s.push(at(1));
    s.push(at(2));
    expect(onChange.mock.calls).toEqual([[true]]);
    s.pop();
    expect(onChange.mock.calls).toEqual([[true]]);
    s.pop();
    expect(onChange.mock.calls).toEqual([[true], [false]]);
    s.pop();
    expect(onChange).toHaveBeenCalledTimes(2);
    s.push(at(4));
    s.clear();
    expect(onChange.mock.calls.slice(2)).toEqual([[true], [false]]);
  });

  it('ignores invalid positions and clamps top to 0..1', () => {
    const s = new PositionStack();
    s.push(at(0));
    s.push({ page: 1.5, top: 0, zoom: 1 });
    s.push({ page: 1, top: Number.NaN, zoom: 1 });
    s.push({ page: 1, top: 0, zoom: 0 });
    expect(s.size).toBe(0);
    s.push(at(1, 1.4));
    expect(s.pop()).toEqual(at(1, 1));
  });
});
