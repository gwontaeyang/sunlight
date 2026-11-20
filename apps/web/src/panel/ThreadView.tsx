// One AI thread (PLAN 8.3, PLAN_M2 3.5–3.7): stored messages (threads.get), the live streaming message, cancel / retry,
// regenerate and the follow-up input. Owner D.
// M2: thread kinds translate (plain display, no follow-up input, "다시 생성" only), figure / equation (capture image or
// the equation's LaTeX on top), the "깊게" toggle on every input whose server task is chat, "깊게" on high-effort chat
// answers, run.retrying. Stored content is drawn through pairStored → StoredMarkup (one pairing per message).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MessageDto, ThreadDto } from '@study-paper/shared/contracts/api';
import type { Anchor, Citation, ParsedAnswer, ThreadKind } from '@study-paper/shared/contracts/domain';
import { equationById } from '../api/structure';
import { qk } from '../api/queryKeys';
import { StructureContext, type JumpResult } from '../markdown/chips';
import { LatexView } from '../markdown/latex';
import { pairStored, StoredMarkup, useStoredPair } from '../markdown/renderStored';
import type { SpPhase } from '../markdown/SpMarkdown';
import { useReaderStore } from '../state/readerStore';
import { usePanelApi } from './panelApi';
import { isActive, type RunRequest, type RunStreamState, type useRunStream } from './useRunStream';

export type RunStreamApi = ReturnType<typeof useRunStream>;

export const THREAD_KIND_TEXT: Record<ThreadKind, string> = { explain: '설명', translate: '번역', figure: '그림', equation: '수식', chat: '질문' };

const MESSAGE_STATUS_TEXT: Partial<Record<MessageDto['status'], string>> = {
  error: '오류로 끝난 답변입니다',
  cancelled: '취소된 답변입니다',
  interrupted: '서버가 다시 시작되어 중단된 답변입니다',
};

export const DEEP_TOOLTIP = '더 오래 생각한 뒤 답합니다(첫 글자까지 수십 초)';

/** Selected text as shown (whitespace and line breaks collapsed to one space; the stored value is unchanged). */
export const collapseSpaces = (t: string) => t.replace(/\s+/g, ' ').trim();

/**
 * The server task of the assistant answer at `index` (0 = the thread's first answer) in a thread of `kind`. Only
 * explain_selection / chat answers may offer <glossary> suggestions as "AI 제안" (PLAN_M2 3.4 rule 6), and "깊게" applies
 * to chat only (3.7). The first answer of a figure / equation thread is figure_area / equation_deep (also after
 * "다시 생성"); a translation is translate_selection.
 */
export function answerTask(kind: ThreadKind | undefined, index: number): 'chat' | 'explain_selection' | 'other' {
  if (kind === 'chat') return 'chat';
  if (kind === 'explain') return index === 0 ? 'explain_selection' : 'chat';
  if (kind === 'figure' || kind === 'equation') return index === 0 ? 'other' : 'chat';
  return 'other';
}

function useJump() {
  const jumpToCitation = useReaderStore((s) => s.jumpToCitation);
  return useMemo(() => (c: Citation): Promise<JumpResult> => jumpToCitation(c), [jumpToCitation]);
}

function messagePhase(m: MessageDto): SpPhase {
  return m.status === 'complete' ? 'final' : m.status === 'streaming' ? 'streaming' : 'failed';
}

function DeepLabel() {
  return (
    <span data-testid="pn-deep-label" className="mb-1 inline-block rounded border border-indigo-300 bg-indigo-50 px-1 text-sl-label text-indigo-800" title="깊게 생각한 답입니다">
      깊게
    </span>
  );
}

export type AnswerFooter = (parsed: ParsedAnswer) => ReactNode;

interface AssistantMessageProps {
  m: MessageDto;
  onRefresh: () => void;
  beingReplaced?: boolean;
  plain?: boolean;
  /** The answer's server task is chat: "깊게" is shown when its effort is high. */
  chatTask?: boolean;
  /** Rendered under a complete answer (e.g. glossary suggestions), from the parser output of THIS answer. */
  footer?: AnswerFooter;
}

function AssistantMessage({ m, onRefresh, beingReplaced = false, plain = false, chatTask = false, footer }: AssistantMessageProps) {
  const onJump = useJump();
  // contentMd is the raw SP-Markup text; display and block membership come from the parser, paired ONCE with the
  // stored citations (PLAN_M2 3.4 rule 5). A translation is plain (no chips, no badges).
  const pair = useStoredPair(m.contentMd, m.citations, { mode: plain ? 'plain' : 'markup' });
  const statusText = MESSAGE_STATUS_TEXT[m.status];
  return (
    <div data-testid="message-assistant" data-status={m.status} data-being-replaced={beingReplaced ? '1' : undefined} className={`rounded border border-gray-200 bg-white p-2${beingReplaced ? ' border-dashed' : ''}`}>
      {beingReplaced && (
        <div data-testid="message-being-replaced" className="mb-1 text-xs text-gray-500">
          이전 답변 · 새 답변이 저장되면 바뀝니다 (실패하거나 취소하면 그대로 남습니다)
        </div>
      )}
      {chatTask && m.effort === 'high' && <DeepLabel />}
      {statusText && <div className="mb-1 text-xs text-amber-700">{statusText}</div>}
      {m.status === 'streaming' && (
        <div className="mb-1 flex items-center gap-2 text-xs text-gray-500">
          다른 연결에서 생성 중인 답변입니다.
          <button type="button" className="rounded border px-1" onClick={onRefresh}>
            다시 읽기
          </button>
        </div>
      )}
      <StoredMarkup parsed={pair.parsed} paired={pair.paired} stats={m.stats} phase={messagePhase(m)} onCitationClick={onJump} />
      {m.status === 'complete' && footer?.(pair.parsed)}
    </div>
  );
}

function UserMessage({ m, label, selection = false }: { m: MessageDto; label: string; selection?: boolean }) {
  return (
    <div data-testid="message-user" className="rounded bg-blue-50 p-2 text-sm">
      <div className="text-sl-label text-blue-700">{label}</div>
      <div className={selection ? 'break-words' : 'whitespace-pre-wrap break-words'}>{selection ? collapseSpaces(m.contentMd) : m.contentMd}</div>
    </div>
  );
}

/** Seconds since the request was sent, ticking once a second while `tick` is true. */
function useElapsedSeconds(since: number | null, tick: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!tick) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [tick, since]);
  return since === null ? null : Math.max(0, Math.floor((now - since) / 1000));
}

/** Waiting for the first text after the CLI started: the model is thinking (can take tens of seconds). */
export const isThinking = (s: RunStreamState) => s.phase === 'running' && s.text === '';

export function runStatusText(s: RunStreamState, elapsedSec: number | null = null): string | null {
  const secs = elapsedSec !== null ? ` · ${elapsedSec}초` : '';
  switch (s.phase) {
    case 'starting':
      return '요청을 보내는 중…';
    case 'accepted':
      return '접수됨 · 시작 대기';
    case 'queued':
      return `대기 중 · 순번 ${s.queuedPosition ?? '?'}`;
    case 'running':
      if (s.retrying && s.text === '') return `형식 오류로 다시 요청 중…${secs}`;
      if (isThinking(s)) return `생각 중…${secs}${s.thinkingTokens !== null ? ` · 약 ${s.thinkingTokens.toLocaleString()} tokens` : ''} — 첫 글자까지 수십 초 걸릴 수 있습니다`;
      return s.thinkingTokens !== null ? `답변 생성 중 · 생각 약 ${s.thinkingTokens.toLocaleString()} tokens` : '답변 생성 중';
    default:
      return null;
  }
}

/** true when the run is a "다시 생성" (messages.create {regenerate:true}). */
export const isRegenerate = (s: RunStreamState) => s.request?.route === 'messages.create' && s.request.body.regenerate === true;

/**
 * The turn a "다시 생성" replaces, pinned by id when the button is pressed (keyed by the run's request object, which
 * retry() re-sends unchanged, so it survives a remount of the view). Positions are not used: after a successful
 * regenerate the server deletes the old turn and the new answer is the live message, so "the last stored answer"
 * would point at the turn before it.
 */
export interface RegenTarget {
  assistantId: string;
  userId: string | null;
  /** Position of the replaced answer among the thread's answers (0 = first): decides its server task. */
  index: number;
}
const regenTargets = new WeakMap<RunRequest, RegenTarget>();

/** The pinned target of the live regenerate run (null for any other run). */
export const regenTargetOf = (s: RunStreamState): RegenTarget | null => (s.request && isRegenerate(s) ? (regenTargets.get(s.request) ?? null) : null);

export interface LiveMessageProps {
  run: RunStreamApi;
  onReopen?: () => void;
  plain?: boolean;
  footer?: AnswerFooter;
  /** The live answer's server task is chat: "깊게" is shown when run.started.effort is high (also for "다시 생성"). */
  chatTask?: boolean;
}

export function LiveMessage({ run, onReopen, plain = false, footer, chatTask = false }: LiveMessageProps) {
  const s = run.state;
  const onJump = useJump();
  // One parse (and, when done, one pairing with run.done.citations) for the live text.
  const pair = useMemo(() => {
    const mode = plain ? ('plain' as const) : ('markup' as const);
    if (s.phase === 'done' && s.done) return pairStored(s.done.text, s.done.citations, { mode });
    // Streaming: parser output with final:false (partial tags held back by the parser); failed: final text rules.
    return { parsed: pairStored(s.text, [], { mode, final: s.phase === 'error' }).parsed, paired: new Map<number, Citation>() };
  }, [s, plain]);
  const active = isActive(s);
  const waiting = isThinking(s);
  const elapsed = useElapsedSeconds(s.requestedAt, waiting);
  const phase: SpPhase = s.phase === 'done' ? 'final' : s.phase === 'error' ? 'failed' : 'streaming';
  const status = runStatusText(s, waiting ? elapsed : null);
  const err = s.error;
  const regen = isRegenerate(s);
  return (
    <div data-testid="live-message" data-phase={s.phase} data-thinking={isThinking(s) ? '1' : undefined} className="rounded border border-blue-200 bg-white p-2">
      {regen && <div className="mb-1 text-sl-label text-blue-700">다시 생성한 답변</div>}
      {s.effort === 'high' && chatTask && <DeepLabel />}
      {status && (
        <div data-testid="run-status" className="mb-1 flex items-center gap-1 text-xs text-gray-600">
          {waiting && <span aria-hidden className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />}
          {status}
        </div>
      )}
      <div data-testid="run-text">
        <StoredMarkup parsed={pair.parsed} paired={pair.paired} stats={s.done?.stats ?? null} phase={phase} onCitationClick={onJump} />
      </div>
      {s.phase === 'done' && footer?.(pair.parsed)}
      {err && (
        <div data-testid="run-error" data-code={err.code} className="mt-1 text-xs text-red-700">
          {err.message}
          {err.code !== 'cancelled' && s.text !== '' && <span className="text-gray-500"> · 위의 글은 {err.code === 'persist_failed' ? '저장되지 않은 답변' : '중단 전까지 받은 부분'}입니다</span>}
          {/* result_deleted (B 수정 2): the thread or paper was deleted while the run went on, no previous answer is kept. */}
          {regen && err.source === 'run' && err.code !== 'result_deleted' && (
            <div data-testid="regenerate-kept" className="text-gray-600">
              다시 생성하지 못해 이전 답변을 그대로 두었습니다.
            </div>
          )}
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {active && (
          <button type="button" data-testid="run-cancel" className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100 disabled:opacity-50" disabled={s.cancelling} onClick={() => void run.cancel()}>
            {s.cancelling ? '취소 중…' : '취소'}
          </button>
        )}
        {err && err.retryable && err.source !== 'run' && (
          <button type="button" data-testid="run-retry" className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100" onClick={() => void run.retry()}>
            다시 연결
          </button>
        )}
        {err && onReopen && (err.source === 'stream' || err.source === 'aborted' || err.code === 'superseded' || err.code === 'payload_version') && (
          <button type="button" data-testid="run-reopen" className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100" onClick={onReopen}>
            thread 다시 열기
          </button>
        )}
      </div>
      {s.events.length > 0 && (
        <div data-testid="run-events" className="mt-1 truncate text-sl-label text-gray-400" title={s.events.join(' → ')}>
          {s.events.join(' → ')}
        </div>
      )}
    </div>
  );
}

/** The "깊게" toggle (PLAN_M2 3.7): aria-pressed; its owner turns it off after each send. */
export function DeepToggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      data-testid="pn-deep-toggle"
      aria-pressed={on}
      title={DEEP_TOOLTIP}
      disabled={disabled}
      className={`rounded border px-2 py-0.5 text-sl-label disabled:opacity-40 ${on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 text-gray-600 hover:bg-gray-100'}`}
      onClick={() => onChange(!on)}
    >
      깊게
    </button>
  );
}

export interface AskAttachment {
  anchor?: Anchor;
  text: string;
}

interface ComposerProps {
  placeholder: string;
  disabled: boolean;
  disabledReason?: string;
  showDeep: boolean;
  attachment?: AskAttachment | null;
  onClearAttachment?: () => void;
  focusTick?: number;
  onSend: (text: string, deep: boolean) => void;
}

function Composer({ placeholder, disabled, disabledReason, showDeep, attachment, onClearAttachment, focusTick = 0, onSend }: ComposerProps) {
  const [text, setText] = useState('');
  const [deep, setDeep] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusTick > 0) ref.current?.focus();
  }, [focusTick]);
  const send = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, showDeep && deep);
    setText('');
    setDeep(false); // the toggle applies to one question
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  return (
    <div className="flex flex-col gap-1 border-t pt-2">
      {attachment && (
        <div data-testid="pn-ask-attachment" className="flex items-start gap-1 rounded bg-gray-50 px-1.5 py-1 text-sl-label text-gray-700">
          <span className="shrink-0 text-gray-500">선택:</span>
          <span className="max-h-10 min-w-0 flex-1 overflow-auto break-words">{collapseSpaces(attachment.text)}</span>
          <button type="button" className="shrink-0 text-gray-500" aria-label="선택 떼기" onClick={onClearAttachment}>
            ×
          </button>
        </div>
      )}
      <textarea
        ref={ref}
        data-testid="followup-input"
        className="h-16 w-full resize-none rounded border border-gray-300 p-1.5 text-sm disabled:bg-gray-100"
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        maxLength={8000}
      />
      <div className="flex items-center justify-between gap-2 text-sl-label text-gray-500">
        <span className="min-w-0 flex-1">{disabled && disabledReason ? disabledReason : 'Ctrl+Enter로 보내기'}</span>
        {showDeep && <DeepToggle on={deep} onChange={setDeep} disabled={disabled} />}
        <button type="button" data-testid="followup-send" className="rounded bg-blue-600 px-3 py-0.5 text-sm text-white disabled:opacity-40" disabled={disabled || text.trim() === ''} onClick={send}>
          보내기
        </button>
      </div>
    </div>
  );
}

/** Capture of a figure / equation thread (papers.capture → blob URL, revoked on change / unmount). */
export function CaptureImage({ paperId, fileId, testId = 'pn-thread-image', className = 'max-h-48' }: { paperId: string; fileId: string; testId?: string; className?: string }) {
  const client = usePanelApi();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setFailed(false);
    client
      .blob('papers.capture', { params: { id: paperId, fileId } })
      .then((b) => {
        if (!alive) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [client, paperId, fileId]);
  if (failed) return <div className="text-xs text-red-700">캡처 이미지를 불러오지 못했습니다</div>;
  if (!url) return <div className="text-xs text-gray-500">캡처 이미지를 불러오는 중…</div>;
  return <img data-testid={testId} src={url} alt="캡처한 영역" className={`${className} max-w-full rounded border border-gray-200 object-contain`} />;
}

function ThreadHead({ paperId, thread }: { paperId: string; thread: ThreadDto }) {
  const structure = useContext(StructureContext);
  if (thread.kind !== 'figure' && thread.kind !== 'equation') return null;
  if (thread.imageFileId) return <CaptureImage paperId={paperId} fileId={thread.imageFileId} />;
  const eq = thread.equationId ? equationById(structure, thread.equationId) : null;
  if (!eq) return null;
  return (
    <div data-testid="pn-thread-equation" className="rounded border border-gray-200 bg-white p-1.5">
      <div className="text-sl-label text-gray-500">{eq.number ? `식 (${eq.number})` : '번호 없는 식'}</div>
      <LatexView latex={eq.latex} katexOk={eq.katexOk} />
    </div>
  );
}

/** Thread a run belongs to: from run.accepted, or the target of a follow-up before it was accepted. */
export function runThreadId(s: RunStreamState): string | null {
  return s.threadId ?? (s.request?.route === 'messages.create' ? s.request.params.id : null);
}

/** What a footer under an answer receives (glossary suggestions need the message id and its run). */
export interface AnswerFooterArgs {
  messageId: string;
  llmCallId: string | null;
  parsed: ParsedAnswer;
}

export interface ThreadViewProps {
  paperId: string;
  /** null = no thread yet: the input asks about the whole paper (threads.create {kind:'chat'}). */
  threadId: string | null;
  run: RunStreamApi;
  contextReady: boolean;
  /** Back to the thread list / a new question. */
  onClose?: () => void;
  /** "ask" action: the selection attached to the next new chat question. */
  askAttachment?: AskAttachment | null;
  onClearAsk?: () => void;
  /** Incremented to focus the question input ("ask"). */
  focusTick?: number;
  /** Under each complete answer whose server task is explain_selection or chat (glossary suggestions — D7). */
  answerFooter?: (args: AnswerFooterArgs) => ReactNode;
}

export function ThreadView({ paperId, threadId, run, contextReady, onClose, askAttachment = null, onClearAsk, focusTick, answerFooter }: ThreadViewProps) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const readable = useReaderStore((st) => st.paperState.readable);
  const thread = useQuery({
    queryKey: qk.thread(threadId ?? '-'),
    queryFn: () => client.call('threads.get', { params: { id: threadId! } }),
    enabled: threadId !== null,
  });
  const s = run.state;
  const active = isActive(s);
  // The live run is shown in the thread it belongs to (before run.accepted: in the "new question" view).
  const runThread = runThreadId(s);
  const liveHere = s.phase !== 'idle' && runThread === threadId;
  const stored = (thread.data?.messages ?? []).filter((m) => !(liveHere && m.id === s.messageId));
  // "다시 생성" is replace-on-success: the server keeps the old turn until the new answer is stored. While it runs
  // (and after a failure) the old turn is shown, the new turn's user message is not repeated; once the new answer
  // is done the old turn is hidden until the refetch no longer returns it. The replaced turn is the one pinned by id
  // when the button was pressed (regenTargets) — once the refetch no longer returns it, nothing is hidden.
  const regen = liveHere && isRegenerate(s);
  const target = regen ? regenTargetOf(s) : null;
  const replacedAt = target ? stored.findIndex((m) => m.id === target.assistantId) : -1;
  const messages =
    replacedAt < 0 ? stored : s.phase === 'done' ? stored.filter((m) => m.id !== target!.assistantId && m.id !== target!.userId) : stored.slice(0, replacedAt + 1);
  const beingReplacedId = isActive(s) && replacedAt >= 0 ? target!.assistantId : null;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const hasAssistant = messages.some((m) => m.role === 'assistant') || (liveHere && s.phase === 'done');
  const kind: ThreadKind | undefined = thread.data?.thread.kind ?? (threadId === null ? 'chat' : undefined);
  // The live run's kind (a new translate / figure / equation thread before threads.get has loaded).
  const liveKind: ThreadKind | undefined = s.request?.route === 'threads.create' ? s.request.body.kind : kind;
  const translate = (kind ?? (liveHere ? liveKind : undefined)) === 'translate';
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.thread(threadId ?? '-') });

  // Position of each stored assistant message among the thread's answers (0 = its first answer).
  const assistantIndex = new Map<string, number>();
  for (const m of stored) if (m.role === 'assistant') assistantIndex.set(m.id, assistantIndex.size);
  // The live answer: a new thread's first answer, "다시 생성" of the pinned turn, or the next follow-up.
  const liveIndex = s.request?.route === 'threads.create' ? 0 : target ? target.index : assistantIndex.size;
  const footerFor = (messageId: string, llmCallId: string | null, k: ThreadKind | undefined, index: number): AnswerFooter | undefined =>
    answerFooter && answerTask(k, index) !== 'other' ? (parsed) => answerFooter({ messageId, llmCallId, parsed }) : undefined;

  const blockedReason = useReaderStore((st) => st.paperState.aiBlockedReason ?? null); // M1.1 M5
  const disabledReason = !contextReady ? (blockedReason ?? '색인 준비 중 — 준비가 끝나면 AI 기능이 켜집니다') : active ? '답변이 끝난 뒤 보낼 수 있습니다' : undefined;
  const send = (text: string, deep: boolean) => {
    const d = deep ? { deep: true } : {};
    if (threadId) {
      void run.start({ route: 'messages.create', params: { id: threadId }, body: { text, ...d } });
      return;
    }
    const sel = askAttachment ? { text: askAttachment.text, ...(askAttachment.anchor ? { anchor: askAttachment.anchor } : {}) } : {};
    void run.start({ route: 'threads.create', params: { id: paperId }, body: { kind: 'chat', question: text, ...sel, ...d } });
    onClearAsk?.();
  };
  const regenerate = () => {
    if (!threadId) return;
    // Pin the turn the server replaces = the thread's last answer. Its question (the new turn's user message on the
    // server) and its position (which decides its server task) come from where that answer is known: the stored thread
    // when it has it, else the run that produced it (review D-R2-02 — before the refetch the stored list still ends
    // with the replaced or the previous turn).
    // Review D-R3-02: the stored list may also hold turns the server has already dropped — AiTab re-reads it at
    // run.accepted, so during and right after a "다시 생성" it lists the old turn AND the new one. Which one the server
    // keeps follows from how the previous run of this thread ended (replace-on-success, discardOnFailure):
    // - a regenerate that ended done: its new turn replaced the pinned old turn → the old turn is gone (not counted);
    // - a regenerate that ended otherwise (error, cancel): the server dropped its new turn and kept the pinned old one,
    //   which is still the turn to replace → the same pin again, with the same question;
    // - any other run that got as far as run.accepted (done, error or cancelled): its own turn is the thread's last.
    const all = thread.data?.messages ?? [];
    const prev = liveHere && !active ? s.request : null;
    const prevTarget = prev ? regenTargetOf(s) : null;
    let question: string | undefined;
    let target: RegenTarget | null = null;
    if (prev && prevTarget && s.phase !== 'done') {
      target = prevTarget;
      question = prev.route === 'messages.create' ? prev.body.text : undefined;
    } else {
      const replaced = new Set<string | null>(prevTarget ? [prevTarget.assistantId, prevTarget.userId] : []);
      const kept = all.filter((m) => !replaced.has(m.id));
      const prevLive = prev && s.messageId ? s.messageId : null;
      const lastStored = [...kept].reverse().find((m) => m.role === 'assistant')?.id ?? null;
      const assistantId = prevLive ?? lastStored;
      const at = assistantId ? kept.findIndex((m) => m.id === assistantId) : -1;
      const answers = kept.filter((m) => m.role === 'assistant');
      if (assistantId && at >= 0) {
        const user = at > 0 && kept[at - 1]!.role === 'user' ? kept[at - 1]! : null;
        question = user?.contentMd;
        target = { assistantId, userId: user?.id ?? null, index: answers.findIndex((m) => m.id === assistantId) };
      } else if (assistantId && prevLive && prev) {
        question = prev.route === 'messages.create' ? prev.body.text : prev.route === 'threads.create' ? (prev.body.question?.trim() ? prev.body.question : (prev.body.anchor?.quote?.exact ?? prev.body.text)) : undefined;
        const index = prevTarget ? prevTarget.index : prev.route === 'threads.create' ? 0 : answers.length;
        target = { assistantId, userId: null, index };
      } else if (assistantId) {
        target = { assistantId, userId: null, index: answers.length };
      }
    }
    const text = question || lastUser?.contentMd || thread.data?.thread.title || '다시 생성';
    const request: RunRequest = { route: 'messages.create', params: { id: threadId }, body: { text: text.slice(0, 8000), regenerate: true } };
    if (target) regenTargets.set(request, target);
    void run.start(request);
  };
  const reopen = () => {
    const id = s.threadId;
    run.reset();
    if (id) void qc.invalidateQueries({ queryKey: qk.thread(id) });
  };
  // A translation needs only a readable paper (PLAN_M2 3.6); everything else the AI context.
  const canRegenerate = translate ? readable : contextReady;
  const userLabel = (i: number) => (i !== 0 ? '질문' : kind === 'explain' ? '선택한 문장' : kind === 'translate' ? '번역할 문장' : '질문');

  return (
    <div data-testid="thread-view" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        {threadId && onClose && (
          <button type="button" data-testid="thread-close" className="rounded border px-1.5 hover:bg-gray-100" onClick={onClose}>
            ← 목록
          </button>
        )}
        <div className="min-w-0 flex-1 truncate font-medium" data-testid="thread-title">
          {threadId ? `${kind ? `[${THREAD_KIND_TEXT[kind]}] ` : ''}${thread.data?.thread.title ?? ''}` : '새 질문'}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="thread-messages">
        {threadId === null && !liveHere && <div className="text-xs text-gray-500">PDF에서 문장을 선택해 ‘설명’을 누르거나, 아래에 논문 전체에 대한 질문을 입력하세요.</div>}
        {thread.isPending && threadId !== null && <div className="text-xs text-gray-500">불러오는 중…</div>}
        {thread.isError && (
          <div className="text-xs text-red-700" data-testid="thread-load-error">
            대화를 불러오지 못했습니다.
            <button type="button" className="ml-1 rounded border px-1" onClick={refresh}>
              다시 시도
            </button>
          </div>
        )}
        {thread.data && <ThreadHead paperId={paperId} thread={thread.data.thread} />}
        {messages.map((m, i) => {
          if (m.role === 'user') return <UserMessage key={m.id} m={m} label={userLabel(i)} selection={i === 0 && (kind === 'explain' || kind === 'translate')} />;
          const idx = assistantIndex.get(m.id) ?? 0;
          return <AssistantMessage key={m.id} m={m} onRefresh={refresh} beingReplaced={m.id === beingReplacedId} plain={translate} chatTask={answerTask(kind, idx) === 'chat'} footer={footerFor(m.id, m.llmCallId, kind, idx)} />;
        })}
        {liveHere && (
          <LiveMessage
            run={run}
            onReopen={reopen}
            plain={liveKind === 'translate'}
            chatTask={answerTask(liveKind, liveIndex) === 'chat'}
            footer={s.messageId ? footerFor(s.messageId, s.runId, liveKind, liveIndex) : undefined}
          />
        )}
        {threadId && hasAssistant && !active && (
          <button type="button" data-testid="regenerate" className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100 disabled:opacity-40" disabled={!canRegenerate} onClick={regenerate}>
            다시 생성
          </button>
        )}
      </div>
      {!translate && (
        <Composer
          placeholder={threadId ? '후속 질문을 입력하세요' : '논문 전체에 대해 질문하세요'}
          disabled={!contextReady || active}
          disabledReason={disabledReason}
          // Every input whose server task is chat: a chat question and every follow-up (explain / figure / equation / chat).
          showDeep={kind !== undefined}
          attachment={threadId === null ? askAttachment : null}
          onClearAttachment={onClearAsk}
          focusTick={focusTick}
          onSend={send}
        />
      )}
    </div>
  );
}
