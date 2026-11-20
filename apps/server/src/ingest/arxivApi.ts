// arXiv metadata (Atom API), PDF and LaTeXML HTML sources (PLAN 4.1 `metadata`, `pdf`; PLAN_M2 3.1 `html`). Owner A.
// NetworkArxivSource: export.arxiv.org/api/query + arxiv.org/pdf/<id>vN + arxiv.org/html/<id>vN through safeFetch
// (host queue, allow-list, byte limits, network guard) with the Atom response cached 7 days in http_cache.
// OfflineArxivSource (SP_ARXIV_OFFLINE_DIR, never in prod): <dir>/<id>.atom.xml + <dir>/<id>v<N>.pdf +
// <dir>/<id>v<N>.html (missing → not_found), no network.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser } from 'linkedom';
import { parseAbsUrl, versionedId } from './arxivId';
import { cooldownMessage } from './cooldownStore';
import { IngestError } from './errors';
import { QueueWaitRefusedError, type HostQueue, type RunOptions } from './hostQueue';
import { ARXIV_API_TTL_MS, type HttpCache } from './httpCache';
import { BYTE_LIMITS, FetchError, safeFetch, safeFetchText, type FetchImpl } from './safeFetch';

export interface ArxivMetadata {
  id: string;
  version: number;
  title: string;
  authors: string[];
  abstract: string | null;
  /** epoch ms of the first version (`published`). */
  publishedAt: number | null;
  primaryCategory: string | null;
  categories: string[];
  doi: string | null;
  journalRef: string | null;
}

export interface MetadataResult {
  meta: ArxivMetadata;
  /** Requests made for this result (0 = cache or offline). */
  requests: number;
}

/** A retry the source is about to wait for (shown in the job stream: "arXiv 응답 대기 — n초 뒤 재시도"). */
export interface ArxivRetryNotice {
  /** 1-based number of the attempt that starts after the wait (1 = this call waits for another request's cooldown). */
  attempt: number;
  maxAttempts: number;
  /** Remaining shared cooldown of the host queue. */
  waitMs: number;
  /** Short cause, e.g. 'HTTP 429', 'HTTP 503', 'timeout'. */
  cause: string;
}

export interface ArxivCallHooks {
  onRetry?: (n: ArxivRetryNotice) => void;
}

export interface HtmlFetchOptions {
  /** The html step's deadline (epoch ms, the source's clock): queue waits, cooldowns, headers and body included. */
  deadline: number;
}

/**
 * pdf: streams the PDF bytes of `<id>v<version>` to `consume`.
 * html: the LaTeXML HTML of `<id>v<version>` as text (≤ BYTE_LIMITS.html). A missing page is FetchError/IngestError
 * 'not_found'; every other failure keeps its FetchError (the pipeline classifies it — PLAN_M2 3.1).
 */
export interface ArxivSource {
  readonly kind: 'network' | 'offline';
  metadata(id: string, version: number | undefined, signal?: AbortSignal, hooks?: ArxivCallHooks): Promise<MetadataResult>;
  pdf<T>(id: string, version: number, consume: (chunks: AsyncIterable<Uint8Array>, size: number | null) => Promise<T>, signal?: AbortSignal, hooks?: ArxivCallHooks): Promise<T>;
  html(id: string, version: number, signal: AbortSignal | undefined, hooks: ArxivCallHooks | undefined, opts: HtmlFetchOptions): Promise<string>;
}

/**
 * arXiv retry policy (M1.1; live demo: the API answered neither within 20 s nor, on the user's retry, without
 * HTTP 429; ~10 min later it worked). The API gets a 60 s header timeout. Timeouts and HTTP 429/502/503/504 are
 * retried; at most `maxAttempts` attempts.
 *
 * Shared cooldown (M1.1.2 review N5): a failed attempt sets a cooldown on the shared host queue — the server's
 * Retry-After, or exponential backoff (15 s → 30 s → 60 s) when that is longer or absent — from inside its queue
 * slot, so EVERY arXiv request (other jobs too) waits for it, still >= 3 s apart. The waiting itself happens in
 * the queue and is reported through hooks.onRetry with the remaining shared cooldown. A cooldown longer than
 * `maxWaitMs` (120 s) is never shortened: the call stops at once with ArxivCooldownError ("arXiv가 약 N분 뒤
 * …"), the job fails and can be retried by the user later; the queue keeps the full cooldown for everyone.
 *
 * Deadline (n1): one overall deadline (`maxTotalMs`, 6 min from the first attempt) covers queue waits, headers,
 * body and cooldowns of all attempts; each request's total timer is cut to the time left and the queue refuses
 * to wait past it.
 * A PDF download is retried only when nothing was consumed yet (an HTTP status or a header timeout).
 */
export interface ArxivRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxWaitMs: number;
  maxTotalMs: number;
  /** Header timeout of export.arxiv.org/api/query. */
  apiHeaderTimeoutMs: number;
  /** Tests: a fake clock (the queue's clock should be the same). */
  now: () => number;
}

export const ARXIV_API_HEADER_TIMEOUT_MS = 60_000;
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export const DEFAULT_ARXIV_RETRY: ArxivRetryOptions = {
  maxAttempts: 4,
  baseDelayMs: 15_000,
  maxWaitMs: 120_000,
  maxTotalMs: 6 * 60_000,
  apiHeaderTimeoutMs: ARXIV_API_HEADER_TIMEOUT_MS,
  now: () => Date.now(),
};

/**
 * arXiv asked for (or the shared cooldown still needs) more than the product's wait cap: stop, retry later. The
 * message names the REAL remaining time (PLAN_M2 D28 — cooldownStore.cooldownMessage): "약 N분 뒤" under an hour,
 * otherwise the resume time; an indefinite wait (Infinity) names no date.
 */
export class ArxivCooldownError extends FetchError {
  constructor(
    readonly waitMs: number,
    cause: string,
    now: number = Date.now(),
  ) {
    super('http_status', cooldownMessage(waitMs, cause, now), undefined, waitMs);
    this.name = 'ArxivCooldownError';
  }
}

/** Whether `e` is worth another attempt; `bodySafe` = the operation may be repeated after its body was read. */
export function retryCause(e: unknown, bodySafe: boolean): string | null {
  if (!(e instanceof FetchError) || e instanceof ArxivCooldownError) return null;
  if (e.code === 'http_status' && e.status !== undefined && RETRYABLE_STATUSES.has(e.status)) return `HTTP ${e.status}`;
  if (e.code === 'timeout' && (e.stage === 'headers' || (bodySafe && e.stage === 'body'))) return 'timeout';
  return null;
}

/** What one attempt passes on to safeFetch. */
export interface AttemptContext {
  deadline: number;
  now: () => number;
  queueRun: RunOptions;
  cooldownFor: (e: unknown) => { ms: number; cause: string } | null;
}

export interface RetryContext {
  o: ArxivRetryOptions;
  bodySafe: boolean;
  signal?: AbortSignal;
  hooks?: ArxivCallHooks;
}

/** Runs `attempt` under the retry policy (see ArxivRetryOptions). */
export async function withArxivRetry<T>(attempt: (ctx: AttemptContext) => Promise<T>, c: RetryContext): Promise<T> {
  const { o } = c;
  const deadline = o.now() + o.maxTotalMs;
  let last: unknown = null;
  for (let n = 1; ; n++) {
    const ctx: AttemptContext = {
      deadline,
      now: o.now,
      queueRun: {
        maxCooldownWaitMs: o.maxWaitMs,
        onCooldownWait: (waitMs, cd) => c.hooks?.onRetry?.({ attempt: n, maxAttempts: o.maxAttempts, waitMs, cause: cd.cause }),
      },
      cooldownFor: (e) => {
        const cause = retryCause(e, c.bodySafe);
        if (!cause) return null;
        const asked = e instanceof FetchError ? (e.retryAfterMs ?? 0) : 0;
        return { ms: Math.max(o.baseDelayMs * 2 ** (n - 1), asked), cause };
      },
    };
    try {
      return await attempt(ctx);
    } catch (e) {
      if (e instanceof QueueWaitRefusedError) {
        if (e.kind === 'too_long') throw new ArxivCooldownError(e.waitMs, e.cooldown?.cause ?? 'cooldown', o.now());
        // The queue wait would run past the overall deadline: a deadline, never a header/body timeout (A1).
        const lastCause = last instanceof Error ? ` (last error: ${last.message})` : '';
        throw new FetchError('timeout', `the overall time limit for this arXiv request ran out while waiting for arXiv${lastCause}`, undefined, undefined, 'deadline');
      }
      const cause = retryCause(e, c.bodySafe);
      if (!cause || c.signal?.aborted) throw e;
      const asked = e instanceof FetchError ? (e.retryAfterMs ?? 0) : 0;
      if (asked > o.maxWaitMs) throw new ArxivCooldownError(asked, cause, o.now()); // the queue keeps the full cooldown
      if (n >= o.maxAttempts || o.now() >= deadline) throw e;
      last = e;
      // The next attempt waits in the queue for the cooldown this one set (reported through onCooldownWait).
    }
  }
}

const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

interface XmlEl {
  tagName: string;
  textContent: string | null;
  children: ArrayLike<XmlEl>;
  getAttribute(name: string): string | null;
}
const kids = (el: XmlEl, tag: string): XmlEl[] => Array.from(el.children).filter((c) => c.tagName.toLowerCase() === tag);
const kid = (el: XmlEl, tag: string): XmlEl | undefined => kids(el, tag)[0];

/**
 * Parses an arXiv API Atom feed and returns the entry for `id` (and `version` when given).
 * No entry → IngestError('not_found'); an `<entry>` that is the API's error report → 'not_found' too.
 */
export function parseArxivAtom(xml: string, id: string, version?: number): ArxivMetadata {
  let doc: { documentElement: XmlEl | null; getElementsByTagName(t: string): ArrayLike<XmlEl> };
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml') as never;
  } catch (e) {
    throw new IngestError('invalid_metadata', `arXiv API response is not XML: ${(e as Error).message}`);
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'feed') throw new IngestError('invalid_metadata', 'arXiv API response is not an Atom feed');
  const entries = kids(root, 'entry');
  for (const entry of entries) {
    const absId = squash(kid(entry, 'id')?.textContent);
    if (/\/api\/errors/.test(absId)) {
      throw new IngestError('not_found', `arXiv API error: ${squash(kid(entry, 'summary')?.textContent).slice(0, 300) || 'unknown'}`);
    }
    const ref = parseAbsUrl(absId);
    if (!ref || ref.id !== id) continue;
    if (version !== undefined && ref.version !== version) {
      throw new IngestError('not_found', `arXiv has no ${id}v${version} (the API returned v${ref.version})`);
    }
    const title = squash(kid(entry, 'title')?.textContent);
    if (!title) throw new IngestError('invalid_metadata', `entry ${absId} has no title`);
    const published = squash(kid(entry, 'published')?.textContent);
    const publishedAt = published ? Date.parse(published) : NaN;
    return {
      id: ref.id,
      version: ref.version,
      title,
      authors: kids(entry, 'author')
        .map((a) => squash(kid(a, 'name')?.textContent))
        .filter((n) => n.length > 0),
      abstract: squash(kid(entry, 'summary')?.textContent) || null,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      primaryCategory: kid(entry, 'arxiv:primary_category')?.getAttribute('term') ?? null,
      categories: kids(entry, 'category')
        .map((c) => c.getAttribute('term') ?? '')
        .filter((t) => t.length > 0),
      doi: squash(kid(entry, 'arxiv:doi')?.textContent) || null,
      journalRef: squash(kid(entry, 'arxiv:journal_ref')?.textContent) || null,
    };
  }
  throw new IngestError('not_found', `arXiv has no paper ${version === undefined ? id : `${id}v${version}`}`);
}

export const apiQueryUrl = (id: string, version?: number) => `https://export.arxiv.org/api/query?id_list=${version === undefined ? id : versionedId(id, version)}&max_results=1`;
export const pdfUrl = (id: string, version: number) => `https://arxiv.org/pdf/${versionedId(id, version)}`;
export const htmlUrl = (id: string, version: number) => `https://arxiv.org/html/${versionedId(id, version)}`;

async function readText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export class NetworkArxivSource implements ArxivSource {
  readonly kind = 'network' as const;
  private readonly retry: ArxivRetryOptions;
  /** Requests sent (all attempts), for logs and tests. */
  requestsSent = 0;
  constructor(
    private readonly o: { queue: HostQueue; cache: HttpCache; fetchImpl?: FetchImpl; retry?: Partial<ArxivRetryOptions> },
  ) {
    this.retry = { ...DEFAULT_ARXIV_RETRY, ...o.retry };
  }

  async metadata(id: string, version: number | undefined, signal?: AbortSignal, hooks?: ArxivCallHooks): Promise<MetadataResult> {
    const url = apiQueryUrl(id, version);
    const key = `arxiv:api:${version === undefined ? id : versionedId(id, version)}`;
    const cached = this.o.cache.get(key);
    if (cached) return { meta: parseArxivAtom(cached.body, id, version), requests: 0 };
    let requests = 0;
    const { text, meta } = await withArxivRetry(
      (ctx) => {
        requests++;
        this.requestsSent++;
        return safeFetchText(url, { kind: 'atom', queue: this.o.queue, fetchImpl: this.o.fetchImpl, signal, accept: 'application/atom+xml', headerTimeoutMs: this.retry.apiHeaderTimeoutMs, ...ctx });
      },
      { o: this.retry, bodySafe: true, signal, hooks },
    );
    const parsed = parseArxivAtom(text, id, version); // only a parseable answer with the entry is cached
    this.o.cache.put(key, meta.finalUrl, meta.status, text, ARXIV_API_TTL_MS);
    return { meta: parsed, requests };
  }

  pdf<T>(id: string, version: number, consume: (chunks: AsyncIterable<Uint8Array>, size: number | null) => Promise<T>, signal?: AbortSignal, hooks?: ArxivCallHooks): Promise<T> {
    return withArxivRetry(
      (ctx) => {
        this.requestsSent++;
        return safeFetch(pdfUrl(id, version), { kind: 'pdf', queue: this.o.queue, fetchImpl: this.o.fetchImpl, signal, accept: 'application/pdf', ...ctx }, (body, meta) => consume(body, meta.contentLength));
      },
      { o: this.retry, bodySafe: false, signal, hooks },
    );
  }

  /**
   * arxiv.org/html/<id>vN under the same queue, cooldown and retry rules, but with ONE deadline for the whole step
   * (PLAN_M2 3.1: 60 s including queue waits and cooldowns — decided before the first wait from the time left).
   */
  html(id: string, version: number, signal: AbortSignal | undefined, hooks: ArxivCallHooks | undefined, opts: HtmlFetchOptions): Promise<string> {
    const left = opts.deadline - this.retry.now();
    return withArxivRetry(
      (ctx) => {
        this.requestsSent++;
        return safeFetch(htmlUrl(id, version), { kind: 'html', queue: this.o.queue, fetchImpl: this.o.fetchImpl, signal, accept: 'text/html', ...ctx }, (body) => readText(body));
      },
      { o: { ...this.retry, maxTotalMs: Math.min(this.retry.maxTotalMs, left) }, bodySafe: true, signal, hooks },
    );
  }
}

/** Test/e2e source: never touches the network. File names: `<id>.atom.xml`, `<id>v<N>.pdf` (old-style ids keep their `/`). */
export class OfflineArxivSource implements ArxivSource {
  readonly kind = 'offline' as const;
  constructor(readonly dir: string) {}

  async metadata(id: string, version: number | undefined): Promise<MetadataResult> {
    const file = join(this.dir, `${id}.atom.xml`);
    if (!existsSync(file)) throw new IngestError('not_found', `offline source has no ${id}.atom.xml`);
    // The offline Atom file describes the paper; a requested version is accepted when its PDF exists.
    const meta = parseArxivAtom(readFileSync(file, 'utf8'), id);
    if (version !== undefined && version !== meta.version) {
      if (!existsSync(join(this.dir, `${versionedId(id, version)}.pdf`))) throw new IngestError('not_found', `offline source has no ${versionedId(id, version)}.pdf`);
      return { meta: { ...meta, version }, requests: 0 };
    }
    return { meta, requests: 0 };
  }

  async pdf<T>(id: string, version: number, consume: (chunks: AsyncIterable<Uint8Array>, size: number | null) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const file = join(this.dir, `${versionedId(id, version)}.pdf`);
    if (!existsSync(file)) throw new IngestError('not_found', `offline source has no ${versionedId(id, version)}.pdf`);
    const size = statSync(file).size;
    if (size > BYTE_LIMITS.pdf) throw new IngestError('too_large', `PDF is ${size} bytes (limit ${BYTE_LIMITS.pdf})`);
    const stream = createReadStream(file, { signal });
    return consume(stream as AsyncIterable<Uint8Array>, size);
  }

  async html(id: string, version: number): Promise<string> {
    const file = join(this.dir, `${versionedId(id, version)}.html`);
    if (!existsSync(file)) throw new FetchError('not_found', `offline source has no ${versionedId(id, version)}.html`, 404);
    const size = statSync(file).size;
    if (size > BYTE_LIMITS.html) throw new FetchError('too_large', `HTML is ${size} bytes (limit ${BYTE_LIMITS.html})`);
    return readFileSync(file, 'utf8');
  }
}
