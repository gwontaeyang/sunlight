import { describe, expect, it } from 'vitest';
import { NormRectSchema, type NormRect } from '@study-paper/shared/contracts/domain';
import { boxToNormRect, normRectToBox, normRectToCss, normRectToScaled, scaledToNormRect, toNormRects } from '../../src/viewer/coords';
import { scaledPositionToViewport, viewportPositionToScaled } from '../../src/vendor/pdf-highlighter';

/** Fake pdf.js viewer: page 1 portrait 612×792, page 2 landscape 792×612, both at `scale`. */
function fakeViewer(scale: number) {
  const sizes = [
    [612, 792],
    [792, 612],
  ] as const;
  return {
    getPageView: (i: number) => {
      const [w, h] = sizes[i]!;
      return { viewport: { width: w * scale, height: h * scale, convertToViewportPoint: (x: number, y: number) => [x * scale, (h - y) * scale] } };
    },
  } as never;
}

const close = (a: NormRect, b: NormRect) => {
  expect(a.page).toBe(b.page);
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(a[k]).toBeCloseTo(b[k], 10);
};

describe('NormRect conversions', () => {
  const r: NormRect = { page: 2, x: 0.1, y: 0.25, w: 0.3, h: 0.02 };

  it('NormRect → scaled → NormRect round trip keeps the 1-based page', () => {
    const s = normRectToScaled(r);
    expect(s.pageNumber).toBe(2);
    close(scaledToNormRect(s), r);
  });

  it('viewport pixels ↔ NormRect round trip is zoom independent', () => {
    for (const zoom of [0.5, 1, 1.37, 2.5]) {
      const page = { width: 612 * zoom, height: 792 * zoom };
      const box = normRectToBox(r, page);
      close(boxToNormRect({ ...box, left: box.left + 40, top: box.top + 7 }, { left: 40, top: 7, ...page }, 2), r);
    }
  });

  it('clamps edges so the result is always schema-valid', () => {
    const out = boxToNormRect({ left: 590, top: -5, width: 50, height: 20 }, { left: 0, top: 0, width: 612, height: 792 }, 1);
    expect(NormRectSchema.safeParse(out).success).toBe(true);
    expect(out.x + out.w).toBeLessThanOrEqual(1);
    expect(out.y).toBe(0);
  });

  it('CSS percentages place the rect inside its page box at any zoom', () => {
    expect(normRectToCss({ page: 1, x: 0.5, y: 0.25, w: 0.125, h: 0.0625 })).toEqual({ left: '50%', top: '25%', width: '12.5%', height: '6.25%' });
  });

  it('toNormRects uses each rect’s own page and frame (bounding rect when there are no rects)', () => {
    const position = {
      boundingRect: { x1: 61.2, y1: 79.2, x2: 306, y2: 158.4, width: 612, height: 792, pageNumber: 1 },
      rects: [
        { x1: 61.2, y1: 79.2, x2: 306, y2: 99, width: 612, height: 792, pageNumber: 1 },
        { x1: 79.2, y1: 61.2, x2: 396, y2: 81, width: 792, height: 612, pageNumber: 2 },
      ],
    };
    const out = toNormRects(position);
    close(out[0]!, { page: 1, x: 0.1, y: 0.1, w: 0.4, h: 0.025 });
    close(out[1]!, { page: 2, x: 0.1, y: 0.1, w: 0.4, h: 19.8 / 612 });
    close(toNormRects({ ...position, rects: [] })[0]!, { page: 1, x: 0.1, y: 0.1, w: 0.4, h: 0.1 });
  });
});

describe('vendored coordinates (review M11): every rect uses its own page viewport', () => {
  it('viewportPositionToScaled normalises a page-2 rect with the page-2 viewport', () => {
    const viewer = fakeViewer(1.5);
    const scaled = viewportPositionToScaled(
      {
        boundingRect: { left: 91.8, top: 118.8, width: 100, height: 20, pageNumber: 1 },
        rects: [
          { left: 91.8, top: 118.8, width: 100, height: 20, pageNumber: 1 },
          { left: 118.8, top: 91.8, width: 100, height: 20, pageNumber: 2 },
        ],
      },
      viewer,
    );
    const [a, b] = scaled.rects.map((s) => scaledToNormRect(s));
    close(a!, { page: 1, x: 91.8 / (612 * 1.5), y: 118.8 / (792 * 1.5), w: 100 / (612 * 1.5), h: 20 / (792 * 1.5) });
    close(b!, { page: 2, x: 118.8 / (792 * 1.5), y: 91.8 / (612 * 1.5), w: 100 / (792 * 1.5), h: 20 / (612 * 1.5) });
  });

  it('NormRect → viewport → NormRect is identical at two zoom levels (page-specific viewports)', () => {
    const rects: NormRect[] = [
      { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.02 },
      { page: 2, x: 0.6, y: 0.5, w: 0.2, h: 0.03 },
    ];
    for (const zoom of [1, 2.25]) {
      const viewer = fakeViewer(zoom);
      const vp = scaledPositionToViewport({ boundingRect: normRectToScaled(rects[0]!), rects: rects.map(normRectToScaled) }, viewer);
      const back = viewportPositionToScaled(vp, viewer).rects.map((s) => scaledToNormRect(s));
      rects.forEach((r, k) => close(back[k]!, r));
      // page 2 is landscape: its pixel width is the 792-pt side
      expect(vp.rects[1]!.left).toBeCloseTo(0.6 * 792 * zoom, 8);
    }
  });
});

describe('vendored groupHighlightsByPage', () => {
  it('lists a highlight once per page it is on (not once per rect + 1)', async () => {
    const { default: group } = await import('../../src/vendor/pdf-highlighter/lib/group-highlights-by-page');
    const rects = [
      { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.02 },
      { page: 1, x: 0.1, y: 0.13, w: 0.2, h: 0.02 },
      { page: 2, x: 0.1, y: 0.1, w: 0.2, h: 0.02 },
    ].map(normRectToScaled);
    const byPage = group([{ id: 'h', position: { boundingRect: rects[0]!, rects } }]);
    expect(byPage[1]).toHaveLength(1);
    expect(byPage[1]![0]!.position.rects).toHaveLength(2);
    expect(byPage[2]).toHaveLength(1);
    expect(byPage[2]![0]!.position.rects).toHaveLength(1);
  });
});
