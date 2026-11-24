import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'wouter';
import type { ReviewCardDto } from '@study-paper/shared/contracts/api';
import type { ReviewRating } from '@study-paper/shared/contracts/domain';
import { api, ApiError } from '../api/client';
import { qk } from '../api/queryKeys';
import { ThemeSwitch } from '../ui/theme';

const ratings = [[1, '다시'], [2, '어려움'], [3, '알맞음'], [4, '쉬움']] as const;
const button = 'rounded-sl-control border border-sl-line px-3 py-1.5 text-sl-ui hover:bg-sl-accent-soft disabled:opacity-50';

function ReviewQuestion({ card, onNotice }: { card: ReviewCardDto; onNotice: (text: string) => void }) {
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const pending = useRef<{ rating: ReviewRating; clientRequestId: string } | null>(null);
  const source = card.highlightId ? '/paper/' + encodeURIComponent(card.paperId) + '?highlight=' + encodeURIComponent(card.highlightId) : null;
  async function grade(rating: ReviewRating) {
    if (busy.current || (pending.current && pending.current.rating !== rating)) return;
    pending.current ??= { rating, clientRequestId: crypto.randomUUID() };
    busy.current = true;
    setSaving(true);
    setError(false);
    onNotice('');
    try {
      await api.call('review.grade', { params: { id: card.id }, body: { ...pending.current, expectedReps: card.fsrs.reps } });
      await qc.invalidateQueries({ queryKey: qk.reviewQueue });
      pending.current = null;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        pending.current = null;
        onNotice(err.status === 404 ? '이 문제는 복습 큐에서 사라졌습니다.' : '복습 일정이 바뀌어 목록을 다시 불러왔습니다.');
        await qc.invalidateQueries({ queryKey: qk.reviewQueue });
      } else {
        setError(true);
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return <article data-testid="review-entry" className="space-y-3 rounded-sl-card border border-sl-line bg-sl-raised p-4">
    <h2 className="whitespace-pre-wrap break-words font-semibold">{card.frontMd}</h2>
    <div className="flex items-center gap-3">
      {!revealed && <button type="button" className={button} onClick={() => setRevealed(true)}>답 보기</button>}
      {source && <Link href={source} className="text-sl-ui text-sl-accent underline">원문 보기</Link>}
    </div>
    {revealed && <>
      <p data-testid="review-answer" className="whitespace-pre-wrap break-words">{card.backMd}</p>
      <div className="flex flex-wrap gap-2" aria-label="이번 답의 난이도">
        {ratings.map(([rating, label]) => <button type="button" key={rating} className={button}
          disabled={saving || (error && pending.current?.rating !== rating)}
          onClick={() => void grade(rating)}>{label}</button>)}
      </div>
      {error && <p role="alert">평가를 저장하지 못했습니다. 같은 평가를 눌러 다시 시도해 주세요.</p>}
    </>}
  </article>;
}

export function ReviewPage() {
  const [notice, setNotice] = useState('');
  const queue = useQuery({ queryKey: qk.reviewQueue, queryFn: () => api.call('review.queue') });
  return <main className="min-h-dvh bg-sl-surface px-5 py-8 text-sl-ink">
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sl-ui text-sl-accent underline">서재로</Link><ThemeSwitch />
      </header>
      <h1 className="text-2xl font-semibold">오늘 복습할 문제</h1>
      {notice && <p role="status" className="text-sl-ui text-sl-meta">{notice}</p>}
      {queue.isPending && <p role="status">복습 큐를 불러오는 중입니다.</p>}
      {queue.isError && <p role="alert">복습 큐를 불러오지 못했습니다. <button className={button} onClick={() => void queue.refetch()}>다시 시도</button></p>}
      {queue.data && (queue.data.cards.length
        ? queue.data.cards.map(({ card }) => <ReviewQuestion key={card.id + '-' + card.fsrs.reps} card={card} onNotice={setNotice} />)
         : <div className="space-y-3">
          <p data-testid="review-empty">지금 복습할 문제가 없습니다. 논문에서 글을 선택하고 ‘문제 만들기’를 눌러 보세요.</p>
          <button type="button" className={button} disabled={queue.isFetching} onClick={() => { setNotice(''); void queue.refetch(); }}>다시 확인</button>
        </div>)}
    </div>
  </main>;
}
