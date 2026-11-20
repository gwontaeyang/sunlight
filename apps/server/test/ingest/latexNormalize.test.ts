// Owner A. latexNormalize (PLAN_M2 3.2, P2): the real alttext forms of the fixtures pass KaTeX after normalization,
// the function is idempotent on the checked forms (not on every input: A-F4R1-03), and the stored value is capped at
// EQUATION_LATEX_MAX characters (katexOk false beyond).
import { describe, expect, it } from 'vitest';
import { katexCheck } from '../../src/ingest/katexCheck';
import { EQUATION_LATEX_MAX } from '@study-paper/shared/contracts/domain';
import { latexNormalize, normalizeForStore } from '../../src/ingest/latexNormalize';

// Real shapes (P2): LaTeXML alttext as it appears in KISS-ICP / FAST-LIO2 / the synthetic fixture.
const FORMS: [string, string][] = [
  ['\\displaystyle\\mbox{\\boldmath$v$}_{k}=\\mbox{\\boldmath$v$}_{k-1}+a_{k}\\,\\Delta t', '\\boldsymbol{v}_{k}=\\boldsymbol{v}_{k-1}+a_{k}\\,\\Delta t'],
  ['\\displaystyle{\\mbox{{{R\\/}}}}_{k}={\\mbox{{{R\\/}}}}_{k-1}\\,\\exp(\\omega_{k}\\,\\Delta t)', '\\mathrm{R}_{k}=\\mathrm{R}_{k-1}\\,\\exp(\\omega_{k}\\,\\Delta t)'],
  ['\\displaystyle\\mathbf{x}_{k}\\boxplus\\mbox{\\boldmath$\\delta$}\\mathbf{x}', '\\mathbf{x}_{k}\\boxplus\\boldsymbol{\\delta}\\mathbf{x}'],
  ['\\displaystyle e_{k}=\\mbox{if }x>0\\mbox{ else }0', 'e_{k}=\\text{if }x>0\\text{ else }0'],
  ['\\displaystyle a\\/b', 'ab'],
  ['\\begin{gathered} \\displaystyle a=b \\\\ \\displaystyle c=d \\end{gathered}', '\\begin{gathered} a=b \\\\ c=d \\end{gathered}'],
  ['\\displaystyle\\begin{aligned} x &amp;= 1 \\end{aligned}', '\\begin{aligned} x &= 1 \\end{aligned}'],
  ['\\displaystyle x &lt; y \\quad   z', 'x < y \\quad z'],
];

describe('latexNormalize', () => {
  it.each(FORMS)('%s', (raw, want) => {
    const got = latexNormalize(raw);
    expect(got).toBe(want);
    expect(katexCheck(got)).toBe(true);
  });
  it('is idempotent on the checked forms: f(f(x)) = f(x), including entity look-alikes and backslash pairs', () => {
    const tricky = ['&amp;lt;', '&amp;amp;', 'a &amp; b', '\\\\displaystyle x', '\\\\/', '\\mbox{\\displaystyle\\boldmath$x$}', '\\displaystylex', '  a \n\t b  ', ...FORMS.map((f) => f[0])];
    for (const t of tricky) expect(latexNormalize(latexNormalize(t)), t).toBe(latexNormalize(t));
    expect(latexNormalize('\\\\displaystyle x')).toBe('\\\\displaystyle x'); // `\\` is a token of its own
    expect(latexNormalize('&amp;lt;')).toBe('&amp;lt;');
  });
  it('is idempotent on fixed-seed token strings: TOKENS are dropped before the entities are restored (A-I10-02)', () => {
    // the shortest counterexamples of the old order (entities first): a dropped token between "&" and an entity tail
    expect(latexNormalize('&\\/amp;')).toBe('&');
    expect(latexNormalize('&\\/#39;')).toBe("'");
    expect(latexNormalize('&amp;\\/lt;')).toBe('&amp;lt;'); // an &amp; that forms an entity name stays
    expect(latexNormalize('&\\displaystyle lt;')).toBe('& lt;');
    // the I10 probe's token table (p5_normalize_fuzz), mulberry32 with a fixed seed
    const TOK = ['\\mbox{', '\\boldmath', '$', '{', '}', '\\/', '\\\\', '\\', '/', '\\displaystyle', 'displaystyle', '&amp;', '&lt;', '&gt;', '&quot;', '&#39;', '&', 'amp;', 'lt;', '#39;', '#x41;', ';', ' ', '  ', 'x', 'R', '\\text{', '\\mathrm{', '\\boldsymbol{', '\n', 'a', '\\mbox{\\boldmath$', '$}', '{\\mbox{{{', '}}}}', 'gt', 'quot'];
    let a = 20261117 >>> 0;
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const seen = new Set<string>();
    const bad: string[] = [];
    for (let n = 0; n < 100_000; n++) {
      const len = 1 + Math.floor(rnd() * 10);
      let s = '';
      for (let i = 0; i < len; i++) s += TOK[Math.floor(rnd() * TOK.length)];
      seen.add(s);
      const once = latexNormalize(s);
      if (latexNormalize(once) !== once && bad.length < 5) bad.push(s);
    }
    expect(seen.size).toBeGreaterThan(80_000); // the generator really varies (ER-A-02)
    expect(bad).toEqual([]);
  });
  it('not idempotent on every input: a dropped token that joins its neighbours into a new token changes again on a second pass (the header limit, A-F4R1-03)', () => {
    // [raw, one pass, two passes] — the header names this limit; the pipeline applies the function once
    const JOINS: [string, string, string][] = [
      ['\\display\\/style x', '\\displaystyle x', 'x'],
      ['\\d\\/isplaystyle', '\\displaystyle', ''],
      ['\\mbo\\/x{a}', '\\mbox{a}', '\\text{a}'],
      ['\\mbo\\/x{\\boldmath$x$}', '\\mbox{\\boldmath$x$}', '\\boldsymbol{x}'],
      ['{\\mbo\\/x{{{R}}}}', '{\\mbox{{{R}}}}', '\\mathrm{R}'],
    ];
    for (const [raw, once, twice] of JOINS) {
      expect(latexNormalize(raw), raw).toBe(once);
      expect(latexNormalize(once), raw).toBe(twice);
    }
  });
  it('4,001 characters → the stored latex is the first 4,000 and katexOk must be false (cut); 4,000 stays whole', () => {
    const long = 'x'.repeat(EQUATION_LATEX_MAX + 1);
    expect(normalizeForStore(long)).toEqual({ latex: 'x'.repeat(EQUATION_LATEX_MAX), cut: true });
    expect(normalizeForStore('x'.repeat(EQUATION_LATEX_MAX))).toEqual({ latex: 'x'.repeat(EQUATION_LATEX_MAX), cut: false });
    // never inside a surrogate pair
    const astral = 'x'.repeat(EQUATION_LATEX_MAX - 1) + '\u{1D465}';
    expect(normalizeForStore(astral).latex.length).toBe(EQUATION_LATEX_MAX - 1);
  });
});
