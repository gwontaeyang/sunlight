// fetch + ReadableStream SSE reader (PLAN 2.3). Every event is validated with contracts/sse.ts.
// Owner: supervisor (D builds the React hook on top in M1).
import { parseSseEvent, RUN_TERMINAL_EVENTS, JOB_TERMINAL_EVENTS, type SseEvent } from '@study-paper/shared/contracts/sse';
import type { ApiBody, ApiParams } from '@study-paper/shared/contracts/api';
import type { RouteId } from '@study-paper/shared/contracts/routes';
import { api, ApiError, type ApiClient } from './client';

export interface RawSseMessage {
  event: string;
  data: string;
}

/** Parses text/event-stream framing across arbitrary chunk boundaries (UTF-8 safe, CRLF tolerant). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<RawSseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let event = 'message';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buf += decoder.decode();
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r\n|\n|\r/)) >= 0) {
        // A trailing '\r' may be the first half of '\r\n' split across chunks: wait for more data.
        if (buf[nl] === '\r' && nl === buf.length - 1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf.startsWith('\r\n', nl) ? 2 : 1));
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = 'message';
          data = [];
        } else if (line.startsWith(':')) {
          /* comment / keep-alive */
        } else {
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
      }
    }
    if (buf.length) {
      const i = buf.indexOf(':');
      if (buf.slice(0, i) === 'data') data.push(buf.slice(i + 1).replace(/^ /, ''));
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}

export interface StreamOptions<R extends RouteId> {
  params?: ApiParams<R>;
  body?: ApiBody<R>;
  signal?: AbortSignal;
  onEvent?: (e: SseEvent) => void;
  client?: ApiClient;
}

/** Stream family of an SSE route: job streams carry only job.* events, every other SSE route only run.*. */
export function streamFamily(route: RouteId): 'run' | 'job' {
  return route === 'jobs.events' ? 'job' : 'run';
}

/**
 * Enforces the stream contract (PLAN 2.3) event by event. Throws ApiError `bad_stream` when:
 * an event of the other family arrives, a run stream does not start with run.accepted, or anything follows
 * the terminal event. `finish()` throws `stream_interrupted` when the stream ended without a terminal event.
 */
export function createStreamChecker(route: RouteId) {
  const family = streamFamily(route);
  let count = 0;
  let terminal: SseEvent | null = null;
  return {
    accept(e: SseEvent): void {
      if (terminal) throw new ApiError(200, 'bad_stream', `${route}: event ${e.event} after the terminal event ${terminal.event}`);
      if (!e.event.startsWith(`${family}.`)) throw new ApiError(200, 'bad_stream', `${route}: unexpected event ${e.event} in a ${family} stream`);
      if (family === 'run' && count === 0 && e.event !== 'run.accepted') throw new ApiError(200, 'bad_stream', `${route}: the stream must start with run.accepted, got ${e.event}`);
      count++;
      if (isTerminal(e)) terminal = e;
    },
    finish(): SseEvent {
      if (!terminal) throw new ApiError(200, 'stream_interrupted', `${route}: the stream ended after ${count} event(s) without a terminal event`);
      return terminal;
    },
  };
}

/**
 * POSTs (or GETs) an SSE route, validates every event and the stream contract, and resolves with all events
 * once the stream ended WITH its terminal event. Events are also delivered through onEvent as they arrive.
 * Throws ApiError: non-2xx answers (e.g. 409 context_not_ready) before any event; `bad_response` for a
 * missing body, a wrong Content-Type or an event that fails its schema; `bad_stream` / `stream_interrupted`
 * as described at createStreamChecker (a cut connection is never a successful result).
 */
export async function streamRoute<R extends RouteId>(route: R, o: StreamOptions<R> = {}): Promise<SseEvent[]> {
  const client = o.client ?? api;
  const res = await client.request(route, { params: o.params, body: o.body, signal: o.signal }, 'text/event-stream');
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('text/event-stream')) throw new ApiError(res.status, 'bad_response', `${route}: expected text/event-stream, got ${type || 'no content-type'}`);
  if (!res.body) throw new ApiError(res.status, 'bad_response', `${route}: the response has no body`);
  const checker = createStreamChecker(route);
  const events: SseEvent[] = [];
  for await (const m of readSse(res.body)) {
    let e: SseEvent;
    try {
      e = parseSseEvent(m.event, JSON.parse(m.data));
    } catch (err) {
      throw new ApiError(res.status, 'bad_response', `${route}: invalid event ${m.event}: ${(err as Error).message}`);
    }
    checker.accept(e);
    events.push(e);
    o.onEvent?.(e);
  }
  checker.finish();
  return events;
}

export const isTerminal = (e: SseEvent) =>
  (RUN_TERMINAL_EVENTS as readonly string[]).includes(e.event) || (JOB_TERMINAL_EVENTS as readonly string[]).includes(e.event);
