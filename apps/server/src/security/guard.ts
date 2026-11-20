// Request guard (PLAN 3 allow table). Everything outside the table is rejected; values are compared exactly.
import type { MiddlewareHandler } from 'hono';
import { errorDto } from '@study-paper/shared/contracts/errors';
import type { AppConfig } from '../config';
import { TOKEN_HEADER, tokensEqual } from './token';

export interface AllowList {
  hosts: Set<string>;
  origins: Set<string>;
}

/** prod: the backend's own origin. dev: + the Vite origin (the proxy rewrites Host with changeOrigin). */
export function allowList(config: Pick<AppConfig, 'env' | 'port' | 'webPort'>): AllowList {
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
  if (config.env === 'dev') {
    origins.add(`http://127.0.0.1:${config.webPort}`);
    origins.add(`http://localhost:${config.webPort}`);
  }
  return { hosts, origins };
}

/** Host allow-list for every response (DNS rebinding), including static files and index.html. */
export function hostGuard(list: AllowList): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!list.hosts.has(host)) return c.json(errorDto('forbidden', 'host not allowed'), 403);
    await next();
  };
}

/**
 * /api/* guard: Origin allow-list (when present) → Sec-Fetch-Site: cross-site rejected → OPTIONS rejected
 * (no CORS headers are ever sent) → X-SP-Token (timing-safe) → 401.
 */
export function apiGuard(list: AllowList, getToken: () => string): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && !list.origins.has(origin)) return c.json(errorDto('forbidden', 'origin not allowed'), 403);
    if ((c.req.header('sec-fetch-site') ?? '').toLowerCase() === 'cross-site') return c.json(errorDto('forbidden', 'cross-site request'), 403);
    if (c.req.method === 'OPTIONS') return c.json(errorDto('forbidden', 'CORS is not supported'), 403);
    if (!tokensEqual(c.req.header(TOKEN_HEADER), getToken())) {
      return c.json(errorDto('unauthorized', 'missing or invalid token (reload the page after a server restart)'), 401);
    }
    await next();
  };
}
