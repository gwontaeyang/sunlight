// Shutdown contract (PLAN 2.2, 2.4). Owner: supervisor. Everything that owns in-flight work (LLM runs with
// their `claude` children: B's runManager; ingest jobs: A's pipeline) registers a ShutdownParticipant.
//
// Order on SIGINT/SIGTERM (index.ts):
//   1. lifecycle.begin(): `signal` aborts. Participants stop taking new work (queued runs end `cancelled`).
//   2. The HTTP server stops accepting connections; open SSE streams stay open to deliver terminal events.
//   3. lifecycle.drain(SHUTDOWN_DEADLINE_MS): every participant aborts its in-flight work
//      (run → child SIGINT → 2 s → SIGKILL), waits until each child has closed AND the terminal state of each
//      run/job is written to the DB, then resolves. A participant never resolves while it still has a child
//      process or an unwritten terminal row; the deadline is the only way out.
//   4. Connections are closed, token/pid files that are ours are removed, the DB is closed, the data-dir lock is
//      released, the process exits. Rows left non-terminal by a missed deadline or a crash are marked
//      `interrupted` by startupRecovery on the next start.
// A participant must not use the DB after its drain() promise resolved.
export const SHUTDOWN_DEADLINE_MS = 6_000;
/** SIGINT → wait this long → SIGKILL for a child process (PLAN 2.4). Must be < SHUTDOWN_DEADLINE_MS. */
export const CHILD_KILL_GRACE_MS = 2_000;

export interface ShutdownParticipant {
  name: string;
  /** Number of in-flight units (runs, jobs) — for logs and tests. */
  active(): number;
  /** Abort in-flight work and resolve once children are gone and terminal rows are written. */
  drain(): Promise<void>;
}

export interface DrainReport {
  name: string;
  ok: boolean;
  activeBefore: number;
  activeAfter: number;
  ms: number;
}

export class Lifecycle {
  private readonly controller = new AbortController();
  private readonly participants: ShutdownParticipant[] = [];

  /** Aborted at step 1. New work must be refused once this is aborted. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get stopping(): boolean {
    return this.controller.signal.aborted;
  }
  register(p: ShutdownParticipant): void {
    this.participants.push(p);
  }
  begin(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
  }
  /** Steps 1 + 3. Resolves when every participant drained or the deadline passed (ok=false for those). */
  async drain(deadlineMs = SHUTDOWN_DEADLINE_MS): Promise<DrainReport[]> {
    this.begin();
    return Promise.all(
      this.participants.map(async (p): Promise<DrainReport> => {
        const t0 = Date.now();
        const activeBefore = p.active();
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), deadlineMs);
        });
        const result = await Promise.race([p.drain().then(() => 'ok' as const, () => 'failed' as const), timeout]);
        clearTimeout(timer);
        return { name: p.name, ok: result === 'ok' && p.active() === 0, activeBefore, activeAfter: p.active(), ms: Date.now() - t0 };
      }),
    );
  }
}
