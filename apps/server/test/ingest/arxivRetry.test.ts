// arXiv robustness. M1.1 (live demo FAST-LIO2: header timeout, then HTTP 429, fine ~10 min later): 60 s header
// timeout for the API, bounded retry with backoff / Retry-After, >= 3 s spacing, Korean wait status.
// M1.1.2 (review N5, n1): the cooldown is SHARED by every arXiv request through the host queue; a Retry-After over
// the 120 s cap stops the job (retryable) instead of retrying early; one 6 min deadline covers everything.
// Mock fetch and fake clocks only: no network, no real multi-second waits.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobSseEvent } from '@study-paper/shared/contracts/sse';
import { ARXIV_API_HEADER_TIMEOUT_MS, ArxivCooldownError, DEFAULT_ARXIV_RETRY, NetworkArxivSource, retryCause, type ArxivRetryNotice, type ArxivRetryOptions } from '../../src/ingest/arxivApi';
import { HostQueue, QueueAbortedError } from '../../src/ingest/hostQueue';
import { HttpCache } from '../../src/ingest/httpCache';
import { configureIngest, ingestService, retryDetail } from '../../src/ingest/pipeline';
import { FetchError, parseRetryAfter, type FetchImpl } from '../../src/ingest/safeFetch';
import { startTestServer, type TestServer } from '../helpers/server';
import { atomFeed, collectJobEvents, freshId, paperRow, SYNTHETIC_PDF, waitJob } from './helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** Fake clock shared by the host queue and the retry policy: `sleep` advances it at once and records the waits. */
function fakeClock(start = 1_000_000) {
  const c = { t: start, sleeps: [] as number[] };
  return {
    c,
    now: () => c.t,
    // Yields to the event loop first (other jobs enqueue meanwhile, as they would during a real wait), then
    // jumps the clock to the wake-up time.
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new QueueAbortedError(signal.reason);
      const wake = c.t + ms;
      c.sleeps.push(ms);
      await new Promise((r) => setTimeout(r, 5));
      if (signal?.aborted) throw new QueueAbortedError(signal.reason);
      c.t = Math.max(c.t, wake);
    },
  };
}

const atomOk = (id: string) => new Response(atomFeed([{ id, version: 1 }]), { headers: { 'content-type': 'application/atom+xml' } });
const hang: FetchImpl = (_url, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));

/** A mock fetch answering per URL from a script (Response | 'hang'), logging the clock at every request. */
function scriptedFetch(now: () => number, script: Record<string, (Response | 'hang')[]>) {
  const log: { url: string; at: number }[] = [];
  const impl: FetchImpl = (url, init) => {
    log.push({ url, at: now() });
    const next = script[url]?.shift();
    if (!next) return Promise.resolve(new Response('no script', { status: 404 }));
    return next === 'hang' ? hang(url, init) : Promise.resolve(next);
  };
  return { impl, log };
}
const apiUrl = (id: string) => `https://export.arxiv.org/api/query?id_list=${id}&max_results=1`;
const status = (n: number, retryAfter?: string) => new Response('', { status: n, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

async function sourceWith(now: () => number, queue: HostQueue, fetchImpl: FetchImpl, retry: Partial<ArxivRetryOptions> = {}) {
  const srv = await startTestServer({ env: 'prod' });
  servers.push(srv);
  return new NetworkArxivSource({ queue, cache: new HttpCache(srv.deps.sqlite, now), fetchImpl, retry: { now, apiHeaderTimeoutMs: 30, ...retry } });
}
const err = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);

describe('parseRetryAfter / retryCause', () => {
  it('delta-seconds, HTTP-date, junk', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter(' 0 ')).toBe(0);
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:29:30 GMT', now)).toBe(90_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('retries 429/503 and timeouts; a body timeout only when repeatable; never a deadline, 404, 500, network or a cooldown stop', () => {
    expect(retryCause(new FetchError('http_status', 'x', 429), false)).toBe('HTTP 429');
    expect(retryCause(new FetchError('timeout', 'x', undefined, undefined, 'headers'), false)).toBe('timeout');
    expect(retryCause(new FetchError('timeout', 'x', undefined, undefined, 'body'), true)).toBe('timeout');
    expect(retryCause(new FetchError('timeout', 'x', undefined, undefined, 'body'), false)).toBeNull();
    expect(retryCause(new FetchError('timeout', 'x', undefined, undefined, 'deadline'), true)).toBeNull();
    for (const e of [new FetchError('not_found', 'x', 404), new FetchError('http_status', 'x', 500), new FetchError('network', 'x'), new ArxivCooldownError(600_000, 'HTTP 429'), new Error('parse')]) {
      expect(retryCause(e, true)).toBeNull();
    }
  });
});

describe('NetworkArxivSource retries (one job)', () => {
  it('default API header timeout is 60 s', () => {
    expect(ARXIV_API_HEADER_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_ARXIV_RETRY.apiHeaderTimeoutMs).toBe(60_000);
  });

  it('429 → header timeout → 503 → 200 with 15 s → 30 s → 60 s cooldowns, >= 3 s apart, each wait reported', async () => {
    const clk = fakeClock();
    const id = freshId();
    const f = scriptedFetch(clk.now, { [apiUrl(id)]: [status(429), 'hang', status(503), atomOk(id)] });
    const src = await sourceWith(clk.now, new HostQueue(clk.now, clk.sleep), f.impl);
    const notices: ArxivRetryNotice[] = [];
    expect(await src.metadata(id, undefined, undefined, { onRetry: (n) => notices.push(n) })).toMatchObject({ meta: { id }, requests: 4 });
    expect(notices.map((n) => [n.attempt, n.cause, n.waitMs])).toEqual([
      [2, 'HTTP 429', 15_000],
      [3, 'timeout', 30_000],
      [4, 'HTTP 503', 60_000],
    ]);
    for (let i = 1; i < f.log.length; i++) expect(f.log[i]!.at - f.log[i - 1]!.at).toBeGreaterThanOrEqual(3_000);
    expect(await src.metadata(id, undefined)).toMatchObject({ requests: 0 }); // cached
  });

  it('a longer Retry-After within the 120 s cap is honoured; a short one never shortens the backoff', async () => {
    const clk = fakeClock();
    const id = freshId();
    const f = scriptedFetch(clk.now, { [apiUrl(id)]: [status(429, '90'), status(503, '1'), atomOk(id)] });
    const src = await sourceWith(clk.now, new HostQueue(clk.now, clk.sleep), f.impl);
    const notices: ArxivRetryNotice[] = [];
    await src.metadata(id, undefined, undefined, { onRetry: (n) => notices.push(n) });
    expect(notices.map((n) => n.waitMs)).toEqual([90_000, 30_000]);
  });

  it('Retry-After over the cap: no early retry — stops at once with the Korean reason; the full cooldown stays shared', async () => {
    const clk = fakeClock();
    const id = freshId();
    const queue = new HostQueue(clk.now, clk.sleep);
    const f = scriptedFetch(clk.now, { [apiUrl(id)]: [status(429, '600'), atomOk(id)] });
    const src = await sourceWith(clk.now, queue, f.impl);
    const e = await err(src.metadata(id, undefined));
    expect(e).toBeInstanceOf(ArxivCooldownError);
    expect(e!.message).toBe('arXiv가 약 10분 뒤 다시 요청하라고 응답했습니다 (HTTP 429) — 그 뒤 다시 시도하세요');
    expect(f.log).toHaveLength(1);
    expect(queue.cooldownOf('arxiv.org')).toEqual({ until: f.log[0]!.at + 600_000, cause: 'HTTP 429' });
  });

  it('gives up after maxAttempts with the last error; 404 / 500 are not retried', async () => {
    const clk = fakeClock();
    const id = freshId();
    const f = scriptedFetch(clk.now, { [apiUrl(id)]: [status(429), status(429), status(429), status(429), status(429)] });
    const src = await sourceWith(clk.now, new HostQueue(clk.now, clk.sleep), f.impl);
    expect(await err(src.metadata(id, undefined))).toMatchObject({ code: 'http_status', status: 429 });
    expect(f.log).toHaveLength(DEFAULT_ARXIV_RETRY.maxAttempts);
    for (const code of [404, 500]) {
      const id2 = freshId();
      const g = scriptedFetch(clk.now, { [apiUrl(id2)]: [status(code)] });
      const s2 = await sourceWith(clk.now, new HostQueue(clk.now, clk.sleep), g.impl);
      await err(s2.metadata(id2, undefined));
      expect(g.log).toHaveLength(1);
    }
  });
});

describe('shared cooldown across jobs (N5)', () => {
  it('job A gets 429 Retry-After 600: job B, queued behind it, never hits arXiv during the cooldown and stops with the same reason', async () => {
    const clk = fakeClock();
    const a = freshId();
    const b = freshId();
    const queue = new HostQueue(clk.now, clk.sleep); // one queue per server, shared by all jobs
    const f = scriptedFetch(clk.now, { [apiUrl(a)]: [status(429, '600')], [apiUrl(b)]: [atomOk(b)] });
    const srcA = await sourceWith(clk.now, queue, f.impl);
    const srcB = await sourceWith(clk.now, queue, f.impl);
    const [ea, eb] = await Promise.all([err(srcA.metadata(a, undefined)), err(srcB.metadata(b, undefined))]);
    expect(ea).toBeInstanceOf(ArxivCooldownError);
    expect(eb).toBeInstanceOf(ArxivCooldownError);
    expect(eb!.message).toMatch(/^arXiv가 약 10분 뒤 다시 요청하라고 응답했습니다 \(HTTP 429\)/);
    expect(f.log.map((l) => l.url)).toEqual([apiUrl(a)]); // B made no request
    expect(clk.c.sleeps).toEqual([]); // and nobody slept through it
    // After the cooldown, B goes through normally.
    clk.c.t += 600_000;
    expect(await srcB.metadata(b, undefined)).toMatchObject({ requests: 1 });
    expect(f.log[1]!.at - f.log[0]!.at).toBeGreaterThanOrEqual(600_000);
  });

  it("a cooldown within the cap: B waits for A's Retry-After too (reported as the shared remaining time); both succeed >= 3 s apart", async () => {
    const clk = fakeClock();
    const a = freshId();
    const b = freshId();
    const queue = new HostQueue(clk.now, clk.sleep);
    const f = scriptedFetch(clk.now, { [apiUrl(a)]: [status(429, '40'), atomOk(a)], [apiUrl(b)]: [atomOk(b)] });
    const srcA = await sourceWith(clk.now, queue, f.impl);
    const srcB = await sourceWith(clk.now, queue, f.impl);
    const na: ArxivRetryNotice[] = [];
    const nb: ArxivRetryNotice[] = [];
    await Promise.all([srcA.metadata(a, undefined, undefined, { onRetry: (n) => na.push(n) }), srcB.metadata(b, undefined, undefined, { onRetry: (n) => nb.push(n) })]);
    const t429 = f.log[0]!.at;
    expect(f.log).toHaveLength(3);
    expect(f.log.slice(1).every((l) => l.at >= t429 + 40_000)).toBe(true);
    for (let i = 1; i < f.log.length; i++) expect(f.log[i]!.at - f.log[i - 1]!.at).toBeGreaterThanOrEqual(3_000);
    expect(nb).toEqual([{ attempt: 1, maxAttempts: 4, waitMs: 40_000, cause: 'HTTP 429' }]);
    expect(na).toHaveLength(1);
    expect(na[0]).toMatchObject({ attempt: 2, cause: 'HTTP 429' });
  });

  it('cancelling a job that waits on the shared cooldown ends it at once, without a request', async () => {
    const t = 1_000_000;
    const now = () => t;
    // A sleep that only ends by abort: the job is parked in the cooldown until we cancel it.
    let parked = 0;
    const sleep = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_, reject) => {
        parked++;
        if (signal?.aborted) return reject(new QueueAbortedError(signal.reason));
        signal?.addEventListener('abort', () => reject(new QueueAbortedError(signal.reason)), { once: true });
      });
    const queue = new HostQueue(now, sleep);
    const id = freshId();
    const f = scriptedFetch(now, { [apiUrl(id)]: [atomOk(id)] });
    const src = await sourceWith(now, queue, f.impl);
    queue.cooldown('arxiv.org', t + 100_000, 'HTTP 429'); // as if another job just got a 429 with Retry-After 100
    const ctrl = new AbortController();
    const waiting: ArxivRetryNotice[] = [];
    const p = err(src.metadata(id, undefined, ctrl.signal, { onRetry: (n) => waiting.push(n) }));
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(waiting[0]).toMatchObject({ attempt: 1, waitMs: 100_000, cause: 'HTTP 429' });
    await vi.waitFor(() => expect(parked).toBe(1)); // really waiting in the queue
    ctrl.abort('deleted');
    expect(await p).toMatchObject({ code: 'cancelled' });
    expect(f.log).toEqual([]);
  });
});

describe('one overall deadline (n1)', () => {
  it("Codex's case — the body stalls 120 s on every attempt: the call ends at 360 s (not 405 s), the last attempt cut short", async () => {
    const srv = await startTestServer({ env: 'prod' });
    servers.push(srv);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
    const id = freshId();
    const starts: number[] = [];
    const fetchImpl: FetchImpl = async () => {
      starts.push(Date.now());
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-type': 'application/atom+xml' } }); // headers, then nothing
    };
    const src = new NetworkArxivSource({ queue: new HostQueue(), cache: new HttpCache(srv.deps.sqlite), fetchImpl });
    const t0 = Date.now();
    let settled: { e: Error | null; at: number } | null = null;
    void err(src.metadata(id, undefined)).then((e) => (settled = { e, at: Date.now() }));
    for (let i = 0; i < 800 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toBeNull();
    const s = settled as unknown as { e: FetchError; at: number };
    expect(s.e).toMatchObject({ code: 'timeout', stage: 'deadline' });
    expect(s.at - t0).toBeLessThanOrEqual(DEFAULT_ARXIV_RETRY.maxTotalMs);
    // Each attempt gets its full 120 s once its queue wait is over (A1); the last one is cut to the 360 s deadline.
    expect(starts.map((x) => x - t0)).toEqual([0, 135_000, 285_000]);
    expect(s.at - t0).toBe(360_000);
  });

  it('a shared cooldown that ends after the deadline is not waited for', async () => {
    const clk = fakeClock();
    const id = freshId();
    const queue = new HostQueue(clk.now, clk.sleep);
    const f = scriptedFetch(clk.now, { [apiUrl(id)]: [atomOk(id)] });
    const src = await sourceWith(clk.now, queue, f.impl, { maxTotalMs: 60_000 });
    queue.cooldown('arxiv.org', clk.now() + 90_000, 'HTTP 503'); // within the 120 s cap, past the 60 s deadline
    expect(await err(src.metadata(id, undefined))).toMatchObject({ code: 'timeout', stage: 'deadline' });
    expect(f.log).toEqual([]);
    expect(clk.c.sleeps).toEqual([]);
  });
});

describe('ingest job stream while arXiv makes us wait', () => {
  it('the second job shows the shared cooldown ("… 뒤 요청 (1/4회)"), the first its retry; both finish', async () => {
    const s = await startTestServer({ env: 'prod' });
    servers.push(s);
    const a = freshId();
    const b = freshId();
    const clk = fakeClock();
    let first = true;
    const fetchImpl: FetchImpl = async (url) => {
      if (url.startsWith('https://export.arxiv.org/api/query')) {
        if (first) {
          first = false;
          return status(429, '40');
        }
        return atomOk(url.includes(a) ? a : b);
      }
      if (url.startsWith('https://arxiv.org/pdf/')) return new Response(new Uint8Array(SYNTHETIC_PDF), { headers: { 'content-type': 'application/pdf' } });
      return new Response('nope', { status: 404 });
    };
    configureIngest(s.deps, { fetchImpl, now: clk.now, queueSleep: clk.sleep });
    const ra = ingestService(s.deps).importArxiv(a);
    const rb = ingestService(s.deps).importArxiv(b);
    const [ea, eb] = await Promise.all([collectJobEvents(s.deps, ra.jobId!), collectJobEvents(s.deps, rb.jobId!)]);
    const metaDetails = (ev: JobSseEvent[]) => ev.flatMap((e) => (e.event === 'job.step' && e.data.step === 'metadata' && e.data.status === 'running' && e.data.detail ? [e.data.detail] : []));
    expect(metaDetails(ea)).toEqual(['arXiv 응답 대기 (HTTP 429) — 40초 뒤 재시도 (2/4회)']);
    expect(metaDetails(eb)).toEqual(['arXiv 응답 대기 (HTTP 429) — 40초 뒤 요청 (1/4회)']);
    expect(ea.at(-1)!.event).toBe('job.done');
    expect(eb.at(-1)!.event).toBe('job.done');
    expect(retryDetail({ attempt: 2, maxAttempts: 4, waitMs: 59_500, cause: 'timeout' })).toBe('arXiv 응답 대기 (응답 없음) — 60초 뒤 재시도 (2/4회)');
  });

  it('Retry-After over the cap: the job fails at once with the Korean reason and stays retryable', async () => {
    const s = await startTestServer({ env: 'prod' });
    servers.push(s);
    const id = freshId();
    const clk = fakeClock();
    let apiCalls = 0;
    const fetchImpl: FetchImpl = async (url) => {
      if (url.startsWith('https://export.arxiv.org/api/query')) {
        apiCalls++;
        return apiCalls === 1 ? status(429, '600') : atomOk(id);
      }
      return new Response(new Uint8Array(SYNTHETIC_PDF), { headers: { 'content-type': 'application/pdf' } });
    };
    configureIngest(s.deps, { fetchImpl, now: clk.now, queueSleep: clk.sleep });
    const res = ingestService(s.deps).importArxiv(id);
    const events = await collectJobEvents(s.deps, res.jobId!);
    expect(events.at(-1)).toMatchObject({ event: 'job.error', data: { code: 'network', message: 'arXiv가 약 10분 뒤 다시 요청하라고 응답했습니다 (HTTP 429) — 그 뒤 다시 시도하세요' } });
    expect(apiCalls).toBe(1);
    expect(paperRow(s.deps, res.paperId)?.ingestStatus).toBe('failed');
    // A retry inside the cooldown stops again without a request (remaining time); after it, the retry succeeds.
    clk.c.t += 300_000;
    const r1 = ingestService(s.deps).retry(res.paperId);
    const r1Events = await collectJobEvents(s.deps, r1.jobId);
    expect(r1Events.at(-1)).toMatchObject({ event: 'job.error', data: { message: expect.stringContaining('약 5분 뒤') } });
    expect(apiCalls).toBe(1);
    clk.c.t += 300_000;
    const r2 = ingestService(s.deps).retry(res.paperId);
    expect((await waitJob(s.deps, r2.jobId)).status).toBe('done');
    expect(apiCalls).toBe(2);
  });
});
