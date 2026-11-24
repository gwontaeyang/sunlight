import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { ReviewCardDto, ReviewQueueResponse, ReviewStatsResponse } from '@study-paper/shared/contracts/api';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import type { CaseContext, RouteCase } from '../helpers/routeCases';

async function createCard(ctx: CaseContext) {
  const result = await ctx.server.req('/api/review/cards', {
    method: 'POST', headers: { 'X-SP-Token': ctx.server.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paperId: SEED_PAPER_ID, type: 'definition', frontMd: 'What is a residual?', backMd: 'A difference between observations and predictions.' }),
  });
  ctx.vars.cardId = ReviewCardDto.parse(JSON.parse(result.text)).id;
}

export const cases: RouteCase[] = [
  { route: 'review.queue', name: 'new card is due with four grading choices', setup: createCard, expect: 'ok',
    check(r, ctx) {
      const queued = ReviewQueueResponse.parse(r.json).cards.find(x => x.card.id === ctx.vars.cardId);
      expect(queued?.preview.map(p => p.rating)).toEqual([1, 2, 3, 4]);
      expect(queued?.card.fsrs.state).toBe(0);
    } },
  { route: 'review.stats', name: 'new card appears in review statistics', setup: createCard, expect: 'ok',
    check(r) { expect(ReviewStatsResponse.parse(r.json).total).toBeGreaterThan(0); } },
  { route: 'review.grade', name: 'grade promotes a new card and writes its pre-grade state', setup: createCard, expect: 'ok',
    params: ctx => ({ id: ctx.vars.cardId! }), body: () => ({ rating: 3, expectedReps: 0, clientRequestId: randomUUID() }),
    check(r, ctx) {
      expect(ReviewCardDto.parse(r.json).fsrs.reps).toBe(1);
      expect(ctx.server.deps.sqlite.prepare('SELECT state,rating FROM review_logs WHERE cardId=?').all(ctx.vars.cardId)).toEqual([{ state: 0, rating: 3 }]);
    } },
  { route: 'review.grade', name: 'unknown card', expect: 'not_found',
    params: { id: 'missing-card' }, body: () => ({ rating: 3, expectedReps: 0, clientRequestId: randomUUID() }) },
  { route: 'review.grade', name: 'stale expected reps', setup: createCard, expect: 'conflict',
    params: ctx => ({ id: ctx.vars.cardId! }), body: () => ({ rating: 3, expectedReps: 7, clientRequestId: randomUUID() }) },
];
