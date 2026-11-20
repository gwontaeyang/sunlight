// Re-explaining the same quote re-opens its thread; a different quote creates a new thread (PLAN 부록 D).
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiTab } from '../../src/panel/AiTab';
import { findReusableThread } from '../../src/panel/threadReuse';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, anchorOf, messageDto, renderWithApi, resetReader, threadDto, threadsApi } from './panelHarness';

afterEach(cleanup);
beforeEach(() => resetReader(true));

describe('findReusableThread', () => {
  const a = threadDto('a', { kind: 'explain', anchor: anchorOf('robust kernel'), updatedAt: 10 });
  const b = threadDto('b', { kind: 'explain', anchor: anchorOf('robust kernel'), updatedAt: 20 });
  const chat = threadDto('c', { kind: 'chat', anchor: anchorOf('point-to-point'), updatedAt: 30 });

  it('same kind + same quote → the newest such thread', () => {
    expect(findReusableThread([a, b, chat], { kind: 'explain', anchor: anchorOf('robust kernel') })?.id).toBe('b');
  });
  it('different quote, other kind, no quote or a non-explain action → null', () => {
    expect(findReusableThread([a, b], { kind: 'explain', anchor: anchorOf('robust kernels') })).toBeNull();
    expect(findReusableThread([chat], { kind: 'explain', anchor: anchorOf('point-to-point') })).toBeNull();
    expect(findReusableThread([a], { kind: 'explain' })).toBeNull();
    expect(findReusableThread([a], { kind: 'translate', anchor: anchorOf('robust kernel') })).toBeNull();
  });
});

describe('AI tab: explain action', () => {
  const T = threadDto('t-old', { kind: 'explain', title: 'robust kernel', anchor: anchorOf('robust kernel') });
  const data = { threads: [T], messages: { 't-old': [messageDto('u', 't-old', 'user', 'robust kernel'), messageDto('m', 't-old', 'assistant', '이전 설명 [[G]]')] } };

  it('the same quote opens the existing thread (no new run) and offers "다시 생성"', async () => {
    const { server } = renderWithApi(createElement(AiTab, { paperId: PAPER }), threadsApi(data));
    await screen.findByTestId('thread-item');
    act(() => useReaderStore.getState().requestAction({ kind: 'explain', anchor: anchorOf('robust kernel'), text: 'robust kernel' }));
    await screen.findByText('이전 설명');
    expect(useReaderStore.getState().pendingAction).toBeNull();
    expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(server.calls.some((c) => c.url === '/api/threads/t-old')).toBe(true);
    expect(screen.getByTestId('regenerate')).toBeTruthy();
    expect(screen.getByTestId('panel-notice').textContent).toContain('다시 열었습니다');
  });

  it('a different quote creates a new explain thread with the anchor', async () => {
    const { server } = renderWithApi(createElement(AiTab, { paperId: PAPER }), threadsApi(data));
    await screen.findByTestId('thread-item');
    act(() => useReaderStore.getState().requestAction({ kind: 'explain', anchor: anchorOf('point-to-point residual'), text: 'point-to-point residual' }));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    const post = server.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`/api/papers/${PAPER}/threads`);
    expect(post.body).toMatchObject({ kind: 'explain', text: 'point-to-point residual', anchor: { kind: 'text', quote: { exact: 'point-to-point residual' } } });
    expect(useReaderStore.getState().pendingAction).toBeNull();
  });

  it('waits for the thread list before deciding; a failed list still creates a thread', async () => {
    const { server } = renderWithApi(createElement(AiTab, { paperId: PAPER }), (c) => (c.method === 'GET' ? { status: 501, json: { error: { code: 'not_implemented', message: 'x' } } } : undefined));
    act(() => useReaderStore.getState().requestAction({ kind: 'explain', anchor: anchorOf('robust kernel'), text: 'robust kernel' }));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(screen.getByText('대화 목록을 불러오지 못했습니다')).toBeTruthy();
  });
});
