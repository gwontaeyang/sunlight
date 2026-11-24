import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, gte, isNull, lte, ne, sql } from 'drizzle-orm';
import { createEmptyCard, fsrs, FSRSVersion, State, type Card } from 'ts-fsrs';
import type { ReviewCardDto } from '@study-paper/shared/contracts/api';
import { FsrsState, type Citation } from '@study-paper/shared/contracts/domain';
import { papers, reviewCards, reviewLogs } from '../db/schema';
import { HttpError, notFound, routeBody, routeJson, routeParams, type AppDeps, type RouteModule } from '../deps';
import { readCitations } from '../llm/citationStore';

const schedule = fsrs({ enable_fuzz: false, request_retention: 0.9 });
const dailyNewLimit = 20;
const ratings = [1, 2, 3, 4] as const;
type Row = typeof reviewCards.$inferSelect;

function fromFsrs(c: Card): ReviewCardDto['fsrs'] {
  return {
    due: c.due.getTime(), stability: c.stability, difficulty: c.difficulty, elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days, learningSteps: c.learning_steps, reps: c.reps, lapses: c.lapses,
    state: c.state, lastReview: c.last_review?.getTime() ?? null,
  };
}

function toFsrs(r: Row): Card {
  return {
    due: new Date(r.due), stability: r.stability, difficulty: r.difficulty, elapsed_days: r.elapsedDays,
    scheduled_days: r.scheduledDays, learning_steps: r.learningSteps, reps: r.reps, lapses: r.lapses,
    state: FsrsState.parse(r.state), last_review: r.lastReview === null ? undefined : new Date(r.lastReview),
  };
}

export const initialSchedule = (now: number) => fromFsrs(createEmptyCard(now));

export function reviewCardDto(r: Row, citations: Citation[] = []): ReviewCardDto {
  return {
    id: r.id, paperId: r.paperId, type: r.type, frontMd: r.frontMd, backMd: r.backMd, highlightId: r.highlightId,
    sectionId: r.sectionId, origin: r.origin, suspended: r.suspended, fsrs: fromFsrs(toFsrs(r)),
    citations, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

/** Find the first millisecond of this local calendar day, including DST transition days. */
export function reviewDayStart(now: number, timezone: string): number {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' });
  const today = format.format(now);
  let lo = now - 48 * 60 * 60 * 1000;
  let hi = now;
  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (format.format(mid) === today) hi = mid;
    else lo = mid;
  }
  return hi;
}

function dayCounts(deps: AppDeps, now: number) {
  return deps.db.select({
    reviews: count(), introduced: sql<number>`coalesce(sum(case when ${reviewLogs.state} = 0 then 1 else 0 end), 0)`,
  }).from(reviewLogs)
    .where(and(gte(reviewLogs.reviewedAt, reviewDayStart(now, deps.config.timezone)), lte(reviewLogs.reviewedAt, now))).get()!;
}

const active = and(eq(reviewCards.suspended, false), isNull(papers.deletingAt));
const paperJoin = eq(papers.id, reviewCards.paperId);

export const schedulerRoutes: RouteModule = (deps) => ({
  'review.queue': (c) => {
    const now = Date.now();
    const newRemainingToday = Math.max(0, dailyNewLimit - dayCounts(deps, now).introduced);
    const dueCards = (isNew: boolean, limit: number) => deps.db.select({ card: reviewCards }).from(reviewCards)
      .innerJoin(papers, paperJoin).where(and(active, lte(reviewCards.due, now),
        isNew ? eq(reviewCards.state, State.New) : ne(reviewCards.state, State.New)))
      .orderBy(asc(reviewCards.due), asc(reviewCards.id)).limit(limit).all();
    // Give overdue reviews priority; keep the response bounded even after a long absence.
    const rows = [...dueCards(false, 100), ...dueCards(true, newRemainingToday)];
    const cards = rows.map(({ card }) => {
      const outcomes = schedule.repeat(toFsrs(card), now);
      return {
        card: reviewCardDto(card, readCitations(deps.db, 'review_card', card.id)),
        preview: ratings.map((rating) => ({ rating, due: outcomes[rating].card.due.getTime(), scheduledDays: outcomes[rating].card.scheduled_days })),
      };
    });
    return routeJson(c, 'review.queue', { now, cards, newRemainingToday });
  },
  'review.stats': (c) => {
    const now = Date.now();
    const { reviews, introduced } = dayCounts(deps, now);
    const row = deps.db.select({
      total: count(),
      dueToday: sql<number>`count(case when ${reviewCards.due} <= ${now} and ${reviewCards.state} <> 0 then 1 end)`,
      newAvailable: sql<number>`count(case when ${reviewCards.due} <= ${now} and ${reviewCards.state} = 0 then 1 end)`,
    }).from(reviewCards).innerJoin(papers, paperJoin).where(active).get()!;
    return routeJson(c, 'review.stats', { total: row.total, dueToday: row.dueToday, reviewedToday: reviews,
      newToday: Math.min(row.newAvailable, Math.max(0, dailyNewLimit - introduced)) });
  },
  'review.grade': async (c) => {
    const { id } = routeParams(c, 'review.grade');
    const { rating, expectedReps, clientRequestId } = await routeBody(c, 'review.grade');
    const result = deps.db.transaction((tx) => {
      const row = tx.select({ card: reviewCards }).from(reviewCards).innerJoin(papers, paperJoin)
        .where(and(active, eq(reviewCards.id, id))).get()?.card;
      if (!row) throw notFound('review card');
      const citations = readCitations(tx, 'review_card', id);
      const prior = tx.select().from(reviewLogs).where(eq(reviewLogs.clientRequestId, clientRequestId)).get();
      if (prior) {
        if (prior.cardId !== id || prior.rating !== rating) throw new HttpError(409, 'conflict', '다른 평가에 사용한 요청입니다.');
        return reviewCardDto(row, citations);
      }
      const now = Date.now();
      if (row.reps !== expectedReps || row.due > now) {
        throw new HttpError(409, 'conflict', '복습 일정이 바뀌었습니다. 큐를 다시 열어 주세요.', reviewCardDto(row, citations));
      }
      if (row.state === State.New && dayCounts(deps, now).introduced >= dailyNewLimit) {
        throw new HttpError(409, 'conflict', '오늘 새로 복습할 수 있는 문제를 모두 풀었습니다.');
      }
      const { card, log } = schedule.next(toFsrs(row), now, rating);
      const updated = tx.update(reviewCards).set({ ...fromFsrs(card), updatedAt: now }).where(eq(reviewCards.id, id)).returning().get();
      tx.insert(reviewLogs).values({
        id: randomUUID(), cardId: id, clientRequestId, rating, state: log.state, due: log.due.getTime(),
        stability: log.stability, difficulty: log.difficulty, elapsedDays: log.elapsed_days, lastElapsedDays: log.last_elapsed_days,
        scheduledDays: log.scheduled_days, learningSteps: log.learning_steps, reviewedAt: now, fsrsLibVersion: FSRSVersion,
      }).run();
      return reviewCardDto(updated, citations);
    });
    return routeJson(c, 'review.grade', result);
  },
});
