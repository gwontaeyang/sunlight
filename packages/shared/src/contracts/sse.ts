// SSE event contract (PLAN 2.3). Every LLM stream starts with run.accepted and ends with exactly one
// terminal event (run.done or run.error). Job streams end with job.done or job.error.
import { z } from 'zod';
import {
  CitationSchema,
  JobErrorCode,
  JobStepName,
  JobStepStatus,
  LlmUsageSchema,
  MessageStatsSchema,
  PaperReadiness,
  ParsedAnswerSchema,
  ParsedBlocksSchema,
  RateLimitInfoSchema,
} from './domain';
import { Effort, LlmErrorCode, ModelAlias, TaskId } from './tasks';

export const SSE_DATA_SCHEMAS = {
  'run.accepted': z.object({
    runId: z.string(),
    task: TaskId,
    threadId: z.string().optional(),
    messageId: z.string().optional(),
    artifactId: z.string().optional(),
  }),
  'run.queued': z.object({ position: z.number().int().nonnegative() }),
  'run.started': z.object({ model: ModelAlias, modelResolved: z.string(), effort: Effort, cliVersion: z.string() }),
  // null = the CLI did not report the value (never shown as 0).
  'run.response_started': z.object({ cacheReadTokens: z.number().int().nullable(), cacheCreationTokens: z.number().int().nullable() }),
  'run.thinking': z.object({ estimatedTokens: z.number().int() }),
  'run.delta': z.object({ text: z.string() }),
  // M2 (PLAN_M2 3.4): the SP-Blocks output failed validation and ONE repair request starts in the same run. errors
  // are formatBlockError lines only (fixed templates — never model text). The web clears the accumulated text.
  // Not terminal: the stream still ends with exactly one run.done | run.error.
  'run.retrying': z.object({ reason: z.literal('validation'), errors: z.array(z.string().max(200)).max(10) }),
  'run.done': z.object({
    text: z.string(),
    parsed: z.union([ParsedAnswerSchema, ParsedBlocksSchema]).nullable(),
    citations: z.array(CitationSchema),
    stats: MessageStatsSchema.nullable(),
    usage: LlmUsageSchema,
    rateLimit: RateLimitInfoSchema.optional(),
  }),
  'run.error': z.object({
    code: LlmErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    partialText: z.string().optional(),
  }),
  'job.step': z.object({ step: JobStepName, status: JobStepStatus, detail: z.string().optional() }),
  'job.state': z.object({ state: PaperReadiness }),
  'job.done': z.object({ paperId: z.string() }),
  'job.error': z.object({ code: JobErrorCode, message: z.string() }),
} as const;

export type SseEventName = keyof typeof SSE_DATA_SCHEMAS;
export type SseData<E extends SseEventName> = z.infer<(typeof SSE_DATA_SCHEMAS)[E]>;
export type SseEvent = { [E in SseEventName]: { event: E; data: SseData<E> } }[SseEventName];
export type RunSseEvent = Extract<SseEvent, { event: `run.${string}` }>;
export type JobSseEvent = Extract<SseEvent, { event: `job.${string}` }>;

export const RUN_TERMINAL_EVENTS = ['run.done', 'run.error'] as const satisfies readonly SseEventName[];
export const JOB_TERMINAL_EVENTS = ['job.done', 'job.error'] as const satisfies readonly SseEventName[];
export const SSE_EVENT_NAMES = Object.keys(SSE_DATA_SCHEMAS) as SseEventName[];

export function isSseEventName(name: string): name is SseEventName {
  return Object.prototype.hasOwnProperty.call(SSE_DATA_SCHEMAS, name);
}

/** Validates one received event (name + already JSON-parsed data). Throws on unknown names or bad data. */
export function parseSseEvent(name: string, data: unknown): SseEvent {
  if (!isSseEventName(name)) throw new Error(`unknown SSE event: ${name}`);
  const parsed = SSE_DATA_SCHEMAS[name].parse(data);
  return { event: name, data: parsed } as SseEvent;
}

/** Serialises one event in text/event-stream framing. data is a single JSON line (no embedded newlines). */
export function formatSseEvent(e: SseEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
