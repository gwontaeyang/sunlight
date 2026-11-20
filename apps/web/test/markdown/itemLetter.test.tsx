// M3a card item letters (concept_CD D panel): P / N / G drawn from the SAME item badge as the badge words, never from
// the label alone; a quiet badge keeps its words for screen readers. Owner D.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaperCardDto } from '@study-paper/shared/contracts/api';
import { ITEM_BADGE_KO, ITEM_BADGES } from '@study-paper/shared/contracts/grounding';
import { ItemBadgeView, ItemLetter } from '../../src/markdown/renderStored';
import { CardBody } from '../../src/panel/CardsTab';
import { card as cardOf } from '../panel/cardFixtures';

afterEach(cleanup);

const LETTER = { grounded_quote: 'P', equation_ref: 'P', unverified: 'P', not_stated: 'N', general: 'G', unconfirmed: '?' } as const;

describe('ItemLetter', () => {
  it('one letter per badge result; none draws nothing; decorative (aria-hidden) and never says "논문 근거"', () => {
    for (const b of ITEM_BADGES) {
      const { container } = render(<ItemLetter badge={b} />);
      const el = screen.queryByTestId('pn-item-letter');
      if (b === 'none') expect(el).toBeNull();
      else {
        expect(el!.textContent).toBe(LETTER[b]);
        expect(el!.getAttribute('aria-hidden')).toBe('true');
        expect(el!.dataset.badge).toBe(b);
        expect(container.textContent).not.toContain('논문 근거');
      }
      cleanup();
    }
  });

  it('only a grounded quote gets the filled proof look; P without a verbatim quote is outlined, N dashed, G round', () => {
    const cls = (b: (typeof ITEM_BADGES)[number]) => {
      render(<ItemLetter badge={b} />);
      const c = screen.getByTestId('pn-item-letter').className;
      cleanup();
      return c;
    };
    expect(cls('grounded_quote')).toContain('bg-sl-proof-bg');
    for (const b of ['equation_ref', 'unverified', 'not_stated', 'general', 'unconfirmed'] as const) expect(cls(b)).not.toContain('bg-sl-proof-bg');
    expect(cls('not_stated')).toContain('border-dashed');
    expect(cls('general')).toContain('rounded-full');
    expect(cls('unconfirmed')).toContain('border-dotted');
  });

  it('quiet badge: the plain verdicts keep their words for screen readers, the others stay visible', () => {
    for (const b of ITEM_BADGES) {
      render(<ItemBadgeView badge={b} quiet />);
      const el = screen.queryByTestId('pn-item-badge');
      if (b === 'none') expect(el).toBeNull();
      else {
        expect(el!.textContent).toBe(ITEM_BADGE_KO[b]);
        expect(el!.className.split(/\s+/).includes('sr-only')).toBe(b === 'grounded_quote' || b === 'not_stated' || b === 'general');
      }
      cleanup();
    }
  });

  it('in a card, every item letter agrees with that item’s badge (one computation)', () => {
    const card: PaperCardDto = cardOf('notation');
    render(<CardBody card={card} overrides={{}} failed={{}} onPatch={() => {}} />);
    const items = screen.getAllByTestId('pn-card-item');
    expect(items.length).toBe(card.items.length);
    for (const li of items) {
      const badge = li.querySelector<HTMLElement>('[data-testid="pn-item-badge"]')!.dataset.badge;
      const letter = li.querySelector<HTMLElement>('[data-testid="pn-item-letter"]')!;
      expect(letter.dataset.badge).toBe(badge);
    }
  });
});
