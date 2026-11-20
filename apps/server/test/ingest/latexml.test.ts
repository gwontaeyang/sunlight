// Owner A. latexml.parse on the M2 synthetic fixture (expected numbers: the fixture's header comment), the real-paper
// table of PLAN_M2 3.2 (skipped without the fixtures), the limits and the codeUrl rule.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubCodeUrl, parse, parseStructure, referenceIds, STORED_CAPS, StructureError } from '../../src/ingest/latexml';

const SYN = readFileSync(new URL('../fixtures/synthetic-m2.html', import.meta.url), 'utf8');
const FIX = join(process.env.SP_DATA_DIR ?? '/nonexistent', 'fixtures');
const kiss = join(FIX, '2209.15397v2.html');
const fastlio = join(FIX, '2107.06829v1.html');

describe('latexml.parse: synthetic-m2.html (its header comment)', () => {
  const s = parse(SYN);
  it('4 sections in document order with numbers, levels and parents; 2 top-level', () => {
    expect(s.sections.map((x) => [x.htmlId, x.number, x.title, x.level, x.parentIndex])).toEqual([
      ['S1', 'I', 'Introduction', 1, null],
      ['S2', 'II', 'Method', 1, null],
      ['S2.SS1', 'II-A', 'Robust Kernel', 2, 1],
      ['S2.SS2', 'II-B', 'Implementation Details', 2, 1],
    ]);
    expect(s.sections.filter((x) => x.level === 1)).toHaveLength(2);
  });
  it('7 equation rows (6 numbered + 1 unnumbered) with holders, sections and the group tag rows joined by gathered', () => {
    const sec = (i: number | null) => (i === null ? null : s.sections[i]!.number);
    expect(s.equations.map((e) => [e.htmlId, e.number, sec(e.sectionIndex), e.group])).toEqual([
      ['S1.E1', '1', 'I', false],
      ['S2.E2', '2', 'II-A', false],
      ['S2.E3', '3', 'II-B', true],
      ['S2.E4', '4', 'II-B', false],
      ['S2.Ex1', null, 'II-B', false],
      ['S2.E5', 'A.1', 'II-B', false],
      ['S2.E6', 'A.1', 'II-B', false],
    ]);
    expect(s.equations[2]!.latexRaw).toBe(
      '\\begin{gathered} \\displaystyle\\mbox{\\boldmath$v$}_{k}=\\mbox{\\boldmath$v$}_{k-1}+a_{k}\\,\\Delta t \\\\ \\displaystyle{\\mbox{{{R\\/}}}}_{k}={\\mbox{{{R\\/}}}}_{k-1}\\,\\exp(\\omega_{k}\\,\\Delta t) \\end{gathered}',
    );
    expect(s.equations[0]!.contextBefore).toBe('and gravity is 9.81 m/s^2.');
    expect(s.equations[2]!.contextBefore).toBe('and the rotation together.');
    expect(s.warnings).not.toContain('equation_number_gap'); // integers 1…4 without a gap
  });
  it('figures, references (arXiv ids by regular expression), ltx_ERROR, code link, arXiv mention', () => {
    expect(s.figures.map((f) => [f.htmlId, f.kind, f.number, f.caption, s.sections[f.sectionIndex!]!.number])).toEqual([
      ['S1.F1', 'figure', '1', 'Overview of the synthetic registration pipeline.', 'I'],
      ['S2.T1', 'table', '1', 'Measured runtime on the synthetic sequence.', 'II-B'],
    ]);
    expect(s.references.map((r) => [r.htmlId, r.label, r.arxivId])).toEqual([
      ['bib.bib1', '[1]', null],
      ['bib.bib2', '[2]', '2301.00003'],
      ['bib.bib3', '[3]', '2301.00099'],
    ]);
    expect(s.references[0]!.rawText).toBe('A. Placeholder, “A synthetic reference,” Synthetic Journal, 2000.');
    expect(s.ltxErrors).toBe(1);
    expect(s.codeUrl).toBe('https://github.com/example/synthetic-registration');
    expect(s.arxivMentions).toEqual([{ id: '0000.00001', version: 1 }]); // the abstract only — the header comment is not text (A-P2-01)
  });
  it('a missing equation number → equation_number_gap (the structure is kept)', () => {
    const gap = parse(SYN.replace('ltx_align_right">(2)</span>', 'ltx_align_right">(5)</span>'));
    expect(gap.warnings).toContain('equation_number_gap');
    expect(gap.equations.filter((e) => e.number !== null)).toHaveLength(6);
  });
});

describe('latexml limits and failures', () => {
  const doc = (body: string) => `<!DOCTYPE html><html><body><article class="ltx_document">${body}</article></body></html>`;
  const sections = (n: number) => Array.from({ length: n }, (_, i) => `<section id="S${i + 1}" class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag">${i + 1} </span>Title ${i + 1}</h2></section>`).join('');
  it('2,001 sections → structure_too_large (no structure)', async () => {
    expect(() => parse(doc(sections(2_001)))).toThrow(StructureError);
    expect(await parseStructure(doc(sections(2_001)))).toMatchObject({ ok: false, warning: 'structure_too_large' });
  });
  it('401 sections → 400 rows kept in document order + structure_truncated', async () => {
    const r = await parseStructure(doc(sections(401)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.structure.sections).toHaveLength(STORED_CAPS.sections);
    expect(r.structure.sections.at(-1)!.number).toBe('400');
    expect(r.structure.warnings).toContain('structure_truncated');
  });
  it('broken HTML and an empty document → {ok:false} (never a throw)', async () => {
    for (const bad of ['', '<<<>>> not html', '<html><body><p>no LaTeXML here</p></body></html>', doc('')]) {
      expect(await parseStructure(bad)).toMatchObject({ ok: false, warning: 'structure_parse_failed' });
    }
  });
  it('codeUrl: https + hostname exactly github.com + no userinfo / port, parsed with URL', () => {
    expect(githubCodeUrl('https://github.com/x/y')).toBe('https://github.com/x/y');
    for (const bad of ['https://github.com.evil.example/x', 'javascript:alert(1)//github.com', 'http://github.com/x', 'https://user@github.com/x', 'https://github.com:444/x', 'https://evil.example/github.com', 'github.com/x']) {
      expect(githubCodeUrl(bad), bad).toBeNull();
    }
    const s = parse(doc(`${sections(1)}<a href="https://github.com.evil.example/x">a</a><a href="javascript:alert(1)//github.com">b</a><a href="http://github.com/x">c</a><a href="https://user@github.com/x">d</a>`));
    expect(s.codeUrl).toBeNull();
  });
  it('codeUrl comes from the paper body only (review A-R3-01): the arXiv page frame (footer/nav/header, .arxiv-html-*) is never read', () => {
    // The real arXiv HTML page: the paper in .ltx_page_main > article.ltx_document, the arXiv footer after it carries
    // "Our team has already identified <a href=https://github.com/arXiv/html_feedback/issues>…" on every paper.
    const page = (main: string) =>
      `<!DOCTYPE html><html><body><header class="arxiv-html-header"><a href="https://github.com/arXiv/header-link">h</a></header><div class="ltx_page_main"><article class="ltx_document">${main}</article></div><footer class="arxiv-html-footer"><p>Our team has already identified <a class="ltx_ref" href="https://github.com/arXiv/html_feedback/issues" target="_blank">the following issues</a>.</p></footer></body></html>`;
    expect(parse(page(sections(1))).codeUrl).toBeNull();
    expect(parse(page(`${sections(1)}<p>Code: <a href="https://github.com/o/r">r</a></p>`)).codeUrl).toBe('https://github.com/o/r');
    // frame elements inside the page main are skipped too (LaTeXML's page footer/nav, any footer/nav/header element)
    const inner = ['<footer><a href="https://github.com/f/1">f</a></footer>', '<nav class="ltx_page_navbar"><a href="https://github.com/n/1">n</a></nav>', '<header><a href="https://github.com/h/1">h</a></header>', '<div class="ltx_page_footer"><a href="https://github.com/p/1">p</a></div>', '<div class="arxiv-html-footer"><span><a href="https://github.com/a/1">a</a></span></div>'];
    for (const f of inner) expect(parse(page(`${f}${sections(1)}`)).codeUrl, f).toBeNull();
    expect(parse(page(`${inner.join('')}${sections(1)}<a href="https://github.com/o/r2">r</a>`)).codeUrl).toBe('https://github.com/o/r2');
    // without .ltx_page_main the article is the body
    expect(parse(`<!DOCTYPE html><html><body><a href="https://github.com/out/x">o</a><article class="ltx_document">${sections(1)}<a href="https://github.com/in/y">i</a></article></body></html>`).codeUrl).toBe('https://github.com/in/y');
  });
  it('codeUrl never comes from the references (review A-F1-02): links under .ltx_bibliography (bibitem, bibblock) are not candidates', () => {
    const bib = (inner: string) => `<section id="bib" class="ltx_bibliography"><h2 class="ltx_title">References</h2><ul class="ltx_biblist"><li id="bib.bib1" class="ltx_bibitem"><span class="ltx_tag ltx_tag_bibitem">[1]</span>${inner}</li></ul></section>`;
    const tool = '<span class="ltx_bibblock">J. L. Blanco, “nanoflann,” <a class="ltx_ref ltx_url" href="https://github.com/jlblancoc/nanoflann">https://github.com/jlblancoc/nanoflann</a>, 2014.</span>';
    // a paper without its own GitHub link that cites a tool's repository → no code link
    expect(parse(doc(`${sections(1)}${bib(tool)}`)).codeUrl).toBeNull();
    // the link directly in the bibitem (outside a bibblock) too
    expect(parse(doc(`${sections(1)}${bib('<a href="https://github.com/cited/repo">r</a>')}`)).codeUrl).toBeNull();
    // the paper's own link is still found, before or after the references
    expect(parse(doc(`${sections(1)}<p><a href="https://github.com/own/a">a</a></p>${bib(tool)}`)).codeUrl).toBe('https://github.com/own/a');
    expect(parse(doc(`${sections(1)}${bib(tool)}<section class="ltx_appendix"><p><a href="https://github.com/own/b">b</a></p></section>`)).codeUrl).toBe('https://github.com/own/b');
  });
  it('codeUrl references paths (review A-F6-03): a link right under .ltx_bibliography (outside the list), several links in one excluded element', () => {
    const own = '<section class="ltx_appendix"><p><a href="https://github.com/own/c">c</a></p></section>';
    // .ltx_bibliography itself excludes: a paragraph between the heading and the list, no biblist/bibitem/bibblock around it
    const outsideList = `<section id="bib" class="ltx_bibliography"><h2 class="ltx_title">References</h2><p class="ltx_p">Code of the cited tools: <a href="https://github.com/cited/outside">o</a></p><ul class="ltx_biblist"><li id="bib.bib1" class="ltx_bibitem"><span class="ltx_bibblock">A. B, 2014.</span></li></ul></section>`;
    expect(parse(doc(`${sections(1)}${outsideList}`)).codeUrl).toBeNull();
    expect(parse(doc(`${sections(1)}${outsideList}${own}`)).codeUrl).toBe('https://github.com/own/c');
    // the second link of an element already found excluded is decided from that element's remembered answer
    const twoInBlock = `<section id="bib" class="ltx_bibliography"><ul class="ltx_biblist"><li id="bib.bib1" class="ltx_bibitem"><span class="ltx_bibblock"><a href="https://github.com/a/one">1</a> and <a href="https://github.com/b/two">2</a></span></li></ul></section>`;
    const twoInFooter = '<footer><a href="https://github.com/f/one">1</a> <a href="https://github.com/f/two">2</a></footer>';
    for (const excluded of [twoInBlock, twoInFooter]) {
      expect(parse(doc(`${sections(1)}${excluded}`)).codeUrl, excluded).toBeNull();
      expect(parse(doc(`${sections(1)}${excluded}${own}`)).codeUrl, excluded).toBe('https://github.com/own/c');
    }
  });
  it('title, tag, caption and reference text read the presentation MathML only — never <annotation> / <annotation-xml> (review A-R3-04)', () => {
    // LaTeXML: <math alttext><semantics><mrow>…glyphs…</mrow><annotation-xml encoding="MathML-Content">…</annotation-xml><annotation encoding="application/x-tex">TeX</annotation></semantics></math>
    const m = (glyphs: string, tex: string) => `<math alttext="${tex}" display="inline"><semantics><mrow><mi>${glyphs}</mi></mrow><annotation-xml encoding="MathML-Content"><ci>${glyphs}-content</ci></annotation-xml><annotation encoding="application/x-tex">${tex}</annotation></semantics></math>`;
    const s = parse(
      doc(
        `<section id="S1" class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag">1 </span>Error ${m('δ', '\\delta')} bound</h2>` +
          `<figure id="S1.F1" class="ltx_figure"><figcaption><span class="ltx_tag">Figure 1: </span>The displacement ${m('δ', '\\delta(\\Delta T)')} caused by ${m('Δ​R', '\\Delta R')}.</figcaption></figure></section>` +
          `<section class="ltx_bibliography"><ul class="ltx_biblist"><li id="bib.bib1" class="ltx_bibitem"><span class="ltx_tag ltx_tag_bibitem">[1]</span><span class="ltx_bibblock">A. B, “On ${m('SO', '\\mathrm{SO}')}(3),” arXiv:2107.06829v1.</span></li></ul></section>`,
      ),
    );
    expect(s.sections[0]!.title).toBe('Error δ bound');
    expect(s.figures[0]!.caption).toBe('The displacement δ caused by Δ​R.');
    expect(s.references[0]).toMatchObject({ rawText: 'A. B, “On SO(3),” arXiv:2107.06829v1.', arxivId: '2107.06829' });
    expect(s.warnings).toEqual([]);
  });
  it.skipIf(!existsSync(kiss) || !existsSync(fastlio))('real papers: no caption, title or reference carries the TeX annotation (A-R3-04)', () => {
    for (const f of [kiss, fastlio]) {
      const s = parse(readFileSync(f, 'utf8'));
      const texts = [...s.figures.map((x) => x.caption), ...s.sections.map((x) => x.title), ...s.references.map((x) => x.rawText)];
      expect(texts.filter((t) => /\\[a-zA-Z]/.test(t)), f).toEqual([]);
    }
    const k = parse(readFileSync(kiss, 'utf8'));
    expect(k.figures.find((x) => x.htmlId === 'S3.F2')!.caption).toContain('maximum point displacement δ⁡(Δ​T) caused by');
  });
  it('reference ids: arXiv new/old style and DOI from the raw text only', () => {
    expect(referenceIds('A. B, "T," arXiv:2107.06829v1, 2021.')).toEqual({ arxivId: '2107.06829', doi: null });
    expect(referenceIds('arXiv preprint arXiv: 1909.12345 (2019)')).toEqual({ arxivId: '1909.12345', doi: null });
    expect(referenceIds('see arxiv.org/abs/cs/0112017.')).toEqual({ arxivId: 'cs/0112017', doi: null });
    expect(referenceIds('IEEE T-RO, doi: 10.1109/TRO.2021.123456.')).toEqual({ arxivId: null, doi: '10.1109/TRO.2021.123456' });
    expect(referenceIds('no ids here 2021.12345')).toEqual({ arxivId: null, doi: null });
  });
});

describe('latexml on the real papers (PLAN_M2 3.2 table; skipped without the fixtures)', () => {
  it.skipIf(!existsSync(kiss))('KISS-ICP 2209.15397v2: 18 sections / 6 top, equations exactly 1…15 (S3.E1…S3.E15), 36 references, 0 ltx_ERROR', () => {
    const s = parse(readFileSync(kiss, 'utf8'));
    expect([s.sections.length, s.sections.filter((x) => x.level === 1).length, s.references.length, s.ltxErrors]).toEqual([18, 6, 36, 0]);
    const num = s.equations.filter((e) => e.number !== null);
    expect(num.map((e) => e.number)).toEqual(Array.from({ length: 15 }, (_, i) => String(i + 1)));
    expect(num.map((e) => e.htmlId)).toEqual(Array.from({ length: 15 }, (_, i) => `S3.E${i + 1}`));
    expect(s.warnings).toEqual([]);
    expect(s.codeUrl).toBe('https://github.com/PRBonn/kiss-icp'); // the paper's own link, not the arXiv footer's
  });
  it.skipIf(!existsSync(kiss) || !existsSync(fastlio))('real papers: the arXiv footer link github.com/arXiv/html_feedback is never the code link', () => {
    for (const f of [kiss, fastlio]) {
      const html = readFileSync(f, 'utf8');
      expect(html).toContain('https://github.com/arXiv/html_feedback/issues'); // the fixture has the footer
      // the same page with the paper's own GitHub links removed → no code link (was the footer link before)
      const own = html.replace(/href="https:\/\/github\.com\/(?!arXiv\/html_feedback)[^"]*"/g, 'href="https://example.org/x"');
      expect(parse(own).codeUrl, f).toBeNull();
    }
  });
  it.skipIf(!existsSync(fastlio))('FAST-LIO2 2107.06829v1: 48 sections / 9 top, equations exactly 1…19 incl. the 5 group tags, 63 references, 3 ltx_ERROR', () => {
    const s = parse(readFileSync(fastlio, 'utf8'));
    expect([s.sections.length, s.sections.filter((x) => x.level === 1).length, s.references.length, s.ltxErrors]).toEqual([48, 9, 63, 3]);
    const num = s.equations.filter((e) => e.number !== null);
    expect(num.map((e) => e.number)).toEqual(Array.from({ length: 19 }, (_, i) => String(i + 1)));
    expect(num.filter((e) => e.group).map((e) => e.htmlId)).toEqual(['S4.E2', 'S4.E6', 'S4.E10', 'S5.E17', 'S5.E18']);
    expect(s.warnings).toEqual([]);
    expect(s.codeUrl).toBe('https://github.com/hku-mars/FAST_LIO');
  });
  it.skipIf(!existsSync(fastlio))('FAST-LIO2 with only its own hku-mars links changed → no code link (the cited github.com/jlblancoc/nanoflann is a reference, A-F1-02)', () => {
    const html = readFileSync(fastlio, 'utf8');
    expect(html).toContain('href="https://github.com/jlblancoc/nanoflann"'); // the fixture cites it in the bibliography
    const own = html.replace(/href="https:\/\/github\.com\/hku-mars\/[^"]*"/g, 'href="https://example.org/x"');
    expect(own).not.toContain('href="https://github.com/hku-mars/');
    expect(parse(own).codeUrl).toBeNull();
  });
  it.skipIf(!existsSync(kiss))('KISS-ICP with only its own PRBonn links changed → no code link (A-F1-02)', () => {
    const html = readFileSync(kiss, 'utf8');
    const own = html.replace(/href="https:\/\/github\.com\/PRBonn\/[^"]*"/g, 'href="https://example.org/x"');
    expect(own).not.toContain('href="https://github.com/PRBonn/');
    expect(parse(own).codeUrl).toBeNull();
  });
});
