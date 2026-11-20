// PLAN 3 allow table as an expected-status matrix, over real HTTP, for dev and prod (S0 gate).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { PROD_CSP } from '../../src/security/headers';
import { startTestServer, type TestServer } from '../helpers/server';

for (const env of ['prod', 'dev'] as const) {
  describe(`security matrix (${env})`, () => {
    let s: TestServer;
    beforeAll(async () => {
      s = await startTestServer({ env, seed: true });
    });
    afterAll(async () => {
      await s.close();
    });

    const tok = () => ({ 'X-SP-Token': s.token });
    type Case = { name: string; path?: string; method?: string; host?: (s: TestServer) => string; headers?: (s: TestServer) => Record<string, string>; body?: string | Buffer; status: number };
    const cases: Case[] = [
      { name: 'good host + token', headers: tok, status: 200 },
      { name: 'Host localhost:<port>', host: (x) => `localhost:${x.port}`, headers: tok, status: 200 },
      { name: 'Host evil.example:<port>', host: (x) => `evil.example:${x.port}`, headers: tok, status: 403 },
      { name: 'Host 127.0.0.1:<other port>', host: () => '127.0.0.1:1', headers: tok, status: 403 },
      { name: 'Host 127.0.0.1 without port', host: () => '127.0.0.1', headers: tok, status: 403 },
      { name: 'Host rebinding suffix', host: (x) => `127.0.0.1.nip.io:${x.port}`, headers: tok, status: 403 },
      { name: 'no token', status: 401 },
      { name: 'wrong token', headers: () => ({ 'X-SP-Token': 'x'.repeat(64) }), status: 401 },
      { name: 'token only in the query string', path: '/api/papers?token=', status: 401 },
      { name: 'Origin = own origin', headers: (x) => ({ ...tok(), Origin: `http://127.0.0.1:${x.port}` }), status: 200 },
      { name: 'Origin = localhost own origin', headers: (x) => ({ ...tok(), Origin: `http://localhost:${x.port}` }), status: 200 },
      { name: 'Origin = Vite origin', headers: (x) => ({ ...tok(), Origin: `http://127.0.0.1:${x.webPort}` }), status: env === 'dev' ? 200 : 403 },
      { name: 'Origin = https own origin', headers: (x) => ({ ...tok(), Origin: `https://127.0.0.1:${x.port}` }), status: 403 },
      { name: 'Origin = evil', headers: () => ({ ...tok(), Origin: 'http://evil.example' }), status: 403 },
      { name: 'Origin = null', headers: () => ({ ...tok(), Origin: 'null' }), status: 403 },
      { name: 'Sec-Fetch-Site cross-site', headers: () => ({ ...tok(), 'Sec-Fetch-Site': 'cross-site' }), status: 403 },
      { name: 'Sec-Fetch-Site same-site (other port)', headers: () => ({ ...tok(), 'Sec-Fetch-Site': 'same-site' }), status: 200 },
      { name: 'Sec-Fetch-Site same-origin', headers: () => ({ ...tok(), 'Sec-Fetch-Site': 'same-origin' }), status: 200 },
      { name: 'OPTIONS preflight from evil origin', method: 'OPTIONS', headers: () => ({ Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-sp-token' }), status: 403 },
      { name: 'OPTIONS even with token', method: 'OPTIONS', headers: tok, status: 403 },
      { name: 'POST text/plain (simple request)', path: '/api/papers/import', method: 'POST', headers: () => ({ ...tok(), 'Content-Type': 'text/plain' }), body: '{"input":"2209.15397"}', status: 415 },
      { name: 'POST form-urlencoded', path: '/api/papers/import', method: 'POST', headers: () => ({ ...tok(), 'Content-Type': 'application/x-www-form-urlencoded' }), body: 'input=2209.15397', status: 415 },
      { name: 'POST multipart', path: '/api/papers/import', method: 'POST', headers: () => ({ ...tok(), 'Content-Type': 'multipart/form-data; boundary=x' }), body: '--x--', status: 415 },
      { name: 'POST form without token', path: '/api/papers/import', method: 'POST', headers: () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }), body: 'input=x', status: 401 },
      { name: 'POST JSON passes the guard (M3 route, not implemented yet → 501)', path: '/api/collections', method: 'POST', headers: () => ({ ...tok(), 'Content-Type': 'application/json' }), body: '{}', status: 501 },
      { name: 'POST JSON > 1 MB', path: '/api/papers/import', method: 'POST', headers: () => ({ ...tok(), 'Content-Type': 'application/json' }), body: Buffer.alloc(1024 * 1024 + 10, 0x20), status: 413 },
      { name: 'capture route accepts > 1 MB (up to 6 MB)', path: `/api/papers/${SEED_PAPER_ID}/threads`, method: 'POST', headers: () => ({ ...tok(), 'Content-Type': 'application/json' }), body: Buffer.alloc(2 * 1024 * 1024, 0x20), status: 400 },
      { name: 'capture route > 6 MB', path: `/api/papers/${SEED_PAPER_ID}/threads`, method: 'POST', headers: () => ({ ...tok(), 'Content-Type': 'application/json' }), body: Buffer.alloc(6 * 1024 * 1024 + 10, 0x20), status: 413 },
      { name: 'PDF without token', path: `/api/papers/${SEED_PAPER_ID}/pdf`, status: 401 },
      { name: 'PDF with token', path: `/api/papers/${SEED_PAPER_ID}/pdf`, headers: tok, status: 200 },
      { name: 'unknown API route without token', path: '/api/nope', status: 401 },
      { name: 'unknown API route with token', path: '/api/nope', headers: tok, status: 404 },
    ];

    for (const c of cases) {
      it(`${c.name} → ${c.status}`, async () => {
        const r = await s.req(c.path ?? '/api/papers', { method: c.method, host: c.host?.(s), headers: c.headers?.(s), body: c.body });
        expect(r.status).toBe(c.status);
        expect(r.headers['access-control-allow-origin']).toBeUndefined();
        expect(r.headers['access-control-allow-credentials']).toBeUndefined();
        if (r.status >= 400 && (r.headers['content-type'] ?? '').includes('json')) {
          expect(JSON.parse(r.text)).toMatchObject({ error: { code: expect.any(String), message: expect.any(String) } });
        }
        expect(r.text).not.toContain(s.token);
      });
    }

    it('API responses are no-store with nosniff and frame denial', async () => {
      const r = await s.req('/api/health', { headers: tok() });
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
    });

    if (env === 'prod') {
      it('index.html: token meta, no-store and CSP for a good host', async () => {
        const r = await s.req('/paper/x');
        expect(r.status).toBe(200);
        expect(r.text).toContain(`<meta name="sp-token" content="${s.token}">`);
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.headers['content-security-policy']).toBe(PROD_CSP);
      });
      it('index.html with a malicious Host → 403 without token', async () => {
        const r = await s.req('/', { host: `evil.example:${s.port}` });
        expect(r.status).toBe(403);
        expect(r.text).not.toContain(s.token);
      });
      it('static path traversal stays inside dist', async () => {
        const r = await s.req('/../../etc/passwd');
        expect(r.text).not.toContain('root:');
      });
    } else {
      it('dev: the backend serves no HTML (Vite serves the page)', async () => {
        const r = await s.req('/');
        expect(r.status).toBe(404);
        expect(r.text).not.toContain(s.token);
      });
    }
  });
}
