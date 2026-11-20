// Vite dev/build config with the PLAN 3 dev security settings. Owner: supervisor.
// dev: 127.0.0.1:<SP_WEB_PORT> only, Host allow-list (Vite allowedHosts + exact host:port check below),
// cors off, /api proxied to 127.0.0.1:<SP_PORT>, per-request token injection from the runtime token file.
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { assertStartupPaths } from '../server/src/security/startupPaths';
import { DEFAULT_PORT, DEFAULT_WEB_PORT, resolveApiPort, resolveWebPort, tokenFilePath } from '../server/src/security/runtimePaths';

function readToken(API_PORT: number): string {
  const file = tokenFilePath(API_PORT);
  if (!existsSync(file)) {
    console.warn(`[sp-dev-security] token file ${file} not found — is the server (SP_PORT=${API_PORT}) running?`);
    return '';
  }
  return readFileSync(file, 'utf8').trim();
}

/** Exact Host check on every dev response (HTML, modules, /api proxy) and no-store for token-bearing HTML. */
function spDevSecurity(API_PORT: number, WEB_PORT: number): Plugin {
  const ALLOWED_HOST_HEADERS = new Set([`127.0.0.1:${WEB_PORT}`, `localhost:${WEB_PORT}`]);
  const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${WEB_PORT}`, `http://localhost:${WEB_PORT}`]);
  return {
    name: 'sp-dev-security',
    apply: 'serve',
    configureServer(server) {
      // WebSocket upgrades (HMR) do not pass through the middlewares: apply the same exact Host rule and an
      // Origin allow-list before Vite's own handler runs. Vite alone accepts a valid HMR token from any Origin.
      server.httpServer?.prependListener('upgrade', (req: IncomingMessage, socket: Duplex) => {
        const origin = req.headers.origin;
        if (!ALLOWED_HOST_HEADERS.has(req.headers.host ?? '') || (origin !== undefined && !ALLOWED_ORIGINS.has(origin))) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          socket.destroy();
        }
      });
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!ALLOWED_HOST_HEADERS.has(req.headers.host ?? '')) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('forbidden host');
          return;
        }
        // Token-bearing HTML must not be cached: force no-store on any text/html response (Vite sends no-cache).
        const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse;
        res.writeHead = ((...a: unknown[]) => {
          if (String(res.getHeader('content-type') ?? '').includes('text/html')) res.setHeader('Cache-Control', 'no-store');
          return writeHead(...a);
        }) as typeof res.writeHead;
        next();
      });
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => ({
        html,
        tags: [
          { tag: 'meta', attrs: { name: 'sp-token', content: readToken(API_PORT) }, injectTo: 'head-prepend' },
          // SP_E2E=1 (Playwright only): expose the web app's test hooks.
          ...(process.env.SP_E2E === '1' ? [{ tag: 'meta', attrs: { name: 'sp-e2e', content: '1' }, injectTo: 'head-prepend' as const }] : []),
        ],
      }),
    },
  };
}

export default defineConfig(({ command }) => {
  if (command === 'serve') assertStartupPaths();
  const API_PORT = command === 'serve' ? resolveApiPort() : DEFAULT_PORT;
  const WEB_PORT = command === 'serve' ? resolveWebPort() : DEFAULT_WEB_PORT;
  return {
    root: import.meta.dirname,
    plugins: [spDevSecurity(API_PORT, WEB_PORT), react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: WEB_PORT,
      strictPort: true,
      allowedHosts: ['127.0.0.1', 'localhost'],
      cors: false,
      proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true } },
    },
    preview: { host: '127.0.0.1', strictPort: true },
    // assetsInlineLimit 0: never inline fonts/images as data: URIs (the prod CSP allows fonts from 'self' only).
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
  };
});
