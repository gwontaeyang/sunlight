import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SelectionQuestion } from '@study-paper/shared/contracts/api';
import { api } from '../../src/api/client';
import { QuestionDialog } from '../../src/review/SelectionQuestions';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const source = { page: 2, quote: { exact: 'A residual measures the difference.' }, rects: [{ page: 2, x: 0.2, y: 0.4, w: 0.5, h: 0.1 }] };
const cards: SelectionQuestion[] = ['What does a residual measure?', 'What measures the difference?'].map((frontMd, i) => ({
  frontMd, type: 'definition', backMd: i ? 'A residual.' : 'The difference.', evidence: source.quote.exact,
}));

it('waits for confirmation, keeps the first committed card after a failure, and retries only the remaining index', async () => {
  const call = vi.spyOn(api, 'call').mockResolvedValue({} as never);
  call.mockResolvedValueOnce({} as never).mockRejectedValueOnce(new Error('connection closed'));
  render(<QueryClientProvider client={new QueryClient()}>
    <QuestionDialog paperId="paper" source={source} cards={cards} runId="run" error={null} retryable={false} retry={vi.fn()} close={vi.fn()} />
  </QueryClientProvider>);
  expect(call).not.toHaveBeenCalled();
  const confirm = screen.getByTestId('rd-review-confirm');
  fireEvent.click(confirm);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByTestId('rd-review-saved').textContent).toContain('1개');
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.getByTestId('rd-review-saved').textContent).toContain('2개'));
  expect(call.mock.calls).toEqual([0, 1, 1].map(questionIndex => {
    const { frontMd, backMd, type } = cards[questionIndex]!;
    return ['review.cards.create', { body: { paperId: 'paper', runId: 'run', questionIndex, frontMd, backMd, type, anchor: source } }];
  }));
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
});
