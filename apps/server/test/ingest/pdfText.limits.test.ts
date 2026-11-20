import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { IngestError } from '../../src/ingest/errors';
import { extractPageTexts, MAX_PDF_PAGES } from '../../src/ingest/pdfText';
import { SYNTHETIC_PDF } from './helpers';

const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof IngestError ? e.code : `other:${(e as Error).message}`));

async function blankPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return doc.save();
}

describe('extractPageTexts limits', () => {
  it('extracts the synthetic paper (2 pages, 1-based)', async () => {
    const r = await extractPageTexts(new Uint8Array(SYNTHETIC_PDF));
    expect(r.pageCount).toBe(2);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(r.pages[0]!.text).toContain('fixed threshold of 0.5 m');
  });

  it(`refuses more than ${MAX_PDF_PAGES} pages before reading any page`, async () => {
    expect(MAX_PDF_PAGES).toBe(300);
    expect(await codeOf(extractPageTexts(await blankPdf(301)))).toBe('too_large');
    expect((await extractPageTexts(await blankPdf(300))).pageCount).toBe(300);
  });

  it('page limit is configurable (tests) and still too_large', async () => {
    expect(await codeOf(extractPageTexts(new Uint8Array(SYNTHETIC_PDF), { maxPages: 1 }))).toBe('too_large');
  });

  it('stops when the total time limit is exceeded between pages', async () => {
    let t = 0;
    const now = () => (t += 70_000); // every page "takes" 70 s against the 120 s limit
    expect(await codeOf(extractPageTexts(new Uint8Array(SYNTHETIC_PDF), { now }))).toBe('timeout');
  });

  it('the wall-clock timer stops a slow extraction', async () => {
    expect(await codeOf(extractPageTexts(await blankPdf(300), { timeoutMs: 1 }))).toBe('timeout');
  });

  it('caller abort → cancelled', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await codeOf(extractPageTexts(new Uint8Array(SYNTHETIC_PDF), { signal: ctrl.signal }))).toBe('cancelled');
  });

  it('not a PDF → invalid_pdf', async () => {
    expect(await codeOf(extractPageTexts(new TextEncoder().encode('%PDF-1.7 garbage')))).toBe('invalid_pdf');
  });
});
