// Equation references per content (supervisor decision S-2, PLAN_M2 9절 41, review B-R3-03): the first
// MAX_EQ_REFS_PER_MESSAGE `<eq n="…"/>` of one content become citations, every further one stays as text (never a
// chip) and adds an issue — the same treatment as `<q>` past MAX_QUOTES_PER_MESSAGE. Quotes and equation references
// are counted separately. Owner B.
import { describe, expect, it } from 'vitest';
import { MAX_EQ_REFS_PER_MESSAGE, MAX_QUOTES_PER_MESSAGE } from '../src/markup/grammar';
import { CHIP_MARK_RE, parseAnswer } from '../src/markup/parseAnswer';

const ISSUE = `more than ${MAX_EQ_REFS_PER_MESSAGE} <eq> in one message: extra kept as text`;
const eqs = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `<eq n="${from + i}"/>`).join(' ');
/** Equation / citation chips the parser issued (kind e or c). */
const chips = (md: string) => [...md.matchAll(CHIP_MARK_RE)].filter((m) => m[0][1] === 'e' || m[0][1] === 'c').length;

describe('parseAnswer: MAX_EQ_REFS_PER_MESSAGE (S-2)', () => {
  it('the limit is 40', () => {
    expect(MAX_EQ_REFS_PER_MESSAGE).toBe(40);
  });

  for (const opts of [{ final: true }, { final: true, labels: 'strip' as const }]) {
    it(`41 <eq> (${opts.labels ?? 'badge'}): 40 citations, the 41st stays as text, one issue`, () => {
      const p = parseAnswer(`식 비교: ${eqs(41)} 끝.`, opts);
      expect(p.citations).toHaveLength(40);
      expect(p.citations.every((c) => c.kind === 'equation')).toBe(true);
      expect(p.citations.map((c) => c.eqNumber)).toEqual(Array.from({ length: 40 }, (_, i) => String(i + 1)));
      expect(p.citations.map((c) => c.ordinal)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect(p.issues.filter((x) => x === ISSUE)).toHaveLength(1);
      // the extra reference is shown as the (escaped) tag text, not a chip, and no "malformed <eq>" issue is added
      expect(chips(p.displayMd)).toBe(40);
      expect(p.displayMd).toContain('\\<eq n="41"/>');
      expect(p.displayMd).not.toContain('식 (41)');
      expect(p.issues.some((x) => x.includes('that is not'))).toBe(false);
      expect(p.blocks.flatMap((b) => b.citationOrdinals)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    });
  }

  it('40 <eq> → all citations, no issue', () => {
    const p = parseAnswer(eqs(40), { final: true });
    expect(p.citations).toHaveLength(40);
    expect(p.issues).not.toContain(ISSUE);
  });

  it('43 <eq> → 40 citations and one issue per extra reference (like <q>)', () => {
    const p = parseAnswer(eqs(43), { final: true });
    expect(p.citations).toHaveLength(40);
    expect(p.issues.filter((x) => x === ISSUE)).toHaveLength(3);
    for (const n of [41, 42, 43]) expect(p.displayMd).toContain(`\\<eq n="${n}"/>`);
  });

  it('counted separately from <q>: 40 quotes + 41 references → 80 citations in text order, only the 41st <eq> is text', () => {
    const parts: string[] = [];
    for (let i = 1; i <= 41; i++) {
      if (i <= MAX_QUOTES_PER_MESSAGE) parts.push(`<q>quote number ${i}</q>`);
      parts.push(`<eq n="${i}"/>`);
    }
    const p = parseAnswer(parts.join(' '), { final: true });
    expect(p.citations).toHaveLength(80);
    expect(p.citations.filter((c) => c.kind === 'quote')).toHaveLength(40);
    expect(p.citations.filter((c) => c.kind === 'equation')).toHaveLength(40);
    expect(p.citations.map((c) => c.ordinal)).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    expect(p.issues.filter((x) => x === ISSUE)).toHaveLength(1);
    expect(p.issues.some((x) => x.startsWith(`more than ${MAX_QUOTES_PER_MESSAGE} <q>`))).toBe(false);
    expect(p.displayMd).toContain('\\<eq n="41"/>');
  });

  it('per content: two separate contents of 40 each are both whole', () => {
    expect(parseAnswer(eqs(40), { final: true }).citations).toHaveLength(40);
    expect(parseAnswer(eqs(40, 41), { final: true }).citations).toHaveLength(40);
  });

  it('streaming (final: false) applies the same limit', () => {
    const p = parseAnswer(`${eqs(41)} 이어서`, { final: false });
    expect(p.citations).toHaveLength(40);
    expect(chips(p.displayMd)).toBe(40);
  });

  it('an extra reference inside a link title is not counted as a demoted citation (it has its own issue)', () => {
    const p = parseAnswer(`${eqs(40)} [링크](https://example.org "<eq n=\"41\"/>")`, { final: true });
    expect(p.citations).toHaveLength(40);
    expect(p.issues.filter((x) => x === ISSUE)).toHaveLength(1);
    expect(p.issues.some((x) => x.includes('inside a link title'))).toBe(false);
    // a real (40th) reference demoted from a link title is still counted
    const q = parseAnswer(`${eqs(39)} [링크](https://example.org "<eq n=\"40\"/>")`, { final: true });
    expect(q.citations).toHaveLength(39);
    expect(q.issues).toContain('1 citation(s) inside a link title, image text or link definition kept as text');
  });

  it('plain mode is unchanged: no citation at all', () => {
    const p = parseAnswer(eqs(41), { final: true, mode: 'plain' });
    expect(p.citations).toHaveLength(0);
    expect(p.issues).not.toContain(ISSUE);
  });
});

// Review B-F1-01: an extra reference is text for the label rules too. A label right after it is not "right after a
// citation" (so mid-sentence it stays text), and a label followed by it is not at the end of its block — exactly as
// if any other word stood there, and as an extra <q> (which leaves its inner text) behaves.
describe('parseAnswer: an extra <eq> is plain text for the label rules (B-F1-01)', () => {
  const EXTRA = '<eq n="41"/>';
  const WORD = 'Z';
  const tails = [
    'A claim <eq n="41"/> [[P]] B claim continues here. [[N]]', // label after the extra ref, mid-sentence
    'A claim [[P]] <eq n="41"/>', // the extra ref after a label at the block end
    'A claim. [[P]] <eq n="41"/>', // the extra ref after a label that follows a sentence end
    'A claim <eq n="41"/> [[N]]', // label at the block end after the extra ref
  ];
  for (const opts of [{ final: true }, { final: false }]) {
    for (const tail of tails) {
      it(`${JSON.stringify(tail)} (final: ${opts.final}) → same blocks and display as with an ordinary word there`, () => {
        const withEq = parseAnswer(`${eqs(40)}\n\n${tail}`, opts);
        const withWord = parseAnswer(`${eqs(40)}\n\n${tail.replace(EXTRA, WORD)}`, opts);
        expect(withEq.citations).toEqual(withWord.citations);
        expect(withEq.blocks).toEqual(withWord.blocks);
        expect(withEq.displayMd).toBe(withWord.displayMd.replace(` ${WORD}`, ' \\<eq n="41"/>'));
      });
    }
  }

  it('mid-sentence label after the extra ref stays text: one block with label N (as after an extra <q>)', () => {
    const p = parseAnswer(`${eqs(40)}\n\nA claim <eq n="41"/> [[P]] B claim continues here. [[N]]`, { final: true });
    expect(p.blocks.slice(1)).toEqual([{ citationOrdinals: [], label: 'N' }]);
    expect(p.displayMd).toContain('A claim \\<eq n="41"/> [[P]] B claim');
    const q = parseAnswer(`${Array.from({ length: 40 }, (_, i) => `<q>quote number ${i + 1}</q>`).join(' ')}\n\nA claim <q>quote 41</q> [[P]] rest. [[N]]`, { final: true });
    expect(q.blocks.slice(1)).toEqual([{ citationOrdinals: [], label: 'N' }]);
  });

  it('a label followed by the extra ref is not at its block end: [[P]] stays text without a sentence end', () => {
    const p = parseAnswer(`${eqs(40)}\n\nA claim [[P]] <eq n="41"/>`, { final: true });
    expect(p.blocks.slice(1)).toEqual([{ citationOrdinals: [] }]);
    expect(p.displayMd).toContain('A claim [[P]] \\<eq n="41"/>');
    // after a sentence end the label closes a segment; the extra ref starts the next (unlabelled) one
    const s = parseAnswer(`${eqs(40)}\n\nA claim. [[P]] <eq n="41"/>`, { final: true });
    expect(s.blocks.slice(1)).toEqual([{ citationOrdinals: [], label: 'P' }, { citationOrdinals: [] }]);
  });

  it('digits between an extra ref and a later citation never form a citation token', () => {
    const p = parseAnswer(`${eqs(40)} <eq n="41"/>12<q>a later quote</q> and <eq n="42"/>7 [[P]]`, { final: true });
    expect(p.citations).toHaveLength(41);
    expect(p.citations[40]).toEqual({ ordinal: 41, kind: 'quote', quote: 'a later quote' });
    expect(p.displayMd).toContain('\\<eq n="41"/>12');
    expect(p.displayMd).toContain('\\<eq n="42"/>7');
    expect(chips(p.displayMd)).toBe(41);
    expect(p.issues.filter((x) => x === ISSUE)).toHaveLength(2);
  });

  it('strip mode: the extra ref stays escaped text and no label survives', () => {
    const p = parseAnswer(`${eqs(40)} A claim <eq n="41"/> [[P]]`, { final: true, labels: 'strip' });
    expect(p.citations).toHaveLength(40);
    expect(p.blocks.every((b) => b.label === undefined)).toBe(true);
    expect(p.displayMd).toContain('\\<eq n="41"/>');
    expect(p.issues.filter((x) => x === ISSUE)).toHaveLength(1);
  });
});
