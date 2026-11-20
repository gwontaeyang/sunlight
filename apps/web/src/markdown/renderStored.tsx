// Stored SP-Markup content (a message, a card item body, a glossary definition, a note) → display (PLAN_M2 3.4 rule 5,
// Codex B4). Owner D.
// ONE pairing per content: pairStored() runs the parser once and S's pairCitations once, and the SAME `paired` result
// drives the body chips (StoredMarkup), the item badge (itemBadge(label, paired)) and the card header counts
// (cardBadgeCounts over those item badges). Nothing here — or in a badge — reads the stored citations directly.
// paired === null (count / kind / quote / eqNumber differ) → the body is drawn like phase 'failed' with no block badge,
// no stats line and a note; the item badge is "확인 안 됨" (unconfirmed).
import { useMemo } from 'react';
import type { Citation, GroundingLabel, MessageStats, ParsedAnswer } from '@study-paper/shared/contracts/domain';
import { ITEM_BADGE_KO, itemBadge, pairCitations, type ItemBadge, type Paired } from '@study-paper/shared/contracts/grounding';
import type { CitationClickHandler } from './chips';
import type { SpPhase } from './grounding';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { SpMarkdown } from './SpMarkdown';

export interface StoredOptions {
  /** 'plain' for translations, notes and memos (no chips, no badges). Default 'markup'. */
  mode?: 'markup' | 'plain';
  /** 'strip' for notation / assumption item bodies (the item label is the attribute). Default 'badge'. */
  labels?: 'badge' | 'strip';
  /** false while the text is still streaming. Default true. */
  final?: boolean;
}

export interface StoredPair {
  parsed: ParsedAnswer;
  paired: Paired;
}

/** parseAnswer + pairCitations, once (PLAN_M2 3.4 rule 5). */
export function pairStored(raw: string, citations: readonly Citation[], opts: StoredOptions = {}): StoredPair {
  const parsed = parseAnswer(raw, { final: opts.final ?? true, mode: opts.mode ?? 'markup', labels: opts.labels ?? 'badge' });
  return { parsed, paired: pairCitations(parsed.citations, citations) };
}

/** Memoised pairStored for one content. */
export function useStoredPair(raw: string, citations: readonly Citation[], opts: StoredOptions = {}): StoredPair {
  const { mode, labels, final } = opts;
  return useMemo(() => pairStored(raw, citations, { mode, labels, final }), [raw, citations, mode, labels, final]);
}

export interface StoredMarkupProps extends StoredPair {
  /** 'final' for complete content; a failed / interrupted message is 'failed' (no pairing verdict is shown). */
  phase?: SpPhase;
  /** The message's stored statsJson — drawn only when the pairing holds. */
  stats?: MessageStats | null;
  onCitationClick?: CitationClickHandler;
}

/** The body of stored content, from ONE pairStored result. */
export function StoredMarkup({ parsed, paired, phase = 'final', stats = null, onCitationClick }: StoredMarkupProps) {
  const citations = useMemo(() => (paired ? [...paired.values()] : []), [paired]);
  const unpaired = phase === 'final' && paired === null;
  return <SpMarkdown displayMd={parsed.displayMd} blocks={parsed.blocks} citations={citations} stats={unpaired ? null : stats} phase={phase} unpaired={unpaired} onCitationClick={onCitationClick} />;
}

const ITEM_BADGE_CLASS: Record<Exclude<ItemBadge, 'none'>, string> = {
  grounded_quote: 'border-emerald-600 bg-emerald-50 text-emerald-800',
  equation_ref: 'border-dashed border-violet-500 bg-violet-50 text-violet-800',
  unverified: 'border-orange-500 bg-orange-50 text-orange-800',
  not_stated: 'border-slate-300 bg-slate-50 text-slate-700',
  general: 'border-slate-300 bg-slate-50 text-slate-700',
  unconfirmed: 'border-gray-400 bg-gray-100 text-gray-600',
};

/**
 * Item badge of a card item: itemBadge(label, paired) → ITEM_BADGE_KO; 'none' (summary item) → no badge.
 * `quiet` (M3a cards, next to an ItemLetter): the three plain verdicts — grounded quote, not stated, general — are told
 * by the letter's shape and the legend, so their words stay for screen readers only; the others stay visible.
 */
export function ItemBadgeView({ badge, quiet = false }: { badge: ItemBadge; quiet?: boolean }) {
  const text = ITEM_BADGE_KO[badge];
  if (badge === 'none' || text === null) return null;
  if (quiet && LETTER_OF[badge].plain)
    return (
      <span data-testid="pn-item-badge" data-badge={badge} className="sr-only">
        {text}
      </span>
    );
  return (
    <span data-testid="pn-item-badge" data-badge={badge} className={`inline-flex items-center rounded border px-1.5 text-sl-label leading-5 whitespace-nowrap ${ITEM_BADGE_CLASS[badge]}`}>
      {text}
    </span>
  );
}

/**
 * The P / N / G mark of a card item (concept_CD D panel), drawn from the SAME item badge (never from the label alone):
 * P filled = a quote found in the paper, P outlined = the model said P but no verbatim quote (equation reference /
 * unverified), N dashed square, G circle, ? dotted = the pairing does not hold. Decorative: the badge carries the words.
 */
const LETTER_OF: Record<Exclude<ItemBadge, 'none'>, { letter: string; plain: boolean; cls: string }> = {
  grounded_quote: { letter: 'P', plain: true, cls: 'rounded-[5px] border-sl-line bg-sl-proof-bg text-sl-proof-ink' },
  equation_ref: { letter: 'P', plain: false, cls: 'rounded-[5px] border-sl-edge text-sl-muted' },
  unverified: { letter: 'P', plain: false, cls: 'rounded-[5px] border-sl-edge text-sl-muted' },
  not_stated: { letter: 'N', plain: true, cls: 'rounded-[5px] border-dashed border-sl-edge text-sl-muted' },
  general: { letter: 'G', plain: true, cls: 'rounded-full border-sl-edge text-sl-muted' },
  unconfirmed: { letter: '?', plain: false, cls: 'rounded-[5px] border-dotted border-sl-edge text-sl-muted' },
};

export function ItemLetter({ badge }: { badge: ItemBadge }) {
  if (badge === 'none') return null;
  const l = LETTER_OF[badge];
  return (
    <span aria-hidden="true" data-testid="pn-item-letter" data-badge={badge} title={ITEM_BADGE_KO[badge] ?? undefined} className={`mt-0.5 inline-flex size-[22px] shrink-0 items-center justify-center border text-sl-label font-semibold ${l.cls}`}>
      {l.letter}
    </span>
  );
}

/** The item badge from the item's label and the pairing of its body (never from the stored citations directly). */
export const badgeOf = (label: GroundingLabel | null, pair: StoredPair): ItemBadge => itemBadge(label, pair.paired);
