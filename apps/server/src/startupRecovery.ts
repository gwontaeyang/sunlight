// Startup recovery (PLAN 2.2, PLAN_M2 3.4–3.5). Runs before the server accepts requests. Owner: supervisor.
// M2 additions (all in the one DB transaction unless noted):
//  ① messages with pendingReplace=1 (an uncommitted regenerate turn: user + assistant) are DELETED — before the
//    streaming → interrupted marking, so the old turn stays as it was; their citations go with the trigger.
//  ② capture files: files rows (kind 'capture') that no thread and no highlight references are deleted, and after
//    the transaction their PNGs; PNGs in papers/<id>/captures without a row are deleted too.
//  ③ upgrade_structure jobs that were running end `interrupted` through the general job rule; papers.ingestStatus is
//    not touched by them (an upgrade never sets it to running).
//  ④ llm_calls.resultRaw: right after the tombstoned papers are deleted, the stored results that are expired
//    (resultRetention.suggestionExpiryCutoff — the same boundary as the use-time decision) or lost their paper
//    (paperId NULL) are cleared. Rows stay; no limit.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Sqlite } from './db/client';
import { CITATION_OWNER_TABLES } from './db/schema';
import type { DataPaths } from './paths';
import { suggestionExpiryCutoff } from './resultRetention';

export interface RecoveryReport {
  llmCalls: number;
  messages: number;
  paperCards: number;
  jobs: number;
  papersIngest: number;
  papersDeleted: number;
  orphanCitations: number;
  tmpEntries: number;
  orphanPaperDirs: number;
  /** ① messages of uncommitted regenerate turns that were deleted. */
  pendingReplaceMessages: number;
  /** ② capture rows nothing referenced (deleted with their files) + PNG files without a row. */
  orphanCaptureRows: number;
  orphanCaptureFiles: number;
  /** ④ llm_calls rows whose resultRaw was cleared. */
  resultRawCleared: number;
}

export function startupRecovery(sqlite: Sqlite, paths: DataPaths, now = Date.now()): RecoveryReport {
  const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args).changes;
  let captureFilesToRemove: string[] = [];
  const report = sqlite.transaction((): Omit<RecoveryReport, 'tmpEntries' | 'orphanPaperDirs' | 'orphanCaptureFiles'> => {
    // Papers whose deletion was interrupted: finish the DB part (cascade + citation triggers).
    const papersDeleted = run(`DELETE FROM papers WHERE deletingAt IS NOT NULL`);
    // ④ after the tombstone deletion (its FK sets paperId NULL): expired or paper-less stored results.
    const resultRawCleared = run(`UPDATE llm_calls SET resultRaw = NULL WHERE resultRaw IS NOT NULL AND (finishedAt IS NULL OR finishedAt <= ? OR paperId IS NULL)`, suggestionExpiryCutoff(now));
    // ① before streaming → interrupted: an uncommitted regenerate turn disappears, the old turn stays.
    const pendingReplaceMessages = run(`DELETE FROM messages WHERE pendingReplace = 1`);
    run(`UPDATE paper_overviews SET pendingRunId=NULL, pendingRegenerate=0 WHERE pendingRunId IS NOT NULL`);
    run(`UPDATE study_paths SET pendingRunId=NULL, pendingCodeLanguage=NULL, pendingRegenerate=0 WHERE pendingRunId IS NOT NULL`);
    const llmCalls = run(`UPDATE llm_calls SET status='interrupted', finishedAt=? WHERE status IN ('queued','running')`, now);
    const messages = run(`UPDATE messages SET status='interrupted' WHERE status='streaming'`);
    const paperCards = run(`UPDATE paper_cards SET status='interrupted' WHERE status='generating'`);
    // A job that was running: its `running` steps can never finish → close them, so a replay of jobs.events and
    // PaperDetailDto.lastJob do not show a step that is "still running" in an interrupted job.
    const runningJobs = sqlite.prepare(`SELECT id, stepsJson FROM jobs WHERE status='running'`).all() as { id: string; stepsJson: string | null }[];
    for (const j of runningJobs) {
      let steps: { step: string; status: string; detail?: string }[] = [];
      try {
        const parsed: unknown = JSON.parse(j.stepsJson ?? '[]');
        if (Array.isArray(parsed)) steps = parsed as typeof steps;
      } catch {
        /* unreadable steps are replaced by an empty list */
      }
      const closed = steps.map((s) => (s.status === 'running' ? { ...s, status: 'error', detail: 'interrupted' } : s));
      sqlite.prepare(`UPDATE jobs SET stepsJson=?, error=COALESCE(error, 'interrupted: the server stopped while the job was running') WHERE id=?`).run(JSON.stringify(closed), j.id);
    }
    const jobs = run(`UPDATE jobs SET status='interrupted', updatedAt=? WHERE status='running'`, now);
    const papersIngest = run(`UPDATE papers SET ingestStatus='interrupted', updatedAt=? WHERE ingestStatus='running'`, now);
    let orphanCitations = 0;
    for (const [ownerType, table] of Object.entries(CITATION_OWNER_TABLES)) {
      orphanCitations += run(`DELETE FROM citations WHERE ownerType=? AND ownerId NOT IN (SELECT id FROM ${table})`, ownerType);
    }
    orphanCitations += run(`DELETE FROM citations WHERE ownerType NOT IN (${Object.keys(CITATION_OWNER_TABLES).map(() => '?').join(',')})`, ...Object.keys(CITATION_OWNER_TABLES));
    // ② capture rows nothing references (a crash between storeCapture's row and its owner, or an owner deleted).
    const orphanCaptures = sqlite
      .prepare(
        `SELECT id, relPath FROM files WHERE kind = 'capture'
           AND id NOT IN (SELECT imageFileId FROM threads WHERE imageFileId IS NOT NULL)
           AND id NOT IN (SELECT imageFileId FROM highlights WHERE imageFileId IS NOT NULL)`,
      )
      .all() as { id: string; relPath: string }[];
    for (const f of orphanCaptures) sqlite.prepare(`DELETE FROM files WHERE id = ?`).run(f.id);
    captureFilesToRemove = orphanCaptures.map((f) => join(paths.root, f.relPath));
    return { llmCalls, messages, paperCards, jobs, papersIngest, papersDeleted, orphanCitations, pendingReplaceMessages, orphanCaptureRows: orphanCaptures.length, resultRawCleared };
  })();
  for (const f of captureFilesToRemove) {
    // relPath is papers/<id>/captures/<fileId>.png; never follow a path outside the data dir.
    if (f.startsWith(paths.papersDir + '/')) rmSync(f, { force: true });
  }
  // PNGs in captures/ without a files row.
  let orphanCaptureFiles = 0;
  if (existsSync(paths.papersDir)) {
    const known = new Set((sqlite.prepare(`SELECT relPath FROM files WHERE kind = 'capture'`).all() as { relPath: string }[]).map((r) => join(paths.root, r.relPath)));
    for (const paper of readdirSync(paths.papersDir, { withFileTypes: true })) {
      if (!paper.isDirectory()) continue;
      const dir = join(paths.papersDir, paper.name, 'captures');
      if (!existsSync(dir)) continue;
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (!known.has(p)) {
          rmSync(p, { recursive: true, force: true });
          orphanCaptureFiles++;
        }
      }
    }
  }

  let tmpEntries = 0;
  if (existsSync(paths.tmpDir)) {
    for (const e of readdirSync(paths.tmpDir)) {
      rmSync(join(paths.tmpDir, e), { recursive: true, force: true });
      tmpEntries++;
    }
  }
  let orphanPaperDirs = 0;
  if (existsSync(paths.papersDir)) {
    const known = new Set((sqlite.prepare(`SELECT id FROM papers`).all() as { id: string }[]).map((r) => r.id));
    for (const e of readdirSync(paths.papersDir, { withFileTypes: true })) {
      if (e.isDirectory() && !known.has(e.name)) {
        rmSync(join(paths.papersDir, e.name), { recursive: true, force: true });
        orphanPaperDirs++;
      }
    }
  }
  return { ...report, tmpEntries, orphanPaperDirs, orphanCaptureFiles };
}
