// Server → browser round trip of quote grounding (review N2). The server's own code decides the citation status
// from the PDF (ingest text extraction + resolveCitations, the functions the server runs), then the browser
// jumps to each citation in the real viewer: a quote is located (and flashed with exactly the quote's text) iff
// the server called it `verbatim`. Both sides match on the page text only, with the same rules.
// Cases: words split into separate pdf.js items, "now here" against a PDF "nowhere", a two-column page with a
// phrase in both columns (ambiguous) and a unique right-column sentence, and — when the read-only real-paper
// fixture is available — a ligature (ﬁ) quote and a quote ending inside the ligature.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import type { Citation } from '../packages/shared/src/contracts/domain';
import { quoteEqualsN1 } from '../packages/shared/src/anchor/matchQuote';
import { parseAnswer } from '../packages/shared/src/markup/parseAnswer';
import { extractPageTexts } from '../apps/server/src/ingest/pdfText';
import { resolveCitations } from '../apps/server/src/llm/citations';
import { SEED_PAPER_ID, SEED_TITLE } from './helpers';

const DUP = 'The voxel map keeps one point per cell.';

async function syntheticPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const size = 10;
  // Left column: "nowhere" drawn as two runs in two fonts with no gap, so pdf.js makes separate items
  // "It goes now" | "here" | " " | "fast and never stops." — an item boundary inside a word.
  let x = 50;
  for (const [part, f] of [['It goes now', font], ['here', bold], [' fast and never stops.', font]] as const) {
    page.drawText(part, { x, y: 600, size, font: f });
    x += f.widthOfTextAtSize(part, size);
  }
  page.drawText(DUP, { x: 50, y: 588, size, font });
  page.drawText('Short left column line.', { x: 50, y: 576, size, font });
  // Right column: the same phrase again and a unique sentence.
  page.drawText(DUP, { x: 318, y: 600, size, font });
  page.drawText('The right column alone says this sentence.', { x: 318, y: 588, size, font });
  return doc.save();
}

async function serverCitations(pdf: Uint8Array, quotes: string[], expectSplitWord = false): Promise<Citation[]> {
  const { pages } = await extractPageTexts(pdf.slice());
  if (expectSplitWord) {
    const p1 = pages[0]!;
    expect(p1.items.map((i) => p1.text.slice(i.start, i.start + i.len))).toEqual(expect.arrayContaining(['It goes now', 'here']));
  }
  const parsed = parseAnswer(quotes.map((q, i) => `claim ${i} <q>${q}</q> [[P]]`).join('\n\n'));
  return resolveCitations(parsed, pages.map((p) => ({ page: p.page, text: p.text })), []);
}

async function openWith(page: Page, pdf: Uint8Array) {
  await page.route(/\/api\/papers\/[^/]+\/pdf(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from(pdf) }));
  await page.goto(`/paper/${SEED_PAPER_ID}`);
  await expect(page.getByTestId('paper-title')).toHaveText(SEED_TITLE);
  await page.waitForSelector('.page[data-page-number="1"] .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
}

type SpWindow = Window & { __spReader: { getState(): { jumpToCitation(c: Citation): Promise<string> } } };

/** Jumps to `c` in the browser; returns the result and the flashed text (when located). */
async function jump(page: Page, c: Citation): Promise<{ result: string; flash: string | null }> {
  await page.evaluate(() => document.querySelectorAll('.sp-flash').forEach((e) => e.remove()));
  // A citation without a position does not move the viewer; give the browser the page anyway to test its recheck.
  const withPage: Citation = c.position ? c : { ...c, position: { page: 1, start: 0, end: 0 } };
  const result = await page.evaluate((c) => (window as unknown as SpWindow).__spReader.getState().jumpToCitation(c), withPage);
  const flash = result === 'located' ? await page.locator('[data-testid="citation-flash"]').first().getAttribute('data-flash-text') : null;
  return { result, flash };
}

async function expectRoundTrip(page: Page, cites: Citation[]) {
  for (const c of cites) {
    const { result, flash } = await jump(page, c);
    expect(result, `${c.status}: ${c.quote}`).toBe(c.status === 'verbatim' ? 'located' : 'page_only');
    if (flash !== null) expect(quoteEqualsN1(c.quote!, flash), flash).toBe(true);
  }
}

test('synthetic two-column page: split items, "now here" vs "nowhere", duplicate phrase, unique right column', async ({ page }) => {
  const pdf = await syntheticPdf();
  const cites = await serverCitations(pdf, ['It goes nowhere fast and never stops.', 'It goes now here fast and never stops.', DUP, 'The right column alone says this sentence.'], true);
  expect(cites.map((c) => c.status)).toEqual(['verbatim', 'fuzzy', 'ambiguous', 'verbatim']);
  await openWith(page, pdf);
  await expectRoundTrip(page, cites);
});

const fixtures = process.env.SP_FIXTURES_DIR ?? (process.env.SP_DATA_DIR ? join(process.env.SP_DATA_DIR, 'fixtures') : '');
const fastLio = fixtures && join(fixtures, '2107.06829v1.pdf');

test('real paper: a ligature quote is located; a quote ending inside the ligature is not', async ({ page }) => {
  test.skip(!fastLio || !existsSync(fastLio), 'read-only FAST-LIO2 fixture not available');
  const pdf = new Uint8Array(readFileSync(fastLio));
  const whole = 'This procedure creates significant motion distortion influencing the performance of the odometry and mapping, especially when the motion is severe.';
  const cites = await serverCitations(pdf, [whole, 'This procedure creates signif']);
  expect(cites[0]!.status).toBe('verbatim');
  expect(cites[1]!.status).not.toBe('verbatim');
  await openWith(page, pdf);
  await expectRoundTrip(page, cites);
});

// M2 integration I4 (PLAN_M2 7절 3, the fourth M1.3 number "DOM 19/19"): `npm run eval:grounding` does not measure the
// browser side, so this case does. Runs only with SP_GROUNDING_EVAL_JSON=<grounding_eval.json of that command> and
// the read-only KISS-ICP fixture; otherwise skipped. The quotes come from that JSON (nothing from the paper is copied
// here): the server's own code decides each status from the PDF, then the viewer jumps to every one — located and
// flashed with exactly the quote's text, 19 of 19.
const groundingEvalJson = process.env.SP_GROUNDING_EVAL_JSON ?? '';
const kissIcp = fixtures && join(fixtures, '2209.15397v2.pdf');

test('real paper: every KISS-ICP positive of eval:grounding is located in the viewer (DOM 19/19)', async ({ page }) => {
  test.skip(!groundingEvalJson || !existsSync(groundingEvalJson), 'SP_GROUNDING_EVAL_JSON (grounding_eval.json) not given');
  test.skip(!kissIcp || !existsSync(kissIcp), 'read-only KISS-ICP fixture not available');
  test.setTimeout(240_000);
  const evalOut = JSON.parse(readFileSync(groundingEvalJson, 'utf8')) as { positives: { paper: string; quote: string; status: string }[] };
  const quotes = evalOut.positives.filter((p) => p.paper === '2209.15397v2').map((p) => p.quote);
  expect(quotes).toHaveLength(19);
  const pdf = new Uint8Array(readFileSync(kissIcp));
  const cites = await serverCitations(pdf, quotes);
  expect(cites).toHaveLength(19);
  expect(cites.map((c) => c.status)).toEqual(Array.from({ length: 19 }, () => 'verbatim'));
  await openWith(page, pdf);
  let located = 0;
  let flashEqual = 0;
  for (const c of cites) {
    const { result, flash } = await jump(page, c);
    expect(result, c.quote!).toBe('located');
    located++;
    expect(flash, c.quote!).not.toBeNull();
    expect(quoteEqualsN1(c.quote!, flash!), flash!).toBe(true);
    flashEqual++;
  }
  expect({ located, flashEqual }).toEqual({ located: 19, flashEqual: 19 });
  console.log(`DOM re-anchoring: located ${located}/19, flash = quote ${flashEqual}/19`);
});
