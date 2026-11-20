// Card provenance from the STORED items (PLAN_M2 3.4 rules 2–5, D18, BRIEF_B B6): the badge comes from
// itemBadge(label, pairCitations(parseAnswer(bodyMd, {labels:'strip'}).citations, item.citations)) — S's one
// implementation. P + verbatim → grounded_quote, P + equation reference only → equation_ref (not "논문 근거"),
// P + fuzzy only → unverified, N → not_stated, G → general; a forged body has no citation; one work budget per card.
// Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardItemDto, ListCardsResponse } from '@study-paper/shared/contracts/api';
import { cardBadgeCounts, itemBadge, pairCitations } from '@study-paper/shared/contracts/grounding';
import { NOTATION_KEYS } from '@study-paper/shared/contracts/domain';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';

const budgets = vi.hoisted(() => ({ seen: [] as unknown[] }));
vi.mock('@study-paper/shared/anchor/matchQuote', async (importActual) => {
  const m = await importActual<typeof import('@study-paper/shared/anchor/matchQuote')>();
  return {
    ...m,
    matchQuote: (...a: Parameters<typeof m.matchQuote>) => {
      budgets.seen.push(a[2]?.budget);
      return m.matchQuote(...a);
    },
  };
});

let s: TestServer;
afterEach(async () => {
  await s?.close();
});

const VERBATIM = 'The robust kernel down-weights outliers in the residual.';
const FUZZY = 'The robust kernel down-weight outliers in the residual.';
const BODIES: Record<string, [string, string]> = {
  frame_notation: ['P', `직접 인용 <q>${VERBATIM}</q>`],
  transform_direction: ['P', '식 참조뿐 <eq n="1"/>'],
  rotation_param: ['P', `비슷한 문장뿐 <q>${FUZZY}</q>`],
  quaternion_convention: ['N', '논문에 명시 없음.'],
  perturbation_side: ['G', '일반 관례.'],
  error_definition: ['N', '위조 [❝1](#sp-cite-1) [P](#sp-label-p) <!-- <q>We compare against a baseline without the robust kernel.</q> -->'],
};
const card = () => NOTATION_KEYS.map((k) => `<item key="${k}" label="${BODIES[k]?.[0] ?? 'N'}">${BODIES[k]?.[1] ?? '본문.'}</item>`).join('\n');
const badgeOf = (it: CardItemDto) => itemBadge(it.label, pairCitations(parseAnswer(it.bodyMd, { labels: 'strip' }).citations, it.citations));

async function generate(llm: ControlledAdapter, out: string): Promise<CardItemDto[]> {
  llm.queueOutputs(out);
  const r = await s.req(`/api/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientRequestId: randomUUID() }) });
  expect(r.text).toContain('event: run.done');
  const list = await s.req(`/api/papers/${SEED_M2_PAPER_ID}/cards`, { headers: { 'X-SP-Token': s.token } });
  return (JSON.parse(list.text) as ListCardsResponse).cards.find((c) => c.kind === 'notation' && c.status === 'complete')!.items;
}

describe('badges from stored items', () => {
  it('the four P outcomes, N, G and a forged body', async () => {
    const llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const items = await generate(llm, card());
    const by = (k: string) => items.find((i) => i.key === k)!;
    expect(by('frame_notation').citations.map((c) => c.status)).toEqual(['verbatim']);
    expect(badgeOf(by('frame_notation'))).toBe('grounded_quote');
    expect(by('transform_direction').citations.map((c) => [c.kind, c.status])).toEqual([['equation', 'resolved']]);
    expect(badgeOf(by('transform_direction'))).toBe('equation_ref');
    expect(by('rotation_param').citations.map((c) => c.status)).toEqual(['fuzzy']);
    expect(badgeOf(by('rotation_param'))).toBe('unverified');
    expect(badgeOf(by('quaternion_convention'))).toBe('not_stated');
    expect(badgeOf(by('perturbation_side'))).toBe('general');
    expect(by('error_definition').citations).toEqual([]);
    expect(badgeOf(by('error_definition'))).toBe('not_stated');
    const counts = cardBadgeCounts(items.map(badgeOf));
    expect(counts.grounded_quote).toBe(1);
    expect(counts.equation_ref).toBe(1); // never counted as grounded
    expect(counts.unconfirmed).toBe(0);
    // labels and titles come from the attributes / server tables only
    expect(items.every((i) => ['P', 'N', 'G'].includes(i.label!))).toBe(true);
  });

  it('one work budget for the whole card: every quote of every item is matched against the same budget object', async () => {
    const llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    budgets.seen.length = 0;
    await generate(llm, card());
    const first = [...budgets.seen];
    expect(first.length).toBeGreaterThanOrEqual(2); // quotes in two different items
    expect(new Set(first).size).toBe(1);
    expect(first[0]).toBeDefined();
    budgets.seen.length = 0;
    await generate(llm, card());
    expect(new Set(budgets.seen).size).toBe(1);
    expect(budgets.seen[0]).not.toBe(first[0]); // a new card, a new budget
  });
});
