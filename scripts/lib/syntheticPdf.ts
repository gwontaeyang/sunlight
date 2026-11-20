// Deterministic 2-page synthetic paper used by seed-fixture, mock outputs and tests (no real paper content).
// The bytes are committed as apps/server/test/fixtures/synthetic.pdf, synthetic-m2.pdf and synthetic-links.pdf;
// apps/server/test/contract/syntheticFixtures.test.ts checks this generator still reproduces them exactly.
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';

export const SYNTHETIC_TITLE = 'A Synthetic Study of Point-to-Point Registration';
const HEADER = 'SYNTHETIC TEST PAPER - NOT A REAL PUBLICATION';

/** [text, bold?] per line. Line-end hyphens and repeated phrases are deliberate (grounding tests). */
export const SYNTHETIC_PAGES: [string, boolean?][][] = [
  [
    [SYNTHETIC_TITLE, true],
    ['I. INTRODUCTION', true],
    ['We estimate the robot pose by minimizing the point-to-'],
    ['point residual between consecutive scans. The data asso-'],
    ['ciation uses a fixed threshold of 0.5 m and a robust kernel.'],
    ['The state vector is x = [p, v, q] and gravity is 9.81 m/s^2.'],
    ['r_i = R p_i + t - q_i                                        (1)'],
    ['Each scan is deskewed with a constant velocity model before matching.'],
  ],
  [
    ['II. METHOD', true],
    ['The robust kernel down-weights outliers in the residual.'],
    ['We compare against a baseline without the robust kernel.'],
    ['The covariance is propagated with a first-order Jacobian.'],
    ['T_k = T_{k-1} Delta T_k                                      (2)'],
    ['The method runs at 10 Hz on a single CPU core.'],
  ],
];

/**
 * M2 synthetic paper (PLAN_M2 D30): every M1 line in the same order and text, plus exactly two lines — the figure
 * caption at the END of page 1 and the bold subsection heading `A. Robust Kernel` right AFTER "We compare against a
 * baseline without the robust kernel." on page 2. Lines are inserted only at these two boundaries, so the mock
 * outputs' quotes keep their status and page (syntheticFixtures.test).
 */
export const SYNTHETIC_M2_CAPTION = 'Fig. 1. Overview of the synthetic registration pipeline.';
export const SYNTHETIC_M2_HEADING = 'A. Robust Kernel';
export const SYNTHETIC_M2_PAGES: [string, boolean?][][] = (() => {
  const pages = SYNTHETIC_PAGES.map((p) => p.map((l) => [...l] as [string, boolean?]));
  pages[0]!.push([SYNTHETIC_M2_CAPTION]);
  const at = pages[1]!.findIndex(([t]) => t === 'We compare against a baseline without the robust kernel.');
  pages[1]!.splice(at + 1, 0, [SYNTHETIC_M2_HEADING, true]);
  return pages;
})();

/** Draws pages of [text, bold?] lines with the seed metadata (same drawing for every synthetic paper). */
export async function buildPdfFromPages(pages: readonly (readonly [string, boolean?])[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Synthetic Test Paper');
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  doc.setProducer('study_paper seed');
  doc.setCreator('study_paper seed');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    page.drawText(HEADER, { x: 72, y: 750, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
    let y = 700;
    for (const [text, isBold] of lines) {
      page.drawText(text, { x: 72, y, size: isBold ? 13 : 11, font: isBold ? bold : font });
      y -= isBold ? 26 : 18;
    }
  }
  return doc.save({ useObjectStreams: false });
}

/** M1 synthetic paper (committed as synthetic.pdf). */
export async function buildSyntheticPdf(): Promise<Uint8Array> {
  return buildPdfFromPages(SYNTHETIC_PAGES);
}

/** M2 synthetic paper (committed as synthetic-m2.pdf). */
export async function buildSyntheticM2Pdf(): Promise<Uint8Array> {
  return buildPdfFromPages(SYNTHETIC_M2_PAGES);
}

export const SYNTHETIC_LINKS_TITLE = 'A Synthetic Paper With Internal Links';
/**
 * Link test paper (committed as synthetic-links.pdf): 2 pages. Page 1 has an internal GoTo link on "see Section II"
 * (explicit destination: page 2) and a citation link on "[1]" (named destination `cite.ref1`, resolved through the
 * catalog /Dests). Page 2 has "II. METHOD" and "REFERENCES / [1] A. Author. A Synthetic Reference. 2000."
 */
export async function buildSyntheticLinksPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Synthetic Link Paper');
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  doc.setProducer('study_paper seed');
  doc.setCreator('study_paper seed');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  for (const p of [p1, p2]) p.drawText(HEADER, { x: 72, y: 750, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
  const line = (page: typeof p1, y: number, text: string, isBold = false) => page.drawText(text, { x: 72, y, size: isBold ? 13 : 11, font: isBold ? bold : font });
  line(p1, 700, SYNTHETIC_LINKS_TITLE, true);
  line(p1, 674, 'I. INTRODUCTION', true);
  const before1 = 'For the details of the method, ';
  const link1 = 'see Section II';
  line(p1, 648, `${before1}${link1}.`);
  const before2 = 'The baseline follows earlier synthetic work ';
  const link2 = '[1]';
  line(p1, 630, `${before2}${link2}.`);
  line(p2, 700, 'II. METHOD', true);
  line(p2, 674, 'The method aligns two synthetic scans.');
  line(p2, 640, 'REFERENCES', true);
  line(p2, 614, '[1] A. Author. A Synthetic Reference. 2000.');

  const rectFor = (prefix: string, text: string, y: number) => {
    const x1 = 72 + font.widthOfTextAtSize(prefix, 11);
    return [x1, y - 3, x1 + font.widthOfTextAtSize(text, 11), y + 10];
  };
  const ctx = doc.context;
  const goTo = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rectFor(before1, link1, 648), Border: [0, 0, 0], Dest: [p2.ref, 'XYZ', 72, 714, null] }));
  const cite = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rectFor(before2, link2, 630), Border: [0, 0, 0], Dest: PDFName.of('cite.ref1') }));
  p1.node.addAnnot(goTo);
  p1.node.addAnnot(cite);
  doc.catalog.set(PDFName.of('Dests'), ctx.obj({ 'cite.ref1': [p2.ref, 'XYZ', 72, 628, null] }));
  return doc.save({ useObjectStreams: false });
}
