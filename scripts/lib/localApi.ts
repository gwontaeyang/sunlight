// Loopback HTTP client of the integration scripts (BRIEF_INTEGRATION "script 공통 규칙", I7, I9). Owner: supervisor.
// The ONE way scripts/** talk to a local study_paper server: scripts may not use fetch, node:http(s) or
// child_process (network.entrypoints / spawn.entrypoints scan them), so every request goes through a Playwright
// APIRequestContext (get / post / put / delete — never `.fetch(`).
// Two call styles share one client and one set of rules (INTEGRATION_NOTES 결정 9):
// - by route id (live E2E): json / sse / bytes(id, { params, body, timeoutMs }) — bodies and JSON answers are
//   checked with the route's contract schema, non-2xx throws;
// - by path (rehearsal): get / post / put / delete(path, { json, noToken, timeoutMs }) and sse(method, path, …) —
//   status and body come back as they are; getText(path) is a plain-text GET.
// Rules this file keeps:
// - host 127.0.0.1 only, http only, an explicit port 1024–65535 that is not one of the forbidden ports (user demo
//   4310 / 5173, e2e defaults 4321–4329 / 5175): anything else throws when the client is made, before any request;
// - every call takes `timeoutMs` (no default: 0, negative, NaN or Infinity throw). Playwright's own default is 30 s,
//   and the routes that start a run answer with the run's SSE stream — a client that gives up at 30 s cuts the stream
//   and the server cancels a cancelOnDisconnect task after the live ledger already reserved the call. Run streams
//   therefore wait runStreamTimeoutMs(task) — the one formula;
// - ONE path validator (resolvePath) for every request of both styles: the path starts with a single `/`, has no
//   backslash or control character (the URL parser reads `\` as `/` and drops tabs and newlines, so `//h`, `/\h` and
//   `/\t/h` name another host — and the token header would go with it) and resolves to the base origin. Anything
//   else throws before a request; the request goes to the checked absolute URL (no second resolution);
// - SSE bodies are read whole (the request ends with the terminal event) and each event is checked with the
//   contract's parseSseEvent;
// - token: prod → the `sp-token` meta of the backend's `/` HTML (the same rule as the e2e helper tokenFromHtml —
//   the e2e helpers vitest file compares the two), dev → the runtime token file of the port (security/runtimePaths)
//   under ONE rule (devTokenPath = devTokenFile): the server's XDG_RUNTIME_DIR or SP_DATA_DIR must be given, and no
//   token file is read from under the real data directory;
// - every request sent after the client is made is recorded in `calls` (method, path, status; 0 = no answer).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { tokenFilePath } from '../../apps/server/src/security/runtimePaths';
import { API_SCHEMAS } from '../../packages/shared/src/contracts/api';
import { API_PREFIX, ROUTE_BY_ID, routePath, type RouteId } from '../../packages/shared/src/contracts/routes';
import { JOB_TERMINAL_EVENTS, parseSseEvent, RUN_TERMINAL_EVENTS, type SseEvent } from '../../packages/shared/src/contracts/sse';
import { QUEUE_TIMEOUT_MS, TASK_SPECS, type TaskId } from '../../packages/shared/src/contracts/tasks';
import { realDataDirPrefixOf } from './realDataDir';

/** Ports no script may talk to: the user's demo server (4310 / 5173) and the e2e defaults (4321–4329 / 5175). */
export const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([4310, 5173, 4321, 4322, 4323, 4324, 4325, 4326, 4327, 4328, 4329, 5175]);
export const LOCAL_HOST = '127.0.0.1';
/** Slack added to a run's own limits (totalMs + queue wait) for the client side of its stream. */
export const RUN_STREAM_SLACK_MS = 30_000;
/** RUN_STREAM_SLACK_MS under the rehearsal's name. */
export const STREAM_SLACK_MS = RUN_STREAM_SLACK_MS;
export const TOKEN_HEADER = 'X-SP-Token';

export class LocalApiError extends Error {
  constructor(
    readonly kind: 'timeout' | 'http_status' | 'schema' | 'transport' | 'usage',
    message: string,
    readonly status?: number,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'LocalApiError';
  }
}

/** Throws unless `ms` is a positive finite number of milliseconds. */
export function checkTimeoutMs(ms: number): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) throw new LocalApiError('usage', `timeoutMs must be a positive finite number of ms, not ${String(ms)}`);
  return ms;
}

/** checkTimeoutMs as an assertion (the rehearsal's name). */
export function assertTimeout(timeoutMs: unknown): asserts timeoutMs is number {
  checkTimeoutMs(timeoutMs as number);
}

/** Client wait for the SSE stream of one run of `task`: TASK_SPECS[task].totalMs + its queue limit + 30 s. */
export function runStreamTimeoutMs(task: TaskId): number {
  const spec = TASK_SPECS[task];
  return spec.totalMs + QUEUE_TIMEOUT_MS[spec.priority] + RUN_STREAM_SLACK_MS;
}

/** http://127.0.0.1:<port> with an allowed port (explicit, 1024–65535, not forbidden), or a throw. */
export function checkBaseUrl(baseUrl: string): URL {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new LocalApiError('usage', `not a URL: ${baseUrl}`);
  }
  if (u.protocol !== 'http:') throw new LocalApiError('usage', `only http:// is allowed (${u.protocol})`);
  if (u.hostname !== LOCAL_HOST) throw new LocalApiError('usage', `only ${LOCAL_HOST} is allowed, not ${u.hostname}`);
  if (u.username !== '' || u.password !== '') throw new LocalApiError('usage', 'no userinfo');
  if (u.port === '') throw new LocalApiError('usage', 'the base URL needs an explicit port');
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new LocalApiError('usage', `the base URL needs a port 1024–65535, not ${u.port}`);
  if (FORBIDDEN_PORTS.has(port)) throw new LocalApiError('usage', `port ${port} is forbidden for scripts (user demo / e2e defaults)`);
  if ((u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '') throw new LocalApiError('usage', 'the base URL is http://127.0.0.1:<port> only');
  return u;
}

/** checkBaseUrl as { origin, port } with the port as a number (the same checks). */
export function checkBaseOrigin(baseUrl: string): { origin: string; port: number } {
  const u = checkBaseUrl(baseUrl);
  return { origin: u.origin, port: Number(u.port) };
}

/**
 * THE path validator of every request: a string that starts with a single `/`, without a backslash or a control
 * character, that resolves against `origin` to `origin` itself. Returns the absolute URL the request goes to.
 * Throws a 'usage' LocalApiError (its message names the path) otherwise.
 */
export function resolvePath(origin: string, path: string): string {
  const o = new URL(origin).origin;
  if (typeof path !== 'string' || !path.startsWith('/')) throw new LocalApiError('usage', `path must start with /, got ${JSON.stringify(path)}`);
  if (path.startsWith('//')) throw new LocalApiError('usage', `path must not start with // (it would name another host), got ${JSON.stringify(path)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(path)) throw new LocalApiError('usage', `path must not contain a backslash or a control character (it could name another host), got ${JSON.stringify(path)}`);
  const u = new URL(path, o);
  if (u.origin !== o) throw new LocalApiError('usage', `path ${JSON.stringify(path)} resolves outside ${o} (to ${u.origin})`);
  return u.href;
}

/** resolvePath against a base URL, returning the path itself (the live E2E name; the same rules). */
export function checkLocalPath(path: string, base: string): string {
  resolvePath(base, path);
  return path;
}

/** The prod token: the `sp-token` meta of the backend's HTML (same regular expression as the e2e helper tokenFromHtml). */
export function tokenFromHtml(html: string): string {
  const m = /<meta name="sp-token" content="([0-9a-f]*)"/.exec(html);
  if (!m) throw new Error('no sp-token meta in HTML');
  return m[1]!;
}

/**
 * text/event-stream body → contract events (each checked with parseSseEvent; a bad event throws). Comment lines
 * (`:`) and unknown fields are skipped; `data:` lines of one event are joined with \n (the server sends one line).
 */
export function parseSseText(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split('\n\n')) {
    let name: string | null = null;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
    }
    if (name === null && data.length === 0) continue;
    if (name === null) throw new Error('SSE event without a name');
    events.push(parseSseEvent(name, JSON.parse(data.join('\n'))));
  }
  return events;
}

/** parseSseText under the rehearsal's name. */
export const parseSseBody: (body: string) => SseEvent[] = parseSseText;

// ------------------------------------------------------------------------------------------------------------------
// dev token file: one rule

/**
 * Refuses a path under the real data directory: ~/.local/share/study_paper* or $XDG_DATA_HOME/study_paper* (string
 * prefix, so study_paper-pre-m2 and the like count), also after resolving symbolic links — the shared rule of
 * ./realDataDir (the one dataSnapshot uses). No switch turns it off here.
 */
function assertNotUnderRealDataDir(label: string, path: string, env: Record<string, string | undefined>): void {
  const pre = realDataDirPrefixOf(path, env);
  if (pre !== null) throw new LocalApiError('usage', `${label} ${resolve(path)} is under the real data directory (${pre}…)`);
}

/**
 * The dev token file of the server on `port` whose environment is `env` (its XDG_RUNTIME_DIR / SP_DATA_DIR). One of
 * the two must be set — without both, the path falls back to the real data directory — and the file must not be under
 * the real data directory.
 */
export function devTokenPath(port: number, env: Record<string, string | undefined>): string {
  if (!env.XDG_RUNTIME_DIR && !env.SP_DATA_DIR) throw new LocalApiError('usage', "dev token: XDG_RUNTIME_DIR or SP_DATA_DIR must be set (the server's runtime directory)");
  const p = tokenFilePath(port, env);
  assertNotUnderRealDataDir('dev token file', p, env);
  return p;
}

/** devTokenPath under the live E2E name (the same rule). */
export function devTokenFile(port: number, serverEnv: Record<string, string | undefined>): string {
  return devTokenPath(port, serverEnv);
}

// ------------------------------------------------------------------------------------------------------------------
// client

/** Options of a call by route id. */
export interface CallOptions {
  params?: Record<string, string>;
  body?: unknown;
  /** Required: the whole request (headers and body) must end within this time. */
  timeoutMs: number;
}

/** Options of a call by path. */
export interface PathCallOptions {
  /** Required: the whole request (headers and body) must end within this time. */
  timeoutMs: number;
  /** JSON body (post / put). */
  json?: unknown;
  /** Send without the token header (token-less probes). */
  noToken?: boolean;
}

/** Result of sse(id, …). */
export interface SseResult {
  status: number;
  events: SseEvent[];
  /** run.done / run.error (run routes) or job.done / job.error (jobs.events); null = the stream ended without one. */
  terminal: SseEvent | null;
  /** Client-side wall time of the whole request. */
  ms: number;
}

/** Result of get / post / put / delete(path, …). */
export interface LocalResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  text: string;
  /** JSON body (throws when it is not JSON). */
  json<T = unknown>(): T;
}

/** Result of sse(method, path, …). */
export interface SseResponse {
  status: number;
  /** Events in order (checked with parseSseEvent); empty when the status is not 200. */
  events: SseEvent[];
  /** The body when the status is not 200 (an error DTO). */
  text: string;
}

export interface CallRecord {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** HTTP status; 0 = no answer (timeout or transport error). */
  status: number;
}

type Method = CallRecord['method'];
type TokenOption = 'html' | { file: string } | { value: string };
type Env = Record<string, string | undefined>;

const TERMINALS: ReadonlySet<string> = new Set<string>([...RUN_TERMINAL_EVENTS, ...JOB_TERMINAL_EVENTS]);

function isTimeoutError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /Timeout \d+ms exceeded|timed? ?out/i.test(msg);
}

async function sendRaw(ctx: APIRequestContext, method: Method, url: string, label: string, headers: Record<string, string>, timeout: number, data?: string): Promise<APIResponse> {
  const opts = { timeout, headers, failOnStatusCode: false, maxRedirects: 0, ...(data !== undefined ? { data } : {}) };
  try {
    if (method === 'GET') return await ctx.get(url, opts);
    if (method === 'POST') return await ctx.post(url, opts);
    if (method === 'PUT') return await ctx.put(url, opts);
    return await ctx.delete(url, opts);
  } catch (e) {
    if (isTimeoutError(e)) throw new LocalApiError('timeout', `${method} ${label}: no complete response within ${timeout} ms`);
    throw new LocalApiError('transport', `${method} ${label}: ${(e as Error).message.split('\n')[0]}`);
  }
}

export class LocalApi {
  /** Every request sent by this client, in order (method, path, status) — the rehearsal records it (m1 server: GET only). */
  readonly calls: CallRecord[] = [];

  private constructor(
    /** http://127.0.0.1:<port> */
    readonly baseUrl: string,
    readonly port: number,
    private readonly ctx: APIRequestContext,
    /** The token sent in X-SP-Token; null = none. */
    readonly token: string | null,
  ) {}

  /** The base origin (the same string as baseUrl). */
  get origin(): string {
    return this.baseUrl;
  }

  /**
   * A client for `baseUrl`. token: 'html' reads the prod meta from `/`; { file } reads a token file (use devTokenFile);
   * { value } uses the given token.
   */
  static open(baseUrl: string, o: { token: TokenOption; timeoutMs: number }): Promise<LocalApi>;
  /**
   * A client for `baseUrl`. token: 'dev' reads the runtime token file of the port (env = the server's XDG_RUNTIME_DIR /
   * SP_DATA_DIR, default process.env), 'prod' reads the meta of `/`, 'none' sends no token.
   */
  static open(o: { baseUrl: string; token: 'dev' | 'prod' | 'none'; timeoutMs: number; env?: Env }): Promise<LocalApi>;
  static async open(a: string | { baseUrl: string; token: 'dev' | 'prod' | 'none'; timeoutMs: number; env?: Env }, b?: { token: TokenOption; timeoutMs: number }): Promise<LocalApi> {
    const u = checkBaseUrl(typeof a === 'string' ? a : a.baseUrl);
    const timeoutMs = checkTimeoutMs(typeof a === 'string' ? (b as { timeoutMs: number }).timeoutMs : a.timeoutMs);
    const port = Number(u.port);
    const origin = u.origin;
    const env: Env = typeof a === 'string' ? process.env : (a.env ?? process.env);
    let tokenOpt: TokenOption | null;
    if (typeof a === 'string') tokenOpt = (b as { token: TokenOption }).token;
    else tokenOpt = a.token === 'prod' ? 'html' : a.token === 'none' ? null : { file: devTokenPath(port, env) };
    const ctx = await request.newContext({ baseURL: origin });
    try {
      let token: string | null = null;
      if (tokenOpt === 'html') {
        const res = await sendRaw(ctx, 'GET', resolvePath(origin, '/'), '/', {}, timeoutMs);
        if (res.status() !== 200) throw new LocalApiError('http_status', `GET / → HTTP ${res.status()}`, res.status());
        token = tokenFromHtml(await res.text());
      } else if (tokenOpt !== null && 'file' in tokenOpt) {
        assertNotUnderRealDataDir('token file', tokenOpt.file, env);
        token = readFileSync(tokenOpt.file, 'utf8').trim();
      } else if (tokenOpt !== null) token = tokenOpt.value;
      if (token !== null && !/^[0-9a-f]+$/.test(token)) throw new LocalApiError('usage', 'the token is not a hex string');
      return new LocalApi(origin, port, ctx, token);
    } catch (e) {
      await ctx.dispose();
      throw e;
    }
  }

  /** Every request of both styles ends here: timeout and path are checked first (nothing sent or recorded on a throw). */
  private async send(method: Method, path: string, o: { timeoutMs: number; body?: unknown; noToken?: boolean }): Promise<APIResponse> {
    const timeout = checkTimeoutMs(o?.timeoutMs);
    const url = resolvePath(this.baseUrl, path);
    const headers: Record<string, string> = {};
    if (this.token !== null && !o.noToken) headers[TOKEN_HEADER] = this.token;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: APIResponse;
    try {
      res = await sendRaw(this.ctx, method, url, path, headers, timeout, o.body !== undefined ? JSON.stringify(o.body) : undefined);
    } catch (e) {
      this.calls.push({ method, path, status: 0 });
      throw e;
    }
    this.calls.push({ method, path, status: res.status() });
    return res;
  }

  private pathOf(id: RouteId, params: Record<string, string> = {}): string {
    return `${API_PREFIX}${routePath(id, params)}`;
  }

  private method(id: RouteId): Method {
    const m = ROUTE_BY_ID[id].method;
    if (m === 'GET' || m === 'POST' || m === 'PUT' || m === 'DELETE') return m;
    throw new LocalApiError('usage', `${id}: method ${m} is not supported by localApi`);
  }

  private checkBody(id: RouteId, body: unknown): void {
    const schema = (API_SCHEMAS[id as keyof typeof API_SCHEMAS] as { body?: { safeParse(v: unknown): { success: boolean; error?: { message: string } } } } | undefined)?.body;
    if (schema && body !== undefined) {
      const r = schema.safeParse(body);
      if (!r.success) throw new LocalApiError('usage', `${id}: request body does not match the contract: ${r.error?.message ?? ''}`);
    }
  }

  private routeSend(id: RouteId, o: CallOptions): Promise<APIResponse> {
    checkTimeoutMs(o?.timeoutMs);
    return this.send(this.method(id), this.pathOf(id, o.params), { timeoutMs: o.timeoutMs, body: o.body });
  }

  private static async httpError(id: string, res: APIResponse): Promise<LocalApiError> {
    let code: string | undefined;
    try {
      code = ((await res.json()) as { error?: { code?: string } }).error?.code;
    } catch {
      code = undefined;
    }
    return new LocalApiError('http_status', `${id} → HTTP ${res.status()}${code ? ` (${code})` : ''}`, res.status(), code);
  }

  /** A JSON (or empty) route. 2xx → the body parsed with the route's response schema (null for empty); else throws 'http_status'. */
  async json<T = unknown>(id: RouteId, o: CallOptions): Promise<{ status: number; data: T }> {
    const kind = ROUTE_BY_ID[id].response;
    if (kind !== 'json' && kind !== 'empty') throw new LocalApiError('usage', `${id} is not a JSON route (${kind})`);
    this.checkBody(id, o.body);
    const res = await this.routeSend(id, o);
    if (res.status() < 200 || res.status() > 299) throw await LocalApi.httpError(id, res);
    if (kind === 'empty') return { status: res.status(), data: null as T };
    const schema = (API_SCHEMAS[id as keyof typeof API_SCHEMAS] as { response?: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { message: string } } } | null }).response;
    const raw: unknown = await res.json();
    if (!schema) return { status: res.status(), data: raw as T };
    const r = schema.safeParse(raw);
    if (!r.success) throw new LocalApiError('schema', `${id}: response does not match the contract: ${r.error?.message.slice(0, 300) ?? ''}`, res.status());
    return { status: res.status(), data: r.data as T };
  }

  /** An SSE route by id (run streams, jobs.events). The whole stream is read, then parsed; non-2xx throws 'http_status'. */
  sse(id: RouteId, o: CallOptions): Promise<SseResult>;
  /** An SSE request by path (GET job stream or POST run): reads the whole body; events are parsed for status 200 only. */
  sse(method: 'GET' | 'POST', path: string, o: PathCallOptions): Promise<SseResponse>;
  async sse(a: RouteId | 'GET' | 'POST', b: CallOptions | string, c?: PathCallOptions): Promise<SseResult | SseResponse> {
    if (typeof b === 'string') {
      const r = await this.pathCall(a as 'GET' | 'POST', b, c as PathCallOptions);
      if (r.status !== 200) return { status: r.status, events: [], text: r.text };
      return { status: r.status, events: parseSseBody(r.text), text: '' };
    }
    const id = a as RouteId;
    if (ROUTE_BY_ID[id].response !== 'sse') throw new LocalApiError('usage', `${id} is not an SSE route`);
    this.checkBody(id, b.body);
    const t0 = Date.now();
    const res = await this.routeSend(id, b);
    if (res.status() < 200 || res.status() > 299) throw await LocalApi.httpError(id, res);
    let events: SseEvent[];
    try {
      events = parseSseText(await res.text());
    } catch (e) {
      throw new LocalApiError('schema', `${id}: stream does not match the contract: ${(e as Error).message.slice(0, 300)}`, res.status());
    }
    const terminal = [...events].reverse().find((e) => TERMINALS.has(e.event)) ?? null;
    return { status: res.status(), events, terminal, ms: Date.now() - t0 };
  }

  /** A binary route (papers.capture, papers.pdf): the bytes and content type; non-2xx throws 'http_status'. */
  async bytes(id: RouteId, o: CallOptions): Promise<{ status: number; body: Buffer; contentType: string }> {
    const kind = ROUTE_BY_ID[id].response;
    if (kind !== 'png' && kind !== 'pdf' && kind !== 'markdown') throw new LocalApiError('usage', `${id} is not a binary route`);
    const res = await this.routeSend(id, o);
    if (res.status() < 200 || res.status() > 299) throw await LocalApi.httpError(id, res);
    return { status: res.status(), body: await res.body(), contentType: res.headers()['content-type'] ?? '' };
  }

  /** A plain GET of a local path (e.g. `/api/health` or `/`): status and text, whatever the status. */
  async getText(path: string, o: { timeoutMs: number }): Promise<{ status: number; text: string }> {
    const res = await this.send('GET', path, { timeoutMs: o?.timeoutMs });
    return { status: res.status(), text: await res.text() };
  }

  private async pathCall(method: Method, path: string, o: PathCallOptions): Promise<LocalResponse> {
    const r = await this.send(method, path, { timeoutMs: o?.timeoutMs, body: o?.json, noToken: o?.noToken });
    const body = await r.body();
    const text = body.toString('utf8');
    return { status: r.status(), headers: r.headers(), body, text, json: <T>() => JSON.parse(text) as T };
  }

  /** GET `path`: status, headers and body as they are (no status check). */
  get(path: string, o: PathCallOptions): Promise<LocalResponse> {
    return this.pathCall('GET', path, o);
  }
  /** POST `path` with the JSON body `json`: status, headers and body as they are. */
  post(path: string, o: PathCallOptions): Promise<LocalResponse> {
    return this.pathCall('POST', path, o);
  }
  /** PUT `path` with the JSON body `json`: status, headers and body as they are. */
  put(path: string, o: PathCallOptions): Promise<LocalResponse> {
    return this.pathCall('PUT', path, o);
  }
  /** DELETE `path`: status, headers and body as they are. */
  delete(path: string, o: PathCallOptions): Promise<LocalResponse> {
    return this.pathCall('DELETE', path, o);
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }
}
