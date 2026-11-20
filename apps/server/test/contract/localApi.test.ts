// scripts/lib/localApi.ts (BRIEF_INTEGRATION "script 공통 규칙", I7, I9; INTEGRATION_NOTES 결정 9). Owner: supervisor.
// The loopback client of the scripts, both call styles: host / port refusal, the required timeout (slow local
// servers started here), the run-stream timeout helper, SSE parsing with the contract, the one path validator at
// every entry point, the `calls` record, the one dev-token-file rule and the real-data-directory rule it shares with
// dataSnapshot (scripts/lib/realDataDir).
// Part 1 = the live E2E style (route id / getText, was stream 1), part 2 = the rehearsal style (path calls, was
// stream 2), part 3 = what ties the two together.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertTimeout,
  checkBaseOrigin,
  checkBaseUrl,
  checkLocalPath,
  checkTimeoutMs,
  devTokenFile,
  devTokenPath,
  FORBIDDEN_PORTS,
  LocalApi,
  LocalApiError,
  parseSseBody,
  parseSseText,
  resolvePath,
  RUN_STREAM_SLACK_MS,
  runStreamTimeoutMs,
  STREAM_SLACK_MS,
  TOKEN_HEADER,
  tokenFromHtml,
} from '../../../../scripts/lib/localApi';
import { assertNotRealDataDir } from '../../../../scripts/lib/dataSnapshot';
import { realDataDirPrefixOf } from '../../../../scripts/lib/realDataDir';
import { formatSseEvent } from '@study-paper/shared/contracts/sse';
import { QUEUE_TIMEOUT_MS, TASK_SPECS, TaskId } from '@study-paper/shared/contracts/tasks';
import { tokenFilePath } from '../../src/security/runtimePaths';
import { tempDir } from '../helpers/tmp';

const servers: http.Server[] = [];
const clients: LocalApi[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/**
 * A local server: `/` answers the prod HTML with a token meta (content `metaToken`, default 00ff), `/slow` answers after
 * `delayMs`, `/api/health` at once.
 */
async function startServer(delayMs: number, metaToken = '00ff'): Promise<number> {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><meta name="sp-token" content="${metaToken}"></head></html>`);
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('late'), delayMs);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`token=${req.headers['x-sp-token'] ?? ''}`);
  });
  servers.push(server);
  for (;;) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    if (!FORBIDDEN_PORTS.has(port)) return port;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('localApi (route id / getText — live E2E)', () => {
  it('only http://127.0.0.1:<allowed port>: other hosts, schemes, missing ports and forbidden ports throw at creation', async () => {
    for (const bad of ['http://localhost:4560', 'http://example.com:4560', 'https://127.0.0.1:4560', 'http://127.0.0.1', 'http://[::1]:4560', 'http://u:p@127.0.0.1:4560', 'http://127.0.0.1:4560/api', 'not a url']) {
      expect(() => checkBaseUrl(bad), bad).toThrow(LocalApiError);
      await expect(LocalApi.open(bad, { token: { value: '00' }, timeoutMs: 1000 }), bad).rejects.toThrow(LocalApiError);
    }
    for (const port of [4310, 5173, 4321, 4325, 4329, 5175]) {
      expect(() => checkBaseUrl(`http://127.0.0.1:${port}`), String(port)).toThrow(/forbidden/);
      await expect(LocalApi.open(`http://127.0.0.1:${port}`, { token: { value: '00' }, timeoutMs: 1000 })).rejects.toThrow(/forbidden/);
    }
    expect(checkBaseUrl('http://127.0.0.1:4570').port).toBe('4570');
  });

  it('timeoutMs is required and must be a positive finite number', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => checkTimeoutMs(bad), String(bad)).toThrow(/timeoutMs/);
    const port = await startServer(0);
    const api = await LocalApi.open(`http://127.0.0.1:${port}`, { token: { value: '00' }, timeoutMs: 5000 });
    clients.push(api);
    await expect(api.getText('/api/health', { timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
    // @ts-expect-error timeoutMs has no default: a call without it does not compile
    await expect(api.getText('/api/health', {})).rejects.toThrow(/timeoutMs/);
  });

  it('a local server that answers after 1.5 s: timeoutMs 500 → timeout error, 5000 → the answer', async () => {
    const port = await startServer(1_500);
    const api = await LocalApi.open(`http://127.0.0.1:${port}`, { token: 'html', timeoutMs: 5000 });
    clients.push(api);
    expect(api.token).toBe('00ff');
    const t0 = Date.now();
    await expect(api.getText('/slow', { timeoutMs: 500 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1_400);
    await expect(api.getText('/slow', { timeoutMs: 5000 })).resolves.toEqual({ status: 200, text: 'late' });
    // the token from the HTML is sent on every request
    await expect(api.getText('/api/health', { timeoutMs: 5000 })).resolves.toEqual({ status: 200, text: 'token=00ff' });
  }, 20_000);

  it('getText refuses a path that would name another host (protocol-relative //host, backslash) before any request', async () => {
    const base = 'http://127.0.0.1:4570';
    for (const bad of ['//example.com/x', '//127.0.0.2:4570/', '/\\example.com/x', '\\\\example.com/x', 'http://example.com/x', 'api/health']) expect(() => checkLocalPath(bad, base), bad).toThrow(LocalApiError);
    for (const ok of ['/', '/api/health', '/a//b', '/x?y=//z']) expect(checkLocalPath(ok, base), ok).toBe(ok);
    // on a real client: refused before a request; an ordinary path still reaches the local server
    const port = await startServer(0);
    const api = await LocalApi.open(`http://127.0.0.1:${port}`, { token: { value: '00' }, timeoutMs: 5000 });
    clients.push(api);
    await expect(api.getText('//example.com/x', { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'usage' });
    await expect(api.getText('/\\example.com/x', { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'usage' });
    await expect(api.getText('/api/health', { timeoutMs: 5000 })).resolves.toEqual({ status: 200, text: 'token=00' });
  });

  it('runStreamTimeoutMs = totalMs + queue limit + 30 s, above totalMs + queue for every task of milestone ≤ 2', () => {
    for (const task of TaskId.options) {
      const spec = TASK_SPECS[task];
      expect(runStreamTimeoutMs(task)).toBe(spec.totalMs + QUEUE_TIMEOUT_MS[spec.priority] + 30_000);
      if (spec.milestone <= 2) expect(runStreamTimeoutMs(task), task).toBeGreaterThan(spec.totalMs + QUEUE_TIMEOUT_MS[spec.priority]);
    }
    expect(runStreamTimeoutMs('explain_selection')).toBeGreaterThan(30_000); // never the Playwright default
  });

  it('parseSseText: contract events in order, comments skipped, an unknown event or bad data throws', () => {
    const text = ': keep-alive\n\nevent: run.accepted\ndata: {"runId":"r1","task":"chat"}\n\nevent: run.delta\ndata: {"text":"a"}\n\nevent: run.error\ndata: {"code":"cancelled","message":"m","retryable":false}\n\n';
    expect(parseSseText(text).map((e) => e.event)).toEqual(['run.accepted', 'run.delta', 'run.error']);
    expect(() => parseSseText('event: run.bogus\ndata: {}\n\n')).toThrow(/unknown SSE event/);
    expect(() => parseSseText('event: run.delta\ndata: {"text":1}\n\n')).toThrow();
  });

  it('tokenFromHtml reads the sp-token meta (e2e/helpers.test.ts compares it with the e2e helper)', () => {
    expect(tokenFromHtml('<meta name="sp-token" content="abc123">')).toBe('abc123');
    expect(() => tokenFromHtml('<html></html>')).toThrow(/sp-token/);
  });
});

describe('localApi (path calls — rehearsal)', () => {
  let server: http.Server;
  let base = '';
  const seen: { method: string; url: string; token: string | undefined }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', token: req.headers['x-sp-token'] as string | undefined });
      if (req.url === '/slow') {
        setTimeout(() => res.end('{"ok":true}'), 1_500);
        return;
      }
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<html><head><meta name="sp-token" content="abc123"></head></html>');
        return;
      }
      if (req.url === '/sse') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(formatSseEvent({ event: 'job.step', data: { step: 'html', status: 'ok' } }));
        res.end(formatSseEvent({ event: 'job.done', data: { paperId: 'p1' } }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses another host, a non-http URL and every forbidden port at creation', async () => {
    for (const u of ['http://localhost:4580', 'http://10.0.0.1:4580', 'https://127.0.0.1:4580', 'http://127.0.0.1', 'http://127.0.0.1:4580/api'])
      await expect(LocalApi.open({ baseUrl: u, token: 'none', timeoutMs: 1_000 })).rejects.toThrow();
    expect([...FORBIDDEN_PORTS]).toEqual(expect.arrayContaining([4310, 5173, 5175, ...Array.from({ length: 9 }, (_, i) => 4321 + i)]));
    for (const p of FORBIDDEN_PORTS) {
      expect(() => checkBaseUrl(`http://127.0.0.1:${p}`)).toThrow(/forbidden/);
      await expect(LocalApi.open({ baseUrl: `http://127.0.0.1:${p}`, token: 'none', timeoutMs: 1_000 })).rejects.toThrow(/forbidden/);
    }
    expect(checkBaseOrigin('http://127.0.0.1:4580').port).toBe(4580);
  });

  it('a call slower than timeoutMs throws; a longer timeout passes; 0 / negative / infinite timeouts throw', async () => {
    const api = await LocalApi.open({ baseUrl: base, token: 'none', timeoutMs: 5_000 });
    try {
      await expect(api.get('/slow', { timeoutMs: 500 })).rejects.toThrow();
      const r = await api.get('/slow', { timeoutMs: 5_000 });
      expect(r.status).toBe(200);
      expect(r.json()).toEqual({ ok: true });
      for (const t of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) await expect(api.get('/x', { timeoutMs: t })).rejects.toThrow(/timeoutMs/);
      // @ts-expect-error — timeoutMs is a required argument (no default)
      await expect(api.get('/x', {})).rejects.toThrow(/timeoutMs/);
    } finally {
      await api.dispose();
    }
  });

  it('get / post / put / delete send the token and record method, path and status', async () => {
    const dir = tempDir();
    const env = { XDG_RUNTIME_DIR: dir };
    const port = Number(new URL(base).port);
    mkdirSync(dirname(tokenFilePath(port, env)), { recursive: true });
    writeFileSync(tokenFilePath(port, env), 'feed42\n');
    const api = await LocalApi.open({ baseUrl: base, token: 'dev', timeoutMs: 5_000, env });
    try {
      seen.length = 0;
      expect((await api.post('/a', { timeoutMs: 5_000, json: { x: 1 } })).json()).toEqual({ method: 'POST', url: '/a' });
      await api.put('/b', { timeoutMs: 5_000, json: {} });
      await api.delete('/c', { timeoutMs: 5_000 });
      await api.get('/d', { timeoutMs: 5_000, noToken: true });
      expect(seen.map((s) => [s.method, s.url, s.token])).toEqual([
        ['POST', '/a', 'feed42'],
        ['PUT', '/b', 'feed42'],
        ['DELETE', '/c', 'feed42'],
        ['GET', '/d', undefined],
      ]);
      expect(api.calls).toEqual([
        { method: 'POST', path: '/a', status: 200 },
        { method: 'PUT', path: '/b', status: 200 },
        { method: 'DELETE', path: '/c', status: 200 },
        { method: 'GET', path: '/d', status: 200 },
      ]);
    } finally {
      await api.dispose();
    }
    const prod = await LocalApi.open({ baseUrl: base, token: 'prod', timeoutMs: 5_000 });
    try {
      seen.length = 0;
      await prod.get('/e', { timeoutMs: 5_000 });
      expect(seen.at(-1)?.token).toBe('abc123');
    } finally {
      await prod.dispose();
    }
  });

  it('a path that would leave the origin throws before any request: nothing recorded, nothing reaches the server', async () => {
    const api = await LocalApi.open({ baseUrl: base, token: 'none', timeoutMs: 5_000 });
    try {
      seen.length = 0;
      const bad = ['//evil.example/x', '/\\evil.example/x', '/\\\\evil.example/x', '/\t/evil.example', '/\n/evil.example', '/x\r', '/x\u0000', 'http://evil.example/x', `${base}/x`, 'x', ''];
      for (const p of bad) {
        expect(() => resolvePath(base, p)).toThrow(/path/);
        await expect(api.get(p, { timeoutMs: 1_000 })).rejects.toThrow(/path/);
        await expect(api.post(p, { timeoutMs: 1_000, json: {} })).rejects.toThrow(/path/);
        await expect(api.sse('GET', p, { timeoutMs: 1_000 })).rejects.toThrow(/path/);
      }
      expect(seen).toEqual([]);
      expect(api.calls).toEqual([]);
      // what the URL parser itself would do with two of them: another host
      expect(new URL('/\\evil.example/x', base).hostname).toBe('evil.example');
      expect(new URL('/\t/evil.example', base).hostname).toBe('evil.example');
      // ordinary paths stay on the origin (dot segments and encoded slashes included)
      expect(resolvePath(base, '/api/papers/a%2Fb?x=1')).toBe(`${base}/api/papers/a%2Fb?x=1`);
      expect(new URL(resolvePath(base, '/a/../..//b')).origin).toBe(base);
      expect((await api.get('/api/papers/a%2Fb', { timeoutMs: 5_000 })).json()).toEqual({ method: 'GET', url: '/api/papers/a%2Fb' });
    } finally {
      await api.dispose();
    }
  });

  it('dev token: XDG_RUNTIME_DIR or SP_DATA_DIR must be set, and the token file must not be under the real data directory', async () => {
    expect(() => devTokenPath(4580, { HOME: '/home/u' })).toThrow(/XDG_RUNTIME_DIR or SP_DATA_DIR/);
    expect(() => devTokenPath(4580, { HOME: '/home/u', SP_DATA_DIR: '/home/u/.local/share/study_paper' })).toThrow(/real data directory/);
    expect(() => devTokenPath(4580, { HOME: '/home/u', XDG_RUNTIME_DIR: '/home/u/.local/share/study_paper/run' })).toThrow(/real data directory/);
    expect(() => devTokenPath(4580, { HOME: '/home/u', XDG_DATA_HOME: '/x/data', SP_DATA_DIR: '/x/data/study_paper' })).toThrow(/real data directory/);
    expect(devTokenPath(4580, { HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1' })).toBe('/run/user/1/study_paper/token.4580');
    expect(devTokenPath(4580, { HOME: '/home/u', SP_DATA_DIR: '/w/.data/x' })).toBe('/w/.data/x/run/token.4580');
    seen.length = 0;
    await expect(LocalApi.open({ baseUrl: base, token: 'dev', timeoutMs: 1_000, env: { HOME: '/home/u' } })).rejects.toThrow(/XDG_RUNTIME_DIR or SP_DATA_DIR/);
    expect(seen).toEqual([]);
  });

  it('reads an SSE body to the end and checks each event against the contract', async () => {
    const api = await LocalApi.open({ baseUrl: base, token: 'none', timeoutMs: 5_000 });
    try {
      const r = await api.sse('GET', '/sse', { timeoutMs: 5_000 });
      expect(r.events).toEqual([
        { event: 'job.step', data: { step: 'html', status: 'ok' } },
        { event: 'job.done', data: { paperId: 'p1' } },
      ]);
    } finally {
      await api.dispose();
    }
    expect(() => parseSseBody('event: job.nope\ndata: {}\n\n')).toThrow(/unknown SSE event/);
    expect(() => parseSseBody('event: job.done\ndata: {"paperId":1}\n\n')).toThrow();
  });

  it('runStreamTimeoutMs exceeds totalMs + queue wait for every milestone ≤ 2 task', () => {
    const tasks = TaskId.options.filter((t) => TASK_SPECS[t].milestone <= 2);
    expect(tasks.length).toBeGreaterThan(5);
    for (const t of tasks) {
      const s = TASK_SPECS[t];
      expect(runStreamTimeoutMs(t)).toBeGreaterThan(s.totalMs + QUEUE_TIMEOUT_MS[s.priority]);
      expect(runStreamTimeoutMs(t)).toBe(s.totalMs + QUEUE_TIMEOUT_MS[s.priority] + STREAM_SLACK_MS);
    }
  });

  it('tokenFromHtml reads the sp-token meta and throws without it', () => {
    expect(tokenFromHtml('<meta name="sp-token" content="0a1b">')).toBe('0a1b');
    expect(() => tokenFromHtml('<html></html>')).toThrow(/sp-token/);
  });
});

describe('localApi (one module for both styles — INTEGRATION_NOTES 결정 9)', () => {
  it('the rehearsal names are the live E2E functions or the same values', () => {
    expect(parseSseBody).toBe(parseSseText);
    expect(STREAM_SLACK_MS).toBe(RUN_STREAM_SLACK_MS);
    expect(STREAM_SLACK_MS).toBe(30_000);
    expect(TOKEN_HEADER).toBe('X-SP-Token');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, '5']) expect(() => assertTimeout(bad), String(bad)).toThrow(/timeoutMs/);
    expect(() => assertTimeout(1)).not.toThrow();
    expect(checkBaseOrigin('http://127.0.0.1:4580')).toEqual({ origin: 'http://127.0.0.1:4580', port: 4580 });
    // the union of both base URL rules: stream 1's userinfo / IPv6 / non-URL refusals and stream 2's port range
    for (const bad of ['http://127.0.0.1:80', 'http://127.0.0.1:1023', 'http://u:p@127.0.0.1:4580', 'http://[::1]:4580', 'not a url']) {
      expect(() => checkBaseOrigin(bad), bad).toThrow(LocalApiError);
      expect(() => checkBaseUrl(bad), bad).toThrow(LocalApiError);
    }
  });

  it('one path validator: the stream 2 refusals hold for checkLocalPath, the stream 1 refusals for resolvePath', () => {
    const base = 'http://127.0.0.1:4570';
    for (const bad of ['//evil.example/x', '/\\evil.example/x', '/\t/evil.example', '/\n/evil.example', '/x\r', '/x\u0000', '/x\u007f', 'http://evil.example/x', `${base}/x`, 'x', '', '//127.0.0.2:4570/', '\\\\example.com/x', 'api/health']) {
      expect(() => checkLocalPath(bad, base), JSON.stringify(bad)).toThrow(LocalApiError);
      expect(() => checkLocalPath(bad, base), JSON.stringify(bad)).toThrow(/path/);
      expect(() => resolvePath(base, bad), JSON.stringify(bad)).toThrow(LocalApiError);
    }
    for (const ok of ['/', '/api/health', '/a//b', '/x?y=//z']) expect(resolvePath(base, ok), ok).toBe(new URL(ok, base).href);
    // a base given with its trailing slash is the same origin
    expect(resolvePath(`${base}/`, '/api/health')).toBe(`${base}/api/health`);
  });

  it('every entry point (getText, route id, get / post / put / delete, both sse forms) refuses a bad path before a request, and nothing is recorded', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const api = await LocalApi.open(`http://127.0.0.1:${port}`, { token: { value: '00' }, timeoutMs: 5000 });
    clients.push(api);
    for (const p of ['/\t/evil.example', '/x\u0000', '//evil.example/x', '/\\evil.example/x']) {
      await expect(api.getText(p, { timeoutMs: 1000 }), JSON.stringify(p)).rejects.toMatchObject({ kind: 'usage' });
      await expect(api.get(p, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'usage' });
      await expect(api.post(p, { timeoutMs: 1000, json: {} })).rejects.toMatchObject({ kind: 'usage' });
      await expect(api.put(p, { timeoutMs: 1000, json: {} })).rejects.toMatchObject({ kind: 'usage' });
      await expect(api.delete(p, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'usage' });
      await expect(api.sse('POST', p, { timeoutMs: 1000, json: {} })).rejects.toMatchObject({ kind: 'usage' });
    }
    expect(hits).toEqual([]);
    expect(api.calls).toEqual([]);
    // route-id calls: their params are encoded into one path segment, so they stay on the origin and are recorded
    await expect(api.json('papers.get', { params: { id: '//evil.example' }, timeoutMs: 5000 })).rejects.toBeInstanceOf(LocalApiError);
    expect(hits).toEqual(['GET /api/papers/%2F%2Fevil.example']);
    expect(api.calls).toEqual([{ method: 'GET', path: '/api/papers/%2F%2Fevil.example', status: 200 }]);
    await expect(api.getText('/api/health', { timeoutMs: 5000 })).resolves.toEqual({ status: 200, text: '{}' });
    expect(api.calls.at(-1)).toEqual({ method: 'GET', path: '/api/health', status: 200 });
  });

  it('a timed-out request is recorded with status 0 and throws a timeout LocalApiError', async () => {
    const port = await startServer(1_500);
    const api = await LocalApi.open({ baseUrl: `http://127.0.0.1:${port}`, token: 'prod', timeoutMs: 5000 });
    clients.push(api);
    expect(api.token).toBe('00ff');
    expect(api.origin).toBe(`http://127.0.0.1:${port}`);
    expect(api.port).toBe(port);
    await expect(api.get('/slow', { timeoutMs: 300 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(api.calls).toEqual([{ method: 'GET', path: '/slow', status: 0 }]);
  }, 20_000);

  it('one dev-token-file rule: devTokenFile is devTokenPath, and a token file under the real data directory is never read', async () => {
    for (const env of [{ HOME: '/home/u' }, { HOME: '/home/u', SP_DATA_DIR: '/home/u/.local/share/study_paper' }, { HOME: '/home/u', XDG_RUNTIME_DIR: '/home/u/.local/share/study_paper-pre-m2/run' }, { HOME: '/home/u', XDG_DATA_HOME: '/x/data', SP_DATA_DIR: '/x/data/study_paper' }]) {
      let a: unknown;
      let b: unknown;
      try {
        devTokenFile(4580, env);
      } catch (e) {
        a = e;
      }
      try {
        devTokenPath(4580, env);
      } catch (e) {
        b = e;
      }
      expect(a, JSON.stringify(env)).toBeInstanceOf(LocalApiError);
      expect((a as Error).message).toBe((b as Error).message);
    }
    expect(devTokenFile(4580, { HOME: '/home/u', SP_DATA_DIR: '/w/.data/x' })).toBe(devTokenPath(4580, { HOME: '/home/u', SP_DATA_DIR: '/w/.data/x' }));
    // a real-data-looking token file (HOME moved to a temp dir) is refused by open({ file }) before it is read
    const port = await startServer(0);
    const home = tempDir();
    const file = join(home, '.local', 'share', 'study_paper', 'run', `token.${port}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'feed42\n');
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(LocalApi.open(`http://127.0.0.1:${port}`, { token: { file }, timeoutMs: 5000 })).rejects.toThrow(/real data directory/);
      // the same file through the server-env form (dev): refused as well
      await expect(LocalApi.open({ baseUrl: `http://127.0.0.1:${port}`, token: 'dev', timeoutMs: 5000, env: { HOME: home, SP_DATA_DIR: join(home, '.local', 'share', 'study_paper') } })).rejects.toThrow(/real data directory/);
    } finally {
      process.env.HOME = saved;
    }
    // outside the real data directory the same file content is read
    const ok = join(tempDir(), 'token');
    writeFileSync(ok, 'feed42\n');
    const api = await LocalApi.open(`http://127.0.0.1:${port}`, { token: { file: ok }, timeoutMs: 5000 });
    clients.push(api);
    expect(api.token).toBe('feed42');
    await expect(api.getText('/api/health', { timeoutMs: 5000 })).resolves.toEqual({ status: 200, text: 'token=feed42' });
    // a token that is not hex is refused in both forms: string form { value }, object form dev (token file content)
    // and prod (an empty sp-token meta)
    await expect(LocalApi.open(`http://127.0.0.1:${port}`, { token: { value: 'not-hex' }, timeoutMs: 5000 })).rejects.toMatchObject({ kind: 'usage' });
    const devEnv = { HOME: '/home/u', SP_DATA_DIR: tempDir() };
    mkdirSync(dirname(tokenFilePath(port, devEnv)), { recursive: true });
    writeFileSync(tokenFilePath(port, devEnv), 'not hex\n');
    await expect(LocalApi.open({ baseUrl: `http://127.0.0.1:${port}`, token: 'dev', timeoutMs: 5000, env: devEnv })).rejects.toMatchObject({ kind: 'usage', message: expect.stringMatching(/not a hex string/) });
    writeFileSync(tokenFilePath(port, devEnv), 'feed42\n');
    const devApi = await LocalApi.open({ baseUrl: `http://127.0.0.1:${port}`, token: 'dev', timeoutMs: 5000, env: devEnv });
    clients.push(devApi);
    expect(devApi.token).toBe('feed42');
    const emptyMetaPort = await startServer(0, '');
    await expect(LocalApi.open({ baseUrl: `http://127.0.0.1:${emptyMetaPort}`, token: 'prod', timeoutMs: 5000 })).rejects.toMatchObject({ kind: 'usage', message: expect.stringMatching(/not a hex string/) });
    const prodApi = await LocalApi.open({ baseUrl: `http://127.0.0.1:${port}`, token: 'prod', timeoutMs: 5000 });
    clients.push(prodApi);
    expect(prodApi.token).toBe('00ff');
  });

  it('one real-data-directory rule: localApi token files and dataSnapshot path arguments refuse the same paths (realDataDirPrefixOf)', () => {
    // a fake HOME and XDG_DATA_HOME in temp dirs (the real ones are never named), with symbolic links to both
    const root = tempDir();
    const home = join(root, 'home');
    const xdgReal = join(root, 'xdg-real');
    mkdirSync(join(home, '.local', 'share', 'study_paper'), { recursive: true });
    mkdirSync(join(xdgReal, 'study_paper'), { recursive: true });
    mkdirSync(join(root, 'work'), { recursive: true });
    symlinkSync(join(home, '.local', 'share', 'study_paper'), join(root, 'alias-home-data'));
    symlinkSync(xdgReal, join(root, 'xdg-link'));
    // RM-R1-04 (1): a prefix-named entry of ~/.local/share that is itself a link — its target refuses what is inside it
    mkdirSync(join(root, 'linked-target'), { recursive: true });
    symlinkSync(join(root, 'linked-target'), join(home, '.local', 'share', 'study_paper-linked'));
    // RM-R2-03: a prefix-named link whose target does not exist yet (study_paper-pre-m2 on an unmounted disk) still
    // refuses its target, so a snapshot --out cannot create the real data directory there
    symlinkSync(join(root, 'not-yet', 'target'), join(home, '.local', 'share', 'study_paper-dangling'));
    const env = { HOME: home, XDG_DATA_HOME: join(root, 'xdg-link') };
    // RM-R1-04 (2): HOME is moved to a temp dir here, the account's home (user database) still counts. A name that does
    // not exist: the rule only inspects paths, nothing under the real home is opened.
    const accountData = join(userInfo().homedir, '.local', 'share', 'study_paper-rm-r1-04-probe-does-not-exist');
    const table: [string, boolean][] = [
      [join(home, '.local', 'share', 'study_paper'), true],
      [join(home, '.local', 'share', 'study_paper-pre-m2'), true],
      [join(root, 'xdg-link', 'study_paper'), true],
      [join(xdgReal, 'study_paper'), true],
      [join(root, 'alias-home-data'), true],
      [join(root, 'linked-target', 'data'), true],
      [accountData, true],
      [join(root, 'not-yet', 'target', 'data'), true],
      [join(root, 'linked-target-sibling'), false],
      [join(root, 'not-yet', 'other'), false],
      [join(home, '.local', 'share', 'other'), false],
      [join(root, 'work', 'study_paper'), false],
      [join(root, 'xdg-real-not'), false],
    ];
    for (const [dataDir, refused] of table) {
      const tokenFile = tokenFilePath(4580, { SP_DATA_DIR: dataDir });
      const label = `${dataDir} → ${refused ? 'refused' : 'allowed'}`;
      expect(realDataDirPrefixOf(tokenFile, env) !== null, label).toBe(refused);
      expect(realDataDirPrefixOf(dataDir, env) !== null, label).toBe(refused);
      // localApi: the dev token file of a server whose SP_DATA_DIR is dataDir
      const viaLocalApi = () => devTokenPath(4580, { ...env, SP_DATA_DIR: dataDir });
      // dataSnapshot: the same directory as a path argument
      const viaSnapshot = () => assertNotRealDataDir('--data', dataDir, env);
      if (refused) {
        expect(viaLocalApi, label).toThrow(/real data directory/);
        expect(viaSnapshot, label).toThrow(/real data directory/);
      } else {
        expect(viaLocalApi(), label).toBe(tokenFile);
        expect(viaSnapshot, label).not.toThrow();
      }
      // the only difference: SP_SNAPSHOT_ALLOW_REAL=1 lifts dataSnapshot's refusal, never localApi's
      const allowEnv = { ...env, SP_SNAPSHOT_ALLOW_REAL: '1' };
      expect(() => assertNotRealDataDir('--data', dataDir, allowEnv), label).not.toThrow();
      if (refused) expect(() => devTokenPath(4580, { ...allowEnv, SP_DATA_DIR: dataDir }), label).toThrow(/real data directory/);
    }
  });
});
