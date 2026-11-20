// Client side of the stream contract (review M3) and raw upload (review M9). Owner: supervisor.
import { describe, expect, it, vi } from 'vitest';
import { formatSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { ApiError, createApiClient } from '../src/api/client';
import { createStreamChecker, streamRoute } from '../src/api/sse';

const ID = '00000000-0000-4000-8000-000000000001';
const accepted: SseEvent = { event: 'run.accepted', data: { runId: 'r1', task: 'explain_selection', threadId: 't1', messageId: 'm1' } };
const delta: SseEvent = { event: 'run.delta', data: { text: '설명' } };
const error: SseEvent = { event: 'run.error', data: { code: 'cancelled', message: 'cancelled', retryable: false } };
const jobStep: SseEvent = { event: 'job.step', data: { step: 'pdf', status: 'ok' } };
const jobDone: SseEvent = { event: 'job.done', data: { paperId: ID } };

function clientFor(events: SseEvent[], init: { contentType?: string; noBody?: boolean } = {}) {
  const text = events.map(formatSseEvent).join('');
  const fetchFn = vi.fn(async () => new Response(init.noBody ? null : text, { status: 200, headers: { 'Content-Type': init.contentType ?? 'text/event-stream' } }));
  return createApiClient({ fetch: fetchFn as unknown as typeof fetch, getToken: () => 'tok' });
}
const explain = (client: ReturnType<typeof clientFor>, onEvent?: (e: SseEvent) => void) =>
  streamRoute('threads.create', { client, params: { id: ID }, body: { kind: 'explain', text: 'x', clientRequestId: crypto.randomUUID() }, onEvent });
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof ApiError ? e.code : `other: ${String(e)}`;
  }
};

describe('streamRoute contract', () => {
  it('resolves only for a stream that starts with run.accepted and ends with one terminal event', async () => {
    const events = await explain(clientFor([accepted, delta, error]));
    expect(events.map((e) => e.event)).toEqual(['run.accepted', 'run.delta', 'run.error']);
  });

  it('a stream cut before its terminal event is an error, but the events seen so far were delivered', async () => {
    const seen: string[] = [];
    expect(await codeOf(explain(clientFor([accepted, delta]), (e) => seen.push(e.event)))).toBe('stream_interrupted');
    expect(seen).toEqual(['run.accepted', 'run.delta']);
    expect(['stream_interrupted', 'bad_response']).toContain(await codeOf(explain(clientFor([])))); // empty stream: never a success
  });

  it('rejects order and family violations', async () => {
    expect(await codeOf(explain(clientFor([delta, error])))).toBe('bad_stream'); // no run.accepted first
    expect(await codeOf(explain(clientFor([accepted, error, delta])))).toBe('bad_stream'); // event after terminal
    expect(await codeOf(explain(clientFor([accepted, error, error])))).toBe('bad_stream'); // two terminals
    expect(await codeOf(explain(clientFor([accepted, jobStep, error])))).toBe('bad_stream'); // job event in a run stream
    expect(await codeOf(streamRoute('jobs.events', { client: clientFor([jobStep, accepted, jobDone]), params: { id: ID } }))).toBe('bad_stream');
    expect((await streamRoute('jobs.events', { client: clientFor([jobStep, jobDone]), params: { id: ID } })).length).toBe(2);
  });

  it('rejects a wrong Content-Type, a missing body and an event that fails its schema', async () => {
    expect(await codeOf(explain(clientFor([accepted, error], { contentType: 'application/json' })))).toBe('bad_response');
    expect(await codeOf(explain(clientFor([], { noBody: true })))).toBe('bad_response');
    const bad = { event: 'run.delta', data: { nope: 1 } } as unknown as SseEvent;
    expect(await codeOf(explain(clientFor([accepted, bad, error])))).toBe('bad_response');
  });

  it('run.retrying (M2) is a non-terminal run event: the one-terminal rule is unchanged', async () => {
    const retrying: SseEvent = { event: 'run.retrying', data: { reason: 'validation', errors: ['item 3: missing key units'] } };
    const done = await explain(clientFor([accepted, delta, retrying, delta, error]));
    expect(done.map((e) => e.event)).toEqual(['run.accepted', 'run.delta', 'run.retrying', 'run.delta', 'run.error']);
    expect(await codeOf(explain(clientFor([accepted, retrying])))).toBe('stream_interrupted'); // retrying is not a terminal
    expect(await codeOf(explain(clientFor([accepted, error, retrying])))).toBe('bad_stream'); // nothing after the terminal
    expect(await codeOf(explain(clientFor([retrying, error])))).toBe('bad_stream'); // still must start with run.accepted
    const tooLong = { event: 'run.retrying', data: { reason: 'validation', errors: ['x'.repeat(201)] } } as unknown as SseEvent;
    expect(await codeOf(explain(clientFor([accepted, tooLong, error])))).toBe('bad_response');
  });

  it('createStreamChecker.finish returns the terminal event', () => {
    const c = createStreamChecker('threads.create');
    c.accept(accepted);
    c.accept(error);
    expect(c.finish().event).toBe('run.error');
  });
});

describe('raw upload', () => {
  it('papers.upload sends the bytes as application/pdf with the encoded file name', async () => {
    const fetchFn = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(JSON.stringify({ paperId: ID, jobId: null, existing: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = createApiClient({ fetch: fetchFn as unknown as typeof fetch, getToken: () => 'tok' });
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const res = await client.call('papers.upload', { rawBody: bytes, filename: '논문 v2.pdf' });
    expect(res).toEqual({ paperId: ID, jobId: null, existing: true });
    const init = fetchFn.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(bytes);
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/pdf', 'X-SP-Filename': encodeURIComponent('논문 v2.pdf'), 'X-SP-Token': 'tok' });
    await expect(client.call('papers.list', { rawBody: bytes } as never)).rejects.toThrow(/does not take a raw body/);
  });
});
