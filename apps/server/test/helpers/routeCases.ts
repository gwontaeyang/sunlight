// Route contract cases (review B2, M8). Owner: supervisor.
//
// Every implemented route needs cases in apps/server/test/routes/<module>.cases.ts (owned by the builder who
// owns the route module): at least one `ok` case and — unless the route takes no params, query or body — at
// least one error case. apps/server/test/contract/routes.gate.test.ts runs all of them against a seeded test
// server and checks the response against contracts/routes.ts + contracts/api.ts + contracts/sse.ts.
// A handler without cases fails the gate, so a route cannot be merged untested.
import type { ApiErrorCode } from '@study-paper/shared/contracts/errors';
import type { RouteId } from '@study-paper/shared/contracts/routes';
import type { SseEvent } from '@study-paper/shared/contracts/sse';
import type { TestServer } from './server';

export interface CaseContext {
  /** Seeded test server (synthetic paper SEED_PAPER_ID, MockLlm). Shared by all cases of one run. */
  server: TestServer;
  /** Scratch space for values created in setup() and used by params()/body()/check(). */
  vars: Record<string, string>;
}

export interface CaseResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** Parsed JSON body (json routes and error DTOs). */
  json: unknown;
  /** Parsed and validated events (sse routes). */
  events: SseEvent[];
  body: Buffer;
}

type Lazy<T> = T | ((ctx: CaseContext) => T);

export interface RouteCase {
  route: RouteId;
  name: string;
  /** 'ok' = 2xx matching the route contract; otherwise the expected error DTO code (status from API_ERROR_STATUS). */
  expect: 'ok' | ApiErrorCode;
  /** Creates the rows this case needs (use ctx.server.deps.db / sqlite, or call other routes). */
  setup?(ctx: CaseContext): void | Promise<void>;
  params?: Lazy<Record<string, string>>;
  query?: Lazy<Record<string, string>>;
  /** JSON body. */
  body?: Lazy<unknown>;
  /** Raw body with its Content-Type (papers.upload). */
  raw?: Lazy<{ body: Buffer; contentType: string; headers?: Record<string, string> }>;
  /** Extra assertions (DB state, field values). The generic contract checks have already passed. */
  check?(res: CaseResponse, ctx: CaseContext): void | Promise<void>;
}

export const resolveLazy = <T>(v: Lazy<T> | undefined, ctx: CaseContext): T | undefined => (typeof v === 'function' ? (v as (c: CaseContext) => T)(ctx) : v);
