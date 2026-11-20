// HTTP app: guards + every route in contracts/routes.ts (unimplemented → 501 DTO). Owner: supervisor.
import { Hono, type Context, type Handler } from 'hono';
import { API_SCHEMAS, type RouteSchemas } from '@study-paper/shared/contracts/api';
import { errorDto, ErrorDtoSchema } from '@study-paper/shared/contracts/errors';
import { API_PREFIX, ROUTES, type RouteDef, type RouteId } from '@study-paper/shared/contracts/routes';
import { HttpError, type AppDeps, type RouteHandlers, type RouteModule } from './deps';
import { collectionsRoutes } from './routes/collections';
import { explainBackRoutes } from './routes/explainBack';
import { exportRoutes } from './routes/export';
import { glossaryRoutes } from './routes/glossary';
import { healthRoutes } from './routes/health';
import { highlightsRoutes } from './routes/highlights';
import { jobsRoutes } from './routes/jobs';
import { llmRoutes } from './routes/llm';
import { notesRoutes } from './routes/notes';
import { paperCardsRoutes } from './routes/paperCards';
import { papersRoutes } from './routes/papers';
import { progressRoutes } from './routes/progress';
import { reviewRoutes } from './routes/review';
import { reviewGenerateRoutes } from './routes/reviewGenerate';
import { settingsRoutes } from './routes/settings';
import { threadsRoutes } from './routes/threads';
import { usageRoutes } from './routes/usage';
import { apiGuard, allowList, hostGuard } from './security/guard';
import { securityHeaders } from './security/headers';
import { contentTypeGuard, sizeGuard } from './security/limits';
import { webStatic } from './web';

/** Route modules (PLAN 9.3 ownership). Builders edit only their own module files. */
export const ROUTE_MODULES: Record<string, RouteModule> = {
  health: healthRoutes,
  papers: papersRoutes,
  jobs: jobsRoutes,
  collections: collectionsRoutes,
  highlights: highlightsRoutes,
  notes: notesRoutes,
  progress: progressRoutes,
  review: reviewRoutes,
  export: exportRoutes,
  settings: settingsRoutes,
  threads: threadsRoutes,
  paperCards: paperCardsRoutes,
  glossary: glossaryRoutes,
  reviewGenerate: reviewGenerateRoutes,
  explainBack: explainBackRoutes,
  usage: usageRoutes,
  llm: llmRoutes,
};

export function notImplemented(route: RouteId): Handler {
  return (c) => c.json(errorDto('not_implemented', `${route} is not implemented yet`), 501);
}

function onError(err: Error, c: Context) {
  if (err instanceof HttpError) return c.json(errorDto(err.code, err.message, err.details), err.status);
  console.error('[server] request failed');
  return c.json(errorDto('internal', 'internal error'), 500);
}

const RESPONSE_CONTENT_TYPE: Partial<Record<RouteDef['response'], string>> = { json: 'application/json', sse: 'text/event-stream', pdf: 'application/pdf', png: 'image/png', markdown: 'text/markdown' };

function contractViolation(c: Context, route: RouteId, what: string) {
  console.error(`[server] contract violation in ${route}: ${what}`);
  return c.json(errorDto('internal', `response of ${route} does not match the contract`), 500);
}

/**
 * Wraps every handler with the route contract (review M8), so a handler cannot skip it:
 * - request: :params, ?query and the JSON body are validated with contracts/api.ts before the handler runs
 *   (400 `validation`). Handlers still read them with routeParams()/routeBody() to get typed values.
 * - response: 2xx must have the framing of contracts/routes.ts (JSON bodies are parsed with the response
 *   schema, SSE/PDF/markdown by Content-Type, `empty` = 204); >= 400 must be the error DTO.
 *   A violation is logged and answered with 500 `internal`.
 */
export function withContract(route: RouteDef & { id: RouteId }, handler: Handler): Handler {
  const schemas: RouteSchemas = API_SCHEMAS[route.id];
  return async (c, next) => {
    if (schemas.params) {
      const r = schemas.params.safeParse(c.req.param());
      if (!r.success) return c.json(errorDto('validation', 'invalid path parameters', r.error.issues), 400);
    }
    if (schemas.query) {
      const r = schemas.query.safeParse(c.req.query());
      if (!r.success) return c.json(errorDto('validation', 'invalid query', r.error.issues), 400);
    }
    if (schemas.body) {
      let raw: unknown;
      try {
        raw = await c.req.json(); // cached by Hono: routeBody() in the handler reads the same parsed value
      } catch {
        return c.json(errorDto('validation', 'body is not valid JSON'), 400);
      }
      const r = schemas.body.safeParse(raw);
      if (!r.success) return c.json(errorDto('validation', 'invalid request body', route.id.startsWith('settings.') ? undefined : r.error.issues), 400);
    }
    const res = (await handler(c, next)) as Response | undefined;
    if (!(res instanceof Response)) return contractViolation(c, route.id, 'handler returned no Response');
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (res.status >= 400) {
      const body: unknown = type.includes('application/json') ? await res.clone().json().catch(() => null) : null;
      return ErrorDtoSchema.safeParse(body).success ? res : contractViolation(c, route.id, `status ${res.status} without the error DTO`);
    }
    if (route.response === 'empty') return res.status === 204 ? res : contractViolation(c, route.id, `expected 204, got ${res.status}`);
    if (res.status !== 200 && res.status !== 201) return contractViolation(c, route.id, `unexpected status ${res.status}`);
    const expected = RESPONSE_CONTENT_TYPE[route.response]!;
    if (!type.includes(expected)) return contractViolation(c, route.id, `expected ${expected}, got ${type || 'no content-type'}`);
    if (route.response === 'json') {
      const body: unknown = await res.clone().json().catch(() => undefined);
      const parsed = schemas.response?.safeParse(body);
      if (!parsed?.success) return contractViolation(c, route.id, JSON.stringify(parsed?.error.issues ?? 'no response schema').slice(0, 2000));
    }
    return res;
  };
}

/** Collects handlers; two modules implementing the same route is a startup error. */
export function collectHandlers(deps: AppDeps): { handlers: RouteHandlers; implemented: Set<RouteId> } {
  const handlers: RouteHandlers = {};
  for (const [name, mod] of Object.entries(ROUTE_MODULES)) {
    for (const [route, h] of Object.entries(mod(deps)) as [RouteId, Handler][]) {
      if (handlers[route]) throw new Error(`route ${route} implemented twice (module ${name})`);
      if (!ROUTES.some((r) => r.id === route)) throw new Error(`module ${name} implements unknown route ${route}`);
      handlers[route] = h;
    }
  }
  return { handlers, implemented: new Set(Object.keys(handlers) as RouteId[]) };
}

export function createApp(deps: AppDeps): Hono {
  const list = allowList(deps.config);
  const app = new Hono();
  app.use('*', securityHeaders());
  app.use('*', hostGuard(list));

  const api = new Hono();
  api.use('*', apiGuard(list, deps.getToken));
  const { handlers } = collectHandlers(deps);
  for (const r of ROUTES) {
    // Unimplemented routes answer 501 whatever the request looks like (no request validation yet).
    const handler = handlers[r.id];
    api.on(r.method, r.path, contentTypeGuard(r.id), sizeGuard(r.id), handler ? withContract(r, handler) : notImplemented(r.id));
  }
  api.notFound((c) => c.json(errorDto('not_found', 'no such API route'), 404));
  api.onError(onError);
  app.route(API_PREFIX, api);

  if (deps.config.env === 'prod') {
    const serveWeb = webStatic(deps.config.webDistDir, deps.getToken);
    app.all('*', (c, next) => {
      if (c.req.path === API_PREFIX || c.req.path.startsWith(`${API_PREFIX}/`)) return c.json(errorDto('not_found', 'no such API route'), 404);
      return serveWeb(c, next);
    });
  }
  app.notFound((c) => c.json(errorDto('not_found', 'not found'), 404));
  app.onError(onError);
  return app;
}
