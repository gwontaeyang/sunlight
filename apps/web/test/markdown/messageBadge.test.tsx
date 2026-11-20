// [[P]] block badges of a message (PLAN_M2 3.4 rule 2, D18): verbatim quote → "논문 근거", equation reference only →
// "식 참조 · 내용 대조 안 함" (p-equation-ref, never "논문 근거"), nothing → "근거 미확인"; the stats lines carry
// pEquationOnly ("식 참조만 n", omitted at 0). Owner D.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Citation, MessageStats } from '@study-paper/shared/contracts/domain';
import { statsDetail, statsSummary } from '../../src/markdown/grounding';
import { pairStored, StoredMarkup } from '../../src/markdown/renderStored';

afterEach(cleanup);

const verbatim = (ordinal: number, quote: string): Citation => ({ ordinal, kind: 'quote', quote, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 5 } });
const eq = (ordinal: number, n: string, status: Citation['status']): Citation => ({ ordinal, kind: 'equation', eqNumber: n, status, score: 1, ...(status === 'resolved' || status === 'no_anchor' ? { equationId: `e${n}`, latex: 'x', katexOk: true } : {}) });

const STATS: MessageStats = {
  blocks: { p: 1, pEquationOnly: 2, pUnverified: 1, n: 0, g: 0, unlabeled: 0 },
  quotes: { verbatim: 1, fuzzy: 0, ambiguous: 0, notFound: 0 },
  eqRefs: { resolved: 1, noAnchor: 1, ambiguous: 0, notFound: 0, unindexed: 0 },
};

describe('message [[P]] badges', () => {
  const raw = '근거 문장 <q>alpha beta</q> [[P]]\n\n식만 <eq n="1"/> [[P]]\n\n위치 없는 식 <eq n="2"/> [[P]]\n\n아무것도 없음 [[P]]';
  const citations = [verbatim(1, 'alpha beta'), eq(2, '1', 'resolved'), eq(3, '2', 'no_anchor')];

  it('verbatim → 논문 근거, equation reference only → 식 참조 · 내용 대조 안 함, nothing → 근거 미확인', () => {
    render(<StoredMarkup {...pairStored(raw, citations)} stats={STATS} />);
    const badges = screen.getAllByTestId('sp-badge');
    expect(badges.map((b) => b.dataset.status)).toEqual(['p-grounded', 'p-equation-ref', 'p-equation-ref', 'p-unverified']);
    expect(badges.map((b) => b.textContent)).toEqual(['논문 근거 · 인용 원문에서 찾음', '식 참조 · 내용 대조 안 함', '식 참조 · 내용 대조 안 함', '근거 미확인']);
    // "논문 근거" appears only on the verbatim block
    expect(screen.getAllByText(/논문 근거/)).toHaveLength(2); // the badge + the stats line
    expect(within(screen.getByTestId('sp-stats')).getByText(/식 참조만 2/)).toBeTruthy();
  });

  it('an equation chip in another block never lends its evidence', () => {
    render(<StoredMarkup {...pairStored('식 <eq n="1"/> [[N]]\n\n주장 [[P]]', [eq(1, '1', 'resolved')])} />);
    expect(screen.getAllByTestId('sp-badge').map((b) => b.dataset.status)).toEqual(['N', 'p-unverified']);
  });

  it('ambiguous / not_found / unindexed equation references are not "식 참조" evidence', () => {
    render(<StoredMarkup {...pairStored('A <eq n="1"/> [[P]]\n\nB <eq n="2"/> [[P]]\n\nC <eq n="3"/> [[P]]', [eq(1, '1', 'ambiguous'), eq(2, '2', 'not_found'), eq(3, '3', 'unindexed')])} />);
    expect(screen.getAllByTestId('sp-badge').map((b) => b.dataset.status)).toEqual(['p-unverified', 'p-unverified', 'p-unverified']);
  });
});

describe('stats lines', () => {
  it('statsDetail and statsSummary name pEquationOnly ("식 참조만 n") only when > 0', () => {
    expect(statsDetail(STATS).split('\n')[0]).toBe('라벨: 논문 근거 1 · 식 참조만 2 · 근거 미확인 1 · 명시 없음 0 · 일반 지식 0 · 라벨 없음 0');
    expect(statsSummary(STATS)).toBe('P 1 · 식 참조만 2 · 근거 미확인 1 · 찾지 못함 0');
    const zero = { ...STATS, blocks: { ...STATS.blocks, pEquationOnly: 0 } };
    expect(statsDetail(zero)).not.toContain('식 참조만');
    expect(statsSummary(zero)).toBe('P 1 · 근거 미확인 1 · 찾지 못함 0');
    expect(statsSummary(STATS)).not.toContain('논문 근거');
  });
});
