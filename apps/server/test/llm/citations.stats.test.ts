// MessageStats.blocks with equation references (PLAN_M2 D18, BRIEF_B B6): a [[P]] block whose only evidence is a
// resolved / no_anchor equation reference counts as pEquationOnly (not p); the block counts sum to the block number.
// Owner B.
import { describe, expect, it } from 'vitest';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { computeStats, resolveCitations } from '../../src/llm/citations';

const PAGES = [{ page: 1, text: 'The robust kernel down-weights outliers in the residual.' }];
const INDEX = [{ id: 'e1', number: '1', pdfPage: 1 }, { id: 'e2', number: '2', pdfPage: null }];

describe('computeStats with an equation index', () => {
  it('equation-only P → pEquationOnly 1, p 0; with a verbatim quote → p', () => {
    const parsed = parseAnswer('식으로만 <eq n="1"/> [[P]]');
    const s = computeStats(parsed, resolveCitations(parsed, PAGES, INDEX));
    expect(s.blocks).toEqual({ p: 0, pEquationOnly: 1, pUnverified: 0, n: 0, g: 0, unlabeled: 0 });
    const both = parseAnswer('식 <eq n="2"/> 과 <q>The robust kernel down-weights outliers in the residual.</q> [[P]]');
    expect(computeStats(both, resolveCitations(both, PAGES, INDEX)).blocks).toMatchObject({ p: 1, pEquationOnly: 0 });
  });
  it('the block counts always sum to the number of blocks', () => {
    const parsed = parseAnswer('a <eq n="1"/> [[P]]\n\nb <eq n="9"/> [[P]]\n\nc <q>The robust kernel down-weights outliers in the residual.</q> [[P]]\n\nd [[N]]\n\ne [[G]]\n\nf');
    const s = computeStats(parsed, resolveCitations(parsed, PAGES, INDEX));
    expect(s.blocks).toEqual({ p: 1, pEquationOnly: 1, pUnverified: 1, n: 1, g: 1, unlabeled: 1 });
    expect(Object.values(s.blocks).reduce((a, b) => a + b, 0)).toBe(parsed.blocks.length);
    expect(s.eqRefs).toMatchObject({ resolved: 1, notFound: 1 });
  });
});
