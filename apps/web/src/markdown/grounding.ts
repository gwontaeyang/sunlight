// Grounding display rules (PLAN 5.3–5.4, PLAN_M2 3.4). Owner D. The decisions themselves are S's
// contracts/grounding.ts (groundsClaim / evidenceOf / pairCitations / itemBadge / cardBadgeCounts) — never re-implemented here.
// Evidence is decided only from the parser's block membership (ParsedBlock.citationOrdinals, found by the block
// index the parser put on the badge) and the matched citation statuses — never by re-reading or counting link
// text in displayMd (a forged `[x](#sp-cite-1)` or `[P](#sp-label-p)` is neither a chip nor evidence).
import type { Citation, MessageStats, ParsedBlock } from '@study-paper/shared/contracts/domain';
import { evidenceOf, type EvidenceKind } from '@study-paper/shared/contracts/grounding';

export type SpPhase = 'streaming' | 'final' | 'failed';

/**
 * Evidence of a [[P]] badge (PLAN_M2 3.4 rule 2, D18), decided by S's evidenceOf over the citations of the badge's OWN
 * parser block (by index, never by counting badges) that are ALSO rendered as chips in the same Markdown block as
 * the badge (`colocated`, from remarkSpIndex): 'quote' = a verbatim quote ("논문 근거"), 'equation_ref' = only a
 * resolved | no_anchor equation reference ("식 참조 · 내용 대조 안 함", never "논문 근거"), 'none' otherwise.
 * Not a P block, or anything missing → 'none' (fail closed).
 */
export function blockEvidence(block: ParsedBlock | undefined, citations: ReadonlyMap<number, Citation>, colocated: readonly number[]): EvidenceKind {
  if (!block || block.label !== 'P') return 'none';
  const shown: Citation[] = [];
  for (const o of block.citationOrdinals) {
    const c = citations.get(o);
    if (c !== undefined && colocated.includes(o)) shown.push(c);
  }
  return evidenceOf(shown);
}

/** Whether a [[P]] badge shows "논문 근거" (a colocated verbatim quote — blockEvidence 'quote'). */
export function blockGrounded(block: ParsedBlock | undefined, citations: ReadonlyMap<number, Citation>, colocated: readonly number[]): boolean {
  return blockEvidence(block, citations, colocated) === 'quote';
}

/**
 * "P n · 근거 미확인 n · 찾지 못함 n" (thread list summary; "식 참조만 n" only when > 0). The stored statsJson of the
 * last answer as it was saved — the list does not parse the bodies (BRIEF_COMMON rule 10's one exception), so it never
 * says "논문 근거".
 */
export function statsSummary(s: MessageStats | null | undefined): string | null {
  if (!s) return null;
  const eqOnly = s.blocks.pEquationOnly ?? 0;
  const parts = [`P ${s.blocks.p}`, ...(eqOnly > 0 ? [`식 참조만 ${eqOnly}`] : []), `근거 미확인 ${s.blocks.pUnverified}`, `찾지 못함 ${s.quotes.notFound + s.eqRefs.notFound}`];
  return parts.join(' · ');
}

/** Longer per-message line (all groups of messages.statsJson). */
export function statsDetail(s: MessageStats): string {
  const b = s.blocks;
  const q = s.quotes;
  const e = s.eqRefs;
  const eqOnly = b.pEquationOnly ?? 0;
  const out = [`라벨: 논문 근거 ${b.p}${eqOnly > 0 ? ` · 식 참조만 ${eqOnly}` : ''} · 근거 미확인 ${b.pUnverified} · 명시 없음 ${b.n} · 일반 지식 ${b.g} · 라벨 없음 ${b.unlabeled}`];
  out.push(`인용: 원문에서 찾음 ${q.verbatim} · 비슷한 문장 ${q.fuzzy} · 여러 곳 ${q.ambiguous} · 찾지 못함 ${q.notFound}${q.unchecked ? ` · 확인 못 함 ${q.unchecked}` : ''}`);
  const unindexed = e.unindexed ?? 0;
  if (e.resolved + e.noAnchor + e.ambiguous + e.notFound > 0) out.push(`식 참조: 찾음 ${e.resolved} · 위치 없음 ${e.noAnchor} · 여러 개 ${e.ambiguous} · 색인에 없음 ${e.notFound}`);
  if (unindexed > 0) out.push(`식 참조 ${unindexed}개: 이 논문은 수식 색인이 없어 확인하지 않음`);
  return out.join('\n');
}

/** http(s) URL or null (other schemes are never opened). */
export function safeExternalUrl(href: string | undefined): URL | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Parser-generated chip links (PLAN 5.2). */
export const SP_HREF = {
  cite: /^#sp-cite-(\d+)$/,
  eq: /^#sp-eq-(\d+)$/,
  label: /^#sp-label-([png])$/,
} as const;
