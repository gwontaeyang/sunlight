// Owner A. The stored LaTeX cap is the contract's EQUATION_LATEX_MAX (contracts/domain.ts — the EquationDto /
// Citation.latex schema cap), not a number of latexNormalize's own (X-I10-03): with the contract value replaced, the
// cut follows it. A separate copy could drift and make papers.structure fail its own response contract.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@study-paper/shared/contracts/domain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@study-paper/shared/contracts/domain')>()),
  EQUATION_LATEX_MAX: 12,
}));

describe('normalizeForStore uses the contract EQUATION_LATEX_MAX (X-I10-03)', () => {
  it('a contract cap of 12 cuts at 12', async () => {
    const { normalizeForStore } = await import('../../src/ingest/latexNormalize');
    expect(normalizeForStore('x'.repeat(13))).toEqual({ latex: 'x'.repeat(12), cut: true });
    expect(normalizeForStore('x'.repeat(12))).toEqual({ latex: 'x'.repeat(12), cut: false });
  });
});
