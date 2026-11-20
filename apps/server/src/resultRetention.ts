// Retention of run results that have no owner row (PLAN_M2 D29, 3.4 rule 6). Owner: supervisor — frozen.
// M2 stores the adopted output of glossary_define in llm_calls.resultRaw. It is usable for 30 days after the run
// finished, and never once the paper is deleted or being deleted (tombstone).
//
// - The DECISION is made at use time by the pure functions below (B's replay, the attach to a finished run kept in
//   memory, and the glossary origin call suggestionAvailable only — nobody re-writes `resultRaw IS NULL` or the
//   30-day arithmetic). The clock is Date.now() passed by the caller (the same clock runManager uses for
//   finishedAt; tests fake Date with vi.setSystemTime).
// - PHYSICAL deletion: papers.delete clears a paper's rows in its tombstone transaction and again right before the
//   row DELETE (clearPaperResultRaw); expired rows are cleared by startup recovery and by a 1 h sweep that empties
//   the whole backlog each tick (batches of RESULT_SWEEP_BATCH, setImmediate between batches). Promise: an expired
//   result leaves the DB within the next tick (≤ 1 h) + the time to empty the backlog; access is refused before that.
import type { Sqlite } from './db/client';
import type { Lifecycle } from './lifecycle';

export const RESULT_RAW_RETENTION_MS = 30 * 86_400_000;
export const RESULT_SWEEP_INTERVAL_MS = 3_600_000;
export const RESULT_SWEEP_BATCH = 500;

/** finishedAt at or before this instant is expired. The one place the boundary is defined. */
export function suggestionExpiryCutoff(now: number): number {
  return now - RESULT_RAW_RETENTION_MS;
}

/** finishedAt === null || finishedAt <= cutoff(now): exactly 30 days after finishing is expired. */
export function isSuggestionExpired(finishedAt: number | null, now: number): boolean {
  return finishedAt === null || finishedAt <= suggestionExpiryCutoff(now);
}

/** The stored suggestion may be used: resultRaw present, paper row present and not being deleted, not expired. */
export function suggestionAvailable(
  row: { resultRaw: string | null; paperId: string | null; finishedAt: number | null },
  paper: { deletingAt: number | null } | undefined,
  now: number,
): boolean {
  return row.resultRaw !== null && row.paperId !== null && paper !== undefined && paper.deletingAt === null && !isSuggestionExpired(row.finishedAt, now);
}

/** Clears every stored result of a paper (papers.delete: tombstone transaction and before the row DELETE). */
export function clearPaperResultRaw(sqlite: Sqlite, paperId: string): number {
  return sqlite.prepare(`UPDATE llm_calls SET resultRaw = NULL WHERE paperId = ? AND resultRaw IS NOT NULL`).run(paperId).changes;
}

/**
 * One batch: clears resultRaw of at most `limit` rows that are expired (same inequality as isSuggestionExpired),
 * have no paper any more (paperId NULL) or belong to a tombstoned paper. Rows and other columns stay.
 */
export function sweepResultRaw(sqlite: Sqlite, now: number, limit = RESULT_SWEEP_BATCH): number {
  return sqlite
    .prepare(
      `UPDATE llm_calls SET resultRaw = NULL WHERE rowid IN (
         SELECT l.rowid FROM llm_calls l LEFT JOIN papers p ON p.id = l.paperId
         WHERE l.resultRaw IS NOT NULL
           AND (l.finishedAt IS NULL OR l.finishedAt <= ? OR l.paperId IS NULL OR p.id IS NULL OR p.deletingAt IS NOT NULL)
         LIMIT ?)`,
    )
    .run(suggestionExpiryCutoff(now), limit).changes;
}

/**
 * Periodic sweep (index.ts starts it once after startup recovery). Every `intervalMs` (default 1 h, unref'd) a tick
 * empties the backlog: batches of RESULT_SWEEP_BATCH until a batch clears fewer rows, yielding with setImmediate in
 * between. When lifecycle.signal aborts, the interval is cleared and no further batch touches the DB (a tick in
 * progress stops before its next batch) — the lifecycle contract: no DB use after drain.
 */
export function startResultSweep(deps: { sqlite: Sqlite; lifecycle: Lifecycle }, opts: { intervalMs?: number; log?: (msg: string) => void } = {}): void {
  const signal = deps.lifecycle.signal;
  if (signal.aborted) return;
  const log = opts.log ?? ((m: string) => console.error(`[resultRetention] ${m}`));
  let running = false;
  const batch = () => {
    if (signal.aborted) {
      running = false;
      return;
    }
    let cleared: number;
    try {
      cleared = sweepResultRaw(deps.sqlite, Date.now(), RESULT_SWEEP_BATCH);
    } catch (e) {
      running = false;
      log(`sweep failed (retried next tick): ${(e as Error).message}`);
      return;
    }
    if (cleared >= RESULT_SWEEP_BATCH) setImmediate(batch);
    else running = false;
  };
  const timer = setInterval(() => {
    if (running || signal.aborted) return;
    running = true;
    batch();
  }, opts.intervalMs ?? RESULT_SWEEP_INTERVAL_MS);
  timer.unref();
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}
