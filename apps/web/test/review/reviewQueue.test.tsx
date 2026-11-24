import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResponse, ReviewCardDto } from '@study-paper/shared/contracts/api';
import { api, ApiError } from '../../src/api/client';
import { ReviewPage } from '../../src/review/ReviewPage';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const card: ReviewCardDto = {
  id: 'card', paperId: 'paper', type: 'definition', frontMd: 'What changes?', backMd: 'The estimate.',
  origin: 'llm', highlightId: 'highlight', sectionId: null, suspended: false, citations: [], createdAt: 1, updatedAt: 1,
  fsrs: { due: 1, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0, lastReview: null },
};
const empty: ApiResponse<'review.queue'> = { now: 1, cards: [], newRemainingToday: 20 };
const due = { ...empty, cards: [{ card, preview: [] }] };

async function openAnswer() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ReviewPage /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '답 보기' }));
}
it.each([404, 409] as const)('refreshes after HTTP %d and can discover another due card from the empty queue', async status => {
  const calls = vi.spyOn(api, 'call').mockResolvedValueOnce(due).mockRejectedValueOnce(new ApiError(status, status === 404 ? 'not_found' : 'conflict', 'state changed'))
    .mockResolvedValueOnce(empty).mockResolvedValueOnce(due);
  await openAnswer();
  fireEvent.click(screen.getByRole('button', { name: '알맞음' }));
  expect(await screen.findByTestId('review-empty')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain(status === 404 ? '사라졌습니다' : '바뀌어');
  fireEvent.click(screen.getByRole('button', { name: '다시 확인' }));
  expect(await screen.findByRole('heading', { name: card.frontMd })).toBeTruthy();
  expect(calls.mock.calls.map(args => args[0])).toEqual(['review.queue', 'review.grade', 'review.queue', 'review.queue']);
});
it('reuses the same grade identity if the reply was lost in transport', async () => {
  const calls = vi.spyOn(api, 'call').mockResolvedValueOnce(due).mockRejectedValueOnce(new Error('connection interrupted'))
    .mockResolvedValueOnce(card).mockResolvedValueOnce(empty);
  await openAnswer();
  const good = screen.getByRole('button', { name: '알맞음' });
  fireEvent.click(good);
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: '쉬움' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(good);
  await waitFor(() => expect(screen.getByTestId('review-empty')).toBeTruthy());
  expect(calls.mock.calls[2]).toEqual(calls.mock.calls[1]);
});
