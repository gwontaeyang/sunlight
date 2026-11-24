// Run contract between routes and the run owner (PLAN 2.3, 2.4; review M6, B3). Owner: supervisor.
// B implements it in runManager.ts (M1); the S0 stub in index.ts implements the same shape minimally.
// Callers: B's routes (threads, cards, …) and, in M3, A's upload (`pdf_metadata`).
//
// Rules the implementation must keep (gated tests: test/contract/m1.gate.test.ts, shutdown.test.ts):
// 1. Identity. `clientRequestId` (UUID from the client) names one run for ever: llm_calls.clientRequestId is
//    UNIQUE. The payload is RunTaskInput.identity when the caller gives one (the full request as the client sent
//    it, normalised: every field that changes meaning or storage), else task + paper + thread + inputs + image.
//    Stored as 'v2:<sha256>' for identity requests. A row from before identity v2 (no prefix) whose hash equals
//    this request's v1 hash (task + paper + thread + inputs + image) cannot be proven to be the same request: it
//    is refused with HttpError(409, 'conflict', …, details {reason:'payload_version'}) — never attached; the
//    result of that old run is in its thread. A request whose answer was replaced by a successful regenerate
//    replays run.error{code:'superseded'}.
//    Starting again with the same id and the same payload returns the existing run
//    (`attached: true`, live or finished — a finished run is replayed from the DB as run.accepted + its
//    terminal event). The same id with a different payload throws HttpError(409, 'conflict').
//    Internal follow-up calls (the single SP-Blocks repair call) get their own llm_calls row with
//    clientRequestId NULL and parentRunId = the run they belong to (M2). The PARENT row becomes terminal only in the
//    terminal transaction of the whole run — while the repair call runs it stays `running` (llm.runs.get polling and
//    the card 409 decision read it).
//    M2 additions to rule 1:
//    - result_deleted: replaying a finished SUCCESSFUL run whose result no longer exists — its owner row (message,
//      card) was deleted, its paper was deleted or is being deleted (papers.deletingAt IS NOT NULL counts as "no
//      result" for messages, cards and suggestions alike), or a stored suggestion (llm_calls.resultRaw) is not
//      usable — answers run.accepted + run.error{code:'result_deleted', retryable:false}; replaced by a successful
//      regenerate → superseded (unchanged). Suggestions are decided ONLY by resultRetention.suggestionAvailable(row,
//      paper, Date.now()). The same decision applies when a request re-attaches to a finished run still kept in
//      memory (retention 10 min / 200): right before the attach the owner rows are checked from the DB; when the
//      result is gone or superseded the DB replay is returned instead of the in-memory log (so a resend right after a
//      deletion and one after an eviction or restart get the same answer). A failed run replays its code without
//      partialText when its owner rows are gone. (Implementation: B.)
//    - A run still RUNNING (no terminal yet) is attached only after the same checks: its paper is not tombstoned
//      and its result owner row (message, card) still exists. Otherwise the request answers run.accepted +
//      run.error{code:'result_deleted', retryable:false} WITHOUT opening the run's log — nothing it streamed before
//      the deletion (run.delta) reaches the new subscriber (PLAN_M2 3.4 "tombstone = no result" extended to running
//      runs, 9절 56 · 60). The payload comparison (different → 409, legacy → 409) comes before this check.
//    - Rule 4 holds for runs whose result is not a message as well: card rows, llm_calls.resultRaw.
//    - Identity and `deep` (PLAN_M2 D31): the route builds the identity with ONE pure function per route
//      (routes/threads.ts createIdentity / messageIdentity) and passes the same value to findExisting's probe and
//      to runTask. An optional field enters the identity only when it has a value; `deep` only as
//      `...(body.deep === true ? { deep: true } : {})` — absent and false add NO key. canonical() drops only
//      undefined, so `deep: false`, `deep: body.deep ?? null` or `deep: body.deep === true` would change every hash
//      M1 stored (prefixed 'v2:' and unprefixed) and turn a plain resend into a 409.
//    - The image part of the hash is the REQUEST body's image only (imagePngBase64, canonical base64 — D32). A capture
//      stored on the owner and re-attached for a follow-up/regenerate goes in storedImagePngBase64, which is never
//      hashed (a body-only probe must reproduce the hash, also after the thread was deleted).
// 1a. Request id first (M2, D27). A route that starts a run calls runs.findExisting(probe) right after body
//    validation — BEFORE any owner lookup, readiness check, capture write or row insert — and continues only when
//    it returns null: same payload → that run (live → attach only after the paper tombstone and result-owner checks
//    of rule 1, else run.accepted + run.error{result_deleted} with no log; finished → replay), different payload →
//    HttpError 409, unknown id → null. runTask still checks the id itself (the race between two starts). There is no way to
//    attach a DIFFERENT request id to a run in progress: a card being generated answers a new id with 409
//    details {reason:'card_generating', runId, cardId} (contracts/errors.ts ConflictDetails).
//    Exception: messages.create has no paper id in its URL; when probe.paperId is absent the stored row's paperId is
//    used, and when that is NULL (the paper row was deleted: FK set null) the hash cannot be recomputed, so the
//    request replays by the row's status WITHOUT comparison, like every other replay (PLAN_M2 9절 60 · 67(c)): a
//    cancelled row → run.error{cancelled}, an ok row → run.error{result_deleted} (its paper is gone) — never the
//    answer text; no run starts.
//    M1 rows (unprefixed hash): compared exactly like comparePayload — equal to the unprefixed v2 hash → same request;
//    else, with probe.legacy, equal to the v1 hash (task = probe.legacy.task ?? the row's task) → 409
//    {reason:'payload_version', runId}; else 409.
// 2. Atomic start. The rows a run needs (thread, user message, assistant message with llmCallId = runId,
//    llm_calls row `queued`) are inserted in ONE transaction before run.accepted is emitted; a lost race on the
//    unique index means "attach to the winner", never a 500.
// 3. Events. Every subscriber sees run.accepted first, then the events in order, then exactly one terminal
//    event (run.done | run.error). subscribe() replays from the start; any number of subscribers; a subscriber
//    that stops reading does not stop the run.
// 4. Persistence. The run writes its own terminal state (message, citations, llm_calls) in one transaction,
//    after re-checking that its owner rows still exist (a deleted thread → the run ends, nothing is inserted).
//    run.done is emitted only after that transaction committed. Any failure between the adapter's result and
//    the commit (parse, citation matching, lookups, the transaction itself) ends the run with exactly one
//    run.error{code:'persist_failed', partialText: the answer} and a best-effort error state in the DB (rows a
//    broken DB could not update are `interrupted` after the next start).
//    `done` resolves after that transaction — and, with the CLI adapter, after the child process has closed.
//    M2 (PLAN_M2 9절 57 · 60 · 62): the result transaction ends `stored` or `owner_deleted`.
//    - owner_deleted (the owner row was deleted or the paper tombstoned while the run ran, without a cancel): nothing
//      is stored; the llm_calls row ends status `cancelled` + errorCode `result_deleted` with the call's usage
//      recorded, and the terminal is run.error{code:'result_deleted', retryable:false} — never run.done.
//    - A result that arrives after a cancel request (runs.cancel, the paper deletion's cancel) is not stored; the run
//      ends like the cancel path (rule 5: run.error{code:'cancelled'}, the same message / card / llm_calls status),
//      usage recorded. So a paper deletion ends its held run with run.error{cancelled}, while a resend of that id
//      during the deferred deletion answers run.accepted + run.error{result_deleted} (rule 1).
//    - A result that arrives during shutdown (rule 6, lifecycle abort and drain) likewise is not stored and ends
//      cancelled / cancelled with its usage recorded.
// 5. Cancel. Queued → removed from the queue; running → adapter aborted (child SIGINT → 2 s → SIGKILL);
//    terminal → no-op. The terminal event of a cancelled run is run.error{code:'cancelled'}.
// 6. Shutdown (lifecycle.ts). The owner registers a ShutdownParticipant: once lifecycle.signal aborts it
//    accepts no work that would spawn a child (new runs end `cancelled`), aborts queued and running runs, and
//    its drain() resolves only when every run satisfied rule 4.
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import type { LlmCallStatus } from '@study-paper/shared/contracts/domain';
import type { TaskId } from '@study-paper/shared/contracts/tasks';
import type { Db } from '../db/client';

/** Transaction handle of the run's start transaction (rule 2). */
export type RunTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Owner rows of a run (rule 2). The run owner calls `insert` INSIDE its start transaction, together with the
 * llm_calls row, so thread + messages + run exist together or not at all. `insert` may throw HttpError (the
 * transaction rolls back, nothing is started). It runs only for a NEW run: when the clientRequestId attaches to
 * an existing run it is not called.
 */
export interface RunStartRows {
  insert(tx: RunTx, runId: string): {
    threadId?: string;
    /** Assistant message (status 'streaming'); the run owner links it (llmCallId = runId) in the same transaction. */
    messageId?: string;
    /** Inputs derived inside the transaction (history, context around the selection). NOT part of the payload identity. */
    extraInputs?: Record<string, string | undefined>;
    /** Page searched first when matching quotes (the selection's page). */
    pageHint?: number;
    /**
     * Messages this run replaces (regenerate). They stay untouched until the run stores its result; the success
     * transaction deletes them (citations go with the trigger). On any other end they stay.
     */
    replaces?: string[];
    /** Messages created by this start that are deleted when the run does not succeed (a regenerate's new turn). */
    discardOnFailure?: string[];
    /** M2: id of the artifact the run produces (a card) → run.accepted.artifactId. */
    artifactId?: string;
  };
}

export interface RunTaskInput {
  /** Server-resolved location retained for confirmation, never sent to the model. */
  reviewSelection?: { page: number; start: number; quote: import('@study-paper/shared/contracts/domain').TextQuoteSelector };
  task: TaskId;
  /** UUID from the client request (rule 1). */
  clientRequestId: string;
  paperId: string | null;
  threadId?: string;
  /** Assistant message row (status 'streaming') that receives the output. */
  messageId?: string;
  /** Task inputs, serialised into the last text block (taskSerialize.ts). Part of the payload identity. */
  inputs: Record<string, string | undefined>;
  /** Image of the REQUEST body (canonical base64). Part of the payload hash. */
  imagePngBase64?: string;
  /**
   * M2: a capture stored on the owner (figure/equation thread) re-attached to the tail for a follow-up or a
   * regenerate. NOT part of the payload hash. Passing both imagePngBase64 and this throws. (Tail placement: B.)
   */
  storedImagePngBase64?: string;
  /** M2: "깊게" — the effort comes from resolveEffort(task, { deep }). Routes reject deep for tasks without deepEffort. */
  deep?: boolean;
  /**
   * Payload identity (rule 1) when given: the request as the client sent it, normalised (e.g. route, params and
   * body without clientRequestId). Must include every field that changes the meaning or the storage of the
   * request; values derived from the DB (history, the task of a regenerate) are left out. Without it the identity
   * is task + paper + thread + inputs + image.
   */
  identity?: Record<string, unknown>;
  /** Owner rows created atomically with the run (rule 2). Without it the caller's rows must already exist. */
  startRows?: RunStartRows;
}

export interface RunHandle {
  runId: string;
  /** true when this start attached to an existing run with the same clientRequestId (rule 1). */
  attached: boolean;
  /** Replays from run.accepted and follows the run until its terminal event (rule 3). */
  subscribe(): AsyncIterable<RunSseEvent>;
  /** Rule 5. */
  cancel(): void;
  /** Resolves when the terminal state is written (rule 4). Never rejects. */
  done: Promise<void>;
}

/** Starts (or attaches to) a run. Throws HttpError(409, 'conflict') for a reused id with another payload. */
export type RunTask = (input: RunTaskInput) => RunHandle;

export type CancelResult = 'cancelled' | 'already_terminal' | 'unknown';

/** Request-id probe of rule 1a: built from the request body (and path) only. */
export interface RunProbe {
  clientRequestId: string;
  /** Omitted when the URL has no paper id (messages.create): the stored row's paperId is used. */
  paperId?: string | null;
  threadId?: string;
  /** The route's identity function output — the same value runTask gets. */
  identity: Record<string, unknown>;
  /** The request body's image only (never a stored capture). */
  imagePngBase64?: string;
  /** M1 v1 hash inputs, from the body only. task omitted → the stored row's task. */
  legacy?: { inputs: Record<string, string | undefined>; task?: TaskId };
}

/** Lookup by run id for GET /llm/runs/:runId and POST /llm/runs/:runId/cancel. */
export interface RunRegistry {
  /**
   * Rule 1a: the run of this clientRequestId — same payload → its handle (live → attach, finished → replay), other
   * payload → throws HttpError(409) (payload_version details for a matching M1 row), unknown id → null.
   */
  findExisting(probe: RunProbe): RunHandle | null;
  /** Live handle, or null when the run is not in memory (finished long ago, other process, unknown id). */
  get(runId: string): RunHandle | null;
  /** DB-backed status (works after a restart); null for an unknown id. */
  status(runId: string): LlmCallStatus | null;
  cancel(runId: string): CancelResult;
}
