// Why a quote stayed unchecked (PLAN_M2 5 "unchecked 이유 미저장", BRIEF_B B6): quote_too_long (N1 needle over
// MAX_NEEDLE_CHARS), text_too_long (page text over MAX_TEXT_CHARS), work_budget (anything else). The matcher is
// unchanged; the reason is decided outside it and stored in citations.detail. Owner B.
import { describe, expect, it } from 'vitest';
import type { ParsedAnswer } from '@study-paper/shared/contracts/domain';
import { MAX_NEEDLE_CHARS, MAX_TEXT_CHARS, WorkBudget } from '@study-paper/shared/anchor/matchQuote';
import { resolveCitations, uncheckedReasonOf } from '../../src/llm/citations';

const quote = (q: string): ParsedAnswer => ({ displayMd: '', citations: [{ ordinal: 1, kind: 'quote', quote: q }], blocks: [], glossary: [], issues: [] });
const PAGES = [{ page: 1, text: 'The robust kernel down-weights outliers in the residual.' }];

describe('uncheckedReason', () => {
  it('quote_too_long: a needle longer than MAX_NEEDLE_CHARS N1 units', () => {
    const long = 'word '.repeat(MAX_NEEDLE_CHARS);
    const [c] = resolveCitations(quote(long), PAGES, []);
    expect(c).toMatchObject({ status: 'unchecked', uncheckedReason: 'quote_too_long' });
  });
  it('text_too_long: the pages together over MAX_TEXT_CHARS', () => {
    const big = [{ page: 1, text: 'x'.repeat(MAX_TEXT_CHARS + 1) }];
    const [c] = resolveCitations(quote('The robust kernel down-weights outliers.'), big, []);
    expect(c).toMatchObject({ status: 'unchecked', uncheckedReason: 'text_too_long' });
    expect(uncheckedReasonOf('short', big)).toBe('text_too_long');
  });
  it('work_budget: the shared budget is used up', () => {
    const budget = new WorkBudget(1);
    const [c] = resolveCitations(quote('The robust kernel down-weights outliers.'), PAGES, [], { budget });
    expect(c).toMatchObject({ status: 'unchecked', uncheckedReason: 'work_budget' });
  });
  it('other states carry no reason', () => {
    const [c] = resolveCitations(quote('The robust kernel down-weights outliers in the residual.'), PAGES, []);
    expect(c!.status).toBe('verbatim');
    expect('uncheckedReason' in c!).toBe(false);
  });
});
