// Study paths retain the last complete lesson until its replacement succeeds.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { StudyPathResult, type StudyCodeLanguage, type StudyPathDto } from '@study-paper/shared/contracts/api';
import { STUDY_PATH_MAX_CHECKS, type Citation } from '@study-paper/shared/contracts/domain';
import type { Db } from '../db/client';
import { llmCalls, papers, studyPaths } from '../db/schema';
import { HttpError, notFound } from '../deps';
import type { RunStartRows, RunTx } from '../llm/runContract';

type Reader = Db | RunTx;
const clearPending = { pendingRunId: null, pendingCodeLanguage: null, pendingRegenerate: false };

export function liveStudyPaper(db: Reader, paperId: string) {
  const row = db.select({ readyAt: papers.contextReadyAt }).from(papers)
    .where(and(eq(papers.id, paperId), isNull(papers.deletingAt))).get();
  if (!row) throw notFound('paper');
  return row;
}

export function readStudyPath(db: Reader, paperId: string): StudyPathDto {
  const row = db.select().from(studyPaths).where(eq(studyPaths.paperId, paperId)).get();
  const active = row?.pendingRunId && row.pendingCodeLanguage
    ? db.select({ id: llmCalls.clientRequestId }).from(llmCalls)
      .where(and(eq(llmCalls.runId, row.pendingRunId), inArray(llmCalls.status, ['running', 'queued']))).get()
    : undefined;
  return {
    result: row?.resultJson ? StudyPathResult.parse(JSON.parse(row.resultJson)) : null,
    pending: row?.pendingRunId && row.pendingCodeLanguage && active?.id
      ? { runId: row.pendingRunId, clientRequestId: active.id, codeLanguage: row.pendingCodeLanguage, regenerate: row.pendingRegenerate }
      : null,
  };
}

export function studyPathPending(db: Reader, paperId: string | null, runId: string): boolean {
  if (!paperId) return false;
  return Boolean(db.select({ id: studyPaths.paperId }).from(studyPaths)
    .innerJoin(papers, eq(papers.id, studyPaths.paperId))
    .where(and(eq(studyPaths.paperId, paperId), eq(studyPaths.pendingRunId, runId), isNull(papers.deletingAt))).get());
}

export function startStudyPathRows(paperId: string, regenerate: boolean, codeLanguage: StudyCodeLanguage): RunStartRows {
  return {
    insert(tx, runId) {
      const paper = liveStudyPaper(tx, paperId);
      if (paper.readyAt === null) throw new HttpError(409, 'context_not_ready', 'paper context is not ready yet');
      const current = tx.select().from(studyPaths).where(eq(studyPaths.paperId, paperId)).get();
      if (current?.pendingRunId) throw new HttpError(409, 'conflict', 'a study path is being generated', {
        reason: 'study_path_generating', runId: current.pendingRunId,
      });
      if (current?.resultJson && !regenerate) throw new HttpError(409, 'conflict', 'this paper already has a study path', {
        reason: 'study_path_exists',
      });
      const pending = { pendingRunId: runId, pendingCodeLanguage: codeLanguage, pendingRegenerate: regenerate };
      tx.insert(studyPaths).values({ paperId, ...pending }).onConflictDoUpdate({ target: studyPaths.paperId, set: pending }).run();
      return { artifactId: runId };
    },
  };
}

export function commitStudyPath(tx: RunTx, paperId: string, runId: string, text: string, citations: Citation[], checkCount: number): string[] | null {
  if (!studyPathPending(tx, paperId, runId)) return null;
  if (!Number.isInteger(checkCount) || checkCount < 1 || checkCount > STUDY_PATH_MAX_CHECKS) throw new Error('invalid study checklist');
  const state = tx.select().from(studyPaths).where(eq(studyPaths.paperId, paperId)).get()!;
  const result = StudyPathResult.parse({
    runId, text, citations, codeLanguage: state.pendingCodeLanguage, checked: Array<boolean>(checkCount).fill(false),
  });
  const previous = state.resultJson ? StudyPathResult.parse(JSON.parse(state.resultJson)) : null;
  tx.update(studyPaths).set({ ...clearPending, resultJson: JSON.stringify(result) }).where(eq(studyPaths.paperId, paperId)).run();
  if (!previous) return [];
  tx.update(llmCalls).set({ errorCode: 'superseded' }).where(eq(llmCalls.runId, previous.runId)).run();
  return [previous.runId];
}

export function failStudyPath(tx: RunTx, paperId: string, runId: string) {
  tx.update(studyPaths).set(clearPending).where(and(eq(studyPaths.paperId, paperId), eq(studyPaths.pendingRunId, runId))).run();
}

export function checkStudyPath(db: Db, paperId: string, runId: string, index: number, checked: boolean): StudyPathDto {
  return db.transaction((tx) => {
    liveStudyPaper(tx, paperId);
    const state = readStudyPath(tx, paperId);
    if (!state.result) throw notFound('study path');
    if (state.result.runId !== runId) throw new HttpError(409, 'conflict', 'the study path has changed', { reason: 'study_path_changed' });
    if (index >= state.result.checked.length) throw new HttpError(400, 'validation', 'unknown checklist item');
    state.result.checked[index] = checked;
    tx.update(studyPaths).set({ resultJson: JSON.stringify(state.result) }).where(eq(studyPaths.paperId, paperId)).run();
    return state;
  }, { behavior: 'immediate' });
}
