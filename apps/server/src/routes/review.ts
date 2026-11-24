import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { ApiBody } from '@study-paper/shared/contracts/api';
import { highlights, llmCalls, papers, reviewCards, sections } from '../db/schema';
import { HttpError, notFound, routeBody, routeJson, type AppDeps, type RouteModule } from '../deps';
import { suggestionAvailable } from '../resultRetention';
import { initialSchedule, reviewCardDto, schedulerRoutes } from '../review/scheduler';
import { storedQuestions } from '../study/selectionQuestions';
import { sectionAt } from './highlights';
import { reviewSelectionPosition } from '../study/selectionAnchor';

type CreateBody = ApiBody<'review.cards.create'>;

export function createReviewCard(deps: Pick<AppDeps, 'db'>, body: CreateBody) {
  const { paperId, runId, questionIndex, anchor } = body;
  return deps.db.transaction((tx) => {
    const now = Date.now();
    const paper = tx.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, paperId)).get();
    if (!paper || paper.deletingAt !== null) throw notFound('paper');
    let highlightId = body.highlightId ?? null;
    let sectionId = body.sectionId ?? null;
    const supplied = highlightId ? tx.select().from(highlights).where(and(eq(highlights.id, highlightId), eq(highlights.paperId, paperId))).get() : null;
    if (highlightId && !supplied) throw notFound('highlight');
    if (sectionId && !tx.select({ id: sections.id }).from(sections).where(and(eq(sections.id, sectionId), eq(sections.paperId, paperId))).get()) throw notFound('section');
    let id: string = randomUUID();
    if (runId !== undefined && questionIndex !== undefined && anchor) {
      // One stable card per accepted preview item, including concurrent clicks and retries after a lost reply.
      id = createHash('sha256').update(JSON.stringify([runId, questionIndex])).digest('hex');
      const call = tx.select().from(llmCalls).where(and(eq(llmCalls.runId, runId), eq(llmCalls.paperId, paperId))).get();
      if (!call || call.task !== 'selection_questions' || call.status !== 'ok' || !suggestionAvailable(call, paper, now)) throw notFound('review preview');
      const saved = storedQuestions(call.resultRaw!);
      const item = saved?.questions.cards[questionIndex];
      if (!saved || !item || item.type !== body.type || item.frontMd !== body.frontMd || item.backMd !== body.backMd) {
        throw new HttpError(400, 'validation', '문제 미리보기와 저장할 내용이 일치하지 않습니다.');
      }
      const pos = reviewSelectionPosition(deps.db, paperId, anchor.page, anchor.quote);
      if (!pos || anchor.page !== saved.page || anchor.quote.exact !== saved.quote.exact || pos.start !== saved.start) {
        throw new HttpError(400, 'validation', '문제를 만든 원래 선택 구간을 확인할 수 없습니다.');
      }
      if (supplied && (supplied.kind !== 'text' || supplied.page !== anchor.page || supplied.startOffset !== pos.start || supplied.endOffset !== pos.end || supplied.quoteExact !== anchor.quote.exact)) {
        throw new HttpError(400, 'validation', '하이라이트와 문제의 선택 위치가 다릅니다.');
      }
      const existingCard = tx.select().from(reviewCards).where(eq(reviewCards.id, id)).get();
      if (existingCard) return reviewCardDto(existingCard);
      const existing = supplied ?? tx.select().from(highlights).where(and(
        eq(highlights.paperId, paperId), eq(highlights.page, anchor.page), eq(highlights.kind, 'text'),
        eq(highlights.startOffset, pos.start), eq(highlights.endOffset, pos.end), eq(highlights.quoteExact, anchor.quote.exact),
      )).get();
      sectionId = sectionAt(deps, paperId, pos);
      if (body.sectionId && body.sectionId !== sectionId) throw new HttpError(400, 'validation', '선택 위치의 절과 일치하지 않습니다.');
      highlightId = existing?.id ?? randomUUID();
      if (!existing) tx.insert(highlights).values({
        id: highlightId, paperId, kind: 'text', color: 1, page: anchor.page, quoteExact: anchor.quote.exact,
        quotePrefix: anchor.quote.prefix ?? null, quoteSuffix: anchor.quote.suffix ?? null,
        startOffset: pos.start, endOffset: pos.end, rectsJson: JSON.stringify(anchor.rects), sectionId,
        createdAt: now, updatedAt: now,
      }).run();
    } else if (!sectionId && supplied) {
      sectionId = supplied.sectionId;
    }
    const row = tx.insert(reviewCards).values({
      id, paperId, type: body.type, frontMd: body.frontMd, backMd: body.backMd, sectionId, highlightId,
      origin: runId ? 'llm' : 'manual', llmCallId: runId ?? null,
      ...initialSchedule(now), createdAt: now, updatedAt: now,
    }).returning().get();
    return reviewCardDto(row);
  });
}

export const reviewRoutes: RouteModule = (deps) => ({
  ...schedulerRoutes(deps),
  'review.cards.create': async (c) => routeJson(c, 'review.cards.create', createReviewCard(deps, await routeBody(c, 'review.cards.create'))),
});
