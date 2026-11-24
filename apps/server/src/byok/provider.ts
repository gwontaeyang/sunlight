import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { Sqlite } from '../db/client';
import type { LlmAdapter, LlmEvent, LlmRunRequest } from '../llm/adapter';
import { EMPTY_USAGE } from '../llm/adapter';
import { guardedFetch } from '../security/network';
import type { LlmErrorCode } from '@study-paper/shared/contracts/tasks';
import { API_MODELS, MAX_OUTPUT, zeroCounts, type ApiModel, type Counts } from './prices';
import { markSent, reserve, settle } from './billing';
import { CredentialStore } from './credentials';

const ORIGIN = 'https://api.anthropic.com';
export type TestTransport = (url: string, init: RequestInit) => Promise<Response>;
export class ApiFailure extends Error {
  constructor(readonly code: LlmErrorCode) {
    super(code);
  }
}
function errorCode(e: unknown): LlmErrorCode {
  if (e instanceof ApiFailure) return e.code;
  if (e instanceof Anthropic.APIError) {
    if (e.status === 429) return 'rate_limited';
    if (e.status === 401 || e.status === 403) return 'api_auth';
  }
  return 'api_error';
}
function errorEvent(code: LlmErrorCode): LlmEvent {
  return { type: 'error', code, message: code, retryable: code === 'api_error' || code === 'rate_limited', partialText: '' };
}

export class ApiProvider {
  constructor(
    readonly sqlite: Sqlite,
    readonly credentials: CredentialStore,
    private readonly testTransport?: TestTransport,
  ) {}
  private client(callId: string, generation: string, model: ApiModel, kind: 'message' | 'check', signal: AbortSignal) {
    const credential = this.credentials.read();
    if (!credential?.key || credential.generation !== generation) throw new ApiFailure('api_key_missing');
    const key = credential.key;
    try {
      reserve(this.sqlite, callId, model, generation, kind);
    } catch (e) {
      if (e instanceof Error && e.message === 'budget_exhausted') throw new ApiFailure('budget_exhausted');
      throw e;
    }
    // The SDK reads custom headers from its environment. Construct the complete wire headers here.
    const method = kind === 'message' ? 'POST' : 'GET';
    const endpoint = ORIGIN + (kind === 'message' ? '/v1/messages' : '/v1/models/' + model);
    return new Anthropic({
      apiKey: key,
      baseURL: ORIGIN,
      authToken: null,
      webhookKey: null,
      maxRetries: 0,
      logLevel: 'off',
      logger: { error() {}, warn() {}, info() {}, debug() {} },
      openTelemetry: false,
      fetch: async (url, init) => {
        if (String(url) !== endpoint || init?.method?.toUpperCase() !== method) throw new ApiFailure('api_error');
        if (signal.aborted || this.credentials.status().generation !== generation) throw new ApiFailure('cancelled');
        const options: RequestInit = {
          method,
          body: init?.body,
          signal: init?.signal ?? signal,
          redirect: 'error',
          credentials: 'omit',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            accept: kind === 'message' ? 'text/event-stream' : 'application/json',
          },
        };
        const beforeSend = () => markSent(this.sqlite, callId);
        if (this.testTransport) {
          beforeSend();
          return this.testTransport(endpoint, options);
        }
        return guardedFetch(endpoint, options, beforeSend);
      },
    });
  }
  async check() {
    const id = randomUUID();
    const credential = this.credentials.status();
    if (!credential.keyConfigured || !credential.generation) return 'missing' as const;
    const controller = new AbortController();
    const remove = this.credentials.onChange(() => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    const model = API_MODELS.haiku;
    let complete = false;
    try {
      const client = this.client(id, credential.generation, model, 'check', signal);
      const result = await client.models.retrieve(model, {}, { signal });
      complete = result.id === model && !signal.aborted;
      return complete ? ('verified' as const) : ('unavailable' as const);
    } catch (e) {
      return errorCode(e) === 'api_auth' ? ('rejected' as const) : ('unavailable' as const);
    } finally {
      remove();
      settle(this.sqlite, id, model, null, complete);
    }
  }
  adapter(generation: string | null, model: ApiModel | null): LlmAdapter {
    return {
      mode: 'api',
      health: async () => ({ cliFound: false, cliVersion: null, loggedIn: null, detail: null }),
      run: (req) => this.events(req, generation, model),
    };
  }
  private async *events(req: LlmRunRequest, generation: string | null, model: ApiModel | null): AsyncGenerator<LlmEvent> {
    if (!generation || !model) {
      yield errorEvent(!model ? 'api_error' : 'api_key_missing');
      return;
    }
    const controller = new AbortController();
    let timedOut: LlmErrorCode = 'startup_timeout';
    let timer: NodeJS.Timeout;
    const arm = (ms: number, code: LlmErrorCode) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = code;
        controller.abort();
      }, ms);
      timer.unref();
    };
    arm(req.timeouts.startupMs, 'startup_timeout');
    const total = AbortSignal.timeout(req.timeouts.totalMs);
    const signal = AbortSignal.any([req.signal, total, controller.signal]);
    let counts: Counts | null = null;
    let tokenOutput = false,
      validInput = false,
      sawStop = false,
      reason: string | null = null;
    let text = '';
    const start = Date.now();
    let settled = false;
    try {
      if (req.jsonSchema && (req.task !== 'selection_questions' || req.prefix.length > 0)) throw new ApiFailure('api_error');
      const client = this.client(req.runId, generation, model, 'message', signal);
      const stream = await client.messages.create(
        {
          model,
          system: req.system,
          stream: true,
          service_tier: 'standard_only',
          inference_geo: 'global',
          max_tokens: MAX_OUTPUT,
          output_config: {
            effort: req.effort,
            ...(req.jsonSchema ? { format: { type: 'json_schema' as const, schema: { ...req.jsonSchema } } } : {}),
          },
          ...(req.effort === 'high' ? { thinking: { type: 'adaptive' as const } } : {}),
          messages: [{ role: 'user', content: [...req.prefix, ...req.tail] }],
        },
        { signal },
      );
      for await (const chunk of stream) {
        arm(req.timeouts.idleMs, 'idle_timeout');
        if (chunk.type === 'message_start') {
          if (counts || chunk.message.model !== model) throw new ApiFailure('api_error');
          const u = chunk.message.usage;
          if (u.service_tier && u.service_tier !== 'standard') throw new ApiFailure('api_error');
          if (u.inference_geo && u.inference_geo !== 'global') throw new ApiFailure('api_error');
          counts = zeroCounts();
          const inputOk = Number.isSafeInteger(u.input_tokens) && u.input_tokens >= 0;
          const cache = u.cache_creation;
          const creation = u.cache_creation_input_tokens ?? 0;
          counts.input = inputOk ? u.input_tokens : 0;
          counts.read = u.cache_read_input_tokens ?? 0;
          counts.write5 = cache?.ephemeral_5m_input_tokens ?? 0;
          counts.write60 = cache?.ephemeral_1h_input_tokens ?? 0;
          validInput = inputOk && counts.write5 + counts.write60 === creation;
          yield { type: 'started', modelResolved: model, cliVersion: 'anthropic-sdk/1.10.0' };
          yield { type: 'response_started', cacheReadTokens: counts.read, cacheCreationTokens: creation };
          arm(req.timeouts.firstContentMs, 'first_content_timeout');
        } else if (chunk.type === 'content_block_delta') {
          if (!counts) throw new ApiFailure('api_error');
          if (chunk.delta.type === 'text_delta') {
            text += chunk.delta.text;
            yield { type: 'text', delta: chunk.delta.text };
          } else if (chunk.delta.type === 'thinking_delta')
            yield { type: 'thinking', estimatedTokens: Math.ceil(chunk.delta.thinking.length / 4) };
        } else if (chunk.type === 'message_delta' && counts) {
          const u = chunk.usage;
          reason = chunk.delta.stop_reason;
          tokenOutput = Number.isSafeInteger(u.output_tokens) && u.output_tokens >= 0;
          if (tokenOutput) counts.output = u.output_tokens;
          if (u.input_tokens != null) counts.input = u.input_tokens;
          if (u.cache_read_input_tokens != null) counts.read = u.cache_read_input_tokens;
          if (u.cache_creation_input_tokens != null && u.cache_creation_input_tokens !== counts.write5 + counts.write60)
            validInput = false;
        } else if (chunk.type === 'message_stop') {
          sawStop = true;
          break;
        }
      }
      signal.throwIfAborted();
      if (!sawStop || !counts || !tokenOutput || !validInput || !reason) throw new ApiFailure('api_error');
      settle(this.sqlite, req.runId, model, counts, true);
      settled = true;
      if (reason !== 'end_turn' && reason !== 'stop_sequence')
        throw new ApiFailure(reason === 'max_tokens' ? 'api_truncated' : 'api_refused');
      yield {
        type: 'result',
        text,
        usage: {
          ...EMPTY_USAGE,
          inputTokens: counts.input,
          cacheReadTokens: counts.read,
          cacheCreationTokens: counts.write5 + counts.write60,
          outputTokens: counts.output,
          durationMs: Date.now() - start,
        },
      };
    } catch (e) {
      if (!settled) {
        settle(this.sqlite, req.runId, model, counts, false);
        settled = true;
      }
      yield errorEvent(
        req.signal.aborted ? 'cancelled' : total.aborted ? 'total_timeout' : controller.signal.aborted ? timedOut : errorCode(e),
      );
    } finally {
      clearTimeout(timer!);
      controller.abort();
      if (!settled) settle(this.sqlite, req.runId, model, counts, false);
    }
  }
}
