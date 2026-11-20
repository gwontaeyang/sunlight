// Stored statistics follow the parser's block ownership (review B4). Owner: supervisor.
import { describe, expect, it } from 'vitest';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { computeStats, resolveCitations } from '../../src/llm/citations';

const PAGES = [{ page: 1, text: 'Intro. The method uses real paper text for registration. End.' }];

describe('grounding statistics', () => {
  it('a [[P]] block with only a forged link is pUnverified even when the borrowed ordinal is verbatim', () => {
    const parsed = parseAnswer('false claim [fake](#sp-cite-1) [[P]]\n\nreal claim <q>real paper text</q> [[P]]', { final: true });
    const citations = resolveCitations(parsed, PAGES, []);
    expect(citations).toEqual([expect.objectContaining({ ordinal: 1, status: 'verbatim' })]);
    const stats = computeStats(parsed, citations);
    expect(stats.blocks).toEqual({ p: 1, pEquationOnly: 0, pUnverified: 1, n: 0, g: 0, unlabeled: 0 });
    expect(stats.quotes).toEqual({ verbatim: 1, fuzzy: 0, ambiguous: 0, notFound: 0 });
  });

  it('not_found and ambiguous quotes never ground a [[P]] block; group sums equal their denominators', () => {
    const pages = [{ page: 1, text: 'robust kernel here. robust kernel there. A unique sentence about voxels.' }];
    const parsed = parseAnswer('x <q>robust kernel</q> [[P]]\n\ny <q>invented sentence that is absent</q> [[P]]\n\nz <q>A unique sentence about voxels.</q> <eq n="9"/> [[P]]\n\nw [[N]]\n\nplain', { final: true });
    const citations = resolveCitations(parsed, pages, []);
    const stats = computeStats(parsed, citations);
    expect(citations.map((c) => c.status)).toEqual(['ambiguous', 'not_found', 'verbatim', 'unindexed']);
    expect(stats.blocks).toEqual({ p: 1, pEquationOnly: 0, pUnverified: 2, n: 1, g: 0, unlabeled: 1 });
    expect(Object.values(stats.blocks).reduce((a, b) => a + b, 0)).toBe(parsed.blocks.length);
    expect(Object.values(stats.quotes).reduce((a, b) => a + b, 0) + Object.values(stats.eqRefs).reduce((a, b) => a + b, 0)).toBe(citations.length);
  });

  it('equation references: unindexed when the paper has no equation index, and they never ground a [[P]] block', () => {
    const parsed = parseAnswer('only an equation <eq n="4"/> [[P]]\n\nquote and equation <q>real paper text</q> <eq n="9"/> [[P]]', { final: true });
    const noIndex = resolveCitations(parsed, PAGES, []);
    expect(noIndex.filter((c) => c.kind === 'equation').map((c) => c.status)).toEqual(['unindexed', 'unindexed']);
    const s1 = computeStats(parsed, noIndex);
    expect(s1.blocks).toMatchObject({ p: 1, pUnverified: 1 });
    expect(s1.eqRefs).toEqual({ resolved: 0, noAnchor: 0, ambiguous: 0, notFound: 0, unindexed: 2 });
    // With an index: 4 is known (no position), 9 is not in it.
    const withIndex = resolveCitations(parsed, PAGES, [{ number: '4', pdfPage: null }]);
    expect(withIndex.filter((c) => c.kind === 'equation').map((c) => c.status)).toEqual(['no_anchor', 'not_found']);
    expect(computeStats(parsed, withIndex).blocks).toMatchObject({ p: 1, pEquationOnly: 1, pUnverified: 0 });
  });
});
