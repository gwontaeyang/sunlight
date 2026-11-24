// Run owner (PLAN 2.3, 2.4; runContract.ts rules 1–6). Owner B.
//
// A run = one llm_calls row + (for message tasks) one assistant message, driven through queue.ts and the
// adapter. Routes start runs with runTask(); the run persists its own terminal state and keeps an in-memory
// event log that any number of subscribers replay (rule 3). Finished handles stay in memory for a bounded time
// (HANDLE_RETENTION); after that a repeated clientRequestId is answered from the DB (run.accepted + terminal).
//
// M2 (PLAN_M2 3.4, runContract rules 1, 1a, 4):
// - The result goes to a SINK chosen from the task: message (M1 behaviour), card (notation / assumptions / summary —
//   the `generating` paper_cards row = run.accepted.artifactId) or suggestion (glossary_define — the adopted output is
//   stored on the run row, llm_calls.resultRaw). prepare (parse, validate, match) runs outside the transaction; the
//   sink's commit / fail run inside the ONE terminal transaction, re-checking that the owner still exists; run.done is
//   emitted only after that commit stored the result. The commit says `stored` or `owner_deleted`: a result whose owner
//   went meanwhile is not stored, its rows end `cancelled` + errorCode result_deleted (usage kept) and the terminal is
//   run.error{result_deleted}. A result that arrives after a cancel request ends like the cancel path (B-CX-2).
// - SP-Blocks repair: an output that fails validateBlocks gets ONE repair call in the same run and queue slot — same
//   prefix, the original <task> block plus <previous_output trust="model"> and <validation_errors trust="app">
//   (formatBlockError lines only). It has its own llm_calls row (clientRequestId NULL, parentRunId); the parent row stays
//   `running` until the run's terminal transaction. totalMs covers the whole run once: with less than
//   repairMinRemainingMs(task) (contracts, S-1: min(120 s, totalMs / 2)) left after the first call the run ends
//   parse_failed; the repair call's deadline is what is left. A second invalid output → parse_failed.
// - effort = resolveEffort(task, { deep }) once per run (llm_calls.effort, the adapter request and run.started).
// - Replays decide "result gone" from the DB for every sink (owner row missing, paper missing or tombstoned, suggestion
//   not usable per resultRetention.suggestionAvailable) → result_deleted; a replaced result → superseded. A finished
//   run still kept in memory is checked the same way before its in-memory log is used, and a run still running is
//   attached only while its paper is not tombstoned and its owner row exists (else result_deleted — B-CX-1).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, desc, eq, gte, inArray, isNull, ne } from 'drizzle-orm';
import type { BlockError } from '@study-paper/shared/contracts/blocks';
import { formatBlockError } from '@study-paper/shared/contracts/blocks';
import type { Citation, LlmUsage, MessageStats, ParsedAnswer, ParsedBlocks, RateLimitInfo } from '@study-paper/shared/contracts/domain';
import { isPdfOnlyUpload, MessageStatsSchema, RateLimitInfoSchema } from '@study-paper/shared/contracts/domain';
import type { RunSseEvent, SseData } from '@study-paper/shared/contracts/sse';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_DEEP_MODEL,
  DEFAULT_PAPER_MODEL,
  DEFAULT_TIMEOUTS,
  LlmErrorCode,
  QUEUE_TIMEOUT_MS,
  TASK_SPECS,
  repairMinRemainingMs,
  resolveEffort,
  resolveModel,
  type Effort,
  type ModelAlias,
  type TaskId,
  type TaskPriority,
} from '@study-paper/shared/contracts/tasks';
import { reportedErrors } from '@study-paper/shared/markup/blockSchemas';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import type { Db } from '../db/client';
import { llmCalls, messages, paperCards, papers, settings, threads } from '../db/schema';
import { HttpError } from '../deps';
import type { Lifecycle } from '../lifecycle';
import type { DataPaths } from '../paths';
import { hasStudyExamples, splitStudyPath, studyPathCitations, STUDY_PATH_MAX_CHARS } from '@study-paper/shared/study-path';
import { overviewCitations, splitOverview } from '@study-paper/shared/overview';
import { commitOverview, failOverview, overviewPending, readOverview } from '../overview/store';
import { commitStudyPath, failStudyPath, readStudyPath, studyPathPending } from '../studyPath/store';
import { parseSelectionQuestions, SELECTION_QUESTIONS_SCHEMA, storedQuestions } from '../study/selectionQuestions';
import { suggestionAvailable } from '../resultRetention';
import { CARD_KIND_OF_TASK, cardAlive, commitCard, failCard, prepareCard, reparseCard, type PreparedCardItem } from '../study/paperCards';
import { commitSuggestion, prepareSuggestion, reparseSuggestion, storedSuggestionTerm } from '../study/glossary';
import type { ContentBlock, LlmAdapter, LlmTimeouts } from './adapter';
import { ClaudeCliAdapter, isRetryable, type CliErrorEvent, type CliResultEvent } from './claudeCli';
import { computeStats, resolveCitations } from './citations';
import { headingIssues } from './headings';
import { equationIndex, groundingPages, readCitations as readOwnerCitations, writeCitations } from './citationStore';
import { ContextError, loadPaperContext, prefixFingerprint, sha256 } from './paperContext';
import { QueueError, RunQueue, type Slot } from './queue';
import type { CancelResult, RunHandle, RunProbe, RunRegistry, RunStartRows, RunTaskInput, RunTx } from './runContract';
import { serializeTask, type RepairPart } from './taskSerialize';

export const SYSTEM_PROMPT = readFileSync(new URL('./prompts/system.md', import.meta.url), 'utf8');
export const SYSTEM_SHA256 = sha256(SYSTEM_PROMPT);
export const PROMPT_VERSION = SYSTEM_SHA256.slice(0, 8);
/** Finished handles kept in memory: at most `max`, each for at most `ms`. */
export const HANDLE_RETENTION = { max: 200, ms: 10 * 60_000 } as const;
/** PLAN 2.4: a cache read of 0 within this window after a success with the same prefix is "unexpected". */
export const CACHE_EXPECTED_WINDOW_MS = 50 * 60_000;

export type { RunStartRows } from './runContract';
export type Tx = RunTx;
/** @deprecated same as RunTaskInput (startRows is part of the contract now). */
export type RunTaskRequest = RunTaskInput;

export interface RunManagerDeps {
  db: Db;
  paths: DataPaths;
  backends?: import('../byok/backend').Backends;
  adapter: LlmAdapter;
  lifecycle?: Lifecycle;
  concurrency?: Record<TaskPriority, number>;
  queueTimeouts?: Record<TaskPriority, number>;
  /** Phase timeouts; totalMs defaults to the task spec. */
  timeouts?: Partial<LlmTimeouts>;
  retention?: { max: number; ms: number };
  /** Instructions for tasks without a prompts/<task>.md (tests; M2/M3 tasks bring their own files). */
  taskTemplates?: Partial<Record<TaskId, string>>;
  log?: (msg: string) => void;
}

// resolveModel/resolveEffort live in contracts/tasks.ts (PLAN_M2 D12 — one place); re-exported for existing callers.
export { resolveEffort, resolveModel } from '@study-paper/shared/contracts/tasks';

/** JSON value with object keys sorted and undefined members dropped (array order is kept: it carries meaning). */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canonical(x)));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  }
  return v;
}

/** Prefix of identity (v2) payload hashes. Rows without it were written by M1 (v1) or by M1.1 (v2 unprefixed). */
export const PAYLOAD_HASH_V2 = 'v2:';

/** v2 body: paper + thread + the caller's normalised request + image hash (unprefixed). */
function identityHash(input: RunTaskInput & { identity: Record<string, unknown> }): string {
  const image = input.imagePngBase64 ? sha256(input.imagePngBase64) : null;
  return sha256(JSON.stringify({ v: 2, paperId: input.paperId, threadId: input.threadId ?? null, identity: canonical(input.identity), image }));
}

/** v1 (M1): task + paper + existing thread + inputs + image hash. Still the identity of callers without `identity`. */
export function legacyPayloadHash(input: RunTaskInput): string {
  const inputs = Object.entries(input.inputs)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(JSON.stringify({ task: input.task, paperId: input.paperId, threadId: input.threadId ?? null, inputs, image: input.imagePngBase64 ? sha256(input.imagePngBase64) : null }));
}

/**
 * Payload identity (rule 1), stored in llm_calls.payloadHash. With `identity` (the routes): 'v2:' + sha256 of
 * paper + thread + the caller's normalised request + image hash. Without it: the v1 hash (unchanged).
 */
export function payloadHash(input: RunTaskInput): string {
  if (input.imagePngBase64 !== undefined && input.storedImagePngBase64 !== undefined) throw new Error('imagePngBase64 and storedImagePngBase64 are exclusive');
  return input.identity ? PAYLOAD_HASH_V2 + identityHash({ ...input, identity: input.identity }) : legacyPayloadHash(input);
}

/**
 * How a stored payload hash relates to a new request with the same clientRequestId:
 * 'same' → attach; 'legacy' → a pre-v2 row that matches only the v1 hash (cannot be proven to be the same
 * request: v1 did not cover the full anchor) → refused with a version error, never attached; 'different' → 409.
 */
export function comparePayload(stored: string | null, input: RunTaskInput): 'same' | 'legacy' | 'different' {
  return comparePayloadWith(stored, input, input);
}

/**
 * The one comparison (comparePayload and findExisting): `input` gives the v2 identity, `legacy` the request as the
 * M1 v1 hash saw it (null = the caller cannot rebuild it → never 'legacy').
 */
function comparePayloadWith(stored: string | null, input: RunTaskInput, legacy: RunTaskInput | null): 'same' | 'legacy' | 'different' {
  payloadHash(input); // throws when imagePngBase64 and storedImagePngBase64 are both given
  if (stored === null) return 'same';
  if (stored === payloadHash(input)) return 'same';
  if (!input.identity || stored.startsWith(PAYLOAD_HASH_V2)) return 'different';
  if (stored === identityHash({ ...input, identity: input.identity })) return 'same'; // v2 written by M1.1 without the prefix
  if (legacy && stored === legacyPayloadHash(legacy)) return 'legacy';
  return 'different';
}

/** Event log of one run: every subscriber replays from the start and then follows live (rule 3). */
class RunLog {
  readonly items: RunSseEvent[] = [];
  private waiters: (() => void)[] = [];
  closed = false;
  push(v: RunSseEvent) {
    if (this.closed) return;
    this.items.push(v);
    this.wake();
  }
  close() {
    this.closed = true;
    this.wake();
  }
  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  async *subscribe(): AsyncGenerator<RunSseEvent> {
    for (let i = 0; ; ) {
      while (i < this.items.length) yield this.items[i++]!;
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/**
 * Where a run's result is stored (PLAN_M2 3.4 "Run과 저장"): a card when the start rows made one (artifactId), the run
 * row for glossary_define, else the assistant message (also a card task started with message rows, as M1 tests do).
 */
export type SinkKind = 'message' | 'card' | 'suggestion' | 'study_path' | 'overview';
function sinkOfStart(task: TaskId, artifactId: string | undefined): SinkKind {
  if (task === 'paper_overview') return 'overview';
  if (task === 'study_path') return 'study_path';
  if (task === 'glossary_define' || task === 'selection_questions') return 'suggestion';
  return artifactId !== undefined && CARD_KIND_OF_TASK[task] !== undefined ? 'card' : 'message';
}

interface Run {
  selection?: import('../byok/backend').Selection;
  runId: string;
  clientRequestId: string;
  payloadHash: string;
  input: RunTaskInput;
  sink: SinkKind;
  threadId: string | null;
  messageId: string | null;
  /** The card of a card run (run.accepted.artifactId). */
  artifactId: string | null;
  extraInputs: Record<string, string | undefined>;
  pageHint?: number;
  /** Messages replaced by this run on success (regenerate); untouched otherwise. */
  replaces: string[];
  /** Messages of this run deleted when it does not succeed (a regenerate's new turn). */
  discardOnFailure: string[];
  /** llm_calls row of the SP-Blocks repair call, once it started. */
  repairRunId: string | null;
  log: RunLog;
  abort: AbortController;
  done: Promise<void>;
  terminal: boolean;
}

/** Result of a sink's prepare step (outside any transaction). */
type Prepared =
  | { kind: 'overview'; parsed: ParsedAnswer; cites: Citation[]; stats: MessageStats }
  | { kind: 'study_path'; parsed: ParsedAnswer; cites: Citation[]; stats: MessageStats; checkCount: number }
  | { kind: 'message'; parsed: ParsedAnswer | null; cites: Citation[]; stats: MessageStats | null }
  | { kind: 'card'; parsed: ParsedBlocks | ParsedAnswer; items: PreparedCardItem[] }
  | { kind: 'selection_questions'; parsed: null; cites: Citation[] }
  | { kind: 'suggestion'; parsed: ParsedBlocks; cites: Citation[] };
type PrepareResult = { ok: true; prepared: Prepared } | { ok: false; errors: BlockError[]; repairable: boolean };

function isUniqueViolation(e: unknown): boolean {
  for (let x = e as { code?: string; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) {
    if (x.code === 'SQLITE_CONSTRAINT_UNIQUE' || x.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  }
  return false;
}

/** The terminal of a request whose result is gone (replay, attach, and a result that found its owner deleted). */
const RESULT_DELETED: RunSseEvent = { event: 'run.error', data: { code: 'result_deleted', message: 'the result of this request no longer exists', retryable: false } };

/**
 * llm_calls.status of a run that ended with this code. result_deleted (a result whose owner was deleted before it could
 * be stored — B-CX-2) is `cancelled`: the run did not fail, its result was discarded.
 */
const errorStatus = (code: LlmErrorCode): 'cancelled' | 'timeout' | 'error' => (code === 'cancelled' || code === 'result_deleted' ? 'cancelled' : code.endsWith('_timeout') ? 'timeout' : 'error');

/** What the sink's commit did with a result: stored (with the runs it superseded), or nothing — its owner is gone. */
type SinkCommit = { kind: 'stored'; superseded: string[] } | { kind: 'owner_deleted' };
const OWNER_DELETED: SinkCommit = { kind: 'owner_deleted' };

type CallRow = typeof llmCalls.$inferSelect;

/** Read-only look at the in-memory runs (tests). */
export interface RunInspector {
  /** The input a live or retained run still holds (undefined once evicted). */
  heldInput(runId: string): Readonly<RunTaskInput> | undefined;
}

export function createRunManager(deps: RunManagerDeps): { runTask: (input: RunTaskRequest) => RunHandle; runs: RunRegistry; queue: RunQueue; inspect: RunInspector } {
  const { db } = deps;
  const log = deps.log ?? ((m: string) => console.warn(`[llm] ${m}`));
  const retention = deps.retention ?? HANDLE_RETENTION;
  const queue = new RunQueue(deps.concurrency ?? DEFAULT_CONCURRENCY, deps.queueTimeouts ?? QUEUE_TIMEOUT_MS);
  if (deps.adapter instanceof ClaudeCliAdapter) deps.adapter.useCwdIfUnset(deps.paths.claudeCwd);

  const runs = new Map<string, Run>(); // live + retained
  const byClient = new Map<string, string>(); // clientRequestId → runId (same lifetime as `runs`)
  const active = new Set<Run>();
  const retained: string[] = [];

  const abortAll = () => {
    for (const r of active) r.abort.abort();
  };
  deps.lifecycle?.signal.addEventListener('abort', abortAll);
  deps.lifecycle?.register({
    name: 'llm-runs',
    active: () => active.size,
    drain: async () => {
      abortAll();
      await Promise.allSettled([...active].map((r) => r.done));
    },
  });

  const handleOf = (r: Run, attached: boolean): RunHandle => ({ runId: r.runId, attached, subscribe: () => r.log.subscribe(), cancel: () => r.abort.abort(), done: r.done });

  const evict = (runId: string) => {
    const r = runs.get(runId);
    if (!r || active.has(r)) return;
    runs.delete(runId);
    if (byClient.get(r.clientRequestId) === runId) byClient.delete(r.clientRequestId);
    const i = retained.indexOf(runId);
    if (i >= 0) retained.splice(i, 1);
  };
  const retain = (r: Run) => {
    retained.push(r.runId);
    while (retained.length > retention.max) evict(retained[0]!);
    setTimeout(() => evict(r.runId), retention.ms).unref();
  };

  // ---------------------------------------------------------------------------------------------------------
  // Result state of a finished run, from the DB (rule 1: replay and the attach to a retained run use the same answer).

  /** The paper may still show results: its row exists and is not tombstoned. */
  const paperAlive = (paperId: string | null): boolean => {
    if (!paperId) return false;
    const p = db.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, paperId)).get();
    return p !== undefined && p.deletingAt === null;
  };
  const assistantOf = (runId: string) => db.select().from(messages).where(and(eq(messages.llmCallId, runId), eq(messages.role, 'assistant'))).get();
  const cardOf = (runId: string) => db.select().from(paperCards).where(eq(paperCards.llmCallId, runId)).get();
  /** The sink of a stored run: card tasks without an assistant message are card runs. */
  const sinkOfRow = (row: CallRow): SinkKind => {
    const task = row.task as TaskId;
    if (task === 'paper_overview') return 'overview';
    if (task === 'study_path') return 'study_path';
    if (task === 'glossary_define' || task === 'selection_questions') return 'suggestion';
    if (CARD_KIND_OF_TASK[task] !== undefined && !assistantOf(row.runId)) return 'card';
    return 'message';
  };

  type Outcome = { kind: 'superseded' } | { kind: 'deleted' } | { kind: 'done'; data: Omit<SseData<'run.done'>, 'usage' | 'rateLimit'> } | { kind: 'parse_failed' } | { kind: 'error'; partialText?: string };

  /** What a replay of this finished (or never finished) run answers. */
  function outcomeOf(row: CallRow): Outcome {
    const task = row.task as TaskId;
    const sink = sinkOfRow(row);
    const alive = paperAlive(row.paperId);
    if (row.status === 'ok') {
      if (row.errorCode === 'superseded') return { kind: 'superseded' };
      if (sink === 'suggestion') {
        const paper = row.paperId ? db.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, row.paperId)).get() : undefined;
        if (!suggestionAvailable(row, paper, Date.now())) return { kind: 'deleted' };
        if (task === 'selection_questions') {
          const saved = storedQuestions(row.resultRaw!);
          return saved ? { kind: 'done', data: { text: saved.text, parsed: null, citations: [], stats: null } } : { kind: 'parse_failed' };
        }
        const term = termOfRow(row);
        const parsed = term === null ? null : reparseSuggestion(row.resultRaw!, term);
        if (!parsed) return { kind: 'parse_failed' };
        const body = parsed.items.find((i) => i.tag === 'term')?.body ?? '';
        const cites = row.paperId ? resolveCitations(parseAnswer(body, { final: true }), groundingPages(db, row.paperId), equationIndex(db, row.paperId)) : [];
        return { kind: 'done', data: { text: row.resultRaw!, parsed, citations: cites, stats: null } };
      }
      if (!alive) return { kind: 'deleted' };
      if (sink === 'study_path' || sink === 'overview') {
        const read = sink === 'study_path' ? readStudyPath : readOverview;
        const result = read(db, row.paperId!).result;
        if (!result || result.runId !== row.runId) return { kind: 'deleted' };
        const parsed = parseAnswer(result.text, { final: true });
        return { kind: 'done', data: { text: result.text, parsed, citations: result.citations, stats: computeStats(parsed, result.citations) } };
      }
      if (sink === 'card') {
        const card = cardOf(row.runId);
        if (!card || card.status !== 'complete' || card.rawOutput === null) return { kind: 'deleted' };
        const parsed = reparseCard(task, card.rawOutput);
        if (!parsed) return { kind: 'parse_failed' };
        return { kind: 'done', data: { text: card.rawOutput, parsed, citations: [], stats: null } };
      }
      const msg = assistantOf(row.runId);
      if (!msg) return { kind: 'deleted' };
      const text = msg.contentMd;
      const parsed = parseMessageAnswer(task, text);
      const stats = msg.statsJson ? MessageStatsSchema.parse(JSON.parse(msg.statsJson)) : null;
      return { kind: 'done', data: { text, parsed, citations: readOwnerCitations(db, 'message', msg.id), stats } };
    }
    // a result discarded because its owner was deleted before it could be stored (B-CX-2): the same answer as a deletion
    if (row.errorCode === 'result_deleted') return { kind: 'deleted' };
    // a failed run: its partial text only while its owner (and paper) still exist
    if (!alive) return { kind: 'error' };
    if (sink === 'message') {
      const msg = assistantOf(row.runId);
      return msg?.contentMd ? { kind: 'error', partialText: msg.contentMd } : { kind: 'error' };
    }
    if (sink === 'card') {
      const card = cardOf(row.runId);
      return card?.rawOutput ? { kind: 'error', partialText: card.rawOutput } : { kind: 'error' };
    }
    return { kind: 'error' };
  }

  /** The requested term of a glossary_define run (its stored task inputs are not kept: the identity hash is). */
  function termOfRow(row: CallRow): string | null {
    const live = runs.get(row.runId);
    if (live) return live.input.inputs.term ?? null;
    // the adopted output was validated against the requested term (normalizeTerm-equal): its own name is that term,
    // read with parseBlocks like the validation (review B-R1-03)
    return storedSuggestionTerm(row.resultRaw!)?.name ?? null;
  }

  /** run.accepted of a replay: the owner rows that still exist. */
  function acceptedOf(row: CallRow): RunSseEvent {
    const sink = sinkOfRow(row);
    const msg = sink === 'message' ? assistantOf(row.runId) : undefined;
    const card = sink === 'card' ? cardOf(row.runId) : undefined;
    return { event: 'run.accepted', data: { runId: row.runId, task: row.task as TaskId, ...(row.threadId ? { threadId: row.threadId } : {}), ...(msg ? { messageId: msg.id } : {}), ...(card ? { artifactId: card.id } : sink === 'study_path' || sink === 'overview' ? { artifactId: row.runId } : {}) } };
  }

  /** Attach to a run that is no longer in memory (or whose result is gone): run.accepted + its terminal, from the DB. */
  function replayFromDb(row: CallRow): RunHandle {
    const events: RunSseEvent[] = [acceptedOf(row)];
    const outcome = outcomeOf(row);
    if (outcome.kind === 'superseded') {
      // Its result was replaced by a successful regenerate (the message / card is gone): an explicit, stable terminal.
      events.push({ event: 'run.error', data: { code: 'superseded', message: 'the result of this request was replaced by a newer one', retryable: false } });
    } else if (outcome.kind === 'deleted') {
      events.push(RESULT_DELETED);
    } else if (outcome.kind === 'parse_failed') {
      events.push({ event: 'run.error', data: { code: 'parse_failed', message: 'the stored output no longer passes the format check', retryable: false } });
    } else if (outcome.kind === 'done') {
      const rateLimit = row.rateLimitJson ? RateLimitInfoSchema.safeParse(JSON.parse(row.rateLimitJson)) : null;
      events.push({
        event: 'run.done',
        data: {
          ...outcome.data,
          usage: { inputTokens: row.inputTokens, cacheReadTokens: row.cacheReadTokens, cacheCreationTokens: row.cacheCreationTokens, outputTokens: row.outputTokens, thinkingTokens: row.thinkingTokens, costUsdApiEquivEst: row.costUsdApiEquivEst, durationMs: row.durationMs, durationApiMs: row.durationApiMs },
          ...(rateLimit?.success ? { rateLimit: rateLimit.data } : {}),
        },
      });
    } else {
      const parsedCode = LlmErrorCode.safeParse(row.errorCode);
      const code: LlmErrorCode = parsedCode.success ? parsedCode.data : row.status === 'cancelled' ? 'cancelled' : 'cli_error';
      const message = row.status === 'interrupted' ? 'the run was interrupted by a server restart' : row.status === 'queued' || row.status === 'running' ? 'the run is no longer tracked by this server' : (row.errorCode ?? row.status);
      events.push({ event: 'run.error', data: { code, message, retryable: row.status === 'interrupted' || isRetryable(code), ...(outcome.partialText ? { partialText: outcome.partialText } : {}) } });
    }
    return staticHandle(row.runId, events);
  }

  const staticHandle = (runId: string, events: RunSseEvent[]): RunHandle => ({
    runId,
    attached: true,
    subscribe: async function* () {
      yield* events;
    },
    cancel: () => {},
    done: Promise.resolve(),
  });

  /**
   * The handle for an existing run (after the payload comparison). A run still running → its log only while its paper
   * is not tombstoned and its owner row (message / card) exists; otherwise run.accepted + run.error{result_deleted}
   * without opening the log, so nothing streamed before a deletion reaches a new subscriber (B-CX-1, Codex M-M2-1 —
   * PLAN_M2 3.4 "tombstone = no result" extended to running runs). A finished run kept in memory → its log only while
   * its result still exists (else the DB replay — a resend right after a deletion answers like one after an eviction).
   * "Still running" = active AND no terminal yet: a run that wrote its terminal (result committed, parse_failed, …)
   * while its adapter iterator has not ended is finished — the same answer as once it leaves the active set (B-F2-02).
   */
  function existingHandle(live: Run | undefined, row: CallRow | undefined): RunHandle {
    if (live && active.has(live) && !live.terminal) {
      if (!liveResultGone(live)) return handleOf(live, true);
      const dbRow = db.select().from(llmCalls).where(eq(llmCalls.runId, live.runId)).get();
      return staticHandle(live.runId, [dbRow ? acceptedOf(dbRow) : { event: 'run.accepted', data: { runId: live.runId, task: live.input.task } }, RESULT_DELETED]);
    }
    const dbRow = row ?? db.select().from(llmCalls).where(eq(llmCalls.runId, live!.runId)).get();
    if (!dbRow) return handleOf(live!, true);
    if (live) {
      const o = outcomeOf(dbRow);
      if (o.kind === 'done' || (o.kind === 'error' && ownerStillThere(dbRow))) return handleOf(live, true);
    }
    return replayFromDb(dbRow);
  }
  /** A running run can no longer store its result: paper tombstoned or gone, or its message / card row deleted. */
  function liveResultGone(r: Run): boolean {
    if (r.sink === 'overview') return !overviewPending(db, r.input.paperId, r.runId);
    if (r.sink === 'study_path') return !studyPathPending(db, r.input.paperId, r.runId);
    if (r.sink === 'card') return r.artifactId === null || !cardAlive(db, r.artifactId);
    if (r.sink === 'message' && r.messageId !== null) return !messageOwnerAlive(db, r);
    return !paperAlive(r.input.paperId);
  }
  /** The owner rows of a (failed) run still exist: the in-memory log (with its partial text) may be shown. */
  function ownerStillThere(row: CallRow): boolean {
    if (!paperAlive(row.paperId)) return false;
    const sink = sinkOfRow(row);
    if (sink === 'overview') return overviewPending(db, row.paperId, row.runId);
    if (sink === 'study_path') return studyPathPending(db, row.paperId, row.runId);
    if (sink === 'message') return assistantOf(row.runId) !== undefined;
    if (sink === 'card') return cardOf(row.runId) !== undefined;
    return true;
  }

  function conflictOr(rel: 'same' | 'legacy' | 'different', runId: string, attach: () => RunHandle): RunHandle {
    if (rel === 'legacy') {
      throw new HttpError(409, 'conflict', 'this request id was stored by an older server version and cannot be re-attached safely; open the thread to see its result, or send the request again (a new id)', { reason: 'payload_version', runId });
    }
    if (rel === 'different') throw new HttpError(409, 'conflict', 'clientRequestId was already used for a different request');
    return attach();
  }

  /**
   * runContract rule 1a (S): the same comparison as lookupExisting, from a body-only probe. probe.paperId absent →
   * the stored paperId; NULL there (the paper row was deleted for good) → no comparison is possible (the stored hash
   * covers the paper id), and the answer is the row state like every other replay (PLAN_M2 9절 60 · 67(c), Codex
   * m-M2-R2-1): a cancelled row → run.error{cancelled}, an ok row → result_deleted (its paper is gone), never its text.
   */
  function findExisting(probe: RunProbe): RunHandle | null {
    const rid = byClient.get(probe.clientRequestId);
    const live = rid ? runs.get(rid) : undefined;
    const row = live ? undefined : db.select().from(llmCalls).where(eq(llmCalls.clientRequestId, probe.clientRequestId)).get();
    if (!live && !row) return null;
    const storedPaperId = live ? live.input.paperId : row!.paperId;
    const storedTask = (live ? live.input.task : row!.task) as TaskId;
    const runId = live ? live.runId : row!.runId;
    const paperId = probe.paperId !== undefined ? probe.paperId : storedPaperId;
    if (paperId === null && probe.paperId === undefined) return existingHandle(live, row);
    const asInput = (task: TaskId, inputs: Record<string, string | undefined>): RunTaskInput => ({
      task,
      clientRequestId: probe.clientRequestId,
      paperId,
      ...(probe.threadId !== undefined ? { threadId: probe.threadId } : {}),
      inputs,
      identity: probe.identity,
      ...(probe.imagePngBase64 !== undefined ? { imagePngBase64: probe.imagePngBase64 } : {}),
    });
    const input = asInput(storedTask, {});
    const legacy = probe.legacy ? asInput(probe.legacy.task ?? storedTask, probe.legacy.inputs) : null;
    const rel = comparePayloadWith(live ? live.payloadHash : row!.payloadHash, input, legacy);
    return conflictOr(rel, runId, () => existingHandle(live, row));
  }

  function lookupExisting(input: RunTaskInput): RunHandle | null {
    const rid = byClient.get(input.clientRequestId);
    const live = rid ? runs.get(rid) : undefined;
    if (live) return conflictOr(comparePayload(live.payloadHash, input), live.runId, () => existingHandle(live, undefined));
    const row = db.select().from(llmCalls).where(eq(llmCalls.clientRequestId, input.clientRequestId)).get();
    if (row) return conflictOr(comparePayload(row.payloadHash, input), row.runId, () => existingHandle(undefined, row));
    return null;
  }


  // ---------------------------------------------------------------------------------------------------------
  const runTask = (input: RunTaskRequest): RunHandle => {
    const hash = payloadHash(input);
    const existing = lookupExisting(input);
    if (existing) return existing;

    const runId = randomUUID();
    if (input.task === 'equation_deep' && input.paperId) {
      const owner = db.select({ source: papers.source, structureSource: papers.structureSource }).from(papers).where(eq(papers.id, input.paperId)).get();
      if (owner && isPdfOnlyUpload(owner.source, owner.structureSource)) throw new HttpError(400, 'validation', 'uploaded PDFs have no indexed LaTeX equations');
    }
    const selection = deps.backends?.select(input.task);
    const model = selection?.model ?? resolveModel(input.task);
    // The one effort decision of this run (PLAN_M2 D12): row, adapter request and run.started use this value.
    const effort = resolveEffort(input.task, { deep: input.deep === true });
    let rows: ReturnType<RunStartRows['insert']> = {};
    try {
      db.transaction((tx) => {
        rows = input.startRows?.insert(tx, runId) ?? {};
        tx.insert(llmCalls)
          .values({ runId, clientRequestId: input.clientRequestId, payloadHash: hash, ...(selection?.columns ?? { executionMode: deps.adapter.mode }), task: input.task, paperId: input.paperId, threadId: rows.threadId ?? input.threadId ?? null, model, effort, promptVersion: PROMPT_VERSION, status: 'queued', acceptedAt: Date.now() })
          .run();
        const messageId = rows.messageId ?? input.messageId;
        if (messageId) tx.update(messages).set({ llmCallId: runId }).where(eq(messages.id, messageId)).run();
        if (sinkOfStart(input.task, rows.artifactId) === 'card') tx.update(paperCards).set({ llmCallId: runId }).where(eq(paperCards.id, rows.artifactId!)).run();
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        const again = lookupExisting(input);
        if (again) return again;
        throw new HttpError(409, 'conflict', 'clientRequestId was already used');
      }
      throw e;
    }

    let resolveDone!: () => void;
    const run: Run = {
      runId,
      clientRequestId: input.clientRequestId,
      payloadHash: hash,
      input,
      selection,
      sink: sinkOfStart(input.task, rows.artifactId),
      threadId: rows.threadId ?? input.threadId ?? null,
      messageId: rows.messageId ?? input.messageId ?? null,
      artifactId: rows.artifactId ?? null,
      extraInputs: rows.extraInputs ?? {},
      ...(rows.pageHint !== undefined ? { pageHint: rows.pageHint } : {}),
      replaces: rows.replaces ?? [],
      discardOnFailure: rows.discardOnFailure ?? [],
      repairRunId: null,
      log: new RunLog(),
      abort: new AbortController(),
      done: new Promise<void>((r) => (resolveDone = r)),
      terminal: false,
    };
    runs.set(runId, run);
    byClient.set(run.clientRequestId, runId);
    active.add(run);
    run.log.push({ event: 'run.accepted', data: { runId, task: input.task, ...(run.threadId ? { threadId: run.threadId } : {}), ...(run.messageId ? { messageId: run.messageId } : {}), ...(run.artifactId ? { artifactId: run.artifactId } : {}) } });
    if (deps.lifecycle?.stopping) run.abort.abort(); // accepted during shutdown: ends `cancelled` without a child

    const rotated = () => run.abort.abort();
    selection?.rotation?.addEventListener('abort', rotated, { once: true });
    if (selection?.rotation?.aborted) rotated();
    void execute(run, model, effort)
      .catch((e: unknown) => {
        // execute() handles its own failures; this only guards the "exactly one terminal event" rule.
        log(`run ${run.runId}: unexpected ${(e as Error).stack ?? String(e)}`);
        if (run.terminal) return;
        run.terminal = true;
        try {
          persistError(run, 'cli_error', 'internal error', (e as Error).message, '');
        } catch {
          /* DB unavailable: startupRecovery marks the row interrupted */
        }
        run.log.push({ event: 'run.error', data: { code: 'cli_error', message: 'internal error', retryable: true } });
      })
      .finally(() => {
        selection?.rotation?.removeEventListener('abort', rotated);
        delete run.selection;
        active.delete(run);
        run.log.close();
        // A retained finished run keeps only what a replay or a payload comparison reads (payloadHash, task, paperId,
        // inputs.term): the PNG of a capture or a re-attached stored capture (up to ~5.6 MB of base64 each) goes now
        // (review B-R1-10).
        if (run.input.imagePngBase64 !== undefined || run.input.storedImagePngBase64 !== undefined) {
          const { imagePngBase64: _image, storedImagePngBase64: _stored, ...kept } = run.input;
          run.input = kept;
        }
        retain(run);
        resolveDone();
      });
    return handleOf(run, false);
  };

  // ---------------------------------------------------------------------------------------------------------
  async function execute(run: Run, model: ModelAlias, effort: Effort): Promise<void> {
    const { input } = run;
    const spec = TASK_SPECS[input.task];
    let text = '';
    let slot: Slot | null = null;
    const fail = (code: LlmErrorCode, message: string, detail?: string) => {
      if (run.terminal) return;
      run.terminal = true;
      slot?.release();
      try {
        persistError(run, code, message, detail, text);
      } catch (e) {
        log(`run ${run.runId}: could not persist ${code}: ${(e as Error).message}`);
      }
      run.log.push({ event: 'run.error', data: { code, message, retryable: isRetryable(code), ...(text ? { partialText: text } : {}) } });
    };

    if (run.abort.signal.aborted) return fail('cancelled', deps.lifecycle?.stopping ? 'the server is shutting down' : 'cancelled');
    try {
      slot = await queue.enqueue(spec.priority, { signal: run.abort.signal, onPosition: (position) => run.log.push({ event: 'run.queued', data: { position } }) });
    } catch (e) {
      if (e instanceof QueueError) return fail(e.code, e.message);
      throw e;
    }
    try {
      const startedAt = Date.now();
      const accepted = db.select({ acceptedAt: llmCalls.acceptedAt }).from(llmCalls).where(eq(llmCalls.runId, run.runId)).get();
      db.update(llmCalls)
        .set({ status: 'running', startedAt, queuedMs: accepted ? startedAt - accepted.acceptedAt : null })
        .where(eq(llmCalls.runId, run.runId))
        .run();
      if (run.abort.signal.aborted) return fail('cancelled', 'cancelled');

      // Prefix: paper tasks = [document, supplement] built by buildPaperPrefix only (the same bytes for every task,
      // image request and repair call on this paper); local / none tasks (translate) have no prefix and no fingerprint.
      let prefix: ContentBlock[] = [];
      let fingerprint: string | null = null;
      let contextMode: 'pdf' | 'text' | null = null;
      if (spec.context === 'paper') {
        if (!input.paperId) return fail('context_not_ready', 'this task needs a paper');
        try {
          const ctx = loadPaperContext(db, deps.paths, input.paperId);
          prefix = ctx.prefix;
          contextMode = ctx.contextMode;
          fingerprint = prefixFingerprint({ systemSha256: SYSTEM_SHA256, pdfSha256: ctx.pdfSha256, supplementSha256: ctx.supplementSha256, contextMode, hasSchema: false });
        } catch (e) {
          if (e instanceof ContextError) return fail(e.code, e.message);
          throw e;
        }
      }
      db.update(llmCalls).set({ contextMode, prefixFingerprint: fingerprint }).where(eq(llmCalls.runId, run.runId)).run();

      const image = input.imagePngBase64 ?? input.storedImagePngBase64;
      const inputs = { ...input.inputs, ...run.extraInputs };
      // Use the preference only for tasks with free-form prose. Explicit translation targets and machine
      // schemas keep their own contract. The language travels after the shared document cache breakpoint.
      if (!inputs.answerLanguage && (spec.output === 'sp-markup' || spec.output === 'sp-blocks')) {
        const saved = db.select({ value: settings.valueJson }).from(settings).where(eq(settings.key, 'llm.answerLanguage')).get();
        if (saved?.value === '"en"') inputs.answerLanguage = 'en';
      }
      const totalMs = deps.timeouts?.totalMs ?? spec.totalMs;
      const deadline = Date.now() + totalMs;
      let repair: RepairPart | undefined;
      let callRunId = run.runId;

      for (let attempt = 1; ; attempt++) {
        const tail: ContentBlock[] = [];
        if (image) tail.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } });
        tail.push({ type: 'text', text: serializeTask(input.task, inputs, deps.taskTemplates?.[input.task], repair) });
        const callStart = Date.now();
        let modelResolved: string | null = null;
        let cliVersion: string | null = null;
        let ttftMs: number | null = null;
        let next = false;
        text = '';
        const iter = (run.selection?.adapter ?? deps.adapter).run({
          runId: callRunId,
          task: input.task,
          model,
          effort,
          ...(input.task === 'selection_questions' ? { jsonSchema: SELECTION_QUESTIONS_SCHEMA } : {}),
          system: SYSTEM_PROMPT,
          prefix,
          tail,
          // totalMs is the whole run's: the repair call gets what is left of it (PLAN_M2 3.4)
          timeouts: { ...DEFAULT_TIMEOUTS, ...deps.timeouts, totalMs: attempt === 1 ? totalMs : Math.max(1, deadline - callStart) },
          signal: run.abort.signal,
        });
        for await (const ev of iter) {
          if (run.terminal || next) continue; // drain: the adapter ends after its terminal event
          if (ev.type === 'started') {
            modelResolved = ev.modelResolved;
            cliVersion = ev.cliVersion;
            db.update(llmCalls).set({ modelResolved, cliVersion }).where(eq(llmCalls.runId, callRunId)).run();
            run.log.push({ event: 'run.started', data: { model, modelResolved, effort, cliVersion } });
          } else if (ev.type === 'response_started') {
            run.log.push({ event: 'run.response_started', data: { cacheReadTokens: ev.cacheReadTokens, cacheCreationTokens: ev.cacheCreationTokens } });
          } else if (ev.type === 'thinking') {
            run.log.push({ event: 'run.thinking', data: { estimatedTokens: ev.estimatedTokens } });
          } else if (ev.type === 'text') {
            if (ttftMs === null) ttftMs = Date.now() - callStart;
            text += ev.delta;
            run.log.push({ event: 'run.delta', data: { text: ev.delta } });
          } else if (ev.type === 'rate_limit') {
            // S (PLAN_M2 D25): for the live ledger only (watchLiveRun) — no SSE event, no run state change.
            continue;
          } else if (ev.type === 'error') {
            text = ev.partialText || text;
            fail(ev.code, ev.message, (ev as CliErrorEvent).detail);
          } else if (ev.type === 'result') {
            const warnings = (ev as CliResultEvent).warnings;
            const meta = { fingerprint, modelResolved, cliVersion, ttftMs, warnings };
            if (run.abort.signal.aborted) {
              // B-CX-2 (Codex M-M2-2): a result that arrives after a cancel request (runs.cancel, the paper deletion's
              // cancel, shutdown) is not stored — the run ends like the cancel path (the adapter's cancel error: same
              // terminal with the streamed text, same message / card / llm_calls status). The call's usage is kept.
              try {
                recordCall(callRunId, ev.usage, ev.rateLimit, meta);
              } catch (e) {
                log(`run ${run.runId}: could not record the usage of a result after a cancel: ${(e as Error).message}`);
              }
              fail('cancelled', 'cancelled');
              continue;
            }
            // Claude Code puts schema output in structured_output. The Messages API streams the JSON as text.
            text = input.task === 'selection_questions' && ev.structured !== undefined ? JSON.stringify(ev.structured) : ev.text;
            // run.done only after the result transaction committed (rule 4, review B3). Anything that throws on the
            // way (parse, validation, citation matching, lookups, the transaction) ends the run with ONE persist_failed.
            let prep: PrepareResult;
            try {
              prep = prepare(run, text);
            } catch (e) {
              log(`run ${run.runId}: could not process the result: ${(e as Error).stack ?? String(e)}`);
              fail('persist_failed', 'the answer could not be stored', (e as Error).message);
              continue;
            }
            if (prep.ok) {
              let committed: CommitOutcome;
              try {
                committed = commitResult(run, callRunId, text, prep.prepared, ev.usage, ev.rateLimit, meta);
              } catch (e) {
                log(`run ${run.runId}: could not store the result: ${(e as Error).stack ?? String(e)}`);
                fail('persist_failed', 'the answer could not be stored', (e as Error).message);
                continue;
              }
              run.terminal = true;
              slot.release();
              // run.done only for a result that was stored; a result whose owner was deleted ends result_deleted (B-CX-2)
              run.log.push(committed.kind === 'stored' ? { event: 'run.done', data: committed.done } : RESULT_DELETED);
              continue;
            }
            const remaining = deadline - Date.now();
            if (attempt === 1 && prep.repairable && remaining >= repairMinRemainingMs(run.input.task) && !run.abort.signal.aborted) {
              const errors = reportedErrors(prep.errors).map(formatBlockError);
              try {
                recordCall(callRunId, ev.usage, ev.rateLimit, meta);
                callRunId = startRepairRow(run, model, effort, contextMode, fingerprint);
              } catch (e) {
                fail('persist_failed', 'the answer could not be stored', (e as Error).message);
                continue;
              }
              run.log.push({ event: 'run.retrying', data: { reason: 'validation', errors } });
              repair = { previousOutput: ev.text, errors };
              next = true;
              continue;
            }
            // The call's usage / cache / rate-limit columns are kept for an invalid output too (review B-R1-07); a DB
            // error here is only logged so the run still ends with its one parse_failed terminal.
            try {
              recordCall(callRunId, ev.usage, ev.rateLimit, meta);
            } catch (e) {
              log(`run ${run.runId}: could not record the usage of an invalid output: ${(e as Error).message}`);
            }
            fail('parse_failed', attempt === 1 && prep.repairable ? 'the output did not pass the format check and no time was left for a repair' : 'the output did not pass the format check', prep.errors.map((x) => x.code).join(', '));
          }
        }
        if (next) continue;
        if (!run.terminal) fail('cli_error', 'the adapter ended without a terminal event');
        break;
      }
    } catch (e) {
      log(`run ${run.runId}: ${(e as Error).stack ?? e}`);
      fail('cli_error', 'internal error while running the task', (e as Error).message);
    } finally {
      slot.release();
    }
  }

  /** The repair call's own llm_calls row (clientRequestId NULL, parentRunId); the parent stays `running`. */
  function startRepairRow(run: Run, model: ModelAlias, effort: Effort, contextMode: 'pdf' | 'text' | null, fingerprint: string | null): string {
    const id = randomUUID();
    const now = Date.now();
    db.insert(llmCalls)
      .values({ runId: id, ...(run.selection?.columns ?? { executionMode: deps.adapter.mode }), clientRequestId: null, payloadHash: null, task: run.input.task, paperId: run.input.paperId, threadId: run.threadId, model, effort, promptVersion: PROMPT_VERSION, contextMode, prefixFingerprint: fingerprint, status: 'running', acceptedAt: now, startedAt: now, queuedMs: 0, parentRunId: run.runId })
      .run();
    run.repairRunId = id;
    return id;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Sinks (PLAN_M2 3.4): prepare outside the transaction, commit / fail inside the terminal transaction.

  function prepare(run: Run, text: string): PrepareResult {
    const { input } = run;
    const spec = TASK_SPECS[input.task];
    const paperId = input.paperId;
    if (run.sink === 'card') {
      const r = prepareCard(input.task, text, paperId ? groundingPages(db, paperId) : [], paperId ? equationIndex(db, paperId) : []);
      return r.ok ? { ok: true, prepared: { kind: 'card', parsed: r.parsed, items: r.items } } : { ok: false, errors: r.errors, repairable: r.repairable };
    }
    if (run.sink === 'suggestion') {
      if (input.task === 'selection_questions') {
        return input.reviewSelection && parseSelectionQuestions(text, input.reviewSelection.quote.exact)
          ? { ok: true, prepared: { kind: 'selection_questions', parsed: null, cites: [] } }
          : { ok: false, errors: [], repairable: false };
      }
      const r = prepareSuggestion(text, input.inputs.term ?? '', paperId ? groundingPages(db, paperId) : [], paperId ? equationIndex(db, paperId) : []);
      return r.ok ? { ok: true, prepared: { kind: 'suggestion', parsed: r.parsed, cites: r.citations } } : { ok: false, errors: r.errors, repairable: r.repairable };
    }
    if (run.sink === 'overview') {
      if (!paperId || !splitOverview(text)) return { ok: false, errors: [], repairable: false };
      const parsed = parseAnswer(text, { final: true });
      const cites = resolveCitations(parsed, groundingPages(db, paperId), equationIndex(db, paperId));
      if (!overviewCitations(text, cites)) return { ok: false, errors: [], repairable: false };
      return { ok: true, prepared: { kind: 'overview', parsed, cites, stats: computeStats(parsed, cites) } };
    }
    if (run.sink === 'study_path') {
      if (!paperId || text.length > STUDY_PATH_MAX_CHARS) return { ok: false, errors: [], repairable: false };
      const parts = splitStudyPath(text);
      if (!parts.complete || !hasStudyExamples(parts.stages[4]!.body, input.inputs.codeLanguage)) return { ok: false, errors: [], repairable: false };
      const parsed = parseAnswer(text, { final: true });
      const cites = resolveCitations(parsed, groundingPages(db, paperId), equationIndex(db, paperId));
      if (!studyPathCitations(text, cites)) return { ok: false, errors: [], repairable: false };
      return { ok: true, prepared: { kind: 'study_path', parsed, cites, stats: computeStats(parsed, cites), checkCount: parts.checklist.length } };
    }
    const parsed = parseMessageAnswer(input.task, text);
    let cites: Citation[] = [];
    let stats: MessageStats | null = null;
    if (parsed && paperId) {
      cites = resolveCitations(parsed, groundingPages(db, paperId), equationIndex(db, paperId), run.pageHint !== undefined ? { pageHint: run.pageHint } : {});
      stats = computeStats(parsed, cites);
    }
    return { ok: true, prepared: { kind: 'message', parsed, cites, stats } };
  }

  /** Message rows may still take the result: the message and its thread exist and the paper is not tombstoned. */
  function messageOwnerAlive(tx: Tx | Db, run: Run): boolean {
    if (!run.messageId) return false;
    const m = tx.select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, run.messageId)).get();
    if (!m) return false;
    const t = tx.select({ paperId: threads.paperId }).from(threads).where(eq(threads.id, m.threadId)).get();
    if (!t) return false;
    const p = tx.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, t.paperId)).get();
    return p !== undefined && p.deletingAt === null;
  }

  /**
   * The sink's success writes: `stored` with the runIds whose results were replaced (superseded), or `owner_deleted`
   * when the owner can no longer take the result (card gone or not generating, message / thread gone, paper deleted or
   * tombstoned) — then nothing is written (B-CX-2).
   */
  function sinkCommit(tx: Tx, run: Run, prepared: Prepared, text: string, finishedAt: number): SinkCommit {
    if (prepared.kind === 'overview') {
      const replaced = run.input.paperId ? commitOverview(tx, run.input.paperId, run.runId, text, prepared.cites) : null;
      return replaced === null ? OWNER_DELETED : { kind: 'stored', superseded: replaced };
    }
    if (prepared.kind === 'study_path') {
      const replaced = run.input.paperId ? commitStudyPath(tx, run.input.paperId, run.runId, text, prepared.cites, prepared.checkCount) : null;
      return replaced === null ? OWNER_DELETED : { kind: 'stored', superseded: replaced };
    }
    if (prepared.kind === 'card') {
      const superseded = run.artifactId ? commitCard(tx, run.artifactId, text, prepared.items) : null;
      return superseded === null ? OWNER_DELETED : { kind: 'stored', superseded };
    }
    if (prepared.kind === 'selection_questions') {
      const raw = JSON.stringify({ ...run.input.reviewSelection, text });
      return commitSuggestion(tx, run.runId, run.input.paperId, raw) ? { kind: 'stored', superseded: [] } : OWNER_DELETED;
    }
    if (prepared.kind === 'suggestion') return commitSuggestion(tx, run.runId, run.input.paperId, text) ? { kind: 'stored', superseded: [] } : OWNER_DELETED;
    if (!messageOwnerAlive(tx, run)) return OWNER_DELETED; // thread or message deleted meanwhile: nothing is inserted
    const superseded: string[] = [];
    // Regenerate: the replaced turn goes only now, together with storing the new answer (review M4). Its
    // successful run is marked superseded so a replay of its request id says so instead of an empty answer (N4).
    if (run.replaces.length) {
      const replaced = tx.select({ runId: messages.llmCallId }).from(messages).where(and(inArray(messages.id, run.replaces), eq(messages.role, 'assistant'))).all();
      for (const { runId: oldRunId } of replaced) {
        if (!oldRunId) continue;
        const old = tx.select({ status: llmCalls.status, errorDetail: llmCalls.errorDetail }).from(llmCalls).where(eq(llmCalls.runId, oldRunId)).get();
        if (old?.status !== 'ok') continue; // a failed run keeps its own error code
        tx.update(llmCalls)
          .set({ errorCode: 'superseded', errorDetail: `${old.errorDetail ? `${old.errorDetail}\n` : ''}superseded by run ${run.runId}`.slice(0, 2048) })
          .where(eq(llmCalls.runId, oldRunId))
          .run();
        superseded.push(oldRunId);
      }
      tx.delete(messages).where(inArray(messages.id, run.replaces)).run();
    }
    tx.update(messages)
      .set({ status: 'complete', contentMd: text, statsJson: prepared.stats ? JSON.stringify(prepared.stats) : null, issuesJson: JSON.stringify(prepared.parsed?.issues ?? []) })
      .where(eq(messages.id, run.messageId!))
      .run();
    // the new turn of a regenerate is committed: no longer pending (startup recovery would delete it otherwise)
    if (run.discardOnFailure.length) tx.update(messages).set({ pendingReplace: 0 }).where(inArray(messages.id, run.discardOnFailure)).run();
    writeCitations(tx, 'message', run.messageId!, prepared.cites);
    if (run.threadId) tx.update(threads).set({ updatedAt: finishedAt }).where(eq(threads.id, run.threadId)).run();
    return { kind: 'stored', superseded };
  }

  /** The sink's failure writes (inside the terminal transaction). */
  function sinkFail(tx: Tx, run: Run, code: LlmErrorCode, partial: string): void {
    if (run.sink === 'card') {
      if (run.artifactId) failCard(tx, run.artifactId, code, partial);
      return;
    }
    if (run.sink === 'study_path' || run.sink === 'overview') {
      const clear = run.sink === 'study_path' ? failStudyPath : failOverview;
      if (run.input.paperId) clear(tx, run.input.paperId, run.runId);
      return;
    }
    if (run.sink === 'suggestion') return; // no owner row: the run row is the record
    // A regenerate that did not succeed: its new turn goes, the replaced turn stays exactly as it was.
    if (run.discardOnFailure.length) tx.delete(messages).where(inArray(messages.id, run.discardOnFailure)).run();
    else if (messageOwnerAlive(tx, run)) tx.update(messages).set({ status: code === 'cancelled' ? 'cancelled' : 'error', contentMd: partial }).where(eq(messages.id, run.messageId!)).run();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Terminal persistence (rule 4): one transaction.

  function persistError(run: Run, code: LlmErrorCode, message: string, detail: string | undefined, partial: string) {
    db.transaction((tx) => {
      const set = { status: errorStatus(code), errorCode: code, errorDetail: (detail ? `${message}\n${detail}` : message).slice(0, 2048), finishedAt: Date.now() };
      tx.update(llmCalls).set(set).where(eq(llmCalls.runId, run.runId)).run();
      if (run.repairRunId) tx.update(llmCalls).set(set).where(eq(llmCalls.runId, run.repairRunId)).run();
      sinkFail(tx, run, code, partial);
    });
  }

  type CallMeta = { fingerprint: string | null; modelResolved: string | null; cliVersion: string | null; ttftMs: number | null; warnings?: string[] };

  /** cacheMissUnexpected of one call (PLAN 2.4): a 0 cache read within the window after a success with the same prefix. */
  function cacheMiss(callRunId: string, usage: LlmUsage, meta: CallMeta, now: number): boolean | null {
    if (!meta.fingerprint || !meta.modelResolved || !meta.cliVersion) return null;
    const row = db.select({ mode: llmCalls.executionMode, generation: llmCalls.credentialGeneration, effort: llmCalls.effort }).from(llmCalls).where(eq(llmCalls.runId, callRunId)).get();
    if (!row) return null;
    const prev = db
      .select({ runId: llmCalls.runId })
      .from(llmCalls)
      .where(and(eq(llmCalls.executionMode, row.mode), eq(llmCalls.effort, row.effort), row.generation === null ? isNull(llmCalls.credentialGeneration) : eq(llmCalls.credentialGeneration, row.generation), eq(llmCalls.prefixFingerprint, meta.fingerprint), eq(llmCalls.modelResolved, meta.modelResolved), eq(llmCalls.cliVersion, meta.cliVersion), eq(llmCalls.status, 'ok'), ne(llmCalls.runId, callRunId), gte(llmCalls.finishedAt, now - CACHE_EXPECTED_WINDOW_MS)))
      .orderBy(desc(llmCalls.finishedAt))
      .get();
    return usage.cacheReadTokens === null ? null : prev !== undefined && usage.cacheReadTokens === 0;
  }

  const usageColumns = (usage: LlmUsage, rateLimit: RateLimitInfo | undefined, meta: CallMeta, cacheMissUnexpected: boolean | null) => ({
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thinkingTokens,
    costUsdApiEquivEst: usage.costUsdApiEquivEst,
    durationMs: usage.durationMs,
    durationApiMs: usage.durationApiMs,
    ttftMs: meta.ttftMs,
    cacheMissUnexpected,
    rateLimitJson: rateLimit ? JSON.stringify(rateLimit) : null,
    errorDetail: meta.warnings?.length ? `warning: ${meta.warnings.join('; ')}`.slice(0, 2048) : null,
  });

  /** Usage of a call whose output is being repaired: recorded on its row WITHOUT a status change (it stays running). */
  function recordCall(callRunId: string, usage: LlmUsage, rateLimit: RateLimitInfo | undefined, meta: CallMeta): void {
    db.update(llmCalls).set(usageColumns(usage, rateLimit, meta, cacheMiss(callRunId, usage, meta, Date.now()))).where(eq(llmCalls.runId, callRunId)).run();
  }

  type CommitOutcome = { kind: 'stored'; done: SseData<'run.done'> } | { kind: 'owner_deleted' };

  /**
   * The terminal transaction of a valid result (call row, parent row, sink). The sink decides first: `stored` → the
   * rows become `ok` and run.done's data is returned; `owner_deleted` → nothing is stored, the rows end `cancelled` with
   * errorCode result_deleted (the call's usage kept) and the sink's failure writes run (B-CX-2). Throws on any failure.
   */
  function commitResult(run: Run, callRunId: string, text: string, prepared: Prepared, usage: LlmUsage, rateLimit: RateLimitInfo | undefined, meta: CallMeta): CommitOutcome {
    const finishedAt = Date.now();
    const cols = usageColumns(usage, rateLimit, meta, cacheMiss(callRunId, usage, meta, finishedAt));
    let sink = OWNER_DELETED as SinkCommit;
    db.transaction((tx) => {
      sink = sinkCommit(tx, run, prepared, text, finishedAt);
      if (sink.kind === 'owner_deleted') {
        const set = { status: errorStatus('result_deleted'), errorCode: 'result_deleted', errorDetail: 'the result arrived after its owner was deleted; it was not stored', finishedAt };
        tx.update(llmCalls).set({ ...cols, ...set }).where(eq(llmCalls.runId, callRunId)).run();
        if (callRunId !== run.runId) tx.update(llmCalls).set({ ...set, rateLimitJson: cols.rateLimitJson }).where(eq(llmCalls.runId, run.runId)).run();
        sinkFail(tx, run, 'result_deleted', '');
        return;
      }
      tx.update(llmCalls).set({ status: 'ok', finishedAt, ...cols }).where(eq(llmCalls.runId, callRunId)).run();
      if (callRunId !== run.runId) tx.update(llmCalls).set({ status: 'ok', finishedAt, rateLimitJson: cols.rateLimitJson }).where(eq(llmCalls.runId, run.runId)).run();
    });
    if (sink.kind === 'owner_deleted') return sink;
    // A superseded run still retained in memory would replay its old answer; drop it so every replay says superseded.
    for (const id of sink.superseded) evict(id);
    const body = prepared.kind === 'message' || prepared.kind === 'study_path' || prepared.kind === 'overview' ? { parsed: prepared.parsed, citations: prepared.cites, stats: prepared.stats } : prepared.kind === 'card' ? { parsed: prepared.parsed, citations: [], stats: null } : { parsed: prepared.parsed, citations: prepared.cites, stats: null };
    return { kind: 'stored', done: { text, ...body, usage, ...(rateLimit ? { rateLimit } : {}) } };
  }

  // ---------------------------------------------------------------------------------------------------------
  const status: RunRegistry['status'] = (runId) => db.select({ status: llmCalls.status }).from(llmCalls).where(eq(llmCalls.runId, runId)).get()?.status ?? null;
  const registry: RunRegistry = {
    findExisting,
    get: (runId) => {
      const r = runs.get(runId);
      return r ? handleOf(r, false) : null;
    },
    status,
    cancel: (runId): CancelResult => {
      const r = runs.get(runId);
      if (r && active.has(r) && !r.terminal) {
        r.abort.abort();
        return 'cancelled';
      }
      return status(runId) === null ? 'unknown' : 'already_terminal';
    },
  };
  return { runTask, runs: registry, queue, inspect: { heldInput: (runId) => runs.get(runId)?.input } };
}

/** Stored citations of one message (ordinal order), as the Citation DTO (citationStore.readCitations for messages). */
export function readCitations(db: Db, messageId: string): Citation[] {
  return readOwnerCitations(db, 'message', messageId);
}

/**
 * A message answer parsed for storage and replay: SP-Markup tasks get parseAnswer plus one fixed issue per missing
 * heading (equation_deep — PLAN_M2 3.5: stored as it is, issue only; headings.ts). null for plain-text tasks.
 */
function parseMessageAnswer(task: TaskId, text: string): ParsedAnswer | null {
  if (TASK_SPECS[task]?.output !== 'sp-markup') return null;
  const parsed = parseAnswer(text, { final: true });
  const missing = headingIssues(task, text);
  return missing.length ? { ...parsed, issues: [...parsed.issues, ...missing] } : parsed;
}
