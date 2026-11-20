// Capture size rule (BRIEF_S S5, PLAN_M2 3.5). Owner: supervisor.
import { describe, expect, it } from 'vitest';
import { CAPTURE, CAPTURE_BOUNDS_CASES, captureCanvasSize } from '../src/image/capture';
import { inspectPng } from '../src/image/png';
import { makeTestPngBase64 } from '../../../apps/server/test/helpers/png';

describe('captureCanvasSize', () => {
  it('matches the boundary table', () => {
    for (const c of CAPTURE_BOUNDS_CASES) {
      const r = captureCanvasSize(c.w1, c.h1, c.shrink);
      expect(r === null ? null : { width: r.width, height: r.height }, c.name).toEqual(c.expect);
    }
  });

  it('every size it returns passes the inspectPng size check', () => {
    let checked = 0;
    for (const c of CAPTURE_BOUNDS_CASES) {
      const r = captureCanvasSize(c.w1, c.h1, c.shrink);
      if (!r) continue;
      expect(inspectPng(makeTestPngBase64({ width: r.width, height: r.height })).ok, c.name).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it('a sweep of selection sizes never yields a side outside [minSidePx, maxSidePx]', () => {
    for (let w = 0.5; w < 5000; w = w * 1.37 + 0.11) {
      for (let h = 0.5; h < 5000; h = h * 1.61 + 0.07) {
        for (const shrink of [1, 0.75, 0.5625, 0.421875]) {
          const r = captureCanvasSize(w, h, shrink);
          if (!r) continue;
          expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(CAPTURE.maxSidePx);
          expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(CAPTURE.minSidePx);
          expect(r.scale).toBeLessThanOrEqual(CAPTURE.maxScale);
        }
      }
    }
  });

  it('rejects non-finite, non-positive and out-of-range shrink inputs', () => {
    for (const [w, h, s] of [[NaN, 10, 1], [10, Infinity, 1], [-1, 10, 1], [10, 10, 0], [10, 10, 1.5]] as const) expect(captureCanvasSize(w, h, s)).toBeNull();
  });
});
