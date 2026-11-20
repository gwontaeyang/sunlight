// Review N3: the whole citation resolution of one answer (exact + fuzzy, all quotes) is bounded by one work
// budget; what does not fit is `unchecked` and counted as such. Real matcher (no mock). Owner F1.
import { describe, expect, it } from 'vitest';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { computeStats, resolveCitations } from '../../src/llm/citations';

const PAGES = [{ page: 1, text: 'a'.repeat(20000) }];
const answer = (quote: string) => parseAnswer(Array.from({ length: 40 }, (_, i) => `주장 ${i} <q>${quote}</q> [[P]]`).join('\n\n'));

describe('resolveCitations: one answer is bounded', () => {
  it.each([
    ['Codex reproduction: B + a×299 (was ~7.9 s)', `B${'a'.repeat(299)}`],
    ['A×600', 'A'.repeat(600)],
    ['a×599 + b', `${'a'.repeat(599)}b`],
  ])('%s: 40 quotes, statuses explicit, stats sum up', (_n, quote) => {
    const parsed = answer(quote);
    expect(parsed.citations).toHaveLength(40);
    const t0 = performance.now();
    const cites = resolveCitations(parsed, PAGES, []);
    // loose sanity bound only (parallel test load); the deterministic unit gate is in shared matchQuote.test.ts
    expect(performance.now() - t0).toBeLessThan(5000);
    for (const c of cites) expect(['fuzzy', 'not_found', 'unchecked']).toContain(c.status);
    const stats = computeStats(parsed, cites);
    const q = stats.quotes;
    expect(q.verbatim + q.fuzzy + q.ambiguous + q.notFound + (q.unchecked ?? 0)).toBe(40);
    expect(stats.blocks.p).toBe(0);
    expect(q.unchecked ?? 0).toBe(cites.filter((c) => c.status === 'unchecked').length);
  });
  it('a normal answer on a normal page is unaffected (verbatim, not unchecked)', () => {
    const cites = resolveCitations(parseAnswer('a <q>The robust kernel down-weights outliers.</q> [[P]]'), [{ page: 1, text: 'Intro.\nThe robust kernel down-weights outliers.\n' }], []);
    expect(cites[0]!.status).toBe('verbatim');
  });
});
