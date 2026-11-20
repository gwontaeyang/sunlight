// M1.2 review A1: per-request timeouts (headers / body / per-hop total) start only when the host-queue slot is
// acquired and the request starts; the caller's overall deadline covers the queue wait and is always reported as
// stage 'deadline'. Mock fetch only; small real timeouts or vitest fake timers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkArxivSource } from '../../src/ingest/arxivApi';
import { HostQueue } from '../../src/ingest/hostQueue';
import { HttpCache } from '../../src/ingest/httpCache';
import { FetchError, safeFetchText, type FetchImpl } from '../../src/ingest/safeFetch';
import { startTestServer, type TestServer } from '../helpers/server';
import { atomFeed, freshId } from './helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const hang: FetchImpl = (_u, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
const stalledBody = () => new Response(new ReadableStream<Uint8Array>({ start() {} }));
const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof FetchError ? `${e.code}/${e.stage ?? '-'}` : `other:${(e as Error).message}`));

describe('safeFetch timer start and stage classification (A1)', () => {
  it("Codex's scaled repro: a 180 ms cooldown no longer eats a 100 ms per-request timeout", async () => {
    const q = new HostQueue();
    q.cooldown('arxiv.org', Date.now() + 180, 'HTTP 429');
    const calls: number[] = [];
    const t0 = Date.now();
    const fetchImpl: FetchImpl = async () => {
      calls.push(Date.now() - t0);
      await new Promise((r) => setTimeout(r, 50)); // answers well within its own 100 ms
      return new Response('ok');
    };
    const r = await safeFetchText('https://arxiv.org/x', { kind: 'atom', queue: q, fetchImpl, totalTimeoutMs: 100, headerTimeoutMs: 100, deadline: Date.now() + 1_000 });
    expect(r.text).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toBeGreaterThanOrEqual(170);
  });

  it('each stage is named correctly: headers, body, deadline during the body, deadline during the queue wait (0 fetches)', async () => {
    const opts = (fetchImpl: FetchImpl, extra: object = {}) => ({ kind: 'atom' as const, queue: new HostQueue(), fetchImpl, ...extra });
    expect(await outcome(safeFetchText('https://arxiv.org/x', opts(hang, { headerTimeoutMs: 30 })))).toBe('timeout/headers');
    expect(await outcome(safeFetchText('https://arxiv.org/x', opts(async () => stalledBody(), { totalTimeoutMs: 60 })))).toBe('timeout/body');
    expect(await outcome(safeFetchText('https://arxiv.org/x', opts(async () => stalledBody(), { totalTimeoutMs: 5_000, deadline: Date.now() + 60 })))).toBe('timeout/deadline');
    expect(await outcome(safeFetchText('https://arxiv.org/x', opts(hang, { headerTimeoutMs: 5_000, deadline: Date.now() + 60 })))).toBe('timeout/deadline');
    // Queue wait runs into the deadline (another request holds the slot): deadline, and this request never fetched.
    const q = new HostQueue();
    let release!: () => void;
    const holder = q.run('arxiv.org', () => new Promise<void>((r) => (release = r)));
    let fetched = 0;
    const waiting = safeFetchText('https://arxiv.org/y', { kind: 'atom', queue: q, fetchImpl: async () => (fetched++, new Response('ok')), totalTimeoutMs: 30, deadline: Date.now() + 80 });
    expect(await outcome(waiting)).toBe('timeout/deadline');
    expect(fetched).toBe(0);
    release();
    await holder;
  });
});

describe('arXiv source after an allowed cooldown (fake timers)', () => {
  for (const retryAfter of [119, 120]) {
    it(`Retry-After ${retryAfter} s, then a slow but normal answer (> 1 s): success with the full per-request time`, async () => {
      const srv = await startTestServer({ env: 'prod' });
      servers.push(srv);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(1_000_000);
      const id = freshId();
      const at: number[] = [];
      const fetchImpl: FetchImpl = async () => {
        at.push(Date.now());
        if (at.length === 1) return new Response('', { status: 429, headers: { 'retry-after': String(retryAfter) } });
        await new Promise((r) => setTimeout(r, 1_500)); // headers after 1.5 s
        const body = atomFeed([{ id, version: 1 }]);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              setTimeout(() => {
                c.enqueue(new TextEncoder().encode(body));
                c.close();
              }, 1_000); // body after another 1 s
            },
          }),
          { headers: { 'content-type': 'application/atom+xml' } },
        );
      };
      const src = new NetworkArxivSource({ queue: new HostQueue(), cache: new HttpCache(srv.deps.sqlite), fetchImpl });
      let result: unknown = null;
      void src.metadata(id, undefined).then(
        (r) => (result = r),
        (e: unknown) => (result = e),
      );
      for (let i = 0; i < 400 && result === null; i++) await vi.advanceTimersByTimeAsync(1_000);
      expect(result).toMatchObject({ meta: { id, version: 1 }, requests: 2 });
      expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(retryAfter * 1_000);
    });
  }
});
