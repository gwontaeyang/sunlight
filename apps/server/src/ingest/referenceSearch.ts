// A user-initiated lookup sends bibliographic metadata only. Candidate links are returned to the reader;
// the server never fetches a DOI, publisher URL, or full text while searching.
import type { ReferenceCandidate, ReferenceSearchRequest } from '@study-paper/shared/contracts/api';
import { NetworkDisabledError, assertNetworkAllowed, isNetworkDisabled } from '../security/network';
import { parseAtomEntries, pdfUrl, RETRYABLE_STATUSES } from './arxivApi';
import { parseArxivInput, versionedId } from './arxivId';
import { QueueWaitRefusedError, type HostQueue } from './hostQueue';
import { FetchError, REFERENCE_ENDPOINTS, safeFetchText, type FetchImpl, type ReferenceProvider } from './safeFetch';

const ROWS = 5;
const MAX_BYTES = 256 * 1024;
const DEADLINE_MS = 15_000;
const PROVIDERS: readonly ReferenceProvider[] = ['arxiv', 'crossref'];

export class ReferenceSearchError extends Error {
  constructor(readonly kind: 'unavailable' | 'timeout' | 'busy') {
    super(`reference search: ${kind}`);
  }
}

export interface ReferenceSearchOptions {
  queue: HostQueue;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trimEnd() : '';
}
function doiOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || !/^10\.\d{4,9}\/[^\s<>\\\u0000-\u001f\u007f]+$/u.test(value)) return null;
  return value.split('/').some(p => p === '.' || p === '..') ? null : value;
}

function words(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function titleScore(query: string[], candidate: string): number {
  const terms = words(candidate);
  if (!terms.length || !query.length) return 0;
  if (query.join(' ') === terms.join(' ')) return 1;
  const a = new Set(query), b = new Set(terms);
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return 0.95 * (2 * common) / (a.size + b.size);
}

function readArxiv(xml: string): ReferenceCandidate[] {
  // Atom results contain a small number of metadata tags. Bound synchronous XML tree work as well as bytes.
  let tags = 0;
  for (const c of xml) if (c === '<' && ++tags > 2_000) throw new Error('oversized Atom structure');
  const rows: ReferenceCandidate[] = [];
  for (const entry of parseAtomEntries(xml).slice(0, ROWS)) {
    const children = Array.from(entry.children);
    const field = (name: string) => children.find(e => e.tagName.toLowerCase() === name)?.textContent?.trim();
    const id = field('id');
    if (id && /^https?:\/\/arxiv\.org\/api\/errors(?:\/|#|$)/i.test(id)) throw new Error('arXiv query refused');
    if (!id || !/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/abs\//i.test(id)) continue;
    const ref = parseArxivInput(id);
    const title = clean(field('title'), 2048);
    if (!title || !ref?.version) continue;
    const arxivId = versionedId(ref.id, ref.version);
    const year = /^([1-9]\d{3})-/.exec(field('published') ?? '');
    rows.push({
      source: 'arxiv', title, arxivId, absUrl: `https://arxiv.org/abs/${arxivId}`, pdfUrl: pdfUrl(ref.id, ref.version),
      authors: children.filter(e => e.tagName.toLowerCase() === 'author').slice(0, 50)
        .map(e => clean(Array.from(e.children).find(c => c.tagName.toLowerCase() === 'name')?.textContent, 512)).filter(Boolean),
      year: year ? Number(year[1]) : null, doi: doiOf(field('arxiv:doi')), score: 0, inLibraryPaperId: null,
    });
  }
  return rows;
}

type Fields = Record<string, unknown>;
function fields(value: unknown): Fields {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
}
function firstItems(value: unknown, max: number): Fields[] {
  return Array.isArray(value) ? value.slice(0, max).map(fields) : [];
}

function openLicense(license: Fields, version: unknown, now: number): boolean {
  if (version !== 'vor' && version !== 'am') return false;
  if (license['content-version'] !== version || typeof license.URL !== 'string') return false;
  if (!/^https?:\/\/creativecommons\.org\/(?:licenses\/by(?:-nc-nd|-nc-sa|-nc|-nd|-sa)?\/[1-4]\.0|publicdomain\/zero\/1\.0)\/?$/i.test(license.URL)) return false;
  const start = fields(license.start);
  const timestamp = typeof start.timestamp === 'number' ? start.timestamp :
    typeof start['date-time'] === 'string' ? Date.parse(start['date-time']) : NaN;
  return Number.isFinite(timestamp) && timestamp <= now;
}

function publicPdf(item: Fields, now: number): string | null {
  const licenses = firstItems(item.license, 32);
  for (const link of firstItems(item.link, 32)) {
    if (link['content-type'] !== 'application/pdf') continue;
    const use = link['intended-application'];
    if (use !== undefined && use !== 'unspecified') continue;
    if (!licenses.some(license => openLicense(license, link['content-version'], now))) continue;
    if (typeof link.URL !== 'string' || link.URL.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(link.URL)) continue;
    const u = URL.parse(link.URL);
    if (!u || u.protocol !== 'https:' || u.username || u.password || u.port) continue;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!/^[\w.-]+\.[a-z]{2,63}$/i.test(host) || /\.(?:localhost|local|internal|localdomain|lan|home|arpa|onion|invalid|test)$/.test(host)) continue;
    if (u.href.length <= 4096) return u.href;
  }
  return null;
}

function readCrossref(json: string, now: number): ReferenceCandidate[] {
  const envelope = fields(JSON.parse(json));
  const items = fields(envelope.message).items;
  if (envelope.status !== 'ok' || !Array.isArray(items)) throw new Error('invalid Crossref response');
  const rows: ReferenceCandidate[] = [];
  for (const item of firstItems(items, ROWS)) {
    const doi = doiOf(item.DOI);
    const title = Array.isArray(item.title) ? clean(item.title[0], 2048) : '';
    if (!doi || !title) continue;
    const dateParts = fields(item.published ?? item.issued)['date-parts'];
    const year = Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? dateParts[0][0] : null;
    const doiUrl = 'https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/');
    if (doiUrl.length > 4096) continue;
    rows.push({
      source: 'crossref', title, doi, arxivId: null, pdfUrl: publicPdf(item, now), absUrl: doiUrl,
      authors: firstItems(item.author, 50).map(a => clean([a.given, a.family].filter(v => typeof v === 'string').join(' ') || a.name, 512)).filter(Boolean),
      year: Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null, score: 0, inLibraryPaperId: null,
    });
  }
  return rows;
}

async function lookup(provider: ReferenceProvider, q: ReferenceSearchRequest, opts: ReferenceSearchOptions, deadline: number): Promise<ReferenceCandidate[]> {
  const url = new URL(REFERENCE_ENDPOINTS[provider]);
  if (provider === 'arxiv') {
    // Put only words inside a single quoted title expression; user input cannot supply arXiv operators.
    const title = words(q.title).join(' ');
    if (!title) return [];
    url.searchParams.set('search_query', `ti:"${title}"`);
    url.searchParams.set('max_results', String(ROWS));
  } else {
    url.searchParams.set('query.bibliographic', [q.title, ...(q.authors ?? []), q.year].filter(Boolean).join(' '));
    url.searchParams.set('rows', String(ROWS));
    url.searchParams.set('select', 'DOI,title,author,published,issued,license,link');
  }
  const { text } = await safeFetchText(url.href, {
    ...opts, referenceProvider: provider, kind: provider === 'arxiv' ? 'atom' : 'json',
    accept: provider === 'arxiv' ? 'application/atom+xml' : 'application/json',
    maxBytes: MAX_BYTES, headerTimeoutMs: 8_000, totalTimeoutMs: DEADLINE_MS, deadline,
    cooldownFor: e => e instanceof FetchError && e.status && RETRYABLE_STATUSES.has(e.status)
      ? { ms: Math.max(15_000, e.retryAfterMs ?? 0), cause: `HTTP ${e.status}` } : null,
  });
  return provider === 'arxiv' ? readArxiv(text) : readCrossref(text, Date.now());
}

export async function findReferences(query: ReferenceSearchRequest, opts: ReferenceSearchOptions): Promise<{
  candidates: ReferenceCandidate[]; unavailable: ReferenceProvider[];
}> {
  assertNetworkAllowed('reference metadata search');
  // Bound both active work and waiters. The arXiv queue is the same object used by the ingestion pipeline.
  if (PROVIDERS.some(provider => opts.queue.pending(new URL(REFERENCE_ENDPOINTS[provider]).hostname) >= 4))
    throw new ReferenceSearchError('busy');
  const deadline = Date.now() + DEADLINE_MS;
  const responses = await Promise.allSettled(PROVIDERS.map(p => lookup(p, query, opts, deadline)));
  const candidates: ReferenceCandidate[] = [];
  const unavailable: ReferenceProvider[] = [];
  const terms = words(query.title);
  let timedOut = false;
  const seen = new Set<string>();
  for (const [i, response] of responses.entries()) {
    if (response.status === 'rejected') {
      const e: unknown = response.reason;
      if (isNetworkDisabled(e)) throw e instanceof NetworkDisabledError ? e : (e as Error).cause;
      timedOut ||= e instanceof QueueWaitRefusedError || (e instanceof FetchError && e.code === 'timeout');
      unavailable.push(PROVIDERS[i]!);
      continue;
    }
    for (const row of response.value) {
      row.score = titleScore(terms, row.title);
      const key = (row.arxivId || row.doi)!.toLowerCase();
      if (!row.score || seen.has(key)) continue;
      seen.add(key);
      candidates.push(row);
    }
  }
  if (unavailable.length === PROVIDERS.length) throw new ReferenceSearchError(timedOut ? 'timeout' : 'unavailable');
  const authorHints = new Set((query.authors ?? []).flatMap(words));
  const authorMatches = (c: ReferenceCandidate) => c.authors.flatMap(words).filter(w => authorHints.has(w)).length;
  candidates.sort((a, b) => b.score - a.score || Number(b.year === query.year) - Number(a.year === query.year) ||
    authorMatches(b) - authorMatches(a) || Number(b.source === 'arxiv') - Number(a.source === 'arxiv'));
  return { candidates: candidates.slice(0, ROWS), unavailable };
}
