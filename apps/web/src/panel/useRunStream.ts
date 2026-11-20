// React hook over streamRoute for LLM runs (PLAN 2.3, PLAN_M2 3.4·3.7). Owner D.
// M2: also card generation and glossary definition streams; run.started.effort and run.retrying (the text is cleared)
// are kept in the state.
// - run.accepted stores runId / threadId / messageId; the stream contract itself is checked by streamRoute.
// - Every new request gets clientRequestId = crypto.randomUUID(); retry() re-sends the same request with the SAME
//   id, so the server attaches to the existing run (replay) instead of starting a second one.
// - cancel() asks the server (llm.runs.cancel, also while queued) and the stream then ends with run.error
//   {code:'cancelled'}; abort() only closes the connection (AbortController). Unmount aborts.
// - A connection cut abnormally after the response started (the body read rejects) is 'stream_interrupted' like a clean
//   EOF without a terminal event; once this stream's run.done / run.error is applied, a later transport error or abort
//   does not overwrite that state (review D-I10-01).
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ApiBody, ApiParams, CreateThreadRequest, PostMessageRequest } from '@study-paper/shared/contracts/api';
import { parseConflictDetails } from '@study-paper/shared/contracts/errors';
import type { RunSseEvent, SseData, SseEvent } from '@study-paper/shared/contracts/sse';
import type { Effort, LlmErrorCode } from '@study-paper/shared/contracts/tasks';
import { api, ApiError, type ApiClient } from '../api/client';
import { streamRoute } from '../api/sse';

export type RunRequest =
  | { route: 'threads.create'; params: ApiParams<'threads.create'>; body: Omit<CreateThreadRequest, 'clientRequestId'> }
  | { route: 'messages.create'; params: ApiParams<'messages.create'>; body: Omit<PostMessageRequest, 'clientRequestId'> }
  // M2: card generation (background run, survives the tab) and a glossary definition request.
  | { route: 'studyPath.generate'; params: ApiParams<'studyPath.generate'>; body: Omit<ApiBody<'studyPath.generate'>, 'clientRequestId'> }
  | { route: 'cards.generate'; params: ApiParams<'cards.generate'>; body: Record<string, never> }
  | { route: 'glossary.define'; params: ApiParams<'glossary.define'>; body: Omit<ApiBody<'glossary.define'>, 'clientRequestId'> };

export type RunPhase = 'idle' | 'starting' | 'accepted' | 'queued' | 'running' | 'done' | 'error';

export interface RunStreamError {
  /** LlmErrorCode for run.error, ApiError code otherwise ('aborted' for a connection closed by us). */
  code: string;
  /** Korean text for the UI. */
  message: string;
  retryable: boolean;
  source: 'run' | 'http' | 'stream' | 'aborted';
  detail?: string;
  /** ApiError.details of an HTTP error (e.g. the ConflictDetails of a 409). */
  details?: unknown;
}

export interface RunStreamState {
  phase: RunPhase;
  runId: string | null;
  threadId: string | null;
  messageId: string | null;
  /** Raw model text so far (run.delta), or the final / partial text after the terminal event. */
  text: string;
  queuedPosition: number | null;
  thinkingTokens: number | null;
  cacheRead: number | null;
  cancelling: boolean;
  clientRequestId: string | null;
  request: RunRequest | null;
  /** Date.now() when the current request was sent (elapsed time while waiting for the first text). */
  requestedAt: number | null;
  /** Event names received on the current stream, in order (shown small under the live message). */
  events: string[];
  /** M2: run.started.effort ('high' = a "깊게" question). */
  effort: Effort | null;
  /** M2: run.accepted.artifactId (cards: the card id). */
  artifactId: string | null;
  /** M2: a run.retrying arrived (SP-Blocks repair request in progress); the accumulated text was cleared. */
  retrying: boolean;
  done?: SseData<'run.done'>;
  error?: RunStreamError;
}

export const IDLE_RUN: RunStreamState = {
  phase: 'idle',
  runId: null,
  threadId: null,
  messageId: null,
  text: '',
  queuedPosition: null,
  thinkingTokens: null,
  cacheRead: null,
  cancelling: false,
  clientRequestId: null,
  request: null,
  requestedAt: null,
  events: [],
  effort: null,
  artifactId: null,
  retrying: false,
};

export const isActive = (s: RunStreamState) => s.phase === 'starting' || s.phase === 'accepted' || s.phase === 'queued' || s.phase === 'running';

const RUN_ERROR_TEXT: Record<LlmErrorCode, string> = {
  cancelled: '취소했습니다',
  queue_timeout: '대기 시간이 너무 길어 중단했습니다',
  startup_timeout: 'Claude CLI가 시간 안에 시작하지 않았습니다',
  first_content_timeout: '첫 응답이 시간 안에 오지 않았습니다',
  idle_timeout: '응답이 한동안 멈춰 중단했습니다',
  total_timeout: '전체 시간 한도를 넘어 중단했습니다',
  rate_limited: '사용 한도에 도달했습니다. 잠시 뒤 다시 시도하세요',
  api_auth: 'API key 인증에 실패했습니다. 설정에서 키를 확인하세요',
  api_error: 'Anthropic 요청을 마치지 못했습니다',
  api_key_missing: '설정에서 API key를 등록하세요',
  api_truncated: '출력 한도에 도달했습니다',
  api_refused: '공급자가 이 요청을 완료하지 않았습니다',
  cli_missing: '설정에서 API key를 등록하거나 Claude Code를 설치하세요',
  cli_error: 'Claude CLI 실행 중 오류가 났습니다',
  unsafe_cli_state: 'CLI 상태가 안전하지 않아 실행하지 않았습니다',
  too_large: '논문이 너무 커서 처리할 수 없습니다',
  context_not_ready: '색인 준비 중입니다. 잠시 뒤 다시 시도하세요',
  parse_failed: '답을 해석하지 못했습니다',
  persist_failed: '답변을 받았지만 저장하지 못했습니다 — 아래 글은 저장되지 않은 답변입니다',
  superseded: '이 답변은 다시 생성되어 교체되었습니다 — thread를 다시 열어 새 답변을 확인하세요',
  // M2 codes (contracts/tasks.ts) — minimal entries so the Record compiles; wording is D's to refine.
  result_deleted: '이 요청의 결과가 더 이상 없습니다(삭제되었거나 보관 기간이 지남)',
  budget_exhausted: '호출 예산을 다 써서 실행하지 않았습니다',
  ledger_locked: '호출 기록이 잠겨 있어 실행하지 않았습니다',
};

export function runErrorText(code: string): string {
  return (RUN_ERROR_TEXT as Record<string, string>)[code] ?? '오류가 났습니다';
}

/**
 * What happens to the run after the connection is gone, by route: a thread answer is stored in the thread; a card
 * keeps generating on the server (cancelOnDisconnect=false) and the tab shows it when done; a glossary definition
 * request is cancelled by the server (cancelOnDisconnect=true) — "다시 연결" re-attaches with the same request ID.
 */
const AFTER_DISCONNECT: Record<RunRequest['route'], string> = {
  'threads.create': '결과는 thread를 다시 열어 확인하세요',
  'messages.create': '결과는 thread를 다시 열어 확인하세요',
  'studyPath.generate': '학습 흐름을 다시 열면 같은 생성 요청에 연결할 수 있습니다',
  'cards.generate': '생성은 서버에서 계속되고 끝나면 여기에 표시됩니다',
  'glossary.define': '서버가 이 요청을 취소했을 수 있습니다(다시 요청하세요)',
};

/** Maps a thrown error of streamRoute / fetch to the UI error (`route` picks the disconnect wording; default: thread). */
export function toRunError(err: unknown, aborted: boolean, route: RunRequest['route'] = 'messages.create'): RunStreamError {
  const after = AFTER_DISCONNECT[route];
  if (aborted || (err instanceof Error && err.name === 'AbortError')) {
    return { code: 'aborted', message: `연결을 닫았습니다 — ${after}`, retryable: true, source: 'aborted' };
  }
  if (err instanceof ApiError) {
    const detail = err.message;
    switch (err.code) {
      case 'context_not_ready':
        return { code: err.code, message: '색인 준비 중입니다. 잠시 뒤 다시 시도하세요', retryable: true, source: 'http', detail };
      case 'stream_interrupted':
        return { code: err.code, message: `연결이 끊겼습니다 — ${after}`, retryable: true, source: 'stream', detail };
      case 'bad_stream':
      case 'bad_response':
        return { code: err.code, message: '서버 응답 형식이 올바르지 않습니다', retryable: true, source: 'stream', detail };
      case 'network':
        return { code: err.code, message: '서버에 연결할 수 없습니다', retryable: true, source: 'http', detail };
      case 'not_implemented':
        return { code: err.code, message: '아직 서버에 구현되지 않은 기능입니다', retryable: false, source: 'http', detail };
      case 'conflict': {
        const c = parseConflictDetails(err.details);
        if (c?.reason === 'payload_version') {
          return { code: 'payload_version', message: '서버가 업데이트되어 이전 요청에 다시 연결할 수 없습니다 — thread를 다시 열어 결과를 확인하세요', retryable: false, source: 'http', detail, details: err.details };
        }
        if (route === 'studyPath.generate') return { code: err.code, message: '학습 흐름의 저장 상태가 바뀌었습니다. 최신 결과나 진행 중인 요청을 확인하세요.', retryable: false, source: 'http' };
        // M2 (D22): a card of this kind is already being generated by another request — not an error for the user.
        if (c?.reason === 'card_generating') return { code: 'card_generating', message: '이미 생성 중입니다', retryable: false, source: 'http', detail, details: err.details };
        return { code: err.code, message: '같은 요청 ID로 다른 요청이 이미 처리되었습니다', retryable: false, source: 'http', detail, details: err.details };
      }
      case 'unauthorized':
        return { code: err.code, message: '서버가 다시 시작되었습니다. 페이지를 새로고침하세요', retryable: false, source: 'http', detail };
      case 'payload_too_large':
        return { code: err.code, message: '선택하거나 입력한 글이 너무 깁니다', retryable: false, source: 'http', detail };
      default:
        return { code: err.code, message: `요청이 실패했습니다 (${err.status || err.code})`, retryable: true, source: 'http', detail };
    }
  }
  return { code: 'unknown', message: '알 수 없는 오류가 났습니다', retryable: true, source: 'http', detail: String(err) };
}

/**
 * Review D-I10-01: what a thrown error of streamRoute means. Everything streamRoute checks is an ApiError, the api
 * client turns a failed fetch into ApiError 'network', and an abort is an AbortError — so any other error thrown AFTER
 * the response started (`responseStarted`: client.request resolved) came from reading the response body (reader.read()
 * rejects, typically with a TypeError, on a reset connection or an incomplete chunked body). That is a dropped
 * connection exactly like a clean EOF without a terminal event: ApiError 'stream_interrupted', so the consumers'
 * reconnect paths (same clientRequestId) apply. Review D-FX2R1-02: a non-ApiError before the response started is a
 * code error, not a cut — it stays as it is ('unknown'), as does an error the consumer's own onEvent threw (never
 * re-sent as a dropped connection). api/sse.ts is not changed.
 */
export function classifyStreamError(err: unknown, consumerError: unknown = null, responseStarted = true): unknown {
  if (err instanceof ApiError) return err;
  if ((err as { name?: unknown } | null)?.name === 'AbortError') return err;
  if (consumerError !== null && err === consumerError) return err;
  if (!responseStarted) return err;
  return new ApiError(0, 'stream_interrupted', `the response body could not be read: ${String(err)}`);
}

/** Pure reducer for one run event (exported for tests). */
export function applyRunEvent(prev: RunStreamState, e: RunSseEvent): RunStreamState {
  const s = { ...prev, events: [...prev.events, e.event] };
  switch (e.event) {
    case 'run.accepted':
      return { ...s, phase: 'accepted', runId: e.data.runId, threadId: e.data.threadId ?? s.threadId, messageId: e.data.messageId ?? s.messageId, artifactId: e.data.artifactId ?? s.artifactId };
    case 'run.queued':
      return { ...s, phase: 'queued', queuedPosition: e.data.position };
    case 'run.started':
      return { ...s, phase: 'running', queuedPosition: null, effort: e.data.effort };
    case 'run.response_started':
      return { ...s, phase: 'running', queuedPosition: null, cacheRead: e.data.cacheReadTokens };
    case 'run.thinking':
      return { ...s, phase: 'running', queuedPosition: null, thinkingTokens: e.data.estimatedTokens };
    case 'run.delta':
      return { ...s, phase: 'running', queuedPosition: null, text: s.text + e.data.text };
    case 'run.retrying':
      // M2 contract (sse.ts): one SP-Blocks repair request starts — the accumulated text is discarded.
      return { ...s, phase: 'running', queuedPosition: null, text: '', retrying: true };
    case 'run.done':
      return { ...s, phase: 'done', queuedPosition: null, cancelling: false, text: e.data.text, done: e.data };
    case 'run.error':
      return {
        ...s,
        phase: 'error',
        queuedPosition: null,
        cancelling: false,
        text: e.data.partialText ?? s.text,
        error: { code: e.data.code, message: runErrorText(e.data.code), retryable: e.data.retryable, source: 'run', detail: e.data.message },
      };
  }
}

export interface UseRunStreamOptions {
  client?: ApiClient;
  /** After the stream ended (terminal event, error or abort) — e.g. invalidate queries. */
  onSettled?: (s: RunStreamState) => void;
  /** Every validated event (after the state update). */
  onEvent?: (e: SseEvent, s: RunStreamState) => void;
}

export function useRunStream(opts: UseRunStreamOptions = {}) {
  const client = opts.client ?? api;
  const stateRef = useRef<RunStreamState>(IDLE_RUN);
  const ctrlRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  const set = useCallback((s: RunStreamState) => {
    stateRef.current = s;
    rerender();
  }, []);

  const send = useCallback(
    async (request: RunRequest, clientRequestId: string) => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      const gen = ++genRef.current;
      set({ ...IDLE_RUN, phase: 'starting', request, clientRequestId, requestedAt: Date.now() });
      // Review D-I10-01: whether the terminal event of THIS stream was applied, and what a consumer's onEvent threw (a
      // bug in the page, not a dropped connection). Review D-FX2R1-02: whether the response started (client.request
      // resolved) — only then can a non-ApiError be a cut body read.
      let terminalSeen = false;
      let consumerError: unknown = null;
      let responseStarted = false;
      const tracked: ApiClient = {
        ...client,
        request: async (...args: Parameters<ApiClient['request']>) => {
          const res = await client.request(...args);
          responseStarted = true;
          return res;
        },
      } as ApiClient;
      try {
        await streamRoute(request.route, {
          client: tracked,
          params: request.params,
          body: { ...request.body, clientRequestId } as never,
          signal: ctrl.signal,
          onEvent: (e) => {
            if (gen !== genRef.current || !e.event.startsWith('run.')) return;
            set(applyRunEvent(stateRef.current, e as RunSseEvent));
            if (e.event === 'run.done' || e.event === 'run.error') terminalSeen = true;
            try {
              optsRef.current.onEvent?.(e, stateRef.current);
            } catch (thrown) {
              consumerError = thrown;
              throw thrown;
            }
          },
        });
      } catch (err) {
        if (gen !== genRef.current) return;
        // A consumer's exception is a bug in the page: keep its stack in the console, whatever event threw it.
        if (consumerError !== null && err === consumerError) console.error('useRunStream: onEvent threw', err);
        // A terminal event already decided this request: a transport error or our own abort after it (before EOF)
        // changes nothing. A contract error (ApiError bad_stream — an event after the terminal) still replaces it, and
        // so does the consumer's own exception at the terminal event ('unknown', as at any other event — review
        // D-FX2R1-02: never swallowed).
        if (terminalSeen && !(err instanceof ApiError) && !(consumerError !== null && err === consumerError)) return;
        set({ ...stateRef.current, phase: 'error', cancelling: false, queuedPosition: null, error: toRunError(classifyStreamError(err, consumerError, responseStarted), ctrl.signal.aborted, request.route) });
      } finally {
        if (gen === genRef.current) {
          ctrlRef.current = null;
          optsRef.current.onSettled?.(stateRef.current);
        }
      }
    },
    [client, set],
  );

  /** New request: a fresh clientRequestId. */
  const start = useCallback((request: RunRequest) => send(request, crypto.randomUUID()), [send]);

  /** Same request again with the same clientRequestId (attaches to the server's run). */
  const retry = useCallback(() => {
    const { request, clientRequestId } = stateRef.current;
    if (request && clientRequestId) return send(request, clientRequestId);
    return Promise.resolve();
  }, [send]);

  /** Closes the connection (the server cancels interactive runs on disconnect). */
  const abort = useCallback(() => ctrlRef.current?.abort(), []);

  /** Server-side cancel (works while queued). Before run.accepted there is no runId: close the connection. */
  const cancel = useCallback(async () => {
    const s = stateRef.current;
    if (!isActive(s)) return;
    if (!s.runId) {
      abort();
      return;
    }
    set({ ...s, cancelling: true });
    try {
      await client.call('llm.runs.cancel', { params: { runId: s.runId } });
    } catch {
      // Cancel route failed (e.g. not implemented yet): closing the connection still cancels the run.
      if (stateRef.current.runId === s.runId && isActive(stateRef.current)) abort();
    }
  }, [abort, client, set]);

  const reset = useCallback(() => {
    ctrlRef.current?.abort();
    genRef.current++;
    ctrlRef.current = null;
    set(IDLE_RUN);
  }, [set]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  return { state: stateRef.current, start, attach: send, retry, cancel, abort, reset };
}
