// The only way the server fetches from the network (PLAN 3 "외부 fetch", 4.1). Owner A.
// - https only, host allow-list (M1: arxiv.org, export.arxiv.org), default port, no userinfo.
// - Redirects are followed by hand (max 3), every hop is checked again and goes through the host queue.
// - The body is read as a stream (decompressed by fetch) and aborted as soon as it exceeds the byte limit.
// - Timeouts: response headers within 20 s (callers may raise it: the arXiv API gets 60 s), each hop (headers +
//   body) within 120 s. These per-request timers start only when the host-queue slot is acquired and the request
//   really starts (M1.2 review A1: a shared cooldown wait must not eat the request's own time). The caller's
//   overall `deadline` runs from the call and covers queue waits too; it is always reported as stage 'deadline'.
//   Retries (arXiv 429/503/timeouts) are the caller's job: see arxivApi.ts.
// - `fetch` is injectable; tests never touch the network.
import { APP_VERSION } from '../config';
import { assertNetworkAllowed, guardedFetch, NetworkDisabledError } from '../security/network';
import { HostQueue, QueueAbortedError, type RunOptions } from './hostQueue';

export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['arxiv.org', 'export.arxiv.org']);
// Search uses fixed metadata endpoints. Its Crossref permission does not apply to paper downloads.
export const REFERENCE_ENDPOINTS = {
  arxiv: 'https://export.arxiv.org/api/query',
  crossref: 'https://api.crossref.org/works',
} as const;
export type ReferenceProvider = keyof typeof REFERENCE_ENDPOINTS;
export const MAX_REDIRECTS = 3;
export const HEADER_TIMEOUT_MS = 20_000;
export const TOTAL_TIMEOUT_MS = 120_000;
/** html: 4 MB (PLAN_M2 P7 — linkedom parses 3.7 MB in ~0.2 s, +84 MB RSS, in one synchronous call that cannot yield). */
export const BYTE_LIMITS = { pdf: 50 * 1024 * 1024, html: 4 * 1024 * 1024, json: 5 * 1024 * 1024, atom: 5 * 1024 * 1024 } as const;
export type FetchKind = keyof typeof BYTE_LIMITS;
/** No personal data (PLAN 4.1). */
export const USER_AGENT = `study_paper/${APP_VERSION}`;

export type FetchErrorCode = 'blocked_url' | 'redirect' | 'http_status' | 'not_found' | 'too_large' | 'timeout' | 'cancelled' | 'network';

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
    readonly status?: number,
    /** Server-requested wait (Retry-After on 429/503), in ms. */
    readonly retryAfterMs?: number,
    /**
     * For 'timeout': before the response headers (nothing consumed yet), while reading the body, or the caller's
     * overall deadline (never retried).
     */
    readonly stage?: 'headers' | 'body' | 'deadline',
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/** Retry-After: delta-seconds or an HTTP-date (RFC 9110 10.2.3). Invalid / missing → undefined. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface SafeFetchOptions {
  kind: FetchKind;
  queue: HostQueue;
  /** Restricts this call to one metadata endpoint, without redirect hops. */
  referenceProvider?: ReferenceProvider;
  fetchImpl?: FetchImpl;
  /** Caller cancellation (shutdown, paper deleted). */
  signal?: AbortSignal;
  /** Overrides for tests. */
  maxBytes?: number;
  headerTimeoutMs?: number;
  totalTimeoutMs?: number;
  accept?: string;
  /** Overall deadline (epoch ms, `now` clock) across queue wait + headers + body: the total timer never runs past it. */
  deadline?: number;
  now?: () => number;
  /** Host-queue options of this request (shared cooldown limits, wait notices). */
  queueRun?: RunOptions;
  /**
   * Called inside the host-queue slot when the request fails, before the slot is released: a returned cooldown
   * is shared with every later request of the group (M1.1 N5).
   */
  cooldownFor?: (e: unknown) => { ms: number; cause: string } | null;
}

export interface FetchMeta {
  status: number;
  finalUrl: string;
  contentType: string;
  contentLength: number | null;
}

/** Throws FetchError('blocked_url') unless the URL is https + allow-listed host + default port + no userinfo. */
export function checkUrl(raw: string, referenceProvider?: ReferenceProvider): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError('blocked_url', `not a URL: ${raw.slice(0, 200)}`);
  }
  if (u.protocol !== 'https:') throw new FetchError('blocked_url', `only https is allowed (${u.protocol})`);
  if (u.username !== '' || u.password !== '') throw new FetchError('blocked_url', 'URLs with userinfo are not allowed');
  if (u.port !== '') throw new FetchError('blocked_url', `only the default port is allowed (${u.port})`);
  if (referenceProvider) {
    if (u.origin + u.pathname !== REFERENCE_ENDPOINTS[referenceProvider])
      throw new FetchError('blocked_url', 'unexpected reference search endpoint');
    return u;
  }
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new FetchError('blocked_url', `host ${u.hostname} is not allowed`);
  return u;
}

/** The default network fetch. Disabled inside vitest unless SP_NET=1, so a test can never reach arXiv by accident. */
export const defaultFetch: FetchImpl = (input, init) => {
  if (process.env.VITEST && process.env.SP_NET !== '1') return Promise.reject(new FetchError('network', 'network access is disabled in tests (inject fetchImpl or set SP_NET=1)'));
  return guardedFetch(input, init);
};

/**
 * Network guard (S, PLAN_M2 D23): a refusal becomes FetchError('blocked_url', 'network_disabled: …') with the
 * NetworkDisabledError as `cause` — not retried (retryCause is null), told apart with isNetworkDisabled(e).
 */
function guardNetwork(what: string): void {
  try {
    assertNetworkAllowed(what);
  } catch (e) {
    if (!(e instanceof NetworkDisabledError)) throw e;
    const err = new FetchError('blocked_url', `network_disabled: ${e.message}`);
    Object.defineProperty(err, 'cause', { value: e, enumerable: false, configurable: true, writable: true });
    throw err;
  }
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches `url` and hands the body stream to `consume` (which must read it to the end or throw).
 * The host-queue slot is held until `consume` finishes. Non-2xx → FetchError('http_status' | 'not_found').
 */
export async function safeFetch<T>(url: string, opts: SafeFetchOptions, consume: (body: AsyncIterable<Uint8Array>, meta: FetchMeta) => Promise<T>): Promise<T> {
  guardNetwork(url); // S: before the queue wait
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const maxBytes = opts.maxBytes ?? BYTE_LIMITS[opts.kind];
  const now = opts.now ?? Date.now;
  const ctrl = new AbortController();
  let abortCause: FetchError | null = null;
  const abortWith = (e: FetchError) => {
    if (!abortCause) abortCause = e;
    ctrl.abort(e);
  };
  const totalMs = opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const deadlineError = () => new FetchError('timeout', 'the overall time limit for this arXiv request ran out', undefined, undefined, 'deadline');
  const leftMs = () => (opts.deadline === undefined ? Number.POSITIVE_INFINITY : opts.deadline - now());
  if (leftMs() <= 0) throw deadlineError();
  // Overall deadline: from now, across queue waits and all hops.
  const deadlineTimer = opts.deadline === undefined ? undefined : setTimeout(() => abortWith(deadlineError()), leftMs());
  const onCallerAbort = () => abortWith(new FetchError('cancelled', 'request cancelled'));
  if (opts.signal?.aborted) onCallerAbort();
  else opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

  /** One hop, run inside the host-queue slot. */
  const hopRequest = async (target: URL): Promise<{ redirect: URL } | { value: T }> => {
    // The slot is ours and the request starts now: only from here do the per-request timers run.
    const left = leftMs();
    if (left <= 0) throw deadlineError();
    const hopTimer = setTimeout(
      () => abortWith(left <= totalMs ? deadlineError() : new FetchError('timeout', `request did not finish within ${totalMs} ms`, undefined, undefined, 'body')),
      Math.min(totalMs, left),
    );
    try {
      return await hopRequestInSlot(target);
    } finally {
      clearTimeout(hopTimer);
    }
  };

  const hopRequestInSlot = async (target: URL): Promise<{ redirect: URL } | { value: T }> => {
    guardNetwork(target.href); // S: every hop, injected fetchImpl included
    const headerMs = opts.headerTimeoutMs ?? HEADER_TIMEOUT_MS;
    const headerTimer = setTimeout(() => abortWith(leftMs() <= 0 ? deadlineError() : new FetchError('timeout', `no response headers within ${headerMs} ms`, undefined, undefined, 'headers')), headerMs);
    let response: Response;
    try {
      response = await fetchImpl(target.href, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: opts.accept ?? '*/*' },
      });
    } catch (e) {
      if (e instanceof NetworkDisabledError && opts.referenceProvider) throw e;
      throw abortCause ?? toFetchError(e);
    } finally {
      clearTimeout(headerTimer);
    }
    if (REDIRECT.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      if (opts.referenceProvider) throw new FetchError('redirect', 'reference search does not follow redirects');
      const loc = response.headers.get('location');
      if (!loc) throw new FetchError('redirect', `redirect ${response.status} without Location`);
      let next: URL;
      try {
        next = new URL(loc, target);
      } catch {
        throw new FetchError('redirect', 'redirect to an invalid URL');
      }
      return { redirect: checkUrl(next.href) };
    }
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel().catch(() => {});
      throw new FetchError(
        response.status === 404 || response.status === 410 ? 'not_found' : 'http_status',
        `${target.href} → HTTP ${response.status}`,
        response.status,
        parseRetryAfter(response.headers.get('retry-after'), now()),
      );
    }
    const lenHeader = response.headers.get('content-length');
    const contentLength = lenHeader !== null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;
    // Content-Length is of the encoded body; a compressed body may still expand past the limit (checked below).
    if (contentLength !== null && contentLength > maxBytes && !response.headers.get('content-encoding')) {
      await response.body?.cancel().catch(() => {});
      throw new FetchError('too_large', `response is ${contentLength} bytes (limit ${maxBytes})`);
    }
    const meta: FetchMeta = { status: response.status, finalUrl: target.href, contentType: response.headers.get('content-type') ?? '', contentLength };
    return { value: await consume(limitBytes(response.body, maxBytes, abortWith, ctrl.signal), meta) };
  };

  try {
    let current = checkUrl(url, opts.referenceProvider);
    for (let hop = 0; ; hop++) {
      const target = current;
      const res = await opts.queue
        .run(
          target.hostname,
          async () => {
            try {
              return await hopRequest(target);
            } catch (e) {
              // Still inside the slot: a cooldown set here is seen by every request queued behind this one.
              const cd = opts.cooldownFor?.(abortCause ?? e);
              if (cd && cd.ms > 0) opts.queue.cooldown(target.hostname, now() + cd.ms, cd.cause);
              throw e;
            }
          },
          ctrl.signal,
          { ...opts.queueRun, ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}) },
        )
        .catch((e: unknown) => {
          // Our own abort reasons win; errors thrown by consume() (e.g. a bad PDF) pass through unchanged.
          if (abortCause) throw abortCause;
          if (e instanceof QueueAbortedError) throw new FetchError('cancelled', e.message);
          throw e;
        });
      if ('value' in res) {
        if (abortCause) throw abortCause; // aborted while consume() was finishing
        return res.value;
      }
      if (hop + 1 > MAX_REDIRECTS) throw new FetchError('redirect', `more than ${MAX_REDIRECTS} redirects`);
      current = res.redirect;
    }
  } finally {
    clearTimeout(deadlineTimer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
}

async function* limitBytes(body: ReadableStream<Uint8Array> | null, maxBytes: number, abortWith: (e: FetchError) => void, signal: AbortSignal): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  // Every read also ends when our controller aborts (timeout, caller), even if the body ignores the signal.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason instanceof FetchError ? signal.reason : new FetchError('cancelled', 'request aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) return;
      total += value.byteLength;
      if (total > maxBytes) {
        const e = new FetchError('too_large', `response exceeds ${maxBytes} bytes`);
        abortWith(e);
        throw e;
      }
      yield value;
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}

function toFetchError(e: unknown): FetchError {
  if (e instanceof FetchError) return e;
  if (e instanceof QueueAbortedError) return new FetchError('cancelled', e.message);
  const err = e as { name?: string; message?: string; cause?: unknown };
  if (err?.name === 'AbortError') return new FetchError('cancelled', 'request aborted');
  return new FetchError('network', `network error: ${err?.message ?? String(e)}`);
}

/** Convenience: whole body as UTF-8 text (Atom / JSON), within the kind's byte limit. */
export function safeFetchText(url: string, opts: SafeFetchOptions): Promise<{ text: string; meta: FetchMeta }> {
  return safeFetch(url, opts, async (body, meta) => {
    const chunks: Uint8Array[] = [];
    for await (const c of body) chunks.push(c);
    return { text: Buffer.concat(chunks).toString('utf8'), meta };
  });
}
