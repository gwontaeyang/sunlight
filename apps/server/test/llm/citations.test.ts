// citations.ts with a controlled matcher: all four quote states, pageHint, equation states, stats sums. Owner B.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuoteMatch } from '@study-paper/shared/anchor/matchQuote';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';

const calls: { exact: string; opts: unknown }[] = [];
const results = new Map<string, QuoteMatch>();
vi.mock('@study-paper/shared/anchor/matchQuote', async (importActual) => ({
  ...(await importActual<typeof import('@study-paper/shared/anchor/matchQuote')>()),
  matchQuote: (_pages: unknown, sel: { exact: string }, opts: unknown) => {
    calls.push({ exact: sel.exact, opts });
    return results.get(sel.exact) ?? { status: 'not_found', score: 0 };
  },
}));
const { computeStats, normalizeEqNumber, resolveCitations } = await import('../../src/llm/citations');
const { WorkBudget } = await import('@study-paper/shared/anchor/matchQuote');

const PAGES = [
  { page: 1, text: 'one' },
  { page: 2, text: 'two' },
];

beforeEach(() => {
  calls.length = 0;
  results.clear();
});

describe('resolveCitations', () => {
  it('passes the four quote states through; only verbatim and fuzzy keep a position', () => {
    results.set('verbatim quote here', { status: 'verbatim', score: 1, position: { page: 2, start: 0, end: 5 } });
    results.set('fuzzy quote here', { status: 'fuzzy', score: 0.86, position: { page: 1, start: 1, end: 4 } });
    results.set('ambiguous quote', { status: 'ambiguous', score: 0, candidates: 3 });
    const parsed = parseAnswer('a <q>verbatim quote here</q> b <q>fuzzy quote here</q> c <q>ambiguous quote</q> d <q>missing quote</q> [[P]]');
    const c = resolveCitations(parsed, PAGES, [], { pageHint: 2 });
    expect(c).toEqual([
      { ordinal: 1, kind: 'quote', quote: 'verbatim quote here', status: 'verbatim', score: 1, position: { page: 2, start: 0, end: 5 } },
      { ordinal: 2, kind: 'quote', quote: 'fuzzy quote here', status: 'fuzzy', score: 0.86, position: { page: 1, start: 1, end: 4 } },
      { ordinal: 3, kind: 'quote', quote: 'ambiguous quote', status: 'ambiguous', score: 0, candidates: 3 },
      { ordinal: 4, kind: 'quote', quote: 'missing quote', status: 'not_found', score: 0 },
    ]);
    expect(calls.map((x) => x.opts)).toEqual(Array.from({ length: 4 }, () => ({ pageHint: 2, budget: expect.any(WorkBudget) })));
    // one work budget shared by every quote of the answer (review N3)
    expect(new Set(calls.map((x) => (x.opts as { budget: unknown }).budget)).size).toBe(1);
  });

  it('a pageHint outside the paper is ignored', () => {
    resolveCitations(parseAnswer('<q>some quote text</q>'), PAGES, [], { pageHint: 9 });
    expect(calls[0]!.opts).toEqual({ budget: expect.any(WorkBudget) });
  });

  it('equation references: resolved / no_anchor / ambiguous / not_found, numbers compared without "(…)"', () => {
    const eqs = [
      { number: '(1)', pdfPage: 1 },
      { number: '2', pdfPage: null },
      { number: '3', pdfPage: 1 },
      { number: '3', pdfPage: 2 },
    ];
    const c = resolveCitations(parseAnswer('<eq n="1"/> <eq n="2"/> <eq n="3"/> <eq n="4"/>'), PAGES, eqs);
    expect(c.map((x) => [x.status, x.score, x.candidates])).toEqual([
      ['resolved', 1, undefined],
      ['no_anchor', 1, undefined],
      ['ambiguous', 0, 2],
      ['not_found', 0, undefined],
    ]);
    expect(normalizeEqNumber(' Eq. (4a) ')).toBe('4a');
  });
});

describe('computeStats', () => {
  it('[[P]] is grounded only by verbatim; resolved/no_anchor alone is pEquationOnly (D18); fuzzy and ambiguous are not; groups sum to their denominators', () => {
    results.set('verbatim quote here', { status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 3 } });
    results.set('fuzzy quote here', { status: 'fuzzy', score: 0.9, position: { page: 1, start: 0, end: 3 } });
    results.set('ambiguous quote', { status: 'ambiguous', score: 0, candidates: 2 });
    const parsed = parseAnswer(
      [
        'a <q>verbatim quote here</q> [[P]]',
        'b <q>fuzzy quote here</q> [[P]]',
        'c <q>ambiguous quote</q> [[P]]',
        'd <eq n="2"/> [[P]]',
        'e <eq n="9"/> [[P]]',
        'f [[N]]',
        'g [[G]]',
        'h',
      ].join('\n\n'),
    );
    const cites = resolveCitations(parsed, PAGES, [{ number: '2', pdfPage: null }]);
    const s = computeStats(parsed, cites);
    expect(s).toEqual({
      blocks: { p: 1, pEquationOnly: 1, pUnverified: 3, n: 1, g: 1, unlabeled: 1 },
      quotes: { verbatim: 1, fuzzy: 1, ambiguous: 1, notFound: 0 },
      eqRefs: { resolved: 0, noAnchor: 1, ambiguous: 0, notFound: 1, unindexed: 0 },
    });
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(s.blocks)).toBe(parsed.blocks.length);
    expect(sum(s.quotes) + sum(s.eqRefs)).toBe(cites.length);
  });
});
