// parseAnswer options (PLAN_M2 3.4, BRIEF_B B3). Owner B. plain = translations / notes / memos (nothing interpreted),
// strip = card item bodies (label tokens removed, no block labels, citation chips kept), D6 link forms (never chips).
import { describe, expect, it } from 'vitest';
import { ParsedAnswerSchema } from '../src/contracts/domain';
import { CHIP_MARK_RE, parseAnswer } from '../src/markup/parseAnswer';
import { readMockFile, readMockManifest } from '../src/mockOutputs';

const marks = (md: string) => [...md.matchAll(CHIP_MARK_RE)].map((m) => m[0]);
/** Citation / equation chips (kind c or e) and label badges (kind b) the parser issued. */
const chipCount = (md: string) => marks(md).filter((m) => m[1] === 'c' || m[1] === 'e').length;
const badgeCount = (md: string) => marks(md).filter((m) => m[1] === 'b').length;

describe("mode: 'plain'", () => {
  const raw = '번역 <q>We estimate the robot pose.</q> 와 <eq n="1"/> [[P]]\n\n중간 [[N]] 글\n\n<glossary><term name="residual">잔차</term></glossary>';
  it('tags, labels and the glossary stay text: no citation, block, glossary, chip or badge', () => {
    const r = parseAnswer(raw, { mode: 'plain' });
    expect(r.citations).toEqual([]);
    expect(r.blocks).toEqual([]);
    expect(r.glossary).toEqual([]);
    expect(marks(r.displayMd)).toEqual([]);
    expect(r.displayMd).toContain('\\<q>We estimate the robot pose.\\</q>');
    expect(r.displayMd).toContain('\\<eq n="1"/>');
    expect(r.displayMd).toContain('[[P]]');
    expect(r.displayMd).toContain('\\<glossary>\\<term name="residual">잔차\\</term>\\</glossary>');
    expect(() => ParsedAnswerSchema.parse(r)).not.toThrow();
  });
  it('HTML and #sp- links are neutralised the same way as in markup mode', () => {
    const r = parseAnswer('<script>x</script> [❝1](#sp-cite-1) [doc](https://example.com)', { mode: 'plain' });
    expect(r.displayMd).toBe('\\<script>x\\</script> \\[❝1\\](#sp-cite-1) [doc](https://example.com)');
  });
  it('plain wins over labels (strip has no effect in plain)', () => {
    expect(parseAnswer(raw, { mode: 'plain', labels: 'strip' })).toEqual(parseAnswer(raw, { mode: 'plain' }));
  });
  it('code stays verbatim; control characters are removed', () => {
    const r = parseAnswer('```\n<q>x</q>\n```\n\na\u0003b', { mode: 'plain' });
    expect(r.displayMd).toContain('```\n<q>x</q>\n```');
    expect(r.displayMd).not.toContain('\u0003');
    expect(r.issues).toContain('control characters removed');
  });
  it('m2.adversarial translate_with_tags: 0 citations, blocks, glossary, chips, badges', () => {
    const e = readMockManifest().m2.adversarial.translate_with_tags!;
    const r = parseAnswer(readMockFile(e.file), e.options);
    expect({ citations: r.citations.length, blocks: r.blocks.length, glossary: r.glossary.length, chips: chipCount(r.displayMd), badges: badgeCount(r.displayMd) }).toEqual(e.expect);
  });
});

describe("labels: 'strip'", () => {
  it('label tokens disappear (end of block and mid-sentence), no block label, citation chips stay', () => {
    const r = parseAnswer('근거 <q>The method runs at 10 Hz on a single CPU core.</q> 와 <eq n="2"/> [[P]]\n\n본문 안 라벨 [[N]] 은 글자가 아니다. [[G]]', { labels: 'strip' });
    expect(r.citations.map((c) => c.kind)).toEqual(['quote', 'equation']);
    expect(chipCount(r.displayMd)).toBe(2);
    expect(badgeCount(r.displayMd)).toBe(0);
    expect(r.blocks.every((b) => b.label === undefined)).toBe(true);
    expect(r.blocks.flatMap((b) => b.citationOrdinals)).toEqual([1, 2]);
    expect(r.displayMd).not.toMatch(/\[\[[PNG]\]\]/);
    expect(r.issues).toContain('3 label token(s) removed (labels: strip)');
  });
  it('an escaped label stays text; code keeps its labels', () => {
    const r = parseAnswer('escaped \\[[P]] and `[[N]]`\n\n```\n[[G]]\n```', { labels: 'strip' });
    expect(r.displayMd).toContain('\\[[P]]');
    expect(r.displayMd).toContain('`[[N]]`');
    expect(r.displayMd).toContain('[[G]]');
    expect(r.issues.some((i) => i.includes('removed'))).toBe(false);
  });
  it('a <q> inside an HTML comment is not a citation (forged_item_badge), outside it is', () => {
    const r = parseAnswer('주석 <!-- <q>We compare against a baseline without the robust kernel.</q> --> 뒤 <q>The robust kernel down-weights outliers in the residual.</q>', { labels: 'strip' });
    expect(r.citations).toEqual([{ ordinal: 1, kind: 'quote', quote: 'The robust kernel down-weights outliers in the residual.' }]);
    expect(r.displayMd).toContain('\\<!-- \\<q>We compare');
    expect(r.issues).toContain('1 HTML comment(s) with tags kept as text');
  });
  it('an unclosed comment runs to the end of the text', () => {
    expect(parseAnswer('a <!-- <q>never a quote</q>', { labels: 'strip' }).citations).toEqual([]);
  });
  it('the default (badge) keeps the M1 behaviour for the same text (comment quotes are citations there)', () => {
    expect(parseAnswer('<!-- <q>x quote</q> --> [[P]]').citations).toHaveLength(1);
  });
  it('the mock card bodies: chips stay, badges 0', () => {
    for (const line of readMockFile('notation_card.md').split('\n').filter(Boolean)) {
      const body = /^<item [^>]*>([\s\S]*)<\/item>$/.exec(line)![1]!;
      const r = parseAnswer(body, { labels: 'strip' });
      expect(badgeCount(r.displayMd)).toBe(0);
      expect(chipCount(r.displayMd)).toBe(r.citations.length);
    }
  });
});

describe('D6 link forms (reference-style, autolink, entity href) never become chips', () => {
  it('m2.adversarial forged_link_forms_d6: no quote, no citation chip, labels as declared', () => {
    const e = readMockManifest().m2.adversarial.forged_link_forms_d6!;
    for (const opts of [e.options, { labels: 'strip' as const }]) {
      const r = parseAnswer(readMockFile(e.file), opts);
      expect(r.citations.filter((c) => c.kind === 'quote')).toHaveLength(e.expect.quotes as number);
      expect(chipCount(r.displayMd)).toBe(e.expect.chips);
    }
    const r = parseAnswer(readMockFile(e.file), e.options);
    expect(r.blocks.map((b) => b.label ?? null)).toEqual(e.expect.labels);
    // only the two label badges carry a marker; every #sp- link the model wrote is unmarked text
    expect(marks(r.displayMd)).toEqual(['\u0003b0\u0004', '\u0003b2\u0004']);
  });
});
