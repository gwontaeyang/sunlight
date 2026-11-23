// Two tiny original pages with controllable metadata, typography and PDF outline destinations.
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

export async function makeUploadPdf(options: { bookmarks?: boolean; title?: string; scan?: boolean; subject?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const title = options.title ?? 'Learning Point Registration';
  if (title) doc.setTitle(title);
  if (options.subject) doc.setSubject(options.subject);
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = [doc.addPage([600, 780]), doc.addPage([600, 780])] as const;
  const headings = ['Matching Points', 'Checking the Estimate'] as const;
  const body = [
    ['We pair each scan point with its closest point in the local map.', 'Faraway pairs are left out of the update.', 'Two nearby targets are enough for this translation example.'],
    ['Check the estimated shift against the two known correspondences.', 'A distant third point should have no effect on the estimate.', 'Run the same calculation after moving the targets together.'],
  ];
  for (const [i, page] of pages.entries()) {
    if (options.scan) { page.drawRectangle({ x: 80, y: 420, width: 100, height: 70 }); continue; }
    const draw = (text: string, y: number, size: number, heavy = false) =>
      page.drawText(text, { x: 64, y, size, font: heavy ? bold : regular });
    draw('Registration Notes', 752, 16, true); // repeated running header, deliberately prominent
    if (i === 0) draw('Learning Point Registration', 685, 24, true);
    const y = i === 0 ? 605 : 666;
    draw(headings[i]!, y, i === 0 ? 17 : 11, true); // the second heading is the same size as body text
    body[i]!.forEach((text, index) => draw(text, y - 38 - 20 * index, 11));
    draw('Figure 1. Sample points', y - 125, 14, true);
    draw(String(i + 1), 22, 11);
  }
  if (options.bookmarks) {
    const ctx = doc.context;
    const outline = ctx.nextRef(), parent = ctx.nextRef(), child = ctx.nextRef();
    ctx.assign(outline, ctx.obj({ Type: 'Outlines', First: parent, Last: parent, Count: 2 }));
    ctx.assign(parent, ctx.obj({ Parent: outline, Title: PDFString.of('Registration procedure'),
      Dest: [pages[0].ref, 'XYZ', 64, 620, null], First: child, Last: child, Count: 1 }));
    ctx.assign(child, ctx.obj({ Parent: parent, Title: PDFString.of('Verify the shift'), Dest: PDFName.of('check') }));
    doc.catalog.set(PDFName.of('Outlines'), outline);
    doc.catalog.set(PDFName.of('Dests'), ctx.obj({ check: [pages[1].ref, 'FitH', 677] }));
  }
  return doc.save({ useObjectStreams: false });
}
