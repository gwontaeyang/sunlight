import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { NormRectSchema } from '@study-paper/shared/contracts/domain';
import { buildPdfFromPages } from '../../../../scripts/lib/syntheticPdf';
import { extractPageTexts, extractUploadedPdf } from '../../src/ingest/pdfText';
import { makeUploadPdf } from '../fixtures/uploadPdf';

describe('local PDF structure', () => {
  it('prefers nested bookmarks (explicit and named) over printed headings; destinations stay on their pages', async () => {
    const result = await extractUploadedPdf(await makeUploadPdf({ bookmarks: true }), 'renamed.pdf');
    expect(result.title).toBe('Learning Point Registration');
    expect(result.outlineKind).toBe('bookmarks');
    expect(result.sections.map(s => [s.title, s.level, s.parentIndex, s.pdfPage])).toEqual([
      ['Registration procedure', 1, null, 1], ['Verify the shift', 2, 0, 2],
    ]);
    for (const [index, expected] of ['Matching Points', 'Checking the Estimate'].entries()) {
      const s = result.sections[index]!;
      expect(result.pages[s.pdfPage - 1]!.text.slice(s.pdfOffset)).toMatch(new RegExp('^' + expected));
      expect(NormRectSchema.parse(s.pdfRect).page).toBe(s.pdfPage);
      expect(s.pdfRect.y).toBeGreaterThan(0.05);
      expect(s.pdfRect.h).toBeGreaterThan(0);
    }
  });

  it('uses font size, a contrasting face and placement, and skips cover, running headers, captions and page numbers', async () => {
    const bytes = await makeUploadPdf();
    const result = await extractUploadedPdf(bytes, 'different-name.pdf');
    expect(result.outlineKind).toBe('estimated');
    expect(result.sections.map(s => [s.title, s.pdfPage])).toEqual([['Matching Points', 1], ['Checking the Estimate', 2]]);
    expect((await extractPageTexts(bytes)).pages).toEqual(result.pages);
    expect(await extractUploadedPdf(bytes, 'same-content.pdf')).toEqual(result);
  });

  it('retains hierarchical numeric section labels and skips a continuous plain-text paragraph', async () => {
    const bytes = await buildPdfFromPages([[
      ['1 Introduction', true], ['An ordinary unfinished line'], ['continues the body of this short paper.'],
      ['1.1 Local Map', true], ['A second ordinary line spanning the width of the paragraph.'],
      ['2 Results', true], ['The estimate agrees with the known motion.'],
    ]]);
    const result = await extractUploadedPdf(bytes, 'numbered.pdf');
    expect(result.sections.map(s => [s.number, s.title, s.level, s.parentIndex])).toEqual([
      ['1', 'Introduction', 1, null], ['1.1', 'Local Map', 2, 0], ['2', 'Results', 1, null],
    ]);
  });

  it('uses the first valid descendant for an internal bookmark folder and never follows an external bookmark', async () => {
    const pdf = await PDFDocument.load(await makeUploadPdf());
    const ctx = pdf.context;
    const outline = ctx.nextRef(), folder = ctx.nextRef(), external = ctx.nextRef(), leaf = ctx.nextRef();
    ctx.assign(outline, ctx.obj({ Type: 'Outlines', First: folder, Last: external, Count: 3 }));
    ctx.assign(folder, ctx.obj({ Parent: outline, Title: PDFString.of('Procedures'), First: leaf, Last: leaf, Next: external, Count: 1 }));
    ctx.assign(external, ctx.obj({ Parent: outline, Title: PDFString.of('Visit elsewhere'), Prev: folder,
      A: { S: 'URI', URI: PDFString.of('https://example.invalid/') } }));
    ctx.assign(leaf, ctx.obj({ Parent: folder, Title: PDFString.of('Checking the Estimate'), Dest: [pdf.getPage(1).ref, 'Fit'] }));
    pdf.catalog.set(PDFName.of('Outlines'), outline);
    const { sections, outlineKind } = await extractUploadedPdf(await pdf.save(), 'folder.pdf');
    expect(outlineKind).toBe('bookmarks');
    expect(sections.map(s => [s.title, s.pdfPage, s.parentIndex])).toEqual([['Procedures', 2, null], ['Checking the Estimate', 2, 0]]);
    expect(sections[0]!.pdfRect).toEqual(sections[1]!.pdfRect);
  });

  it('keeps raw offsets aligned with the reader when PDF.js yields many text chunks on one page', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 780]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let row = 0; row < 600; row++) {
      // Four columns force distinct text items. Finish each row with a sentinel for offset verification.
      for (let col = 0; col < 4; col++) page.drawText('entry-' + row + '-' + col, { font, size: 1, x: 50 + col * 125, y: 720 - row });
    }
    const bytes = await doc.save();
    const upload = await extractUploadedPdf(bytes, 'table.pdf');
    const baseline = await extractPageTexts(bytes);
    expect(upload.pages[0]!.items.length).toBeGreaterThan(1500);
    expect(upload.pages[0]!.text).toContain('entry-599-3');
    expect(upload.pages).toEqual(baseline.pages);
  });

  it('keeps scanned pages readable, takes the missing title from the filename, and enforces the page limit', async () => {
    const bytes = await makeUploadPdf({ scan: true, title: '' });
    const result = await extractUploadedPdf(bytes, 'scan notes.PDF');
    expect(result).toMatchObject({ title: 'scan notes', pageCount: 2, outlineKind: 'none', sections: [] });
    expect(result.pages.map(p => p.text)).toEqual(['', '']);
    await expect(extractUploadedPdf(bytes, 'scan.pdf', { maxPages: 1 })).rejects.toMatchObject({ code: 'too_large' });
    await expect(extractUploadedPdf(bytes, 'scan.pdf', { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' });
  });
});
