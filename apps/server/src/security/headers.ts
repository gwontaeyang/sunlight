// Security headers (PLAN 3). The CSP applies to prod HTML; dev HTML comes from Vite.
import type { MiddlewareHandler } from 'hono';

export const PROD_CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  };
}
