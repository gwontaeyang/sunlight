import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { ReviewCardDto, SelectionQuestions } from '@study-paper/shared/contracts/api';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import type { CaseContext, RouteCase } from '../helpers/routeCases';
import { sseEvents } from './threads.cases';

const id = SEED_PAPER_ID;
const selection = 'fixed threshold of 0.5 m';
const anchor = { quote: { exact: selection }, page: 1, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }] };
const create = '/api/review/cards';

async function post(ctx: CaseContext, path: string, body: unknown) {
  return ctx.server.req(path, { method: 'POST', headers: { 'X-SP-Token': ctx.server.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function preview(ctx: CaseContext) {
  const events = sseEvents((await post(ctx, '/api/papers/' + id + '/review-cards/from-selection', { selection, page: 1, clientRequestId: randomUUID() })).text);
  const head = events[0], done = events.at(-1);
  if (head?.event !== 'run.accepted' || done?.event !== 'run.done') throw new Error('selection preview failed');
  const [first] = SelectionQuestions.parse(JSON.parse(done.data.text)).cards;
  ctx.vars.payload = JSON.stringify({ type: first!.type, backMd: first!.backMd, frontMd: first!.frontMd, paperId: id, runId: head.data.runId, questionIndex: 0, anchor });
}

export const cases: RouteCase[] = [
  { route: 'reviewCards.fromSelection', name: 'two preview questions with exact evidence; preview alone saves no cards', expect: 'ok', params: { id },
    body: () => ({ selection, page: 1, clientRequestId: randomUUID() }),
    check(r, ctx) {
      const head = r.events[0], done = r.events.at(-1);
      if (head?.event !== 'run.accepted' || done?.event !== 'run.done') throw new Error('selection preview failed');
      expect(SelectionQuestions.parse(JSON.parse(done.data.text)).cards.map((q) => q.evidence)).toEqual([selection, selection]);
      expect(ctx.server.deps.sqlite.prepare('SELECT count(*) AS n FROM review_cards WHERE llmCallId=?').get(head.data.runId)).toEqual({ n: 0 });
    } },
  { route: 'reviewCards.fromSelection', name: 'selection from a different page', expect: 'validation', params: { id }, body: () => ({ selection, page: 2, clientRequestId: randomUUID() }) },
  { route: 'reviewCards.fromSelection', name: 'ambiguous selection without location context', expect: 'validation', params: { id }, body: () => ({ selection: 'robust kernel', page: 2, clientRequestId: randomUUID() }) },
  { route: 'review.cards.create', name: 'repeat confirmation reuses the same anchored SRS card', expect: 'ok', setup: preview, body: (ctx: CaseContext) => JSON.parse(ctx.vars.payload!),
    async check(r, ctx) {
      const dto = ReviewCardDto.parse(r.json);
      expect(dto).toMatchObject({ origin: 'llm', fsrs: { reps: 0, state: 0 } });
      expect(ctx.server.deps.sqlite.prepare('SELECT paperId,page,quoteExact,startOffset FROM highlights WHERE id=?').get(dto.highlightId)).toMatchObject({ paperId: id, page: 1, quoteExact: selection, startOffset: expect.any(Number) });
      const again = await post(ctx, create, JSON.parse(ctx.vars.payload!));
      expect(again.status).toBe(200);
      expect(ReviewCardDto.parse(JSON.parse(again.text))).toEqual(dto);
    } },
  { route: 'review.cards.create', name: 'reject altered preview text', expect: 'validation', setup: preview, body: (ctx: CaseContext) => ({ ...JSON.parse(ctx.vars.payload!), backMd: 'outside the selection' }) },
  { route: 'review.cards.create', name: 'reject an anchor on a different page', expect: 'validation', setup: preview, body: (ctx: CaseContext) => ({ ...JSON.parse(ctx.vars.payload!), anchor: { ...anchor, page: 2 } }) },
  { route: 'review.cards.create', name: 'foreign or deleted highlight', expect: 'not_found', body: { paperId: id, type: 'why', frontMd: 'Q', backMd: 'A', highlightId: 'missing' } },
];
