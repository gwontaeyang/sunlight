// Area capture size rule (PLAN_M2 3.5, D11). Owner: supervisor. Shared by the web capture (C — the canvas size it
// renders) and the server PNG check (inspectPng — the size it accepts), so a size computed here always passes there.
//
// scale = min(maxSidePx / max(w1, h1), maxScale) × shrink, width/height = floor(w1 × scale)/floor(h1 × scale), where
// w1·h1 are the selection's size in px at zoom 1. A result side under minSidePx → null (the selection is ignored).
// No extra enlargement for small selections beyond maxScale (PLAN §8.2).

export const CAPTURE = {
  /** Longest side of a capture PNG (and the most the server accepts). */
  maxSidePx: 1568,
  /** Shortest side the server accepts; a smaller computed size is dropped on the web. */
  minSidePx: 8,
  /** Most a selection is enlarged relative to zoom 1. */
  maxScale: 4,
  /** Largest PNG accepted (decoded bytes). */
  maxBytes: 4 * 1024 * 1024,
} as const;

export interface CaptureSize {
  width: number;
  height: number;
  scale: number;
}

/** Canvas size for a selection of w1 × h1 px at zoom 1; `shrink` (0 < shrink ≤ 1) is the web's retry factor (× 0.75). */
export function captureCanvasSize(w1: number, h1: number, shrink = 1): CaptureSize | null {
  if (!Number.isFinite(w1) || !Number.isFinite(h1) || !Number.isFinite(shrink) || w1 <= 0 || h1 <= 0 || shrink <= 0 || shrink > 1) return null;
  const scale = Math.min(CAPTURE.maxSidePx / Math.max(w1, h1), CAPTURE.maxScale) * shrink;
  // floor, then clamp against a float result a hair above the limit (w1 × (1568 / w1) can be 1568.0000000000002).
  const width = Math.min(Math.floor(w1 * scale), CAPTURE.maxSidePx);
  const height = Math.min(Math.floor(h1 * scale), CAPTURE.maxSidePx);
  if (width < CAPTURE.minSidePx || height < CAPTURE.minSidePx) return null;
  return { width, height, scale };
}

export interface CaptureBoundsCase {
  name: string;
  w1: number;
  h1: number;
  shrink?: number;
  expect: { width: number; height: number } | null;
}

/**
 * Boundary table (BRIEF_S S5): used by capture.test (every non-null size passes inspectPng) and by C's
 * areaCapture.test. Output 7/8 px, 1,568/1,569 px, fractional sizes.
 */
export const CAPTURE_BOUNDS_CASES: readonly CaptureBoundsCase[] = [
  { name: 'tiny selection enlarged ×4 to exactly 8 px', w1: 2, h1: 2, expect: { width: 8, height: 8 } },
  { name: 'enlarged ×4 short side 7 px → null', w1: 1.75, h1: 10, expect: null },
  { name: 'short side 7.99 px floors to 7 → null', w1: 1.9975, h1: 100, expect: null },
  { name: 'short side 8.x px floors to 8', w1: 2.1, h1: 100, expect: { width: 8, height: 400 } },
  { name: 'long side exactly 1568 at zoom 1', w1: 1568, h1: 400, expect: { width: 1568, height: 400 } },
  { name: 'long side 1569 at zoom 1 → scaled down to 1568', w1: 1569, h1: 1569, expect: { width: 1568, height: 1568 } },
  { name: 'big selection scaled to 1568', w1: 3136, h1: 1000, expect: { width: 1568, height: 500 } },
  { name: 'fractional sizes floor', w1: 100.7, h1: 50.3, expect: { width: 402, height: 201 } },
  { name: 'retry shrink 0.75', w1: 1568, h1: 784, shrink: 0.75, expect: { width: 1176, height: 588 } },
  { name: 'thin strip: long side 1568, short side under 8 → null', w1: 2000, h1: 10, expect: null },
  { name: 'odd ratio keeps the long side at 1568', w1: 1000, h1: 333, expect: { width: 1568, height: 522 } },
  { name: 'zero size → null', w1: 0, h1: 10, expect: null },
];
