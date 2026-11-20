// Grounding decisions and citation pairing (PLAN_M2 3.4 rules 2 and 5, D18, D26). Owner: supervisor — the ONE
// implementation: server stats (llm/citations.ts), web chips/badges (markdown/grounding.ts) and card badges all call
// these functions; nobody re-implements the decision. Pure functions; imports contracts/domain types only.
//
// - Only a verbatim quote grounds a claim ("논문 근거"). An equation reference (resolved | no_anchor) only says that an
//   equation with that number is in the index — it is a separate state ("식 참조 · 내용 대조 안 함"), never "논문 근거".
// - Pairing is fail-closed: one pairCitations result per content (a message, a card item, a glossary definition) drives
//   the body chips, the item badge and the card header counts together. A mismatch (null) makes all of them
//   "확인 안 됨" — itemBadge never looks at the stored citations directly.
import type { Citation, GroundingLabel, RawCitation } from './domain';

export type EvidenceKind = 'quote' | 'equation_ref' | 'none';
export type ItemBadge = 'grounded_quote' | 'equation_ref' | 'unverified' | 'not_stated' | 'general' | 'unconfirmed' | 'none';
export const ITEM_BADGES: readonly ItemBadge[] = ['grounded_quote', 'equation_ref', 'unverified', 'not_stated', 'general', 'unconfirmed', 'none'];

/** Badge text (PLAN_M2 3.4 rule 2). "논문 근거" appears in grounded_quote only. 'none' = no item badge (summary item). */
export const ITEM_BADGE_KO: Record<ItemBadge, string | null> = {
  grounded_quote: '논문 근거 · 인용 원문에서 찾음',
  equation_ref: '식 참조 · 내용 대조 안 함',
  unverified: '근거 미확인',
  not_stated: '논문에 명시 없음',
  general: '일반 지식',
  unconfirmed: '확인 안 됨',
  none: null,
};

/** Result of pairCitations: ordinal → stored citation, or null when the parse and the stored rows do not pair. */
export type Paired = ReadonlyMap<number, Citation> | null;

/** True only for a verbatim quote (D18: an equation reference never grounds a claim). */
export function groundsClaim(c: Pick<Citation, 'kind' | 'status'>): boolean {
  return c.kind === 'quote' && c.status === 'verbatim';
}

/** quote: ≥ 1 verbatim quote / equation_ref: none of those but ≥ 1 resolved|no_anchor equation reference / none. */
export function evidenceOf(citations: Iterable<Pick<Citation, 'kind' | 'status'>>): EvidenceKind {
  let eq = false;
  for (const c of citations) {
    if (groundsClaim(c)) return 'quote';
    if (c.kind === 'equation' && (c.status === 'resolved' || c.status === 'no_anchor')) eq = true;
  }
  return eq ? 'equation_ref' : 'none';
}

/**
 * Pairs the parser's citations with the stored ones: same count and, for every ordinal, the same kind and the same
 * quote (quote) / eqNumber (equation). Any difference — or a duplicate ordinal on either side — → null.
 */
export function pairCitations(parsed: readonly RawCitation[], stored: readonly Citation[]): Paired {
  if (parsed.length !== stored.length) return null;
  const byOrdinal = new Map<number, Citation>();
  for (const s of stored) {
    if (byOrdinal.has(s.ordinal)) return null;
    byOrdinal.set(s.ordinal, s);
  }
  const seen = new Set<number>();
  for (const p of parsed) {
    if (seen.has(p.ordinal)) return null;
    seen.add(p.ordinal);
    const s = byOrdinal.get(p.ordinal);
    if (!s || s.kind !== p.kind) return null;
    if (p.kind === 'quote' ? (p.quote ?? '') !== (s.quote ?? '') : (p.eqNumber ?? '') !== (s.eqNumber ?? '')) return null;
  }
  return byOrdinal;
}

/**
 * Item badge from the item's label and the pairing of its content (never from stored citations directly):
 * label null → none / paired null → unconfirmed / P → grounded_quote | equation_ref | unverified / N → not_stated /
 * G → general.
 */
export function itemBadge(label: GroundingLabel | null, paired: Paired): ItemBadge {
  if (label === null) return 'none';
  if (paired === null) return 'unconfirmed';
  if (label === 'N') return 'not_stated';
  if (label === 'G') return 'general';
  const e = evidenceOf(paired.values());
  return e === 'quote' ? 'grounded_quote' : e === 'equation_ref' ? 'equation_ref' : 'unverified';
}

/** Card header counts, computed from the item badges only ('none' — summary items — is not counted). */
export function cardBadgeCounts(badges: readonly ItemBadge[]): Record<Exclude<ItemBadge, 'none'>, number> {
  const out: Record<Exclude<ItemBadge, 'none'>, number> = { grounded_quote: 0, equation_ref: 0, unverified: 0, not_stated: 0, general: 0, unconfirmed: 0 };
  for (const b of badges) if (b !== 'none') out[b]++;
  return out;
}
