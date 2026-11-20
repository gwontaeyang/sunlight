// prod only: serves apps/web/dist with the per-start token injected into index.html (PLAN 3). Owner: supervisor.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Handler } from 'hono';
import { PROD_CSP } from './security/headers';
import { TOKEN_META_NAME } from './security/token';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

export function injectToken(html: string, token: string): string {
  // SP_E2E=1 (Playwright only): the web app exposes its test hooks (window.__spViewer / __spReader).
  const e2e = process.env.SP_E2E === '1' ? '<meta name="sp-e2e" content="1">' : '';
  const meta = `<meta name="${TOKEN_META_NAME}" content="${token}">${e2e}`;
  return html.includes('</head>') ? html.replace('</head>', `${meta}</head>`) : meta + html;
}

export function webStatic(distDir: string, getToken: () => string): Handler {
  const root = resolve(distDir);
  return (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('method not allowed', 405);
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(c.req.path));
    } catch {
      return c.text('bad request', 400);
    }
    const file = resolve(join(root, rel));
    const inside = file === root || file.startsWith(root + sep);
    if (inside && file !== root && existsSync(file) && statSync(file).isFile() && extname(file) !== '.html') {
      const type = MIME[extname(file)] ?? 'application/octet-stream';
      const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return new Response(readFileSync(file), { headers: { 'Content-Type': type, 'Cache-Control': cache, 'Content-Security-Policy': PROD_CSP } });
    }
    const indexFile = join(root, 'index.html');
    if (!existsSync(indexFile)) return c.text('web app is not built: run npm run build', 503);
    return new Response(injectToken(readFileSync(indexFile, 'utf8'), getToken()), {
      headers: { 'Content-Type': MIME['.html']!, 'Cache-Control': 'no-store', 'Content-Security-Policy': PROD_CSP },
    });
  };
}
