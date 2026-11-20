// LLM adapter interface (PLAN 2.4). Owner: supervisor — frozen; implementations: ClaudeCliAdapter (B, M1),
// MockLlmAdapter (SP_LLM=mock). Queueing lives outside the adapter (queue.ts, runManager.ts).
import type { LlmUsage, RateLimitInfo } from '@study-paper/shared/contracts/domain';
import type { Effort, LlmErrorCode, ModelAlias, TaskId } from '@study-paper/shared/contracts/tasks';

export type CacheControl = { type: 'ephemeral'; ttl: '1h' };
export type ContentBlock =
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };

export interface LlmTimeouts {
  /** spawn → system:init */
  startupMs: number;
  /** init → first response_started / thinking / text */
  firstContentMs: number;
  /** max gap between stdout events afterwards */
  idleMs: number;
  /** spawn → end */
  totalMs: number;
}

export interface LlmRunRequest {
  runId: string;
  task: TaskId;
  model: ModelAlias;
  effort: Effort;
  /** Constant for every task (cache prefix). */
  system: string;
  /** Cached prefix: [document, supplement text with cache_control] or []. */
  prefix: ContentBlock[];
  /** Variable part: [image?, text]. */
  tail: ContentBlock[];
  /** Allowed only when prefix is empty (pdf_metadata). */
  jsonSchema?: object;
  timeouts: LlmTimeouts;
  signal: AbortSignal;
}

export type LlmEvent =
  | { type: 'started'; modelResolved: string; cliVersion: string }
  | { type: 'response_started'; cacheReadTokens: number | null; cacheCreationTokens: number | null }
  | { type: 'thinking'; estimatedTokens: number }
  | { type: 'text'; delta: string }
  // M2 (PLAN_M2 D25, Codex M-R3-2): the CLI reported its rate-limit state. Not terminal, may come at any time before
  // the terminal event. liveLedger.watchLiveRun stops the ledger on a status other than 'allowed' (except an approved
  // 'allowed_warning', INTEGRATION_NOTES 결정 26); the run owner
  // ignores it (no SSE event, no run state change). MockLlmAdapter never emits it.
  | { type: 'rate_limit'; rateLimit: RateLimitInfo }
  | { type: 'result'; text: string; structured?: unknown; usage: LlmUsage; rateLimit?: RateLimitInfo } // terminal
  | { type: 'error'; code: LlmErrorCode; message: string; retryable: boolean; partialText: string }; // terminal

export interface LlmHealth {
  cliFound: boolean;
  cliVersion: string | null;
  /** null when not checked (the CLI has no cheap login probe). */
  loggedIn: boolean | null;
  detail: string | null;
}

export interface LlmAdapter {
  readonly mode: 'cli' | 'mock' | 'api';
  /** Yields events in order; exactly one terminal event (result | error) ends the iteration. */
  run(req: LlmRunRequest): AsyncIterable<LlmEvent>;
  health(): Promise<LlmHealth>;
}

export const EMPTY_USAGE: LlmUsage = {
  inputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  outputTokens: null,
  thinkingTokens: null,
  costUsdApiEquivEst: null,
  durationMs: null,
  durationApiMs: null,
};
