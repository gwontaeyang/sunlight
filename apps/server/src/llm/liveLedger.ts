// Live CLI call ledger (PLAN_M2 D25, BRIEF_S S6b v3.4). Owner: supervisor — frozen.
//
// With SP_LIVE_LEDGER=<dir> every real `claude` child is spawned only inside guardLiveRun — called at the one spawn
// site (claudeCli.ts runChild) — after a reservation in the ledger directory. Without the variable nothing here
// touches a file and every call passes through (normal use, mock runs, unit tests).
//
// STOP POLICY: "STOP_REQUESTED가 생긴 뒤에 lock을 잡는 호출은 spawn 0. 그 순간 이미 lock 안에서 확인을 마친 호출(lock이
// 하나라 최대 1건)만 spawn될 수 있다. STOP 확정은 lock 안에서만. 이미 돌고 있는 child는 끝까지 둔다."
// (After STOP_REQUESTED exists, a call that takes the lock spawns nothing. Only a call that had already finished its
// check inside the lock at that moment — at most one, there is one lock — may still spawn. STOP is confirmed only
// inside the lock. Children that already run are left to finish.)
// If the process ends before STOP is confirmed, STOP_REQUESTED alone still blocks every later spawn (guardLiveRun ②):
// the asynchronous retry only tidies the state up to STOP, it is not what keeps the ledger closed.
//
// Directory layout:
//   caps.json            LiveCaps (initLiveLedger, 'wx')
//   lock                 {"pid","at","nonce"} — created complete with link(2) from a temp file (never seen empty)
//   lock.break           second lock, taken (one attempt) to break a stale `lock` of a dead pid
//   breaks.log           one JSON line per broken stale lock {pid, at, brokenBy}
//   STOP_REQUESTED       first stop reason, written immediately without the lock ('wx')
//   STOP                 confirmed stop, written only inside the lock ('wx')
//   <model>.<k>          per-model reservation k = 1..caps.perModel[model] (O_EXCL)
//   total.<n>            total reservation n = 1..caps.total (O_EXCL)
//   ALLOW_RATE_WARNING   coordinator approval of the rate-limit warning exception (INTEGRATION_NOTES 결정 26):
//                        {"approvedBy","reason","at"} ('wx'), made only by `live-e2e.ts init --allow-rate-warning`
//   rate_warnings.jsonl  one JSON line per allowed_warning that did NOT stop the ledger because of that approval: every
//                        such rate_limit event (a run can have several), or the result when its run recorded no event
// Reservations are never returned: a spawn that failed or died at once still counts (never under-count).
// guardLiveRun's section (lock → caps → STOP/STOP_REQUESTED → reserve model → reserve total → spawnFn → unlock) is
// synchronous: waiting for the lock uses Atomics.wait (10 ms steps, ≤ lockWaitMs) and blocks the event loop; the
// section itself holds the lock for milliseconds (spawn returns at once). A pid that looks alive (pid reuse included)
// is never broken automatically: after the wait the call ends `ledger_locked` (no spawn, no reservation) and a person
// runs `npx tsx scripts/live-ledger.ts unlock <dir>` after checking that no holder exists. Assumption: one ledger
// directory is used from one host / one PID namespace.
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, constants, existsSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { RateLimitInfo } from '@study-paper/shared/contracts/domain';
import { ModelAlias, type TaskId } from '@study-paper/shared/contracts/tasks';
import type { LlmEvent } from './adapter';

export const LiveCapsSchema = z.strictObject({
  total: z.number().int().min(0),
  perModel: z.partialRecord(ModelAlias, z.number().int().min(0)),
});
export interface LiveCaps {
  total: number;
  /** A model that is not listed has a cap of 0. */
  perModel: Partial<Record<ModelAlias, number>>;
}
export type LiveRefusal = 'no_caps' | 'stopped' | 'model_cap' | 'total_cap' | 'ledger_locked';
export const LEDGER_LOCK_WAIT_MS = 2_000;
/** Interval of the asynchronous STOP confirmation retries (each one a single attempt without waiting). */
export const STOP_RETRY_MS = 1_000;

const F = { caps: 'caps.json', lock: 'lock', lockBreak: 'lock.break', breaks: 'breaks.log', stop: 'STOP', stopRequested: 'STOP_REQUESTED' } as const;
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number) => Atomics.wait(WAIT_CELL, 0, 0, ms);

export const ledgerDir = (): string | undefined => process.env.SP_LIVE_LEDGER || undefined;

// ------------------------------------------------------------------------------------------------------------------
// lock

interface LockToken {
  path: string;
  content: string;
}

/** Creates `name` atomically WITH its content: temp file → link(2) (EEXIST = taken) → unlink temp. */
function tryCreateLock(dir: string, name: string): LockToken | null {
  const content = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: randomBytes(8).toString('hex') });
  const tmp = join(dir, `${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(tmp, join(dir, name));
    return { path: join(dir, name), content };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
}

function releaseLock(t: LockToken): void {
  try {
    if (readFileSync(t.path, 'utf8') === t.content) unlinkSync(t.path);
  } catch {
    /* gone already (broken as stale or unlocked by a person) */
  }
}

const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

function holderOf(content: string | null): { pid: number; at: number } | null {
  if (content === null) return null;
  try {
    const v = JSON.parse(content) as { pid?: unknown; at?: unknown };
    return typeof v.pid === 'number' && typeof v.at === 'number' ? { pid: v.pid, at: v.at } : null;
  } catch {
    return null;
  }
}

function pidIsDead(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** One attempt to break a stale lock (dead holder) under lock.break, re-reading the lock before removing it. */
function tryBreakStale(dir: string, seen: string): void {
  const b = tryCreateLock(dir, F.lockBreak);
  if (!b) return; // someone else is breaking it, or a lock.break was left behind (→ ledger_locked until unlock)
  try {
    const lockPath = join(dir, F.lock);
    const now = readText(lockPath);
    const holder = holderOf(now);
    if (now === seen && holder && pidIsDead(holder.pid)) {
      unlinkSync(lockPath);
      appendFileSync(join(dir, F.breaks), `${JSON.stringify({ pid: holder.pid, at: holder.at, brokenBy: process.pid })}\n`);
    }
  } finally {
    releaseLock(b);
  }
}

/** Takes the ledger lock within waitMs (synchronously). null = not taken. */
function acquireLock(dir: string, waitMs: number): LockToken | null {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const t = tryCreateLock(dir, F.lock);
    if (t) return t;
    const seen = readText(join(dir, F.lock));
    const holder = holderOf(seen);
    if (seen !== null && holder && pidIsDead(holder.pid)) {
      tryBreakStale(dir, seen);
      const again = tryCreateLock(dir, F.lock);
      if (again) return again;
    }
    if (Date.now() >= deadline) return null;
    sleepSync(Math.min(10, Math.max(1, deadline - Date.now())));
  }
}

// ------------------------------------------------------------------------------------------------------------------
// caps, reservations

// A malformed FIFO or device must not block the verdict indefinitely. Inspect the opened file itself.
function readLedgerFile(dir: string, name: string): string {
  const fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${name} is not a regular file`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function loadCaps(dir: string): LiveCaps {
  const raw = readLedgerFile(dir, F.caps);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${F.caps} is not valid JSON`);
  }
  const parsed = LiveCapsSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${F.caps} has invalid caps`);
  return parsed.data;
}

function readCaps(dir: string): LiveCaps | null {
  try {
    return loadCaps(dir);
  } catch {
    return null;
  }
}

/** Creates the first free `<prefix>.<k>` (k = 1..cap) with O_EXCL. */
function reserve(dir: string, prefix: string, cap: number, record: string): boolean {
  for (let k = 1; k <= cap; k++) {
    try {
      const fd = openSync(join(dir, `${prefix}.${k}`), 'wx', 0o600);
      try {
        writeFileSync(fd, record);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  return false;
}

/** Order-independent form of caps for comparison: total + every model alias in a fixed order (unlisted = 0). */
const capsKey = (c: LiveCaps): string => JSON.stringify([c.total, ...ModelAlias.options.map((m) => c.perModel[m] ?? 0)]);

/**
 * Creates a ledger: the directory and caps.json ('wx'). An existing ledger with the same caps (compared by value:
 * key order and an explicit 0 for an unlisted model do not matter) is fine; other caps throw.
 */
export function initLiveLedger(dir: string, caps: LiveCaps): void {
  const parsed = LiveCapsSchema.parse(caps);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, F.caps);
  const text = JSON.stringify(parsed);
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const existing = readCaps(dir);
    if (!existing || capsKey(existing) !== capsKey(parsed)) throw new Error(`live ledger ${dir} already exists with other caps`);
  }
}

/**
 * The spawn gate. Without SP_LIVE_LEDGER: { ok: true, value: spawnFn() } and no file is touched. With it, one
 * synchronous section: lock (a missing ledger directory → no_caps) → caps.json (no_caps) → STOP or STOP_REQUESTED (stopped) → model reservation (model_cap)
 * → total reservation (total_cap; the model slot stays used) → spawnFn() → unlock (finally). A refusal never calls
 * spawnFn. When spawnFn throws, the reservation stays, the lock is released and the error propagates.
 */
export function guardLiveRun<T>(model: ModelAlias, info: { runId: string; task: TaskId }, spawnFn: () => T, opts: { lockWaitMs?: number; expectedCaps?: LiveCaps } = {}): { ok: true; value: T } | { ok: false; reason: LiveRefusal } {
  const dir = ledgerDir();
  if (!dir) return opts.expectedCaps ? { ok: false, reason: 'no_caps' } : { ok: true, value: spawnFn() };
  let lock: LockToken | null;
  try {
    lock = acquireLock(dir, opts.lockWaitMs ?? LEDGER_LOCK_WAIT_MS);
  } catch (e) {
    // SP_LIVE_LEDGER names a directory that does not exist (a typo, or not initialised): there are no caps to
    // read — the same refusal as a missing caps.json, not a CLI spawn failure.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'no_caps' };
    throw e;
  }
  if (!lock) return { ok: false, reason: 'ledger_locked' };
  try {
    const caps = readCaps(dir);
    if (!caps || (opts.expectedCaps && capsKey(caps) !== capsKey(opts.expectedCaps))) return { ok: false, reason: 'no_caps' };
    if (existsSync(join(dir, F.stop)) || existsSync(join(dir, F.stopRequested))) return { ok: false, reason: 'stopped' };
    const record = JSON.stringify({ runId: info.runId, task: info.task, model, pid: process.pid, at: Date.now() });
    if (!reserve(dir, model, caps.perModel[model] ?? 0, record)) return { ok: false, reason: 'model_cap' };
    if (!reserve(dir, 'total', caps.total, record)) return { ok: false, reason: 'total_cap' };
    return { ok: true, value: spawnFn() };
  } finally {
    releaseLock(lock);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// stop

const retries = new Map<string, NodeJS.Timeout>();
let lifecycleSignal: AbortSignal | undefined;

/** index.ts binds the server lifecycle: pending STOP confirmation retries end when it aborts. */
export function bindLiveLedgerLifecycle(signal: AbortSignal): void {
  lifecycleSignal = signal;
  signal.addEventListener(
    'abort',
    () => {
      for (const t of retries.values()) clearInterval(t);
      retries.clear();
    },
    { once: true },
  );
}

function writeOnce(path: string, text: string): void {
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/** One confirmation attempt: STOP present → true; else take the lock (waitMs), write STOP inside it. */
function confirmStop(dir: string, reason: string, waitMs: number): boolean {
  if (existsSync(join(dir, F.stop))) return true;
  const lock = acquireLock(dir, waitMs);
  if (!lock) return false;
  try {
    writeOnce(join(dir, F.stop), reason);
    return true;
  } finally {
    releaseLock(lock);
  }
}

/**
 * Two steps (Codex M-R3-1 — there is no STOP written outside the lock):
 * 1. STOP_REQUESTED ('wx', first reason kept) at once, without the lock — from here every call that takes the lock
 *    is refused.
 * 2. STOP ('wx') inside the ledger lock → 'stopped'. An existing STOP (EEXIST) also counts as confirmed (idempotent).
 *    Lock not taken within lockWaitMs → 'stop_pending' and an unref'd retry every STOP_RETRY_MS, each a single
 *    attempt without waiting (lockWaitMs 0; a stale lock of a dead pid is broken within it). The retry ends when STOP
 *    exists (whoever wrote it) or the bound lifecycle aborts; one retry per process and directory.
 */
export function stopLiveLedger(dir: string, reason: string, opts: { lockWaitMs?: number } = {}): { status: 'stopped' | 'stop_pending' } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeOnce(join(dir, F.stopRequested), reason);
  if (confirmStop(dir, reason, opts.lockWaitMs ?? LEDGER_LOCK_WAIT_MS)) return { status: 'stopped' };
  if (!retries.has(dir) && !lifecycleSignal?.aborted) {
    const t = setInterval(() => {
      let done = false;
      try {
        done = confirmStop(dir, reason, 0);
      } catch {
        done = false;
      }
      if (done || lifecycleSignal?.aborted) {
        clearInterval(t);
        retries.delete(dir);
      }
    }, STOP_RETRY_MS);
    t.unref();
    retries.set(dir, t);
  }
  return { status: 'stop_pending' };
}

// ------------------------------------------------------------------------------------------------------------------
// rate-limit warning exception (INTEGRATION_NOTES 결정 26 — user-approved)
//
// Without the approval file nothing changes: every rate-limit status other than 'allowed' stops the ledger. With a
// valid <ledger>/ALLOW_RATE_WARNING, a status of exactly 'allowed_warning' (a rate_limit event, or a successful result
// carrying it) does not stop the ledger: it is recorded (server log line + rate_warnings.jsonl) and the calls go on.
// 'rejected', every other status that is not 'allowed', and a terminal rate_limited error still stop it, approval or
// not. The caps (total and per model) are untouched: the approval never adds a call.

/** The one status the approval lets through. */
export const RATE_WARNING_STATUS = 'allowed_warning';
export const RATE_WARNING_APPROVAL_FILE = 'ALLOW_RATE_WARNING';
export const RATE_WARNINGS_FILE = 'rate_warnings.jsonl';
export const RateWarningApprovalSchema = z.strictObject({
  approvedBy: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
  at: z.string().min(1).max(64),
});
export type RateWarningApproval = z.infer<typeof RateWarningApprovalSchema>;
/** One line of rate_warnings.jsonl. */
export interface RateWarningRecord {
  at: string;
  /** 'event' = the CLI's rate_limit event; 'result' = a successful result with the warning status (no event recorded). */
  source: 'event' | 'result';
  status: string;
  utilization: number | null;
  resetsAt: number | null;
  rateLimitType: string | null;
  runId: string | null;
}

/**
 * The approval of `dir`, or null: no file, or a file that is not exactly {approvedBy, reason, at} (a damaged approval
 * is no approval — the ledger then stops on the warning as without it).
 */
export function readRateWarningApproval(dir: string): RateWarningApproval | null {
  const raw = readText(join(dir, RATE_WARNING_APPROVAL_FILE));
  if (raw === null) return null;
  try {
    const parsed = RateWarningApprovalSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Writes the approval into an initialised ledger (caps.json readable) with 'wx'. An existing valid approval is kept
 * (the first one stays, like STOP) and returned; an existing damaged one throws. Only `live-e2e.ts init
 * --allow-rate-warning` calls it.
 */
export function allowRateWarning(dir: string, approval: RateWarningApproval): RateWarningApproval {
  const parsed = RateWarningApprovalSchema.parse(approval);
  if (!readCaps(dir)) throw new Error(`live ledger ${dir} has no caps (initialise it first)`);
  try {
    writeFileSync(join(dir, RATE_WARNING_APPROVAL_FILE), JSON.stringify(parsed), { flag: 'wx', mode: 0o600 });
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const existing = readRateWarningApproval(dir);
    if (!existing) throw new Error(`live ledger ${dir} has a damaged ${RATE_WARNING_APPROVAL_FILE}`);
    return existing;
  }
}

/** The rate_warnings.jsonl lines of `dir` ([] when there is none; a torn or foreign line is skipped). */
export function readRateWarnings(dir: string): RateWarningRecord[] {
  const raw = readText(join(dir, RATE_WARNINGS_FILE));
  if (raw === null) return [];
  const out: RateWarningRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v = JSON.parse(line) as RateWarningRecord;
      if (v !== null && typeof v === 'object' && typeof v.status === 'string' && typeof v.at === 'string') out.push(v);
    } catch {
      /* torn by a kill mid-write */
    }
  }
  return out;
}

/**
 * What one rate-limit state means for the ledger: 'continue' (no status, or 'allowed'), 'warning_allowed' (exactly
 * 'allowed_warning' and the ledger carries a valid approval), 'stop' (everything else). watchLiveRun's rule;
 * smoke-live.ts applies the same exception to its own terminal check (RATE_WARNING_STATUS + readRateWarningApproval).
 */
export function rateLimitVerdict(r: RateLimitInfo | undefined, approved: boolean): 'continue' | 'warning_allowed' | 'stop' {
  if (r === undefined || r.status === null || r.status === undefined || r.status === 'allowed') return 'continue';
  return approved && r.status === RATE_WARNING_STATUS ? 'warning_allowed' : 'stop';
}

function recordRateWarning(dir: string, source: RateWarningRecord['source'], r: RateLimitInfo, runId: string | null): void {
  const rec: RateWarningRecord = { at: new Date().toISOString(), source, status: r.status ?? '', utilization: r.sevenDayUtilization, resetsAt: r.resetsAt, rateLimitType: r.rateLimitType, runId };
  appendFileSync(join(dir, RATE_WARNINGS_FILE), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  console.log(`[study_paper] live ledger: rate limit ${rec.status} allowed by ${RATE_WARNING_APPROVAL_FILE} (no stop) run=${runId ?? '-'} utilization=${rec.utilization ?? '-'} resetsAt=${rec.resetsAt ?? '-'} type=${rec.rateLimitType ?? '-'}`);
}

/**
 * Passes every event through unchanged; with SP_LIVE_LEDGER set it also stops the ledger on (1) a rate_limit event
 * whose status is not 'allowed' — at once, before any terminal — and (2) a terminal rate_limited error or a result
 * whose rateLimit status is not 'allowed'. Calling stop twice in one run is fine (idempotent).
 * Exception (결정 26): with a valid ALLOW_RATE_WARNING in the ledger (read at each such event), a status of exactly
 * 'allowed_warning' does not stop — it is recorded: one line for EVERY such rate_limit event of the run (a run can see
 * several, e.g. a seven_day and a five_hour warning), and one for the result only when no event of the run was recorded
 * (the result repeats the last event's state). `utilization` is the seven-day window's value whatever the
 * rateLimitType. A warning that cannot be recorded stops the ledger as without the approval. 'rejected', any other status
 * and a terminal rate_limited error stop as above. `info.runId` only labels the record.
 */
export function watchLiveRun(events: AsyncIterable<LlmEvent>, info: { runId?: string } = {}): AsyncIterable<LlmEvent> {
  const dir = ledgerDir();
  if (!dir) return events;
  return (async function* () {
    let warned = false;
    const onLimit = (r: RateLimitInfo | undefined, source: RateWarningRecord['source']) => {
      const v = rateLimitVerdict(r, r?.status === RATE_WARNING_STATUS && readRateWarningApproval(dir) !== null);
      if (v === 'stop') stopLiveLedger(dir, `rate_limit: ${r!.status}`);
      else if (v === 'warning_allowed' && !(source === 'result' && warned)) {
        try {
          recordRateWarning(dir, source, r!, info.runId ?? null);
          warned = true;
        } catch (e) {
          console.error(`[liveLedger] could not record the allowed rate-limit warning (${(e as Error).message}): stopping as without the approval`);
          stopLiveLedger(dir, `rate_limit: ${r!.status} (the allowed warning could not be recorded)`);
        }
      }
    };
    for await (const ev of events) {
      try {
        if (ev.type === 'rate_limit') onLimit(ev.rateLimit, 'event');
        else if (ev.type === 'error' && ev.code === 'rate_limited') stopLiveLedger(dir, 'rate_limited');
        else if (ev.type === 'result') onLimit(ev.rateLimit, 'result');
      } catch (e) {
        console.error(`[liveLedger] could not record the stop: ${(e as Error).message}`);
      }
      yield ev;
    }
  })();
}

// ------------------------------------------------------------------------------------------------------------------
// inspection (scripts/live-ledger.ts)

// A listed marker still stops the run if its contents cannot be read. Try reading even an unlisted marker:
// STOP_REQUESTED may have been published since readdir. Only ENOENT for an unlisted marker means absent.
function readStopMarker(dir: string, name: string, entries: readonly string[]): string | null {
  try {
    return readLedgerFile(dir, name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !entries.includes(name)) return null;
    return `could not read ${name} (${code ?? (error instanceof Error ? error.message : 'I/O error')})`;
  }
}

/** Pass expectedCaps for a verdict: a missing directory or missing, unreadable or different caps throws.
 * The inspection CLI can still display uninitialised ledgers without making a verdict. */
export function readLiveLedger(dir: string, expectedCaps?: LiveCaps): {
  caps: LiveCaps | null;
  used: { total: number; perModel: Record<string, number> };
  stopped: string | null;
  stopRequested: string | null;
  lock: { pid: number; at: number } | null;
} {
  const entries = expectedCaps || existsSync(dir) ? readdirSync(dir) : [];
  const perModel: Record<string, number> = {};
  let total = 0;
  for (const f of entries) {
    const m = /^([a-z]+)\.(\d+)$/.exec(f);
    if (!m) continue;
    if (m[1] === 'total') total++;
    else if ((ModelAlias.options as readonly string[]).includes(m[1]!)) perModel[m[1]!] = (perModel[m[1]!] ?? 0) + 1;
  }
  const stopped = readStopMarker(dir, F.stop, entries);
  const stopRequested = readStopMarker(dir, F.stopRequested, entries);
  const caps = expectedCaps ? loadCaps(dir) : readCaps(dir);
  if (expectedCaps && (!caps || capsKey(caps) !== capsKey(expectedCaps))) throw new Error(`${F.caps} differs from the expected live caps`);
  return { caps, used: { total, perModel }, stopped, stopRequested, lock: holderOf(readText(join(dir, F.lock))) };
}

/** Removes `lock` and `lock.break` (a person checked that no holder exists). STOP files and reservations stay. */
export function unlockLiveLedger(dir: string): { removed: string[] } {
  const removed: string[] = [];
  for (const name of [F.lock, F.lockBreak]) {
    const p = join(dir, name);
    const content = readText(p);
    if (content === null) continue;
    try {
      unlinkSync(p);
      removed.push(`${name}: ${content}`);
    } catch {
      /* raced */
    }
  }
  return { removed };
}
