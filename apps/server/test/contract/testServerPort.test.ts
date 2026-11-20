// The test server's port (INT-WARNOK-R1-08). Owner: supervisor. freePort closes its probe before the caller listens,
// so a parallel worker can take the port in between; startTestServer then got an uncaught EADDRINUSE and waited for
// 'listening' until the test timed out. serveOnFreePort retries with a new port on EADDRINUSE only.
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/proc';
import { freePort, serveOnFreePort, startTestServer } from '../helpers/server';
import { stripComments } from '../helpers/sourceScan';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
/** A plain TCP listener holding a port (another worker's server). */
async function holdPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise<void>((r) => s.close(() => r())));
  return (s.address() as net.AddressInfo).port;
}
const get = (port: number) =>
  new Promise<string>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString('utf8')));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
const ok = () => new Response('ok-from-test');

describe('serveOnFreePort: a port taken between freePort and listen', () => {
  it('EADDRINUSE on the first port → a new port; the server answers there', async () => {
    const taken = await holdPort();
    const given: number[] = [];
    const ports = [taken];
    const { server, port } = await serveOnFreePort(ok, {
      nextPort: async () => {
        const p = ports.shift() ?? (await freePort());
        given.push(p);
        return p;
      },
    });
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    expect(given).toHaveLength(2);
    expect(given[0]).toBe(taken);
    expect(port).toBe(given[1]);
    expect(port).not.toBe(taken);
    expect(await get(port)).toBe('ok-from-test');
  });

  it('every port taken: the last EADDRINUSE after `attempts` ports', async () => {
    const taken = await holdPort();
    let calls = 0;
    const err = await serveOnFreePort(ok, { attempts: 3, nextPort: async () => (calls++, taken) }).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(err?.code).toBe('EADDRINUSE');
    expect(calls).toBe(3);
  });

  it('another listen error is thrown at once (no retry)', async () => {
    let calls = 0;
    const err = await serveOnFreePort(ok, { nextPort: async () => (calls++, 70_000) }).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(err?.code).toBe('ERR_SOCKET_BAD_PORT');
    expect(calls).toBe(1);
  });

  it('startTestServer listens through serveOnFreePort (no second serve() call) and answers on the port it reports', async () => {
    const code = stripComments(readFileSync(join(REPO_ROOT, 'apps/server/test/helpers/server.ts'), 'utf8'));
    expect(code.match(/\bserve\(\{/g)).toHaveLength(1);
    expect(code).toMatch(/export async function serveOnFreePort\([\s\S]*?const server = serve\(\{ fetch, hostname: '127\.0\.0\.1', port \}\);/);
    expect(code).toMatch(/export async function startTestServer\([\s\S]*?const \{ server, port \} = await serveOnFreePort\(/);
    const s = await startTestServer({ env: 'test' });
    closers.push(() => s.close());
    const r = await s.req('/api/health', { headers: { 'X-SP-Token': s.token } }); // the Host rule uses the reported port
    expect(r.status).toBe(200);
  });
});
