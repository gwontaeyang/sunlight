// Real-paper check (BRIEF_C acceptance): KISS-ICP (arXiv 2209.15397v2) quote samples. Runs only when the
// read-only fixture exists in $SP_DATA_DIR/fixtures (never committed). Text extraction mirrors the server:
// pdfjs-dist legacy build + TEXT_CONTENT_OPTIONS + buildPageText.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PageText } from '../src/contracts/domain';
import { matchQuote, quoteEqualsN1 } from '../src/anchor/matchQuote';
import { normalizeN1 } from '../src/anchor/normalize';
import { buildPageText, TEXT_CONTENT_OPTIONS } from '../src/anchor/pageText';

const dir = process.env.SP_DATA_DIR ? join(process.env.SP_DATA_DIR, 'fixtures') : '';
const pdfPath = dir && join(dir, '2209.15397v2.pdf');
const samplesPath = dir && join(dir, 'kiss_icp_quote_samples.json');
const available = !!dir && existsSync(pdfPath) && existsSync(samplesPath);

interface Samples {
  positive_verbatim: { quote: string; page: number; start: number }[];
  ambiguous: { quote: string; candidates: number }[];
  negative_not_verbatim: string[];
}

async function extract(path: string): Promise<PageText[]> {
  const require = createRequire(import.meta.url);
  const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    useSystemFonts: false,
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/',
    cMapUrl: join(pdfjsRoot, 'cmaps') + '/',
    cMapPacked: true,
  });
  try {
    const doc = await task.promise;
    const pages: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent(TEXT_CONTENT_OPTIONS);
      pages.push(buildPageText(n, content.items, page.getViewport({ scale: 1 })));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

describe.skipIf(!available)('KISS-ICP 2209.15397v2 quote samples', () => {
  let pages: PageText[] = [];
  let samples: Samples;
  beforeAll(async () => {
    samples = JSON.parse(readFileSync(samplesPath, 'utf8')) as Samples;
    pages = await extract(pdfPath);
  }, 60_000);

  it('8 positive quotes are verbatim at the recorded page/offset and the extracted span equals the quote in N1', () => {
    expect(samples.positive_verbatim).toHaveLength(8);
    for (const s of samples.positive_verbatim) {
      const r = matchQuote(pages, { exact: s.quote });
      expect({ q: s.quote, status: r.status, page: r.position?.page, start: r.position?.start }).toEqual({ q: s.quote, status: 'verbatim', page: s.page, start: s.start });
      const span = pages[s.page - 1]!.text.slice(r.position!.start, r.position!.end);
      expect(quoteEqualsN1(s.quote, span)).toBe(true);
      // pageOnly on the recorded page (web DOM re-anchoring) gives the same range
      expect(matchQuote(pages, { exact: s.quote }, { pageHint: s.page, pageOnly: true }).position).toEqual(r.position);
    }
  });

  it('a repeated expression is ambiguous with the recorded candidate count', () => {
    for (const s of samples.ambiguous) expect(matchQuote(pages, { exact: s.quote })).toMatchObject({ status: 'ambiguous', candidates: s.candidates });
  });

  it('altered negatives are never verbatim', () => {
    for (const q of samples.negative_not_verbatim) expect({ q, status: matchQuote(pages, { exact: q }).status }).not.toEqual({ q, status: 'verbatim' });
  });

  it('a one-word change of a positive sample is fuzzy, not verbatim', () => {
    const r = matchQuote(pages, { exact: 'In our implementation, we keep only the last point that was inserted into the voxel.' });
    expect(r.status).toBe('fuzzy');
    expect(r.position?.page).toBe(4);
  });

  it('every page text is stable under N1 (sanity: non-empty, map within bounds)', () => {
    expect(pages.length).toBe(8);
    for (const p of pages) {
      const n = normalizeN1(p.text);
      expect(n.text.length).toBeGreaterThan(100);
      expect(Math.max(...n.end)).toBeLessThanOrEqual(p.text.length);
    }
  });
});
