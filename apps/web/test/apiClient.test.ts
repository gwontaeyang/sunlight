// web side of the contract gate (PLAN 9.2-11): the api client parses mock responses with the shared schemas.
import { describe, expect, it, vi } from 'vitest';
import { formatSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { parseConflictDetails } from '@study-paper/shared/contracts/errors';
import { ApiError, buildUrl, createApiClient } from '../src/api/client';
import { readSse, streamRoute } from '../src/api/sse';

const PAPER = {
  id: '00000000-0000-4000-8000-000000000001',
  source: 'upload',
  arxivId: null,
  arxivVersion: null,
  title: 'A Synthetic Study',
  authors: ['Test Author'],
  year: 2000,
  status: 'reading',
  ingestStatus: 'done',
  state: { readable: true, contextReady: true, structureReady: true },
  ai: { available: true, reason: null },
  pageCount: 2,
  collectionId: null,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: null,
  structureSource: null,
  supplementVersion: 1,
  structureUpgradeAvailable: false,
};

const CANVAS_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAABhklEQVR4AbRSPUhCYRQ9vAhyMEohCKEIKjCUIMqw0Adu4qZOgkMoTg4tCi4OLppOIjSI0iA4ibS4CiIlaWWhEFQEBdIQWuDwggh77yEPoef7kfrgfvf77j33HDhcYvAP5ymVGjQcDpaZwB+efquFC5sNUwoFtgsFlpkTmD+oQEqwUzzXYyKBh3gcm+k0ljweDsEJcBWZj496HecWCxQaDbZyOczQeZSCGP3Ifd9HInjOZLBD26FxuXjHJxLoViqoGo1Q6nSsJdMqFS85U5QtcBcK4bVYxH65jEW7neEQDMkCpt4VTm8OoTaboUsmQdCbIsg8bHIC7yck+KJ7bEB1toijjTeQzSYWrNbhqLTECfDBGSvO6A1hrNBGo3wQ0RqvwFevh1ufD/12G6ZaDWqSFCUaB/gl0Mnn0XA6sez1Yj0cHjcnuc4JfHY6uHa7QdF5j96QOYNBMokQkBV4yWZZS9aCQawGAkJ42T3ikrbjm6KwWypBqdfLJhAbILSxGFb8fjHcxP0fAAAA//8KRt9fAAAABklEQVQDAK0F0W49gdBcAAAAAElFTkSuQmCC';

function fakeFetch(status: number, body: unknown, contentType = 'application/json') {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': contentType } }));
}

describe('api client', () => {
  it('builds paths from contracts/routes.ts and sends the token header', async () => {
    const f = fakeFetch(200, { papers: [PAPER] });
    const client = createApiClient({ fetch: f as unknown as typeof fetch, getToken: () => 'tok' });
    const res = await client.call('papers.list');
    expect(res.papers[0]!.title).toBe('A Synthetic Study');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/papers');
    expect((init!.headers as Record<string, string>)['X-SP-Token']).toBe('tok');
    expect(buildUrl('papers.pdf', { id: 'a/b' })).toBe('/api/papers/a%2Fb/pdf');
  });
  it('keepalive: passed to fetch only when asked (a last papers.position flush), with the token header and the JSON body', async () => {
    const f = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    const client = createApiClient({ fetch: f as unknown as typeof fetch, getToken: () => 'tok' });
    const body = { page: 3, zoom: 1.25, mode: 'page-width', top: 0.4 } as const;
    await expect(client.call('papers.position', { params: { id: PAPER.id }, body, keepalive: true })).resolves.toBeUndefined();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`/api/papers/${PAPER.id}/position`);
    expect(init).toMatchObject({ method: 'PUT', keepalive: true, body: JSON.stringify(body) });
    expect((init!.headers as Record<string, string>)['X-SP-Token']).toBe('tok');
    await client.call('papers.position', { params: { id: PAPER.id }, body });
    expect(f.mock.calls[1]![1]).not.toHaveProperty('keepalive');
  });
  it('rejects a response that does not match the schema', async () => {
    const client = createApiClient({ fetch: fakeFetch(200, { papers: [{ id: 1 }] }) as unknown as typeof fetch, getToken: () => 't' });
    await expect(client.call('papers.list')).rejects.toMatchObject({ code: 'bad_response' });
  });
  it('maps the error DTO (501) and signals 401', async () => {
    const onUnauthorized = vi.fn();
    const c501 = createApiClient({ fetch: fakeFetch(501, { error: { code: 'not_implemented', message: 'x' } }) as unknown as typeof fetch, getToken: () => 't', onUnauthorized });
    await expect(c501.call('papers.import', { body: { input: '2209.15397', clientRequestId: crypto.randomUUID() } })).rejects.toMatchObject({ status: 501, code: 'not_implemented' });
    const c401 = createApiClient({ fetch: fakeFetch(401, { error: { code: 'unauthorized', message: 'x' } }) as unknown as typeof fetch, getToken: () => 't', onUnauthorized });
    await expect(c401.call('papers.list')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
  it('409 details reach ApiError.details unchanged and parse as ConflictDetails (payload_version, card_generating)', async () => {
    const cases = [
      { reason: 'payload_version', runId: 'r0' },
      { reason: 'card_generating', runId: 'r1', cardId: 'c1' },
    ];
    for (const details of cases) {
      const c = createApiClient({ fetch: fakeFetch(409, { error: { code: 'conflict', message: 'x', details } }) as unknown as typeof fetch, getToken: () => 't' });
      const err = await c.call('papers.list').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).details).toEqual(details);
      expect(parseConflictDetails((err as ApiError).details)).toEqual(details);
    }
    expect(parseConflictDetails({ reason: 'card_generating', runId: 'r1' })).toBeNull(); // cardId missing
    expect(parseConflictDetails(undefined)).toBeNull();
  });
  it('blob(): a png route returns the image; a wrong type or a broken PNG is bad_response; non-png routes are refused', async () => {
    // A real 24×16 PNG from Chrome's canvas.toDataURL (same constant as packages/shared/test/png.test.ts).
    const png = Uint8Array.from(atob(CANVAS_PNG), (ch) => ch.charCodeAt(0));
    const params = { id: PAPER.id, fileId: PAPER.id };
    const ok = createApiClient({ fetch: vi.fn(async () => new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } })) as unknown as typeof fetch, getToken: () => 't' });
    const b = await ok.blob('papers.capture', { params });
    expect(b.type).toBe('image/png');
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(new Uint8Array(png));
    const wrongType = createApiClient({ fetch: vi.fn(async () => new Response(png, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })) as unknown as typeof fetch, getToken: () => 't' });
    await expect(wrongType.blob('papers.capture', { params })).rejects.toMatchObject({ code: 'bad_response' });
    const broken = png.slice();
    broken[broken.length - 1]! ^= 1;
    const bad = createApiClient({ fetch: vi.fn(async () => new Response(broken, { status: 200, headers: { 'Content-Type': 'image/png' } })) as unknown as typeof fetch, getToken: () => 't' });
    await expect(bad.blob('papers.capture', { params })).rejects.toMatchObject({ code: 'bad_response' });
    const notFound = createApiClient({ fetch: fakeFetch(404, { error: { code: 'not_found', message: 'capture' } }) as unknown as typeof fetch, getToken: () => 't' });
    await expect(notFound.blob('papers.capture', { params })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(ok.blob('papers.list')).rejects.toThrow(/not a png route/);
  });
});

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(c);
      ctrl.close();
    },
  });
}

describe('SSE reader', () => {
  const events: SseEvent[] = [
    { event: 'run.accepted', data: { runId: 'r1', task: 'explain_selection', threadId: 't1', messageId: 'm1' } },
    { event: 'run.delta', data: { text: '한국어 텍스트 <q>' } },
    { event: 'run.error', data: { code: 'cancelled', message: '취소', retryable: false } },
  ];
  it('handles chunk boundaries inside lines and inside UTF-8 code points', async () => {
    const bytes = new TextEncoder().encode(events.map(formatSseEvent).join('').replace(/\n/g, '\r\n'));
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5) chunks.push(bytes.slice(i, i + 5));
    const got = [];
    for await (const m of readSse(streamOf(chunks))) got.push({ event: m.event, data: JSON.parse(m.data) });
    expect(got).toEqual(events);
  });
  it('streamRoute validates every event and reports them in order', async () => {
    const f = fakeFetch(200, events.map(formatSseEvent).join(''), 'text/event-stream');
    const seen: string[] = [];
    const all = await streamRoute('threads.create', {
      params: { id: 'p1' },
      body: { kind: 'explain', clientRequestId: crypto.randomUUID() },
      client: createApiClient({ fetch: f as unknown as typeof fetch, getToken: () => 't' }),
      onEvent: (e) => seen.push(e.event),
    });
    expect(seen).toEqual(['run.accepted', 'run.delta', 'run.error']);
    expect(all).toHaveLength(3);
  });
  it('streamRoute rejects an event outside the contract', async () => {
    const f = fakeFetch(200, 'event: run.delta\ndata: {"txt":"x"}\n\n', 'text/event-stream');
    await expect(streamRoute('threads.create', { params: { id: 'p1' }, body: { kind: 'explain', clientRequestId: crypto.randomUUID() }, client: createApiClient({ fetch: f as unknown as typeof fetch, getToken: () => 't' }) })).rejects.toThrow();
  });
});
