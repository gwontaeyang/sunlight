import { describe, expect, it } from 'vitest';
import { HostQueue } from '../../src/ingest/hostQueue';
import { ALLOWED_HOSTS, BYTE_LIMITS, checkUrl, FetchError, safeFetch, safeFetchText, USER_AGENT, type FetchImpl, type SafeFetchOptions } from '../../src/ingest/safeFetch';

/** A queue whose clock jumps 1 min per read, so the 3 s spacing never waits in these tests (hostQueue.test covers it). */
const fastQueue = () => {
  let t = 0;
  return new HostQueue(() => (t += 60_000));
};

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
function mockFetch(route: Route) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return route(url, init);
  };
  return { impl, calls };
}

const opts = (fetchImpl: FetchImpl, extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({ kind: 'atom', queue: fastQueue(), fetchImpl, ...extra });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof FetchError ? e.code : `other:${(e as Error).message}`;
  }
  return 'resolved';
};

describe('checkUrl', () => {
  it.each([
    ['http://arxiv.org/abs/1', 'http'],
    ['https://evil.com/abs/1', 'host'],
    ['https://arxiv.org.evil.com/x', 'host'],
    ['https://user:pw@arxiv.org/x', 'userinfo'],
    ['https://user@arxiv.org/x', 'userinfo'],
    ['https://arxiv.org:8443/x', 'port'],
    ['https://127.0.0.1/x', 'IP'],
    ['file:///etc/passwd', 'file'],
    ['not a url', 'garbage'],
  ])('blocks %s (%s)', (url) => {
    expect(() => checkUrl(url)).toThrow(FetchError);
  });
  it('allows the default https port and both arXiv hosts', () => {
    expect(checkUrl('https://arxiv.org:443/pdf/2209.15397v2').href).toBe('https://arxiv.org/pdf/2209.15397v2');
    expect(checkUrl('https://export.arxiv.org/api/query?id_list=2209.15397').hostname).toBe('export.arxiv.org');
  });
});

describe('safeFetch', () => {
  it('blocked URLs never reach fetch', async () => {
    const m = mockFetch(() => new Response('x'));
    for (const url of ['http://arxiv.org/x', 'https://example.com/x', 'https://a:b@arxiv.org/x', 'https://arxiv.org:8080/x']) {
      expect(await code(safeFetchText(url, opts(m.impl)))).toBe('blocked_url');
    }
    expect(m.calls).toHaveLength(0);
  });

  it('sends the app User-Agent (no personal data) and manual redirects', async () => {
    const m = mockFetch(() => new Response('<feed/>', { status: 200, headers: { 'content-type': 'application/atom+xml' } }));
    const r = await safeFetchText('https://export.arxiv.org/api/query?id_list=2209.15397', opts(m.impl));
    expect(r.text).toBe('<feed/>');
    expect(m.calls[0]!.init.redirect).toBe('manual');
    expect((m.calls[0]!.init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^study_paper\/\d+\.\d+\.\d+$/);
  });

  it('follows up to 3 allowed redirects, re-checking every hop', async () => {
    const m = mockFetch((url) => {
      const n = Number(/hop(\d)/.exec(url)?.[1] ?? 0);
      return n < 3 ? new Response(null, { status: 302, headers: { location: `/pdf/hop${n + 1}` } }) : new Response('%PDF-ok');
    });
    const r = await safeFetchText('https://arxiv.org/pdf/hop0', opts(m.impl, { kind: 'pdf' }));
    expect(r.text).toBe('%PDF-ok');
    expect(r.meta.finalUrl).toBe('https://arxiv.org/pdf/hop3');
    expect(m.calls.map((c) => c.url)).toEqual(['https://arxiv.org/pdf/hop0', 'https://arxiv.org/pdf/hop1', 'https://arxiv.org/pdf/hop2', 'https://arxiv.org/pdf/hop3']);
  });

  it('refuses a 4th redirect', async () => {
    const m = mockFetch((url) => new Response(null, { status: 301, headers: { location: `${url}x` } }));
    expect(await code(safeFetchText('https://arxiv.org/a', opts(m.impl)))).toBe('redirect');
    expect(m.calls).toHaveLength(4);
  });

  it.each([
    ['http://arxiv.org/pdf/x', 'http'],
    ['https://evil.example/pdf/x', 'other host'],
    ['https://arxiv.org:8443/pdf/x', 'other port'],
    ['https://u:p@arxiv.org/pdf/x', 'userinfo'],
  ])('refuses a redirect to %s (%s)', async (location) => {
    const m = mockFetch(() => new Response(null, { status: 302, headers: { location } }));
    expect(await code(safeFetchText('https://arxiv.org/pdf/2209.15397v2', opts(m.impl)))).toBe('blocked_url');
    expect(m.calls).toHaveLength(1);
  });

  it('maps 404 to not_found and other statuses to http_status', async () => {
    expect(await code(safeFetchText('https://arxiv.org/x', opts(mockFetch(() => new Response('no', { status: 404 })).impl)))).toBe('not_found');
    expect(await code(safeFetchText('https://arxiv.org/x', opts(mockFetch(() => new Response('busy', { status: 503 })).impl)))).toBe('http_status');
  });

  it('stops a streamed body as soon as it exceeds the byte limit', async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
        if (pulled > 1000) c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const m = mockFetch(() => new Response(body));
    expect(await code(safeFetchText('https://arxiv.org/x', opts(m.impl, { maxBytes: 10 * 1024 })))).toBe('too_large');
    expect(pulled).toBeLessThan(20);
    expect(cancelled).toBe(true);
  });

  it('refuses early on a Content-Length over the limit', async () => {
    const m = mockFetch(() => new Response('x'.repeat(100), { headers: { 'content-length': '100' } }));
    expect(await code(safeFetchText('https://arxiv.org/x', opts(m.impl, { maxBytes: 10 })))).toBe('too_large');
  });

  it('uses the kind limits: 5 MB for atom/json, 50 MB for pdf', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    expect(await code(safeFetchText('https://arxiv.org/x', opts(mockFetch(() => new Response(big)).impl, { kind: 'atom' })))).toBe('too_large');
    expect(await code(safeFetchText('https://arxiv.org/x', opts(mockFetch(() => new Response(big)).impl, { kind: 'pdf' })))).toBe('resolved');
  });

  it('M2: HTML has a 4 MB limit (PLAN_M2 P7) and the host allow-list is unchanged (arxiv.org, export.arxiv.org only)', async () => {
    expect(BYTE_LIMITS.html).toBe(4 * 1024 * 1024);
    const over = new Uint8Array(4 * 1024 * 1024 + 1);
    const at = new Uint8Array(4 * 1024 * 1024);
    expect(await code(safeFetchText('https://arxiv.org/html/2209.15397v2', opts(mockFetch(() => new Response(over)).impl, { kind: 'html' })))).toBe('too_large');
    expect(await code(safeFetchText('https://arxiv.org/html/2209.15397v2', opts(mockFetch(() => new Response(at)).impl, { kind: 'html' })))).toBe('resolved');
    expect([...ALLOWED_HOSTS].sort()).toEqual(['arxiv.org', 'export.arxiv.org']);
    expect(() => checkUrl('https://github.com/x')).toThrow(FetchError);
  });

  const hang: Route = (_url, init) =>
    new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });

  it('times out when headers do not arrive', async () => {
    const t0 = Date.now();
    expect(await code(safeFetchText('https://arxiv.org/x', opts(mockFetch(hang).impl, { headerTimeoutMs: 50 })))).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('times out when the body stalls past the total limit', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10));
      },
      pull() {
        return new Promise(() => {}); // never delivers more
      },
    });
    const m = mockFetch(() => new Response(stalled));
    expect(await code(safeFetchText('https://arxiv.org/x', opts(m.impl, { totalTimeoutMs: 100 })))).toBe('timeout');
  });

  it('caller abort → cancelled', async () => {
    const ctrl = new AbortController();
    const p = safeFetchText('https://arxiv.org/x', opts(mockFetch(hang).impl, { signal: ctrl.signal }));
    setTimeout(() => ctrl.abort(), 20);
    expect(await code(p)).toBe('cancelled');
  });

  it('a network failure becomes FetchError(network)', async () => {
    const m = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await code(safeFetchText('https://arxiv.org/x', opts(m.impl)))).toBe('network');
  });

  it('errors thrown by the consumer pass through unchanged', async () => {
    const m = mockFetch(() => new Response('abc'));
    const p = safeFetch('https://arxiv.org/x', opts(m.impl), async () => {
      throw new Error('consumer says no');
    });
    expect(await code(p)).toBe('other:consumer says no');
  });

  it('the default fetch is disabled inside tests (no accidental network)', async () => {
    expect(await code(safeFetchText('https://arxiv.org/x', { kind: 'atom', queue: fastQueue() }))).toBe('network');
  });
});
