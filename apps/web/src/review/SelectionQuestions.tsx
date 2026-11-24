import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { SelectionQuestions, type SelectionQuestion } from '@study-paper/shared/contracts/api';
import type { NormRect, TextQuoteSelector } from '@study-paper/shared/contracts/domain';
import { api } from '../api/client';
import { qk } from '../api/queryKeys';
import { useRunStream } from '../panel/useRunStream';

type Source = { page: number; quote: TextQuoteSelector; rects: NormRect[] };
const btn = 'rounded-sl-control border border-sl-edge px-3 py-1.5 focus-visible:outline-sl-accent disabled:opacity-50';

function readQuestions(text: string) {
  try {
    const result = SelectionQuestions.safeParse(JSON.parse(text));
    return result.success ? result.data.cards : null;
  } catch {
    return null;
  }
}

export function useSelectionQuestions(paperId: string) {
  const [source, setSource] = useState<Source | null>(null);
  const { state, start, reset, retry } = useRunStream();
  const open = useCallback((anchor: Source) => {
    setSource(anchor);
    const { exact, prefix, suffix } = anchor.quote;
    void start({ route: 'reviewCards.fromSelection', params: { id: paperId },
      body: { page: anchor.page, selection: exact, prefix, suffix } });
  }, [paperId, start]);
  const close = () => { reset(); setSource(null); };
  const cards = useMemo(() => state.phase === 'done' ? readQuestions(state.text) : null, [state.phase, state.text]);
  return { open, active: source !== null, dialog: source && (
    <QuestionDialog key={state.clientRequestId} paperId={paperId} source={source}
      runId={state.runId} cards={cards} close={close} retry={() => void retry()}
      error={state.error?.message ?? (state.phase === 'done' && !cards ? '문제를 읽지 못했습니다.' : null)}
      retryable={state.error?.retryable ?? false} />
  ) };
}

export function QuestionDialog({ paperId, source, runId, cards, close, error, retryable, retry }: {
  paperId: string; source: Source; runId: string | null; cards: readonly SelectionQuestion[] | null;
  close: () => void; error: string | null; retryable: boolean; retry: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const [excluded, setExcluded] = useState<number[]>([]);
  const [saved, setSaved] = useState<number[]>([]);
  const [saveError, setSaveError] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    return () => { if (el?.open) el.close(); };
  }, []);
  const remaining = cards?.map((_, i) => i).filter(i => !excluded.includes(i) && !saved.includes(i)) ?? [];
  async function confirm() {
    if (savingNow.current || !runId || !cards?.length || !remaining.length) return;
    savingNow.current = true;
    setSaving(true);
    setSaveError(false);
    try {
      for (const i of remaining) {
        const { frontMd, backMd, type } = cards[i]!;
        await api.call('review.cards.create', { body: {
          paperId, runId, questionIndex: i, type, frontMd, backMd, anchor: source,
        } });
        setSaved(prev => [...prev, i]);
        void qc.invalidateQueries({ queryKey: qk.highlights(paperId) });
        void qc.invalidateQueries({ queryKey: qk.reviewQueue });
      }
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
      savingNow.current = false;
    }
  }
  return (
    <dialog ref={dialog} data-reader-chrome data-testid="pn-review-q" aria-labelledby="selection-questions-title"
      onCancel={event => { event.preventDefault(); if (!savingNow.current) close(); }}
      className="fixed inset-0 m-auto max-h-[85dvh] w-[min(36rem,92vw)] overflow-y-auto rounded-sl-card border border-sl-line bg-sl-raised p-5 text-sl-ink shadow-sl-card backdrop:bg-black/30">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 id="selection-questions-title" className="text-lg font-semibold">복습문제 미리보기</h2>
        <button type="button" className={btn} disabled={saving} onClick={close}>닫기</button>
      </header>
      <p className="text-sl-label text-sl-meta">선택한 원문 · {source.page}쪽</p>
      <blockquote className="my-2 max-h-28 overflow-auto whitespace-pre-wrap break-words border-l-2 border-sl-line pl-3 text-sl-ui">{source.quote.exact}</blockquote>
      {error ? <p role="alert">{error} {retryable && <button type="button" className={btn} onClick={retry}>다시 연결</button>}</p>
        : !cards ? <p role="status">선택한 글에서 문제를 만들고 있습니다.</p> : <>
        <p className="my-3 text-sl-ui">질문과 답을 읽고 복습할 문제를 골라 주세요.</p>
        <ol className="space-y-3">{cards.map((q, i) => (
          <li key={i} className="rounded-sl-card border border-sl-line p-3">
            <label className="flex items-start gap-2 font-medium">
              <input type="checkbox" className="mt-1" disabled={saving || saved.includes(i)} checked={!excluded.includes(i)}
                onChange={e => setExcluded(prev => e.target.checked ? prev.filter(n => n !== i) : [...prev, i])} />
              <span className="whitespace-pre-wrap break-words">{q.frontMd}</span>
            </label>
            <p className="mt-1 whitespace-pre-wrap break-words text-sl-ui">{q.backMd}</p>
            <p className="mt-2 break-words text-sl-label text-sl-meta">선택 근거 · {q.evidence}</p>
          </li>
        ))}</ol>
        {saveError && <p role="alert" className="my-2">저장을 마치지 못했습니다. 남은 문제를 다시 추가해 주세요.</p>}
        {saved.length > 0 && <p role="status" data-testid="rd-review-saved" className="my-3">복습 큐에 {saved.length}개 추가됨 · <Link href="/review" className="text-sl-accent underline">복습 열기</Link></p>}
        <button type="button" className={btn + ' mt-3'} data-testid="rd-review-confirm" disabled={saving || !remaining.length}
          onClick={() => void confirm()}>{saving ? '저장 중…' : '복습 큐에 추가'}{!saving && remaining.length > 0 ? ' (' + remaining.length + ')' : ''}</button>
      </>}
    </dialog>
  );
}
