// Current section on two-column pages (C 수정 3, C-I10-01 — AD_COORDINATOR_NOTES 추가 지시 8): the heading
// positions of both gold papers (05_m2/gold/adjudication_work/geometry.txt — page, x and y of each heading's first
// text item; only the numbers are copied here) as SectionDto. Requirements: scrolling down never moves the current
// section back in document order, every anchored heading is current at some scroll position, KISS-ICP p4 top 0.40 is
// III-B (left column text, III-C still below, III-D in the right column), one-column and full-width layouts give the
// same answer as the plain (page, y) rule, and a selection picks its section from its own (page, column, y).
import { describe, expect, it } from 'vitest';
import type { SectionDto } from '@study-paper/shared/contracts/api';
import type { NormRect } from '@study-paper/shared/contracts/domain';
import { currentSectionAt, sectionAtRect, selectionSectionId } from '../../src/viewer/sections';

type Row = [id: string, page: number, x: number, y: number];
const KISS_ICP: Row[] = [
  ['S1', 1, 0.6514, 0.6093], ['S2', 2, 0.2149, 0.8651], ['S3', 3, 0.1234, 0.3776], ['S3.SS1', 3, 0.08, 0.7266],
  ['S3.SS2', 4, 0.08, 0.148], ['S3.SS3', 4, 0.08, 0.7291], ['S3.SS4', 4, 0.5098, 0.2516], ['S3.SS5', 5, 0.08, 0.4238],
  ['S3.SS6', 5, 0.5098, 0.6957], ['S4', 6, 0.168, 0.193], ['S4.SS1', 6, 0.08, 0.3808], ['S4.SS2', 6, 0.08, 0.6591],
  ['S4.SS3', 6, 0.5098, 0.3356], ['S4.SS4', 7, 0.08, 0.5733], ['S4.SS4.SSS1', 7, 0.0963, 0.6877], ['S4.SS4.SSS2', 7, 0.526, 0.5345],
  ['S5', 7, 0.6565, 0.8801], ['S6', 8, 0.1898, 0.4348],
];
const FAST_LIO2: Row[] = [
  ['S1', 1, 0.2216, 0.5944], ['S2', 2, 0.6407, 0.0688], ['S2.SS1', 2, 0.5098, 0.0916], ['S2.SS2', 3, 0.08, 0.8482],
  ['S3', 4, 0.2004, 0.5805], ['S4', 4, 0.2027, 0.8955], ['S4.SS1', 4, 0.5098, 0.3434], ['S4.SS1.SSS1', 4, 0.526, 0.3915],
  ['S4.SS1.SSS2', 5, 0.0963, 0.2449], ['S4.SS2', 5, 0.08, 0.8492], ['S4.SS2.SSS1', 5, 0.526, 0.1603], ['S4.SS2.SSS2', 5, 0.526, 0.4629],
  ['S4.SS2.SSS3', 5, 0.526, 0.8021], ['S5', 6, 0.2402, 0.7344], ['S5.SS1', 6, 0.08, 0.8496], ['S5.SS2', 7, 0.08, 0.0688],
  ['S5.SS2.SSS1', 7, 0.0963, 0.089], ['S5.SS2.SSS2', 7, 0.0963, 0.7051], ['S5.SS3', 7, 0.08, 0.8184], ['S5.SS3.SSS1', 7, 0.526, 0.3968],
  ['S5.SS3.SSS2', 7, 0.526, 0.8537], ['S5.SS3.SSS3', 8, 0.0963, 0.899], ['S5.SS4', 8, 0.5098, 0.5218], ['S5.SS4.SSS1', 8, 0.526, 0.5873],
  ['S5.SS4.SSS2', 9, 0.0963, 0.28], ['S5.SS5', 9, 0.5098, 0.6536], ['S5.SS6', 10, 0.08, 0.1653], ['S5.SS6.SSS1', 10, 0.0963, 0.2606],
  ['S5.SS6.SSS2', 10, 0.526, 0.1843], ['S5.SS6.SSS3', 10, 0.526, 0.4262], ['S6', 10, 0.6195, 0.5665], ['S6.SS1', 11, 0.08, 0.5723],
  ['S6.SS2', 11, 0.5098, 0.0688], ['S6.SS2.SSS1', 11, 0.526, 0.0943], ['S6.SS2.SSS2', 11, 0.526, 0.6424], ['S6.SS3', 12, 0.5098, 0.7893],
  ['S6.SS3.SSS1', 13, 0.0963, 0.5345], ['S6.SS3.SSS2', 13, 0.526, 0.378], ['S6.SS4', 13, 0.5098, 0.6838], ['S7', 14, 0.1656, 0.8284],
  ['S7.SS1', 14, 0.08, 0.8489], ['S7.SS2', 14, 0.5098, 0.5657], ['S7.SS2.SSS1', 14, 0.526, 0.5863], ['S7.SS2.SSS2', 16, 0.0963, 0.8235],
  ['S7.SS2.SSS3', 16, 0.526, 0.8537], ['S7.SS3', 17, 0.08, 0.7279], ['S8', 17, 0.6461, 0.2651], ['Sx1', 17, 0.6395, 0.5709],
];

/** dx shifts every heading box sideways (a page whose text block sits off the page centre — twoside margins). */
const asSections = (rows: Row[], w: number, dx = 0): SectionDto[] =>
  rows.map(([id, page, x0, y], i) => {
    const x = x0 + dx;
    return { id, ordinal: i, level: 1, parentId: null, number: null, title: id, htmlId: id, pdfPage: page, pdfOffset: null, pdfRect: { page, x, y, w: Math.min(w, 1 - x), h: 0.0126 } };
  });

const STEPS = 2000;
/** Every (page, top) at 1/2000 steps in scroll order, with the current section's ordinal (-1 = none). */
function sweep(sections: SectionDto[]): { seen: Set<string>; backwards: string[] } {
  const ord = new Map(sections.map((s) => [s.id, s.ordinal] as const));
  const pages = Math.max(...sections.map((s) => s.pdfPage ?? 1)) + 1;
  const seen = new Set<string>();
  const backwards: string[] = [];
  let prev = -1;
  for (let page = 1; page <= pages; page++) {
    for (let k = 0; k <= STEPS; k++) {
      const cur = currentSectionAt(sections, { page, top: k / STEPS });
      const o = cur === null ? -1 : ord.get(cur)!;
      if (o < prev) backwards.push(`p${page} top ${k / STEPS}: ${cur}`);
      prev = Math.max(prev, o);
      if (cur) seen.add(cur);
    }
  }
  return { seen, backwards };
}

describe('current section on two-column pages (gold heading positions)', () => {
  // w: the probe's 0.2 and a narrow first item (a small-caps heading splits into short items)
  for (const w of [0.2, 0.02]) {
    it(`KISS-ICP: 18/18 headings become current, never backwards (w ${w})`, () => {
      const sections = asSections(KISS_ICP, w);
      const { seen, backwards } = sweep(sections);
      expect(backwards).toEqual([]);
      expect(KISS_ICP.map((r) => r[0]).filter((id) => !seen.has(id))).toEqual([]);
      expect(seen.size).toBe(18);
    });

    it(`FAST-LIO2: 48/48 headings become current, never backwards (w ${w})`, () => {
      const sections = asSections(FAST_LIO2, w);
      const { seen, backwards } = sweep(sections);
      expect(backwards).toEqual([]);
      expect(FAST_LIO2.map((r) => r[0]).filter((id) => !seen.has(id))).toEqual([]);
      expect(seen.size).toBe(48);
    });
  }

  // C3-R1-01: the right column may start a little left of the page middle (gold margin to the middle is 0.0098), or
  // the left column a little further right; the column comes from the box centre, so the rule holds under ±0.02 for
  // heading boxes of real width (ingested right-column-edge headings are 0.08–0.41 wide). A 0.02-wide first item at the
  // right column's edge stays right while its centre does (dx ≥ −0.0198); at dx −0.02 it sits on the middle.
  const shifts: [dx: number, w: number][] = [[-0.02, 0.2], [0.02, 0.2], [-0.012, 0.2], [-0.012, 0.02], [-0.015, 0.02], [0.02, 0.02]];
  for (const [dx, w] of shifts) {
    it(`text block shifted dx ${dx} (w ${w}): KISS-ICP 18/18 and FAST-LIO2 48/48 still current, never backwards`, () => {
      for (const rows of [KISS_ICP, FAST_LIO2]) {
        const { seen, backwards } = sweep(asSections(rows, w, dx));
        expect(backwards).toEqual([]);
        expect(rows.map((r) => r[0]).filter((id) => !seen.has(id))).toEqual([]);
      }
      const kiss = asSections(KISS_ICP, w, dx);
      expect(currentSectionAt(kiss, { page: 4, top: 0.4 })).toBe('S3.SS2');
      expect(currentSectionAt(kiss, { page: 4, top: 0.99 })).toBe('S3.SS4');
    });
  }

  it('KISS-ICP p4: top 0.40 is III-B (III-C still below in the left column, III-D waits for the right column)', () => {
    const sections = asSections(KISS_ICP, 0.2);
    expect(currentSectionAt(sections, { page: 4, top: 0.4 })).toBe('S3.SS2');
    expect(currentSectionAt(sections, { page: 4, top: 0.1 })).toBe('S3.SS1'); // III-A continues at the top of p4
    expect(currentSectionAt(sections, { page: 4, top: 0.73 })).toBe('S3.SS3'); // III-C reaches the top
    expect(currentSectionAt(sections, { page: 4, top: 0.99 })).toBe('S3.SS4'); // then the right column's III-D
    expect(currentSectionAt(sections, { page: 5, top: 0.1 })).toBe('S3.SS4');
  });
});

/** The plain rule (before C 수정 3): the last anchored heading, in ordinal order, at or above (page, top). */
function plainRule(sections: SectionDto[], pos: { page: number; top: number }): string | null {
  let current: string | null = null;
  for (const s of [...sections].sort((a, b) => a.ordinal - b.ordinal)) {
    if (s.pdfPage === null) continue;
    const y = s.pdfRect && s.pdfRect.page === s.pdfPage ? s.pdfRect.y : 0;
    if (s.pdfPage < pos.page || (s.pdfPage === pos.page && y <= pos.top)) current = s.id;
  }
  return current;
}

/** mulberry32 — fixed seed, Math.imul based. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('one-column and full-width layouts keep the plain (page, y) rule', () => {
  it('fixed-seed random one-column papers (left-aligned, centred and full-width headings): same answer everywhere', () => {
    const r = rng(20261117);
    for (let paper = 0; paper < 40; paper++) {
      const n = 3 + Math.floor(r() * 20);
      const raw = Array.from({ length: n }, () => {
        const page = 1 + Math.floor(r() * 6);
        const kind = r();
        // left-aligned at the margin, centred on the page (crosses the middle), or full width
        const w = kind < 0.4 ? 0.05 + r() * 0.4 : kind < 0.8 ? 0.1 + r() * 0.3 : 0.8;
        const x = kind < 0.4 ? 0.08 + r() * 0.02 : kind < 0.8 ? 0.5 - w / 2 + (r() - 0.5) * 0.02 : 0.1;
        return { page, x, y: r() * 0.97, w };
      });
      raw.sort((a, b) => a.page - b.page || a.y - b.y);
      const sections: SectionDto[] = raw.map((h, i) => ({
        id: `s${i}`, ordinal: i, level: 1, parentId: null, number: null, title: `s${i}`, htmlId: null,
        pdfPage: h.page, pdfOffset: null, pdfRect: { page: h.page, x: h.x, y: h.y, w: h.w, h: 0.012 },
      }));
      for (let page = 1; page <= 7; page++) {
        for (let k = 0; k <= 200; k++) {
          const pos = { page, top: k / 200 };
          expect(currentSectionAt(sections, pos), `paper ${paper} p${page} top ${pos.top}`).toBe(plainRule(sections, pos));
        }
      }
    }
  });
});

describe('section of a selection (page, column, y of its first rect)', () => {
  const sections = asSections(KISS_ICP, 0.2);
  const at = (page: number, x: number, y: number, w = 0.3): NormRect => ({ page, x, y, w, h: 0.012 });

  it('left column follows the left headings, right column text before its first heading is still the left column’s last section', () => {
    expect(sectionAtRect(sections, at(4, 0.08, 0.4))).toBe('S3.SS2'); // III-B body
    expect(sectionAtRect(sections, at(4, 0.08, 0.8))).toBe('S3.SS3'); // under III-C
    expect(sectionAtRect(sections, at(4, 0.52, 0.1))).toBe('S3.SS3'); // right column, above III-D: III-C continues
    expect(sectionAtRect(sections, at(4, 0.52, 0.3))).toBe('S3.SS4'); // under III-D
    expect(sectionAtRect(sections, at(5, 0.08, 0.1))).toBe('S3.SS4'); // top of p5 left column
    expect(sectionAtRect(sections, at(1, 0.08, 0.1))).toBeNull(); // before the first heading
  });

  it('text block shifted ±0.02 (C3-R1-01): left and right column body rects keep their sections', () => {
    for (const dx of [-0.02, -0.012, 0.02]) {
      const shifted = asSections(KISS_ICP, 0.2, dx);
      const body = (page: number, x: number, y: number): NormRect => ({ page, x: x + dx, y, w: 0.41, h: 0.012 });
      expect(sectionAtRect(shifted, body(4, 0.08, 0.4)), `dx ${dx}`).toBe('S3.SS2'); // III-B body
      expect(sectionAtRect(shifted, body(4, 0.5098, 0.1)), `dx ${dx}`).toBe('S3.SS3'); // right column above III-D
      expect(sectionAtRect(shifted, body(4, 0.5098, 0.3)), `dx ${dx}`).toBe('S3.SS4'); // under III-D
      // a narrow first item of a right-column heading and a short right-column line
      expect(sectionAtRect(asSections(KISS_ICP, 0.02, dx), { page: 4, x: 0.5098 + dx, y: 0.3, w: 0.05, h: 0.012 })).toBe('S3.SS4');
    }
  });

  it('a full-width rect counts as the left column; no rect or an unanchored list gives null', () => {
    expect(sectionAtRect(sections, at(4, 0.1, 0.4, 0.8))).toBe('S3.SS2');
    expect(sectionAtRect(sections, null)).toBeNull();
    expect(sectionAtRect([], at(4, 0.1, 0.4))).toBeNull();
  });
});

describe('selectionSectionId (the sectionId of a note / question on a selection)', () => {
  const sections = asSections(KISS_ICP, 0.2);
  const r = (page: number, x: number, y: number): NormRect => ({ page, x, y, w: 0.38, h: 0.012 });
  const anchor = (rects: NormRect[]) => ({ kind: 'text' as const, quote: { exact: 'x', prefix: '', suffix: '' }, rects });

  it('note and ask get the section of the selection’s first rect in reading order; other kinds and no structure get null', () => {
    const a = anchor([r(4, 0.08, 0.4)]);
    expect(selectionSectionId('note', sections, a)).toBe('S3.SS2');
    expect(selectionSectionId('ask', sections, a)).toBe('S3.SS2');
    for (const k of ['explain', 'translate', 'glossary']) expect(selectionSectionId(k, sections, a)).toBeNull();
    expect(selectionSectionId('note', undefined, a)).toBeNull();
  });

  it('a selection from the bottom of the left column into the right column starts at its left rect (rects are sorted by y)', () => {
    // under III-C (left y .729) at y .95, continued at the top of the right column (y .05, above III-D)
    const a = anchor([r(4, 0.52, 0.05), r(4, 0.08, 0.95)]);
    expect(selectionSectionId('note', sections, a)).toBe('S3.SS3');
    // a selection in the right column under III-D
    expect(selectionSectionId('ask', sections, anchor([r(4, 0.52, 0.31), r(4, 0.52, 0.33)]))).toBe('S3.SS4');
  });
});

// C3-R2-01: a selection rect is the selected part of each line only, so in a one-column paper a selection in the right
// half of a line has its centre right of the middle. Its column is used only when the paper shows two columns (some
// anchored heading is in the right column); otherwise the selection follows the plain (page, y) rule like the viewport.
/** The plain rule for a selection rect: the last anchored heading, in ordinal order, at or above (page, centre y — C3-R3-01). */
function plainRectRule(sections: SectionDto[], rect: NormRect): string | null {
  return plainRule(sections, { page: rect.page, top: rect.y + rect.h / 2 });
}

describe('section of a selection in a one-column paper keeps the plain (page, y) rule (C3-R2-01)', () => {
  const mk = (rows: [id: string, page: number, x: number, y: number, w: number][]): SectionDto[] =>
    rows.map(([id, page, x, y, w], i) => ({ id, ordinal: i, level: 1, parentId: null, number: null, title: id, htmlId: id, pdfPage: page, pdfOffset: null, pdfRect: { page, x, y, w, h: 0.012 } }));
  // left-aligned headings at the text block's left edge (x 0.147 = 1.25 in of 8.5 in) — the reviewer's probe paper
  const left = mk([['1 Intro', 1, 0.147, 0.3, 0.16], ['2 Method', 2, 0.147, 0.2, 0.12], ['3 Results', 2, 0.147, 0.7, 0.12], ['4 Concl', 3, 0.147, 0.5, 0.14]]);
  const sel = (page: number, x: number, y: number, w: number): NormRect => ({ page, x, y, w, h: 0.012 });
  const anchor = (rects: NormRect[]) => ({ kind: 'text' as const, quote: { exact: 'x', prefix: '', suffix: '' }, rects });

  it('left half, right half and line end of one line give the section above it; before the first heading is null', () => {
    expect(sectionAtRect(left, sel(2, 0.2, 0.4, 0.15))).toBe('2 Method');
    expect(sectionAtRect(left, sel(2, 0.6, 0.4, 0.15))).toBe('2 Method'); // right half (centre 0.675)
    expect(sectionAtRect(left, sel(2, 0.55, 0.4, 0.3))).toBe('2 Method'); // from mid-line to the line end
    expect(sectionAtRect(left, sel(2, 0.6, 0.1, 0.15))).toBe('1 Intro'); // above "2 Method": the previous page's section
    expect(sectionAtRect(left, sel(1, 0.6, 0.1, 0.15))).toBeNull(); // before the first heading
    expect(selectionSectionId('note', left, anchor([sel(2, 0.6, 0.4, 0.15)]))).toBe('2 Method');
    expect(selectionSectionId('ask', left, anchor([sel(1, 0.6, 0.1, 0.15)]))).toBeNull();
    // a selection running from the right half of a line above "3 Results" over it into the next section starts above it
    expect(selectionSectionId('note', left, anchor([sel(2, 0.6, 0.68, 0.25), sel(2, 0.147, 0.7, 0.12), sel(2, 0.147, 0.715, 0.4)]))).toBe('2 Method');
  });

  it('fixed-seed random one-column papers (left-aligned, centred and full-width headings) × single-line selections anywhere on a line', () => {
    const r = rng(20261118);
    for (let paper = 0; paper < 40; paper++) {
      const n = 3 + Math.floor(r() * 20);
      const raw = Array.from({ length: n }, () => {
        const page = 1 + Math.floor(r() * 6);
        const kind = r();
        const w = kind < 0.4 ? 0.05 + r() * 0.4 : kind < 0.8 ? 0.1 + r() * 0.3 : 0.8;
        const x = kind < 0.4 ? 0.08 + r() * 0.07 : kind < 0.8 ? 0.5 - w / 2 + (r() - 0.5) * 0.02 : 0.1;
        return { page, x, y: r() * 0.97, w };
      });
      raw.sort((a, b) => a.page - b.page || a.y - b.y);
      const sections = mk(raw.map((h, i) => [`s${i}`, h.page, h.x, h.y, h.w]));
      for (let k = 0; k < 400; k++) {
        const page = 1 + Math.floor(r() * 7);
        const x = 0.08 + r() * 0.8; // any start on the line (the text block is 0.08–0.92)
        const rect = sel(page, x, r(), Math.min(0.02 + r() * 0.4, 0.92 - x));
        expect(sectionAtRect(sections, rect), `paper ${paper} rect ${JSON.stringify(rect)}`).toBe(plainRectRule(sections, rect));
        // a second line below it (full line) does not change the first rect
        const a = anchor([rect, sel(page, 0.08, rect.y + 0.015, 0.84)]);
        expect(selectionSectionId('note', sections, a), `paper ${paper} anchor`).toBe(plainRectRule(sections, rect));
      }
    }
  });
});

describe('selectionSectionId picks its first rect in reading order, not the first in the array (C3-R2-02)', () => {
  const r = (page: number, x: number, y: number): NormRect => ({ page, x, y, w: 0.2, h: 0.012 });
  const anchor = (rects: NormRect[]) => ({ kind: 'text' as const, quote: { exact: 'x', prefix: '', suffix: '' }, rects });

  it('FAST-LIO2 p11: from under VI-A (left) into the right column above VI-B — the array starts with the right rect', () => {
    const sections = asSections(FAST_LIO2, 0.2);
    // stored rects are sorted (page, y, x): the right column's top line (y .0688, VI-B's own line) comes first
    expect(selectionSectionId('note', sections, anchor([r(11, 0.5098, 0.0688), r(11, 0.08, 0.9)]))).toBe('S6.SS1');
    expect(selectionSectionId('ask', sections, anchor([r(11, 0.5098, 0.0688), r(11, 0.08, 0.9), r(11, 0.08, 0.915)]))).toBe('S6.SS1');
  });
});

// C3-R3-01: a selection rect is the browser's text box (text layer), a heading's pdfRect is the server's item box
// (baseline − font size); the two tops differ by a fraction of an em in either direction (a stored highlight: DOM top
// 0.0009 above the item; the seed paper in e2e Chrome: 0.0011 below), so a selection of the heading line itself must
// not depend on the top. The rect's vertical centre is compared with the heading's y.
describe('a selection of the heading line itself gets that section; the line above keeps the previous one (C3-R3-01)', () => {
  /** A DOM-shaped box of a whole heading line: its top a little above the server box, taller (h 0.0166). */
  const headingLine = (s: SectionDto): NormRect => ({ ...s.pdfRect!, y: s.pdfRect!.y - 0.001, h: 0.0166 });
  /** The line directly above it (12 pt ≈ 0.016 of a letter page), same column. */
  const lineAbove = (s: SectionDto): NormRect => ({ ...s.pdfRect!, y: s.pdfRect!.y - 0.016, h: 0.0166 });
  const anchor = (rects: NormRect[]) => ({ kind: 'text' as const, quote: { exact: 'x', prefix: '', suffix: '' }, rects });

  for (const [name, rows] of [['KISS-ICP', KISS_ICP], ['FAST-LIO2', FAST_LIO2]] as const) {
    it(`${name}: every heading line → its own section, the line above → the previous section (null before the first)`, () => {
      const sections = asSections(rows, 0.2);
      const own: string[] = [];
      const above: string[] = [];
      sections.forEach((s, i) => {
        const got = sectionAtRect(sections, headingLine(s));
        if (got !== s.id) own.push(`${s.id} → ${got}`);
        const prev = i === 0 ? null : sections[i - 1]!.id;
        const gotAbove = sectionAtRect(sections, lineAbove(s));
        if (gotAbove !== prev) above.push(`above ${s.id} → ${gotAbove} (want ${prev})`);
        // the same through selectionSectionId (a selection of the heading line continuing on the next line)
        expect(selectionSectionId('note', sections, anchor([headingLine(s), { ...headingLine(s), y: s.pdfRect!.y + 0.015 }])), s.id).toBe(s.id);
      });
      expect(own).toEqual([]);
      expect(above).toEqual([]);
      expect(sectionAtRect(sections, headingLine(sections[0]!))).not.toBeNull(); // the first heading line is not "before the first heading"
    });
  }

  it('the boundary: a rect whose centre is exactly the heading y is in that section, a centre just above it is not', () => {
    const one: SectionDto[] = [
      { id: 'A', ordinal: 0, level: 1, parentId: null, number: null, title: 'A', htmlId: null, pdfPage: 1, pdfOffset: null, pdfRect: { page: 1, x: 0.125, y: 0.25, w: 0.25, h: 0.0125 } },
      { id: 'B', ordinal: 1, level: 1, parentId: null, number: null, title: 'B', htmlId: null, pdfPage: 1, pdfOffset: null, pdfRect: { page: 1, x: 0.125, y: 0.5, w: 0.25, h: 0.0125 } },
    ];
    expect(sectionAtRect(one, { page: 1, x: 0.125, y: 0.375, w: 0.5, h: 0.25 })).toBe('B'); // centre 0.5 = B's y
    expect(sectionAtRect(one, { page: 1, x: 0.125, y: 0.375 - 2 ** -20, w: 0.5, h: 0.25 })).toBe('A'); // centre just above
    // the same in the right column of a two-column page (B and the rect in the right column)
    const two = one.map((s) => (s.id === 'B' ? { ...s, pdfRect: { ...s.pdfRect!, x: 0.625 } } : s));
    expect(sectionAtRect(two, { page: 1, x: 0.625, y: 0.375, w: 0.25, h: 0.25 })).toBe('B');
    expect(sectionAtRect(two, { page: 1, x: 0.625, y: 0.375 - 2 ** -20, w: 0.25, h: 0.25 })).toBe('A');
  });

  it('the first rect of a selection is the one whose centre comes first (the same y sectionAtRect compares)', () => {
    const one: SectionDto[] = [
      { id: 'A', ordinal: 0, level: 1, parentId: null, number: null, title: 'A', htmlId: null, pdfPage: 1, pdfOffset: null, pdfRect: { page: 1, x: 0.125, y: 0.25, w: 0.25, h: 0.0125 } },
      { id: 'B', ordinal: 1, level: 1, parentId: null, number: null, title: 'B', htmlId: null, pdfPage: 1, pdfOffset: null, pdfRect: { page: 1, x: 0.125, y: 0.5, w: 0.25, h: 0.0125 } },
    ];
    // a tall box starting higher (centre 0.51, under B's top) and a short box inside its band whose centre (0.498) is
    // above B's top: the short box comes first in reading order, so the selection starts before B
    const tall: NormRect = { page: 1, x: 0.125, y: 0.49, w: 0.25, h: 0.04 };
    const short: NormRect = { page: 1, x: 0.4, y: 0.495, w: 0.02, h: 0.006 };
    expect(selectionSectionId('note', one, anchor([tall, short]))).toBe('A');
    expect(selectionSectionId('note', one, anchor([tall]))).toBe('B');
  });

  it('one-column paper: the heading line itself (top a little above the server box) gets that heading', () => {
    const mk = (rows: [id: string, page: number, x: number, y: number, w: number][]): SectionDto[] =>
      rows.map(([id, page, x, y, w], i) => ({ id, ordinal: i, level: 1, parentId: null, number: null, title: id, htmlId: id, pdfPage: page, pdfOffset: null, pdfRect: { page, x, y, w, h: 0.012 } }));
    const left = mk([['1 Intro', 1, 0.147, 0.3, 0.16], ['2 Method', 2, 0.147, 0.2, 0.12], ['3 Results', 2, 0.147, 0.7, 0.12]]);
    expect(sectionAtRect(left, { page: 1, x: 0.147, y: 0.299, w: 0.16, h: 0.0166 })).toBe('1 Intro'); // was null
    expect(sectionAtRect(left, { page: 2, x: 0.147, y: 0.199, w: 0.12, h: 0.0166 })).toBe('2 Method');
    expect(sectionAtRect(left, { page: 2, x: 0.3, y: 0.699, w: 0.05, h: 0.0166 })).toBe('3 Results'); // right part of the heading line
    expect(sectionAtRect(left, { page: 2, x: 0.147, y: 0.684, w: 0.6, h: 0.0166 })).toBe('2 Method'); // the line above
  });
});

// C3-R3-02: a right-column heading with no left / full-width heading before it on its page has τ = y (L = 0 — L never
// comes from an earlier page): FAST-LIO2 p2 starts with II and II-A in the right column (p1 ends with I on the left).
describe('a right-column heading with no earlier left heading on its page becomes current at its own y (C3-R3-02)', () => {
  it('FAST-LIO2 p2: top 0.07 → II (S2, y 0.0688), top 0.095 → II-A (S2.SS1, y 0.0916)', () => {
    const sections = asSections(FAST_LIO2, 0.2);
    expect(currentSectionAt(sections, { page: 2, top: 0.06 })).toBe('S1');
    expect(currentSectionAt(sections, { page: 2, top: 0.07 })).toBe('S2');
    expect(currentSectionAt(sections, { page: 2, top: 0.095 })).toBe('S2.SS1');
    expect(currentSectionAt(sections, { page: 2, top: 0.3 })).toBe('S2.SS1');
  });
});
