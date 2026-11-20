// Body type and size limits per route (PLAN 3 "입력 크기").
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { LIMITS } from '@study-paper/shared/contracts/api';
import { errorDto } from '@study-paper/shared/contracts/errors';
import type { RouteId } from '@study-paper/shared/contracts/routes';

/** Routes whose body may carry a PNG capture (base64) get the 6 MB request limit. */
const CAPTURE_ROUTES = new Set<RouteId>(['threads.create', 'highlights.create']);
const RAW_PDF_ROUTES = new Set<RouteId>(['papers.upload']);

export function maxBodyBytes(route: RouteId): number {
  if (RAW_PDF_ROUTES.has(route)) return LIMITS.uploadBytes;
  if (CAPTURE_ROUTES.has(route)) return LIMITS.captureRequestBytes;
  return LIMITS.jsonBodyBytes;
}

export function allowedContentType(route: RouteId): string {
  return RAW_PDF_ROUTES.has(route) ? 'application/pdf' : 'application/json';
}

function hasBody(headers: Headers): boolean {
  const len = headers.get('content-length');
  if (len !== null) return Number(len) > 0;
  return headers.has('transfer-encoding');
}

/** A request with a body must use the route's media type (JSON, or application/pdf for upload) → else 415. */
export function contentTypeGuard(route: RouteId): MiddlewareHandler {
  const expected = allowedContentType(route);
  return async (c, next) => {
    if (hasBody(c.req.raw.headers)) {
      const ct = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (ct !== expected) return c.json(errorDto('unsupported_media_type', `Content-Type must be ${expected}`), 415);
    }
    await next();
  };
}

/** Streaming-aware size limit (Content-Length and chunked bodies) → 413 error DTO. */
export function sizeGuard(route: RouteId): MiddlewareHandler {
  const maxSize = maxBodyBytes(route);
  return bodyLimit({ maxSize, onError: (c) => c.json(errorDto('payload_too_large', `request body exceeds ${maxSize} bytes`), 413) });
}
