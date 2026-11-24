// arXiv ingest pipeline (PLAN 4.1, PLAN_M2 3.1): resolve → metadata → pdf → text → html → structure → anchor →
// supplement → terminal. Owner A.
//
// States: `readable` after text (PDF + page_texts), `context_ready` after supplement (file published, sha,
// contextMode — supplement v2 + structure rows in ONE transaction T_struct when the HTML gave a structure, otherwise
// the M1 v1 supplement.txt with structureSource 'none'), then `structure_ready` in the terminal transaction.
// html/structure/anchor never fail an import: a missing / late / unusable HTML is a step `skipped`/`warn` + an ingest
// warning, and the paper continues with v1 (PLAN 4.1, PLAN_M2 D2). HTML deadline 60 s for the whole step. An
// unexpected exception after the parse (normalize / KaTeX) is structure_parse_failed (v1); one in the anchor step leaves
// every position null + step `warn` (+ anchor_failed, supervisor decision S-3 — the cause stays in the step detail) and
// v2 is still published. In an upgrade job those exceptions stay retryable failures. A source.html whose structure
// failed for good is removed (no files row ever points at it).
//
// Job kinds (A5): import_arxiv / retry_ingest write papers.ingestStatus (+ structureReadyAt) in their terminal and
// never structureSource. upgrade_structure (M1 paper → v2, PLAN_M2 3.1/D3/D4) runs html → structure → anchor →
// supplement; its SUCCESS terminal is written inside T_struct (structureStore.commitUpgradeStructure), its failure
// terminal writes the jobs row (+ a final structure warning on the paper) only — never ingestStatus, readableAt,
// contextReadyAt or structureReadyAt. liveJobForPaper / latestJob take the kinds to look at: papers.import,
// retryIngest and lastJob see ingest kinds only; the upgrade job is PaperDetailDto.structureUpgrade.job.
//
// arXiv cooldown (PLAN_M2 D28): the host queue saves every cooldown extension in settings and restores it here
// (cooldownStore.ts); SP_ARXIV_COOLDOWN_RESET=1 deletes the stored row at server start (routes/papers.ts module init)
// and again, idempotently, when the service is created.
//
// Persistence and events: every step change is written to jobs.stepsJson (and the step's artifacts to their
// tables) in ONE synchronous transaction, and the matching SSE event is emitted synchronously right after it.
// A subscriber therefore takes a DB snapshot and attaches its listener in the same tick and can never miss or
// duplicate an event (jobs.events: replay stored steps + reached states → live → exactly one terminal).
//
// Cancellation: each job has an AbortController. Shutdown (lifecycle participant) aborts with 'shutdown' → the
// job ends `interrupted`; paper deletion aborts with 'deleted' → the job ends `failed` / code `cancelled`.
// The runner always writes its terminal row before its `done` promise resolves.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ImportPaperResponse, JobDto as JobDtoSchema, ReferenceSearchRequest } from '@study-paper/shared/contracts/api';
import type { IngestWarningCode, JobErrorCode, JobKind, JobStepName, JobStepStatus, NormRect, PaperReadiness } from '@study-paper/shared/contracts/domain';
import type { JobSseEvent } from '@study-paper/shared/contracts/sse';
import { files, jobs, pageTexts, papers } from '../db/schema';
import { HttpError, notFound, type AppDeps } from '../deps';
import type { ShutdownParticipant } from '../lifecycle';
import { isNetworkDisabled } from '../security/network';
import { anchorStructure, type AnchorPage, type AnchorResult } from './anchorStructure';
import { parseArxivInput } from './arxivId';
import { NetworkArxivSource, OfflineArxivSource, type ArxivCallHooks, type ArxivRetryOptions, type ArxivSource } from './arxivApi';
import { resetStoredCooldown, SettingsCooldownStore } from './cooldownStore';
import { formatJobError, IngestError, parseJobError, toIngestError } from './errors';
import { PDF_MAGIC, recordFile, sha256Hex, writeAtomic, type WriteAtomicOptions } from './files';
import { HostQueue, type CooldownStore } from './hostQueue';
import { HttpCache } from './httpCache';
import { prepareStoredEquations } from './katexCheck';
import { arxivMentions, parseStructure, type ParsedStructure, type MentionList, versionVerdict } from './latexml';
import { extractPageTexts, PDFJS_VERSION, type ExtractOptions } from './pdfText';
import { findReferences } from './referenceSearch';
import { BYTE_LIMITS, type FetchImpl } from './safeFetch';
import { commitImportStructure, commitUpgradeStructure, mergeWarnings, publishSupplementV2, buildSupplementInput, StructureCommitError, type StoredLatex } from './structureStore';
import { structureUpgradeState } from './structureUpgradeState';
import { buildSupplementV1, contextModeFor, publishSupplement, SUPPLEMENT_FILE, SUPPLEMENT_VERSION } from './supplement';

/** Steps of an ingest job (import_arxiv, retry_ingest) in order. */
export const INGEST_STEPS = ['resolve', 'metadata', 'pdf', 'text', 'html', 'structure', 'anchor', 'supplement'] as const satisfies readonly JobStepName[];
/** Steps of an upgrade_structure job. */
export const UPGRADE_STEPS = ['html', 'structure', 'anchor', 'supplement'] as const satisfies readonly JobStepName[];
export type IngestStep = (typeof INGEST_STEPS)[number];
/** Kinds whose job is the paper's ingest (lastJob, papers.import, retryIngest). */
export const INGEST_KINDS: readonly JobKind[] = ['import_arxiv', 'retry_ingest', 'upload'];
export const UPGRADE_KINDS: readonly JobKind[] = ['upgrade_structure'];
/** The html step's deadline: queue waits, cooldowns, headers and body (PLAN_M2 3.1). */
export const HTML_STEP_DEADLINE_MS = 60_000;
export const PDF_FILE = 'paper.pdf';
/** papers.delete waits at most this long for the paper's jobs (and runs) to end. */
export const DELETE_WAIT_MS = 5_000;

export interface JobStep {
  step: JobStepName;
  status: JobStepStatus;
  detail?: string;
}

export interface IngestOptions {
  /** Replaces the arXiv source entirely (tests). */
  source?: ArxivSource;
  /** Network fetch used by the default network source (tests inject a mock). */
  fetchImpl?: FetchImpl;
  /** SP_ARXIV_OFFLINE_DIR; ignored when config.env === 'prod'. Defaults to process.env. */
  offlineDir?: string | null;
  /** Text extraction limits (tests). */
  text?: Pick<ExtractOptions, 'maxPages' | 'timeoutMs' | 'now'>;
  now?: () => number;
  /** Called between steps (tests: inject failures / pauses). Throwing fails the step. */
  beforeStep?: (step: IngestStep, jobId: string, signal: AbortSignal) => void | Promise<void>;
  /** Opens the PDF temp file (tests: short writes, slow fsync/close). */
  openFile?: WriteAtomicOptions['openFile'];
  /** arXiv retry policy overrides (tests: short timeouts; its clock defaults to `now`). */
  arxivRetry?: Partial<ArxivRetryOptions>;
  /** Sleep of the shared host queue (tests: a fake clock that advances `now`). */
  queueSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** papers.delete waits this long for live writers before it answers (tests). Default DELETE_WAIT_MS. */
  deleteWaitMs?: number;
  /** html step deadline (tests). Default HTML_STEP_DEADLINE_MS. */
  htmlDeadlineMs?: number;
  /** KaTeX budget of the structure step in ms (tests inject 0). */
  katexBudgetMs?: number;
  /** Work units of the anchor step (tests inject 0). */
  anchorWork?: number;
  /**
   * Fault injection (tests). 'publish.after' (awaited) runs between the v2 file publication and T_struct;
   * 'tstruct.begin' / 'tstruct.job' run synchronously INSIDE T_struct (before the abort / job checks — a hook may change
   * rows on deps.sqlite there, it is the same transaction) and 'tstruct.finish' (upgrade) right before the job's success
   * terminal inside it; 'tstruct.committed' runs right after T_struct committed (throw = a crash point); 'terminal' runs
   * inside every failure-terminal transaction (throw = the write fails); 'structure.parsed' (after the parse, before
   * KaTeX) and 'anchor.run' (inside the anchor computation) are where an unexpected exception of those steps is
   * simulated.
   */
  inject?: (point: InjectPoint, jobId: string) => void | Promise<void>;
  /** arXiv cooldown persistence; default the settings table of the app DB, null = memory only (tests). */
  cooldownStore?: CooldownStore | null;
}

export type InjectPoint = 'publish.after' | 'tstruct.begin' | 'tstruct.job' | 'tstruct.finish' | 'tstruct.committed' | 'terminal' | 'structure.parsed' | 'anchor.run';

/** What the structure steps hand to each other inside one job run (memory only; a retry starts again at html). */
interface RunWork {
  html: string | null;
  htmlFile: { sha256: string; bytes: number } | null;
  parsed: ParsedStructure | null;
  latex: StoredLatex[] | null;
  anchors: AnchorResult | null;
  codeUrl: string | null;
  warnings: IngestWarningCode[];
}

/** A structure failure of an upgrade: the job error code + the warning that settles it for good (null = retryable). */
export class StructureFailure extends IngestError {
  constructor(
    code: JobErrorCode,
    message: string,
    readonly warning: IngestWarningCode | null,
  ) {
    super(code, message);
    this.name = 'StructureFailure';
  }
}

type HtmlOutcome =
  | { kind: 'ok'; html: string }
  | { kind: 'final'; warning: 'html_not_found' | 'html_version_mismatch' | 'structure_too_large' | 'structure_parse_failed'; code: JobErrorCode; message: string }
  | { kind: 'deferred'; code: JobErrorCode; message: string; networkDisabled: boolean };

type AbortReason = 'shutdown' | 'deleted';
export type JobDto = z.infer<typeof JobDtoSchema>;

/** In-memory async queue used to hand events to one subscriber. */
class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  onDetach: (() => void) | null = null;
  push(v: T): void {
    if (this.closed) return;
    this.items.push(v);
    this.wake();
  }
  close(): void {
    this.closed = true;
    this.wake();
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    try {
      for (;;) {
        if (this.items.length > 0) {
          yield this.items.shift()!;
          continue;
        }
        if (this.closed) return;
        await new Promise<void>((r) => (this.waiter = r));
      }
    } finally {
      this.onDetach?.();
    }
  }
}

class JobRun {
  readonly abort = new AbortController();
  readonly listeners = new Set<(e: JobSseEvent) => void>();
  done: Promise<void> = Promise.resolve();
  readonly work: RunWork = { html: null, htmlFile: null, parsed: null, latex: null, anchors: null, codeUrl: null, warnings: [] };
  /** Set when the terminal row and event were written (the upgrade's success terminal lives in T_struct). */
  finished = false;
  constructor(
    readonly id: string,
    readonly paperId: string,
    readonly kind: JobKind,
    readonly steps: JobStep[],
  ) {}
  emit(e: JobSseEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}

const isTerminal = (e: JobSseEvent) => e.event === 'job.done' || e.event === 'job.error';

/**
 * The html_version_mismatch message when the mentions name another version of the paper, or when the list overflowed
 * (more distinct pairs than it keeps — the version cannot be told, so the HTML is not used: M-M2-R2-5); null otherwise.
 */
function versionMismatch(list: MentionList, arxivId: string, version: number): string | null {
  const v = versionVerdict(list, arxivId, version);
  if (v.kind === 'other') return `the HTML is arXiv:${arxivId}v${v.version}, not v${version}`;
  if (v.kind === 'unknown') return `the HTML names more than ${list.mentions.length} distinct arXiv versions — not checked as v${version}`;
  return null;
}

export class IngestService {
  private readonly live = new Map<string, JobRun>();
  readonly queue: HostQueue;
  private source: ArxivSource;
  private readonly now: () => number;
  readonly participant: ShutdownParticipant;

  constructor(
    private readonly deps: AppDeps,
    private opts: IngestOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    if (deps.config.arxivCooldownReset) resetStoredCooldown(deps.sqlite, 'arxiv');
    const store = opts.cooldownStore === undefined ? new SettingsCooldownStore(deps.sqlite) : (opts.cooldownStore ?? undefined);
    this.queue = new HostQueue(this.now, opts.queueSleep, { store });
    this.source = this.makeSource();
    this.participant = {
      name: 'ingest-jobs',
      active: () => this.live.size,
      drain: async () => {
        const runs = [...this.live.values()];
        for (const r of runs) r.abort.abort('shutdown' satisfies AbortReason);
        await Promise.all(runs.map((r) => r.done));
      },
    };
  }

  /** Test hook: replace options (source, fetch, limits) of a running service. */
  setOptions(opts: IngestOptions): void {
    this.opts = { ...this.opts, ...opts };
    this.source = this.makeSource();
  }

  get sourceKind(): ArxivSource['kind'] {
    return this.source.kind;
  }

  private makeSource(): ArxivSource {
    if (this.opts.source) return this.opts.source;
    const offlineDir = this.opts.offlineDir !== undefined ? this.opts.offlineDir : (process.env.SP_ARXIV_OFFLINE_DIR ?? null);
    if (offlineDir && this.deps.config.env !== 'prod') return new OfflineArxivSource(offlineDir);
    return new NetworkArxivSource({ queue: this.queue, cache: new HttpCache(this.deps.sqlite, this.now), fetchImpl: this.opts.fetchImpl, retry: { now: this.now, ...this.opts.arxivRetry } });
  }

  findReferences(query: ReferenceSearchRequest, signal: AbortSignal) {
    return findReferences(query, { queue: this.queue, fetchImpl: this.opts.fetchImpl, signal });
  }

  activeJobs(): number {
    return this.live.size;
  }

  /** The live job of the paper among `kinds` (ingest kinds unless given), or null. */
  liveJobForPaper(paperId: string, kinds: readonly JobKind[] = INGEST_KINDS): string | null {
    for (const r of this.live.values()) if (r.paperId === paperId && kinds.includes(r.kind)) return r.id;
    return null;
  }

  /** Resolves when the job (if live) has written its terminal row. */
  whenDone(jobId: string): Promise<void> {
    return this.live.get(jobId)?.done ?? Promise.resolve();
  }

  // ------------------------------------------------------------------------------------------------
  // papers.import

  importArxiv(input: string): ImportPaperResponse {
    const ref = parseArxivInput(input);
    if (!ref) throw new HttpError(400, 'validation', 'not an arXiv id or arxiv.org URL (e.g. 2209.15397, 2209.15397v2, cs/0112017, https://arxiv.org/abs/2209.15397)');
    if (this.deps.lifecycle.stopping) throw new HttpError(409, 'conflict', 'the server is shutting down');
    const { db, sqlite } = this.deps;

    const existingResponse = (row: typeof papers.$inferSelect): ImportPaperResponse => {
      if (row.deletingAt !== null) throw new HttpError(409, 'conflict', 'this paper is being deleted; import it again afterwards');
      const liveJob = this.liveJobForPaper(row.id, INGEST_KINDS);
      const sameVersion = ref.version === undefined || (row.arxivVersion !== null && row.arxivVersion === ref.version);
      if (liveJob && sameVersion) return { paperId: row.id, jobId: liveJob, existing: false };
      const res: ImportPaperResponse = { paperId: row.id, jobId: liveJob, existing: true };
      if (row.arxivVersion !== null) res.existingVersion = row.arxivVersion;
      if (ref.version !== undefined) res.requestedVersion = ref.version;
      return res;
    };

    const found = db.select().from(papers).where(eq(papers.arxivId, ref.id)).get();
    if (found) return existingResponse(found);

    const now = this.now();
    const paperId = randomUUID();
    const jobId = randomUUID();
    const steps: JobStep[] = [{ step: 'resolve', status: 'ok', detail: ref.version === undefined ? `${ref.id} (latest)` : `${ref.id}v${ref.version}` }];
    try {
      sqlite.transaction(() => {
        db.insert(papers)
          .values({ id: paperId, source: 'arxiv', arxivId: ref.id, arxivVersion: ref.version ?? null, title: `arXiv:${ref.id}`, ingestStatus: 'running', createdAt: now, updatedAt: now })
          .run();
        db.insert(jobs).values({ id: jobId, kind: 'import_arxiv', paperId, status: 'running', stepsJson: JSON.stringify(steps), createdAt: now, updatedAt: now }).run();
      })();
    } catch (e) {
      // Lost a race on papers.arxivId UNIQUE (another process/connection): answer with the winner, never 500.
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const winner = db.select().from(papers).where(eq(papers.arxivId, ref.id)).get();
        if (winner) return existingResponse(winner);
      }
      throw e;
    }
    this.start(new JobRun(jobId, paperId, 'import_arxiv', steps), ref.version);
    return { paperId, jobId, existing: false };
  }

  // ------------------------------------------------------------------------------------------------
  // papers.retryIngest: only while structureReadyAt is null, from the first step that is not done.

  retry(paperId: string): { jobId: string } {
    const { db, sqlite } = this.deps;
    const row = db.select().from(papers).where(eq(papers.id, paperId)).get();
    if (!row || row.deletingAt !== null) throw notFound('paper');
    if (this.liveJobForPaper(paperId, UPGRADE_KINDS)) throw new HttpError(409, 'conflict', 'a structure upgrade of this paper is running');
    if (row.structureReadyAt !== null) throw new HttpError(409, 'conflict', 'the paper is already ingested; delete and import it again to start over');
    if (row.source !== 'arxiv' || !row.arxivId) throw new HttpError(409, 'conflict', 'only arXiv imports can be retried');
    const liveJob = this.liveJobForPaper(paperId, INGEST_KINDS);
    if (liveJob) return { jobId: liveJob };
    if (this.deps.lifecycle.stopping) throw new HttpError(409, 'conflict', 'the server is shutting down');

    const prev = latestJob(this.deps, paperId);
    const prevOk = new Set((prev?.steps ?? []).filter((s: JobStep) => s.status === 'ok' || s.status === 'skipped').map((s: JobStep) => s.step));
    const pdfPath = join(this.deps.paths.paperDir(paperId), PDF_FILE);
    // html … supplement: done once the supplement is published (contextReadyAt) — they run again together otherwise.
    const contextDone = row.contextReadyAt !== null;
    const done: Record<IngestStep, boolean> = {
      resolve: true,
      metadata: prevOk.has('metadata') && row.arxivVersion !== null,
      pdf: prevOk.has('pdf') && row.pdfSha256 !== null && existsSync(pdfPath),
      text: row.readableAt !== null,
      html: contextDone,
      structure: contextDone,
      anchor: contextDone,
      supplement: false,
    };
    // Once a step is not done, every later step runs again.
    let redo = false;
    const steps: JobStep[] = [];
    for (const s of INGEST_STEPS) {
      redo ||= !done[s];
      if (!redo) steps.push({ step: s, status: 'skipped', detail: 'done in an earlier job' });
    }
    const now = this.now();
    const jobId = randomUUID();
    sqlite.transaction(() => {
      db.insert(jobs).values({ id: jobId, kind: 'retry_ingest', paperId, status: 'running', stepsJson: JSON.stringify(steps), createdAt: now, updatedAt: now }).run();
      db.update(papers).set({ ingestStatus: 'running', updatedAt: now }).where(eq(papers.id, paperId)).run();
    })();
    this.start(new JobRun(jobId, paperId, 'retry_ingest', steps), row.arxivVersion ?? undefined);
    return { jobId };
  }

  // ------------------------------------------------------------------------------------------------
  // papers.upgradeStructure (PLAN_M2 3.1, D3): user-started html → structure → anchor → supplement v2 of an M1 paper.

  upgradeStructure(paperId: string): { jobId: string } {
    const { db } = this.deps;
    const row = db.select().from(papers).where(eq(papers.id, paperId)).get();
    if (!row || row.deletingAt !== null) throw notFound('paper');
    const running = this.liveJobForPaper(paperId, UPGRADE_KINDS);
    if (running) return { jobId: running };
    if (this.liveJobForPaper(paperId, INGEST_KINDS)) throw new HttpError(409, 'conflict', 'the paper is being ingested; upgrade it after the import has finished');
    if (this.deps.lifecycle.stopping) throw new HttpError(409, 'conflict', 'the server is shutting down');
    const state = structureUpgradeState(row, null);
    if (!state.available) throw new HttpError(409, 'conflict', 'this paper is not a structure upgrade target');
    if (!row.arxivId || row.arxivVersion === null) throw new HttpError(409, 'conflict', 'the paper has no arXiv version');
    const now = this.now();
    const jobId = randomUUID();
    db.insert(jobs).values({ id: jobId, kind: 'upgrade_structure', paperId, status: 'running', stepsJson: '[]', createdAt: now, updatedAt: now }).run();
    this.start(new JobRun(jobId, paperId, 'upgrade_structure', []), row.arxivVersion);
    return { jobId };
  }

  // ------------------------------------------------------------------------------------------------
  // papers.delete: abort the paper's live jobs and wait (bounded) until their terminal rows are written.

  async cancelPaper(paperId: string, timeoutMs = DELETE_WAIT_MS): Promise<boolean> {
    const ended = this.abortPaper(paperId);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
    const ok = await Promise.race([ended.then(() => true), timeout]);
    clearTimeout(timer);
    return ok;
  }

  /**
   * Aborts the paper's live jobs ('deleted'); resolves once every one of them has stopped (terminal row written,
   * no file write left). Writers re-check the abort right before publishing into papers/<id>/ (M1.1 M6).
   */
  abortPaper(paperId: string): Promise<void> {
    const runs = [...this.live.values()].filter((r) => r.paperId === paperId);
    for (const r of runs) r.abort.abort('deleted' satisfies AbortReason);
    return Promise.all(runs.map((r) => r.done)).then(() => undefined);
  }

  get deleteWaitMs(): number {
    return this.opts.deleteWaitMs ?? DELETE_WAIT_MS;
  }

  // ------------------------------------------------------------------------------------------------
  // jobs.events

  /** Live run of a job, or null. */
  liveRun(jobId: string): JobRun | null {
    return this.live.get(jobId) ?? null;
  }

  // ------------------------------------------------------------------------------------------------
  // Runner

  private start(run: JobRun, requestedVersion: number | undefined): void {
    this.live.set(run.id, run);
    run.done = this.execute(run, requestedVersion).finally(() => {
      this.live.delete(run.id);
    });
  }

  private writeSteps(run: JobRun, extra?: () => void): void {
    const now = this.now();
    this.deps.sqlite.transaction(() => {
      extra?.();
      this.deps.db.update(jobs).set({ stepsJson: JSON.stringify(run.steps), updatedAt: now }).where(eq(jobs.id, run.id)).run();
    })();
  }

  private setStep(run: JobRun, step: JobStepName, status: JobStepStatus, detail?: string, extra?: () => void): void {
    const entry: JobStep = detail === undefined ? { step, status } : { step, status, detail: detail.slice(0, 500) };
    const i = run.steps.findIndex((s) => s.step === step);
    if (i >= 0) run.steps[i] = entry;
    else run.steps.push(entry);
    this.writeSteps(run, extra);
    run.emit({ event: 'job.step', data: entry });
  }

  private emitState(run: JobRun, state: PaperReadiness): void {
    run.emit({ event: 'job.state', data: { state } });
  }

  private checkAbort(run: JobRun): void {
    if (!run.abort.signal.aborted) return;
    throw run.abort.signal.reason === 'deleted' ? new IngestError('cancelled', 'the paper was deleted') : new IngestError('interrupted', 'the server is shutting down');
  }

  private paper(run: JobRun) {
    const row = this.deps.db.select().from(papers).where(and(eq(papers.id, run.paperId), isNull(papers.deletingAt))).get();
    if (!row) throw new IngestError('cancelled', 'the paper was deleted');
    return row;
  }

  private async execute(run: JobRun, requestedVersion: number | undefined): Promise<void> {
    const skip = new Set(run.steps.filter((s) => s.status === 'skipped' || s.status === 'ok').map((s) => s.step));
    const upgrade = run.kind === 'upgrade_structure';
    let current: IngestStep | null = null;
    try {
      // Let the HTTP response go out before the first step (and keep import synchronous for idempotency).
      await Promise.resolve();
      for (const step of upgrade ? UPGRADE_STEPS : INGEST_STEPS) {
        if (skip.has(step)) continue;
        current = step;
        this.checkAbort(run);
        await this.opts.beforeStep?.(step, run.id, run.abort.signal);
        this.checkAbort(run);
        this.setStep(run, step, 'running');
        if (step === 'metadata') await this.stepMetadata(run, requestedVersion);
        else if (step === 'pdf') await this.stepPdf(run);
        else if (step === 'text') await this.stepText(run);
        else if (step === 'html') await this.stepHtml(run);
        else if (step === 'structure') await this.stepStructure(run);
        else if (step === 'anchor') await this.stepAnchor(run);
        else if (step === 'supplement') await (upgrade ? this.stepUpgradeSupplement(run) : this.stepSupplement(run));
      }
      current = null;
      if (run.finished) return; // the upgrade's success terminal was written in T_struct
      if (upgrade) throw new IngestError('internal', 'the upgrade ended without publishing a structure');
    } catch (e) {
      let err = toIngestError(e);
      // A fetch/extract cancelled by our own abort reports the abort reason.
      if (run.abort.signal.aborted && (err.code === 'cancelled' || err.code === 'interrupted')) {
        err = run.abort.signal.reason === 'deleted' ? new IngestError('cancelled', 'the paper was deleted') : new IngestError('interrupted', 'the server is shutting down');
      }
      this.finish(run, err, current);
      return;
    }
    this.finish(run, null);
  }

  /**
   * Terminal transaction (job status, paper ingestStatus, failed step; on success also structure_ready) + exactly
   * one terminal event. job.done is emitted only after that transaction committed (M1.1 B3): when it throws
   * (disk full, I/O error) or the job row is gone, the job ends with job.error instead, and a second, smaller
   * write tries to leave the row terminal ('failed') with structureReadyAt still null, so papers.retryIngest can
   * run again. If even that write fails the row stays 'running' without a runner: jobs.events reports it as
   * interrupted, retry is allowed, and startup recovery marks it interrupted.
   */
  private finish(run: JobRun, err: IngestError | null, failedStep: IngestStep | null = null): void {
    if (run.kind === 'upgrade_structure') {
      this.finishUpgrade(run, err ?? new IngestError('internal', 'the upgrade ended without a result'), failedStep);
      return;
    }
    const now = this.now();
    const { db } = this.deps;
    const markFailedStep = (e: IngestError, step: IngestStep | null) => {
      if (!step) return;
      const i = run.steps.findIndex((s) => s.step === step);
      const entry: JobStep = { step, status: 'error', detail: e.message.slice(0, 500) };
      if (i >= 0) run.steps[i] = entry;
      else run.steps.push(entry);
    };
    if (err === null && run.abort.signal.aborted) err = run.abort.signal.reason === 'deleted' ? new IngestError('cancelled', 'the paper was deleted') : new IngestError('interrupted', 'the server is shutting down');
    const statusOf = (e: IngestError | null) => (e === null ? 'done' : e.code === 'interrupted' ? 'interrupted' : 'failed');
    if (err) markFailedStep(err, failedStep);
    let committed = false;
    try {
      const jobStatus = statusOf(err);
      this.deps.sqlite.transaction(() => {
        void this.opts.inject?.('terminal', run.id);
        const r = db
          .update(jobs)
          .set({ status: jobStatus, stepsJson: JSON.stringify(run.steps), error: err ? formatJobError(err) : null, updatedAt: now })
          .where(eq(jobs.id, run.id))
          .run();
        if (r.changes === 0 && err === null) throw new IngestError('cancelled', 'the paper was deleted');
        // Ingest kinds never write structureSource (T_struct / the v1 publication decided it, A5); COALESCE only fills
        // a NULL left by an M1 job whose terminal write failed after its supplement.
        db.update(papers)
          .set(err === null ? { ingestStatus: jobStatus, structureSource: sql`COALESCE(${papers.structureSource}, 'none')`, structureReadyAt: now, updatedAt: now } : { ingestStatus: jobStatus, updatedAt: now })
          .where(eq(papers.id, run.paperId))
          .run();
      })();
      committed = true;
    } catch (e) {
      console.error(`[ingest] job ${run.id}: terminal write failed: ${(e as Error).message}`);
      if (err === null) {
        err = e instanceof IngestError && e.code === 'cancelled' ? e : new IngestError('internal', `could not save the job result (${(e as Error).message}); retry the import`);
        // No step failed (every step's own write committed); only the terminal write did: no job.step error.
      }
    }
    if (!committed) {
      // Second chance: a terminal, retryable row. Failing here too leaves the row 'running' (see above).
      const fallback = err!;
      try {
        this.deps.sqlite.transaction(() => {
          void this.opts.inject?.('terminal', run.id);
          db.update(jobs)
            .set({ status: statusOf(fallback), stepsJson: JSON.stringify(run.steps), error: formatJobError(fallback), updatedAt: now })
            .where(eq(jobs.id, run.id))
            .run();
          db.update(papers).set({ ingestStatus: statusOf(fallback), updatedAt: now }).where(eq(papers.id, run.paperId)).run();
        })();
      } catch (e) {
        console.error(`[ingest] job ${run.id}: fallback terminal write failed too (the row stays running until retry or restart): ${(e as Error).message}`);
      }
    }
    if (err && failedStep) run.emit({ event: 'job.step', data: { step: failedStep, status: 'error', detail: err.message.slice(0, 500) } });
    if (err === null) this.emitState(run, 'structure_ready');
    run.emit(err ? { event: 'job.error', data: { code: err.code, message: err.message } } : { event: 'job.done', data: { paperId: run.paperId } });
    run.finished = true;
    this.live.delete(run.id);
  }

  /**
   * Failure / interruption terminal of an upgrade (its success terminal is in T_struct): the jobs row (WHERE status
   * 'running') and — for a failure that settles "no structure" for good — the warning on the paper, in one
   * transaction. Never ingestStatus or the readiness timestamps. When the row is no longer 'running' (T_struct already
   * committed 'done' right before a crash point) nothing is written and the stored outcome is reported. A failed
   * write falls back to the jobs row alone; if that fails too the row stays 'running' (startup recovery → interrupted).
   */
  private finishUpgrade(run: JobRun, errIn: IngestError, failedStep: IngestStep | null): void {
    const now = this.now();
    const { db, sqlite } = this.deps;
    let err = errIn;
    if (run.abort.signal.aborted && (err.code === 'cancelled' || err.code === 'interrupted')) {
      err = run.abort.signal.reason === 'deleted' ? new IngestError('cancelled', 'the paper was deleted') : new IngestError('interrupted', 'the server is shutting down');
    }
    if (failedStep) {
      const i = run.steps.findIndex((s) => s.step === failedStep);
      const entry: JobStep = { step: failedStep, status: 'error', detail: err.message.slice(0, 500) };
      if (i >= 0) run.steps[i] = entry;
      else run.steps.push(entry);
    }
    const status = err.code === 'interrupted' ? 'interrupted' : 'failed';
    const warning = err instanceof StructureFailure ? err.warning : null;
    const notRunning = new Error('the job row is not running');
    let written = false;
    try {
      sqlite.transaction(() => {
        void this.opts.inject?.('terminal', run.id);
        const r = db
          .update(jobs)
          .set({ status, stepsJson: JSON.stringify(run.steps), error: formatJobError(err), updatedAt: now })
          .where(and(eq(jobs.id, run.id), eq(jobs.status, 'running')))
          .run();
        if (r.changes !== 1) throw notRunning;
        if (warning) {
          const cur = db.select({ w: papers.ingestWarningsJson }).from(papers).where(eq(papers.id, run.paperId)).get();
          if (cur) db.update(papers).set({ ingestWarningsJson: mergeWarnings(cur.w, [warning]), updatedAt: now }).where(and(eq(papers.id, run.paperId), isNull(papers.deletingAt))).run();
        }
      })();
      written = true;
    } catch (e) {
      if (e === notRunning) {
        // Already terminal (T_struct committed 'done' before a crash point): report what is stored, once.
        const row = db.select().from(jobs).where(eq(jobs.id, run.id)).get();
        if (row) {
          if (row.status === 'done') run.emit({ event: 'job.step', data: { step: 'supplement', status: 'ok' } });
          run.emit(terminalOf(row));
        } else run.emit({ event: 'job.error', data: { code: 'cancelled', message: 'the paper was deleted' } });
        run.finished = true;
        this.live.delete(run.id);
        return;
      }
      console.error(`[ingest] upgrade job ${run.id}: terminal write failed: ${(e as Error).message}`);
    }
    if (!written) {
      try {
        sqlite.transaction(() => {
          void this.opts.inject?.('terminal', run.id);
          db.update(jobs)
            .set({ status, stepsJson: JSON.stringify(run.steps), error: formatJobError(err), updatedAt: now })
            .where(and(eq(jobs.id, run.id), eq(jobs.status, 'running')))
            .run();
        })();
      } catch (e) {
        console.error(`[ingest] upgrade job ${run.id}: fallback terminal write failed too (the row stays running until restart): ${(e as Error).message}`);
      }
    }
    if (failedStep) run.emit({ event: 'job.step', data: { step: failedStep, status: 'error', detail: err.message.slice(0, 500) } });
    run.emit({ event: 'job.error', data: { code: err.code, message: err.message } });
    run.finished = true;
    this.live.delete(run.id);
  }

  /** While a source waits to retry arXiv, the step stays 'running' with a Korean detail (job.step event + stored). */
  private retryHooks(run: JobRun, step: IngestStep): ArxivCallHooks {
    return {
      onRetry: (n) => {
        if (run.abort.signal.aborted) return;
        this.setStep(run, step, 'running', retryDetail(n));
      },
    };
  }

  private async stepMetadata(run: JobRun, requestedVersion: number | undefined): Promise<void> {
    const p = this.paper(run);
    const { meta, requests } = await this.source.metadata(p.arxivId!, requestedVersion, run.abort.signal, this.retryHooks(run, 'metadata'));
    this.checkAbort(run);
    const year = meta.publishedAt !== null ? new Date(meta.publishedAt).getUTCFullYear() : null;
    const detail = `${meta.id}v${meta.version}${requests === 0 ? ` (${this.source.kind === 'offline' ? 'offline' : 'cache'})` : ''}`;
    this.setStep(run, 'metadata', 'ok', detail, () => {
      this.deps.db
        .update(papers)
        .set({
          arxivVersion: meta.version,
          title: meta.title,
          authorsJson: JSON.stringify(meta.authors),
          abstract: meta.abstract,
          year,
          publishedAt: meta.publishedAt,
          primaryCategory: meta.primaryCategory,
          doi: meta.doi,
          venue: meta.journalRef,
          updatedAt: this.now(),
        })
        .where(eq(papers.id, run.paperId))
        .run();
    });
  }

  private async stepPdf(run: JobRun): Promise<void> {
    const p = this.paper(run);
    if (p.arxivVersion === null) throw new IngestError('internal', 'metadata step did not record a version');
    const dest = join(this.deps.paths.paperDir(run.paperId), PDF_FILE);
    const written = await this.source.pdf(
      p.arxivId!,
      p.arxivVersion,
      (chunks) =>
        writeAtomic({ tmpDir: this.deps.paths.tmpDir, dest, chunks, maxBytes: BYTE_LIMITS.pdf, magic: PDF_MAGIC, expectedSha256: p.pdfSha256, signal: run.abort.signal, openFile: this.opts.openFile }),
      run.abort.signal,
      this.retryHooks(run, 'pdf'),
    );
    this.checkAbort(run);
    this.setStep(run, 'pdf', 'ok', `${written.bytes} bytes`, () => {
      recordFile(this.deps.db, { paperId: run.paperId, kind: 'pdf', relPath: `papers/${run.paperId}/${PDF_FILE}`, sha256: written.sha256, bytes: written.bytes, mime: 'application/pdf' }, this.now());
      this.deps.db.update(papers).set({ pdfSha256: written.sha256, updatedAt: this.now() }).where(eq(papers.id, run.paperId)).run();
    });
  }

  private async stepText(run: JobRun): Promise<void> {
    const p = this.paper(run);
    const file = join(this.deps.paths.paperDir(run.paperId), PDF_FILE);
    if (!existsSync(file)) throw new IngestError('invalid_pdf', 'paper.pdf is missing');
    const data = readFileSync(file);
    if (p.pdfSha256 && sha256Hex(data) !== p.pdfSha256) throw new IngestError('invalid_pdf', 'paper.pdf does not match the recorded sha256');
    const extracted = await extractPageTexts(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), { ...this.opts.text, signal: run.abort.signal });
    this.checkAbort(run);
    const now = this.now();
    this.setStep(run, 'text', 'ok', `${extracted.pageCount} pages`, () => {
      const { db } = this.deps;
      db.delete(pageTexts).where(eq(pageTexts.paperId, run.paperId)).run();
      for (const pg of extracted.pages) {
        db.insert(pageTexts).values({ paperId: run.paperId, page: pg.page, text: pg.text, itemsJson: JSON.stringify(pg.items), pdfjsVersion: PDFJS_VERSION }).run();
      }
      db.update(papers).set({ pageCount: extracted.pageCount, readableAt: now, updatedAt: now }).where(eq(papers.id, run.paperId)).run();
    });
    this.emitState(run, 'readable');
  }

  // ------------------------------------------------------------------------------------------------
  // html → structure → anchor (shared by ingest and upgrade jobs). An ingest job turns every failure into a step
  // skipped/warn + warning and continues with v1; an upgrade job fails (StructureFailure: final failures carry the
  // warning that removes the upgrade button, transient ones none).

  private failOrWarn(run: JobRun, step: IngestStep, status: 'skipped' | 'warn', warning: IngestWarningCode, code: JobErrorCode, message: string): void {
    if (run.kind === 'upgrade_structure') throw new StructureFailure(code, message, warning);
    if (!run.work.warnings.includes(warning)) run.work.warnings.push(warning);
    this.setStep(run, step, status, `${warning}: ${message}`);
  }

  /**
   * The structure of this HTML failed for good: source.html (written by the html step, no files row points at it — it
   * is recorded only in T_struct) is moved to tmp/ and removed, so no file without a row stays in the paper directory.
   */
  private discardUnrecordedHtml(run: JobRun): void {
    run.work.htmlFile = null;
    const row = this.deps.db.select({ id: files.id }).from(files).where(and(eq(files.paperId, run.paperId), eq(files.kind, 'html'))).get();
    if (row) return;
    const dest = this.deps.paths.sourceHtmlFile(run.paperId);
    if (!existsSync(dest)) return;
    try {
      const aside = join(this.deps.paths.tmpDir, `${randomUUID()}.stale-html`);
      renameSync(dest, aside);
      rmSync(aside, { force: true });
    } catch (e) {
      console.warn(`[ingest] ${run.paperId}: could not remove the unused source.html (${(e as Error).message})`);
    }
  }

  /** Fetches and validates the HTML (no state change). */
  private async fetchHtml(run: JobRun, arxivId: string, version: number): Promise<HtmlOutcome> {
    const deadline = this.now() + (this.opts.htmlDeadlineMs ?? HTML_STEP_DEADLINE_MS);
    let html: string;
    try {
      html = await this.source.html(arxivId, version, run.abort.signal, this.retryHooks(run, 'html'), { deadline });
    } catch (e) {
      if (run.abort.signal.aborted) throw e;
      // The guard's refusal is told apart ONLY by isNetworkDisabled (a real blocked URL has the same code).
      if (isNetworkDisabled(e)) return { kind: 'deferred', code: 'blocked_url', message: 'network_disabled', networkDisabled: true };
      const err = toIngestError(e);
      if (err.code === 'not_found') return { kind: 'final', warning: 'html_not_found', code: 'not_found', message: `arXiv has no HTML for ${arxivId}v${version}` };
      if (err.code === 'too_large') return { kind: 'final', warning: 'structure_too_large', code: 'too_large', message: err.message };
      return { kind: 'deferred', code: err.code === 'timeout' || err.code === 'blocked_url' || err.code === 'network' ? err.code : 'internal', message: err.message, networkDisabled: false };
    }
    if (Buffer.byteLength(html, 'utf8') > BYTE_LIMITS.html) return { kind: 'final', warning: 'structure_too_large', code: 'too_large', message: `HTML exceeds ${BYTE_LIMITS.html} bytes` };
    if (!/<html[\s>]/i.test(html)) return { kind: 'final', warning: 'structure_parse_failed', code: 'internal', message: 'the response is not an HTML document' };
    // The same id with another version in the text → another version's HTML: never used (no mention → accepted).
    const mismatch = versionMismatch(arxivMentions(html), arxivId, version);
    if (mismatch !== null) return { kind: 'final', warning: 'html_version_mismatch', code: 'version_mismatch', message: mismatch };
    return { kind: 'ok', html };
  }

  private async stepHtml(run: JobRun): Promise<void> {
    const p = this.paper(run);
    if (!p.arxivId || p.arxivVersion === null) throw new IngestError('internal', 'html needs the arXiv id and version');
    const out = await this.fetchHtml(run, p.arxivId, p.arxivVersion);
    this.checkAbort(run);
    if (out.kind === 'deferred') {
      if (run.kind === 'upgrade_structure') throw new IngestError(out.code, out.networkDisabled ? 'network_disabled: outbound network access is off (SP_NETWORK=off)' : out.message);
      if (!run.work.warnings.includes('html_deferred')) run.work.warnings.push('html_deferred');
      this.setStep(run, 'html', 'warn', out.networkDisabled ? 'html_deferred: network_disabled' : `html_deferred: ${out.message}`);
      return;
    }
    if (out.kind === 'final') {
      this.failOrWarn(run, 'html', out.warning === 'html_not_found' ? 'skipped' : 'warn', out.warning, out.code, out.message);
      return;
    }
    // A source.html the DB already points at is never replaced.
    const row = this.deps.db.select({ id: files.id }).from(files).where(and(eq(files.paperId, run.paperId), eq(files.kind, 'html'))).get();
    if (row) throw new IngestError('internal', 'the paper already has a recorded source.html');
    const data = Buffer.from(out.html, 'utf8');
    const written = await writeAtomic({
      tmpDir: this.deps.paths.tmpDir,
      dest: this.deps.paths.sourceHtmlFile(run.paperId),
      chunks: (async function* () {
        yield new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      })(),
      maxBytes: BYTE_LIMITS.html,
      signal: run.abort.signal,
    });
    this.checkAbort(run);
    run.work.html = out.html;
    run.work.htmlFile = written;
    this.setStep(run, 'html', 'ok', `${written.bytes} bytes${this.source.kind === 'offline' ? ' (offline)' : ''}`);
  }

  private async stepStructure(run: JobRun): Promise<void> {
    const html = run.work.html;
    if (html === null) {
      this.setStep(run, 'structure', 'skipped', 'no HTML');
      return;
    }
    run.work.html = null; // the parse result is all the later steps need
    const r = await parseStructure(html, run.abort.signal);
    this.checkAbort(run);
    if (!r.ok) {
      this.discardUnrecordedHtml(run);
      this.failOrWarn(run, 'structure', 'warn', r.warning, r.warning === 'structure_too_large' ? 'too_large' : 'internal', r.message);
      return;
    }
    const parsed = r.structure;
    // The text the parser built names another version (written with an entity, split by an inline element — what the
    // html step's raw scan cannot see, M-M2-R2-5) → the end of the html step's check: no structure, the HTML file
    // dropped, v1 for an import, a final failure with html_version_mismatch for an upgrade.
    const p = this.paper(run);
    if (!p.arxivId || p.arxivVersion === null) throw new IngestError('internal', 'structure needs the arXiv id and version');
    const mismatch = versionMismatch(parsed.textMentions, p.arxivId, p.arxivVersion);
    if (mismatch !== null) {
      this.discardUnrecordedHtml(run);
      this.failOrWarn(run, 'structure', 'warn', 'html_version_mismatch', 'version_mismatch', `${mismatch} (in the parsed text)`);
      return;
    }
    let checked: Awaited<ReturnType<typeof prepareStoredEquations>>;
    try {
      await this.opts.inject?.('structure.parsed', run.id);
      checked = await prepareStoredEquations(
        parsed.equations,
        { ...(this.opts.katexBudgetMs !== undefined ? { budgetMs: this.opts.katexBudgetMs } : {}), signal: run.abort.signal },
      );
    } catch (e) {
      // An import never fails here (the same HTML gives the same exception → settled: structure_parse_failed, v1).
      if (run.abort.signal.aborted || run.kind === 'upgrade_structure') throw e;
      this.discardUnrecordedHtml(run);
      this.failOrWarn(run, 'structure', 'warn', 'structure_parse_failed', 'internal', `structure processing failed: ${(e as Error).message}`);
      return;
    }
    this.checkAbort(run);
    const { latex, budgetExceeded } = checked;
    for (const w of parsed.warnings) if (!run.work.warnings.includes(w)) run.work.warnings.push(w);
    if (budgetExceeded && !run.work.warnings.includes('katex_budget')) run.work.warnings.push('katex_budget');
    run.work.parsed = parsed;
    run.work.latex = latex;
    run.work.codeUrl = parsed.codeUrl;
    const numbered = parsed.equations.filter((e) => e.number !== null).length;
    const okNumbered = parsed.equations.filter((e, i) => e.number !== null && latex[i]!.katexOk).length;
    const notes = [...parsed.warnings, ...(budgetExceeded ? ['katex_budget'] : [])];
    this.setStep(
      run,
      'structure',
      notes.length > 0 ? 'warn' : 'ok',
      `${parsed.sections.length} sections, ${numbered} numbered equations (KaTeX ${okNumbered}/${numbered}), ${parsed.figures.length} figures, ${parsed.references.length} references${notes.length ? ` — ${notes.join(', ')}` : ''}`,
    );
  }

  private async stepAnchor(run: JobRun): Promise<void> {
    const parsed = run.work.parsed;
    if (!parsed) {
      this.setStep(run, 'anchor', 'skipped', 'no structure');
      return;
    }
    const rows = this.deps.db.select({ page: pageTexts.page, text: pageTexts.text, itemsJson: pageTexts.itemsJson }).from(pageTexts).where(eq(pageTexts.paperId, run.paperId)).orderBy(asc(pageTexts.page)).all();
    // items are parsed only for a page where a position was settled (the rect lookup), once — not all pages up front.
    const pages: AnchorPage[] = rows.map((r) => {
      let items: AnchorPage['items'] | null = null;
      return {
        page: r.page,
        text: r.text,
        get items() {
          if (items === null) {
            items = [];
            try {
              const v = JSON.parse(r.itemsJson) as unknown;
              if (Array.isArray(v)) items = v as AnchorPage['items'];
            } catch {
              items = [];
            }
          }
          return items;
        },
      };
    });
    let a: AnchorResult;
    try {
      await this.opts.inject?.('anchor.run', run.id);
      a = await anchorStructure(parsed.sections, parsed.equations, parsed.figures, pages, { ...(this.opts.anchorWork !== undefined ? { work: this.opts.anchorWork } : {}), signal: run.abort.signal });
    } catch (e) {
      // An import keeps its structure with every position unknown (v2 still published); an upgrade stays retryable.
      if (run.abort.signal.aborted || run.kind === 'upgrade_structure') throw e;
      run.work.anchors = null;
      if (!run.work.warnings.includes('anchor_failed')) run.work.warnings.push('anchor_failed');
      this.setStep(run, 'anchor', 'warn', `anchor_failed: ${(e as Error).message} — every position null`);
      return;
    }
    this.checkAbort(run);
    run.work.anchors = a;
    if (a.budgetExhausted && !run.work.warnings.includes('anchor_budget')) run.work.warnings.push('anchor_budget');
    const numbered = parsed.equations.filter((e) => e.number !== null).length;
    const eqOk = a.equations.filter((x, i) => x !== null && parsed.equations[i]!.number !== null).length;
    const stages = (['s1', 's2', 's3'] as const).map((st) => `${st} ${a.equationStages.filter((x) => x === st).length}`).join(', ');
    this.setStep(
      run,
      'anchor',
      a.budgetExhausted ? 'warn' : 'ok',
      `sections ${a.sections.filter((x) => x !== null).length}/${parsed.sections.length}, equations ${eqOk}/${numbered} (${stages}), figures ${a.figures.filter((x) => x !== null).length}/${parsed.figures.length}${a.budgetExhausted ? ' — anchor_budget' : ''}`,
    );
  }

  private supplementMeta(p: typeof papers.$inferSelect) {
    return { title: p.title, authors: JSON.parse(p.authorsJson) as string[], arxivId: p.arxivId!, arxivVersion: p.arxivVersion!, year: p.year, primaryCategory: p.primaryCategory };
  }

  private async stepSupplement(run: JobRun): Promise<void> {
    const p = this.paper(run);
    const now = this.now();
    if (p.contextReadyAt === null) {
      if (p.arxivVersion === null || p.pageCount === null) throw new IngestError('internal', 'supplement needs metadata and page texts');
      const paperDir = this.deps.paths.paperDir(run.paperId);
      const pdfBytes = statSync(join(paperDir, PDF_FILE)).size;
      const contextMode = contextModeFor(p.pageCount, pdfBytes);
      const w = run.work;
      if (w.parsed && w.latex) {
        // v2: publish the file, then T_struct in the same transaction as the step row (events after the commit).
        const input = buildSupplementInput(w.parsed, w.latex, this.supplementMeta(p));
        this.checkAbort(run); // synchronous from here to the link(2) (M1.1 M6)
        const pub = publishSupplementV2(this.deps, run.paperId, input, run.abort.signal);
        if (pub.truncated && !w.warnings.includes('supplement_truncated')) w.warnings.push('supplement_truncated');
        await this.opts.inject?.('publish.after', run.id);
        this.setStep(run, 'supplement', 'ok', `v2, contextMode=${contextMode}${pub.result === 'identical' ? ' (already published)' : ''}`, () =>
          commitImportStructure(this.deps, {
            paperId: run.paperId,
            jobId: run.id,
            signal: run.abort.signal,
            abortError: () => this.abortError(run),
            parsed: w.parsed!,
            latex: w.latex!,
            anchors: w.anchors,
            supplement: { sha256: pub.sha256, bytes: pub.bytes },
            html: w.htmlFile,
            warnings: w.warnings,
            now,
            contextMode,
            codeUrl: w.codeUrl,
            inject: (pt) => void this.opts.inject?.(pt, run.id),
          }),
        );
        this.opts.inject?.('tstruct.committed', run.id);
        this.emitState(run, 'context_ready');
      } else {
        const text = buildSupplementV1(this.supplementMeta(p));
        this.checkAbort(run); // synchronous from here to the link(2): a deletion cannot interleave (M1.1 M6)
        const pub = publishSupplement(this.deps.paths.tmpDir, paperDir, text);
        if (p.supplementSha256 !== null && p.supplementSha256 !== pub.sha256) throw new IngestError('supplement_exists', 'a different supplement is already recorded');
        this.setStep(run, 'supplement', 'ok', `v${SUPPLEMENT_VERSION}, contextMode=${contextMode}${pub.result === 'identical' ? ' (already published)' : ''}`, () => {
          recordFile(this.deps.db, { paperId: run.paperId, kind: 'supplement', relPath: `papers/${run.paperId}/${SUPPLEMENT_FILE}`, sha256: pub.sha256, bytes: pub.bytes, mime: 'text/plain' }, now);
          const cur = this.deps.db.select({ w: papers.ingestWarningsJson }).from(papers).where(eq(papers.id, run.paperId)).get();
          // No structure: v1 + structureSource 'none' (the M1 publication), with the reason as warnings.
          this.deps.db
            .update(papers)
            .set({ supplementSha256: pub.sha256, supplementVersion: SUPPLEMENT_VERSION, contextMode, contextReadyAt: now, structureSource: 'none', ingestWarningsJson: mergeWarnings(cur?.w ?? null, w.warnings), updatedAt: now })
            .where(eq(papers.id, run.paperId))
            .run();
        });
        this.emitState(run, 'context_ready');
      }
    } else {
      this.setStep(run, 'supplement', 'ok', 'already published');
    }
    // "structure_ready" becomes final in the terminal transaction (finish), so a job whose terminal write fails is not
    // left structure_ready (= not retryable).
    this.checkAbort(run);
  }

  /** Upgrade: publish v2, then T_struct with the job's success terminal; events only after the commit. */
  private async stepUpgradeSupplement(run: JobRun): Promise<void> {
    const p = this.paper(run);
    const w = run.work;
    if (!w.parsed || !w.latex) throw new IngestError('internal', 'no structure to publish');
    if (p.arxivVersion === null) throw new IngestError('internal', 'the paper has no arXiv version');
    const input = buildSupplementInput(w.parsed, w.latex, this.supplementMeta(p));
    this.checkAbort(run);
    const pub = publishSupplementV2(this.deps, run.paperId, input, run.abort.signal);
    if (pub.truncated && !w.warnings.includes('supplement_truncated')) w.warnings.push('supplement_truncated');
    await this.opts.inject?.('publish.after', run.id);
    const entry: JobStep = { step: 'supplement', status: 'ok', detail: `v2${pub.result === 'identical' ? ' (already published)' : ''}` };
    const i = run.steps.findIndex((s) => s.step === 'supplement');
    if (i >= 0) run.steps[i] = entry;
    else run.steps.push(entry);
    commitUpgradeStructure(this.deps, {
      paperId: run.paperId,
      jobId: run.id,
      signal: run.abort.signal,
      abortError: () => this.abortError(run),
      parsed: w.parsed,
      latex: w.latex,
      anchors: w.anchors,
      supplement: { sha256: pub.sha256, bytes: pub.bytes },
      html: w.htmlFile,
      warnings: w.warnings,
      now: this.now(),
      codeUrl: w.codeUrl,
      finalStepsJson: JSON.stringify(run.steps),
      inject: (pt) => void this.opts.inject?.(pt, run.id),
    });
    this.opts.inject?.('tstruct.committed', run.id);
    run.finished = true;
    run.emit({ event: 'job.step', data: entry });
    run.emit({ event: 'job.done', data: { paperId: run.paperId } });
    this.live.delete(run.id);
  }

  private abortError(run: JobRun): IngestError {
    return run.abort.signal.reason === 'deleted' ? new IngestError('cancelled', 'the paper was deleted') : new IngestError('interrupted', 'the server is shutting down');
  }
}

/**
 * "arXiv 응답 대기 (HTTP 429) — 30초 뒤 재시도 (2/4회)". `waitMs` is the remaining SHARED cooldown of the host
 * queue, so a job that waits for another job's 429 shows the same remaining time ("… 뒤 요청 (1/4회)").
 */
export function retryDetail(n: { attempt: number; maxAttempts: number; waitMs: number; cause: string }): string {
  const cause = n.cause === 'timeout' ? '응답 없음' : n.cause;
  return `arXiv 응답 대기 (${cause}) — ${Math.ceil(n.waitMs / 1000)}초 뒤 ${n.attempt > 1 ? '재시도' : '요청'} (${n.attempt}/${n.maxAttempts}회)`;
}

// --------------------------------------------------------------------------------------------------
// Jobs as DTOs and event streams (also for jobs that are not live: finished, or from before a restart).

const STEP_STATUSES = new Set<string>(['running', 'ok', 'skipped', 'warn', 'error']);
const STEP_NAMES = new Set<string>(['resolve', 'metadata', 'pdf', 'text', 'html', 'structure', 'anchor', 'supplement', 'enrich']);

export function parseSteps(json: string): JobStep[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((s): s is JobStep => typeof s === 'object' && s !== null && STEP_NAMES.has((s as JobStep).step) && STEP_STATUSES.has((s as JobStep).status))
      .map((s) => (typeof s.detail === 'string' ? { step: s.step, status: s.status, detail: s.detail } : { step: s.step, status: s.status }));
  } catch {
    return [];
  }
}

export function toJobDto(row: typeof jobs.$inferSelect): JobDto {
  return { id: row.id, kind: row.kind, paperId: row.paperId, status: row.status, steps: parseSteps(row.stepsJson), error: row.error };
}

/** Most recent job of a paper among `kinds` (default: ingest kinds — PaperDetailDto.lastJob), or null. */
export function latestJob(deps: Pick<AppDeps, 'db'>, paperId: string, kinds: readonly JobKind[] = INGEST_KINDS): JobDto | null {
  // rowid breaks ties between jobs created in the same millisecond (insertion order; ids are random UUIDs).
  const row = deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.paperId, paperId), inArray(jobs.kind, [...kinds])))
    .orderBy(desc(jobs.createdAt), desc(sql`rowid`))
    .limit(1)
    .all()[0];
  return row ? toJobDto(row) : null;
}

function reachedStates(p: { readableAt: number | null; contextReadyAt: number | null; structureReadyAt: number | null } | undefined): PaperReadiness[] {
  if (!p) return [];
  const out: PaperReadiness[] = [];
  if (p.readableAt !== null) out.push('readable');
  if (p.contextReadyAt !== null) out.push('context_ready');
  if (p.structureReadyAt !== null) out.push('structure_ready');
  return out;
}

function terminalOf(row: typeof jobs.$inferSelect): JobSseEvent {
  if (row.status === 'done') return { event: 'job.done', data: { paperId: row.paperId ?? '' } };
  if (row.status === 'interrupted') {
    const e = parseJobError(row.error);
    return { event: 'job.error', data: { code: 'interrupted', message: row.error ? e.message : 'the server stopped while the job ran; retry the import' } };
  }
  return { event: 'job.error', data: parseJobError(row.error) };
}

/**
 * jobs.events: replays the stored steps (job.step) and the states already reached (job.state), then follows
 * the live job, and ends with exactly one job.done | job.error. The snapshot and the listener are taken in
 * the same synchronous tick (see the header). Returns null for an unknown job.
 */
export function jobEvents(deps: AppDeps, jobId: string): AsyncIterable<JobSseEvent> | null {
  const row = deps.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!row) return null;
  const q = new EventQueue<JobSseEvent>();
  for (const s of parseSteps(row.stepsJson)) q.push({ event: 'job.step', data: s });
  // An upgrade job replays its steps only: the paper's readiness states belong to its ingest job.
  const paper = row.paperId && row.kind !== 'upgrade_structure' ? deps.db.select({ readableAt: papers.readableAt, contextReadyAt: papers.contextReadyAt, structureReadyAt: papers.structureReadyAt }).from(papers).where(eq(papers.id, row.paperId)).get() : undefined;
  for (const state of reachedStates(paper)) q.push({ event: 'job.state', data: { state } });

  const run = row.status === 'running' ? (peekIngest(deps)?.liveRun(jobId) ?? null) : null;
  if (row.status !== 'running') {
    q.push(terminalOf(row));
    q.close();
  } else if (!run) {
    // A 'running' row without a live runner (another process, or recovery has not run): report it as interrupted.
    q.push({ event: 'job.error', data: { code: 'interrupted', message: 'the job is not running in this server; retry the import' } });
    q.close();
  } else {
    const listener = (e: JobSseEvent) => {
      q.push(e);
      if (isTerminal(e)) q.close();
    };
    run.listeners.add(listener);
    q.onDetach = () => run.listeners.delete(listener);
  }
  return q;
}

// --------------------------------------------------------------------------------------------------
// One service per app (AppDeps is created by the supervisor's index.ts / test server; AppDeps has no ingest
// field, so the service lives beside it). Created lazily on the first import/retry: the shutdown participant is
// registered then, so apps that never ingest keep the lifecycle participants they had.

const services = new WeakMap<AppDeps, IngestService>();
const pendingOptions = new WeakMap<AppDeps, IngestOptions>();

export function ingestService(deps: AppDeps): IngestService {
  let s = services.get(deps);
  if (!s) {
    s = new IngestService(deps, pendingOptions.get(deps));
    services.set(deps, s);
    deps.lifecycle.register(s.participant);
  }
  return s;
}

export function peekIngest(deps: AppDeps): IngestService | undefined {
  return services.get(deps);
}

/** Tests / scripts: set options (fetch, source, limits) before or after the service exists. */
export function configureIngest(deps: AppDeps, opts: IngestOptions): void {
  const s = services.get(deps);
  if (s) s.setOptions(opts);
  else pendingOptions.set(deps, { ...pendingOptions.get(deps), ...opts });
}

