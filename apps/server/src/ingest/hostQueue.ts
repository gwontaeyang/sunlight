// Per-host request spacing (PLAN 4.1). Owner A.
// arxiv.org and export.arxiv.org share ONE queue: at most 1 request in flight, and a request starts no earlier
// than MIN_GAP after the previous one started (and never before it finished). A "request" is the whole task
// passed to run(): for a download that includes reading the body, so a slow PDF keeps the slot.
// Timers use setTimeout/Date.now, so tests drive the queue with vi.useFakeTimers() (or inject now + sleep).
//
// Shared cooldown (M1.1 review N5): a task that learns the host is rate-limiting / overloaded (429/503 with or
// without Retry-After, a timeout) sets cooldown(host, until) BEFORE it gives the slot back, so every later task
// of the group, from any job, starts no earlier than `until` (and still >= MIN_GAP after the previous start).
// A waiting task can refuse a cooldown that is longer than it may wait (maxCooldownWaitMs) or that ends after its
// deadline: run() then rejects with QueueWaitRefusedError instead of sleeping.
//
// Persistence (PLAN_M2 D28, M2): with a CooldownStore every extension of a group's cooldown is saved (cooldownStore.ts,
// settings key ingest.cooldown.<group>) and the constructor restores it, so a restart never shortens what the server
// asked for. The value is never capped: Retry-After 86400 keeps the group closed for 24 h; a non-finite or
// out-of-range value (Retry-After with hundreds of digits) means "indefinite" (notBefore = Infinity) until the time
// passes — never — or the user starts the server once with SP_ARXIV_COOLDOWN_RESET=1. Long waits are slept in chunks
// of at most MAX_TIMER_MS (Node fires longer setTimeout delays at once); every chunk re-evaluates the cooldown.

export const ARXIV_MIN_GAP_MS = 3_000;

export interface QueueGroup {
  name: string;
  concurrency: 1;
  minGapMs: number;
}

/** Longest single setTimeout delay Node honours (2^31 - 1 ms); longer waits are slept in chunks. */
export const MAX_TIMER_MS = 2_147_483_647;

const ARXIV_GROUP: QueueGroup = { name: 'arxiv', concurrency: 1, minGapMs: ARXIV_MIN_GAP_MS };
const HOST_GROUPS: Record<string, QueueGroup> = { 'arxiv.org': ARXIV_GROUP, 'export.arxiv.org': ARXIV_GROUP };

export function groupForHost(host: string): QueueGroup {
  const g = HOST_GROUPS[host.toLowerCase()];
  if (!g) throw new Error(`no request queue for host ${host}`);
  return g;
}

export class QueueAbortedError extends Error {
  constructor(reason: unknown) {
    super(`request cancelled before it started: ${reason instanceof Error ? reason.message : String(reason ?? 'aborted')}`);
    this.name = 'AbortError';
  }
}

interface GroupState {
  /** Tail of the chain: resolves when the previous task finished. */
  tail: Promise<void>;
  lastStart: number;
  pending: number;
  /** Shared cooldown: no task of the group starts before this (epoch ms), and why. */
  notBefore: number;
  cooldownCause: string | null;
  /** A stored row may exist for this cooldown (saved or restored and not yet expired). */
  stored: boolean;
}

export interface Cooldown {
  until: number;
  cause: string;
}

/**
 * Where a group's cooldown survives a restart (cooldownStore.ts). restore() applies the restore rules (expired row →
 * deleted → null; unreadable row → deleted + a conservative short cooldown) and returns the cooldown to start with;
 * save() stores the given until (Infinity = indefinite) — it never throws (a failed save only logs).
 */
export interface CooldownStore {
  restore(group: string, now: number): Cooldown | null;
  save(group: string, cooldown: Cooldown, now: number): void;
  /** The stored cooldown has passed (a task is about to start): delete its row if it is not newer. */
  expire(group: string, now: number): void;
}

export interface HostQueueOptions {
  store?: CooldownStore;
}

export interface RunOptions {
  /** Called before sleeping on a shared cooldown (not for the plain MIN_GAP spacing). */
  onCooldownWait?: (waitMs: number, cooldown: Cooldown) => void;
  /** Refuse (QueueWaitRefusedError 'too_long') a cooldown wait longer than this. */
  maxCooldownWaitMs?: number;
  /** Refuse (QueueWaitRefusedError 'deadline') to start after this epoch ms. */
  deadline?: number;
}

export class QueueWaitRefusedError extends Error {
  constructor(
    readonly kind: 'too_long' | 'deadline',
    readonly waitMs: number,
    readonly cooldown: Cooldown | null,
  ) {
    super(kind === 'too_long' ? `host cooldown of ${Math.ceil(waitMs / 1000)} s (${cooldown?.cause ?? 'cooldown'})` : `the request could not start before its deadline (wait ${Math.ceil(waitMs / 1000)} s)`);
    this.name = 'QueueWaitRefusedError';
  }
}

export class HostQueue {
  private readonly groups = new Map<string, GroupState>();
  /** Start times of every task (tests and logs). */
  readonly starts: { group: string; at: number }[] = [];

  private readonly store: CooldownStore | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
    opts: HostQueueOptions = {},
  ) {
    this.store = opts.store;
    // Restore every group's stored cooldown (PLAN_M2 D28): a restart keeps the full server-given wait.
    if (this.store) {
      for (const g of new Set(Object.values(HOST_GROUPS))) {
        const cd = this.store.restore(g.name, this.now());
        if (cd) {
          const st = this.stateOf(g);
          st.notBefore = cd.until;
          st.cooldownCause = cd.cause;
          st.stored = true;
        }
      }
    }
  }

  private state(host: string): GroupState {
    return this.stateOf(groupForHost(host));
  }

  private stateOf(group: QueueGroup): GroupState {
    let st = this.groups.get(group.name);
    if (!st) {
      st = { tail: Promise.resolve(), lastStart: Number.NEGATIVE_INFINITY, pending: 0, notBefore: Number.NEGATIVE_INFINITY, cooldownCause: null, stored: false };
      this.groups.set(group.name, st);
    }
    return st;
  }

  /**
   * Extends the group's shared cooldown to `until` (never shortens it). A non-finite / NaN `until` other than
   * +Infinity is treated as +Infinity (indefinite): an unreadable server wait never becomes "no wait". Every
   * extension is saved to the store.
   */
  cooldown(host: string, until: number, cause: string): void {
    const group = groupForHost(host);
    const st = this.stateOf(group);
    const value = Number.isNaN(until) ? Number.POSITIVE_INFINITY : until;
    if (value > st.notBefore) {
      st.notBefore = value;
      st.cooldownCause = cause;
      if (this.store) {
        this.store.save(group.name, { until: value, cause }, this.now());
        st.stored = true;
      }
    }
  }

  /** The active cooldown of the host's group, or null. */
  cooldownOf(host: string): Cooldown | null {
    const st = this.state(host);
    return st.notBefore > this.now() ? { until: st.notBefore, cause: st.cooldownCause ?? 'cooldown' } : null;
  }

  /** Number of tasks waiting or running in the host's group. */
  pending(host: string): number {
    return this.groups.get(groupForHost(host).name)?.pending ?? 0;
  }

  /**
   * Runs `task` in the host's group (FIFO). Rejects without running when `signal` aborts while waiting, or with
   * QueueWaitRefusedError when the shared cooldown is longer than `opts` allow.
   */
  run<T>(host: string, task: () => Promise<T>, signal?: AbortSignal, opts: RunOptions = {}): Promise<T> {
    const group = groupForHost(host);
    const state = this.state(host);
    state.pending++;
    const prev = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>((r) => (release = r));
    const result = (async () => {
      let started = false;
      try {
        // A cooldown already active: say so (and refuse a too-long one) before queueing behind other tasks.
        const early = state.notBefore - this.now();
        if (early > 0) {
          const cd: Cooldown = { until: state.notBefore, cause: state.cooldownCause ?? 'cooldown' };
          if (opts.maxCooldownWaitMs !== undefined && early > opts.maxCooldownWaitMs) throw new QueueWaitRefusedError('too_long', early, cd);
          if (opts.deadline !== undefined && state.notBefore > opts.deadline) throw new QueueWaitRefusedError('deadline', early, cd);
          opts.onCooldownWait?.(early, cd);
        }
        // Each distinct cooldown is reported once (a longer one set meanwhile is reported again).
        let notifiedUntil = early > 0 ? state.notBefore : Number.NEGATIVE_INFINITY;
        await abortable(prev, signal);
        // Re-evaluated after every sleep: a cooldown may only grow while we wait.
        for (;;) {
          if (signal?.aborted) throw new QueueAbortedError(signal.reason);
          const now = this.now();
          const gapWait = state.lastStart + group.minGapMs - now;
          const coolWait = state.notBefore - now;
          const wait = Math.max(gapWait, coolWait);
          if (wait <= 0) break;
          const cd: Cooldown | null = coolWait > 0 ? { until: state.notBefore, cause: state.cooldownCause ?? 'cooldown' } : null;
          if (cd && coolWait >= gapWait) {
            if (opts.maxCooldownWaitMs !== undefined && coolWait > opts.maxCooldownWaitMs) throw new QueueWaitRefusedError('too_long', coolWait, cd);
          }
          if (opts.deadline !== undefined && now + wait > opts.deadline) throw new QueueWaitRefusedError('deadline', wait, cd);
          if (cd && coolWait >= gapWait && cd.until !== notifiedUntil) {
            notifiedUntil = cd.until;
            opts.onCooldownWait?.(coolWait, cd);
          }
          await this.sleepFn(Math.min(wait, MAX_TIMER_MS), signal);
        }
        if (signal?.aborted) throw new QueueAbortedError(signal.reason);
        // The stored cooldown has passed: its row goes (a restart would delete it as well).
        if (state.stored && state.notBefore <= this.now()) {
          state.stored = false;
          this.store?.expire(group.name, this.now());
        }
        state.lastStart = this.now();
        started = true;
        this.starts.push({ group: group.name, at: state.lastStart });
        return await task();
      } finally {
        state.pending--;
        // A task that gave up while the previous one still runs must not open the slot early.
        if (started) release();
        else void prev.then(release);
      }
    })();
    return result;
  }
}

function abortable(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new QueueAbortedError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new QueueAbortedError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new QueueAbortedError(signal.reason));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new QueueAbortedError(signal!.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
