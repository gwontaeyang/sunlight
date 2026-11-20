// Concurrency queue for LLM runs (PLAN 2.4). Owner B.
// Two lanes: interactive (default limit 2) and background (default limit 1). While interactive work is waiting,
// no new background run starts. FIFO inside a lane. A waiting entry ends with queue_timeout after
// QUEUE_TIMEOUT_MS of its lane, or `cancelled` when its signal aborts. A slot is held until release() — the
// run manager releases it only after the child process has closed.
import { DEFAULT_CONCURRENCY, QUEUE_TIMEOUT_MS, type TaskPriority } from '@study-paper/shared/contracts/tasks';

export class QueueError extends Error {
  constructor(readonly code: 'queue_timeout' | 'cancelled') {
    super(code === 'queue_timeout' ? 'waited too long for a free slot' : 'cancelled while queued');
  }
}

export interface Slot {
  readonly lane: TaskPriority;
  /** Idempotent. */
  release(): void;
}

export interface EnqueueOptions {
  signal?: AbortSignal;
  /** Called when the entry has to wait, and again whenever its position (0 = next) changes. */
  onPosition?: (position: number) => void;
}

interface Waiter {
  lane: TaskPriority;
  resolve: (s: Slot) => void;
  reject: (e: QueueError) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
  onPosition?: (position: number) => void;
  lastPosition: number;
}

export class RunQueue {
  private readonly running: Record<TaskPriority, number> = { interactive: 0, background: 0 };
  private readonly waiting: Record<TaskPriority, Waiter[]> = { interactive: [], background: [] };

  constructor(
    private readonly limits: Record<TaskPriority, number> = DEFAULT_CONCURRENCY,
    private readonly timeouts: Record<TaskPriority, number> = QUEUE_TIMEOUT_MS,
  ) {}

  stats() {
    return { running: { ...this.running }, waiting: { interactive: this.waiting.interactive.length, background: this.waiting.background.length } };
  }

  enqueue(lane: TaskPriority, opts: EnqueueOptions = {}): Promise<Slot> {
    if (opts.signal?.aborted) return Promise.reject(new QueueError('cancelled'));
    if (this.canStart(lane) && this.waiting[lane].length === 0) return Promise.resolve(this.take(lane));
    return new Promise<Slot>((resolve, reject) => {
      const onAbort = () => this.drop(w, new QueueError('cancelled'));
      const w: Waiter = {
        lane,
        resolve,
        reject,
        timer: setTimeout(() => this.drop(w, new QueueError('queue_timeout')), this.timeouts[lane]),
        cleanup: () => {
          clearTimeout(w.timer);
          opts.signal?.removeEventListener('abort', onAbort);
        },
        onPosition: opts.onPosition,
        lastPosition: -1,
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting[lane].push(w);
      this.reportPositions();
    });
  }

  private canStart(lane: TaskPriority): boolean {
    if (this.running[lane] >= this.limits[lane]) return false;
    // Interactive work waiting → hold back new background starts.
    if (lane === 'background' && this.waiting.interactive.length > 0) return false;
    return true;
  }

  private take(lane: TaskPriority): Slot {
    this.running[lane]++;
    let released = false;
    return {
      lane,
      release: () => {
        if (released) return;
        released = true;
        this.running[lane]--;
        this.pump();
      },
    };
  }

  private drop(w: Waiter, e: QueueError) {
    const list = this.waiting[w.lane];
    const i = list.indexOf(w);
    if (i < 0) return;
    list.splice(i, 1);
    w.cleanup();
    w.reject(e);
    this.pump();
  }

  private pump() {
    for (const lane of ['interactive', 'background'] as const) {
      while (this.waiting[lane].length > 0 && this.canStart(lane)) {
        const w = this.waiting[lane].shift()!;
        w.cleanup();
        w.resolve(this.take(lane));
      }
    }
    this.reportPositions();
  }

  private reportPositions() {
    for (const lane of ['interactive', 'background'] as const) {
      this.waiting[lane].forEach((w, i) => {
        if (w.lastPosition !== i) {
          w.lastPosition = i;
          w.onPosition?.(i);
        }
      });
    }
  }
}
