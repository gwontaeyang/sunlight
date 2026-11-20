// Controllable fake server for panel tests: SSE routes return a stream the test pushes events into,
// JSON routes answer from a handler. Uses the real api client + streamRoute (contract checks included).
import { vi } from 'vitest';
import type { Citation, MessageStats, ParsedAnswer, ParsedBlocks } from '@study-paper/shared/contracts/domain';
import { formatSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import type { Effort, TaskId } from '@study-paper/shared/contracts/tasks';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { createApiClient } from '../../src/api/client';

export interface FakeCall {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

/** json: a JSON body; png (M2): raw bytes answered as image/png (papers.capture through api.blob). */
export type JsonReply = { status: number; json?: unknown; png?: Uint8Array };
/** May answer asynchronously (M2: a test holds a reply to check that patches are serialised). */
export type JsonHandler = (call: FakeCall) => JsonReply | undefined | Promise<JsonReply | undefined>;

export function createFakeServer(json: JsonHandler = () => undefined) {
  const enc = new TextEncoder();
  const calls: FakeCall[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let onCancel: ((call: FakeCall) => void) | null = null;

  const fetchFn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: FakeCall = { method: init.method ?? 'GET', url, body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
    calls.push(call);
    const accept = (init.headers as Record<string, string>)?.Accept ?? '';
    if (accept.includes('text/event-stream')) {
      // M2: a handler may refuse an SSE request with an HTTP error before any event (e.g. 409 card_generating).
      const refused = await json(call);
      if (refused && refused.status >= 400) return new Response(JSON.stringify(refused.json ?? null), { status: refused.status, headers: { 'Content-Type': 'application/json' } });
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          streams.push(c);
          init.signal?.addEventListener('abort', () => {
            try {
              c.error(new DOMException('The operation was aborted.', 'AbortError'));
            } catch {
              /* already closed */
            }
          });
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.endsWith('/cancel')) onCancel?.(call);
    const r = (await json(call)) ?? (url.endsWith('/cancel') ? { status: 204 } : { status: 404, json: { error: { code: 'not_found', message: 'nope' } } });
    if (r.png !== undefined) return new Response(r.png as BodyInit, { status: r.status, headers: { 'Content-Type': 'image/png' } });
    return r.json === undefined ? new Response(null, { status: r.status }) : new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });

  const current = () => streams[streams.length - 1]!;
  return {
    client: createApiClient({ fetch: fetchFn as unknown as typeof fetch, getToken: () => 'tok', onUnauthorized: () => {} }),
    fetchFn,
    calls,
    streamCount: () => streams.length,
    push: (...events: SseEvent[]) => {
      for (const e of events) current().enqueue(enc.encode(formatSseEvent(e)));
    },
    end: () => current().close(),
    /**
     * Review D-I10-01: an ABNORMAL cut — the body read rejects (what fetch reports for a reset connection or an
     * incomplete chunked body: a TypeError), unlike end() which is a clean EOF.
     */
    fail: (err: unknown = new TypeError('network error')) => current().error(err),
    onCancel: (fn: (call: FakeCall) => void) => {
      onCancel = fn;
    },
  };
}

export const ev = {
  accepted: (o: { runId?: string; threadId?: string; messageId?: string; task?: TaskId; artifactId?: string } = {}): SseEvent => ({
    event: 'run.accepted',
    data: { runId: o.runId ?? 'r1', task: o.task ?? 'explain_selection', threadId: o.threadId ?? 't1', messageId: o.messageId ?? 'm1', ...(o.artifactId !== undefined ? { artifactId: o.artifactId } : {}) },
  }),
  /** M2: a run without a thread (cards.generate, glossary.define): run.accepted with only runId / task / artifactId. */
  acceptedRun: (o: { runId?: string; task: TaskId; artifactId?: string }): SseEvent => ({ event: 'run.accepted', data: { runId: o.runId ?? 'r1', task: o.task, ...(o.artifactId !== undefined ? { artifactId: o.artifactId } : {}) } }),
  /** M2: run.retrying (SP-Blocks repair request). */
  retrying: (errors: string[] = ['item 3: missing attribute label']): SseEvent => ({ event: 'run.retrying', data: { reason: 'validation', errors } }),
  /** M2: run.done of an SP-Blocks / plain run (parsed given as is, e.g. null for a translation). */
  doneParsed: (text: string, parsed: ParsedAnswer | ParsedBlocks | null, citations: Citation[] = []): SseEvent => ({
    event: 'run.done',
    data: { text, parsed, citations, stats: null, usage: { inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, outputTokens: null, thinkingTokens: null, costUsdApiEquivEst: null, durationMs: null, durationApiMs: null } },
  }),
  queued: (position: number): SseEvent => ({ event: 'run.queued', data: { position } }),
  started: (effort: Effort = 'low'): SseEvent => ({ event: 'run.started', data: { model: 'opus', modelResolved: 'claude-opus', effort, cliVersion: '2.0.0' } }),
  response: (cacheReadTokens = 1000): SseEvent => ({ event: 'run.response_started', data: { cacheReadTokens, cacheCreationTokens: 0 } }),
  thinking: (estimatedTokens: number): SseEvent => ({ event: 'run.thinking', data: { estimatedTokens } }),
  delta: (text: string): SseEvent => ({ event: 'run.delta', data: { text } }),
  done: (text: string, citations: Citation[] = [], stats: MessageStats | null = null): SseEvent => ({
    event: 'run.done',
    data: {
      text,
      parsed: parseAnswer(text),
      citations,
      stats,
      usage: { inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, outputTokens: null, thinkingTokens: null, costUsdApiEquivEst: null, durationMs: null, durationApiMs: null },
    },
  }),
  error: (code: 'cancelled' | 'idle_timeout' | 'cli_error' | 'result_deleted' | 'parse_failed', partialText?: string): SseEvent => ({ event: 'run.error', data: { code, message: code, retryable: code !== 'cancelled' && code !== 'result_deleted', ...(partialText !== undefined ? { partialText } : {}) } }),
};
