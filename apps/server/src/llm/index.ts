// runTask: the single entry point for LLM work (PLAN 2.3, 2.4, 9.3). Owner B.
// The run owner lives in runManager.ts (queue.ts, paperContext.ts, taskSerialize.ts, citations.ts) and the CLI
// adapter in claudeCli.ts. This file keeps the names index.ts (supervisor) imports.
import type { TaskPriority } from '@study-paper/shared/contracts/tasks';
import type { Db } from '../db/client';
import type { Lifecycle } from '../lifecycle';
import type { DataPaths } from '../paths';
import type { LlmAdapter, LlmTimeouts } from './adapter';
import { createRunManager } from './runManager';
import type { RunRegistry, RunTask } from './runContract';

export { PROMPT_VERSION, SYSTEM_PROMPT } from './runManager';
export type { RunHandle, RunRegistry, RunTask, RunTaskInput } from './runContract';
export { ClaudeCliAdapter } from './claudeCli';

export interface LlmDeps {
  db: Db;
  paths: DataPaths;
  backends?: import('../byok/backend').Backends;
  adapter: LlmAdapter;
  /** Shutdown contract (lifecycle.ts): the run owner registers a participant that aborts and awaits its runs. */
  lifecycle?: Lifecycle;
  /** config.concurrency (default DEFAULT_CONCURRENCY). */
  concurrency?: Record<TaskPriority, number>;
  queueTimeouts?: Record<TaskPriority, number>;
  timeouts?: Partial<LlmTimeouts>;
}

export function createRunTask(deps: LlmDeps): { runTask: RunTask; runs: RunRegistry } {
  const { runTask, runs } = createRunManager(deps);
  return { runTask, runs };
}
