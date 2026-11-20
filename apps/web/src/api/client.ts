// Typed REST client: request paths from contracts/routes.ts, responses parsed with contracts/api.ts.
// Owner: supervisor.
import { API_SCHEMAS, type ApiBody, type ApiParams, type ApiQuery, type ApiResponse, type RouteSchemas } from '@study-paper/shared/contracts/api';
import { ErrorDtoSchema, type ApiErrorCode } from '@study-paper/shared/contracts/errors';
import { API_PREFIX, ROUTE_BY_ID, routePath, type RouteId } from '@study-paper/shared/contracts/routes';
import { inspectPngBytes } from '@study-paper/shared/image/png';
import { readTokenFromDocument, TOKEN_EXPIRED_EVENT, TOKEN_HEADER } from './token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** bad_stream: an SSE stream broke its contract; stream_interrupted: it ended without a terminal event. */
    readonly code: ApiErrorCode | 'network' | 'bad_response' | 'bad_stream' | 'stream_interrupted',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  /** Defaults to the <meta name="sp-token"> of the current document. */
  getToken?: () => string;
  /** Called on 401 (defaults to dispatching TOKEN_EXPIRED_EVENT on window). */
  onUnauthorized?: () => void;
}

export interface CallOptions<R extends RouteId> {
  params?: ApiParams<R>;
  query?: ApiQuery<R>;
  body?: ApiBody<R>;
  /** Raw request body for routes without a JSON body schema (papers.upload: the PDF bytes). */
  rawBody?: Blob | ArrayBuffer | Uint8Array;
  /** Sent as X-SP-Filename (URI-encoded) with rawBody; display only, the server never uses it as a path. */
  filename?: string;
  signal?: AbortSignal;
  /**
   * fetch `keepalive`: the request outlives the page (a last flush on pagehide / visibilitychange, e.g.
   * papers.position). Browsers cap the body of keepalive requests (64 KiB in total), so use it only for small bodies.
   */
  keepalive?: boolean;
}

/** Content-Type of raw bodies per route (must match the server's contentTypeGuard). */
const RAW_BODY_TYPE: Partial<Record<RouteId, string>> = { 'papers.upload': 'application/pdf' };
export const FILENAME_HEADER = 'X-SP-Filename';

export function buildUrl<R extends RouteId>(route: R, params?: ApiParams<R>, query?: ApiQuery<R>): string {
  const path = API_PREFIX + routePath(route, (params ?? {}) as Record<string, string>);
  const q = query ? new URLSearchParams(Object.entries(query as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) : null;
  return q && [...q].length ? `${path}?${q}` : path;
}

export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const dto = ErrorDtoSchema.safeParse(body);
  if (dto.success) return new ApiError(res.status, dto.data.error.code, dto.data.error.message, dto.data.error.details);
  return new ApiError(res.status, 'bad_response', `HTTP ${res.status}`);
}

export function createApiClient(opts: ApiClientOptions = {}) {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const getToken = opts.getToken ?? (() => readTokenFromDocument());
  const onUnauthorized = opts.onUnauthorized ?? (() => window.dispatchEvent(new Event(TOKEN_EXPIRED_EVENT)));

  /** Low-level request with the token header; returns the raw Response (throws ApiError on HTTP errors). */
  async function request<R extends RouteId>(route: R, o: CallOptions<R> = {}, accept = 'application/json'): Promise<Response> {
    const def = ROUTE_BY_ID[route];
    const headers: Record<string, string> = { [TOKEN_HEADER]: getToken(), Accept: accept };
    let body: BodyInit | undefined;
    if (o.rawBody !== undefined) {
      const type = RAW_BODY_TYPE[route];
      if (!type) throw new Error(`route ${route} does not take a raw body`);
      if (o.body !== undefined) throw new Error('pass either body or rawBody');
      headers['Content-Type'] = type;
      if (o.filename) headers[FILENAME_HEADER] = encodeURIComponent(o.filename);
      body = o.rawBody as BodyInit;
    } else if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    let res: Response;
    try {
      res = await doFetch(buildUrl(route, o.params, o.query), { method: def.method, headers, body, signal: o.signal, ...(o.keepalive ? { keepalive: true } : {}) });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new ApiError(0, 'network', (e as Error).message);
    }
    if (!res.ok) {
      if (res.status === 401) onUnauthorized();
      throw await toApiError(res);
    }
    return res;
  }

  /** JSON / 204 routes: returns the parsed response (undefined for 204 / empty routes). */
  async function call<R extends RouteId>(route: R, o: CallOptions<R> = {}): Promise<ApiResponse<R>> {
    const res = await request(route, o);
    const schema = (API_SCHEMAS[route] as RouteSchemas).response;
    if (!schema || res.status === 204) return undefined as ApiResponse<R>;
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new ApiError(res.status, 'bad_response', 'response is not JSON');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ApiError(res.status, 'bad_response', `response of ${route} does not match the contract`, parsed.error.issues);
    return parsed.data as ApiResponse<R>;
  }

  /**
   * Binary `png` routes (papers.capture): the token travels in the header, so an <img src> URL cannot be used —
   * fetch the Blob and show it through URL.createObjectURL. The body must be image/png and pass inspectPngBytes
   * (same structure check as the server), else bad_response.
   */
  async function blob<R extends RouteId>(route: R, o: CallOptions<R> = {}): Promise<Blob> {
    if (ROUTE_BY_ID[route].response !== 'png') throw new Error(`route ${route} is not a png route`);
    const res = await request(route, o, 'image/png');
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!type.includes('image/png')) throw new ApiError(res.status, 'bad_response', `response of ${route} is not image/png`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const check = inspectPngBytes(bytes);
    if (!check.ok) throw new ApiError(res.status, 'bad_response', `response of ${route} is not a valid PNG (${check.reason})`);
    return new Blob([bytes], { type: 'image/png' });
  }

  return { request, call, blob, getToken };
}

export type ApiClient = ReturnType<typeof createApiClient>;
export const api = createApiClient();

/** pdf.js getDocument parameters for a paper PDF (token via httpHeaders, never in the URL). */
export function pdfSource(paperId: string, token = readTokenFromDocument()) {
  return {
    url: buildUrl('papers.pdf', { id: paperId }),
    httpHeaders: { [TOKEN_HEADER]: token },
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    iccUrl: '/pdfjs/iccs/',
    disableRange: true,
  };
}
