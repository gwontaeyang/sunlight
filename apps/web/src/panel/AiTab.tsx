// AI tab (PLAN 8.3, PLAN_M2 3.5–3.7, BRIEF_D D2): thread list + ThreadView + reader actions. Owner D.
// The viewer (C) publishes `pendingAction`. This tab handles explain · translate · ask · figure · equation; glossary
// and note actions belong to the glossary and highlights·notes tabs (left pending here for them).
// - explain / translate / equation(equationId) re-open the newest COMPLETE thread for the same quote / equation
//   (threadReuse.ts); a capture (figure, equation with an image) and ask always start new.
// - translate needs only a readable paper; the other runs need the AI context.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import type { CreateThreadRequest } from '@study-paper/shared/contracts/api';
import { qk } from '../api/queryKeys';
import { statsSummary } from '../markdown/grounding';
import { useReaderStore, type ReaderAction } from '../state/readerStore';
import { GlossarySuggestions } from './GlossaryTab';
import { usePanelApi } from './panelApi';
import { findReusableThread } from './threadReuse';
import { collapseSpaces, runThreadId, THREAD_KIND_TEXT, ThreadView, type AnswerFooterArgs, type AskAttachment } from './ThreadView';
import { isActive, useRunStream } from './useRunStream';

const AI_ACTIONS: ReadonlySet<ReaderAction['kind']> = new Set(['explain', 'translate', 'ask', 'figure', 'equation']);

const REOPEN_TEXT: Partial<Record<ReaderAction['kind'], string>> = {
  explain: '같은 문장의 설명을 다시 열었습니다. 새 답이 필요하면 ‘다시 생성’을 누르세요.',
  translate: '같은 문장의 번역을 다시 열었습니다. 새 번역이 필요하면 ‘다시 생성’을 누르세요.',
  equation: '이 식의 깊이 읽기를 다시 열었습니다. 새 답이 필요하면 ‘다시 생성’을 누르세요.',
};

type ThreadBody = Omit<CreateThreadRequest, 'clientRequestId'>;

/** threads.create body for an action, or the notice for an unsupported combination (PLAN_M2 3.5 task input table). */
export function threadRequestFor(a: ReaderAction): { body: ThreadBody } | { notice: string } {
  const text = a.text ?? a.anchor?.quote?.exact;
  const area = a.anchor?.kind === 'area' && a.anchor.rects.length === 1 && a.imagePng !== undefined;
  switch (a.kind) {
    case 'explain':
      return text ? { body: { kind: 'explain', ...(a.anchor ? { anchor: a.anchor } : {}), ...(a.text ? { text: a.text } : {}) } } : { notice: '설명할 문장을 먼저 선택하세요' };
    case 'translate':
      return text ? { body: { kind: 'translate', ...(a.anchor ? { anchor: a.anchor } : {}), ...(a.text ? { text: a.text } : {}) } } : { notice: '번역할 문장을 먼저 선택하세요' };
    case 'figure':
      return area ? { body: { kind: 'figure', anchor: a.anchor!, imagePng: a.imagePng! } } : { notice: '그림·표 설명은 PDF에서 영역을 캡처(Ctrl+드래그)해 시작합니다' };
    case 'equation':
      if (a.equationId && a.imagePng === undefined) return { body: { kind: 'equation', equationId: a.equationId } };
      if (area && !a.equationId) return { body: { kind: 'equation', anchor: a.anchor!, imagePng: a.imagePng! } };
      return { notice: '수식 깊이 읽기는 수식 탭·식 번호에서, 또는 수식 영역을 캡처해 시작합니다' };
    default:
      return { notice: '이 동작은 AI 탭에서 지원하지 않습니다' };
  }
}

export function AiTab({ paperId, answerFooter }: { paperId: string; answerFooter?: (args: AnswerFooterArgs) => ReactNode }) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const contextReady = useReaderStore((s) => s.paperState.contextReady);
  const readable = useReaderStore((s) => s.paperState.readable);
  // M1.1 M5: why the AI is off (색인 준비 중, or a paper the current LLM cannot use yet).
  const blockedReason = useReaderStore((s) => s.paperState.aiBlockedReason ?? null) ?? '색인 준비 중 — 준비가 끝나면 AI 기능이 켜집니다';
  const selection = useReaderStore((s) => s.selection);
  const pendingAction = useReaderStore((s) => s.pendingAction);
  const requestAction = useReaderStore((s) => s.requestAction);
  const consumeAction = useReaderStore((s) => s.consumeAction);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskAttachment | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const threads = useQuery({ queryKey: qk.threads(paperId), queryFn: () => client.call('threads.list', { params: { id: paperId } }) });

  const run = useRunStream({
    client,
    onEvent: (e, s) => {
      if (e.event !== 'run.accepted') return;
      const id = runThreadId(s);
      if (id) {
        setSelected(id);
        // The server stored the user message and the assistant placeholder: show them now.
        void qc.invalidateQueries({ queryKey: qk.thread(id) });
      }
      void qc.invalidateQueries({ queryKey: qk.threads(paperId) });
    },
    onSettled: (s) => {
      const id = runThreadId(s);
      if (id) void qc.invalidateQueries({ queryKey: qk.thread(id) });
      void qc.invalidateQueries({ queryKey: qk.threads(paperId) });
    },
  });
  const active = isActive(run.state);
  const start = run.start;

  // Reader actions. Waits for the thread list (or its failure) so a repeated action finds its thread.
  useEffect(() => {
    const a = useReaderStore.getState().pendingAction;
    if (!a || !AI_ACTIONS.has(a.kind)) return; // glossary / note: the other tabs consume them
    if (a.kind === 'ask') {
      consumeAction();
      const text = a.text ?? a.anchor?.quote?.exact;
      setAsk(text ? { text, ...(a.anchor ? { anchor: a.anchor } : {}) } : null);
      setSelected(null);
      setNotice(contextReady ? null : blockedReason);
      setFocusTick((t) => t + 1);
      return;
    }
    if (threads.isPending) return;
    consumeAction();
    const existing = findReusableThread(threads.data?.threads ?? [], a);
    if (existing) {
      setNotice(REOPEN_TEXT[a.kind] ?? null);
      setSelected(existing.id);
      return;
    }
    const req = threadRequestFor(a);
    if ('notice' in req) {
      setNotice(req.notice);
      return;
    }
    if (a.kind === 'translate' ? !readable : !contextReady) {
      setNotice(a.kind === 'translate' ? 'PDF를 읽을 수 있게 되면 번역할 수 있습니다' : blockedReason);
      return;
    }
    if (active) {
      setNotice('진행 중인 답변이 끝난 뒤 다시 시도하세요.');
      return;
    }
    setNotice(null);
    setSelected(null);
    void start({ route: 'threads.create', params: { id: paperId }, body: req.body });
  }, [pendingAction, threads.isPending, threads.data, contextReady, readable, blockedReason, active, consumeAction, paperId, start]);

  const list = threads.data?.threads ?? [];
  const selText = selection?.text ? collapseSpaces(selection.text) : '';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="ai-tab">
      {!contextReady && (
        <div data-testid="context-not-ready" className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
          {blockedReason}
        </div>
      )}
      {selection?.text && (
        <div className="flex items-start gap-2 rounded border border-gray-200 bg-gray-50 p-1.5 text-xs">
          <div data-testid="selection-text" className="max-h-16 min-w-0 flex-1 overflow-auto break-words">
            {selText}
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            <button
              type="button"
              data-testid="explain-button"
              className="rounded bg-blue-600 px-2 py-0.5 text-white disabled:opacity-40"
              disabled={!contextReady || active}
              title={contextReady ? '선택한 문장 설명 (E)' : blockedReason}
              onClick={() => requestAction({ kind: 'explain', anchor: selection.anchor, text: selection.text })}
            >
              설명
            </button>
            <button
              type="button"
              data-testid="pn-translate-button"
              className="rounded border border-blue-600 px-2 py-0.5 text-blue-700 disabled:opacity-40"
              disabled={!readable || active}
              title="선택한 문장 번역 (T)"
              onClick={() => requestAction({ kind: 'translate', anchor: selection.anchor, text: selection.text })}
            >
              번역
            </button>
          </div>
        </div>
      )}
      {notice && (
        <div data-testid="panel-notice" className="flex items-start justify-between gap-2 rounded bg-sky-50 px-2 py-1 text-xs text-sky-900">
          <span>{notice}</span>
          <button type="button" className="text-sky-700" aria-label="알림 닫기" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
      <details open={selected === null} className="shrink-0 rounded border border-gray-200">
        <summary className="cursor-pointer px-2 py-1 text-xs font-medium">대화 목록 ({list.length})</summary>
        <ul data-testid="thread-list" className="max-h-48 overflow-y-auto">
          {threads.isError && <li className="px-2 py-1 text-xs text-red-700">대화 목록을 불러오지 못했습니다</li>}
          {threads.isSuccess && list.length === 0 && <li className="px-2 py-1 text-xs text-gray-500">아직 대화가 없습니다</li>}
          {list.map((t) => {
            const summary = statsSummary(t.lastStats);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  data-testid="thread-item"
                  data-thread-id={t.id}
                  className={`block w-full px-2 py-1 text-left text-xs hover:bg-gray-50 ${t.id === selected ? 'bg-blue-50' : ''}`}
                  onClick={() => setSelected(t.id)}
                >
                  <span className="mr-1 rounded bg-gray-100 px-1 text-sl-label text-gray-600">{THREAD_KIND_TEXT[t.kind]}</span>
                  <span className="break-words">{t.title}</span>
                  {summary && (
                    <span data-testid="thread-stats" className="block text-sl-label text-gray-500">
                      {summary}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </details>
      <ThreadView
        paperId={paperId}
        threadId={selected}
        run={run}
        contextReady={contextReady}
        onClose={() => setSelected(null)}
        askAttachment={ask}
        onClearAsk={() => setAsk(null)}
        focusTick={focusTick}
        // "용어 제안" buttons: ThreadView calls this only for explain_selection / chat answers (PLAN_M2 3.4 rule 6).
        answerFooter={answerFooter ?? ((f) => <GlossarySuggestions paperId={paperId} suggestions={f.parsed.glossary} messageId={f.messageId} llmCallId={f.llmCallId} />)}
      />
    </div>
  );
}
