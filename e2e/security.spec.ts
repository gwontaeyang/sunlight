// PLAN 3 security gate in a real browser and over raw HTTP, for the prod server and the dev (Vite) stack.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_PORTS } from '../playwright.config';
import { SEED_PAPER_ID, dbCounts, hostPort, rawRequest, tokenFromHtml, wsUpgrade } from './helpers';

const ATTACK_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>attacker</title></head><body>attacker</body></html>';

let attacker: http.Server;
test.beforeAll(async () => {
  attacker = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(ATTACK_PAGE);
  });
  await new Promise<void>((r) => attacker.listen(E2E_PORTS.attacker, '127.0.0.1', () => r()));
});
test.afterAll(async () => {
  await new Promise<void>((r) => attacker.close(() => r()));
});

const project = () => test.info().project.name as 'prod' | 'dev';

for (const attackerHost of ['127.0.0.1', 'localhost']) {
  test(`requests from another site (${attackerHost}:${E2E_PORTS.attacker}) fail and change nothing`, async ({ page, baseURL }) => {
    const before = dbCounts(project());
    await page.goto(`http://${attackerHost}:${E2E_PORTS.attacker}/`);
    const body = JSON.stringify({ kind: 'explain', text: 'x', clientRequestId: '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' });
    const results = await page.evaluate(
      async ({ target, paperId, body }) => {
        const out: Record<string, string> = {};
        const attempt = async (name: string, url: string, init: RequestInit) => {
          try {
            const r = await fetch(url, init);
            out[name] = r.type === 'opaque' ? 'opaque' : `readable:${r.status}`;
          } catch {
            out[name] = 'blocked';
          }
        };
        await attempt('get', `${target}/api/papers`, {});
        await attempt('simple_post', `${target}/api/papers/${paperId}/threads`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
        await attempt('json_post_with_header', `${target}/api/papers/${paperId}/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SP-Token': 'guess' }, body });
        await attempt('no_cors_post', `${target}/api/papers/${paperId}/threads`, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body });
        return out;
      },
      { target: baseURL!, paperId: SEED_PAPER_ID, body },
    );
    // no-cors: the browser may send it but the page can never read the answer (Chrome blocks it outright
    // because of Cross-Origin-Resource-Policy: same-origin); either way the DB check below must hold.
    expect(results).toMatchObject({ get: 'blocked', simple_post: 'blocked', json_post_with_header: 'blocked' });
    expect(['blocked', 'opaque']).toContain(results.no_cors_post);

    // Classic form POST (navigation) from the attacker page.
    const formResponse = page.waitForResponse((r) => r.url().includes('/api/papers/') && r.request().method() === 'POST');
    await page.evaluate(
      ({ target, paperId }) => {
        const f = document.createElement('form');
        f.method = 'POST';
        f.action = `${target}/api/papers/${paperId}/threads`;
        f.enctype = 'text/plain';
        const i = document.createElement('input');
        i.name = '{"kind":"explain","clientRequestId":"6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","x":"';
        i.value = '"}';
        f.appendChild(i);
        document.body.appendChild(f);
        f.submit();
      },
      { target: baseURL!, paperId: SEED_PAPER_ID },
    );
    expect((await formResponse).status()).toBe(403);
    expect(dbCounts(project())).toEqual(before);
  });
}

test('malicious Host: HTML and /api are refused and never carry the token', async ({ baseURL }) => {
  const { port } = hostPort(baseURL!);
  const good = await rawRequest(port, '/');
  expect(good.status).toBe(200);
  const token = tokenFromHtml(good.text);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(good.headers['cache-control']).toBe('no-store');
  for (const host of [`evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `localhost:${port + 1}`]) {
    for (const path of ['/', '/paper/x', '/api/health', `/api/papers/${SEED_PAPER_ID}/pdf`]) {
      const r = await rawRequest(port, path, { host, headers: { 'X-SP-Token': token } });
      expect({ host, path, status: r.status }).toEqual({ host, path, status: 403 });
      expect(r.text).not.toContain(token);
    }
  }
});

test('token-less PDF request → 401; with token → PDF', async ({ baseURL }) => {
  const { port } = hostPort(baseURL!);
  const token = tokenFromHtml((await rawRequest(port, '/')).text);
  expect((await rawRequest(port, `/api/papers/${SEED_PAPER_ID}/pdf`)).status).toBe(401);
  const ok = await rawRequest(port, `/api/papers/${SEED_PAPER_ID}/pdf`, { headers: { 'X-SP-Token': token } });
  expect(ok.status).toBe(200);
  expect(ok.text.startsWith('%PDF-')).toBe(true);
});

test('dev only: Vite HMR websocket refuses a malicious Host even with the HMR token', async ({ baseURL }) => {
  test.skip(project() !== 'dev', 'HMR exists only in dev');
  const { port } = hostPort(baseURL!);
  const client = await rawRequest(port, '/@vite/client');
  const wsToken = /wsToken = "([^"]+)"/.exec(client.text)?.[1];
  expect(wsToken).toBeTruthy();
  expect(await wsUpgrade(port, `/?token=${wsToken}`, `127.0.0.1:${port}`, `http://127.0.0.1:${port}`)).toContain('101');
  for (const host of [`evil.example:${port}`, `127.0.0.1.nip.io:${port}`]) {
    const status = await wsUpgrade(port, `/?token=${wsToken}`, host, `http://${host}`);
    expect({ host, status }).not.toMatchObject({ status: expect.stringContaining('101') });
  }
  expect(await wsUpgrade(port, '/?token=wrong', `127.0.0.1:${port}`, 'http://evil.example')).not.toContain('101');
  // Policy: even a VALID HMR token is refused from a foreign Origin or another port's Host (our upgrade guard).
  expect(await wsUpgrade(port, `/?token=${wsToken}`, `127.0.0.1:${port}`, 'http://evil.example')).toContain('403');
  expect(await wsUpgrade(port, `/?token=${wsToken}`, `127.0.0.1:${port}`, `http://127.0.0.1:${port + 1}`)).toContain('403');
  expect(await wsUpgrade(port, `/?token=${wsToken}`, 'localhost:9999', `http://127.0.0.1:${port}`)).toContain('403');
  expect(await wsUpgrade(port, `/?token=${wsToken}`, `localhost:${port}`, `http://localhost:${port}`)).toContain('101');
});

test('a server restart rotates the token (old token → 401) — prod: HTML meta, dev: runtime token file', async () => {
  const mode = project();
  const dir = mkdtempSync(join(tmpdir(), 'study_paper-e2e-restart-'));
  const port = E2E_PORTS.restart;
  const env = { ...process.env, SP_ENV: mode, SP_LLM: 'mock', SP_PORT: String(port), SP_DATA_DIR: join(dir, 'data'), SP_CONFIG_PATH: join(dir, 'config','none.json'), SP_SECRETS_DIR: join(dir,'secrets'), XDG_RUNTIME_DIR: join(dir, 'run') };
  const tokenFile = join(dir, 'run', 'study_paper', `token.${port}`);
  const start = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], { env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        if (mode === 'prod') {
          const r = await rawRequest(port, '/');
          if (r.status === 200) return { child, token: tokenFromHtml(r.text) };
        } else if ((await rawRequest(port, '/api/health')).status === 401 && existsSync(tokenFile)) {
          return { child, token: readFileSync(tokenFile, 'utf8') };
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    child.kill('SIGKILL');
    throw new Error('restart server did not start');
  };
  const stop = (child: ReturnType<typeof spawn>) =>
    new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGINT');
    });
  try {
    const a = await start();
    expect((await rawRequest(port, '/api/papers', { headers: { 'X-SP-Token': a.token } })).status).toBe(200);
    await stop(a.child);
    const b = await start();
    try {
      expect(b.token).not.toBe(a.token);
      expect((await rawRequest(port, '/api/papers', { headers: { 'X-SP-Token': a.token } })).status).toBe(401);
      expect((await rawRequest(port, '/api/papers', { headers: { 'X-SP-Token': b.token } })).status).toBe(200);
    } finally {
      await stop(b.child);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
