import { recoverReservations } from './byok/billing';
import { Backends } from './byok/backend';
import { ApiProvider } from './byok/provider';
import { CredentialStore } from './byok/credentials';
// Server entry point (PLAN 2.2). `npm run dev` (SP_ENV=dev) / `npm start` (SP_ENV=prod). Owner: supervisor.
// Startup order: data-dir lock → DB open → backup + migrate → startup recovery → listen → token/pid files.
// Shutdown order: lifecycle.ts.
import { realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { openSqlite, toDrizzle } from './db/client';
import { MigrationError, migrateWithBackup } from './db/migrate';
import { acquireInstanceLock, InstanceLockError, type InstanceLock } from './instanceLock';
import { Lifecycle, SHUTDOWN_DEADLINE_MS } from './lifecycle';
import { ClaudeCliAdapter, createRunTask } from './llm/index';
import { bindLiveLedgerLifecycle } from './llm/liveLedger';
import { MockLlmAdapter } from './llm/mockAdapter';
import { dataPaths, ensureDataDirs } from './paths';
import { startupRecovery } from './startupRecovery';
import { startResultSweep } from './resultRetention';
import { disableGlobalFetch } from './security/network';
import { generateToken, removeRuntimeTokenFile, writeRuntimeTokenFile } from './security/token';
import type { AppDeps } from './deps';

import { fileURLToPath } from 'node:url';

const log = (...a: unknown[]) => console.log('[study_paper]', ...a);
/** After the drain: how long in-flight responses may take to flush before connections are closed. */
const RESPONSE_FLUSH_MS = 1_500;

export async function startServer(userLauncher = false) {
  const config = loadConfig(process.env, userLauncher, true);
  const credentials = new CredentialStore(config.secretsDir!);
  credentials.status();
  credentials.recoverTemps();
  // Second line of defence (PLAN_M2 D23): with the network off, even a fetch that bypasses the guard is refused.
  if (config.network === 'off') disableGlobalFetch();
  const paths = dataPaths(config.dataDir);
  ensureDataDirs(paths);

  // Exclusive per data dir, before anything touches the DB, tmp/ or the token file of a running server.
  let lock: InstanceLock;
  try {
    lock = acquireInstanceLock(paths.lockFile, 'server');
  } catch (e) {
    if (!(e instanceof InstanceLockError)) throw e;
    console.error(`[study_paper] ${e.message}`);
    process.exit(1);
  }

  const sqlite = openSqlite(paths.dbFile);
  const closeDb = () => {
    try {
      sqlite.close();
    } catch {
      /* already closed */
    }
  };
  try {
    const m = await migrateWithBackup(sqlite, { backupsDir: paths.backupsDir });
    if (m.applied.length) log(`migrations applied: ${m.applied.join(', ')}${m.backupPath ? ` (backup ${m.backupPath})` : ''}`);
  } catch (e) {
    console.error(`[study_paper] ${(e as Error).message}`);
    if (e instanceof MigrationError && e.backupPath) console.error(`[study_paper] backup: ${e.backupPath}`);
    closeDb();
    lock.release();
    process.exit(1);
  }
  recoverReservations(sqlite);
  const recovery = startupRecovery(sqlite, paths);
  if (Object.values(recovery).some((n) => n > 0)) log('startup recovery', JSON.stringify(recovery));

  const token = generateToken();
  // Both files are written only after the port is ours, and removed only while they are still ours: a start
  // that fails to bind must not replace the token file of the server that already runs on this port.
  let tokenFile: string | null = null;
  let pidFileWritten = false;
  const removeOwnFiles = () => {
    if (tokenFile) removeRuntimeTokenFile(tokenFile, token);
    if (pidFileWritten) rmSync(paths.pidFile, { force: true });
  };

  const lifecycle = new Lifecycle();
  bindLiveLedgerLifecycle(lifecycle.signal); // pending live-ledger STOP retries end with the server
  const db = toDrizzle(sqlite);
  const mockDelay = process.env.SP_MOCK_CHUNK_DELAY_MS === undefined ? undefined : Number(process.env.SP_MOCK_CHUNK_DELAY_MS);
  const llm = config.llmMode === 'mock' ? new MockLlmAdapter({ chunkDelayMs: mockDelay }) : new ClaudeCliAdapter({ claudeBin: config.claudeBin, cwd: paths.claudeCwd });
  const backends = new Backends(sqlite, llm, new ApiProvider(sqlite, credentials), config.claudeBin);
  const deps: AppDeps = { backends, config, paths, sqlite, db, getToken: () => token, llm, ...createRunTask({ db, paths, adapter: llm, backends, lifecycle, concurrency: config.concurrency }), lifecycle, shutdown: lifecycle.signal };
  // After startup recovery: hourly removal of expired run results (resultRetention.ts); stops with the lifecycle.
  startResultSweep({ sqlite, lifecycle });
  const app = createApp(deps);
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    if (config.env === 'dev') tokenFile = writeRuntimeTokenFile(config.port, token);
    // A new file renamed into place: an existing server.pid (a crashed server's) is replaced, never written into.
    const pidTmp = `${paths.pidFile}.${process.pid}.tmp`;
    rmSync(pidTmp, { force: true });
    writeFileSync(pidTmp, String(process.pid), { mode: 0o600, flag: 'wx' });
    renameSync(pidTmp, paths.pidFile);
    pidFileWritten = true;
    log(`listening on http://${config.host}:${info.port} (env=${config.env}, llm=${config.llmMode}, network=${config.network}, data=${config.dataDir})`);
  });
  server.on('error', (e) => {
    console.error('[study_paper] server error:', e.message);
    removeOwnFiles();
    closeDb();
    lock.release();
    process.exit(1);
  });

  let stopping = false;
  const finish = (code: number) => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    removeOwnFiles();
    closeDb();
    lock.release();
    process.exit(code);
  };
  const stop = async (signal: string) => {
    if (stopping) {
      log(`${signal} again: exiting without waiting`);
      finish(1);
      return;
    }
    stopping = true;
    log(`${signal}: shutting down`);
    lifecycle.begin(); // 1. refuse new work
    let closed = false;
    server.close(() => (closed = true)); // 2. no new connections; open SSE streams still receive their terminal event
    const reports = await lifecycle.drain(SHUTDOWN_DEADLINE_MS); // 3. children gone + terminal rows written
    // Let in-flight responses (SSE streams carrying the terminal event) finish before connections are cut.
    const idle = server as unknown as { closeIdleConnections?: () => void };
    for (let waited = 0; !closed && waited < RESPONSE_FLUSH_MS; waited += 25) {
      idle.closeIdleConnections?.();
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const r of reports) {
      if (r.activeBefore > 0 || !r.ok) log(`drain ${r.name}: ${r.ok ? 'ok' : 'DEADLINE'} (${r.activeBefore} → ${r.activeAfter} active, ${r.ms} ms)`);
    }
    finish(reports.every((r) => r.ok) ? 0 : 1); // 4.
  };
  // SIGINT is raised on Ctrl+C on every OS (the documented way to stop on Windows). SIGTERM is POSIX; on win32 the
  // handler simply never fires (registering it does not throw), so the shutdown path still works through SIGINT.
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

/** Run as the program (npm start, dev, the runbook), not imported (start-user.ts): compared by real path, so a start
 *  through a symbolic link to the repository starts the server as before (the module URL is already the real path). */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.env.SP_ENV ??= 'prod'; // `npm start` default (the npm script no longer sets it inline — that is a POSIX shell-ism)
  void startServer();
}
