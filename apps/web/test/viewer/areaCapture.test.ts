// Area capture (BRIEF_C C1) with a fake pdf.js page and fake canvases: the canvas size is captureCanvasSize for every
// row of S's CAPTURE_BOUNDS_CASES, oversize PNGs shrink × 0.75 up to 3 times and then fail without a result, the
// canvas is released, a selection running off the page is cut to it, and NormRect ↔ canvas pixels round-trip.
import { describe, expect, it, vi } from 'vitest';
import { CAPTURE, CAPTURE_BOUNDS_CASES, captureCanvasSize } from '@study-paper/shared/image/capture';
import { isCanonicalBase64 } from '@study-paper/shared/image/png';
import type { NormRect } from '@study-paper/shared/contracts/domain';
import {
  bytesToBase64,
  CAPTURE_MAX_RETRIES,
  CaptureError,
  canvasToNormPoint,
  captureArea,
  captureSizeFor,
  captureTransform,
  type CaptureCanvas,
  type CapturePage,
} from '../../src/viewer/AreaCapture';
import { scaledToNormRect } from '../../src/viewer/coords';

/** A page whose viewport at scale 1 is W × H px. Records every render. */
function fakePage(W: number, H: number) {
  const renders: { width: number; height: number; scale: number; transform?: number[] }[] = [];
  const page: CapturePage = {
    getViewport: ({ scale }) => ({ width: W * scale, height: H * scale }),
    render: ({ canvas, viewport, transform }) => {
      renders.push({ width: canvas.width, height: canvas.height, scale: viewport.width / W, transform });
      return { promise: Promise.resolve() };
    },
  };
  return { page, renders };
}

/** Canvases whose PNG has the given sizes in turn (bytes 0x89 'P' 'N' 'G' …). */
function fakeCanvases(blobSizes: number[]) {
  const made: CaptureCanvas[] = [];
  let i = 0;
  const createCanvas = (): CaptureCanvas => {
    const size = blobSizes[Math.min(i++, blobSizes.length - 1)]!;
    const c: CaptureCanvas = {
      width: 300,
      height: 150,
      toBlob: (cb) => {
        const bytes = new Uint8Array(Math.min(size, 64)).map((_, k) => (k * 37 + 11) & 0xff);
        cb({ size, arrayBuffer: async () => bytes.buffer } as unknown as Blob);
      },
    };
    made.push(c);
    return c;
  };
  return { createCanvas, made };
}

const W = 4000;
const H = 4000;
const rectFor = (w1: number, h1: number): NormRect => ({ page: 1, x: 0, y: 0, w: w1 / W, h: h1 / H });

describe('canvas size = captureCanvasSize (S boundary table)', () => {
  for (const row of CAPTURE_BOUNDS_CASES) {
    it(row.name, async () => {
      const { page, renders } = fakePage(W, H);
      const rect = rectFor(row.w1, row.h1);
      const want = captureCanvasSize(row.w1, row.h1, row.shrink ?? 1);
      expect(want === null ? null : { width: want.width, height: want.height }).toEqual(row.expect);
      // the size helper used by the menu is the shared function, for every shrink value
      const got = captureSizeFor(page, rect, row.shrink ?? 1);
      expect(got && { width: got.width, height: got.height }).toEqual(row.expect);
      if (row.shrink !== undefined) return; // the shrink row is exercised by the retry tests
      const { createCanvas, made } = fakeCanvases([1000]);
      const r = await captureArea(page, rect, { createCanvas });
      if (row.expect === null) {
        expect(r).toBeNull(); // output side < 8 px: ignored, nothing rendered
        expect(made).toHaveLength(0);
        return;
      }
      expect(renders).toEqual([{ width: row.expect.width, height: row.expect.height, scale: expect.closeTo(want!.scale, 9), transform: [1, 0, 0, 1, -0, -0] }]);
      expect(r).toMatchObject({ widthPx: row.expect.width, heightPx: row.expect.height });
      expect(Math.max(r!.widthPx, r!.heightPx)).toBeLessThanOrEqual(CAPTURE.maxSidePx);
      expect(Math.min(r!.widthPx, r!.heightPx)).toBeGreaterThanOrEqual(CAPTURE.minSidePx);
      expect(made[0]).toMatchObject({ width: 0, height: 0 }); // released
    });
  }

  it('small selections are enlarged at most 4× (no extra enlargement), big ones to a 1,568 px long side', () => {
    const { page } = fakePage(612, 792);
    expect(captureSizeFor(page, { page: 1, x: 0.1, y: 0.1, w: 50 / 612, h: 20 / 792 })).toMatchObject({ width: 200, height: 80, scale: 4 });
    const full = captureSizeFor(page, { page: 1, x: 0, y: 0, w: 1, h: 1 })!;
    expect(Math.max(full.width, full.height)).toBe(1568);
  });
});

describe('PNG over 4 MiB', () => {
  const big = CAPTURE.maxBytes + 1;
  it('shrinks × 0.75 and renders again until it fits', async () => {
    const { page, renders } = fakePage(W, H);
    const { createCanvas, made } = fakeCanvases([big, big, 2_000_000]);
    const r = await captureArea(page, rectFor(1568, 784), { createCanvas });
    expect(renders.map((x) => [x.width, x.height])).toEqual([
      [1568, 784],
      [1176, 588],
      [882, 441],
    ]);
    expect(renders[1]).toMatchObject({ width: captureCanvasSize(1568, 784, 0.75)!.width, height: captureCanvasSize(1568, 784, 0.75)!.height });
    expect(r).toMatchObject({ widthPx: 882, heightPx: 441 });
    expect(made.every((c) => c.width === 0 && c.height === 0)).toBe(true);
  });

  it(`still over after ${CAPTURE_MAX_RETRIES} shrinks → CaptureError too_large, no result`, async () => {
    const { page, renders } = fakePage(W, H);
    const { createCanvas, made } = fakeCanvases([big]);
    await expect(captureArea(page, rectFor(1568, 784), { createCanvas })).rejects.toMatchObject({ code: 'too_large' });
    expect(renders).toHaveLength(1 + CAPTURE_MAX_RETRIES);
    expect(made.every((c) => c.width === 0)).toBe(true);
  });

  it('a shrink that makes the output smaller than 8 px also fails (nothing to send)', async () => {
    const { page, renders } = fakePage(W, H);
    const { createCanvas } = fakeCanvases([big]);
    // 100 × 3 → 400 × 12 px, × 0.75 → 300 × 9 px, × 0.5625 → 6 px high (null): two renders, then the error
    await expect(captureArea(page, rectFor(100, 3), { createCanvas })).rejects.toBeInstanceOf(CaptureError);
    expect(renders.map((x) => x.height)).toEqual([12, 9]);
  });

  it('a render error → CaptureError render_failed and the canvas is released', async () => {
    const { page } = fakePage(W, H);
    page.render = () => ({ promise: Promise.reject(new Error('boom')) });
    const { createCanvas, made } = fakeCanvases([10]);
    await expect(captureArea(page, rectFor(400, 300), { createCanvas })).rejects.toMatchObject({ code: 'render_failed' });
    expect(made[0]).toMatchObject({ width: 0, height: 0 });
  });
});

describe('coordinates', () => {
  it('a drag running past the page edge is cut to the start page (scaled → NormRect clamps)', () => {
    const r = scaledToNormRect({ x1: 500, y1: 700, x2: 900, y2: 1300, width: 800, height: 1000, pageNumber: 2 });
    expect(r).toEqual({ page: 2, x: 0.625, y: 0.7, w: 0.375, h: expect.closeTo(0.3, 9) });
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });

  it('captureArea renders the page shifted by the rect offset at the output scale (also after a shrink)', async () => {
    // C-R1-06: the table rows all start at (0, 0); a wrong offset (e.g. the page's top-left corner) must fail here
    const { page, renders } = fakePage(612, 792);
    const rect: NormRect = { page: 1, x: 0.25, y: 0.4, w: 0.5, h: 0.2 };
    const { createCanvas } = fakeCanvases([CAPTURE.maxBytes + 1, 1000]);
    const r = await captureArea(page, rect, { createCanvas });
    expect(renders).toHaveLength(2);
    for (const x of renders) {
      // pixels at this scale: the rect starts at 0.25 / 0.4 of the page viewport
      expect(x.transform![0]).toBe(1);
      expect(x.transform![3]).toBe(1);
      expect(x.transform![4]).toBeCloseTo(-0.25 * 612 * x.scale, 6);
      expect(x.transform![5]).toBeCloseTo(-0.4 * 792 * x.scale, 6);
      expect(x.transform![4]).toBeLessThan(-1);
      // the canvas covers the rect at that scale (floor of captureCanvasSize)
      expect(x.width).toBe(Math.floor(0.5 * 612 * x.scale));
      expect(x.height).toBe(Math.floor(0.2 * 792 * x.scale));
    }
    expect(renders[1]!.scale).toBeCloseTo(renders[0]!.scale * 0.75, 9);
    expect(r).toMatchObject({ widthPx: renders[1]!.width, heightPx: renders[1]!.height });
  });

  it('NormRect → canvas transform → back to NormRect (round trip)', () => {
    const { page } = fakePage(612, 792);
    const rect: NormRect = { page: 1, x: 0.2, y: 0.35, w: 0.4, h: 0.1 };
    const size = captureSizeFor(page, rect)!;
    const t = captureTransform(page, rect, size.scale);
    const vp = page.getViewport({ scale: size.scale });
    // the rect's top-left corner lands on canvas (0, 0)
    expect(rect.x * vp.width + t[4]!).toBeCloseTo(0, 9);
    expect(rect.y * vp.height + t[5]!).toBeCloseTo(0, 9);
    expect(canvasToNormPoint(page, rect, size.scale, { x: 0, y: 0 })).toEqual({ x: 0.2, y: 0.35 });
    const br = canvasToNormPoint(page, rect, size.scale, { x: size.width, y: size.height });
    expect(br.x).toBeCloseTo(rect.x + rect.w, 2);
    expect(br.y).toBeCloseTo(rect.y + rect.h, 2);
  });
});

describe('base64', () => {
  it('is canonical standard base64 of the bytes', async () => {
    for (const n of [0, 1, 2, 3, 4, 5, 40000, 70001]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 0xff);
      const b64 = bytesToBase64(bytes);
      expect(isCanonicalBase64(b64) || n === 0).toBe(true);
      expect(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))).toEqual(bytes);
    }
  });

  it('captureArea returns the PNG bytes as base64 with the output size', async () => {
    const { page } = fakePage(612, 792);
    const toBlob = vi.fn((cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])])));
    const r = await captureArea(page, { page: 1, x: 0, y: 0, w: 0.5, h: 0.5 }, { createCanvas: () => ({ width: 0, height: 0, toBlob }) });
    expect(r?.pngBase64).toBe(btoa('\x89PNG'));
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
  });
});
