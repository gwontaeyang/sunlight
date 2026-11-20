// Owner A. The linear markup pre-scan in front of parseHTML (PLAN_M2 P7 · 3.2 · 9절 39, review A-R2-02 / A-R3-02).
// Decided by structure, not by time: (1) property — the estimated depth is never below the depth of the DOM linkedom
// actually builds (adversarial shapes, the fixtures, the real papers, a seeded random generator mixing void elements,
// implied closes, foreign content, self-closing tags, raw text and comments); (2) the adversarial shapes at full size are
// refused (structure_too_large) or stay within the limits; (3) the real papers pass with their tag count and depth
// reported. The same documents also check the two node-count bounds of review A-F2-01/02: the non-element node bound is
// never below the text·comment·CDATA nodes of linkedom's DOM, and the foreign-context length equals htmlparser2's own.
// Wall clock only as a loose regression bound.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'htmlparser2';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';
import { parse, parseStructure, StructureError } from '../../src/ingest/latexml';
import { PRESCAN_LIMITS, scanMarkup } from '../../src/ingest/markupScan';
import { BYTE_LIMITS } from '../../src/ingest/safeFetch';
import { manyLinks, nestedHeadinglessSections, sharedGroupHolder, sharedTbodyHolder, whitespaceParagraph } from './latexmlShapes';

// linkedom's parseHTML wrapped in a spy (same behaviour) so a test can show the parser is never called for a refused
// document (review A-F1-04); the DOM-depth helper below goes through the same spy
vi.mock('linkedom', async (importOriginal) => {
  const m = await importOriginal<typeof import('linkedom')>();
  return { ...m, parseHTML: vi.fn(m.parseHTML) };
});

const FIX = join(process.env.SP_DATA_DIR ?? '/nonexistent', 'fixtures');
const REAL = { kiss: join(FIX, '2209.15397v2.html'), fastlio: join(FIX, '2107.06829v1.html') };
const SYN = ['synthetic-m2.html', 'synthetic-latexml.html'].map((f) => [f, readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8')] as const);

interface N {
  nodeType: number;
  firstChild: N | null;
  nextSibling: N | null;
}
/** Maximum element depth of linkedom's DOM (the root element = 1) and its non-element nodes (text, comment, CDATA,
 * doctype), iteratively. */
function domStats(html: string): { depth: number; nonElements: number } {
  const doc = parseHTML(html).document as unknown as { childNodes: ArrayLike<N> }; // (the doctype node has no nextSibling)
  let max = 0;
  let nonElements = 0;
  const stack: [N, number][] = [];
  for (const c of Array.from(doc.childNodes)) stack.push([c, 1]);
  while (stack.length > 0) {
    const [node, d] = stack.pop()!;
    if (node.nodeType !== 1) {
      nonElements++;
      continue;
    }
    if (d > max) max = d;
    for (let c = node.firstChild; c; c = c.nextSibling) stack.push([c, d + 1]);
  }
  return { depth: max, nonElements };
}
const domDepth = (html: string) => domStats(html).depth;

/** The longest htmlparser2 foreignContext while parsing `html` with linkedom's options (the same htmlparser2 10.1.0 copy
 * linkedom imports; the array is private, read after each open tag — the only place it grows). */
function parserForeignMax(html: string): number {
  let max = 0;
  const parser: Parser = new Parser(
    {
      onopentagname() {
        const len = (parser as unknown as { foreignContext: boolean[] }).foreignContext.length;
        if (len > max) max = len;
      },
    },
    { lowerCaseAttributeNames: false, decodeEntities: true, xmlMode: false },
  );
  max = (parser as unknown as { foreignContext: boolean[] }).foreignContext.length;
  parser.write(html);
  parser.end();
  return max;
}

/**
 * The properties (only meaningful when the scan did not stop at a limit — refused is the safe outcome): the estimated
 * depth is ≥ the real depth, the non-element node bound is ≥ the real count (A-F2-01), and the foreign-context length is
 * htmlparser2's exactly (A-F2-02).
 */
function expectSound(html: string, label: string): { est: number; real: number; refused: boolean; nodes: number; realNodes: number } {
  const s = scanMarkup(html);
  const real = domStats(html);
  if (s.over === null) {
    expect(s.maxDepth, label).toBeGreaterThanOrEqual(real.depth);
    expect(s.nonElementNodes, label).toBeGreaterThanOrEqual(real.nonElements);
    expect(s.maxForeignContext, label).toBe(parserForeignMax(html));
  }
  return { est: s.maxDepth, real: real.depth, refused: s.over !== null, nodes: s.nonElementNodes, realNodes: real.nonElements };
}

const wrap = (body: string) => `<!DOCTYPE html><html><body><article class="ltx_document">${body}</article></body></html>`;

/** The adversarial forms A measured (review A-R2-02), at a size linkedom parses quickly (n repetitions). */
const ADVERSARIAL: Record<string, (n: number) => string> = {
  'p-div-/p': (n) => wrap('<p><div></p>'.repeat(n)),
  'b-/div': (n) => wrap('<b></div>'.repeat(n)),
  'deep table': (n) => wrap(`${'<table><tbody><tr><td>'.repeat(n)}x${'</td></tr></tbody></table>'.repeat(n)}`),
  'deep table, no end tags': (n) => wrap(`${'<table><tr><td>'.repeat(n)}x`),
  'deep figure': (n) => wrap(`${'<figure class="ltx_figure"><figcaption>c</figcaption>'.repeat(n)}${'</figure>'.repeat(n)}`),
  'deep b': (n) => wrap(`${'<b>'.repeat(n)}x${'</b>'.repeat(n)}`),
  'deep b, unclosed': (n) => wrap('<b>'.repeat(n)),
  'li implied closes': (n) => wrap(`<ul>${'<li><ul>'.repeat(n)}`),
  'p in p': (n) => wrap('<p><span>'.repeat(n)),
  'links dense': (n) => wrap(`<p>${'<a href="x">y</a>'.repeat(n)}</p>`),
  'inline dense': (n) => wrap(`<p>${'<b>a</b><i>b</i><span>c</span>'.repeat(n)}</p>`),
  'foreign self-closing': (n) => wrap(`<math>${'<mrow><mi/>'.repeat(n)}</math>`),
  'self-closing in html': (n) => wrap('<div/>'.repeat(n)),
  'end p without open': (n) => wrap(`<div>${'</p>'.repeat(n)}</div>`),
  'end br': (n) => wrap(`<div>${'</br>'.repeat(n)}</div>`),
  // htmlparser2 picks a raw-text element by its first letter (t or x) and the rest of the name (review A-F1-01): <tmp>
  // reads raw text up to </xmp, <xitle> up to </title, <xextarea> up to </textarea — and stays open (its end tag has
  // another name), so the </b> inside is text, not an end tag
  'raw-text name tmp': (n) => wrap('<b><tmp></b></xmp>'.repeat(n)),
  'raw-text name xitle': (n) => wrap('<b><XiTle></b></TITLE>'.repeat(n)),
  'raw-text name xextarea': (n) => wrap('<b><xextarea></b></textarea >'.repeat(n)),
  // non-element nodes (review A-F2-01): every "<" that starts no tag cuts a text node, an entity is its own text node
  // (with the text before it; a two-code-point entity gives two), and comments are nodes — none of them is a start tag
  'lt run': (n) => wrap('<'.repeat(n)),
  'lt pairs': (n) => wrap('a<<'.repeat(n)),
  'entities': (n) => wrap('&amp;'.repeat(n)),
  'text and entities': (n) => wrap('a&amp;'.repeat(n)),
  'two-code-point entities': (n) => wrap('a&NotEqualTilde;'.repeat(n)),
  'title entities': (n) => wrap(`<title>${'a&amp;'.repeat(n)}</title>`),
  'empty comments': (n) => wrap('<!-->'.repeat(n)),
  'end-tag text </>': (n) => wrap('x</>'.repeat(n)),
  'bogus comments': (n) => wrap('</1x>'.repeat(n)),
  // foreign context (review A-F2-02): htmlparser2 keeps a foreign/integration entry until an end tag of that very name —
  // an ancestor's end tag or a foreign self-closing tag leaves it behind, so it grows with the start tags, not the depth
  'foreign entry left by ancestor end': (n) => wrap('<b><mi></b>'.repeat(n)),
  'foreign self-closing svg in b': (n) => wrap('<b><svg/></b>'.repeat(n)),
  'foreign entry, title in svg': (n) => wrap('<svg><title></svg>'.repeat(n)),
};

// ---- seeded random documents
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NAMES = ['p', 'div', 'b', 'span', 'li', 'ul', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'h2', 'section', 'figure', 'figcaption', 'article', 'math', 'svg', 'mi', 'mo', 'mrow', 'mtext', 'annotation-xml', 'annotation', 'semantics', 'foreignObject', 'desc', 'a', 'select', 'option', 'optgroup', 'dd', 'dt', 'rt', 'rp', 'input', 'br', 'img', 'hr', 'col', 'body', 'head', 'link', 'DIV', 'Tr', 'P'];
/** [open tag name, the end tag that closes its raw text] — htmlparser2 matches t/x as the first letter of title·textarea·xmp. */
const RAW: readonly (readonly [string, string])[] = [
  ['script', 'script'], ['style', 'style'], ['textarea', 'textarea'], ['title', 'title'], ['xmp', 'xmp'], ['SCRIPT', 'script'], ['Style', 'style'],
  ['tmp', 'xmp'], ['TmP', 'XMP'], ['xitle', 'title'], ['XITLE', 'Title'], ['xextarea', 'textarea'], ['xEXTAREA', 'TEXTAREA'],
];
function randomDoc(seed: number, tokens: number): string {
  const r = mulberry32(seed);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const out: string[] = ['<!DOCTYPE html><html><body>'];
  for (let k = 0; k < tokens; k++) {
    const x = r();
    const nm = pick(NAMES);
    if (x < 0.36) out.push(`<${nm}${r() < 0.2 ? ` class="c${k}" title='a<b>c' data-x=y` : ''}>`);
    else if (x < 0.62) out.push(`</${nm}>`);
    else if (x < 0.66) out.push(`<${nm}/>`);
    else if (x < 0.68) out.push(`<${nm} / >`);
    else if (x < 0.7) out.push(pick(['</p>', '</br>', '</ p>', '</>', '</ div>', '</1x>']));
    else if (x < 0.73) {
      const [raw, seq] = pick(RAW);
      const body = pick(['<div><b>', '</div></b>', '</scriptx>', '</script/>', `</${seq.toLowerCase()}x>`, 'a < b && c > d', '']);
      const end = pick([`</${seq}>`, `</${seq.toUpperCase()} >`, `\x1c\x0f${seq.toLowerCase()}>`, `</${seq}\n>`, `</${raw}>`, '']);
      out.push(`<${raw}>${body}${end}`);
    } else if (x < 0.76) out.push(pick(['<!-- <div><b> -->', '<!-->', '<!--->', '<!-x <div> >', '<![CDATA[ <div> ]]>', '<![CDAT <div>', '<!DOCTYPE x>', '<? <div> ?>', '<!>', '<!->']));
    else if (x < 0.8) out.push(pick(['a < b', '<<b>', '< div>', 'x > y', '&lt;div&gt;', '<3', 'a&NotEqualTilde;b', '&amp;&', '<<<', 'x</>y', '&#60;/b>']));
    else if (x < 0.82) out.push(pick(['<b><svg/></b>', '<b><mi></b>', '<i><math><mtext></i>', '<svg><desc/></svg>', '</math>', '</mi>']));
    else out.push(pick(['text ', 'more words ', '\n']));
  }
  return out.join('');
}

describe('markup pre-scan: estimated depth ≥ the depth of linkedom DOM', () => {
  it('adversarial forms (A-R2-02 shapes) at a parseable size', () => {
    const rows: string[] = [];
    for (const [name, make] of Object.entries(ADVERSARIAL)) {
      for (const n of [1, 2, 7, 60, 200]) {
        const { est, real } = expectSound(make(n), `${name} ×${n}`);
        if (n === 200) rows.push(`${name}: est ${est} real ${real}`);
      }
    }
    expect(rows).toHaveLength(Object.keys(ADVERSARIAL).length);
  });

  it('the shapes of latexml.limits (latexmlShapes.ts) and the two synthetic fixtures', () => {
    for (const [f, html] of SYN) expectSound(html, f);
    expectSound(sharedGroupHolder(2_000, 40), 'sharedGroupHolder');
    expectSound(sharedTbodyHolder(40, 200), 'sharedTbodyHolder');
    expectSound(whitespaceParagraph(1_000, 4), 'whitespaceParagraph');
    expectSound(manyLinks(2_000), 'manyLinks');
    expectSound(nestedHeadinglessSections(40, 2_000), 'nestedHeadinglessSections');
  });

  it.skipIf(!existsSync(REAL.kiss) || !existsSync(REAL.fastlio))('the real papers: under every limit, estimate = DOM depth (tag count and depth reported)', () => {
    const seen: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(REAL)) {
      const html = readFileSync(f, 'utf8');
      const s = scanMarkup(html);
      const real = domStats(html);
      expect(s.over).toBeNull();
      expect(s.maxDepth).toBeGreaterThanOrEqual(real.depth);
      expect(s.nonElementNodes).toBeGreaterThanOrEqual(real.nonElements);
      expect(s.maxForeignContext).toBe(parserForeignMax(html));
      seen[k] = {
        startTags: s.startTags,
        depth: s.maxDepth,
        domDepth: real.depth,
        maxAttributes: s.maxAttributes,
        maxNameChars: s.maxNameChars,
        nonElementNodes: s.nonElementNodes,
        domNonElements: real.nonElements,
        maxForeignContext: s.maxForeignContext,
      };
    }
    // the values at the time of writing (PLAN_M2 P7 measured depth 27 · 30 with another depth convention)
    expect(seen).toMatchInlineSnapshot(`
      {
        "fastlio": {
          "depth": 30,
          "domDepth": 30,
          "domNonElements": 10132,
          "maxAttributes": 7,
          "maxForeignContext": 3,
          "maxNameChars": 16,
          "nonElementNodes": 10413,
          "startTags": 10807,
        },
        "kiss": {
          "depth": 27,
          "domDepth": 27,
          "domNonElements": 4024,
          "maxAttributes": 7,
          "maxForeignContext": 4,
          "maxNameChars": 16,
          "nonElementNodes": 4078,
          "startTags": 3673,
        },
      }
    `);
  });

  it('seeded random documents (void, implied closes, foreign, self-closing, raw text, comments, quotes, entities) — 400 documents', () => {
    let exact = 0;
    let refused = 0;
    let maxReal = 0;
    let maxRealNodes = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const html = randomDoc(seed, 300 + (seed % 7) * 150);
      const r = expectSound(html, `seed ${seed}`);
      if (r.refused) refused++;
      else if (r.est === r.real) exact++;
      maxReal = Math.max(maxReal, r.real);
      maxRealNodes = Math.max(maxRealNodes, r.realNodes);
    }
    expect(maxRealNodes).toBeGreaterThan(200);
    // at the time of writing: refused 0, exact 239 / 400, deepest DOM 48 — every document was checked, and the estimate
    // is mostly exact (it exceeds the DOM only through foreign self-closing ghosts)
    expect(refused).toBe(0);
    expect(maxReal).toBeGreaterThan(20);
    expect(exact).toBeGreaterThan(100);
  });

  it('raw-text detection follows the tokenizer (s + c/t → script·style, t/x + i/e/m → title·textarea·xmp; review A-F1-01): estimate = DOM depth, start tags = DOM elements', () => {
    const firsts = ['s', 'S', 't', 'T', 'x', 'X', 'c', 'm'];
    const rests = ['cript', 'CRIPT', 'tyle', 'TyLe', 'itle', 'ITLE', 'extarea', 'EXTarea', 'mp', 'MP', 'cripts', 'tyl', 'itl', 'extare', 'mpx', 'm', 'i', 'e'];
    const ends = '</xmp></title></textarea></script></style>';
    const elements = (html: string) => (parseHTML(html).document as unknown as { querySelectorAll(s: string): ArrayLike<unknown> }).querySelectorAll('*').length;
    const special: string[] = [];
    for (const f of firsts) {
      for (const rest of rests) {
        const nm = f + rest;
        // two divs, the tag, two </div> (text when the tag starts raw text — then the divs stay open), the raw-text ends
        const html = wrap(`<div><div><${nm}></div></div>${ends}<i>x</i>`.repeat(6));
        const s = scanMarkup(html);
        expect(s.over, nm).toBeNull();
        expect(s.maxDepth, nm).toBe(domDepth(html));
        expect(s.startTags, nm).toBe(elements(html));
        if (s.maxDepth > 10) special.push(nm);
      }
    }
    const expected = [
      ...['s', 'S'].flatMap((f) => ['cript', 'CRIPT', 'tyle', 'TyLe'].map((r) => f + r)),
      ...['t', 'T', 'x', 'X'].flatMap((f) => ['itle', 'ITLE', 'extarea', 'EXTarea', 'mp', 'MP'].map((r) => f + r)),
    ];
    expect(special.sort()).toEqual(expected.sort());
  });
});

describe('markup pre-scan: limits', () => {
  it('start tags: 300,000 pass, 300,001 refused before parseHTML (structure_too_large)', () => {
    const at = wrap('<b></b>'.repeat(PRESCAN_LIMITS.startTags - 3)); // + html, body, article = exactly 300,000
    expect(scanMarkup(at)).toMatchObject({ over: null, startTags: PRESCAN_LIMITS.startTags });
    const over = wrap('<b></b>'.repeat(PRESCAN_LIMITS.startTags - 2)); // 300,001
    expect(scanMarkup(over)).toMatchObject({ over: 'startTags', startTags: PRESCAN_LIMITS.startTags + 1 });
    expect(() => parse(over)).toThrow(expect.objectContaining({ warning: 'structure_too_large', message: expect.stringContaining('start tags') }));
  });

  it('depth: 256 pass, 257 refused; the html/body/article levels count', () => {
    const at = wrap(`${'<b>'.repeat(256 - 3)}x`);
    expect(scanMarkup(at)).toMatchObject({ over: null, maxDepth: 256 });
    expect(domDepth(at)).toBe(256);
    const over = wrap(`${'<b>'.repeat(256 - 2)}x`);
    expect(scanMarkup(over).over).toBe('depth');
    expect(() => parse(over)).toThrow(expect.objectContaining({ warning: 'structure_too_large', message: expect.stringContaining('depth') }));
  });

  it('non-element nodes (A-F2-01): a bound of 600,000 passes, 600,001 is refused', () => {
    // wrap's doctype is one node (a declaration); each "<!---->" one comment; no text between them
    const at = wrap('<!---->'.repeat(PRESCAN_LIMITS.nonElementNodes - 1));
    expect(scanMarkup(at)).toMatchObject({ over: null, nonElementNodes: PRESCAN_LIMITS.nonElementNodes });
    const over = wrap('<!---->'.repeat(PRESCAN_LIMITS.nonElementNodes));
    expect(scanMarkup(over)).toMatchObject({ over: 'nonElementNodes', nonElementNodes: PRESCAN_LIMITS.nonElementNodes + 1 });
    expect(() => parse(over)).toThrow(expect.objectContaining({ warning: 'structure_too_large', message: expect.stringContaining('non-element nodes') }));
    // the parts of the bound, each on a small document: a "<" after text, an entity (3), a comment, trailing text
    expect(scanMarkup('<html>a<b>c&amp;d</b>e<!--x-->f').nonElementNodes).toBe(1 + (3 + 1) + 1 + 1 + 1); // a · c & (3 for the entity) d · e · comment · f
    expect(scanMarkup('<html><<<').nonElementNodes).toBe(3);
    // the end of the input inside a token: htmlparser2 emits an end tag cut off after its name and then the rest as
    // text (seed 12760 of the reviewer's generator — before: bound 2 < DOM 3), drops an unfinished open tag, and ends an
    // unfinished comment, declaration or raw text with one node
    const tails = ['word </thead x>/></head ><tbody><s <b><td a=/></XITLE></styl ><body a=><styl a=><tit></xmp<aword ', 'a</b ', 'a</b x="', '<script>x</script ', '<title>a&amp;</title ', '<xmp>a</xmp', 'a<b c="', 'a<!-- x', 'a<!x', 'a<?x', 'a</1x', 'a</ ', 'a<'];
    for (const t of tails) expectSound(`<html><body>${t}`, JSON.stringify(t));
  });

  it('foreign context (A-F2-02): length 64 passes, 65 is refused; it follows htmlparser2 (not the stack depth)', () => {
    const at = wrap('<b><mi></b>'.repeat(PRESCAN_LIMITS.foreignContext - 1)); // htmlparser2 starts with one entry
    expect(scanMarkup(at)).toMatchObject({ over: null, maxForeignContext: PRESCAN_LIMITS.foreignContext, maxDepth: 5 });
    expect(parserForeignMax(at)).toBe(PRESCAN_LIMITS.foreignContext);
    const over = wrap('<b><mi></b>'.repeat(PRESCAN_LIMITS.foreignContext));
    expect(scanMarkup(over)).toMatchObject({ over: 'foreignContext', maxForeignContext: PRESCAN_LIMITS.foreignContext + 1 });
    expect(parserForeignMax(over)).toBe(PRESCAN_LIMITS.foreignContext + 1);
    expect(() => parse(over)).toThrow(expect.objectContaining({ warning: 'structure_too_large', message: expect.stringContaining('foreign') }));
    // well-formed MathML closes its entries: any number of formulas stays at 1 + nesting
    const formulas = wrap('<p><math><semantics><mrow><mi>x</mi><mo>=</mo><mn>1</mn></mrow><annotation-xml><mi>y</mi></annotation-xml></semantics></math></p>'.repeat(5_000));
    expect(scanMarkup(formulas)).toMatchObject({ over: null, maxForeignContext: 4 }); // the initial entry, math, annotation-xml, mi
    expect(parserForeignMax(formulas)).toBe(4);
  });

  it('accessor costs (A-R3-02): attributes per tag ≤ 256, tag and attribute names ≤ 64 characters', () => {
    const attrs = (k: number) => Array.from({ length: k }, (_, i) => ` a${i}="v"`).join('');
    expect(scanMarkup(wrap(`<b${attrs(256)}>x</b>`)).over).toBeNull();
    expect(scanMarkup(wrap(`<b${attrs(257)}>x</b>`)).over).toBe('attributesPerTag');
    expect(scanMarkup(wrap(`<${'x'.repeat(64)}>y</${'x'.repeat(64)}>`)).over).toBeNull();
    expect(scanMarkup(wrap(`<${'x'.repeat(65)}>y`)).over).toBe('nameChars');
    expect(scanMarkup(wrap(`<b ${'d'.repeat(65)}="1">y</b>`)).over).toBe('nameChars');
    expect(scanMarkup(wrap(`</${'x'.repeat(65)}>`)).over).toBe('nameChars');
    // a <, > or quote inside a quoted value is not markup
    expect(scanMarkup(wrap(`<b title="<i><i><i>" alt='>>'>x</b>`))).toMatchObject({ over: null, startTags: 4, maxDepth: 4, maxAttributes: 2 });
  });

  it('every adversarial form at full size (≤ 4 MB) is refused or stays inside the limits (bounded parse)', async () => {
    const fill = (unit: string) => wrap(unit.repeat(Math.floor((BYTE_LIMITS.html - wrap('').length) / unit.length)));
    const full: Record<string, string> = {
      'p-div-/p': ADVERSARIAL['p-div-/p']!(300_000),
      'b-/div': ADVERSARIAL['b-/div']!(400_000),
      'deep table 180,000': ADVERSARIAL['deep table']!(180_000).slice(0, BYTE_LIMITS.html),
      'deep figure': ADVERSARIAL['deep figure']!(60_000),
      'deep b 300,000': ADVERSARIAL['deep b']!(300_000),
      'links 230,000': manyLinks(),
      'nested sections 400 + 300,000 inline': nestedHeadinglessSections(),
      'foreign self-closing': ADVERSARIAL['foreign self-closing']!(150_000),
      'end br': ADVERSARIAL['end br']!(600_000),
      // review A-F1-01's 1.41 MB form: before the fix it passed the scan (depth estimate 204) and parseHTML took 10 s
      'raw-text name tmp': wrap(`${'<b>'.repeat(200)}<tmp>${'</b>'.repeat(200)}</xmp>`.repeat(1_000)),
      'raw-text name xitle': ADVERSARIAL['raw-text name xitle']!(100_000), // 200,003 start tags — under that limit
      'attributes 256 × many': wrap(`<p>${`<b${Array.from({ length: 256 }, (_, i) => ` a${i}`).join('')}>x</b>`.repeat(3_000)}</p>`),
      // review A-F2-01: 3 start tags, depth 3 — before the bound, 4.19 M text nodes and parseStructure 33.8 s, RSS 1.5 GB
      'lt run 4 MB': fill('<'),
      'entities 4 MB': fill('&amp;'),
      'text and entities 4 MB': fill('a&amp;'),
      'empty comments 4 MB': fill('<!-->'),
      // review A-F2-02: 299,948 start tags, depth estimate 254 — before the bound, parseHTML 10.9 s / 7.9 s
      'foreign entry left by ancestor end': wrap(`<b>${'<mi>'.repeat(250)}</b>`.repeat(1_195)),
      'foreign self-closing svg in b': wrap(`<b>${'<svg/>'.repeat(250)}</b>`.repeat(1_195)),
    };
    const outcome: Record<string, string> = {};
    for (const [name, html] of Object.entries(full)) {
      expect(Buffer.byteLength(html), name).toBeLessThanOrEqual(BYTE_LIMITS.html);
      const s = scanMarkup(html);
      const t0 = Date.now();
      const r = await parseStructure(html);
      expect(Date.now() - t0, name).toBeLessThan(20_000); // loose regression bound only
      if (s.over !== null) {
        expect(r, name).toMatchObject({ ok: false, warning: 'structure_too_large' });
        outcome[name] = `refused (${s.over})`;
      } else {
        expect(s.maxDepth).toBeLessThanOrEqual(PRESCAN_LIMITS.depth);
        expect(s.startTags).toBeLessThanOrEqual(PRESCAN_LIMITS.startTags);
        expect(s.nonElementNodes).toBeLessThanOrEqual(PRESCAN_LIMITS.nonElementNodes);
        expect(s.maxForeignContext).toBeLessThanOrEqual(PRESCAN_LIMITS.foreignContext);
        outcome[name] = `parsed (${r.ok ? 'ok' : r.warning})`;
      }
    }
    expect(outcome).toMatchInlineSnapshot(`
      {
        "attributes 256 × many": "parsed (structure_parse_failed)",
        "b-/div": "refused (depth)",
        "deep b 300,000": "refused (depth)",
        "deep figure": "refused (depth)",
        "deep table 180,000": "refused (depth)",
        "empty comments 4 MB": "refused (nonElementNodes)",
        "end br": "refused (startTags)",
        "entities 4 MB": "refused (nonElementNodes)",
        "foreign entry left by ancestor end": "refused (foreignContext)",
        "foreign self-closing": "refused (foreignContext)",
        "foreign self-closing svg in b": "refused (foreignContext)",
        "links 230,000": "parsed (ok)",
        "lt run 4 MB": "refused (nonElementNodes)",
        "nested sections 400 + 300,000 inline": "refused (depth)",
        "p-div-/p": "refused (depth)",
        "raw-text name tmp": "refused (depth)",
        "raw-text name xitle": "refused (depth)",
        "text and entities 4 MB": "refused (nonElementNodes)",
      }
    `);
  }, 120_000);

  it('the pre-scan itself is linear: a 4 MB input of each form scans in a loose bound', () => {
    for (const html of [wrap('<p><div></p>'.repeat(300_000)), wrap('<!-- x -->'.repeat(400_000)), wrap(`<script>${'</scrip'.repeat(500_000)}`), wrap(`<b title="${'<'.repeat(3_900_000)}">`)]) {
      const t0 = Date.now();
      scanMarkup(html);
      expect(Date.now() - t0).toBeLessThan(5_000);
    }
  });

  it('parse() throws StructureError for a refused document and never calls parseHTML for it (every limit)', () => {
    const spy = vi.mocked(parseHTML);
    const refused: Record<string, string> = {
      startTags: wrap('<b></b>'.repeat(PRESCAN_LIMITS.startTags - 2)),
      depth: wrap('<b>'.repeat(10_000)),
      attributesPerTag: wrap(`<b${' a'.repeat(257)}>x</b>`),
      nameChars: wrap(`<${'x'.repeat(65)}>y`),
      nonElementNodes: wrap('<'.repeat(PRESCAN_LIMITS.nonElementNodes + 1)),
      foreignContext: wrap('<b><svg/></b>'.repeat(PRESCAN_LIMITS.foreignContext)),
    };
    for (const [which, html] of Object.entries(refused)) {
      expect(scanMarkup(html).over, which).toBe(which);
      spy.mockClear();
      expect(() => parse(html), which).toThrow(StructureError);
      expect(() => parse(html), which).toThrow(expect.objectContaining({ warning: 'structure_too_large', message: expect.stringContaining('markup pre-scan') }));
      expect(spy, which).not.toHaveBeenCalled();
    }
    // the spy does see the parser on a document under every limit
    spy.mockClear();
    expect(parse(SYN[0]![1]).sections.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
