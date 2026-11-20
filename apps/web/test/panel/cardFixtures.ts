// Card DTOs for panel tests, built from the shared mock outputs (notation_card.md / assumptions_card.md) the way the
// server stores them: one item per <item>, citations = the parser's citations matched as verbatim quotes and
// resolved equation references (the server's matcher decides that for real; here it is fixed). Owner D.
import type { CardItemDto, PaperCardDto } from '@study-paper/shared/contracts/api';
import { ASSUMPTION_CATEGORY_KO, NOTATION_TITLES_KO, type AssumptionCategory, type Citation, type GroundingLabel, type NotationKey } from '@study-paper/shared/contracts/domain';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import assumptionsMd from '../../../../packages/shared/fixtures/mock-outputs/assumptions_card.md?raw';
import notationMd from '../../../../packages/shared/fixtures/mock-outputs/notation_card.md?raw';

const ITEM_RE = /^<item ([^>]*)>([\s\S]*?)<\/item>$/gm;
const ATTR_RE = /(\w+)="([^"]*)"/g;

/** Stored citations of a body: the parser's citations as the server would match them (quotes verbatim, equations resolved). */
export function matchedCitations(bodyMd: string, labels: 'badge' | 'strip' = 'strip'): Citation[] {
  return parseAnswer(bodyMd, { labels }).citations.map((c) =>
    c.kind === 'quote'
      ? { ordinal: c.ordinal, kind: 'quote', quote: c.quote!, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: c.quote!.length } }
      : { ordinal: c.ordinal, kind: 'equation', eqNumber: c.eqNumber!, status: 'resolved', score: 1, equationId: `eq-${c.eqNumber}`, latex: `x_{${c.eqNumber}}`, katexOk: true },
  );
}

export function itemsOf(raw: string, kind: 'notation' | 'assumptions', idPrefix = 'it'): CardItemDto[] {
  return [...raw.matchAll(ITEM_RE)].map((m, i) => {
    const attrs = Object.fromEntries([...m[1]!.matchAll(ATTR_RE)].map((a) => [a[1]!, a[2]!]));
    const body = m[2]!;
    const category = kind === 'assumptions' ? (attrs.category ?? null) : null;
    return {
      id: `${idPrefix}-${i + 1}`,
      ordinal: i + 1,
      key: kind === 'notation' ? (attrs.key ?? null) : null,
      category,
      label: (attrs.label ?? null) as GroundingLabel | null,
      title: kind === 'notation' ? NOTATION_TITLES_KO[attrs.key as NotationKey] : ASSUMPTION_CATEGORY_KO[category as AssumptionCategory],
      bodyMd: body,
      attrs: Object.fromEntries(Object.entries(attrs).filter(([k]) => k === 'stated')),
      confirmed: false,
      userNote: null,
      citations: matchedCitations(body),
    };
  });
}

export function card(kind: PaperCardDto['kind'], o: Partial<PaperCardDto> = {}): PaperCardDto {
  const items = kind === 'notation' ? itemsOf(notationMd, 'notation') : kind === 'assumptions' ? itemsOf(assumptionsMd, 'assumptions', 'as') : [];
  return { id: `card-${kind}`, kind, status: 'complete', rawOutput: null, errorCode: null, runId: `run-${kind}`, items, createdAt: 10, ...o };
}

export { assumptionsMd, notationMd };
