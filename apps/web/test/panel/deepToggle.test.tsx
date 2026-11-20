// "깊게" toggle (PLAN_M2 3.7, BRIEF_D D2): on every input whose server task is chat — a chat question and the
// follow-ups of chat / explain / equation / figure threads — with deep:true in the body; off after sending; absent on
// translate, the first explain request and "다시 생성". The in-progress display (run.started{effort:'high'} +
// run.thinking → "깊게" + "생각 중") is checked here with event timing under control (S review R1-02). Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ThreadKind } from '@study-paper/shared/contracts/domain';
import { AiTab } from '../../src/panel/AiTab';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, anchorOf, messageDto, renderWithApi, resetReader, threadDto, threadsApi } from './panelHarness';
import { ev } from './sseFake';

afterEach(cleanup);
beforeEach(() => resetReader(true));

const toggle = () => screen.getByTestId('pn-deep-toggle');
const lastPost = (server: { calls: { method: string; body: Record<string, unknown> | undefined; url: string }[] }) => server.calls.filter((c) => c.method === 'POST').at(-1)!;

function threadData(kind: ThreadKind) {
  const T = threadDto('t1', { kind, title: `${kind} thread`, anchor: kind === 'figure' ? { kind: 'area', rects: [{ page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] } : anchorOf('q') });
  return threadsApi({ threads: [T], messages: { t1: [messageDto('u1', 't1', 'user', 'q'), messageDto('a1', 't1', 'assistant', '첫 답 [[G]]')] } });
}

describe('"깊게" toggle', () => {
  it('chat question: visible, deep:true in threads.create, off after sending', async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().title).toBe('더 오래 생각한 뒤 답합니다(첫 글자까지 수십 초)');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '기여는?' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(lastPost(server).body).toMatchObject({ kind: 'chat', question: '기여는?', deep: true });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('a question without the toggle sends no deep key', async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '기여는?' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect('deep' in lastPost(server).body!).toBe(false);
  });

  it.each(['explain', 'equation', 'figure', 'chat'] as const)('%s thread follow-up: visible and deep:true in messages.create', async (kind) => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadData(kind));
    fireEvent.click(await screen.findByTestId('thread-item'));
    await screen.findByTestId('message-assistant');
    fireEvent.click(toggle());
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '후속' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(lastPost(server)).toMatchObject({ url: '/api/threads/t1/messages', body: { text: '후속', deep: true } });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('absent on a translate thread; the first explain request and "다시 생성" never carry deep', async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadData('translate'));
    fireEvent.click(await screen.findByTestId('thread-item'));
    await screen.findByTestId('message-assistant');
    expect(screen.queryByTestId('pn-deep-toggle')).toBeNull();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect('deep' in lastPost(server).body!).toBe(false);
    cleanup();

    const s2 = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} })).server;
    await screen.findByText('아직 대화가 없습니다');
    fireEvent.click(toggle()); // turned on, but an explain action is not a chat input
    act(() => useReaderStore.getState().requestAction({ kind: 'explain', anchor: anchorOf('robust kernel'), text: 'robust kernel' }));
    await waitFor(() => expect(s2.streamCount()).toBe(1));
    expect(lastPost(s2).body!.kind).toBe('explain');
    expect('deep' in lastPost(s2).body!).toBe(false);
  });

  it('in progress: run.started{effort:"high"} + run.thinking → "깊게" and "생각 중"; the stored answer with effort high keeps "깊게"', async () => {
    const data = { threads: [] as ReturnType<typeof threadDto>[], messages: {} as Record<string, ReturnType<typeof messageDto>[]> };
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi(data));
    await screen.findByText('아직 대화가 없습니다');
    fireEvent.click(toggle());
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '깊은 질문' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    data.threads.push(threadDto('td', { kind: 'chat', title: '깊은 질문' }));
    data.messages.td = [messageDto('ud', 'td', 'user', '깊은 질문'), messageDto('ad', 'td', 'assistant', '', { status: 'streaming' })];
    await act(async () => server.push(ev.accepted({ runId: 'rd', threadId: 'td', messageId: 'ad', task: 'chat' }), ev.started('high'), ev.thinking(1200)));
    const live = await screen.findByTestId('live-message');
    await waitFor(() => expect(within(live).getByTestId('pn-deep-label').textContent).toBe('깊게'));
    expect(within(live).getByTestId('run-status').textContent).toMatch(/생각 중…/);
    expect(live.dataset.thinking).toBe('1');

    data.messages.td = [messageDto('ud', 'td', 'user', '깊은 질문'), messageDto('ad', 'td', 'assistant', '깊은 답 [[G]]', { effort: 'high', llmCallId: 'rd' })];
    await act(async () => {
      server.push(ev.delta('깊은 답 [[G]]'), ev.done('깊은 답 [[G]]'));
      server.end();
    });
    await waitFor(() => expect(within(screen.getByTestId('live-message')).queryByTestId('run-status')).toBeNull());
    expect(within(screen.getByTestId('live-message')).getByTestId('pn-deep-label')).toBeTruthy();
  });

  it('a stored chat answer with effort high shows "깊게"; low / the first equation answer do not', async () => {
    const T = threadDto('tq', { kind: 'equation', equationId: 'e1', title: '식' });
    renderWithApi(
      <AiTab paperId={PAPER} />,
      threadsApi({ threads: [T], messages: { tq: [messageDto('u1', 'tq', 'user', '식'), messageDto('a1', 'tq', 'assistant', '깊이 읽기 [[G]]', { effort: 'high' }), messageDto('u2', 'tq', 'user', '후속'), messageDto('a2', 'tq', 'assistant', '후속 답 [[G]]', { effort: 'high' }), messageDto('u3', 'tq', 'user', '후속2'), messageDto('a3', 'tq', 'assistant', '보통 답 [[G]]', { effort: 'low' })] } }),
    );
    fireEvent.click(await screen.findByTestId('thread-item'));
    const answers = await screen.findAllByTestId('message-assistant');
    expect(answers.map((a) => within(a).queryByTestId('pn-deep-label') !== null)).toEqual([false, true, false]);
  });
});
