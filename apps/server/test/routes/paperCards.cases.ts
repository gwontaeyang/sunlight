// Owner B. Contract cases of the paper cards route module (see ../helpers/routeCases.ts).
import { expect } from 'vitest';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import type { CaseContext, RouteCase } from '../helpers/routeCases';
import { sseEvents } from './threads.cases';

const MISSING = '00000000-0000-4000-8000-00000000dead';
const uuid = () => crypto.randomUUID();

/** Generates a card of `kind` on the seed paper; stores cardId / runId / itemId in ctx.vars. */
async function generateOnSeed(ctx: CaseContext, kind: 'notation' | 'assumptions' | 'summary'): Promise<void> {
  const s = ctx.server;
  const r = await s.req(`/api/papers/${SEED_PAPER_ID}/cards/${kind}/generate`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientRequestId: uuid() }) });
  const ev = sseEvents(r.text);
  const a = ev[0];
  if (a?.event !== 'run.accepted' || ev.at(-1)?.event !== 'run.done') throw new Error(`setup card failed: ${r.text.slice(0, 300)}`);
  ctx.vars.cardId = a.data.artifactId!;
  ctx.vars.runId = a.data.runId;
  ctx.vars.itemId = (s.deps.sqlite.prepare(`SELECT id FROM paper_card_items WHERE cardId = ? ORDER BY ordinal`).get(ctx.vars.cardId) as { id: string }).id;
}

export const cases: RouteCase[] = [
  {
    route: 'cards.generate',
    name: 'notation card: run.accepted.artifactId = the card, 11 items stored',
    expect: 'ok',
    params: { id: SEED_PAPER_ID, kind: 'notation' },
    body: () => ({ clientRequestId: uuid() }),
    check: (r, ctx) => {
      const a = r.events[0]!;
      if (a.event !== 'run.accepted') throw new Error('first event');
      expect(a.data.artifactId).toBeTruthy();
      expect(r.events.at(-1)!.event).toBe('run.done');
      const done = r.events.at(-1)!;
      if (done.event === 'run.done') expect([done.data.citations, done.data.stats]).toEqual([[], null]);
      expect(ctx.server.deps.sqlite.prepare(`SELECT status, llmCallId FROM paper_cards WHERE id = ?`).get(a.data.artifactId)).toEqual({ status: 'complete', llmCallId: a.data.runId });
      expect(ctx.server.deps.sqlite.prepare(`SELECT count(*) AS n FROM paper_card_items WHERE cardId = ?`).get(a.data.artifactId)).toEqual({ n: 11 });
    },
  },
  {
    route: 'cards.generate',
    name: 'summary card: one item (key summary, no label)',
    expect: 'ok',
    params: { id: SEED_PAPER_ID, kind: 'summary' },
    body: () => ({ clientRequestId: uuid() }),
    check: (r, ctx) => {
      const a = r.events[0]!;
      if (a.event !== 'run.accepted') throw new Error('first event');
      expect(ctx.server.deps.sqlite.prepare(`SELECT key, label, title FROM paper_card_items WHERE cardId = ?`).all(a.data.artifactId)).toEqual([{ key: 'summary', label: null, title: null }]);
    },
  },
  { route: 'cards.generate', name: 'unknown paper', expect: 'not_found', params: { id: MISSING, kind: 'notation' }, body: () => ({ clientRequestId: uuid() }) },
  { route: 'cards.generate', name: 'unknown kind', expect: 'validation', params: { id: SEED_PAPER_ID, kind: 'poster' }, body: () => ({ clientRequestId: uuid() }) },
  { route: 'cards.generate', name: 'missing clientRequestId', expect: 'validation', params: { id: SEED_PAPER_ID, kind: 'notation' }, body: {} },
  {
    route: 'cards.generate',
    name: 'same clientRequestId for another kind',
    expect: 'conflict',
    setup: async (ctx) => {
      await generateOnSeed(ctx, 'assumptions');
      ctx.vars.crid = (ctx.server.deps.sqlite.prepare(`SELECT clientRequestId FROM llm_calls WHERE runId = ?`).get(ctx.vars.runId) as { clientRequestId: string }).clientRequestId;
    },
    params: { id: SEED_PAPER_ID, kind: 'summary' },
    body: (ctx: CaseContext) => ({ clientRequestId: ctx.vars.crid }),
  },
  {
    route: 'cards.list',
    name: 'the latest complete card per kind with items and citations',
    expect: 'ok',
    setup: (ctx) => generateOnSeed(ctx, 'notation'),
    params: { id: SEED_PAPER_ID },
    check: (r, ctx) => {
      const cards = (r.json as { cards: { id: string; kind: string; status: string; runId: string | null; items: { key: string | null; citations: unknown[] }[] }[] }).cards;
      const card = cards.find((c) => c.id === ctx.vars.cardId)!;
      expect(card).toMatchObject({ kind: 'notation', status: 'complete', runId: ctx.vars.runId });
      expect(card.items.find((i) => i.key === 'state_vector')?.citations).toHaveLength(1);
      expect(cards.filter((c) => c.kind === 'notation' && c.status === 'complete')).toHaveLength(1);
    },
  },
  { route: 'cards.list', name: 'unknown paper', expect: 'not_found', params: { id: MISSING } },
  {
    route: 'cardItems.patch',
    name: 'confirm an item and set a note',
    expect: 'ok',
    setup: (ctx) => generateOnSeed(ctx, 'notation'),
    params: (ctx) => ({ id: ctx.vars.itemId! }),
    body: { confirmed: true, userNote: '내 메모' },
    check: (r) => expect(r.json).toMatchObject({ confirmed: true, userNote: '내 메모' }),
  },
  { route: 'cardItems.patch', name: 'unknown item', expect: 'not_found', params: { id: MISSING }, body: { confirmed: true } },
  { route: 'cardItems.patch', name: 'a note longer than 8000 chars', expect: 'validation', params: { id: MISSING }, body: { userNote: 'x'.repeat(8001) } },
];
