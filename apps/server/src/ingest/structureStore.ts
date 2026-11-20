// Structure rows + supplement v2 publication + the T_struct transaction (PLAN_M2 3.1 "게시와 전환"). Owner A.
//
// 1. Files first: source.html was written by the html step (atomic); supplement.v2.txt is published with
//    publishNoClobber. The same bytes already there → 'identical'. Other bytes while papers.supplementVersion ≠ 2 →
//    a leftover of an earlier attempt the DB never pointed at: moved to tmp/, removed, published again. Other bytes
//    while supplementVersion = 2 → supplement_exists (a file the DB points at is never replaced). The abort signal is
//    checked right before, and the check → link stretch is synchronous.
// 2. T_struct — ONE transaction, both branches: first the job's abort signal, then the jobs row must still be
//    'running', then the paper must have no structure rows yet; rows (sections, equations, figures, references) and
//    files rows (html, supplement — INSERT only: the v1 row of an upgraded paper stays) are inserted, and the papers
//    UPDATE carries `deletingAt IS NULL` + the expected version, changes === 1. Anything else → rollback (no rows; the
//    published file is a leftover the next attempt or the deletion removes).
//      import:  SET supplementSha256, supplementVersion=2, contextMode, contextReadyAt, structureSource='latexml',
//               codeUrl (only when NULL), ingestWarningsJson (warnings added) WHERE supplementVersion IS NULL
//      upgrade: SET supplementSha256, supplementVersion=2, structureSource='latexml', updatedAt, codeUrl (only when
//               NULL), ingestWarningsJson (added only) WHERE supplementVersion=1 AND structureSource='none' — and the
//               job's SUCCESS terminal in the same transaction (jobs.status='done' + final steps WHERE status
//               'running', changes === 1): structure and job success commit or roll back together (Codex M6).
//    The caller emits events only after this returns.
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { serializeSupplementV2, type SupplementIndexInput } from '@study-paper/shared/contracts/supplement';
import type { ContextMode } from '@study-paper/shared/contracts/domain';
import { equations, figures, files, jobs, paperReferences, papers, sections } from '../db/schema';
import type { AppDeps } from '../deps';
import type { AnchorResult } from './anchorStructure';
import { IngestError } from './errors';
import { publishNoClobber, sha256Hex, type PublishResult } from './files';
import type { ParsedStructure } from './latexml';

export const SUPPLEMENT_V2_VERSION = 2;

export interface StoredLatex {
  latex: string;
  katexOk: boolean;
}

/** serializeSupplementV2 input: the parsed structure + the stored latex + metadata as given (never pre-cut). */
export function buildSupplementInput(parsed: ParsedStructure, latex: readonly StoredLatex[], meta: SupplementIndexInput['meta']): SupplementIndexInput {
  const numberOf = (i: number | null) => (i === null ? null : (parsed.sections[i]?.number ?? null));
  return {
    meta,
    sections: parsed.sections.map((s) => ({ htmlId: s.htmlId, number: s.number, title: s.title })),
    equations: parsed.equations.flatMap((e, i) => (e.number === null ? [] : [{ number: e.number, sectionNumber: numberOf(e.sectionIndex), latex: latex[i]!.latex }])),
    figures: parsed.figures.map((f) => ({ kind: f.kind, number: f.number, caption: f.caption })),
    references: parsed.references.map((r) => ({ label: r.label, rawText: r.rawText })),
  };
}

export interface PublishedV2 {
  text: string;
  truncated: boolean;
  sha256: string;
  bytes: number;
  result: PublishResult | 'replaced_leftover';
}

/** Serializes and publishes supplement.v2.txt (rule 1 of the header). Synchronous from the abort check to link(2). */
export function publishSupplementV2(deps: Pick<AppDeps, 'paths' | 'sqlite'>, paperId: string, input: SupplementIndexInput, signal: AbortSignal): PublishedV2 {
  const { text, truncated } = serializeSupplementV2(input);
  const data = Buffer.from(text, 'utf8');
  const dest = deps.paths.supplementFile(paperId, SUPPLEMENT_V2_VERSION);
  if (signal.aborted) throw new IngestError('cancelled', 'cancelled before publishing supplement.v2.txt');
  let result: PublishedV2['result'];
  try {
    result = publishNoClobber(deps.paths.tmpDir, dest, data);
  } catch (e) {
    if (!(e instanceof IngestError) || e.code !== 'supplement_exists') throw e;
    const row = deps.sqlite.prepare(`SELECT supplementVersion FROM papers WHERE id = ?`).get(paperId) as { supplementVersion: number | null } | undefined;
    if (row?.supplementVersion === SUPPLEMENT_V2_VERSION) throw e;
    // A leftover the DB never pointed at: move it out of the paper directory and publish again.
    const aside = join(deps.paths.tmpDir, `${randomUUID()}.stale-supplement`);
    renameSync(dest, aside);
    rmSync(aside, { force: true });
    publishNoClobber(deps.paths.tmpDir, dest, data);
    result = 'replaced_leftover';
  }
  return { text, truncated, sha256: sha256Hex(data), bytes: data.length, result };
}

export class StructureCommitError extends IngestError {
  constructor(
    readonly reason: 'aborted' | 'job_not_running' | 'structure_exists' | 'paper_changed',
    message: string,
    code: 'cancelled' | 'interrupted' | 'internal' | 'supplement_exists' = 'internal',
  ) {
    super(code, message);
    this.name = 'StructureCommitError';
  }
}

/** Appends codes to an ingestWarningsJson value (existing entries kept in order, no duplicates). */
export function mergeWarnings(json: string | null, add: readonly string[]): string {
  let list: string[] = [];
  try {
    const v = json ? (JSON.parse(json) as unknown) : [];
    list = Array.isArray(v) ? v.map(String) : [];
  } catch {
    list = [];
  }
  for (const w of add) if (!list.includes(w)) list.push(w);
  return JSON.stringify(list);
}

export interface StructureRowsInput {
  paperId: string;
  parsed: ParsedStructure;
  latex: readonly StoredLatex[];
  anchors: AnchorResult | null;
}

export interface CommitBase extends StructureRowsInput {
  jobId: string;
  signal: AbortSignal;
  /** Abort reason → error (deleted → cancelled, shutdown → interrupted). */
  abortError: () => IngestError;
  supplement: { sha256: string; bytes: number };
  /** source.html written by the html step (sha256, bytes), or null. */
  html: { sha256: string; bytes: number } | null;
  warnings: readonly string[];
  now: number;
  /**
   * Test fault injection inside the transaction: 'tstruct.begin' (before the abort check), 'tstruct.job' (before the job
   * check), 'tstruct.finish' (upgrade: after the papers UPDATE, before the job's success terminal).
   */
  inject?: (point: 'tstruct.begin' | 'tstruct.job' | 'tstruct.finish') => void;
}

/** Inserts the structure rows (inside the caller's transaction). */
function insertRows(deps: Pick<AppDeps, 'db'>, s: StructureRowsInput): void {
  const { db } = deps;
  const count = (t: typeof sections | typeof equations | typeof figures | typeof paperReferences) => db.select({ n: sql<number>`count(*)` }).from(t).where(eq(t.paperId, s.paperId)).get()?.n ?? 0;
  if (count(sections) + count(equations) + count(figures) + count(paperReferences) > 0) throw new StructureCommitError('structure_exists', 'the paper already has structure rows');
  const secIds = s.parsed.sections.map(() => randomUUID());
  s.parsed.sections.forEach((sec, i) => {
    const a = s.anchors?.sections[i] ?? null;
    db.insert(sections)
      .values({ id: secIds[i]!, paperId: s.paperId, parentId: sec.parentIndex === null ? null : secIds[sec.parentIndex]!, htmlId: sec.htmlId, number: sec.number, title: sec.title, level: sec.level, ordinal: i + 1, contentMd: null, pdfPage: a?.page ?? null, pdfOffset: a?.start ?? null, pdfRectJson: a?.rect ? JSON.stringify(a.rect) : null })
      .run();
  });
  const secId = (i: number | null) => (i === null ? null : (secIds[i] ?? null));
  s.parsed.equations.forEach((e, i) => {
    const a = s.anchors?.equations[i] ?? null;
    const l = s.latex[i]!;
    db.insert(equations)
      .values({ id: randomUUID(), paperId: s.paperId, sectionId: secId(e.sectionIndex), htmlId: e.htmlId, number: e.number, ordinal: i + 1, latexRaw: e.latexRaw, latex: l.latex, katexOk: l.katexOk, contextBefore: e.contextBefore, contextAfter: e.contextAfter, pdfPage: a?.page ?? null, pdfOffset: a?.start ?? null, pdfRectJson: a?.rect ? JSON.stringify(a.rect) : null })
      .run();
  });
  s.parsed.figures.forEach((f, i) => {
    db.insert(figures).values({ id: randomUUID(), paperId: s.paperId, sectionId: secId(f.sectionIndex), htmlId: f.htmlId, kind: f.kind, number: f.number, caption: f.caption, pdfPage: s.anchors?.figures[i] ?? null }).run();
  });
  s.parsed.references.forEach((r, i) => {
    db.insert(paperReferences).values({ id: randomUUID(), paperId: s.paperId, ordinal: i + 1, htmlId: r.htmlId, label: r.label, rawText: r.rawText, arxivId: r.arxivId, doi: r.doi }).run();
  });
}

function checks(deps: Pick<AppDeps, 'db'>, c: CommitBase): void {
  c.inject?.('tstruct.begin');
  if (c.signal.aborted) throw c.abortError();
  c.inject?.('tstruct.job');
  const job = deps.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, c.jobId)).get();
  if (!job || job.status !== 'running') throw new StructureCommitError('job_not_running', `the job is no longer running (${job?.status ?? 'gone'})`);
}

function insertFiles(deps: Pick<AppDeps, 'db'>, c: CommitBase): void {
  const rel = (name: string) => `papers/${c.paperId}/${name}`;
  if (c.html) deps.db.insert(files).values({ id: randomUUID(), paperId: c.paperId, kind: 'html', relPath: rel('source.html'), sha256: c.html.sha256, bytes: c.html.bytes, mime: 'text/html', createdAt: c.now }).run();
  deps.db.insert(files).values({ id: randomUUID(), paperId: c.paperId, kind: 'supplement', relPath: rel('supplement.v2.txt'), sha256: c.supplement.sha256, bytes: c.supplement.bytes, mime: 'text/plain', createdAt: c.now }).run();
}

/**
 * New-import branch of T_struct (call INSIDE the step transaction — pipeline.setStep's `extra`, so the step row and
 * the structure commit together).
 */
export function commitImportStructure(deps: Pick<AppDeps, 'db'>, c: CommitBase & { contextMode: ContextMode; codeUrl: string | null }): void {
  checks(deps, c);
  insertRows(deps, c);
  insertFiles(deps, c);
  const cur = deps.db.select({ w: papers.ingestWarningsJson }).from(papers).where(eq(papers.id, c.paperId)).get();
  const r = deps.db
    .update(papers)
    .set({
      supplementSha256: c.supplement.sha256,
      supplementVersion: SUPPLEMENT_V2_VERSION,
      contextMode: c.contextMode,
      contextReadyAt: c.now,
      structureSource: 'latexml',
      codeUrl: sql`COALESCE(${papers.codeUrl}, ${c.codeUrl})`,
      ingestWarningsJson: mergeWarnings(cur?.w ?? null, c.warnings),
      updatedAt: c.now,
    })
    .where(and(eq(papers.id, c.paperId), isNull(papers.supplementVersion), isNull(papers.deletingAt)))
    .run();
  if (r.changes !== 1) {
    const p = deps.db.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, c.paperId)).get();
    if (!p || p.deletingAt !== null) throw new StructureCommitError('paper_changed', 'the paper was deleted', 'cancelled');
    throw new StructureCommitError('paper_changed', 'the paper already has a supplement (supplementVersion is set)', 'supplement_exists');
  }
}

/**
 * Upgrade branch of T_struct: its own transaction, including the job's success terminal (status 'done' + `steps`).
 * Throws (→ rollback) on any failed condition.
 */
export function commitUpgradeStructure(deps: Pick<AppDeps, 'db' | 'sqlite'>, c: CommitBase & { codeUrl: string | null; finalStepsJson: string }): void {
  deps.sqlite.transaction(() => {
    checks(deps, c);
    insertRows(deps, c);
    insertFiles(deps, c);
    const cur = deps.db.select({ w: papers.ingestWarningsJson }).from(papers).where(eq(papers.id, c.paperId)).get();
    const r = deps.db
      .update(papers)
      .set({ supplementSha256: c.supplement.sha256, supplementVersion: SUPPLEMENT_V2_VERSION, structureSource: 'latexml', codeUrl: sql`COALESCE(${papers.codeUrl}, ${c.codeUrl})`, ingestWarningsJson: mergeWarnings(cur?.w ?? null, c.warnings), updatedAt: c.now })
      .where(and(eq(papers.id, c.paperId), eq(papers.supplementVersion, 1), eq(papers.structureSource, 'none'), isNull(papers.deletingAt)))
      .run();
    if (r.changes !== 1) {
      const p = deps.db.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, c.paperId)).get();
      if (!p || p.deletingAt !== null) throw new StructureCommitError('paper_changed', 'the paper was deleted', 'cancelled');
      throw new StructureCommitError('paper_changed', 'the paper is no longer an upgrade target (already upgraded?)', 'internal');
    }
    c.inject?.('tstruct.finish');
    const j = deps.db
      .update(jobs)
      .set({ status: 'done', stepsJson: c.finalStepsJson, error: null, updatedAt: c.now })
      .where(and(eq(jobs.id, c.jobId), eq(jobs.status, 'running')))
      .run();
    if (j.changes !== 1) throw new StructureCommitError('job_not_running', 'the upgrade job row could not be finished (not running)');
  })();
}
