import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { API_SCHEMAS, type RouteSchemas } from '../packages/shared/src/contracts/api';
import { API_ERROR_STATUS, ErrorDtoSchema, type ApiErrorCode } from '../packages/shared/src/contracts/errors';
import { API_PREFIX, ROUTE_BY_ID, type RouteId } from '../packages/shared/src/contracts/routes';
import { formatSseEvent, JOB_TERMINAL_EVENTS, parseSseEvent, RUN_TERMINAL_EVENTS, type SseEvent } from '../packages/shared/src/contracts/sse';
import { inspectPngBytes } from '../packages/shared/src/image/png';

export const SEED_PAPER_ID = '00000000-0000-4000-8000-000000000001';
export const SEED_TITLE = 'A Synthetic Study of Point-to-Point Registration';

export function hostPort(baseURL: string): { host: string; port: number } {
  const u = new URL(baseURL);
  return { host: u.hostname, port: Number(u.port) };
}

/** Raw HTTP request with an explicit Host header (Playwright's request API always sets the real host). `body` is sent as is. */
export function rawRequest(port: number, path: string, o: { host?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { Host: o.host ?? `127.0.0.1:${port}`, ...o.headers }, setHost: false, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

/** Sends a WebSocket upgrade and returns the status line (Vite HMR checks). */
export function wsUpgrade(port: number, path: string, host: string, origin: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () =>
      s.write([`GET ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Protocol: vite-hmr', `Origin: ${origin}`, '', ''].join('\r\n')),
    );
    let buf = '';
    s.on('data', (c) => (buf += c));
    s.on('error', () => resolve('(error)'));
    setTimeout(() => {
      s.destroy();
      resolve(buf.split('\r\n')[0] || '(closed)');
    }, 800);
  });
}

export function tokenFromHtml(html: string): string {
  const m = /<meta name="sp-token" content="([0-9a-f]*)"/.exec(html);
  if (!m) throw new Error('no sp-token meta in HTML');
  return m[1]!;
}

/** Row counts of tables a successful cross-site write would change (the e2e DB of a project). */
export function dbCounts(project: 'prod' | 'dev'): Record<string, number> {
  const db = new Database(join(process.env.SP_E2E_ROOT!, project, 'db', 'study_paper.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const out: Record<string, number> = {};
    for (const t of ['papers', 'threads', 'messages', 'llm_calls', 'jobs', 'highlights']) out[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    return out;
  } finally {
    db.close();
  }
}

/** Offline arXiv source of the dev e2e server (SP_ARXIV_OFFLINE_DIR): one synthetic paper, no network. */
export const OFFLINE_ARXIV = { id: '2301.00001', version: 1, title: 'An Offline Synthetic Import' } as const;

/** Atom feed in the shape export.arxiv.org returns (synthetic values) for OFFLINE_ARXIV. */
export function offlineAtomFeed(): string {
  const { id, version, title } = OFFLINE_ARXIV;
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query</title>
  <id>http://arxiv.org/api/synthetic</id>
  <updated>2023-01-02T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/${id}v${version}</id>
    <updated>2023-01-02T00:00:00Z</updated>
    <published>2023-01-01T12:00:00Z</published>
    <title>${title}</title>
    <summary>A synthetic abstract.</summary>
    <author><name>Test Author</name></author>
    <link href="http://arxiv.org/abs/${id}v${version}" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/${id}v${version}" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.RO" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.RO" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>
`;
}

/** Token of the server behind baseURL (prod: backend HTML, dev: Vite HTML). */
export async function apiToken(baseURL: string): Promise<string> {
  const { port } = hostPort(baseURL);
  return tokenFromHtml((await rawRequest(port, '/')).text);
}

/**
 * The reading position resetSeedState stores: it opens like a paper with no saved position (page width, top of
 * page 1). The API has no "clear position" route (papers.position only stores one), so this is the closest state.
 */
export const RESET_POSITION = { page: 1, zoom: 1, mode: 'page-width', top: 0 } as const;

/**
 * Tests of one project share a server and its data dir: remove what earlier tests left on the seed papers
 * (highlights, threads) so every test starts from the seeded state. `paperIds` defaults to the M1 seed paper (the
 * M1 behaviour); M2 specs pass their papers, e.g. `[SEED_M2_PAPER_ID, SEED_LINKS_PAPER_ID]`. A paper that does not
 * exist (404) is skipped. `token` defaults to the one in the server's HTML.
 * M2: the reader saves the reading position (papers.position) while a test scrolls, and reopens the paper there, so
 * the position is reset to RESET_POSITION as well (a 404 / 409 paper — missing or without pages — is skipped).
 */
export async function resetSeedState(baseURL: string, paperIds: readonly string[] = [SEED_PAPER_ID], token?: string): Promise<void> {
  const { port } = hostPort(baseURL);
  const headers = { 'X-SP-Token': token ?? (await apiToken(baseURL)) };
  const get = async (path: string) => JSON.parse((await rawRequest(port, path, { headers })).text) as Record<string, { id: string }[]>;
  for (const paperId of paperIds) {
    const id = encodeURIComponent(paperId);
    for (const h of (await get(`/api/papers/${id}/highlights`)).highlights ?? []) await rawRequest(port, `/api/highlights/${h.id}`, { method: 'DELETE', headers });
    for (const t of (await get(`/api/papers/${id}/threads`)).threads ?? []) await rawRequest(port, `/api/threads/${t.id}`, { method: 'DELETE', headers });
    const body = JSON.stringify(RESET_POSITION);
    const pos = await rawRequest(port, `/api/papers/${id}/position`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, body });
    if (pos.status !== 204 && pos.status !== 404 && pos.status !== 409) throw new Error(`resetSeedState: papers.position ${paperId} answered ${pos.status}: ${pos.text}`);
  }
}

// =================================================================================================================
// M2 (BRIEF_S S5 · S10): seed ids, test PNGs and contract-checked route mocks for C and D.

export const SEED_UPGRADE_PAPER_ID = '00000000-0000-4000-8000-000000000002';
export const SEED_UPGRADE_TITLE = 'M2 Seed: Upgrade Target';
export const SEED_LINKS_PAPER_ID = '00000000-0000-4000-8000-000000000003';
export const SEED_LINKS_TITLE = 'M2 Seed: Link Target';
export const SEED_M2_PAPER_ID = '00000000-0000-4000-8000-000000000004';
export const SEED_M2_TITLE = 'M2 Seed: Structured Synthetic Paper';

/** Valid PNGs with correct CRCs (inspectPng passes): use these for every mock capture. */
export { makeTestPng, makeTestPngBase64, pngSize } from '../apps/server/test/helpers/png';

/** One mocked reply. `status` defaults to 200 (json/sse/png) or 204 (empty). An error is the error DTO. */
export type MockReply =
  | { kind: 'json'; body: unknown; status?: number }
  | { kind: 'sse'; events: SseEvent[] }
  | { kind: 'empty' }
  | { kind: 'png'; body: Buffer | Uint8Array }
  | { kind: 'error'; status: number; code: ApiErrorCode; message?: string; details?: unknown };

export interface MockRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  /** Parsed and validated JSON body (undefined for routes without a body). */
  body: unknown;
}

/** Throws when the request does not match the route's params / query / body schemas. Pure (no page). */
export function checkMockRequest(routeId: RouteId, req: MockRequest): void {
  const s = API_SCHEMAS[routeId] as RouteSchemas;
  if (s.params) s.params.parse(req.params);
  if (s.query) s.query.parse(req.query);
  if (s.body) s.body.parse(req.body);
  else if (req.body !== undefined && req.body !== null && req.body !== '') throw new Error(`${routeId} takes no JSON body`);
}

/**
 * Throws when a mocked reply breaks the contract of the route. Pure (no page): json → the response schema (an error →
 * the error DTO with the status of its code) / sse → every event parses, a run stream starts with run.accepted (a job
 * stream with a job event) and ends with exactly one terminal event / empty → 204 without body / png → inspectPng.
 */
export function checkMockReply(routeId: RouteId, reply: MockReply): void {
  const def = ROUTE_BY_ID[routeId];
  if (reply.kind === 'error') {
    ErrorDtoSchema.parse({ error: { code: reply.code, message: reply.message ?? reply.code, ...(reply.details !== undefined ? { details: reply.details } : {}) } });
    if (API_ERROR_STATUS[reply.code] !== reply.status) throw new Error(`${routeId}: error ${reply.code} must have status ${API_ERROR_STATUS[reply.code]}, not ${reply.status}`);
    return;
  }
  if (reply.kind !== def.response) throw new Error(`${routeId} answers ${def.response}, the mock answers ${reply.kind}`);
  if (reply.kind === 'json') {
    if ((reply.status ?? 200) >= 300) throw new Error(`${routeId}: a json reply must be 2xx (use kind 'error')`);
    (API_SCHEMAS[routeId] as RouteSchemas).response!.parse(JSON.parse(JSON.stringify(reply.body)));
  } else if (reply.kind === 'sse') {
    const family = routeId === 'jobs.events' ? 'job' : 'run';
    const terminals: readonly string[] = family === 'job' ? JOB_TERMINAL_EVENTS : RUN_TERMINAL_EVENTS;
    if (reply.events.length === 0) throw new Error(`${routeId}: empty stream`);
    for (const e of reply.events) {
      parseSseEvent(e.event, JSON.parse(JSON.stringify(e.data)));
      if (!e.event.startsWith(`${family}.`)) throw new Error(`${routeId}: ${e.event} in a ${family} stream`);
    }
    if (family === 'run' && reply.events[0]!.event !== 'run.accepted') throw new Error(`${routeId}: a run stream starts with run.accepted`);
    if (reply.events.filter((e) => terminals.includes(e.event)).length !== 1) throw new Error(`${routeId}: exactly one terminal event`);
    if (!terminals.includes(reply.events.at(-1)!.event)) throw new Error(`${routeId}: the terminal event is last`);
  } else if (reply.kind === 'png') {
    const r = inspectPngBytes(new Uint8Array(reply.body));
    if (!r.ok) throw new Error(`${routeId}: mock PNG fails inspectPng (${r.reason}) — build it with makeTestPng`);
  }
}

/** text/event-stream body of these events. */
export function mockSse(events: SseEvent[]): string {
  return events.map((e) => formatSseEvent(e)).join('');
}

/** Route path → RegExp over the full URL (named groups for :params). */
export function routeUrlPattern(routeId: RouteId): RegExp {
  const path = (API_PREFIX + ROUTE_BY_ID[routeId].path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z]+)/g, '(?<$1>[^/?#]+)');
  return new RegExp(`^[a-z]+://[^/]+${path}(?:\\?.*)?$`);
}

/** The real request path of a route: `/api` + the route path with :params filled in (encoded) + the query. */
export function routePath(routeId: RouteId, params: Record<string, string> = {}, query: Record<string, string> = {}): string {
  const path = ROUTE_BY_ID[routeId].path.replace(/:([A-Za-z]+)/g, (_, k: string) => {
    if (params[k] === undefined) throw new Error(`${routeId}: missing param ${k}`);
    return encodeURIComponent(params[k]);
  });
  const qs = new URLSearchParams(query).toString();
  return `${API_PREFIX}${path}${qs ? `?${qs}` : ''}`;
}

/**
 * The REAL server's answer to a json route, checked like a mock: the request against the route's params / query /
 * body schemas, the response must be 2xx and parse with the route's response schema (otherwise it throws). For mocks
 * that change one or two fields of a real response inside a mockRoute callback (it runs in the test process and goes
 * straight to the server, not through the page, so it never hits the page's own mocks), e.g.
 *   await mockRoute(page, 'papers.get', async (req) => ({ kind: 'json', body: { ...(await realJson<PaperDetailDto>(baseURL, 'papers.get', { params: req.params })), lastPosition: store.get('pos') ?? null } }));
 * The reply is then checked again by mockRoute. `token` defaults to the token in the server's index page.
 */
export async function realJson<T = unknown>(baseURL: string, routeId: RouteId, req: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; token?: string } = {}): Promise<T> {
  const def = ROUTE_BY_ID[routeId];
  if (def.response !== 'json') throw new Error(`realJson: ${routeId} answers ${def.response}, not json`);
  checkMockRequest(routeId, { params: req.params ?? {}, query: req.query ?? {}, body: req.body });
  const { port } = hostPort(baseURL);
  const token = req.token ?? (await apiToken(baseURL));
  const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
  const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, 'X-SP-Token': token };
    if (payload !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) });
    const r = http.request({ host: '127.0.0.1', port, path: routePath(routeId, req.params, req.query), method: def.method, headers, setHost: false, agent: false }, (out) => {
      let text = '';
      out.setEncoding('utf8');
      out.on('data', (c: string) => (text += c));
      out.on('end', () => resolve({ status: out.statusCode ?? 0, text }));
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`realJson: ${routeId} answered ${res.status}: ${res.text.slice(0, 200)}`);
  return (API_SCHEMAS[routeId] as RouteSchemas).response!.parse(JSON.parse(res.text)) as T;
}

/** Contract violations seen by mockRoute on a page (a violating reply is answered with a 500 error DTO). */
const violations = new WeakMap<Page, string[]>();
export function mockViolations(page: Page): string[] {
  return violations.get(page) ?? [];
}

/**
 * Mocks a route whose M2 behaviour another builder owns (BRIEF_COMMON): request and reply are checked against the
 * contract. A violation is recorded (mockViolations) and answered with a 500 error DTO, and the respond callback's
 * exception is rethrown — the spec fails instead of testing against an invented shape. Other methods on the same
 * URL fall through (route.fallback()).
 */
export async function mockRoute(page: Page, routeId: RouteId, respond: (req: MockRequest) => MockReply | Promise<MockReply>): Promise<void> {
  const def = ROUTE_BY_ID[routeId];
  const re = routeUrlPattern(routeId);
  await page.route(re, async (route) => {
    const request = route.request();
    if (request.method() !== def.method) return route.fallback();
    const url = new URL(request.url());
    const params = Object.fromEntries(Object.entries(re.exec(request.url())?.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    const raw = request.postData();
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const req: MockRequest = { params, query: Object.fromEntries(url.searchParams), body };
    try {
      checkMockRequest(routeId, req);
      const reply = await respond(req);
      checkMockReply(routeId, reply);
      if (reply.kind === 'error') return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify({ error: { code: reply.code, message: reply.message ?? reply.code, ...(reply.details !== undefined ? { details: reply.details } : {}) } }) });
      if (reply.kind === 'json') return route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body) });
      if (reply.kind === 'sse') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: mockSse(reply.events) });
      if (reply.kind === 'png') return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(reply.body) });
      return route.fulfill({ status: 204, body: '' });
    } catch (e) {
      const list = violations.get(page) ?? [];
      list.push(`${routeId}: ${(e as Error).message}`);
      violations.set(page, list);
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: `mock contract violation in ${routeId}` } }) });
      throw e;
    }
  });
}

/**
 * Node-side state for mocks that must survive page reloads (the handlers run in the test process): e.g.
 * papers.position PUT → the next papers.get.lastPosition, progress.put → progress.list, highlights.create(area) →
 * highlights.list + papers.capture, papers.upgradeStructure → jobs.events → papers.get / papers.list /
 * papers.structure. Values are deep-copied in and out, so a mock cannot change stored state by accident.
 */
export interface MockStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  update<T>(key: string, fn: (prev: T | undefined) => T): T;
  has(key: string): boolean;
  delete(key: string): void;
  keys(): string[];
}
export function createMockStore(initial: Record<string, unknown> = {}): MockStore {
  const m = new Map<string, unknown>(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  const copy = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
  return {
    get: <T>(k: string) => copy(m.get(k) as T | undefined),
    set: <T>(k: string, v: T) => void m.set(k, copy(v)),
    update: <T>(k: string, fn: (prev: T | undefined) => T) => {
      const next = fn(copy(m.get(k) as T | undefined));
      m.set(k, copy(next));
      return copy(next);
    },
    has: (k) => m.has(k),
    delete: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

// =================================================================================================================
// M2 integration (BRIEF_INTEGRATION I3): the skeleton's K1 offline import and its retry clean-up.

/**
 * Offline arXiv source of K1 (dev e2e server): an id no seed paper, no seed reference (2301.00099) and no other e2e
 * import (OFFLINE_ARXIV = 2301.00001, left behind by the M1 dev import test) uses, so K1's import is always a new
 * paper. playwright.config.ts puts its Atom feed, the M1 synthetic.pdf and synthetic-m2.html in the offline directory.
 */
export const OFFLINE_ARXIV_K1 = { id: '2301.00005', version: 1, title: 'An Offline Structured Import' } as const;

/** The Atom feed of offlineAtomFeed() for any synthetic paper (offlineAtomFeedOf(OFFLINE_ARXIV) === offlineAtomFeed()). */
export function offlineAtomFeedOf(p: { id: string; version: number; title: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query</title>
  <id>http://arxiv.org/api/synthetic</id>
  <updated>2023-01-02T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/${p.id}v${p.version}</id>
    <updated>2023-01-02T00:00:00Z</updated>
    <published>2023-01-01T12:00:00Z</published>
    <title>${p.title}</title>
    <summary>A synthetic abstract.</summary>
    <author><name>Test Author</name></author>
    <link href="http://arxiv.org/abs/${p.id}v${p.version}" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/${p.id}v${p.version}" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.RO" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.RO" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>
`;
}

/**
 * Deletes (papers.delete) every listed paper with this arXiv id and returns how many there were — a retried K1 starts
 * without the paper an earlier attempt imported. Throws when a delete does not answer 204.
 */
export async function deletePapersByArxivId(baseURL: string, arxivId: string, token?: string): Promise<number> {
  const { port } = hostPort(baseURL);
  const headers = { 'X-SP-Token': token ?? (await apiToken(baseURL)) };
  const list = JSON.parse((await rawRequest(port, '/api/papers', { headers })).text) as { papers: { id: string; arxivId: string | null }[] };
  const ids = list.papers.filter((p) => p.arxivId === arxivId).map((p) => p.id);
  for (const id of ids) {
    const r = await rawRequest(port, `/api/papers/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
    if (r.status !== 204) throw new Error(`deletePapersByArxivId: papers.delete ${id} answered ${r.status}: ${r.text}`);
  }
  return ids.length;
}
