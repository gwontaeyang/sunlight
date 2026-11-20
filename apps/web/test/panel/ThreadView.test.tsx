// ThreadView / AI tab: cancel, error with partial text, follow-up question, disabled before context_ready,
// stream_interrupted retry. Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiTab } from '../../src/panel/AiTab';
import { ThreadView } from '../../src/panel/ThreadView';
import { useRunStream } from '../../src/panel/useRunStream';
import { usePanelApi } from '../../src/panel/panelApi';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, STATS, anchorOf, messageDto, renderWithApi, resetReader, threadDto, threadsApi } from './panelHarness';
import { ev } from './sseFake';

afterEach(cleanup);
beforeEach(() => resetReader(true));

function Harness({ threadId, contextReady = true }: { threadId: string | null; contextReady?: boolean }) {
  const run = useRunStream({ client: usePanelApi() });
  return <ThreadView paperId={PAPER} threadId={threadId} run={run} contextReady={contextReady} />;
}

const T1 = threadDto('t1', { kind: 'explain', title: 'We estimate the robot pose', anchor: anchorOf('We estimate the robot pose') });
const T1_MESSAGES = [
  messageDto('u1', 't1', 'user', 'We estimate the robot pose'),
  messageDto('a1', 't1', 'assistant', '요지 <q>We estimate the robot pose</q> [[P]]', {
    citations: [{ ordinal: 1, kind: 'quote', quote: 'We estimate the robot pose', status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 26 } }],
    stats: STATS,
  }),
];

describe('ThreadView', () => {
  it('disables the input and buttons before context_ready', async () => {
    resetReader(false);
    useReaderStore.setState({ selection: { anchor: anchorOf('abc'), text: 'abc' } });
    renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    expect(screen.getByTestId('context-not-ready').textContent).toContain('색인 준비 중');
    const input = screen.getByTestId('followup-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect((screen.getByTestId('followup-send') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('explain-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('restores stored messages with their citation states (threads.get)', async () => {
    renderWithApi(<Harness threadId="t1" />, threadsApi({ threads: [T1], messages: { t1: T1_MESSAGES } }));
    await screen.findByTestId('message-assistant');
    expect(screen.getByTestId('message-user').textContent).toContain('We estimate the robot pose');
    const a = screen.getByTestId('message-assistant');
    expect(within(a).getByTestId('sp-chip').dataset.status).toBe('verbatim');
    expect(within(a).getByTestId('sp-badge').textContent).toBe('논문 근거 · 인용 원문에서 찾음');
    expect(within(a).getByTestId('sp-stats').textContent).toContain('찾지 못함 1');
  });

  it('a citation chip calls readerStore.jumpToCitation; without a viewer it shows "위치 미확정"', async () => {
    renderWithApi(<Harness threadId="t1" />, threadsApi({ threads: [T1], messages: { t1: T1_MESSAGES } }));
    const chip = await screen.findByTestId('sp-chip');
    await act(async () => fireEvent.click(chip));
    expect(await screen.findByText('위치 미확정')).toBeTruthy();
  });

  it('follow-up question: messages.create with text + clientRequestId, streams, then shows the final answer', async () => {
    const { server } = renderWithApi(<Harness threadId="t1" />, threadsApi({ threads: [T1], messages: { t1: T1_MESSAGES } }));
    await screen.findByTestId('message-assistant');
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '왜 point-to-point인가요?' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    const call = server.calls.find((c) => c.method === 'POST')!;
    expect(call.url).toBe('/api/threads/t1/messages');
    expect(call.body).toMatchObject({ text: '왜 point-to-point인가요?' });
    expect(typeof call.body!.clientRequestId).toBe('string');
    expect((screen.getByTestId('followup-input') as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => server.push(ev.accepted({ runId: 'r2', threadId: 't1', messageId: 'a2', task: 'chat' }), ev.started(), ev.delta('답변 <q>We estimate the robot pose</q> [[P]]')));
    const live = await screen.findByTestId('live-message');
    await waitFor(() => expect(within(live).getByTestId('sp-phase-note').textContent).toBe('생성 중 · 인용 확인 전'));
    expect(within(live).getByTestId('sp-chip').dataset.status).toBe('pending');

    await act(async () => {
      server.push(ev.done('답변 <q>We estimate the robot pose</q> [[P]]', [{ ordinal: 1, kind: 'quote', quote: 'We estimate the robot pose', status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 26 } }], STATS));
      server.end();
    });
    await waitFor(() => expect(within(screen.getByTestId('live-message')).getByTestId('sp-chip').dataset.status).toBe('verbatim'));
    expect(within(screen.getByTestId('live-message')).queryByTestId('sp-phase-note')).toBeNull();
    expect(within(screen.getByTestId('live-message')).getByTestId('sp-badge').dataset.status).toBe('p-grounded');
    expect((screen.getByTestId('followup-input') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('cancel while streaming: llm.runs.cancel, then "취소했습니다" with the partial text kept as "확인 안 됨"', async () => {
    const { server } = renderWithApi(<Harness threadId="t1" />, threadsApi({ threads: [T1], messages: { t1: T1_MESSAGES } }));
    server.onCancel(() => {
      server.push(ev.error('cancelled', '부분 답 <q>We estimate</q>'));
      server.end();
    });
    await screen.findByTestId('message-assistant');
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '질문' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted({ runId: 'r3', threadId: 't1', messageId: 'a3' }), ev.queued(1)));
    expect((await screen.findByTestId('run-status')).textContent).toContain('대기 중');
    await act(async () => fireEvent.click(screen.getByTestId('run-cancel')));
    await waitFor(() => expect(screen.getByTestId('run-error').dataset.code).toBe('cancelled'));
    expect(server.calls.some((c) => c.method === 'POST' && c.url === '/api/llm/runs/r3/cancel')).toBe(true);
    const live = screen.getByTestId('live-message');
    expect(live.textContent).toContain('취소했습니다');
    expect(live.textContent).toContain('부분 답');
    expect(within(live).getByTestId('sp-chip').dataset.status).toBe('unchecked');
    expect(screen.queryByTestId('run-cancel')).toBeNull();
  });

  it('whole-paper question in the AI tab: run.error keeps the partial text; thinking state is shown', async () => {
    const TN = threadDto('tn', { kind: 'chat', title: '이 논문의 기여는?' });
    const data = { threads: [] as ReturnType<typeof threadDto>[], messages: { tn: [messageDto('un', 'tn', 'user', '이 논문의 기여는?'), messageDto('a5', 'tn', 'assistant', '', { status: 'streaming' })] } };
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi(data));
    await screen.findByText('아직 대화가 없습니다');
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '이 논문의 기여는?' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    const call = server.calls.find((c) => c.method === 'POST')!;
    expect(call.url).toBe(`/api/papers/${PAPER}/threads`);
    expect(call.body).toMatchObject({ kind: 'chat', question: '이 논문의 기여는?' });

    data.threads.push(TN); // the server created the thread
    await act(async () => server.push(ev.accepted({ runId: 'r5', threadId: 'tn', messageId: 'a5', task: 'chat' }), ev.started(), ev.thinking(300)));
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toMatch(/생각 중….*약 300 tokens/));
    await waitFor(() => expect(screen.getByTestId('message-user').textContent).toContain('이 논문의 기여는?'));
    expect(screen.queryByTestId('message-assistant')).toBeNull(); // the stored placeholder is replaced by the live message
    await act(async () => {
      server.push(ev.delta('지금까지 '), ev.error('idle_timeout', '지금까지 받은 글'));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('run-error').dataset.code).toBe('idle_timeout'));
    const live = screen.getByTestId('live-message');
    expect(live.textContent).toContain('지금까지 받은 글');
    expect(live.textContent).toContain('중단 전까지 받은 부분');
    expect(within(live).getByTestId('sp-phase-note').textContent).toContain('확인 안 됨');
    expect(screen.getByTestId('thread-title').textContent).toContain('[질문]');
  });

  it('stream_interrupted: offers "다시 연결" (same clientRequestId) and "thread 다시 열기"', async () => {
    const { server } = renderWithApi(<Harness threadId="t1" />, threadsApi({ threads: [T1], messages: { t1: T1_MESSAGES } }));
    await screen.findByTestId('message-assistant');
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '질문' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted({ runId: 'r4', threadId: 't1', messageId: 'a4' }), ev.delta('부분'));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('run-error').dataset.code).toBe('stream_interrupted'));
    expect(screen.getByTestId('run-error').textContent).toContain('연결이 끊겼습니다');
    expect(screen.getByTestId('run-reopen')).toBeTruthy();
    fireEvent.click(screen.getByTestId('run-retry'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    const posts = server.calls.filter((c) => c.method === 'POST');
    expect(posts[1]!.body!.clientRequestId).toBe(posts[0]!.body!.clientRequestId);
  });

  it('long time to first text: a clear "생각 중" state with elapsed seconds until the first delta', async () => {
    const { server } = renderWithApi(<Harness threadId="t1" />, threadsApi({ threads: [T1], messages: { t1: T1_MESSAGES } }));
    await screen.findByTestId('message-assistant');
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '질문' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted({ runId: 'r6', threadId: 't1', messageId: 'a6', task: 'chat' }), ev.started(), ev.response()));
    const live = await screen.findByTestId('live-message');
    await waitFor(() => expect(live.dataset.thinking).toBe('1'));
    expect(screen.getByTestId('run-status').textContent).toMatch(/^생각 중… · \d+초 — 첫 글자까지 수십 초 걸릴 수 있습니다$/);
    await act(async () => server.push(ev.delta('첫 글자')));
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.thinking).toBeUndefined());
    expect(screen.getByTestId('run-status').textContent).toBe('답변 생성 중');
  });

  it('regenerate (replace-on-success): the old answer stays visible, marked, while the new one streams; on failure it stays', async () => {
    const { server } = renderWithApi(<Harness threadId="t1" />, threadsApi({ threads: [T1], messages: { t1: T1_MESSAGES } }));
    fireEvent.click(await screen.findByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted({ runId: 'r7', threadId: 't1', messageId: 'a7' }), ev.started(), ev.delta('새 답 일부')));
    const old = await screen.findByTestId('message-assistant');
    expect(old.dataset.beingReplaced).toBe('1');
    expect(within(old).getByTestId('message-being-replaced').textContent).toContain('새 답변이 저장되면 바뀝니다');
    expect(within(old).getByTestId('sp-chip').dataset.status).toBe('verbatim'); // old citations still usable
    await act(async () => {
      server.push({ event: 'run.error', data: { code: 'rate_limited', message: 'rate_limited', retryable: false, partialText: '새 답 일부' } });
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('run-error').dataset.code).toBe('rate_limited'));
    expect(screen.getByTestId('regenerate-kept').textContent).toContain('이전 답변을 그대로 두었습니다');
    const kept = screen.getByTestId('message-assistant');
    expect(kept.dataset.beingReplaced).toBeUndefined();
    expect(kept.textContent).toContain('요지');
    expect(screen.getAllByTestId('message-user')).toHaveLength(1);
  });

  it('regenerate success: the old turn is hidden once the new answer is done; a server refetch with the new turn shows it once', async () => {
    const data = { threads: [T1], messages: { t1: [...T1_MESSAGES] } };
    const { server } = renderWithApi(<Harness threadId="t1" />, threadsApi(data));
    fireEvent.click(await screen.findByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted({ runId: 'r8', threadId: 't1', messageId: 'a8' }), ev.started(), ev.done('새 답 <q>We estimate the robot pose</q> [[P]]'));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('done'));
    expect(screen.queryByTestId('message-assistant')).toBeNull();
    expect(screen.queryByTestId('message-user')).toBeNull();
    expect(screen.getByTestId('live-message').textContent).toContain('다시 생성한 답변');
  });

  it('persist_failed: the answer is shown as not stored', async () => {
    const { server } = renderWithApi(<Harness threadId="t1" />, threadsApi({ threads: [T1], messages: { t1: T1_MESSAGES } }));
    await screen.findByTestId('message-assistant');
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '질문' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted({ runId: 'r9', threadId: 't1', messageId: 'a9' }), ev.started(), ev.delta('전체 답'), { event: 'run.error', data: { code: 'persist_failed', message: 'x', retryable: false, partialText: '전체 답' } });
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('run-error').dataset.code).toBe('persist_failed'));
    expect(screen.getByTestId('run-error').textContent).toContain('저장하지 못했습니다');
    expect(screen.getByTestId('run-error').textContent).toContain('저장되지 않은 답변');
  });

  it('regenerate sends messages.create {regenerate:true} with the last question', async () => {
    const { server } = renderWithApi(<Harness threadId="t1" />, threadsApi({ threads: [T1], messages: { t1: T1_MESSAGES } }));
    fireEvent.click(await screen.findByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(server.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ text: 'We estimate the robot pose', regenerate: true });
  });
});
