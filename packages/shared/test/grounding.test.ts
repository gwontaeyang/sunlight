// Grounding decisions and pairing (BRIEF_S S3b, PLAN_M2 3.4 rules 2 and 5, D18). Owner: supervisor.
import { describe, expect, it } from 'vitest';
import type { Citation, GroundingLabel, RawCitation } from '../src/contracts/domain';
import { cardBadgeCounts, evidenceOf, groundsClaim, ITEM_BADGE_KO, ITEM_BADGES, itemBadge, pairCitations, type ItemBadge } from '../src/contracts/grounding';

const q = (ordinal: number, quote: string, status: Citation['status']): Citation => ({ ordinal, kind: 'quote', quote, status, score: status === 'verbatim' ? 1 : 0.5 });
const e = (ordinal: number, eqNumber: string, status: Citation['status']): Citation => ({ ordinal, kind: 'equation', eqNumber, status, score: status === 'resolved' || status === 'no_anchor' ? 1 : 0 });
const raw = (c: Citation): RawCitation => (c.kind === 'quote' ? { ordinal: c.ordinal, kind: 'quote', quote: c.quote } : { ordinal: c.ordinal, kind: 'equation', eqNumber: c.eqNumber });
const pairedOf = (cs: Citation[]) => pairCitations(cs.map(raw), cs);

describe('groundsClaim / evidenceOf', () => {
  it('only a verbatim quote grounds a claim', () => {
    const table: [Citation, boolean][] = [
      [q(1, 'a', 'verbatim'), true],
      [q(1, 'a', 'fuzzy'), false],
      [q(1, 'a', 'ambiguous'), false],
      [q(1, 'a', 'not_found'), false],
      [q(1, 'a', 'unchecked'), false],
      [e(1, '1', 'resolved'), false],
      [e(1, '1', 'no_anchor'), false],
      [e(1, '1', 'ambiguous'), false],
      [e(1, '1', 'not_found'), false],
      [e(1, '1', 'unindexed'), false],
    ];
    for (const [c, want] of table) expect(groundsClaim(c), `${c.kind} ${c.status}`).toBe(want);
  });

  it('evidenceOf: quote > equation_ref (resolved | no_anchor) > none', () => {
    expect(evidenceOf([])).toBe('none');
    expect(evidenceOf([q(1, 'a', 'verbatim')])).toBe('quote');
    expect(evidenceOf([e(1, '1', 'resolved'), q(2, 'a', 'verbatim')])).toBe('quote');
    expect(evidenceOf([e(1, '1', 'resolved')])).toBe('equation_ref');
    expect(evidenceOf([e(1, '1', 'no_anchor'), q(2, 'a', 'fuzzy')])).toBe('equation_ref');
    expect(evidenceOf([q(1, 'a', 'fuzzy'), q(2, 'b', 'ambiguous'), e(3, '1', 'ambiguous'), e(4, '9', 'not_found'), e(5, '2', 'unindexed'), q(6, 'c', 'unchecked')])).toBe('none');
  });
});

describe('pairCitations', () => {
  const stored = [q(1, 'real paper text', 'verbatim'), e(2, '1', 'resolved')];
  it('same count and every (ordinal, kind, quote/eqNumber) → Map(ordinal → stored)', () => {
    const p = pairCitations(stored.map(raw), stored);
    expect(p).not.toBeNull();
    expect([...p!.entries()]).toEqual([
      [1, stored[0]],
      [2, stored[1]],
    ]);
    expect(pairCitations([], [])).toEqual(new Map());
  });
  it('the four mismatches → null', () => {
    const parsed = stored.map(raw);
    expect(pairCitations(parsed.slice(0, 1), stored), 'count').toBeNull();
    expect(pairCitations([parsed[0]!, { ordinal: 2, kind: 'quote', quote: '1' }], stored), 'kind').toBeNull();
    expect(pairCitations([{ ...parsed[0]!, quote: 'other text' }, parsed[1]!], stored), 'quote').toBeNull();
    expect(pairCitations([parsed[0]!, { ...parsed[1]!, eqNumber: '2' }], stored), 'eqNumber').toBeNull();
  });
  it('duplicate or shifted ordinals → null', () => {
    const parsed = stored.map(raw);
    expect(pairCitations([parsed[0]!, { ...parsed[1]!, ordinal: 3 }], stored)).toBeNull();
    expect(pairCitations([parsed[0]!, parsed[0]!], [stored[0]!, stored[0]!])).toBeNull();
  });
});

describe('itemBadge', () => {
  // paired cases: null (mismatch) / verbatim / equation refs only (resolved, no_anchor) / fuzzy only / none.
  const cases: [string, Citation[] | null][] = [
    ['mismatch', null],
    ['verbatim', [q(1, 'a', 'verbatim'), e(2, '1', 'resolved')]],
    ['resolved only', [e(1, '1', 'resolved')]],
    ['no_anchor only', [e(1, '2', 'no_anchor')]],
    ['fuzzy only', [q(1, 'a', 'fuzzy')]],
    ['no citations', []],
  ];
  const expected: Record<string, Record<string, ItemBadge>> = {
    null: { mismatch: 'none', verbatim: 'none', 'resolved only': 'none', 'no_anchor only': 'none', 'fuzzy only': 'none', 'no citations': 'none' },
    P: { mismatch: 'unconfirmed', verbatim: 'grounded_quote', 'resolved only': 'equation_ref', 'no_anchor only': 'equation_ref', 'fuzzy only': 'unverified', 'no citations': 'unverified' },
    N: { mismatch: 'unconfirmed', verbatim: 'not_stated', 'resolved only': 'not_stated', 'no_anchor only': 'not_stated', 'fuzzy only': 'not_stated', 'no citations': 'not_stated' },
    G: { mismatch: 'unconfirmed', verbatim: 'general', 'resolved only': 'general', 'no_anchor only': 'general', 'fuzzy only': 'general', 'no citations': 'general' },
  };
  it('the full table: label 4 kinds × paired cases', () => {
    let n = 0;
    for (const label of [null, 'P', 'N', 'G'] as (GroundingLabel | null)[]) {
      for (const [name, cs] of cases) {
        const paired = cs === null ? null : pairedOf(cs);
        if (cs !== null) expect(paired).not.toBeNull();
        expect(itemBadge(label, paired), `${String(label)} × ${name}`).toBe(expected[String(label)]![name]);
        n++;
      }
    }
    expect(n).toBe(24);
  });
});

describe('cardBadgeCounts and ITEM_BADGE_KO', () => {
  it('counts only item badges; the sum equals the items without a summary (none) item', () => {
    const badges: ItemBadge[] = ['grounded_quote', 'grounded_quote', 'equation_ref', 'unverified', 'not_stated', 'general', 'unconfirmed', 'none'];
    const counts = cardBadgeCounts(badges);
    expect(counts).toEqual({ grounded_quote: 2, equation_ref: 1, unverified: 1, not_stated: 1, general: 1, unconfirmed: 1 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(badges.filter((b) => b !== 'none').length);
    expect(cardBadgeCounts([])).toEqual({ grounded_quote: 0, equation_ref: 0, unverified: 0, not_stated: 0, general: 0, unconfirmed: 0 });
  });
  it('"논문 근거" appears only in grounded_quote; none has no text; every badge has an entry', () => {
    expect(Object.keys(ITEM_BADGE_KO).sort()).toEqual([...ITEM_BADGES].sort());
    const withGround = ITEM_BADGES.filter((b) => ITEM_BADGE_KO[b]?.includes('논문 근거'));
    expect(withGround).toEqual(['grounded_quote']);
    expect(ITEM_BADGE_KO.none).toBeNull();
    expect(ITEM_BADGE_KO.equation_ref).toBe('식 참조 · 내용 대조 안 함');
    expect(ITEM_BADGE_KO.unconfirmed).toBe('확인 안 됨');
  });
});
