// LLM task ids and default specs (PLAN 2.4, 2.5). Owner: supervisor. Runtime overrides live in DB settings.
import { z } from 'zod';

export const TaskId = z.enum([
  'explain_selection',
  'chat',
  'translate_selection',
  'figure_area',
  'summary',
  'equation_deep',
  'notation_card',
  'assumptions_card',
  'glossary_define',
  'cards_from_highlights',
  'explain_back_grade',
  'study_path',
  'pdf_metadata',
]);
export type TaskId = z.infer<typeof TaskId>;

/** CLI model aliases. The resolved model id is reported by system:init and stored as modelResolved. */
export const ModelAlias = z.enum(['haiku', 'sonnet', 'opus', 'fable']);
export type ModelAlias = z.infer<typeof ModelAlias>;
export const Effort = z.enum(['low', 'medium', 'high']);
export type Effort = z.infer<typeof Effort>;

export const DEFAULT_PAPER_MODEL: ModelAlias = 'opus';
export const DEFAULT_DEEP_MODEL: ModelAlias = 'opus';
/** "절약 모드" switches every task to this model. */
export const ECONOMY_MODEL: ModelAlias = 'sonnet';

export type TaskContext = 'paper' | 'local' | 'none';
export type TaskOutput = 'sp-markup' | 'sp-blocks' | 'markdown' | 'json-schema';
/** Model role: resolved through settings (paperModel/deepModel) or a fixed alias. */
export type TaskModelRole = 'paperModel' | 'deepModel' | ModelAlias;
/** Queue lane (PLAN 2.4): interactive limit 2, background limit 1. */
export type TaskPriority = 'interactive' | 'background';

export interface TaskSpec {
  id: TaskId;
  context: TaskContext;
  model: TaskModelRole;
  effort: Effort;
  output: TaskOutput;
  cancelOnDisconnect: boolean;
  priority: TaskPriority;
  totalMs: number;
  milestone: 1 | 2 | 3 | 4;
  /** Effort for a request sent with `deep: true` ("깊게", PLAN_M2 3.7). Absent = the task does not support deep. */
  deepEffort?: Effort;
}

const s = 1000;
/**
 * Defaults from PLAN 2.5. `priority` is not in the plan table: S0 maps cancelOnDisconnect=false tasks
 * (generated artifacts that keep running without a viewer) to the background lane, the rest to interactive.
 */
export const TASK_SPECS: Record<TaskId, TaskSpec> = {
  explain_selection: { id: 'explain_selection', context: 'paper', model: 'paperModel', effort: 'low', output: 'sp-markup', cancelOnDisconnect: true, priority: 'interactive', totalMs: 120 * s, milestone: 1 },
  // M2 (PLAN_M2 D12): chat defaults to low; a question sent with deep:true runs at high.
  chat: { id: 'chat', context: 'paper', model: 'paperModel', effort: 'low', deepEffort: 'high', output: 'sp-markup', cancelOnDisconnect: true, priority: 'interactive', totalMs: 300 * s, milestone: 1 },
  translate_selection: { id: 'translate_selection', context: 'local', model: 'sonnet', effort: 'low', output: 'markdown', cancelOnDisconnect: true, priority: 'interactive', totalMs: 60 * s, milestone: 2 },
  figure_area: { id: 'figure_area', context: 'paper', model: 'paperModel', effort: 'medium', output: 'sp-markup', cancelOnDisconnect: true, priority: 'interactive', totalMs: 180 * s, milestone: 2 },
  summary: { id: 'summary', context: 'paper', model: 'paperModel', effort: 'medium', output: 'sp-markup', cancelOnDisconnect: false, priority: 'background', totalMs: 300 * s, milestone: 2 },
  equation_deep: { id: 'equation_deep', context: 'paper', model: 'deepModel', effort: 'high', output: 'sp-markup', cancelOnDisconnect: true, priority: 'interactive', totalMs: 600 * s, milestone: 2 },
  notation_card: { id: 'notation_card', context: 'paper', model: 'deepModel', effort: 'high', output: 'sp-blocks', cancelOnDisconnect: false, priority: 'background', totalMs: 600 * s, milestone: 2 },
  assumptions_card: { id: 'assumptions_card', context: 'paper', model: 'deepModel', effort: 'high', output: 'sp-blocks', cancelOnDisconnect: false, priority: 'background', totalMs: 600 * s, milestone: 2 },
  glossary_define: { id: 'glossary_define', context: 'paper', model: 'paperModel', effort: 'low', output: 'sp-blocks', cancelOnDisconnect: true, priority: 'interactive', totalMs: 120 * s, milestone: 2 },
  cards_from_highlights: { id: 'cards_from_highlights', context: 'paper', model: 'paperModel', effort: 'high', output: 'sp-blocks', cancelOnDisconnect: false, priority: 'background', totalMs: 300 * s, milestone: 4 },
  explain_back_grade: { id: 'explain_back_grade', context: 'paper', model: 'deepModel', effort: 'high', output: 'sp-blocks', cancelOnDisconnect: true, priority: 'interactive', totalMs: 600 * s, milestone: 4 },
  study_path: { id: 'study_path', context: 'paper', model: 'deepModel', effort: 'high', output: 'sp-markup', cancelOnDisconnect: false, priority: 'background', totalMs: 600 * s, milestone: 3 },
  pdf_metadata: { id: 'pdf_metadata', context: 'none', model: 'haiku', effort: 'low', output: 'json-schema', cancelOnDisconnect: false, priority: 'background', totalMs: 60 * s, milestone: 4 },
};

/** Model alias of a task (settings arrive in M3). The one place a task's model is resolved (PLAN_M2 D12). */
export function resolveModel(task: TaskId): ModelAlias {
  const m = TASK_SPECS[task].model;
  return m === 'paperModel' ? DEFAULT_PAPER_MODEL : m === 'deepModel' ? DEFAULT_DEEP_MODEL : m;
}

/** Whether a task accepts `deep: true` (PLAN_M2 3.7). Requests for other tasks with deep:true are a 400. */
export function supportsDeep(task: TaskId): boolean {
  return TASK_SPECS[task].deepEffort !== undefined;
}

/**
 * Effort of a run. The ONE place it is decided (llm_calls.effort, adapter request, run.started all use this value —
 * PLAN_M2 D12). `deep` only changes the effort of a task that has `deepEffort`; callers reject deep for the others.
 */
export function resolveEffort(task: TaskId, opts?: { deep?: boolean }): Effort {
  const spec = TASK_SPECS[task];
  return opts?.deep === true && spec.deepEffort !== undefined ? spec.deepEffort : spec.effort;
}

/**
 * Upper bound of the minimum time left in a run's totalMs for an SP-Blocks repair request to start (PLAN_M2 3.4).
 * totalMs covers the whole run once (first call + repair). Since v3.6 the per-task minimum is
 * `repairMinRemainingMs(task)` (this value or half the task's totalMs, whichever is smaller); use that function,
 * not this constant, to decide whether a repair starts.
 */
export const REPAIR_MIN_REMAINING_MS = 120_000;

/**
 * Minimum time left in a run's totalMs for an SP-Blocks repair request to start (PLAN_M2 3.4, 9절 40 — S-1):
 * min(REPAIR_MIN_REMAINING_MS, floor(totalMs / 2)). With less than this left after the first call the run ends as
 * parse_failed without a repair. The halving keeps a repair reachable on a real clock for short tasks
 * (`glossary_define`: totalMs 120 s → 60 s); long tasks keep the 120 s bound.
 */
export function repairMinRemainingMs(task: TaskId): number {
  return Math.min(REPAIR_MIN_REMAINING_MS, Math.floor(TASK_SPECS[task].totalMs / 2));
}

/** Per-phase timeouts (PLAN 2.4). totalMs comes from the task spec. */
export const DEFAULT_TIMEOUTS = { startupMs: 15 * s, firstContentMs: 90 * s, idleMs: 90 * s } as const;
/** Queue wait limits (PLAN 2.4). */
export const QUEUE_TIMEOUT_MS: Record<TaskPriority, number> = { interactive: 60 * s, background: 900 * s };
export const DEFAULT_CONCURRENCY: Record<TaskPriority, number> = { interactive: 2, background: 1 };
/** Claude Code version the CLI adapter was verified against (PLAN 11 R10). */
export const VERIFIED_CLI_VERSION = '2.1.325';

/** run.error codes (PLAN 2.3). */
export const LlmErrorCode = z.enum([
  'cancelled',
  'queue_timeout',
  'startup_timeout',
  'first_content_timeout',
  'idle_timeout',
  'total_timeout',
  'rate_limited',
  'api_auth',
  'api_error',
  'api_key_missing',
  'api_truncated',
  'api_refused',
  'cli_missing',
  'cli_error',
  'unsafe_cli_state',
  'too_large',
  'context_not_ready',
  'parse_failed',
  // The answer arrived but its result (message, citations, llm_calls) could not be stored or processed; the run
  // never emits run.done in that case. partialText carries the unsaved answer text. (M1.1, review B3)
  'persist_failed',
  // Replay of a request whose answer was later replaced by a successful "다시 생성" (the old message is gone).
  // Terminal and not retryable; the thread holds the new answer. (M1.2, review N4)
  'superseded',
  // M2 (PLAN_M2 3.4 rule 1): replay of a request whose result no longer exists — the owner row (message, card) was
  // deleted, the paper was deleted or is being deleted (tombstone), or a stored suggestion expired. Also a LIVE
  // terminal (PLAN_M2 9절 56 · 57 · 60): a running run whose owner row went (or whose paper was tombstoned) before its
  // result was stored ends run.error{result_deleted} (llm_calls `cancelled`), and a same-id request for a running run
  // whose paper is tombstoned or whose owner row is gone answers run.accepted + run.error{result_deleted} without its
  // log. A run cancelled first (runs.cancel, the paper deletion's cancel) ends `cancelled` instead. Terminal, not
  // retryable.
  'result_deleted',
  // M2 (PLAN_M2 D25): the live ledger refused the reservation (STOP, per-model or total cap, missing caps). No child
  // process was started. Not retryable.
  'budget_exhausted',
  // M2 (PLAN_M2 D25): the live ledger lock could not be taken within LEDGER_LOCK_WAIT_MS. No child was started and
  // nothing was reserved — kept apart from budget_exhausted so a busy/stuck lock does not look like a spent budget.
  'ledger_locked',
]);
export type LlmErrorCode = z.infer<typeof LlmErrorCode>;
