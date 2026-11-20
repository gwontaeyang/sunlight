import { Backends } from '../../src/byok/backend';
import { ApiProvider } from '../../src/byok/provider';
import { CredentialStore, credentialDirectory } from '../../src/byok/credentials';
// Real HTTP test server on 127.0.0.1:<free port> with an isolated data dir (never the user's).
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../../src/app';
import { loadConfig, type SpEnv } from '../../src/config';
import { openSqlite, toDrizzle } from '../../src/db/client';
import { migrateWithBackup } from '../../src/db/migrate';
import type { AppDeps } from '../../src/deps';
import { seedFixture, type SeedPaper } from '../../src/dev/seedFixture';
import { configureIngest, ingestService } from '../../src/ingest/pipeline';
import type { LlmEvent, LlmRunRequest } from '../../src/llm/adapter';
import { startupRecovery } from '../../src/startupRecovery';
import { Lifecycle } from '../../src/lifecycle';
import type { LlmAdapter } from '../../src/llm/adapter';
import { createRunTask } from '../../src/llm/index';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { dataPaths, ensureDataDirs } from '../../src/paths';
import { generateToken } from '../../src/security/token';
import { fileTempDir } from './tmp';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

type ServeFetch = Parameters<typeof serve>[0]['fetch'];
/**
 * Listens `fetch` on 127.0.0.1 at a port from `nextPort` (default freePort), with a new port on EADDRINUSE: freePort
 * closes its probe before the caller listens, so a parallel worker can take the port in between (INT-WARNOK-R1-08 —
 * an uncaught EADDRINUSE left startTestServer waiting for 'listening' until the test timed out). Any other listen
 * error is thrown at once; after `attempts` taken ports the last EADDRINUSE is thrown.
 */
export async function serveOnFreePort(fetch: ServeFetch, o: { nextPort?: () => Promise<number>; attempts?: number } = {}): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  const nextPort = o.nextPort ?? freePort;
  const attempts = o.attempts ?? 5;
  let last: unknown = new Error('serveOnFreePort: attempts must be at least 1');
  for (let i = 0; i < attempts; i++) {
    const port = await nextPort();
    try {
      const server = serve({ fetch, hostname: '127.0.0.1', port });
      await new Promise<void>((resolve, reject) => {
        if (server.listening) return resolve();
        const onError = (e: Error) => {
          server.off('listening', onListening);
          reject(e);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
      });
      return { server, port };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      last = e;
    }
  }
  throw last;
}

export interface TestServer {
  /** Data directory (kept across restart()). */
  dataDir: string;
  port: number;
  webPort: number;
  token: string;
  deps: AppDeps;
  close(): Promise<void>;
  req(path: string, o?: { method?: string; headers?: Record<string, string>; body?: string | Buffer; host?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; text: string }>;
  /**
   * Stops this server like index.ts (drain, close, DB closed) and starts a new one on the SAME data directory, with
   * startup recovery, the same options and the same adapter object (pass `llm` to replace it). New port and token.
   */
  restart(o?: { llm?: LlmAdapter }): Promise<TestServer>;
}

export interface TestServerOptions {
  env: SpEnv;
  /** Seeds the M1 paper (SEED_PAPER_ID) — the M1 behaviour. */
  seed?: boolean;
  /** M2: seeds these papers (seedFixture's list); overrides `seed`. */
  papers?: readonly SeedPaper[];
  llm?: LlmAdapter;
  /** M2: offline arXiv directory for this server's ingest (honoured outside prod: use env 'test' or 'dev'). */
  offlineDir?: string;
  /**
   * M2: papers.delete's wait for writers (ms) — a short value makes the deferred-delete path reachable. Given, the
   * ingest service is created at start so the wait applies also when the test never imports a paper.
   */
  deleteWaitMs?: number;
  /** M2: injected fetch of the ingest (a spy: gate G7a asserts it is never called with an offline directory). */
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  apiTransport?: import('../../src/byok/provider').TestTransport;
  /** internal: an existing data dir (restart). */
  dataDir?: string;
}

export async function startTestServer(opts: TestServerOptions = { env: 'prod' }): Promise<TestServer> {
  const root = fileTempDir('sp-srv-');
  const paths = dataPaths(opts.dataDir ?? join(root, 'data'));
  ensureDataDirs(paths);
  const sqlite = openSqlite(paths.dbFile);
  let listener: ReturnType<typeof serve> | undefined;
  try {
    await migrateWithBackup(sqlite, { backupsDir: paths.backupsDir });
    const db = toDrizzle(sqlite);
    if (opts.dataDir) startupRecovery(sqlite, paths);
    else if (opts.papers) await seedFixture(db, sqlite, paths, Date.now(), { papers: opts.papers });
    else if (opts.seed) await seedFixture(db, sqlite, paths);
    const dist = join(root, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>app</body></html>');
    const webPort = await freePort();
    // listen first (a taken port is retried), then build the app for that port: config.port is part of the app's rules
    let app: ReturnType<typeof createApp> | null = null;
    const { server, port } = await serveOnFreePort((req, env) => (app ? app.fetch(req, env) : new Response('starting', { status: 503 })));
    listener = server;
    const pathsEnv = { SP_DATA_DIR: paths.root, SP_CONFIG_PATH: join(paths.root, '..', 'config', 'config.json'), SP_SECRETS_DIR: join(paths.root, '..', 'secrets') };
    const secretDir = credentialDirectory(pathsEnv, false);
    const config = {
      ...loadConfig({ SP_ENV: opts.env, SP_PORT: String(port), SP_WEB_PORT: String(webPort), ...pathsEnv, SP_LLM: 'mock' }),
      webDistDir: dist,
    };
    const token = generateToken();
    const llm = opts.llm ?? new MockLlmAdapter({ chunkDelayMs: 0 });
    const lifecycle = new Lifecycle();
    const backends = new Backends(sqlite, llm, new ApiProvider(sqlite, new CredentialStore(secretDir), opts.apiTransport), config.claudeBin);
    const deps: AppDeps = { backends, config, paths, sqlite, db, getToken: () => token, llm, ...createRunTask({ db, paths, adapter: llm, backends, lifecycle }), lifecycle, shutdown: lifecycle.signal };
    if (opts.offlineDir !== undefined || opts.deleteWaitMs !== undefined || opts.fetchImpl !== undefined) {
      configureIngest(deps, { ...(opts.offlineDir !== undefined ? { offlineDir: opts.offlineDir } : {}), ...(opts.deleteWaitMs !== undefined ? { deleteWaitMs: opts.deleteWaitMs } : {}), ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}) });
    }
    // papers.delete reads its wait from the ingest service (peekIngest) and falls back to the 5 s default while no
    // service exists — a server that only seeds would never apply the option (B-F3R1-03). Create it up front then.
    if (opts.deleteWaitMs !== undefined) ingestService(deps);
    app = createApp(deps);
    const close = () =>
      // Same order as index.ts: stop new work, drain participants, then close connections and the DB.
      lifecycle.drain(5_000).then(
        () =>
          new Promise<void>((resolve) => {
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => {
              sqlite.close();
              resolve();
            });
          }),
      );
    return {
      dataDir: paths.root,
      port,
      webPort,
      token,
      deps,
      restart: async (o = {}) => {
        await close();
        return startTestServer({ ...opts, llm: o.llm ?? llm, dataDir: paths.root });
      },
      close,
      req: (path, o = {}) =>
        new Promise((resolve, reject) => {
          const headers: Record<string, string> = { Host: o.host ?? `127.0.0.1:${port}`, ...o.headers };
          if (o.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(o.body));
          const r = http.request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers, setHost: false, agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const body = Buffer.concat(chunks);
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
            });
          });
          r.on('error', reject);
          if (o.body !== undefined) r.write(o.body);
          r.end();
        }),
    };
  } catch (error) {
    try {
      if (listener) {
        const server = listener;
        if ('closeAllConnections' in server) server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    } finally { sqlite.close(); }
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Controllable adapter for gate tests (M2): records every request, can replace the output of the next calls, and can
// hold a call until released. Wraps any adapter (default: MockLlmAdapter without delays).

export interface RecordedCall {
  task: LlmRunRequest['task'];
  model: LlmRunRequest['model'];
  effort: LlmRunRequest['effort'];
  prefix: LlmRunRequest['prefix'];
  tail: LlmRunRequest['tail'];
}

export interface HoldOptions {
  ignoreAbort?: boolean;
  /** Only with ignoreAbort: after the release the call answers its normal result even if it was aborted. */
  lateResult?: boolean;
}

interface Hold {
  started: () => void;
  release: Promise<void>;
  ignoreAbort: boolean;
  lateResult: boolean;
}

function makeHold(o: HoldOptions): { hold: Hold; handle: { started: Promise<void>; release: () => void } } {
  if (o.lateResult === true && o.ignoreAbort !== true) throw new Error('holdNext/holdCall: lateResult needs ignoreAbort');
  let release!: () => void;
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const releaseP = new Promise<void>((r) => (release = r));
  return { hold: { started, release: releaseP, ignoreAbort: o.ignoreAbort === true, lateResult: o.lateResult === true }, handle: { started: startedP, release } };
}

export class ControlledAdapter implements LlmAdapter {
  readonly mode = 'mock' as const;
  readonly calls: RecordedCall[] = [];
  private readonly outputs: string[] = [];
  private holds: Hold[] = [];
  private readonly holdsAt = new Map<number, Hold>();
  constructor(private readonly inner: LlmAdapter = new MockLlmAdapter({ chunkDelayMs: 0 })) {}

  /** The next calls answer these texts, in order (then the inner adapter's normal output). */
  queueOutputs(...texts: string[]): void {
    this.outputs.push(...texts);
  }

  /** Number of queued outputs no call has taken yet. */
  get pendingOutputs(): number {
    return this.outputs.length;
  }

  /**
   * Drops the queued outputs no call has taken (e.g. the repair output of a request whose first output was already
   * valid) so they cannot leak into the next request. Returns how many were dropped.
   */
  clearOutputs(): number {
    return this.outputs.splice(0).length;
  }

  /**
   * The next call waits (after 'started', before any text) until `release()` is called; `started` resolves when that
   * call has begun. The call still honours its abort signal unless `ignoreAbort`. With `ignoreAbort` alone, a call
   * aborted meanwhile then still ends with the inner adapter's cancel error (it sees the aborted signal after the
   * release); with `lateResult` too, the inner adapter gets a signal that is never aborted, so the call answers its
   * normal result after the abort (a CLI that ignores the kill, or a result already on its way — B-CX-2).
   */
  holdNext(o: HoldOptions = {}): { started: Promise<void>; release: () => void } {
    const { hold, handle } = makeHold(o);
    this.holds.push(hold);
    return handle;
  }

  /** Like holdNext, for the call with this 1-based number (counted over the adapter's life, e.g. a repair call). */
  holdCall(n: number, o: HoldOptions = {}): { started: Promise<void>; release: () => void } {
    const { hold, handle } = makeHold(o);
    this.holdsAt.set(n, hold);
    return handle;
  }

  async *run(req: LlmRunRequest): AsyncIterable<LlmEvent> {
    this.calls.push({ task: req.task, model: req.model, effort: req.effort, prefix: req.prefix, tail: req.tail });
    const text = this.outputs.shift();
    const hold = this.holdsAt.get(this.calls.length) ?? this.holds.shift();
    this.holdsAt.delete(this.calls.length);
    if (hold) {
      yield { type: 'started', modelResolved: `mock-${req.model}`, cliVersion: 'mock' };
      hold.started();
      if (hold.ignoreAbort) await hold.release;
      else await Promise.race([hold.release, new Promise<void>((r) => (req.signal.aborted ? r() : req.signal.addEventListener('abort', () => r(), { once: true })))]);
      if (req.signal.aborted && !hold.ignoreAbort) {
        yield { type: 'error', code: 'cancelled', message: 'cancelled', retryable: false, partialText: '' };
        return;
      }
    }
    const source = text === undefined ? this.inner : new MockLlmAdapter({ chunkDelayMs: 0, outputs: { [req.task]: text } });
    const innerReq = hold?.lateResult ? { ...req, signal: new AbortController().signal } : req;
    let first = true;
    for await (const ev of source.run(innerReq)) {
      if (hold && first && ev.type === 'started') {
        first = false;
        continue; // already sent
      }
      first = false;
      yield ev;
    }
  }

  health() {
    return this.inner.health();
  }
}
