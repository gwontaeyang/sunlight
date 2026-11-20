// Owner A. The HTML size bound (PLAN_M2 P7, common rule 3): a 4 MB LaTeXML document is parsed to the end (loose wall
// clock bound; the work is judged by the extraction's work counter — nodes visited + characters read — and the most work
// between two event-loop yields), and anything over 4 MB never reaches the parser — the fetch refuses it (network and
// offline sources). Adversarial shapes whose items share or nest subtrees (latexmlShapes.ts) stay linear in the input.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetworkArxivSource, OfflineArxivSource } from '../../src/ingest/arxivApi';
import { HostQueue } from '../../src/ingest/hostQueue';
import { HttpCache } from '../../src/ingest/httpCache';
import { ANCHORS_MAX, CAPTION_CHARS, CHARS_PER_UNIT, CONTEXT_MAX, HEADING_CHILD_SCAN, ITEM_WORK_MAX, LATEX_RAW_MAX, parse, parseStructure, REFERENCE_CHARS, SIBLING_NODES_PER_ELEMENT, STORED_CAPS, TEXT_STEPS, TITLE_CHARS, WORK_MAX, YIELD_WORK, type ParsedStructure } from '../../src/ingest/latexml';
import { BYTE_LIMITS, type FetchImpl } from '../../src/ingest/safeFetch';
import { fileTempDir } from '../helpers/tmp';
import { commentSiblings, manyLinks, nestedHeadinglessSections, sharedGroupHolder, sharedTbodyHolder, whitespaceParagraph } from './latexmlShapes';

/**
 * Work linear in the input, and bounded between two yields (the decision; the wall clock bound is loose). The extraction
 * (sections … links) stops at its caps: ≤ n/10. The parsed-text walk of the version check (M-M2-R2-5) visits every node
 * and reads the text: ≤ n (a node is entered and climbed out of once and takes input characters; ≤ 0.41 n measured on
 * these shapes).
 */
function expectBoundedWork(s: ParsedStructure, html: string): void {
  expect(s.work - s.textWork).toBeLessThanOrEqual(html.length / 10);
  expect(s.textWork).toBeLessThanOrEqual(html.length);
  expect(s.work).toBeLessThanOrEqual(WORK_MAX);
  expect(s.maxWorkBetweenYields).toBeLessThanOrEqual(YIELD_WORK + ITEM_WORK_MAX);
}

/** parseStructure with the number of event-loop turns other code got meanwhile. */
async function parseCountingTurns(html: string) {
  let turns = 0;
  const iv = setInterval(() => turns++, 0);
  const t0 = Date.now();
  const r = await parseStructure(html);
  clearInterval(iv);
  expect(Date.now() - t0).toBeLessThan(30_000); // loose
  return { r, turns };
}

/** A LaTeXML-shaped document of about `bytes` bytes: sections with a paragraph, an inline math and a numbered equation. */
function bigDoc(bytes: number): { html: string; sections: number } {
  const head = '<!DOCTYPE html><html><body><article class="ltx_document">';
  const tail = '</article></body></html>';
  const parts: string[] = [];
  let size = head.length + tail.length;
  let i = 0;
  while (size < bytes) {
    i++;
    const block = `<section id="S${i}" class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag">${i} </span>Section ${i}</h2><div class="ltx_para"><p class="ltx_p">Text ${'x'.repeat(2200)} <math alttext="a_{${i}}" display="inline"></math> more text.</p><table id="S${i}.E1" class="ltx_equation"><tbody><tr><td><math alttext="\\displaystyle b_{${i}}" display="block"></math></td><td><span class="ltx_tag ltx_tag_equation">(${i})</span></td></tr></tbody></table></div></section>`;
    parts.push(block);
    size += block.length;
  }
  return { html: head + parts.join('') + tail, sections: i };
}

describe('latexml at the 4 MB bound', () => {
  it('a 4 MB document finishes: sections and equations kept up to the stored caps, element count bounded', async () => {
    const { html, sections } = bigDoc(BYTE_LIMITS.html - 1024);
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(BYTE_LIMITS.html);
    expect(sections).toBeGreaterThan(STORED_CAPS.sections); // so the caps are exercised
    expect(sections).toBeLessThanOrEqual(2_000);
    let yields = 0;
    const t0 = Date.now();
    const iv = setInterval(() => yields++, 0); // the event loop runs between the extraction phases
    const r = await parseStructure(html);
    clearInterval(iv);
    expect(Date.now() - t0).toBeLessThan(30_000); // loose; the decision is the work below
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.structure.sections).toHaveLength(STORED_CAPS.sections);
    expect(r.structure.equations).toHaveLength(STORED_CAPS.equations);
    expect(r.structure.warnings).toContain('structure_truncated');
    // work: the kept sections + the equation tags/tables up to the equation cap (the loop stops there) — not the document
    expectBoundedWork(r.structure, html);
    expect(r.structure.work).toBeGreaterThan(YIELD_WORK); // so the in-phase yields are exercised
    expect(yields).toBeGreaterThan(0);
  }, 60_000);

  it('equation caps per kind: 401 unnumbered display rows before 1 numbered equation → the numbered one is kept, total ≤ the cap', () => {
    const un = Array.from({ length: 401 }, (_, i) => `<table id="S1.Ex${i + 1}" class="ltx_equation"><tbody><tr><td><math alttext="u_{${i}}" display="block"></math></td></tr></tbody></table>`).join('');
    const html = `<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag">1 </span>One</h2><div class="ltx_para"><p class="ltx_p">Before.</p>${un}<table id="S1.E1" class="ltx_equation"><tbody><tr><td><math alttext="x=1" display="block"></math></td><td><span class="ltx_tag ltx_tag_equation">(1)</span></td></tr></tbody></table><p class="ltx_p">After.</p></div></section></article></body></html>`;
    const s = parse(html);
    expect(s.equations).toHaveLength(STORED_CAPS.equations);
    const numbered = s.equations.filter((e) => e.number !== null);
    expect(numbered).toEqual([expect.objectContaining({ number: '1', htmlId: 'S1.E1', latexRaw: 'x=1', contextAfter: 'After.' })]);
    expect(s.equations.filter((e) => e.number === null)).toHaveLength(STORED_CAPS.equations - 1);
    expect(s.warnings).toContain('structure_truncated');
    // 400 numbered + unnumbered after them: all numbered kept, no unnumbered room, the rest dropped
    const nums = Array.from({ length: 400 }, (_, i) => `<table id="S1.E${i + 1}" class="ltx_equation"><tbody><tr><td><math alttext="n_{${i}}" display="block"></math></td><td><span class="ltx_tag ltx_tag_equation">(${i + 1})</span></td></tr></tbody></table>`).join('');
    const t = parse(`<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section"><h2 class="ltx_title">One</h2><div class="ltx_para">${nums}${un}</div></section></article></body></html>`);
    expect(t.equations).toHaveLength(400);
    expect(t.equations.every((e) => e.number !== null)).toBe(true);
    expect(t.warnings).toContain('structure_truncated');
    // exactly at the cap with nothing dropped → no warning
    const u = parse(`<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section"><h2 class="ltx_title">One</h2><div class="ltx_para">${nums}</div></section></article></body></html>`);
    expect(u.equations).toHaveLength(400);
    expect(u.warnings).not.toContain('structure_truncated');
  });

  it('one huge paragraph followed by many equation tables: context work is bounded (no per-equation copy of the paragraph), the event loop gets turns', async () => {
    // ~3 MB paragraph (text after its last math + many small elements), then 1,500 numbered equation tables as siblings.
    const spans = Array.from({ length: 20_000 }, (_, i) => `<span class="w">word${i} </span>`).join('');
    const para = `<p class="ltx_p">Lead <math alttext="a" display="inline"></math> ${'filler text '.repeat(150_000)}${spans}closing words of the paragraph.</p>`;
    const eqs = Array.from({ length: 1_500 }, (_, i) => `<table id="S1.E${i + 1}" class="ltx_equation"><tbody><tr><td><math alttext="e_{${i}}" display="block"></math></td><td><span class="ltx_tag ltx_tag_equation">(${i + 1})</span></td></tr></tbody></table>`).join('');
    const html = `<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section"><h2 class="ltx_title">One</h2><div class="ltx_para">${para}${eqs}</div></section></article></body></html>`;
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(BYTE_LIMITS.html);
    let yields = 0;
    const iv = setInterval(() => yields++, 0);
    const t0 = Date.now();
    const r = await parseStructure(html);
    clearInterval(iv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.structure.equations).toHaveLength(STORED_CAPS.equations);
    // The first equation sees the paragraph; its tail is the last CONTEXT_MAX characters, same as the full-text rule.
    const full = 'filler text '.repeat(150_000) + Array.from({ length: 20_000 }, (_, i) => `word${i} `).join('') + 'closing words of the paragraph.';
    expect(r.structure.equations[0]!.contextBefore).toBe(full.replace(/\s+/g, ' ').trim().slice(-CONTEXT_MAX));
    expect(r.structure.equations[0]!.contextBefore!.endsWith('closing words of the paragraph.')).toBe(true);
    // Later tables have earlier equation tables as siblings: the sibling walk stops (CONTEXT_SIBLINGS_MAX) → null.
    expect(r.structure.equations[100]!.contextBefore).toBeNull();
    expectBoundedWork(r.structure, html);
    expect(yields).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 60_000);

  describe('shapes whose items share or nest subtrees (review A-R2-01): work linear in the input, bounded between yields', () => {
    it('one equation group holder with 19,000 math rows shared by 400 group tags: the holder is walked once, cut at LATEX_RAW_MAX', async () => {
      const html = sharedGroupHolder();
      const { r, turns } = await parseCountingTurns(html);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const eqs = r.structure.equations;
      expect(eqs).toHaveLength(400);
      expect(eqs.map((e) => e.number)).toEqual(Array.from({ length: 400 }, (_, i) => String(i + 1)));
      expect(eqs.every((e) => e.group && e.htmlId === 'S1.EGx1' && e.latexRaw === eqs[0]!.latexRaw)).toBe(true);
      expect(eqs[0]!.latexRaw).toHaveLength(LATEX_RAW_MAX);
      expect(eqs[0]!.latexRaw.startsWith('\\begin{gathered} x_{0} \\\\ x_{1} \\\\ x_{2}')).toBe(true);
      expectBoundedWork(r.structure, html);
      expect(turns).toBeGreaterThan(0);
    }, 60_000);

    it('nested heading-less sections around many inline elements: heading lookup stays among the first children', async () => {
      // 400 deep around 300,000 inline elements is now refused by the markup pre-scan (depth > 256, > 300,000 start
      // tags — 9절 39); the extraction bound is checked at the deepest nesting the pre-scan lets through.
      expect(await parseStructure(nestedHeadinglessSections())).toMatchObject({ ok: false, warning: 'structure_too_large', message: expect.stringContaining('pre-scan') });
      const depth = 250; // + html, body, article, b = 254 ≤ 256
      const html = nestedHeadinglessSections(depth, 290_000);
      const { r, turns } = await parseCountingTurns(html);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const secs = r.structure.sections;
      expect(secs).toHaveLength(depth);
      expect(secs.every((s) => s.title === '' && s.number === null)).toBe(true);
      expect(secs.map((s) => s.parentIndex)).toEqual(Array.from({ length: depth }, (_, i) => (i === 0 ? null : i - 1)));
      expectBoundedWork(r.structure, html);
      expect(turns).toBeGreaterThan(0);
    }, 60_000);

    it('one tbody[id] holder shared by 400 tags with 8 kB alttexts: joined once, cut at LATEX_RAW_MAX', async () => {
      const html = sharedTbodyHolder();
      expect(Buffer.byteLength(html)).toBeLessThanOrEqual(BYTE_LIMITS.html);
      const { r, turns } = await parseCountingTurns(html);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const eqs = r.structure.equations;
      expect(eqs).toHaveLength(400);
      expect(eqs.every((e) => e.htmlId === 'S1.E1.b' && e.latexRaw.length === LATEX_RAW_MAX && e.latexRaw === eqs[0]!.latexRaw)).toBe(true);
      expectBoundedWork(r.structure, html);
      expect(turns).toBeGreaterThan(0);
    }, 60_000);

    it('a 3.5 MB whitespace text node after the math of a paragraph: the context read stops at its character budget (unknown → null)', async () => {
      const html = whitespaceParagraph();
      expect(Buffer.byteLength(html)).toBeLessThanOrEqual(BYTE_LIMITS.html);
      const { r, turns } = await parseCountingTurns(html);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.structure.equations).toHaveLength(32);
      expect(r.structure.equations.every((e) => e.contextBefore === null)).toBe(true);
      expectBoundedWork(r.structure, html);
      expect(r.structure.work).toBeGreaterThan(YIELD_WORK); // the reads are counted
      expect(turns).toBeGreaterThan(0);
      // a short whitespace run keeps the full-text rule: the text after the math is empty → the paragraph before is used
      const small = parse(whitespaceParagraph(1_000, 2));
      expect(small.equations.map((e) => e.contextBefore)).toEqual([null, null]);
    }, 60_000);

    it('230,000 links: the code-link loop yields, checks at most ANCHORS_MAX links, and finds a GitHub link before that', async () => {
      const html = manyLinks();
      expect(Buffer.byteLength(html)).toBeLessThanOrEqual(BYTE_LIMITS.html);
      const { r, turns } = await parseCountingTurns(html);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.structure.codeUrl).toBeNull();
      expectBoundedWork(r.structure, html);
      expect(turns).toBeGreaterThan(0);
      const at = (n: number) => manyLinks(n, 'https://example.com/x').replace('</p></section>', '<a href="https://github.com/o/r">code</a></p></section>');
      expect(parse(at(100)).codeUrl).toBe('https://github.com/o/r');
      const late = parse(at(ANCHORS_MAX));
      expect(late.codeUrl).toBeNull(); // the link after ANCHORS_MAX others is not looked at
      expect(late.maxWorkBetweenYields).toBeLessThanOrEqual(YIELD_WORK + ITEM_WORK_MAX);
    }, 60_000);

    it('non-element siblings (A-R3-02): sibling scans count every node they pass and stop at their node budget (unknown)', async () => {
      const html = commentSiblings();
      expect(Buffer.byteLength(html)).toBeLessThanOrEqual(BYTE_LIMITS.html);
      const { r, turns } = await parseCountingTurns(html);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // every table's contextBefore would have to pass 400,000 comments to reach the paragraph → stopped, unknown
      expect(r.structure.equations).toHaveLength(32);
      expect(r.structure.equations.every((e) => e.contextBefore === null)).toBe(true);
      expectBoundedWork(r.structure, html);
      expect(turns).toBeGreaterThan(0);
      // a few comments (within SIBLING_NODES_PER_ELEMENT per element) still reach the paragraph — the real-paper case
      expect(parse(commentSiblings(3, 2)).equations.map((e) => e.contextBefore)).toEqual(['Lead words.', 'Lead words.']);
      // a heading behind more comments than its scan may pass is not found (title unknown); behind a few it is
      const sec = (k: number) => `<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section">${'<!---->'.repeat(k)}<h2 class="ltx_title"><span class="ltx_tag">1 </span>One</h2></section></article></body></html>`;
      expect(parse(sec(10)).sections[0]).toMatchObject({ number: '1', title: 'One' });
      expect(parse(sec(SIBLING_NODES_PER_ELEMENT * HEADING_CHILD_SCAN + 1)).sections[0]).toMatchObject({ number: null, title: '' });
    }, 60_000);

    it('nested untagged display tables (each walk would cover the rest of the nest): past WORK_MAX the structure is unknown', () => {
      // 1,000 deep (3,000 levels) is now refused by the markup pre-scan before parsing (9절 39) …
      const deep = 1_000;
      const html = `<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section"><h2>One</h2>${'<table class="ltx_equation"><tr><td>'.repeat(deep)}${'<b>w</b>'.repeat(30_000)}${'</td></tr></table>'.repeat(deep)}</section></article></body></html>`;
      expect(() => parse(html)).toThrow(expect.objectContaining({ warning: 'structure_too_large', message: expect.stringContaining('pre-scan') }));
      // … and the work bound still holds under the depth limit: 8 nests of 70 tables (210 levels), each table walk cut
      // at HOLDER_STEPS → 560 walks × 20,000 steps > WORK_MAX.
      const nest = `${'<table class="ltx_equation"><tr><td>'.repeat(70)}${'<b>w</b>'.repeat(10_000)}${'</td></tr></table>'.repeat(70)}`;
      const shallow = `<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section"><h2>One</h2>${nest.repeat(8)}</section></article></body></html>`;
      expect(() => parse(shallow)).toThrow(expect.objectContaining({ warning: 'structure_too_large', message: expect.stringContaining(`work over ${WORK_MAX}`) }));
    }, 60_000);
  });

  it('the network source refuses an HTML body over 4 MB (too_large) before anything is parsed', async () => {
    const big = 'a'.repeat(BYTE_LIMITS.html + 1);
    const fetchImpl: FetchImpl = async () => new Response(`<html>${big}</html>`, { headers: { 'content-type': 'text/html' } });
    const root = fileTempDir('sp-html-');
    const { openSqlite } = await import('../../src/db/client');
    const { migrateWithBackup } = await import('../../src/db/migrate');
    const sqlite = openSqlite(join(root, 'db.sqlite'));
    await migrateWithBackup(sqlite, { backupsDir: join(root, 'b') });
    const src = new NetworkArxivSource({ queue: new HostQueue(), cache: new HttpCache(sqlite), fetchImpl });
    await expect(src.html('2301.00001', 1, undefined, undefined, { deadline: Date.now() + 60_000 })).rejects.toMatchObject({ code: 'too_large' });
    sqlite.close();
  });

  it('the offline source refuses a file over 4 MB (too_large)', async () => {
    const dir = mkdtempSync(join(fileTempDir('sp-off-'), 'o'));
    writeFileSync(join(dir, '2301.00001v1.html'), Buffer.alloc(BYTE_LIMITS.html + 1, 0x61));
    await expect(new OfflineArxivSource(dir).html('2301.00001', 1)).rejects.toMatchObject({ code: 'too_large' });
    await expect(new OfflineArxivSource(dir).html('2301.00001', 2)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('values cut at a parser cap (review A-R3-03, decision S-4): stored with a trailing "…" and structure_truncated', () => {
  const docOf = (body: string) => `<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag">1 </span>One</h2>${body}</section></article></body></html>`;
  const eqTable = (rows: string) => `<table id="S1.E1" class="ltx_equation"><tbody id="S1.E1.b">${rows}</tbody></table>`;
  const tagCell = '<td><span class="ltx_tag ltx_tag_equation">(1)</span></td>';

  it('nothing cut → no "…", no warning, latexCut false (the synthetic and the usual shapes)', () => {
    const s = parse(docOf(eqTable(`<tr><td><math alttext="a=b"></math></td>${tagCell}</tr>`)));
    expect(s.equations[0]).toMatchObject({ latexRaw: 'a=b', latexCut: false });
    expect(s.sections[0]!.title).toBe('One');
    expect(s.warnings).not.toContain('structure_truncated');
  });

  it('an equation holder whose walk stops at HOLDER_STEPS before its last row → latexRaw ends with "…", latexCut (→ katexOk false)', () => {
    // review evidence: a math row "a=b", a row of 11,000 filler nodes, then the tagged row "+c"
    const s = parse(docOf(eqTable(`<tr><td><math alttext="a=b"></math></td></tr><tr><td>${'<b>w</b>'.repeat(11_000)}</td></tr><tr><td><math alttext="+c"></math></td>${tagCell}</tr>`)));
    expect(s.equations.filter((e) => e.number === '1')).toEqual([expect.objectContaining({ latexRaw: 'a=b…', latexCut: true })]);
    expect(s.warnings).toContain('structure_truncated');
  });

  it('alttexts past HOLDER_CHARS → the cut text ends with "…", latexCut; a join past LATEX_RAW_MAX keeps LATEX_RAW_MAX chars ending with "…"', () => {
    const s = parse(docOf(eqTable(`<tr><td><math alttext="a=b${' '.repeat(61_000)}"></math></td></tr><tr><td><math alttext="+c"></math></td>${tagCell}</tr>`)));
    const e = s.equations.find((x) => x.number === '1')!;
    expect(e.latexCut).toBe(true);
    expect(e.latexRaw.endsWith('…')).toBe(true);
    expect(e.latexRaw).not.toContain('+c');
    expect(s.warnings).toContain('structure_truncated');
    const big = parse(sharedTbodyHolder(4, 8_000));
    expect(big.equations.every((x) => x.latexCut && x.latexRaw.length === LATEX_RAW_MAX && x.latexRaw.endsWith('…'))).toBe(true);
    expect(big.warnings).toContain('structure_truncated');
  });

  it('a caption past CAPTION_CHARS, a title past TITLE_CHARS, a caption whose walk stops at TEXT_STEPS → "…" + structure_truncated', () => {
    const fig = (cap: string) => `<figure id="S1.F1" class="ltx_figure"><figcaption><span class="ltx_tag">Figure 1: </span>${cap}</figcaption></figure>`;
    const long = parse(docOf(fig('w'.repeat(9_000))));
    expect(long.figures[0]!.caption).toBe(`${'w'.repeat(CAPTION_CHARS)}…`);
    expect(long.warnings).toContain('structure_truncated');
    const steps = parse(docOf(fig(`Lead ${'<span>x</span>'.repeat(TEXT_STEPS)} tail`)));
    expect(steps.figures[0]!.caption.endsWith('…')).toBe(true);
    expect(steps.figures[0]!.caption).not.toContain('tail');
    expect(steps.warnings).toContain('structure_truncated');
    const title = parse(`<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag">1 </span>${'T'.repeat(TITLE_CHARS + 10)}</h2></section></article></body></html>`);
    expect(title.sections[0]!.title).toBe(`${'T'.repeat(TITLE_CHARS)}…`);
    expect(title.warnings).toContain('structure_truncated');
    // exactly at the cap with nothing after → not cut
    const exact = parse(`<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section"><h2 class="ltx_title">${'T'.repeat(TITLE_CHARS)}</h2></section></article></body></html>`);
    expect(exact.sections[0]!.title).toBe('T'.repeat(TITLE_CHARS));
    expect(exact.warnings).not.toContain('structure_truncated');
  });

  it('a reference past REFERENCE_CHARS → rawText ends with "…" and its ids are unknown (null) — the cut may fall inside one', () => {
    const bib = (text: string) => `<section class="ltx_bibliography"><ul class="ltx_biblist"><li id="bib.bib1" class="ltx_bibitem"><span class="ltx_tag ltx_tag_bibitem">[1]</span><span class="ltx_bibblock">${text}</span></li></ul></section>`;
    const s = parse(docOf(bib(`${'r'.repeat(REFERENCE_CHARS - 12)} arXiv:2107.06829v1 and more`)));
    expect(s.references[0]!.rawText.endsWith('…')).toBe(true);
    expect(s.references[0]).toMatchObject({ arxivId: null, doi: null });
    expect(s.warnings).toContain('structure_truncated');
    const ok = parse(docOf(bib('A. B, "T," arXiv:2107.06829v1, 2021.')));
    expect(ok.references[0]).toMatchObject({ rawText: 'A. B, "T," arXiv:2107.06829v1, 2021.', arxivId: '2107.06829' });
    expect(ok.warnings).not.toContain('structure_truncated');
  });
});

describe('the parsed-text walk of the version check (M-M2-R2-5) at the 4 MB bound', () => {
  const doc = (body: string) => `<!DOCTYPE html><html><body><article class="ltx_document"><section id="S1" class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag">1 </span>One</h2>${body}</section></article></body></html>`;
  const room = BYTE_LIMITS.html - 400;
  it('a 4 MB text of mentions with one other version at the very end: found, the walk yields, work linear', async () => {
    const unit = 'arXiv:2301.00001v1 ';
    const html = doc(`<p>${unit.repeat(Math.floor((room - 40) / unit.length))}arXiv:2301.00001v2</p>`);
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(BYTE_LIMITS.html);
    const { r, turns } = await parseCountingTurns(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.structure.textMentions).toEqual({ mentions: [{ id: '2301.00001', version: 1 }, { id: '2301.00001', version: 2 }], overflow: false });
    expectBoundedWork(r.structure, html);
    expect(r.structure.textWork).toBeGreaterThan(YIELD_WORK); // the text is counted
    expect(turns).toBeGreaterThan(0);
  }, 60_000);
  it('290,000 inline elements with a mention split across the last ones: found, the walk yields, work linear', async () => {
    const html = doc(`<p>${'<b>x</b>'.repeat(290_000)} arXiv:2301.<b>00001</b><i>v2</i></p>`);
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(BYTE_LIMITS.html);
    const { r, turns } = await parseCountingTurns(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.structure.textMentions.mentions).toEqual([{ id: '2301.00001', version: 2 }]);
    expectBoundedWork(r.structure, html);
    expect(turns).toBeGreaterThan(0);
  }, 60_000);
  it('a 4 MB run of characters that can all be part of a mention has no cut: matched in one slice, bounded by the run', async () => {
    const run = 'a'.repeat(room - 200);
    const html = doc(`<p>${run}</p>`);
    const { r } = await parseCountingTurns(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.structure.textMentions).toEqual({ mentions: [], overflow: false });
    expect(r.structure.textWork).toBeLessThanOrEqual(html.length);
    // the slice-end search and the match over the run: one piece (no character in it can end a mention)
    expect(r.structure.maxWorkBetweenYields).toBeLessThanOrEqual(YIELD_WORK + ITEM_WORK_MAX + Math.ceil((2 * run.length) / CHARS_PER_UNIT));
  }, 60_000);
});
