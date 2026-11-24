import { and, eq, inArray, isNull } from 'drizzle-orm';
import { OverviewResult, type OverviewDto } from '@study-paper/shared/contracts/api';
import type { Citation } from '@study-paper/shared/contracts/domain';
import type { Db } from '../db/client';
import { llmCalls, paperOverviews, papers } from '../db/schema';
import { HttpError } from '../deps';
import type { RunStartRows, RunTx } from '../llm/runContract';
import { liveStudyPaper } from '../studyPath/store';

const clearPending = { pendingRunId: null, pendingRegenerate: false };

export function readOverview(db: Db | RunTx, paperId: string): OverviewDto {
  const row = db.select().from(paperOverviews).where(eq(paperOverviews.paperId, paperId)).get();
  const active = row?.pendingRunId ? db.select({ id: llmCalls.clientRequestId }).from(llmCalls)
    .where(and(eq(llmCalls.runId, row.pendingRunId), inArray(llmCalls.status, ['running', 'queued']))).get() : undefined;
  return {
    result: row?.resultJson ? OverviewResult.parse(JSON.parse(row.resultJson)) : null,
    pending: row?.pendingRunId && active?.id
      ? { runId: row.pendingRunId, clientRequestId: active.id, regenerate: row.pendingRegenerate } : null,
  };
}

export function overviewPending(db: Db | RunTx, paperId: string | null, runId: string): boolean {
  if (!paperId) return false;
  return Boolean(db.select({ id: papers.id }).from(paperOverviews).innerJoin(papers, eq(papers.id, paperOverviews.paperId))
    .where(and(eq(papers.id, paperId), isNull(papers.deletingAt), eq(paperOverviews.pendingRunId, runId))).get());
}

export function startOverviewRows(paperId: string, regenerate: boolean): RunStartRows {
  return {
    insert(tx, runId) {
      if (liveStudyPaper(tx, paperId).readyAt === null) throw new HttpError(409, 'context_not_ready', 'paper context is not ready yet');
      const row = tx.select().from(paperOverviews).where(eq(paperOverviews.paperId, paperId)).get();
      if (row?.pendingRunId) throw new HttpError(409, 'conflict', 'an overview is being generated', {
        reason: 'overview_generating', runId: row.pendingRunId,
      });
      if (row?.resultJson && !regenerate) throw new HttpError(409, 'conflict', 'this paper already has an overview', { reason: 'overview_exists' });
      const pending = { pendingRunId: runId, pendingRegenerate: regenerate };
      tx.insert(paperOverviews).values({ paperId, ...pending }).onConflictDoUpdate({ target: paperOverviews.paperId, set: pending }).run();
      return { artifactId: runId };
    },
  };
}

export function commitOverview(tx: RunTx, paperId: string, runId: string, text: string, citations: Citation[]): string[] | null {
  if (!overviewPending(tx, paperId, runId)) return null;
  const previous = readOverview(tx, paperId).result;
  const result = OverviewResult.parse({ runId, text, citations });
  tx.update(paperOverviews).set({ ...clearPending, resultJson: JSON.stringify(result) }).where(eq(paperOverviews.paperId, paperId)).run();
  if (!previous) return [];
  tx.update(llmCalls).set({ errorCode: 'superseded' }).where(eq(llmCalls.runId, previous.runId)).run();
  return [previous.runId];
}

export function failOverview(tx: RunTx, paperId: string, runId: string) {
  tx.update(paperOverviews).set(clearPending).where(and(eq(paperOverviews.paperId, paperId), eq(paperOverviews.pendingRunId, runId))).run();
}
