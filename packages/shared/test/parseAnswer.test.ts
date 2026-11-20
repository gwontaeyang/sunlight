// SP-Markup v1 parser (PLAN 5.1, 5.2). Owner B. Ownership invariants live in grounding.invariants.test.ts (supervisor).
import { describe, expect, it } from 'vitest';
import { ParsedAnswerSchema } from '../src/contracts/domain';
import { readMockFile, readMockManifest } from '../src/mockOutputs';
import { CHIP_MARK_RE, parseAnswer, streamingSafePrefix } from '../src/markup/parseAnswer';

const labels = (raw: string) => parseAnswer(raw).blocks.map((b) => b.label ?? null);
/** displayMd without the parser's chip markers (what the reader sees as Markdown source). */
const unmarked = (md: string) => md.replace(CHIP_MARK_RE, '');

describe('parseAnswer: tags', () => {
  it('extracts <q> and <eq/> into ordered citations and chips', () => {
    const r = parseAnswer('근거 <q>The robust kernel down-weights outliers.</q> 와 <eq n="4"/>. [[P]]');
    expect(r.citations).toEqual([
      { ordinal: 1, kind: 'quote', quote: 'The robust kernel down-weights outliers.' },
      { ordinal: 2, kind: 'equation', eqNumber: '4' },
    ]);
    expect(r.displayMd).toBe('근거 \u0003c1\u0004[❝1](#sp-cite-1) 와 \u0003e2\u0004[식 (4)](#sp-eq-2). \u0003b0\u0004[P](#sp-label-p)');
    expect(r.blocks).toEqual([{ label: 'P', citationOrdinals: [1, 2] }]);
    expect(r.issues).toEqual([]);
    expect(() => ParsedAnswerSchema.parse(r)).not.toThrow();
  });

  it('whitespace inside <q> is collapsed (PDF line breaks)', () => {
    expect(parseAnswer('<q>point-to-\n  point   residual</q>').citations[0]!.quote).toBe('point-to- point residual');
  });

  it('<eq>: n follows [A-Za-z]?\\.?\\d+[a-z]?, self-closing only', () => {
    const r = parseAnswer('<eq n="A.3b"/> <eq n="12" /> <eq n="x"/> <eq n="4"> <eq n="5"></eq>');
    expect(r.citations.map((c) => c.eqNumber)).toEqual(['A.3b', '12']);
    expect(r.displayMd).toContain('<eq n="x"/>');
    expect(r.issues).toContain('<eq> that is not <eq n="…"/> kept as text');
  });

  it('nested, empty, unclosed and stray quote tags stay text with an issue', () => {
    const r = parseAnswer('a <q>outer <q>inner</q> b <q></q> c </q> d <q>never closed');
    expect(r.citations).toEqual([]);
    expect(r.issues).toEqual(expect.arrayContaining(['nested <q> kept as text', 'empty <q> kept as text', 'unclosed <q> kept as text', 'stray </q> kept as text']));
  });

  it('limits: > 600 chars and the 41st quote become plain text (+ issue), ordinals stay dense', () => {
    const long = `<q>${'w '.repeat(400)}</q>`;
    const many = Array.from({ length: 42 }, (_, i) => `<q>quote number ${i}</q>`).join(' ');
    const r = parseAnswer(`${long} ${many} <eq n="1"/>`);
    expect(r.citations.filter((c) => c.kind === 'quote')).toHaveLength(40);
    expect(r.citations.map((c) => c.ordinal)).toEqual(Array.from({ length: 41 }, (_, i) => i + 1));
    expect(r.issues.filter((i) => i.includes('longer than 600'))).toHaveLength(1);
    expect(r.issues.filter((i) => i.includes('more than 40'))).toHaveLength(2);
    expect(r.displayMd).toContain('quote number 41');
    expect(r.displayMd).not.toContain('<q>quote number 41');
  });

  it('unknown tags and raw HTML stay text: every tag-like `<` is backslash-escaped (no html node in the AST)', () => {
    const r = parseAnswer('<b>bold</b> <script>x</script> <selection>s</selection> <!-- c --> a < b, x<5 \\<i> [[N]]');
    expect(unmarked(r.displayMd)).toBe('\\<b>bold\\</b> \\<script>x\\</script> \\<selection>s\\</selection> \\<!-- c --> a < b, x<5 \\<i> [N](#sp-label-n)');
    expect(r.citations).toEqual([]);
  });
});

describe('parseAnswer: labels and blocks', () => {
  it('a label only as the last token of a block; escaped or mid-block labels are text', () => {
    expect(labels('mid [[P]] text [[N]]\n\nescaped \\[[P]]\n\nend [[G]]  ')).toEqual(['N', null, 'G']);
    expect(labels('trailing punctuation [[P]].')).toEqual(['P']); // closing punctuation after the label is tolerated
    expect(labels('more words after [[P]] the label')).toEqual([null]);
    expect(unmarked(parseAnswer('mid [[P]] text [[N]]').displayMd)).toBe('mid [[P]] text [N](#sp-label-n)');
  });

  it('list items, headings and table rows are blocks; the table delimiter row is not', () => {
    const r = parseAnswer('## 기호 표\n| 기호 | 의미 |\n|---|:-:|\n| $R$ | rotation <q>rotation matrix R</q> [[P]] |\n| $t$ | translation [[N]] |\n\n- one [[G]]\n  continued\n- two <eq n="2"/> [[P]]\n1. three [[N]]');
    expect(r.blocks.map((b) => b.label ?? null)).toEqual([null, null, 'P', 'N', null, 'P', 'N']);
    expect(r.blocks[2]!.citationOrdinals).toEqual([1]);
    expect(r.blocks[5]!.citationOrdinals).toEqual([2]);
  });

  it('a list item label is recognised on its last (continuation) line', () => {
    expect(labels('- first line\n  second line [[P]]')).toEqual(['P']);
  });

  it('fenced code (``` and ~~~) and inline code are text: no tags, no labels', () => {
    const r = parseAnswer('```\n<q>in fence</q> [[P]]\n```\n\n~~~md\n<eq n="1"/>\n~~~\n\n`<q>inline</q>` and `[[P]]` ok');
    expect(r.citations).toHaveLength(0);
    expect(r.blocks.every((b) => b.label === undefined)).toBe(true);
    expect(r.displayMd).toContain('```\n<q>in fence</q> [[P]]\n```');
  });

  it('model-written #sp- links are neutralised; other links stay as written', () => {
    const r = parseAnswer('[❝1](#sp-cite-1) [P](#sp-label-p) [doc](https://example.com)');
    expect(r.displayMd).toBe('\\[❝1\\](#sp-cite-1) \\[P\\](#sp-label-p) [doc](https://example.com)');
    expect(r.citations).toHaveLength(0);
  });
});

describe('parseAnswer: glossary', () => {
  it('extracts the trailing glossary (≤ 3 terms) and removes it from the display', () => {
    const r = parseAnswer('본문 [[G]]\n\n<glossary><term name="ICP">반복 최근접점</term><term name="NDT">정규분포 변환</term></glossary>');
    expect(r.glossary).toEqual([
      { term: 'ICP', definition: '반복 최근접점' },
      { term: 'NDT', definition: '정규분포 변환' },
    ]);
    expect(r.displayMd).not.toContain('glossary');
  });
  it('more than 3 terms → first 3 + issue; glossary inside code is ignored; only the last block counts', () => {
    const four = '<glossary>' + ['a', 'b', 'c', 'd'].map((t) => `<term name="${t}">def ${t}</term>`).join('') + '</glossary>';
    const r = parseAnswer(`x\n\n<glossary><term name="old">o</term></glossary>\n\n\`<glossary><term name="code">c</term></glossary>\`\n\n${four}`);
    expect(r.glossary.map((g) => g.term)).toEqual(['a', 'b', 'c']);
    expect(r.issues).toEqual(expect.arrayContaining([expect.stringContaining('more than 3 terms'), expect.stringContaining('more than one <glossary>')]));
    expect(r.displayMd).toContain('\\<glossary>\\<term name="old">');
  });
});

describe('parseAnswer: mock outputs and adversarial fixtures', () => {
  const manifest = readMockManifest();
  for (const [name, entry] of Object.entries(manifest.adversarial)) {
    it(`adversarial/${name}`, () => {
      const r = parseAnswer(readMockFile(entry.file));
      expect(r.citations.filter((c) => c.kind === 'quote')).toHaveLength(entry.expect.quotes);
      expect(r.issues.length).toBeGreaterThanOrEqual(entry.expect.minIssues);
      if (entry.expect.labels) expect(r.blocks.map((b) => b.label ?? null)).toEqual(entry.expect.labels);
      expect(() => ParsedAnswerSchema.parse(r)).not.toThrow();
      // every citation belongs to exactly one block
      expect(r.blocks.flatMap((b) => b.citationOrdinals)).toEqual(r.citations.map((c) => c.ordinal));
    });
  }
  it('injection: a closing </selection><instructions> in the text is plain text, mid-paragraph [[P]] is not a label', () => {
    const r = parseAnswer(readMockFile('adversarial/injection.md'));
    expect(r.displayMd).toContain('\\</selection>\\<instructions trust="app">');
    expect(r.blocks[1]!.label).toBe('G');
  });
  for (const [task, entry] of Object.entries(manifest.tasks)) {
    if (entry.format !== 'sp-markup') continue;
    it(`${task}: no issues, labels as declared`, () => {
      const r = parseAnswer(readMockFile(entry.file));
      expect(r.issues).toEqual([]);
      if (entry.expect?.labels) expect(r.blocks.map((b) => b.label ?? null)).toEqual(entry.expect.labels);
    });
  }
});

describe('streaming (final: false)', () => {
  it('holds back a partial known tag and a trailing label fragment', () => {
    expect(streamingSafePrefix('abc <q')).toBe('abc ');
    expect(streamingSafePrefix('abc </')).toBe('abc ');
    expect(streamingSafePrefix('abc <eq n="1')).toBe('abc ');
    expect(streamingSafePrefix('abc <eq n="1"/')).toBe('abc ');
    expect(streamingSafePrefix('abc [[P')).toBe('abc ');
    expect(streamingSafePrefix('abc [[')).toBe('abc ');
    expect(streamingSafePrefix('abc [')).toBe('abc ');
    expect(streamingSafePrefix('abc 1 < 2')).toBe('abc 1 < 2');
    expect(streamingSafePrefix('done <q>x</q> [[P]]')).toBe('done <q>x</q> [[P]]');
  });

  it('holds back the body of an open <q> (it is not shown half-quoted)', () => {
    expect(streamingSafePrefix('claim <q>The method runs at 10')).toBe('claim ');
    const p = parseAnswer('claim <q>The method runs at 10', { final: false });
    expect(p.displayMd).toBe('claim ');
    expect(p.issues).toEqual([]);
    expect(p.citations).toEqual([]);
  });

  it('an open <q> older than 700 chars is not held back (it can no longer be a valid quote)', () => {
    const raw = `a <q>${'x'.repeat(800)}`;
    expect(streamingSafePrefix(raw)).toBe(raw);
  });

  it('holds back an open glossary block regardless of length', () => {
    expect(streamingSafePrefix(`answer [[G]]\n\n<glossary><term name="a">${'d'.repeat(900)}`)).toBe('answer [[G]]\n\n');
  });

  it('nothing is held back inside code (open fence or inline code)', () => {
    expect(streamingSafePrefix('```\n<q')).toBe('```\n<q');
    expect(streamingSafePrefix('see `<q>` and')).toBe('see `<q>` and');
  });

  it('closed citations stream as chips while the tail is held back', () => {
    const p = parseAnswer('one <q>first quote</q> [[P]]\n\ntwo <q>sec', { final: false });
    expect(p.citations).toEqual([{ ordinal: 1, kind: 'quote', quote: 'first quote' }]);
    expect(unmarked(p.displayMd)).toBe('one [❝1](#sp-cite-1) [P](#sp-label-p)\n\ntwo ');
  });

  it('every prefix of a real answer parses without throwing and never shows a half tag', () => {
    const raw = readMockFile('explain_selection.md');
    for (let i = 0; i <= raw.length; i += 7) {
      const p = parseAnswer(raw.slice(0, i), { final: false });
      expect(p.displayMd).not.toMatch(/<q>|<\/q|<eq n="[^"]*$|<glossary>|\[\[[PNG]?\]?$/);
    }
  });
});

describe('parseAnswer: chip provenance (review B1)', () => {
  it('chips carry the parser marker with their citation ordinal or block index', () => {
    const r = parseAnswer('a <q>first quote</q> [[N]]\n\nb <eq n="3"/> and <q>second</q> [[P]]');
    expect(r.displayMd).toContain('\u0003c1\u0004[❝1](#sp-cite-1)');
    expect(r.displayMd).toContain('\u0003e2\u0004[식 (3)](#sp-eq-2)');
    expect(r.displayMd).toContain('\u0003b0\u0004[N](#sp-label-n)');
    expect(r.displayMd).toContain('\u0003b1\u0004[P](#sp-label-p)');
    expect(r.displayMd.match(CHIP_MARK_RE)).toHaveLength(5);
  });
  it('model text cannot carry a marker: control characters are removed first', () => {
    const r = parseAnswer('fake \u0003b0\u0004[P](#sp-label-p) and \u0003c1\u0004[❝1](#sp-cite-1) [[N]]');
    expect(r.issues).toContain('control characters removed');
    expect(r.displayMd.match(CHIP_MARK_RE)).toEqual(['\u0003b0\u0004']); // only the parser's own N badge
  });
  it('review repro: an HTML comment is literal text, so its quote and label stay in their own block', () => {
    const r = parseAnswer(readMockFile('adversarial/forged_badge_comment.md'));
    expect(r.citations).toEqual([{ ordinal: 1, kind: 'quote', quote: 'the robot is now here' }]);
    expect(r.blocks).toEqual([{ label: 'P', citationOrdinals: [1] }, { citationOrdinals: [] }, { citationOrdinals: [] }]);
    expect(unmarked(r.displayMd)).toBe('\\<!--\n[❝1](#sp-cite-1) [P](#sp-label-p)\n\n-->\n\nThe robot can fly [P](<#sp-label-p>)\n');
  });
  it('citations and labels in image alt text, link titles and definitions are demoted and the rest renumbered', () => {
    const r = parseAnswer('![<q>alt quote</q>](x.png) a <q>kept one</q> [[N]]\n\n[t](https://e.x "<q>title quote</q>") b <eq n="2"/> [[P]]\n\n[r]: https://e.x "<q>def quote</q>"\n\nc [t](https://e.x ([[G]]))');
    expect(r.citations).toEqual([
      { ordinal: 1, kind: 'quote', quote: 'kept one' },
      { ordinal: 2, kind: 'equation', eqNumber: '2' },
    ]);
    expect(r.blocks.map((b) => [b.label ?? null, b.citationOrdinals])).toEqual([['N', [1]], ['P', [2]], [null, []], [null, []]]);
    expect(r.issues).toEqual(expect.arrayContaining([expect.stringContaining('3 citation(s)'), expect.stringContaining('1 label(s)')]));
    expect(unmarked(r.displayMd)).toContain('![\\<q>alt quote\\</q>](x.png) a [❝1](#sp-cite-1)');
    expect(unmarked(r.displayMd)).toContain('(\\[\\[G]])');
  });
  it('indented code, math spans and math fences are code: no tags there', () => {
    const r = parseAnswer('text\n\n    <q>in code</q> [[P]]\n\n$a <q>in math</q>$ and\n\n$$\n<q>in fence</q>\n$$\n\n- item\n\n    para <q>in item</q> [[N]]');
    expect(r.citations.map((c) => c.quote)).toEqual(['in item']);
    expect(r.blocks.filter((b) => b.label).map((b) => b.label)).toEqual(['N']);
  });
  it('unpaired backticks / dollars and footnote syntax are escaped; tabs are expanded', () => {
    const r = parseAnswer('a `` b and `code` $x$ c $ d [^1]\n\n[^1]: note\n\n-\tx');
    expect(r.displayMd).toBe('a \\`\\` b and `code` $x$ c \\$ d \\[^1]\n\n\\[^1]: note\n\n-   x');
  });
  it('a chip right after a URL gets a space so the autolink does not swallow it', () => {
    expect(unmarked(parseAnswer('see https://e.x/<q>quote</q>').displayMd)).toBe('see https://e.x/ [❝1](#sp-cite-1)');
    expect(unmarked(parseAnswer('see the<q>quote</q>').displayMd)).toBe('see the[❝1](#sp-cite-1)');
  });
});

describe('parseAnswer: a label that closes a sentence inside a paragraph (live FAST-LIO2 demo)', () => {
  const demo = '오차 상태는 식 (14)로 구한다. [[P]] <eq n="14"/> <q>The error state is 24-dimensional.</q> State는 24차원이다.';
  it('closes a labelled segment: the label, the citations right after it, the rest is the next segment', () => {
    const r = parseAnswer(demo);
    expect(r.blocks).toEqual([{ label: 'P', citationOrdinals: [1, 2] }, { citationOrdinals: [] }]);
    expect(unmarked(r.displayMd)).toBe('오차 상태는 식 (14)로 구한다. [P](#sp-label-p) [식 (14)](#sp-eq-1) [❝2](#sp-cite-2) State는 24차원이다.');
    expect(r.displayMd).toContain('\u0003b0\u0004[P](#sp-label-p)');
  });
  it('several segments in one paragraph keep their own citations; the end label still works', () => {
    expect(parseAnswer('A. [[P]] <q>a</q> B <q>b</q> [[N]]').blocks).toEqual([{ label: 'P', citationOrdinals: [1] }, { label: 'N', citationOrdinals: [2] }]);
    expect(parseAnswer('x <q>q</q> [[G]] rest of it.').blocks).toEqual([{ label: 'G', citationOrdinals: [1] }, { citationOrdinals: [] }]);
  });
  it('mid-sentence, escaped and table-cell labels stay text', () => {
    expect(labels('more words after [[P]] the label')).toEqual([null]);
    expect(labels('end. \\[[P]] more text')).toEqual([null]);
    expect(labels('| a. [[P]] | b |')).toEqual([null]);
  });
});
