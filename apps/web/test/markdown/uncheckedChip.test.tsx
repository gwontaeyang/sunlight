// The reason of an `unchecked` quote chip (BRIEF_D D3, PLAN_M2 3.3 uncheckedReason): chip text and tooltip in Korean for
// the three reasons, and a stored row without a reason (M1 data) read as the work budget. Review D-R1-08. Owner D.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Citation, UncheckedReason } from '@study-paper/shared/contracts/domain';
import { UNCHECKED_TEXT } from '../../src/markdown/chips';
import { pairStored, StoredMarkup } from '../../src/markdown/renderStored';

afterEach(cleanup);

const Q = 'We estimate the robot pose';
const unchecked = (reason?: UncheckedReason): Citation => ({ ordinal: 1, kind: 'quote', quote: Q, status: 'unchecked', score: 0, ...(reason ? { uncheckedReason: reason } : {}) });

describe('unchecked quote chip: reason text', () => {
  it.each([
    ['quote_too_long', '인용이 너무 김', '인용이 너무 김'],
    ['text_too_long', '논문이 너무 김', '논문이 너무 김'],
    ['work_budget', '작업량 초과', '대조 시간 한도'],
    [undefined, '작업량 초과', '대조 시간 한도'],
  ] as const)('%s → chip "(%s)", tooltip "(%s)"', (reason, chipText, title) => {
    render(<StoredMarkup {...pairStored(`<q>${Q}</q> [[P]]`, [unchecked(reason)])} />);
    const chip = screen.getByTestId('sp-chip');
    expect(chip.dataset.status).toBe('unchecked');
    expect(chip.dataset.ordinal).toBe('1');
    expect(chip.dataset.reason).toBe(reason);
    expect(chip.textContent).toBe(`❝1 확인 못 함(${chipText})`);
    expect(chip.getAttribute('title')).toBe(`원문과 맞춰 보지 못했습니다(${title}) — ${Q}`);
    expect(chip.textContent).not.toContain('논문 근거');
  });

  it('the table covers every UncheckedReason with distinct chip texts', () => {
    expect(Object.keys(UNCHECKED_TEXT).sort()).toEqual(['quote_too_long', 'text_too_long', 'work_budget']);
    expect(new Set(Object.values(UNCHECKED_TEXT).map((t) => t.chip)).size).toBe(3);
  });
});
