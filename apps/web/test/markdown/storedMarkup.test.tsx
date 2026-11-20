// One pairing per content (PLAN_M2 3.4 rule 5, Codex B4): pairStored → { parsed, paired } drives the body chips, the
// item badge and (cardsTab) the card header counts. Mismatch kinds: count, kind, quote, eqNumber. Owner D.
import { cleanup, render, screen } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Citation, MessageStats } from '@study-paper/shared/contracts/domain';
import type { PaperCardDto } from '@study-paper/shared/contracts/api';
import { badgeOf, ItemBadgeView, pairStored, StoredMarkup, useStoredPair } from '../../src/markdown/renderStored';
import { CardsTab } from '../../src/panel/CardsTab';
import { PAPER, renderWithApi, resetReader } from '../panel/panelHarness';

const pairCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('@study-paper/shared/contracts/grounding', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@study-paper/shared/contracts/grounding')>();
  return {
    ...orig,
    pairCitations: (parsed: Parameters<typeof orig.pairCitations>[0], stored: Parameters<typeof orig.pairCitations>[1]) => {
      pairCalls.n++;
      return orig.pairCitations(parsed, stored);
    },
  };
});

afterEach(cleanup);
beforeEach(() => {
  pairCalls.n = 0;
});

const Q = 'We estimate the robot pose';
const verbatim = (ordinal: number, quote = Q): Citation => ({ ordinal, kind: 'quote', quote, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: quote.length } });
const eqRes = (ordinal: number, n: string): Citation => ({ ordinal, kind: 'equation', eqNumber: n, status: 'resolved', score: 1, equationId: `e${n}`, latex: 'x', katexOk: true });
const STATS: MessageStats = { blocks: { p: 1, pEquationOnly: 0, pUnverified: 0, n: 0, g: 0, unlabeled: 0 }, quotes: { verbatim: 1, fuzzy: 0, ambiguous: 0, notFound: 0 }, eqRefs: { resolved: 1, noAnchor: 0, ambiguous: 0, notFound: 0, unindexed: 0 } };

const RAW = `요지 <q>${Q}</q> <eq n="1"/> [[P]]`;
const chips = () => screen.queryAllByTestId('sp-chip');
const badges = () => screen.queryAllByTestId('sp-badge');

export const MISMATCHES: [string, Citation[]][] = [
  ['count', [verbatim(1)]],
  ['kind', [verbatim(1), verbatim(2, '1')]],
  ['quote', [verbatim(1, 'We estimate the robot position'), eqRes(2, '1')]],
  ['eqNumber', [verbatim(1), eqRes(2, '2')]],
];

describe('pairStored', () => {
  it('paired: final chips and the grounded badge; stats line shown', () => {
    render(<StoredMarkup {...pairStored(RAW, [verbatim(1), eqRes(2, '1')])} stats={STATS} />);
    expect(chips().map((c) => c.dataset.status)).toEqual(['verbatim', 'resolved']);
    expect(badges().map((b) => b.dataset.status)).toEqual(['p-grounded']);
    expect(screen.getByTestId('sp-stats')).toBeTruthy();
    expect(screen.queryByTestId('pn-unpaired-note')).toBeNull();
  });

  it.each(MISMATCHES)('mismatch (%s): body chips "확인 안 됨", no block badge, no stats line; item badge "확인 안 됨"', (_kind, stored) => {
    const pair = pairStored(RAW, stored);
    expect(pair.paired).toBeNull();
    render(
      <>
        <StoredMarkup {...pair} stats={STATS} />
        <ItemBadgeView badge={badgeOf('P', pair)} />
      </>,
    );
    // ① body
    expect(chips().length).toBe(2);
    expect(chips().every((c) => c.dataset.status === 'unchecked' && c.textContent!.includes('확인 안 됨'))).toBe(true);
    expect(badges()).toHaveLength(0);
    expect(screen.getByTestId('pn-unpaired-note').textContent).toBe('저장된 인용과 현재 표시 규칙이 달라 확인 표시를 생략함');
    expect(screen.queryByTestId('sp-stats')).toBeNull(); // even though statsJson.blocks.p = 1
    // ② item badge: unconfirmed, never "논문 근거" (the stored citation is verbatim)
    const b = screen.getByTestId('pn-item-badge');
    expect(b.dataset.badge).toBe('unconfirmed');
    expect(b.textContent).toBe('확인 안 됨');
    expect(screen.queryByText(/논문 근거/)).toBeNull();
  });

  it('pairCitations runs once per content, however often the content re-renders', () => {
    function Item({ raw, cites }: { raw: string; cites: Citation[] }) {
      const pair = useStoredPair(raw, cites, { labels: 'strip' });
      const badge = useMemo(() => badgeOf('P', pair), [pair]);
      return (
        <div>
          <ItemBadgeView badge={badge} />
          <StoredMarkup {...pair} />
        </div>
      );
    }
    const cites = [verbatim(1), eqRes(2, '1')];
    const { rerender } = render(<Item raw={RAW} cites={cites} />);
    rerender(<Item raw={RAW} cites={cites} />);
    rerender(<Item raw={RAW} cites={cites} />);
    expect(pairCalls.n).toBe(1);
    expect(screen.getByTestId('pn-item-badge').dataset.badge).toBe('grounded_quote');
  });

  it('plain mode: <q>, <eq>, [[P]], <glossary> and #sp- links are text; no chip, no badge', () => {
    const raw = `번역 <q>${Q}</q> <eq n="1"/> [[P]] [❝1](#sp-cite-1) [P](#sp-label-p)\n\n<glossary><term name="x">y</term></glossary>`;
    const pair = pairStored(raw, [], { mode: 'plain' });
    expect(pair.parsed.citations).toEqual([]);
    expect(pair.parsed.blocks).toEqual([]);
    expect(pair.parsed.glossary).toEqual([]);
    const { container } = render(<StoredMarkup {...pair} />);
    expect(chips()).toHaveLength(0);
    expect(badges()).toHaveLength(0);
    expect(container.textContent).toContain(`<q>${Q}</q>`);
    expect(container.textContent).toContain('<eq n="1"/>');
    expect(container.textContent).toContain('[[P]]');
    expect(container.textContent).toContain('[❝1](#sp-cite-1)');
    expect(container.textContent).toContain('<glossary><term name="x">y</term></glossary>');
    expect(container.querySelector('a')).toBeNull();
  });

  it('plain mode keeps code and math as they are', () => {
    const { container } = render(<StoredMarkup {...pairStored('코드 `<q>x</q>` 와 $a<b$\n\n```\n<eq n="1"/>\n```', [], { mode: 'plain' })} />);
    expect(container.querySelector('code')!.textContent).toBe('<q>x</q>');
    expect(container.querySelector('pre')!.textContent).toContain('<eq n="1"/>');
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('strip mode: the body label disappears, citation chips stay', () => {
    const { container } = render(<StoredMarkup {...pairStored(RAW, [verbatim(1), eqRes(2, '1')], { labels: 'strip' })} />);
    expect(badges()).toHaveLength(0);
    expect(chips().map((c) => c.dataset.status)).toEqual(['verbatim', 'resolved']);
    expect(container.textContent).not.toContain('[[P]]');
    expect(container.textContent).not.toMatch(/(^|\s)P(\s|$)/);
  });

  it.each(MISMATCHES)('mismatch (%s) on a card item: ③ the header counts it as "확인 안 됨" 1, never "논문 근거" / "식 참조만"', async (_kind, stored) => {
    resetReader(true);
    const item = { id: 'i1', ordinal: 1, key: 'error_definition', category: null, label: 'P' as const, title: '오차 정의', bodyMd: RAW, attrs: {}, confirmed: false, userNote: null, citations: stored };
    const notation: PaperCardDto = { id: 'c1', kind: 'notation', status: 'complete', rawOutput: null, errorCode: null, runId: 'r1', items: [item], createdAt: 1 };
    renderWithApi(<CardsTab paperId={PAPER} />, (c) => (c.method === 'GET' && c.url === `/api/papers/${PAPER}/cards` ? { status: 200, json: { cards: [notation] } } : undefined));
    const counts = await screen.findByTestId('pn-card-counts');
    const shown = Object.fromEntries([...counts.querySelectorAll('[data-count]')].map((e) => [(e as HTMLElement).dataset.count, e.textContent]));
    expect(shown).toEqual({ unconfirmed: '확인 안 됨 1', confirmed: '확인함 0 / 1' });
    // ① body and ② item badge of the same item agree
    expect(screen.getByTestId('pn-item-badge').dataset.badge).toBe('unconfirmed');
    expect(chips().every((c) => c.dataset.status === 'unchecked')).toBe(true);
    expect(badges()).toHaveLength(0);
    expect(screen.queryByText(/논문 근거/)).toBeNull();
    expect(pairCalls.n).toBe(1); // body, item badge and header counts from one pairing
  });
});
