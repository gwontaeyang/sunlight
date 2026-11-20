// A test adapter for the late-result races (Codex M-M2-1 / M-M2-2, coordinator notes 추가 지시 4 B-CX-1·B-CX-2). Owner B.
//
// A gated call sends 'started' and one text delta (PRE_DELETE_TEXT, the "already streamed" part a new subscriber must
// not see once the result is gone), then waits for release(). With `ignoreAbort` it then answers its normal result even
// if the run was cancelled meanwhile (a CLI that ignores the kill, or a result that was already on its way); without it,
// an abort ends the call with the adapter's cancel error (the existing cancel path) carrying the streamed text. A call
// without a gate streams its output and answers it. The result's usage is the fixed USAGE (the tests check it is kept).
// holdAfterResult(n) keeps call n's iterator open after its result until released (an adapter that still awaits
// something after its terminal event — the run has committed but is still in the active set; B-F2-02).
import type { TaskId } from '@study-paper/shared/contracts/tasks';
import type { LlmUsage } from '@study-paper/shared/contracts/domain';
import type { LlmAdapter, LlmEvent, LlmHealth, LlmRunRequest } from '../../src/llm/adapter';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';

export const PRE_DELETE_TEXT = 'PRE_DELETE_MODEL_TEXT ';
export const USAGE: LlmUsage = { inputTokens: 123, cacheReadTokens: 7, cacheCreationTokens: 5, outputTokens: 45, thinkingTokens: null, costUsdApiEquivEst: 0.01, durationMs: 1000, durationApiMs: 900 };

interface Gate {
  ignoreAbort: boolean;
  started: () => void;
  release: Promise<void>;
}

export class GateAdapter implements LlmAdapter {
  readonly mode = 'mock' as const;
  readonly calls: TaskId[] = [];
  private readonly outputs: string[] = [];
  private readonly gates = new Map<number, Gate>();
  private readonly afterResult = new Map<number, { resulted: () => void; release: Promise<void> }>();
  private readonly inner = new MockLlmAdapter({ chunkDelayMs: 0 });

  /** The next calls answer these texts, in order (then the shared mock output of the task). */
  queueOutputs(...texts: string[]): void {
    this.outputs.push(...texts);
  }

  /** Gates the call with this 1-based number (counted over the adapter's life — 2 = the repair call of a first run). */
  gateCall(n: number, o: { ignoreAbort: boolean }): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const releaseP = new Promise<void>((r) => (release = r));
    this.gates.set(n, { ignoreAbort: o.ignoreAbort, started, release: releaseP });
    return { started: startedP, release };
  }

  /** Call n (1-based) yields its result, then waits for release() before its iterator ends. */
  holdAfterResult(n: number): { resulted: Promise<void>; release: () => void } {
    let release!: () => void;
    let resulted!: () => void;
    const resultedP = new Promise<void>((r) => (resulted = r));
    const releaseP = new Promise<void>((r) => (release = r));
    this.afterResult.set(n, { resulted, release: releaseP });
    return { resulted: resultedP, release };
  }

  /** The output a normal call of this request answers (the queued text, else the mock fixture for the request). */
  private async outputFor(req: LlmRunRequest): Promise<string> {
    const queued = this.outputs.shift();
    if (queued !== undefined) return queued;
    for await (const ev of this.inner.run({ ...req, signal: new AbortController().signal })) if (ev.type === 'result') return ev.text;
    throw new Error('mock adapter gave no result');
  }

  async *run(req: LlmRunRequest): AsyncIterable<LlmEvent> {
    this.calls.push(req.task);
    const n = this.calls.length;
    const gate = this.gates.get(n);
    const text = await this.outputFor(req);
    yield { type: 'started', modelResolved: `mock-${req.model}`, cliVersion: 'mock' };
    if (gate) {
      yield { type: 'text', delta: PRE_DELETE_TEXT };
      gate.started();
      if (gate.ignoreAbort) await gate.release;
      else await Promise.race([gate.release, new Promise<void>((r) => (req.signal.aborted ? r() : req.signal.addEventListener('abort', () => r(), { once: true })))]);
      if (req.signal.aborted && !gate.ignoreAbort) {
        yield { type: 'error', code: 'cancelled', message: 'cancelled', retryable: false, partialText: PRE_DELETE_TEXT };
        return;
      }
    } else {
      yield { type: 'text', delta: text };
    }
    yield { type: 'result', text, usage: USAGE };
    const after = this.afterResult.get(n);
    if (after) {
      after.resulted();
      await after.release;
    }
  }

  health(): Promise<LlmHealth> {
    return Promise.resolve({ cliFound: true, cliVersion: 'mock', loggedIn: null, detail: null });
  }
}
