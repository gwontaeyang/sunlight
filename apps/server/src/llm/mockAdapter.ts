// SP_LLM=mock: streams shared/fixtures/mock-outputs with delays (no tokens, no network). Owner B.
// Cache numbers follow a deterministic rule instead of "always read": per adapter instance, the first request
// with a given (model, prefix) writes the prefix to the cache, later ones read it; no prefix → no cache tokens.
// Token counts are rough (PDF bytes / 100, text chars / 4) and only for display.
// M2 (BRIEF_B B9): `outputs[task]` may be an array — the calls of that task take its entries in order (then the last
// one repeats; a repair test queues an invalid and a valid output). Every request is recorded (`requests`: task and
// whether the tail starts with an image). The default glossary_define fixture answers for the REQUESTED term (its
// <term name> is set to the request's <requested_term>), as a real model is asked to; overrides are used verbatim.
import { createHash } from 'node:crypto';
import type { TaskId } from '@study-paper/shared/contracts/tasks';
import { readMockFile, readMockOutput } from '@study-paper/shared/mock-outputs';
import type { LlmAdapter, LlmEvent, LlmHealth, LlmRunRequest } from './adapter';

export interface MockLlmOptions {
  /**
   * Override outputs per task (tests). Defaults to the shared mock-output fixtures. A string answers every call of the
   * task; an array answers the calls in order (the last entry repeats).
   */
  outputs?: Partial<Record<TaskId, string | readonly string[]>>;
  /** Delay between streamed chunks (ms). */
  chunkDelayMs?: number;
  /** Characters per text delta. */
  chunkChars?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort); // do not pile up listeners on a long output
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Rough token estimate of a prefix (mock display only). */
export function mockPrefixTokens(prefix: LlmRunRequest['prefix']): number {
  let n = 0;
  for (const b of prefix) {
    if (b.type === 'text') n += Math.ceil(b.text.length / 4);
    else n += Math.ceil((b.source.data.length * 3) / 4 / 100);
  }
  return Math.max(1, n);
}

/** What a request looked like (tests: the repair tail, the image re-attached to a follow-up). */
export interface MockRequestRecord {
  task: TaskId;
  /** tail[0] is an image block. */
  image: boolean;
  /** The last text block of the tail (the <task> block). */
  taskText: string;
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** The default glossary_define answer, renamed to the requested term (when it can be an attribute value). */
function answerForTerm(text: string, req: LlmRunRequest): string {
  const last = req.tail.at(-1);
  const m = last?.type === 'text' ? /<requested_term trust="user">([\s\S]*?)<\/requested_term>/.exec(last.text) : null;
  if (!m) return text;
  const term = unescapeXml(m[1]!);
  if (/["<>]/.test(term)) return text;
  return text.replace(/^<term name="[^"]*">/, `<term name="${term.replace(/\s+/g, ' ').trim()}">`);
}

export class MockLlmAdapter implements LlmAdapter {
  readonly mode = 'mock' as const;
  /** (model, prefix) keys already written to the simulated cache. */
  private readonly cached = new Set<string>();
  /** Every request, in order. */
  readonly requests: MockRequestRecord[] = [];
  private readonly served = new Map<TaskId, number>();
  constructor(private readonly opts: MockLlmOptions = {}) {}

  /** The output of this call: the override (array entries in order) or the fixture. */
  private outputFor(req: LlmRunRequest): string {
    const o = this.opts.outputs?.[req.task];
    if (o === undefined) {
      const text = readMockOutput(req.task);
      if (req.task === 'paper_overview') {
        const tail = req.tail.at(-1);
        if (tail?.type === 'text' && tail.text.includes('<answer_language trust="app">en</answer_language>')) return readMockFile('paper_overview.en.md');
      }
      if (req.task === 'selection_questions') {
        const tail = req.tail.at(-1);
        const taskText = tail?.type === 'text' ? tail.text : '';
        const evidence = unescapeXml(/<selection [^>]*>([\s\S]*?)<\/selection>/.exec(taskText)?.[1] ?? '').slice(0, 250);
        const english = taskText.includes('<answer_language trust="app">en</answer_language>');
        const fixture = JSON.parse(text) as { cards: { frontMd: string; backMd: string; evidence: string }[] };
        return JSON.stringify({ cards: fixture.cards.map((card, i) => ({
          ...card, frontMd: english ? ['What does this passage describe?', 'How does the passage express this point?'][i] : card.frontMd,
          backMd: evidence, evidence,
        })) });
      }
      if (req.task === 'study_path') {
        const tail = req.tail.at(-1);
        const taskText = tail?.type === 'text' ? tail.text : '';
        const blocks = /```(?:cpp|python)\n[\s\S]*?\n```/g;
        const examples = (taskText.includes('<code_language trust="app">python</code_language>') ? readMockFile('study_path.python.md') : text).match(blocks)!;
        if (taskText.includes('<answer_language trust="app">en</answer_language>')) {
          return readMockFile('study_path.en.md').replace(/\{\{example_([12])\}\}/g, (_, n: string) => examples[Number(n) - 1]!);
        }
        let index = 0;
        return text.replace(blocks, () => examples[index++]!);
      }
      return req.task === 'glossary_define' ? answerForTerm(text, req) : text;
    }
    if (typeof o === 'string') return o;
    const n = this.served.get(req.task) ?? 0;
    this.served.set(req.task, n + 1);
    if (o.length === 0) throw new Error(`no mock output for ${req.task}`);
    return o[Math.min(n, o.length - 1)]!;
  }

  /** cache read/write for this request (first time per (model, prefix) = write, then read). */
  private cacheUsage(req: LlmRunRequest): { read: number; write: number } {
    if (req.prefix.length === 0) return { read: 0, write: 0 };
    const key = createHash('sha256').update(req.model).update('\0').update(JSON.stringify(req.prefix)).digest('hex');
    const tokens = mockPrefixTokens(req.prefix);
    if (this.cached.has(key)) return { read: tokens, write: 0 };
    this.cached.add(key);
    return { read: 0, write: tokens };
  }

  async *run(req: LlmRunRequest): AsyncIterable<LlmEvent> {
    const last = req.tail.at(-1);
    this.requests.push({ task: req.task, image: req.tail[0]?.type === 'image', taskText: last?.type === 'text' ? last.text : '' });
    const text = this.outputFor(req);
    const delay = this.opts.chunkDelayMs ?? 15;
    const size = this.opts.chunkChars ?? 24;
    const cancelled = (partialText: string): LlmEvent => ({ type: 'error', code: 'cancelled', message: 'cancelled', retryable: false, partialText });
    if (req.signal.aborted) {
      yield cancelled('');
      return;
    }
    yield { type: 'started', modelResolved: `mock-${req.model}`, cliVersion: 'mock' };
    await sleep(delay, req.signal);
    const cache = this.cacheUsage(req);
    yield { type: 'response_started', cacheReadTokens: cache.read, cacheCreationTokens: cache.write };
    if (req.effort === 'high') yield { type: 'thinking', estimatedTokens: 50 };
    let sent = '';
    for (let i = 0; i < text.length; i += size) {
      if (req.signal.aborted) {
        yield cancelled(sent);
        return;
      }
      const delta = text.slice(i, i + size);
      sent += delta;
      yield { type: 'text', delta };
      await sleep(delay, req.signal);
    }
    if (req.signal.aborted) {
      yield cancelled(sent);
      return;
    }
    yield {
      type: 'result',
      text,
      structured: req.jsonSchema ? JSON.parse(text) : undefined,
      usage: { inputTokens: 2, cacheReadTokens: cache.read, cacheCreationTokens: cache.write, outputTokens: Math.ceil(text.length / 4), thinkingTokens: 0, costUsdApiEquivEst: 0, durationMs: 0, durationApiMs: 0 },
      rateLimit: { status: 'allowed', rateLimitType: 'seven_day', resetsAt: null, sevenDayUtilization: null },
    };
  }

  async health(): Promise<LlmHealth> {
    return { cliFound: true, cliVersion: 'mock', loggedIn: null, detail: 'SP_LLM=mock' };
  }
}
