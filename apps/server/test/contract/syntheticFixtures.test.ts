// Synthetic fixtures (BRIEF_S S7, PLAN_M2 D30; coordinator note m-R3-1). Owner: supervisor.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findExactHits, matchQuote, type PageTextLike } from '@study-paper/shared/anchor/matchQuote';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { readMockFile, readMockManifest } from '@study-paper/shared/mock-outputs';
import { extractPageTexts } from '../../src/ingest/pdfText';
import { buildSyntheticLinksPdf, buildSyntheticM2Pdf, buildSyntheticPdf } from '../../../../scripts/lib/syntheticPdf';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url));
const pagesOf = async (b: Buffer): Promise<PageTextLike[]> => (await extractPageTexts(new Uint8Array(b))).pages.map((p) => ({ page: p.page, text: p.text }));

describe('synthetic fixtures', () => {
  it('the generator reproduces the committed synthetic.pdf, synthetic-m2.pdf and synthetic-links.pdf byte for byte', async () => {
    for (const [name, build] of [['synthetic.pdf', buildSyntheticPdf], ['synthetic-m2.pdf', buildSyntheticM2Pdf], ['synthetic-links.pdf', buildSyntheticLinksPdf]] as const) {
      expect(Buffer.from(await build()).equals(fixture(name)), name).toBe(true);
    }
  });

  it('every line of the M1 page texts is a line of the same M2 page; M2 adds exactly the caption and the heading', async () => {
    const m1 = await pagesOf(fixture('synthetic.pdf'));
    const m2 = await pagesOf(fixture('synthetic-m2.pdf'));
    expect(m2.map((p) => p.page)).toEqual(m1.map((p) => p.page));
    const added: string[] = [];
    for (const p of m1) {
      const m2Lines = m2[p.page - 1]!.text.split('\n');
      for (const l of p.text.split('\n')) expect(m2Lines, `page ${p.page}: ${l}`).toContain(l);
      added.push(...m2Lines.filter((l) => !p.text.split('\n').includes(l)));
    }
    expect(added).toEqual(['Fig. 1. Overview of the synthetic registration pipeline.', 'A. Robust Kernel']);
  });

  it('every <q> of every manifest mock output (tasks, adversarial, m2) has the same matchQuote status and position page on both PDFs', async () => {
    const m1 = await pagesOf(fixture('synthetic.pdf'));
    const m2 = await pagesOf(fixture('synthetic-m2.pdf'));
    const manifest = readMockManifest();
    const files = new Set<string>();
    for (const e of Object.values(manifest.tasks)) if (e.file.endsWith('.md')) files.add(e.file);
    for (const e of Object.values(manifest.adversarial)) files.add(e.file);
    for (const group of [manifest.m2.adversarial, manifest.m2.blocksInvalid, manifest.m2.blocksAdversarial]) for (const e of Object.values(group)) files.add(e.file);
    let total = 0;
    let located = 0;
    for (const f of files) {
      const raw = readMockFile(f);
      const quotes = new Set<string>([...raw.matchAll(/<q>([\s\S]*?)<\/q>/g)].map((m) => m[1]!));
      for (const c of parseAnswer(raw, { final: true }).citations) if (c.kind === 'quote' && c.quote) quotes.add(c.quote);
      for (const q of quotes) {
        const a = matchQuote(m1, { exact: q });
        const b = matchQuote(m2, { exact: q });
        expect({ f, q: q.slice(0, 60), status: b.status, page: b.position?.page ?? null }).toEqual({ f, q: q.slice(0, 60), status: a.status, page: a.position?.page ?? null });
        if (a.position) {
          expect(typeof a.position.page).toBe('number'); // m-R3-1: the page is really compared, not null against null
          located++;
        }
        total++;
      }
    }
    expect(total).toBeGreaterThanOrEqual(32);
    expect(located).toBeGreaterThanOrEqual(25);
    // a discriminating example: a page-2 line is found on page 2 in both PDFs
    expect(matchQuote(m2, { exact: 'The method runs at 10 Hz on a single CPU core.' }).position?.page).toBe(2);
    expect(matchQuote(m1, { exact: 'The method runs at 10 Hz on a single CPU core.' }).position?.page).toBe(2);
  });

  it('M2 PDF: one "Robust Kernel" heading hit (page 2, line head "A. "), one caption hit (page 1); II-B, (3), (4), (A.1) are absent', async () => {
    const m2 = await pagesOf(fixture('synthetic-m2.pdf'));
    const line = (h: { page: number; start: number; end: number }) => {
      const t = m2[h.page - 1]!.text;
      const ls = t.lastIndexOf('\n', h.start - 1) + 1;
      let le = t.indexOf('\n', h.end);
      if (le < 0) le = t.length;
      return { page: h.page, start: h.start, head: t.slice(ls, h.start), tail: t.slice(h.end, le) };
    };
    expect(findExactHits(m2, { exact: 'Robust Kernel' }).map(line)).toEqual([{ page: 2, start: 174, head: 'A. ', tail: '' }]);
    expect(findExactHits(m2, { exact: 'Overview of the synthetic registration pipeline.' }).map(line)).toEqual([{ page: 1, start: 449, head: 'Fig. 1. ', tail: '' }]);
    expect(findExactHits(m2, { exact: '(2)' }).map((h) => [h.page, h.start])).toEqual([[2, 270]]);
    for (const absent of ['Implementation Details', 'IMPLEMENTATION DETAILS', '(3)', '(4)', '(A.1)', 'Measured runtime on the synthetic sequence.']) expect(findExactHits(m2, { exact: absent }), absent).toEqual([]);
  });

  it('links PDF: a GoTo link to page 2 and a named-destination link cite.ref1; page 2 has the heading and the reference', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(fixture('synthetic-links.pdf')), verbosity: 0 });
    const doc = await task.promise;
    const annots = (await (await doc.getPage(1)).getAnnotations()) as { subtype: string; dest: unknown }[];
    expect(annots.map((a) => a.subtype)).toEqual(['Link', 'Link']);
    expect(Array.isArray(annots[0]!.dest)).toBe(true);
    expect(annots[1]!.dest).toBe('cite.ref1');
    const dest = (await doc.getDestination('cite.ref1')) as unknown[];
    expect(await doc.getPageIndex(dest[0] as never)).toBe(1);
    expect(await doc.getPageIndex((annots[0]!.dest as unknown[])[0] as never)).toBe(1);
    const pages = await pagesOf(fixture('synthetic-links.pdf'));
    expect(pages[0]!.text).toContain('see Section II.');
    expect(pages[0]!.text).toContain('[1].');
    expect(pages[1]!.text.split('\n')).toEqual(expect.arrayContaining(['II. METHOD', 'REFERENCES', '[1] A. Author. A Synthetic Reference. 2000.']));
    await task.destroy();
  });
});
