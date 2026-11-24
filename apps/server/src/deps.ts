// Dependencies handed to every route module. Owner: supervisor.
import type { Context, Handler } from 'hono';
import { API_SCHEMAS, type ApiBody, type ApiParams, type ApiResponse, type RouteSchemas } from '@study-paper/shared/contracts/api';
import { errorDto } from '@study-paper/shared/contracts/errors';
import type { RouteId } from '@study-paper/shared/contracts/routes';
import type { AppConfig } from './config';
import type { Db, Sqlite } from './db/client';
import type { Lifecycle } from './lifecycle';
import type { LlmAdapter } from './llm/adapter';
import type { RunRegistry, RunTask } from './llm/runContract';
import type { DataPaths } from './paths';

export interface AppDeps {
  backends: import('./byok/backend').Backends;
  config: AppConfig;
  paths: DataPaths;
  sqlite: Sqlite;
  db: Db;
  getToken(): string;
  llm: LlmAdapter;
  /** Run contract (llm/runContract.ts): start/attach a run, look one up, cancel it. */
  runTask: RunTask;
  runs: RunRegistry;
  /** Shutdown contract (lifecycle.ts): owners of in-flight work register a ShutdownParticipant here. */
  lifecycle: Lifecycle;
  /** = lifecycle.signal. Aborted when shutdown begins: refuse new work, abort in-flight work. */
  shutdown: AbortSignal;
}

/** A route module returns handlers for the routes it implements; missing routes answer 501. */
export type RouteHandlers = Partial<Record<RouteId, Handler>>;
export type RouteModule = (deps: AppDeps) => RouteHandlers;

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 503,
    readonly code: Parameters<typeof errorDto>[0],
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Validates :params with the route schema (400 on failure). */
const schemasOf = (route: RouteId): RouteSchemas => API_SCHEMAS[route];

export function routeParams<R extends RouteId>(c: Context, route: R): ApiParams<R> {
  const schema = schemasOf(route).params;
  if (!schema) throw new Error(`route ${route} has no params schema`);
  const r = schema.safeParse(c.req.param());
  if (!r.success) throw new HttpError(400, 'validation', 'invalid path parameters', r.error.issues);
  return r.data as never;
}

/** Parses and validates the JSON body with the route schema (400 on failure). */
export async function routeBody<R extends RouteId>(c: Context, route: R): Promise<ApiBody<R>> {
  const schema = schemasOf(route).body;
  if (!schema) throw new Error(`route ${route} has no body schema`);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'validation', 'body is not valid JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'validation', 'invalid request body', route.startsWith('settings.') ? undefined : r.error.issues);
  return r.data as never;
}

/** Validates a JSON response against the route schema before sending (catches contract drift early). */
export function routeJson<R extends RouteId>(c: Context, route: R, body: ApiResponse<R>, status: 200 | 201 = 200) {
  const schema = schemasOf(route).response;
  if (!schema) throw new Error(`route ${route} has no JSON response schema`);
  return c.json(schema.parse(body) as object, status);
}

export function notFound(what: string): HttpError {
  return new HttpError(404, 'not_found', `${what} not found`);
}
