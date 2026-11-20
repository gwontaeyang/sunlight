// A migrated + seeded DB with a run manager on top (no HTTP), for runManager / queue / paperContext tests. Owner B.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import type { TaskId } from '@study-paper/shared/contracts/tasks';
import { openSqlite, toDrizzle, type Db, type Sqlite } from '../../src/db/client';
import { migrateWithBackup } from '../../src/db/migrate';
import { messages, threads } from '../../src/db/schema';
import { SEED_PAPER_ID, seedFixture } from '../../src/dev/seedFixture';
import { Lifecycle } from '../../src/lifecycle';
import type { LlmAdapter } from '../../src/llm/adapter';
import { ClaudeCliAdapter } from '../../src/llm/claudeCli';
import { createRunManager, type RunManagerDeps, type RunTaskRequest } from '../../src/llm/runManager';
import type { RunHandle } from '../../src/llm/runContract';
import { dataPaths, ensureDataDirs, type DataPaths } from '../../src/paths';
import { tempDir } from '../helpers/tmp';
import { fakeClaudeBin } from './fakeCli';

export interface RunEnv {
  root: string;
  paths: DataPaths;
  sqlite: Sqlite;
  db: Db;
  lifecycle: Lifecycle;
  manager: ReturnType<typeof createRunManager>;
  /** Mutable env of the fake CLI (read at each spawn). */
  fakeEnv: Record<string, string | undefined>;
  pids: number[];
  /** New manager on the same DB (a "restart"; the old one is left alone). */
  restart(over?: Partial<RunManagerDeps>): ReturnType<typeof createRunManager>;
  close(): void;
}

export async function makeRunEnv(opts: { adapter?: LlmAdapter; deps?: Partial<RunManagerDeps>; fakeEnv?: Record<string, string> } = {}): Promise<RunEnv> {
  const root = tempDir('sp-run-');
  const paths = dataPaths(join(root, 'data'));
  ensureDataDirs(paths);
  const sqlite = openSqlite(paths.dbFile);
  await migrateWithBackup(sqlite, { backupsDir: paths.backupsDir });
  const db = toDrizzle(sqlite);
  await seedFixture(db, sqlite, paths);
  const pids: number[] = [];
  const fakeEnv: Record<string, string | undefined> = { ...process.env, ...opts.fakeEnv };
  const adapter = opts.adapter ?? new ClaudeCliAdapter({ claudeBin: fakeClaudeBin(root), env: fakeEnv, onSpawn: (pid) => pids.push(pid), log: () => {} });
  const lifecycle = new Lifecycle();
  const base = { db, paths, adapter, lifecycle, log: () => {}, ...opts.deps };
  return {
    root,
    paths,
    sqlite,
    db,
    lifecycle,
    manager: createRunManager(base),
    fakeEnv,
    pids,
    restart: (over = {}) => createRunManager({ ...base, lifecycle: new Lifecycle(), ...over }),
    close: () => sqlite.close(),
  };
}

/** startRows like the routes': a new thread with a user message and a streaming assistant message. */
export function threadRows(paperId = SEED_PAPER_ID): RunTaskRequest['startRows'] & { ids: { threadId?: string; messageId?: string } } {
  const ids: { threadId?: string; messageId?: string } = {};
  return {
    ids,
    insert: (tx) => {
      const now = Date.now();
      ids.threadId = randomUUID();
      ids.messageId = randomUUID();
      tx.insert(threads).values({ id: ids.threadId, paperId, kind: 'explain', title: 't', createdAt: now, updatedAt: now }).run();
      tx.insert(messages).values({ id: randomUUID(), threadId: ids.threadId, role: 'user', contentMd: 'q', status: 'complete', createdAt: now }).run();
      tx.insert(messages).values({ id: ids.messageId, threadId: ids.threadId, role: 'assistant', contentMd: '', status: 'streaming', createdAt: now + 1 }).run();
      return { threadId: ids.threadId, messageId: ids.messageId };
    },
  };
}

export function request(over: Partial<RunTaskRequest> = {}, task: TaskId = 'explain_selection'): RunTaskRequest {
  return { task, clientRequestId: randomUUID(), paperId: SEED_PAPER_ID, inputs: { selection: 'We estimate the robot pose' }, startRows: threadRows(), ...over };
}

export async function events(h: RunHandle): Promise<RunSseEvent[]> {
  const out: RunSseEvent[] = [];
  for await (const e of h.subscribe()) out.push(e);
  return out;
}

export const terminalOf = (ev: RunSseEvent[]) => ev.filter((e) => e.event === 'run.done' || e.event === 'run.error');

export async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
