// Two-column page (review demo item: a citation flash in KISS-ICP's left column ran into the right column).
// Cause: pdf.js sizes each text-layer span from a canvas measurement made with lang="" while the span inherited
// <html lang="ko">, so Chrome drew it in another `sans-serif`/`serif` font and the span came out wider than its
// glyphs. The viewer element now carries the canvas language (PdfReader.matchTextLayerLang).
// The seeded paper's PDF request is answered with a generated two-column PDF (pdf-lib, standard Times font):
// left and right column lines share baselines, the left column is drawn first (like LaTeX output).
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import type { Citation } from '../packages/shared/src/contracts/domain';
import { SEED_PAPER_ID, SEED_TITLE } from './helpers';

const PAGE_W = 612;
const PAGE_H = 792;
const COL_X = [50, 318] as const;
const COL_W = 244;
const SIZE = 10;
const LEFT = [
  'Abstract. Robust and accurate pose estimation of a robotic',
  'platform is an essential part of many robotic applications.',
  'In this work we use different LiDAR sensors. Our odometry',
  'estimation approach relies on point-to-point ICP combined',
  'with adaptive thresholding for correspondence matching, a',
  'robust kernel, a simple but widely applicable motion model.',
];
const RIGHT = [
  '[35]. Even though LiDAR odometry has been an active area',
  'of research for the last three decades, the design of the',
  'current pipelines is usually coupled with assumptions about',
  'the robot motion and the structure of the environment in',
  'which the system operates, which limits its generality.',
  'We propose a simple pipeline that works on many platforms.',
];
const QUOTE = 'Our odometry estimation approach relies on point-to-point ICP combined with adaptive thresholding for correspondence matching,';

interface Layout {
  pdf: Uint8Array;
  /** Right edge of the widest left-column line and left edge of the right column, in page fractions. */
  leftRight: number;
  rightLeft: number;
}

async function twoColumnPdf(): Promise<Layout> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  let widest = 0;
  const draw = (lines: string[], x: number) =>
    lines.forEach((line, i) => {
      widest = x === COL_X[0] ? Math.max(widest, font.widthOfTextAtSize(line, SIZE)) : widest;
      page.drawText(line, { x, y: 600 - i * 12, size: SIZE, font });
    });
  draw(LEFT, COL_X[0]);
  draw(RIGHT, COL_X[1]);
  expect(COL_X[0] + widest).toBeLessThan(COL_X[1] - 10); // a real gutter
  return { pdf: await doc.save(), leftRight: (COL_X[0] + widest) / PAGE_W, rightLeft: COL_X[1] / PAGE_W };
}

async function openTwoColumn(page: Page, pdf: Uint8Array) {
  await page.route(/\/api\/papers\/[^/]+\/pdf(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from(pdf) }));
  await page.goto(`/paper/${SEED_PAPER_ID}`);
  await expect(page.getByTestId('paper-title')).toHaveText(SEED_TITLE);
  await page.waitForSelector('.page[data-page-number="1"] .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
}

/** Boxes (page fractions) of the elements matching `sel` inside page 1. */
function boxes(page: Page, sel: string) {
  return page.evaluate((sel) => {
    const p = document.querySelector('.page[data-page-number="1"]')!.getBoundingClientRect();
    return Array.from(document.querySelectorAll(`.page[data-page-number="1"] ${sel}`)).map((e) => {
      const r = e.getBoundingClientRect();
      return { text: e.textContent ?? '', l: (r.left - p.left) / p.width, r: (r.right - p.left) / p.width, t: (r.top - p.top) / p.height, b: (r.bottom - p.top) / p.height };
    });
  }, sel);
}

test('two columns: text-layer spans end where their glyphs end, and a citation flash stays in its column', async ({ page }) => {
  const layout = await twoColumnPdf();
  await openTwoColumn(page, layout.pdf);

  // 1. Every left-column span ends at the column's text edge (±0.5 % of the page width), never in the gutter.
  const spans = await boxes(page, '.textLayer span[role="presentation"]');
  const left = spans.filter((s) => LEFT.includes(s.text));
  expect(left).toHaveLength(LEFT.length);
  for (const s of left) expect(s.r, s.text).toBeLessThan(layout.leftRight + 0.005);
  const widestLeft = Math.max(...left.map((s) => s.r));
  expect(Math.abs(widestLeft - layout.leftRight)).toBeLessThan(0.005);

  // 2. Jump to a quote that starts mid-line, covers a full line and ends mid-line in the left column.
  const c: Citation = { ordinal: 1, kind: 'quote', quote: QUOTE, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: QUOTE.length } };
  const result = await page.evaluate((c) => (window as unknown as { __spReader: { getState(): { jumpToCitation(c: Citation): Promise<string> } } }).__spReader.getState().jumpToCitation(c), c);
  expect(result).toBe('located');
  const parts = await boxes(page, '.sp-flash-part');
  expect(parts.length).toBe(3);
  for (const p of parts) {
    expect(p.r, 'flash ends inside the left column').toBeLessThan(layout.leftRight + 0.005);
    expect(p.r, 'flash never reaches the right column').toBeLessThan(layout.rightLeft);
    expect(p.l).toBeGreaterThanOrEqual(COL_X[0] / PAGE_W - 0.005);
  }
  // The first part starts at "Our", not at the line start; the last ends at "matching,", not at the line end.
  const lineOf = (text: string) => left.find((s) => s.text === text)!;
  expect(parts[0]!.l).toBeGreaterThan(lineOf(LEFT[2]!).l + 0.1);
  expect(parts[2]!.r).toBeLessThan(lineOf(LEFT[4]!).r - 0.005);
});

test('the viewer element carries the measuring language, the UI around it keeps Korean', async ({ page }) => {
  const layout = await twoColumnPdf();
  await openTwoColumn(page, layout.pdf);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko');
  expect(await page.locator('.pdfViewer').getAttribute('lang')).toBe('');
  expect(await page.evaluate(() => document.querySelector('[data-reader-chrome]')?.closest('[lang]')?.getAttribute('lang'))).toBe('ko');
});
