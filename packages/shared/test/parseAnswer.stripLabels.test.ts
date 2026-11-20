// labels: 'strip' removes label tokens until none is left (review B-I10-01, coordinator notes 추가 지시 8 B 4): a
// removal can join the text around it into a new token (`[[[[P]]P]]` → `[[P]]`), which applyLabels then turned into a
// block label and a badge chip inside a card item body. The scan rechecks the point of each removal (a stack of the
// kept characters with their backslash runs) and stays linear. Card item labels come from the item attribute only.
// Owner B.
import { describe, expect, it } from 'vitest';
import { type MarkupWork, parseAnswer, splitFences } from '../src/markup/parseAnswer';

const STRIP = { final: true, labels: 'strip' } as const;
const badgeMarks = (md: string) => md.match(/\u0003b\d+\u0004/g) ?? [];
/** `[[P]]` / `[[N]]` / `[[G]]` in the text that an even run of backslashes (or none) precedes: an unescaped token. */
function unescapedTokens(md: string): number {
  let n = 0;
  for (const m of md.matchAll(/\[\[[PNG]\]\]/g)) {
    let run = 0;
    for (let i = m.index - 1; i >= 0 && md[i] === '\\'; i--) run++;
    if (run % 2 === 0) n++;
  }
  return n;
}
/** No labelled block and no badge chip; and, when the text has no code segment (fence, indented code — code keeps
 * its tokens as written), no unescaped token left in the display text. Returns whether the token check ran. */
function noLabels(raw: string): { r: ReturnType<typeof parseAnswer>; tokenChecked: boolean } {
  const r = parseAnswer(raw, STRIP);
  expect(r.blocks.filter((b) => b.label !== undefined), JSON.stringify(raw)).toEqual([]);
  expect(badgeMarks(r.displayMd), JSON.stringify(raw)).toEqual([]);
  const tokenChecked = !splitFences(raw).some((seg) => seg.code);
  if (tokenChecked) expect(unescapedTokens(r.displayMd), JSON.stringify(raw)).toBe(0);
  return { r, tokenChecked };
}
const expectNoLabels = (raw: string) => {
  const { r, tokenChecked } = noLabels(raw);
  expect(tokenChecked).toBe(true);
  return r;
};

describe("labels: 'strip' — a removal that forms a new token removes that one too", () => {
  it('the review inputs', () => {
    const r = expectNoLabels('The filter is iterated. [[[[P]]P]] <q>iterated Kalman filter</q>');
    expect(r.citations).toHaveLength(1);
    expect(r.issues).toContain('2 label token(s) removed (labels: strip)');
    expectNoLabels('Claim one. [[[[N]]G]]');
    expectNoLabels('[[N[[G]]]]');
    expect(expectNoLabels('[[N[[G]]]]').displayMd).toBe('');
    expectNoLabels('a. [[[[[[P]]P]]P]]');
    expectNoLabels('a. [[[[[[P]]P]]P]] b. [[[[N]]G]]\n\nc. [[[[G]]N]]');
  });

  it('escapes still hold: an odd backslash run keeps the joined token as escaped text, an even one does not', () => {
    const odd = expectNoLabels('a \\[[[[P]]P]]');
    expect(odd.displayMd).toContain('\\[[P]]');
    expect(odd.issues).toContain('1 label token(s) removed (labels: strip)');
    const even = expectNoLabels('a \\\\[[[[P]]P]]');
    expect(even.displayMd).not.toContain('[[P]]');
    expect(even.issues).toContain('2 label token(s) removed (labels: strip)');
  });

  it('fixed-seed fuzz: no labelled block, no badge chip, no unescaped token in strip mode', () => {
    // mulberry32 (public domain): Math.imul-based, a distinct string per draw
    let seed = 0x5eed_b4;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // no backtick: a code span keeps its tokens as written (the 'code keeps its labels' case of parseAnswer.modes)
    const ALPHABET = ['[', '[', '[', ']', ']', ']', 'P', 'N', 'G', '\\', ' ', '.', 'x', '\n', '[[P]]', '[[N]]', '<q>a b c</q>'];
    const seen = new Set<string>();
    let tokenChecked = 0;
    for (let k = 0; k < 20_000; k++) {
      const len = 4 + Math.floor(rnd() * 24);
      let raw = '';
      for (let i = 0; i < len; i++) raw += ALPHABET[Math.floor(rnd() * ALPHABET.length)]!;
      seen.add(raw);
      if (noLabels(raw).tokenChecked) tokenChecked++;
    }
    expect(seen.size).toBeGreaterThan(19_000);
    expect(tokenChecked).toBeGreaterThan(15_000);
  });

  it('linear work for nested tokens: 100× the input → ≤ 100× the steps + a constant', () => {
    for (const unit of ['[[[[P]]P]] ', '[[N[[G]]]] ', '[[[[[[P]]P]]P]]. ', '\\\\[[[[P]]P]]']) {
      const steps = (n: number) => {
        const w: MarkupWork = { steps: 0 };
        parseAnswer(unit.repeat(n), STRIP, w);
        return w.steps;
      };
      const one = steps(200);
      expect(steps(20_000), unit).toBeLessThanOrEqual(100 * one + 5_000);
    }
    // one deep nest: [[ × k then P]] × k collapses entirely
    const k = 50_000;
    const deep = `${'[['.repeat(k)}P]]${'P]]'.repeat(k - 1)}`;
    const w: MarkupWork = { steps: 0 };
    const r = parseAnswer(deep, STRIP, w);
    expect(r.displayMd).toBe('');
    expect(r.issues).toContain(`${k} label token(s) removed (labels: strip)`);
  });
});
