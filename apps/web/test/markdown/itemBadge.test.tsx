// Card item badge display (PLAN_M2 3.4 rule 2): the 7 itemBadge results → ITEM_BADGE_KO text and a distinct shape.
// The decision itself is S's (grounding.test); this file checks only what the panel draws. Owner D.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cardBadgeCounts, ITEM_BADGE_KO, ITEM_BADGES, itemBadge, type ItemBadge } from '@study-paper/shared/contracts/grounding';
import type { Citation } from '@study-paper/shared/contracts/domain';
import { badgeOf, ItemBadgeView, pairStored } from '../../src/markdown/renderStored';
import { CardHeaderCounts } from '../../src/panel/CardsTab';

afterEach(cleanup);

describe('ItemBadgeView', () => {
  it('draws each of the 7 results with its Korean text; none draws nothing', () => {
    const classes = new Set<string>();
    for (const b of ITEM_BADGES) {
      const { container } = render(<ItemBadgeView badge={b} />);
      const el = screen.queryByTestId('pn-item-badge');
      if (b === 'none') {
        expect(el).toBeNull();
        expect(container.textContent).toBe('');
      } else {
        expect(el!.dataset.badge).toBe(b);
        expect(el!.textContent).toBe(ITEM_BADGE_KO[b]);
        classes.add(el!.className);
      }
      cleanup();
    }
    expect(classes.size).toBeGreaterThanOrEqual(5); // N and G share the neutral shape; the others differ
  });

  it('"논문 근거" only on grounded_quote; equation_ref and unconfirmed look different from it', () => {
    render(
      <>
        <ItemBadgeView badge="grounded_quote" />
        <ItemBadgeView badge="equation_ref" />
        <ItemBadgeView badge="unconfirmed" />
      </>,
    );
    const [g, e, u] = screen.getAllByTestId('pn-item-badge');
    expect(g!.textContent).toContain('논문 근거');
    expect(e!.textContent).toBe('식 참조 · 내용 대조 안 함');
    expect(u!.textContent).toBe('확인 안 됨');
    expect(new Set([g!.className, e!.className, u!.className]).size).toBe(3);
  });

  it('badgeOf = itemBadge(label, the pairing of the body)', () => {
    const v: Citation = { ordinal: 1, kind: 'quote', quote: 'a b', status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 3 } };
    const pair = pairStored('본문 <q>a b</q>', [v], { labels: 'strip' });
    expect(badgeOf('P', pair)).toBe(itemBadge('P', pair.paired));
    expect(badgeOf('P', pair)).toBe('grounded_quote');
    expect(badgeOf(null, pair)).toBe('none');
    expect(badgeOf('P', pairStored('본문 <q>a b</q>', [], { labels: 'strip' }))).toBe('unconfirmed');
  });

  it('header counts show cardBadgeCounts of the item badges (summary "none" not counted, zeros omitted)', () => {
    const badges: ItemBadge[] = ['grounded_quote', 'grounded_quote', 'equation_ref', 'unverified', 'not_stated', 'general', 'unconfirmed', 'none'];
    render(<CardHeaderCounts badges={badges} confirmed={3} total={7} />);
    const want = cardBadgeCounts(badges);
    const shown = Object.fromEntries([...screen.getByTestId('pn-card-counts').querySelectorAll<HTMLElement>('[data-count]')].map((e) => [e.dataset.count, Number(e.textContent!.replace(/^\D+/, '').split(' ')[0])]));
    expect(shown).toEqual({ ...want, confirmed: 3 });
    cleanup();
    render(<CardHeaderCounts badges={['not_stated', 'none']} confirmed={0} total={1} />);
    expect(screen.getByTestId('pn-card-counts').textContent).toBe('명시 없음 1확인함 0 / 1');
  });
});
