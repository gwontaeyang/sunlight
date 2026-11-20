// Owner A. Area highlight sectionId and the page's columns (review A-R1-07, then A-F3-01 — coordinator decision
// 추가 지시 3, PLAN_M2 9절 52): the columns come from the page's text layout (page_texts items), never from the width of
// the stored heading rect (one text item — for a centred "III" only the numeral). Same-page heading H is before area A
// when col(H) < col(A), or (same column, A full width, or one column) and H.y ≤ A.top; headings of earlier pages are
// always before; the last one by (page, offset) wins; a heading on the page without a rect, or a page without a
// readable text layout → unknown (null). The real-paper case rebuilds the reviewer's probe (parse → extractPageTexts →
// anchorStructure on both stored papers; skipped without the fixtures).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HighlightDto } from '@study-paper/shared/contracts/api';
import type { NormRect } from '@study-paper/shared/contracts/domain';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { anchorStructure } from '../../src/ingest/anchorStructure';
import { parse } from '../../src/ingest/latexml';
import { extractPageTexts } from '../../src/ingest/pdfText';
import { BAND_POSITIONS, COLUMN_RULE, headingBeforeArea, pageColumns, storedPageColumns, type LayoutItem, type PageColumns } from '../../src/routes/highlights';
import { startTestServer, type TestServer } from '../helpers/server';

// ---- synthetic page layouts (normalised page coordinates) -------------------------------------------------------
const BODY_H = 0.013;
const line = (x: number, y: number, w: number, h = BODY_H): LayoutItem => ({ len: 5, rect: { x, y, w, h } });
const ys = (n: number, from = 0.07, step = 0.015) => Array.from({ length: n }, (_, k) => from + k * step);
/** IEEE-like two columns x 0.08–0.49 / 0.51–0.92, 55 lines each, nothing in the gutter. */
const twoColumns = (): LayoutItem[] => [...ys(55).map((y) => line(0.08, y, 0.41)), ...ys(55).map((y) => line(0.51, y, 0.41))];
/**
 * Two columns with what crosses the gutter on the real pages (KISS-ICP p1, FAST-LIO2 p4·p12·p15·p17): the running
 * head (w 0.522), three title lines, an author line, a full-width caption whose last line ends at x 0.504, the arXiv
 * stamp, a full-width table of small cells across the gutter, a figure label in the gutter, zero-height space items.
 */
const twoColumnsWithFloats = (): LayoutItem[] => [
  ...ys(40, 0.35).map((y) => line(0.08, y, 0.41)),
  ...ys(40, 0.35).map((y) => line(0.51, y, 0.41)),
  line(0.398, 0.031, 0.522, 0.009),
  line(0.127, 0.067, 0.746, 0.03),
  line(0.159, 0.102, 0.683, 0.03),
  line(0.315, 0.137, 0.371, 0.03),
  line(0.386, 0.183, 0.124, 0.014),
  ...ys(3, 0.2, 0.012).map((y) => line(0.08, y, 0.84, 0.011)),
  line(0.08, 0.236, 0.424, 0.011),
  line(0.052, 0.676, 0.543, 0.025),
  ...ys(8, 0.25, 0.011).flatMap((y) => [0.1, 0.2, 0.3, 0.4, 0.47, 0.55, 0.65, 0.75, 0.85].map((x) => line(x, y, 0.05, 0.009))),
  line(0.499, 0.3, 0.077, 0.011),
  ...ys(6, 0.25, 0.011).map((y) => line(0.46, y, 0.042, 0)),
];
/** One column x 0.12–0.88: full lines, lines split at a font change, paragraph ends of every length, display maths. */
const oneColumn = (): LayoutItem[] => {
  const out: LayoutItem[] = [];
  ys(57).forEach((y, k) => {
    if (k % 9 === 8) out.push(line(0.12, y, 0.05 + ((k * 37) % 70) / 100)); // paragraph end
    else if (k % 4 === 1) out.push(line(0.12, y, 0.18), line(0.3, y, 0.58)); // italic start, then the rest (≤ 0.6)
    else if (k % 4 === 3) out.push(line(0.12, y, 0.33), line(0.45, y, 0.43));
    else out.push(line(0.12, y, 0.76));
  });
  for (const y of [0.2, 0.5, 0.8]) for (let g = 0; g < 14; g++) out.push(line(0.36 + g * 0.02, y + 0.005, 0.012)); // equation glyphs
  return out;
};
/** One column of heavy maths: 20 text lines and 15 display equations of 40 glyphs each (glyphs outnumber lines 30:1). */
const oneColumnMaths = (): LayoutItem[] => [
  ...ys(20, 0.07, 0.04).map((y) => line(0.12, y, 0.76)),
  ...ys(15, 0.09, 0.055).flatMap((y) => Array.from({ length: 40 }, (_, g) => line(0.3 + g * 0.01, y, 0.006))),
];

/**
 * One column of a code listing (review A-F4-01, shaped like shared-mime-info-spec.pdf p7/p11 — pdfTeX, one column):
 * a running head at the right, prose lines across the page, listing rows split into word items that all end before
 * x 0.64, and short tokens (≥ 10) right of 0.646 on a few rows. The band search alone finds a gutter near 0.64 here.
 */
const listing = (): LayoutItem[] => {
  const out: LayoutItem[] = [line(0.692, 0.059, 0.19)];
  for (const y of [0.3, 0.315, 0.486, 0.502, 0.7, 0.716]) out.push(line(0.196, y, 0.68)); // prose
  ys(10, 0.09, 0.0145).forEach((y, k) => out.push(line(0.196, y, 0.2), line(0.405, y, 0.12), line(0.535, y, 0.1 - (k % 3) * 0.02))); // listing rows
  ys(12, 0.34, 0.0145).forEach((y, k) => out.push(line(0.196, y, 0.22 + (k % 4) * 0.05)));
  for (const y of [0.106, 0.12, 0.135, 0.15]) out.push(line(0.646, y, 0.018), line(0.673, y, 0.026), line(0.708, y, 0.07)); // DO NOT EDIT!-->
  ys(14, 0.53, 0.0145).forEach((y) => out.push(line(0.196, y, 0.25), line(0.455, y, 0.18)));
  return out;
};
/** Review A-F4-01 (3): 12 full-width lines, 30 short lines, 12 narrow items right of 0.66 — one column. */
const shortLines = (): LayoutItem[] => [
  ...ys(12, 0.07, 0.015).map((y) => line(0.12, y, 0.76)),
  ...ys(30, 0.26, 0.015).map((y, k) => line(0.12, y, 0.2 + (k % 5) * 0.08)),
  ...ys(12, 0.75, 0.015).map((y) => line(0.67 + (y * 100 % 3) * 0.03, y, 0.06)),
];
/** Review A-F4-01 (3): one column whose lines end in word items of equal width (0.075, gap 0.01) — the gaps line up. */
const wordItems = (): LayoutItem[] => [
  ...ys(5, 0.07, 0.015).map((y) => line(0.12, y, 0.76)),
  ...ys(40, 0.16, 0.015).flatMap((y) => [line(0.12, y, 0.3), ...Array.from({ length: 6 }, (_, k) => line(0.43 + k * 0.085, y, 0.075))]),
];
/**
 * Two columns with the lines near the gutter only on `rows` rows (the others ragged far from it): left lines ending at
 * 0.49 and right lines starting at 0.51 — side by side when `sideBySide`, else at heights that never overlap.
 */
const nearGutter = (rows: number, sideBySide: boolean): LayoutItem[] => {
  const out: LayoutItem[] = [];
  ys(40, 0.07, 0.02).forEach((y, k) => {
    const near = k < rows;
    out.push(line(0.08, y, near ? 0.41 : 0.3)); // left: ends at 0.49 or 0.38
    const yr = near && !sideBySide ? y + 0.4 + 0.0105 : y;
    out.push(line(near ? 0.51 : 0.62, yr, near ? 0.41 : 0.3)); // right: starts at 0.51 or 0.62
  });
  return out;
};
/** The page mirrored left ↔ right. */
const mirror = (items: LayoutItem[]): LayoutItem[] => items.map((i) => ({ ...i, rect: { ...i.rect, x: 1 - i.rect.x - i.rect.w } }));
/**
 * An IEEE reference list in both columns (review A-F5-01; KISS-ICP p8, FAST-LIO2 p18·p19 measured): every third row
 * starts a reference with a `[NN]` label (w 0.0217, not a line) at the column's left edge; the reference text follows
 * with a hanging indent, 0.0081 after the label's end. Left lines end at 0.4902, the right labels start at 0.5098 (band
 * 0.4925–0.5075, g 0.5) and the right text at g + `rightStart` — real 0.0396 for two-digit labels; a three-digit
 * `[100]` is ≈ 0.0065 wider.
 */
const references = (rightStart: number): LayoutItem[] => {
  const out: LayoutItem[] = [];
  ys(50, 0.07, 0.0113).forEach((y, k) => {
    for (const [labelX, textX, end] of [
      [0.08, 0.1098, 0.4902],
      [0.5098, 0.5 + rightStart, 0.92],
    ] as const) {
      if (k % 3 === 0) out.push(line(labelX, y, textX - 0.0081 - labelX, 0.0101));
      out.push(line(textX, y, (k % 3 === 2 ? 0.6 : 1) * (end - textX), 0.0101)); // the last line of a reference is short
    }
  });
  return out;
};
/**
 * Two columns whose lines end `leftGap` before / start `rightGap` past g 0.5, side by side on 30 rows. Between a line
 * and 0.4902 / 0.5098 a narrow item (< 0.15 wide, not a line — a label or a number) leaves 0.005, so the band stays at
 * 0.4925–0.5075.
 */
const gaps = (leftGap: number, rightGap: number): LayoutItem[] =>
  ys(30, 0.07, 0.02).flatMap((y) => [
    line(0.08, y, 0.5 - leftGap - 0.08),
    line(0.5 - leftGap + 0.005, y, leftGap - 0.0148),
    line(0.5098, y, rightGap - 0.0148),
    line(0.5 + rightGap, y, 0.92 - 0.5 - rightGap),
  ].filter((i) => i.rect.w > 0));
/**
 * One column of a decoder trace (foo2zjs manual p78 — groff, one column — measured: g 0.4113, its meaning column at
 * g + 0.0829): "offset: escape" lines at the left, their meaning at x 0.5005 (g 0.4175 + 0.083), hex dump rows from
 * 0.42 across the page. With a side reach of 0.085 or more the meaning column reads as a right column.
 */
const trace = (): LayoutItem[] => {
  const T = 0.0119;
  const out = [line(0.121, 0.045, 0.094, T), line(0.4195, 0.045, 0.19, T), line(0.813, 0.045, 0.094, T)];
  ys(20, 0.088, 0.0143).forEach((y, k) => {
    if (k % 5 === 3) out.push(line(0.4336, y, 0.474, T));
    else if (k % 5 === 4) out.push(line(0.4235, y, 0.514, T));
    else out.push(line(0.1916, y, [0.19, 0.21, 0.22][k % 5]!, T), line(0.5005, y, [0.33, 0.06, 0.21][k % 5]!, T));
  });
  ys(10, 0.39, 0.0143).forEach((y, k) => out.push(line(0.1815, y, 0.05 + (k % 4) * 0.08, T)));
  out.push(line(0.121, 0.9, 0.1, T), line(0.4209, 0.9, 0.187, T));
  return out;
};
/** Ragged two columns (left lines end at 0.38, right ones start at 0.62 — never near the gutter) on 40 rows. */
const ragged = (): LayoutItem[] => ys(40, 0.07, 0.02).flatMap((y) => [line(0.08, y, 0.3), line(0.62, y, 0.3)]);

describe('pageColumns: side-by-side evidence (A-F5-01, A-F5-02)', () => {
  const gutterOf = (l: PageColumns) => (l.kind === 'two' ? l.gutter : null);
  it('A-F5-01: a reference list in both columns — right text after the labels at g + 0.0396 (real), + 0.0461 (three-digit labels), + 0.0526 → two at 0.5', () => {
    for (const start of [0.0396, 0.0461, 0.0526]) expect(gutterOf(pageColumns(references(start))), String(start)).toBeCloseTo(0.5, 3);
  });
  it('A-F5-01 boundary: lines 0.059 from the gutter on either side → two; 0.061 → one', () => {
    expect(gutterOf(pageColumns(gaps(0.0098, 0.059)))).toBeCloseTo(0.5, 3);
    expect(pageColumns(gaps(0.0098, 0.061))).toEqual({ kind: 'one' });
    expect(gutterOf(pageColumns(gaps(0.059, 0.0098)))).toBeCloseTo(0.5, 3);
    expect(pageColumns(gaps(0.061, 0.0098))).toEqual({ kind: 'one' });
  });
  it('A-F5-01 upper limit: a one-column decoder trace whose meaning column starts 0.083 right of the gutter (foo2zjs p78 shape) → one', () => {
    expect(pageColumns(trace())).toEqual({ kind: 'one' });
  });
  it('A-F5-02: ≥ 3 side-by-side lines are needed on EACH side — 8 left lines beside one tall right line → one, mirrored → one; 3 and 3 → two', () => {
    const oneTall = [...ragged(), ...ys(8, 0.07, 0.02).map((y) => line(0.08, y, 0.41)), line(0.51, 0.07, 0.41, 0.16)];
    expect(pageColumns(oneTall)).toEqual({ kind: 'one' });
    expect(pageColumns(mirror(oneTall))).toEqual({ kind: 'one' });
    expect(gutterOf(pageColumns(nearGutter(3, true)))).toBeCloseTo(0.5, 2);
    expect(gutterOf(pageColumns(mirror(nearGutter(3, true))))).toBeCloseTo(0.5, 2);
  });
  it('A-F5-02: only lines (items ≥ 0.15 wide) count beside the gutter — 0.14 wide items → one, 0.16 → two', () => {
    const beside = (w: number) => [
      ...ragged(),
      ...ys(8, 0.075, 0.02).flatMap((y) => [line(0.08, y, 0.25), line(0.49 - w, y, w), line(0.51, y, w), line(0.52 + w, y, 0.4 - w)]),
    ];
    expect(pageColumns(beside(0.14))).toEqual({ kind: 'one' });
    expect(gutterOf(pageColumns(beside(0.16)))).toBeCloseTo(0.5, 2);
  });
  it('A-F5-02: short right lines inside a tall right item do not hide it — 5 left lines beside it → two (the right extents are merged)', () => {
    const contained = [
      ...ragged(),
      line(0.51, 0.1, 0.41, 0.4), // a tall right item (y 0.1–0.5)
      ...[0.2, 0.3].map((y) => line(0.51, y, 0.2)), // short right lines inside its extent
      ...[0.2, 0.25, 0.3, 0.4, 0.45].map((y) => line(0.08, y, 0.41)), // left lines at the gutter: 2 beside the short ones, 5 beside the tall one
    ];
    expect(gutterOf(pageColumns(contained))).toBeCloseTo(0.5, 2);
  });
});

describe('pageColumns: the page text layout (A-F3-01)', () => {
  const gutterOf = (l: PageColumns) => (l.kind === 'two' ? l.gutter : null);
  it('two columns with an empty gutter → two, the gutter in the middle of the band', () => {
    expect(gutterOf(pageColumns(twoColumns()))).toBeCloseTo(0.5, 2);
  });
  it('two columns whose gutter is crossed by the running head, title, a full-width caption and table, the arXiv stamp → still two at 0.5', () => {
    expect(gutterOf(pageColumns(twoColumnsWithFloats()))).toBeCloseTo(0.5, 2);
  });
  it('one column (full lines, split lines, paragraph ends, display maths) → one', () => {
    expect(pageColumns(oneColumn())).toEqual({ kind: 'one' });
  });
  it('one column of heavy maths (glyph items outnumber the lines) → one', () => {
    expect(pageColumns(oneColumnMaths())).toEqual({ kind: 'one' });
  });
  it('a page with almost no text, an empty page, only zero-height items, nine items on one side → one', () => {
    expect(pageColumns([line(0.08, 0.1, 0.3), line(0.6, 0.1, 0.3), line(0.08, 0.2, 0.3), line(0.6, 0.2, 0.3)])).toEqual({ kind: 'one' });
    expect(pageColumns([])).toEqual({ kind: 'one' });
    expect(pageColumns(twoColumns().map((i) => ({ ...i, rect: { ...i.rect, h: 0 } })))).toEqual({ kind: 'one' });
    expect(pageColumns([...ys(9).map((y) => line(0.08, y, 0.41)), ...ys(55).map((y) => line(0.51, y, 0.41))])).toEqual({ kind: 'one' });
  });
  it('items without text (len 0) do not count', () => {
    expect(pageColumns(twoColumns().map((i) => ({ ...i, len: 0 })))).toEqual({ kind: 'one' });
  });
  it('the band is looked for between x 0.35 and 0.65 only', () => {
    // a gutter at 0.3 (columns 0.08–0.29 / 0.31–0.86) is outside the window → one
    expect(pageColumns([...ys(55).map((y) => line(0.08, y, 0.21)), ...ys(55).map((y) => line(0.31, y, 0.55))])).toEqual({ kind: 'one' });
  });
  it('A-F4-01: one column of a code listing (spec p7 / p11 shape) → one', () => {
    expect(pageColumns(listing())).toEqual({ kind: 'one' });
  });
  it('A-F4-01: one column of short lines and narrow items right of 0.66 → one', () => {
    expect(pageColumns(shortLines())).toEqual({ kind: 'one' });
  });
  it('A-F4-01: one column whose lines end in aligned word items → one', () => {
    expect(pageColumns(wordItems())).toEqual({ kind: 'one' });
  });
  it('known limit: a one-column page that is mostly a two-column table of wide cells reads as two columns', () => {
    const table = [
      ...ys(4, 0.07, 0.015).map((y) => line(0.12, y, 0.76)),
      ...ys(20, 0.15, 0.015).flatMap((y) => [line(0.12, y, 0.36), line(0.52, y, 0.36)]),
      ...ys(4, 0.5, 0.015).map((y) => line(0.12, y, 0.76)),
    ];
    expect(pageColumns(table)).toEqual({ kind: 'two', gutter: expect.closeTo(0.5, 2) as unknown as number });
  });
  it('known limit (review A-F6-01): a two-column page whose left column is only a table and figures reads as one column', () => {
    // knitt2022 (arXiv 2210.06001) p4 shape, measured read-only: the left column holds a table title (0.167–0.362), table
    // cells < 0.15 wide, figure labels, and two captions — only the Figure 4 caption's first line (0.098–0.476) reaches
    // the gutter; the right column is 32 body lines at x 0.515. Band and item counts pass, but there is 1 side-by-side
    // pair, not 3 → one column (sectionId then compares heights only). Accepted for M2 (structural change → supervisor,
    // A-F4-04): the pair condition is needed (without it 70 of 556 independent one-column pages read as two).
    const page = (captionLines: number): LayoutItem[] => [
      line(0.167, 0.105, 0.195, 0.012), // table title
      ...ys(12, 0.125, 0.015).flatMap((y) => [0.1, 0.18, 0.26, 0.34].map((x) => line(x, y, 0.05, 0.011))), // table cells
      ...ys(6, 0.42, 0.03).map((y) => line(0.2, y, 0.04, 0.01)), // figure labels
      ...ys(captionLines, 0.626, 0.014).map((y) => line(0.098, y, 0.378, 0.012)), // Figure 4 caption at the gutter
      line(0.098, 0.626 + captionLines * 0.014, 0.12, 0.012), // its short last line
      line(0.095, 0.869, 0.235, 0.012), // Figure 5 caption, far from the gutter
      ...ys(32, 0.07, 0.026).map((y) => line(0.515, y, 0.405, 0.013)), // the right column's body
    ];
    expect(pageColumns(page(1))).toEqual({ kind: 'one' });
    // the same page with a four-line caption at the gutter has 4 left / 3 right pairs → two: the pair count decides
    expect(pageColumns(page(4))).toEqual({ kind: 'two', gutter: expect.closeTo(0.496, 2) as unknown as number });
  });
  it('A-F4-01: two columns need ≥ 3 lines on each side at the gutter, side by side', () => {
    expect(gutterOf(pageColumns(nearGutter(3, true)))).toBeCloseTo(0.5, 2);
    expect(pageColumns(nearGutter(2, true))).toEqual({ kind: 'one' });
    expect(pageColumns(nearGutter(8, false))).toEqual({ kind: 'one' }); // as many lines at the gutter, never at the same height
  });
  it('boundary (A-F4-03): exactly 10 items on a side → two, 9 → one (each side)', () => {
    const cols = (left: number, right: number) => [...ys(left).map((y) => line(0.08, y, 0.41)), ...ys(right).map((y) => line(0.51, y, 0.41))];
    expect(gutterOf(pageColumns(cols(10, 55)))).toBeCloseTo(0.5, 2);
    expect(pageColumns(cols(9, 55))).toEqual({ kind: 'one' });
    expect(gutterOf(pageColumns(cols(55, 10)))).toBeCloseTo(0.5, 2);
    expect(pageColumns(cols(55, 9))).toEqual({ kind: 'one' });
  });
  it('boundary (A-F4-03): a gutter narrower than the 0.01 band → one; 0.012 wide → two', () => {
    const cols = (end: number, start: number) => [...ys(55).map((y) => line(0.08, y, end - 0.08)), ...ys(55).map((y) => line(start, y, 0.92 - start))];
    expect(pageColumns(cols(0.496, 0.504))).toEqual({ kind: 'one' });
    expect(gutterOf(pageColumns(cols(0.494, 0.506)))).toBeCloseTo(0.5, 2);
  });
  it('boundary (A-F4-03): a gutter just inside either end of the 0.35–0.65 window → two; just past the upper end → one', () => {
    const cols = (end: number, start: number) => [...ys(55).map((y) => line(0.08, y, end - 0.08)), ...ys(55).map((y) => line(start, y, 0.92 - start))];
    expect(gutterOf(pageColumns(cols(0.632, 0.646)))).toBeCloseTo(0.639, 2); // band 0.6325–0.645
    expect(gutterOf(pageColumns(cols(0.352, 0.366)))).toBeCloseTo(0.359, 2); // band 0.3525–0.365
    expect(pageColumns(cols(0.66, 0.675))).toEqual({ kind: 'one' }); // the band would end past 0.65
  });
  it('the band may be crossed by lines covering at most half of the line height', () => {
    const cols = [...ys(30, 0.05).map((y) => line(0.08, y, 0.41)), ...ys(30, 0.05).map((y) => line(0.51, y, 0.41))]; // 30 rows: 0.39
    const full = (n: number) => ys(n, 0.55, 0.014).map((y) => line(0.08, y, 0.84)); // n rows across the gutter
    expect(pageColumns([...cols, ...full(25)]).kind).toBe('two'); // 0.325 / 0.715 = 45 %
    expect(pageColumns([...cols, ...full(32)])).toEqual({ kind: 'one' }); // 0.416 / 0.806 = 52 %
  });
});

describe('headingBeforeArea on a layout', () => {
  const two: PageColumns = { kind: 'two', gutter: 0.5 };
  const r = (x: number, y: number, w: number, h = 0.02): NormRect => ({ page: 2, x, y, w, h });
  it('reviewer case (A): a centred heading numeral, an area in the same column above it but right of the numeral → not before', () => {
    expect(headingBeforeArea(r(0.215, 0.865, 0.036), r(0.28, 0.785, 0.2), two)).toBe(false);
  });
  it('reviewer case (B): a centred heading numeral, a narrow area left of it below it in the same column → before', () => {
    expect(headingBeforeArea(r(0.2, 0.58, 0.041), r(0.08, 0.62, 0.1), two)).toBe(true);
  });
  it('an earlier column is before whatever the height; a later column never is', () => {
    expect(headingBeforeArea(r(0.08, 0.9, 0.3), r(0.52, 0.1, 0.3), two)).toBe(true);
    expect(headingBeforeArea(r(0.52, 0.1, 0.3), r(0.08, 0.9, 0.3), two)).toBe(false);
  });
  it('the same column: before when its top is at or above the area top', () => {
    expect(headingBeforeArea(r(0.6, 0.4, 0.2), r(0.52, 0.4, 0.4), two)).toBe(true);
    expect(headingBeforeArea(r(0.6, 0.41, 0.2), r(0.52, 0.4, 0.4), two)).toBe(false);
  });
  it('a full-width area (≥ 0.05 past the gutter on both sides) compares heights only; less reach is a column', () => {
    expect(headingBeforeArea(r(0.52, 0.1, 0.2), r(0.08, 0.3, 0.84), two)).toBe(true);
    expect(headingBeforeArea(r(0.08, 0.5, 0.2), r(0.08, 0.3, 0.84), two)).toBe(false);
    const reach = COLUMN_RULE.fullWidthReach;
    expect(headingBeforeArea(r(0.52, 0.1, 0.2), r(0.5 - reach, 0.3, 2 * reach), two)).toBe(true); // full width, H above
    // 0.04 left / 0.03 right of the gutter: not full width, centre 0.495 → the left column; H in the right one
    expect(headingBeforeArea(r(0.52, 0.1, 0.2), r(0.46, 0.3, 0.07), two)).toBe(false);
  });
  it('A-F6-02: the full-width reach is 0.05 — fixed pairs 0.045 / 0.055 past the gutter on each side', () => {
    // H in the left column below the area top: an area reaching 0.045 left of the gutter is a right-column area
    // (centre 0.5775 → H's column is earlier → before); reaching 0.055 it is full width (heights → H below → not before)
    expect(headingBeforeArea(r(0.08, 0.5, 0.2), r(0.455, 0.3, 0.245), two)).toBe(true);
    expect(headingBeforeArea(r(0.08, 0.5, 0.2), r(0.445, 0.3, 0.255), two)).toBe(false);
    // H in the right column above the area top: an area x 0.3–0.545 is a left-column area (H's column is later → not
    // before); x 0.3–0.555 is full width (heights → H above → before)
    expect(headingBeforeArea(r(0.6, 0.1, 0.2), r(0.3, 0.3, 0.245), two)).toBe(false);
    expect(headingBeforeArea(r(0.6, 0.1, 0.2), r(0.3, 0.3, 0.255), two)).toBe(true);
  });
  it('one column: heights only', () => {
    expect(headingBeforeArea(r(0.6, 0.3, 0.2), r(0.08, 0.5, 0.1), { kind: 'one' })).toBe(true);
    expect(headingBeforeArea(r(0.08, 0.6, 0.2), r(0.6, 0.5, 0.1), { kind: 'one' })).toBe(false);
  });
});

// ---- the route on the seed paper with injected layouts -----------------------------------------------------------
let s: TestServer;
const P = SEED_M2_PAPER_ID;
const H = {
  P1: { id: 'col-p1', page: 1, offset: 10, rect: { page: 1, x: 0.08, y: 0.1, w: 0.2, h: 0.02 } },
  P1b: { id: 'col-p1b', page: 1, offset: 50, rect: { page: 1, x: 0.55, y: 0.5, w: 0.2, h: 0.02 } },
  L1: { id: 'col-l1', page: 2, offset: 100, rect: { page: 2, x: 0.08, y: 0.15, w: 0.25, h: 0.02 } },
  // a centred level-1 heading: the stored rect is its numeral only (KISS-ICP / FAST-LIO2: w 0.025–0.041)
  LC: { id: 'col-lc', page: 2, offset: 250, rect: { page: 2, x: 0.27, y: 0.4, w: 0.03, h: 0.02 } },
  L2: { id: 'col-l2', page: 2, offset: 400, rect: { page: 2, x: 0.08, y: 0.55, w: 0.3, h: 0.02 } },
  R1: { id: 'col-r1', page: 2, offset: 900, rect: { page: 2, x: 0.52, y: 0.3, w: 0.2, h: 0.02 } },
};
/** Store a page's items as pdfText does; `padTo` pads the JSON with trailing spaces to that many characters. */
function setPage(page: number, items: LayoutItem[] | null, padTo?: number): void {
  if (items === null) {
    s.deps.sqlite.prepare('DELETE FROM page_texts WHERE paperId = ? AND page = ?').run(P, page);
    return;
  }
  let text = '';
  const stored = items.map((i) => {
    const start = text.length;
    text += 'abcde\n';
    return { start, len: i.len, rect: { page, ...i.rect } };
  });
  let json = JSON.stringify(stored);
  if (padTo !== undefined) {
    expect(json.length).toBeLessThanOrEqual(padTo);
    json += ' '.repeat(padTo - json.length);
  }
  s.deps.sqlite.prepare("INSERT OR REPLACE INTO page_texts (paperId, page, text, itemsJson, pdfjsVersion) VALUES (?, ?, ?, ?, 'test')").run(P, page, text, json);
}
beforeAll(async () => {
  s = await startTestServer({ env: 'test', papers: ['m2'] });
  // replace the seed's anchored sections by the layout above; page 1 is one column, page 2 two columns
  s.deps.sqlite.prepare('DELETE FROM sections WHERE paperId = ?').run(P);
  const ins = s.deps.sqlite.prepare('INSERT INTO sections (id, paperId, parentId, htmlId, number, title, level, ordinal, contentMd, pdfPage, pdfOffset, pdfRectJson) VALUES (?, ?, NULL, NULL, NULL, ?, 1, ?, NULL, ?, ?, ?)');
  [...Object.values(H), P3].forEach((h, i) => ins.run(h.id, P, h.id, i, h.page, h.offset, JSON.stringify(h.rect)));
  s.deps.sqlite.prepare('UPDATE papers SET pageCount = 3 WHERE id = ?').run(P);
  setPage(1, oneColumn());
  setPage(2, twoColumnsWithFloats());
  setPage(3, listing());
});
afterAll(async () => {
  await s.close();
});
/** Page 3 (the seed has 2; the test raises pageCount): a code listing (one column) with heading P3 left at y 0.252. */
const P3 = { id: 'col-p3', page: 3, offset: 20, rect: { page: 3, x: 0.196, y: 0.252, w: 0.198, h: 0.018 } };
async function areaSection(page: number, x: number, y: number, w: number, h: number): Promise<string | null> {
  const r = await s.req(`/api/papers/${P}/highlights`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'area', color: 1, page, rects: [{ page, x, y, w, h }] }) });
  expect(r.status).toBe(200);
  return (JSON.parse(r.text) as HighlightDto).sectionId;
}

describe('area highlight sectionId from the page layout', () => {
  it('an area in the left column → the last left-column heading above it (not the right column heading with a larger offset)', async () => {
    expect(await areaSection(2, 0.08, 0.3, 0.38, 0.05)).toBe(H.L1.id);
    expect(await areaSection(2, 0.08, 0.45, 0.38, 0.05)).toBe(H.LC.id);
    expect(await areaSection(2, 0.08, 0.7, 0.38, 0.1)).toBe(H.L2.id);
  });
  it('reviewer case (A): an area right of the centred numeral, above it in the same column → the heading before (not LC)', async () => {
    expect(await areaSection(2, 0.33, 0.3, 0.15, 0.05)).toBe(H.L1.id);
  });
  it('reviewer case (B): a narrow area left of the centred numeral, below it → LC (not the one before)', async () => {
    expect(await areaSection(2, 0.08, 0.45, 0.1, 0.05)).toBe(H.LC.id);
  });
  it('an area at the top of the right column → the last heading of the left column on the same page', async () => {
    expect(await areaSection(2, 0.52, 0.05, 0.4, 0.1)).toBe(H.L2.id);
    expect(await areaSection(2, 0.51, 0.05, 0.04, 0.05)).toBe(H.L2.id); // narrow, at the gutter
  });
  it('an area in the right column below its heading → that heading (the left column ones have smaller offsets)', async () => {
    expect(await areaSection(2, 0.52, 0.5, 0.4, 0.1)).toBe(H.R1.id);
  });
  it('a figure across both columns at the top of the page → the last heading of the page before', async () => {
    expect(await areaSection(2, 0.08, 0.02, 0.84, 0.1)).toBe(H.P1b.id);
  });
  it('a one-column page compares heights only: an area below a heading in the right half → that heading', async () => {
    expect(await areaSection(1, 0.08, 0.6, 0.3, 0.05)).toBe(H.P1b.id);
    expect(await areaSection(1, 0.6, 0.3, 0.3, 0.05)).toBe(H.P1.id);
  });
  it('A-F4-01: on a code-listing page (one column) an area above the heading and right of x 0.64 is not after it', async () => {
    // shared-mime-info-spec.pdf p7: heading "2.4. The glob files" (x 0.196, y 0.252), area x 0.654–0.854 at y 0.102
    expect(await areaSection(3, 0.654, 0.102, 0.2, 0.05)).toBe(H.R1.id); // the last heading of page 2, not P3
    expect(await areaSection(3, 0.654, 0.4, 0.2, 0.05)).toBe(P3.id);
  });
  it('a page with almost no text is one column', async () => {
    setPage(1, [line(0.08, 0.1, 0.3), line(0.6, 0.1, 0.3)]);
    try {
      expect(await areaSection(1, 0.08, 0.6, 0.3, 0.05)).toBe(H.P1b.id);
    } finally {
      setPage(1, oneColumn());
    }
  });
  it('the same page as two columns changes the answer (the layout is read from page_texts)', async () => {
    setPage(1, twoColumns());
    try {
      expect(await areaSection(1, 0.08, 0.6, 0.3, 0.05)).toBe(H.P1.id); // P1b is in the right column
    } finally {
      setPage(1, oneColumn());
    }
  });
  it('a heading on the page without a rect, or the page without a readable text layout → unknown (null)', async () => {
    s.deps.sqlite.prepare('UPDATE sections SET pdfRectJson = NULL WHERE id = ?').run(H.R1.id);
    try {
      expect(await areaSection(2, 0.08, 0.7, 0.38, 0.1)).toBeNull();
    } finally {
      s.deps.sqlite.prepare('UPDATE sections SET pdfRectJson = ? WHERE id = ?').run(JSON.stringify(H.R1.rect), H.R1.id);
    }
    const unreadable = ['{not json', JSON.stringify(Array.from({ length: COLUMN_RULE.maxItems + 1 }, () => ({ start: 0, len: 1, rect: { page: 2, x: 0.1, y: 0.1, w: 0.1, h: 0.01 } })))];
    for (const itemsJson of [null, ...unreadable]) {
      if (itemsJson === null) setPage(2, null);
      else s.deps.sqlite.prepare('UPDATE page_texts SET itemsJson = ? WHERE paperId = ? AND page = 2').run(itemsJson, P);
      try {
        expect(await areaSection(2, 0.08, 0.7, 0.38, 0.1), itemsJson?.slice(0, 20) ?? 'no row').toBeNull();
      } finally {
        setPage(2, twoColumnsWithFloats());
      }
    }
  });
});

describe('bounded work of the layout (A-F4-02)', () => {
  /** `n` items, two columns side by side (n/2 lines each), rows overlapping in y. */
  const dense = (n: number): LayoutItem[] => Array.from({ length: n }, (_, k) => line(k % 2 ? 0.51 : 0.08, 0.05 + (k >> 1) * (0.85 / (n / 2)), 0.41));
  it('the worst shape at the item cap (every item a line crossing every band position): visits ≤ (4 × 117 + 12) per item', () => {
    expect(BAND_POSITIONS).toBe(117);
    const n = COLUMN_RULE.maxItems;
    const work = { itemVisits: 0 };
    const cross = Array.from({ length: n }, (_, k) => line(0.2 + (k % 7) * 0.001, (k % 997) / 1000, 0.6));
    expect(pageColumns(cross, work)).toEqual({ kind: 'one' });
    expect(work.itemVisits).toBeGreaterThan(4 * BAND_POSITIONS * n * 0.9); // the shape is the worst one
    expect(work.itemVisits).toBeLessThanOrEqual((4 * BAND_POSITIONS + 12) * n);
    const work2 = { itemVisits: 0 };
    expect(pageColumns(dense(n), work2).kind).toBe('two');
    expect(work2.itemVisits).toBeLessThanOrEqual((4 * BAND_POSITIONS + 12) * n);
  });
  it('the item cap is 4,000: exactly 4,000 items are laid out, 4,001 are unknown (null)', async () => {
    expect(COLUMN_RULE.maxItems).toBe(4_000);
    try {
      setPage(2, dense(COLUMN_RULE.maxItems));
      expect(await areaSection(2, 0.08, 0.7, 0.38, 0.1)).toBe(H.L2.id);
      setPage(2, [...dense(COLUMN_RULE.maxItems), line(0.08, 0.95, 0.1)]);
      expect(await areaSection(2, 0.08, 0.7, 0.38, 0.1)).toBeNull();
    } finally {
      setPage(2, twoColumnsWithFloats());
    }
  });
  it('itemsJson longer than 640,000 characters is unknown without being read or parsed; exactly 640,000 is laid out', async () => {
    expect(COLUMN_RULE.maxItemsJsonChars).toBe(640_000);
    expect(COLUMN_RULE.maxItemsJsonChars).toBeGreaterThanOrEqual(COLUMN_RULE.maxItems * 160);
    try {
      setPage(2, twoColumnsWithFloats(), COLUMN_RULE.maxItemsJsonChars);
      expect(await areaSection(2, 0.08, 0.7, 0.38, 0.1)).toBe(H.L2.id);
      setPage(2, twoColumnsWithFloats(), COLUMN_RULE.maxItemsJsonChars + 1);
      expect(await areaSection(2, 0.08, 0.7, 0.38, 0.1)).toBeNull();
      const parse = vi.spyOn(JSON, 'parse');
      try {
        expect(storedPageColumns(s.deps, P, 2)).toBeNull();
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    } finally {
      setPage(2, twoColumnsWithFloats());
    }
    expect(storedPageColumns(s.deps, P, 2)).toEqual({ kind: 'two', gutter: expect.closeTo(0.5, 2) as unknown as number });
  });
});

// ---- the reviewer's probe on the real papers ------------------------------------------------------------------------
describe('real papers: heading positions from parse → extractPageTexts → anchorStructure (skipped without the fixtures)', () => {
  const FIX = join(process.env.SP_DATA_DIR ?? '/nonexistent', 'fixtures');
  // Both are IEEE two-column on every page: columns x 0.08–0.49 / 0.51–0.92 (the anchored heading x values show it).
  const COLS: [number, number][] = [
    [0.08, 0.49],
    [0.51, 0.92],
  ];
  for (const [id, minChecks] of [
    ['2209.15397v2', 250],
    ['2107.06829v1', 700],
  ] as const) {
    const ok = existsSync(join(FIX, `${id}.html`)) && existsSync(join(FIX, `${id}.pdf`));
    it.skipIf(!ok)(`${id}: every page two columns at 0.5; areas in the heading's column (5 starts + the inner edge) above / below, in the other column, full width → 0 misjudged`, async () => {
      const st = parse(readFileSync(join(FIX, `${id}.html`), 'utf8'));
      const ex = await extractPageTexts(new Uint8Array(readFileSync(join(FIX, `${id}.pdf`))));
      const pages = ex.pages.map((p) => ({ page: p.page, text: p.text, items: p.items }));
      const r = await anchorStructure(st.sections, st.equations, st.figures, pages);
      const layouts = pages.map((p) => pageColumns(p.items));
      expect(layouts.map((l) => (l.kind === 'two' && Math.abs(l.gutter - 0.5) < 0.01 ? 'two@0.5' : JSON.stringify(l)))).toEqual(layouts.map(() => 'two@0.5'));
      const wrong: string[] = [];
      let n = 0;
      st.sections.forEach((sec, i) => {
        const a = r.sections[i];
        if (!a?.rect) return;
        const h = a.rect;
        const layout = layouts[a.page - 1]!;
        const col = h.x + h.w / 2 < 0.5 ? 0 : 1;
        const [L, R] = COLS[col]!;
        const [oL, oR] = COLS[1 - col]!;
        const check = (area: NormRect, want: boolean, what: string) => {
          n++;
          if (headingBeforeArea(h, area, layout) !== want) wrong.push(`${sec.number} p${a.page} ${what}`);
        };
        for (const [where, y, want] of [
          ['above', h.y - 0.06, false],
          ['below', h.y + h.h + 0.01, true],
        ] as const) {
          if (y < 0 || y > 0.95) continue;
          for (const d of [0, 0.05, 0.1, 0.15, 0.2]) check({ page: a.page, x: L + d, y, w: Math.min(0.15, R - L - d), h: 0.03 }, want, `same column +${d} ${where}`);
          check({ page: a.page, x: col === 0 ? 0.45 : 0.51, y, w: 0.04, h: 0.03 }, want, `inner edge ${where}`);
          check({ page: a.page, x: oL + 0.05, y, w: Math.min(0.2, oR - oL - 0.05), h: 0.03 }, col === 0, `other column ${where}`);
          check({ page: a.page, x: 0.08, y, w: 0.84, h: 0.03 }, want, `full width ${where}`);
        }
      });
      expect(wrong).toEqual([]);
      expect(n).toBeGreaterThan(minChecks);
      console.log(`[columns] ${id}: ${layouts.length} pages two columns at 0.5, ${n} areas, 0 misjudged`);
    }, 60_000);
  }
});
