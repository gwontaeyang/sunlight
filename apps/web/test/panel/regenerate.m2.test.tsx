// "다시 생성" in threads with more than one turn (review D-R1-01): the replaced turn is pinned by id when the button is
// pressed, so after the new answer is done and threads.get is re-read the earlier turns stay visible, the live answer
// keeps its server task (glossary suggestions on a figure / equation follow-up, none on a first answer) and a
// regenerated high-effort chat answer shows "깊게" while live. Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Anchor } from '@study-paper/shared/contracts/domain';
import type { MessageDto } from '@study-paper/shared/contracts/api';
import { AiTab } from '../../src/panel/AiTab';
import { qk } from '../../src/api/queryKeys';
import { PAPER, anchorOf, messageDto, renderWithApi, resetReader, threadDto, threadsApi } from './panelHarness';
import { ev, type JsonHandler } from './sseFake';

afterEach(cleanup);
beforeEach(() => resetReader(true));

const AREA: Anchor = { kind: 'area', rects: [{ page: 2, x: 0.1, y: 0.2, w: 0.4, h: 0.3 }] };
const G = '<glossary><term name="robust kernel">outlier 가중치를 줄이는 장치</term></glossary>';

function twoTurn(kind: 'figure' | 'equation' | 'chat' | 'explain') {
  const T = threadDto('t', { kind, title: kind, anchor: kind === 'figure' ? AREA : anchorOf('q'), equationId: kind === 'equation' ? 'e1' : null });
  const messages: Record<string, MessageDto[]> = {
    t: [
      messageDto('u0', 't', 'user', '첫 질문'),
      messageDto('a0', 't', 'assistant', `첫 답 [[G]]\n\n${G}`, { llmCallId: 'run-0' }),
      messageDto('u1', 't', 'user', '질문후속'),
      messageDto('a1', 't', 'assistant', `후속 답 [[G]]\n\n${G}`, { llmCallId: 'run-1' }),
    ],
  };
  return { T, data: { threads: [T], messages } };
}

async function openThread() {
  fireEvent.click(await screen.findByTestId('thread-item'));
  await waitFor(() => expect(screen.getAllByTestId('message-assistant').length).toBeGreaterThan(0));
}

describe('regenerate of the last turn in a 2-turn thread', () => {
  it.each(['figure', 'equation'] as const)('%s: after done + refetch the first turn stays, one second answer, its suggestions kept', async (kind) => {
    const { data } = twoTurn(kind);
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi(data));
    await openThread();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted({ runId: 'r9', threadId: 't', messageId: 'a9', task: 'chat' }), ev.started(), ev.delta('새 후속')));
    // While it runs: both earlier answers visible, the replaced one marked.
    const during = screen.getAllByTestId('message-assistant');
    expect(during.map((a) => a.dataset.beingReplaced ?? '')).toEqual(['', '1']);
    // Success: the server replaced the old turn (u1, a1) by (u9, a9); the refetch returns the new turn.
    data.messages.t = [data.messages.t![0]!, data.messages.t![1]!, messageDto('u9', 't', 'user', '질문후속'), messageDto('a9', 't', 'assistant', `새 후속 답 [[G]]\n\n${G}`, { llmCallId: 'r9' })];
    await act(async () => {
      server.push(ev.done(`새 후속 답 [[G]]\n\n${G}`));
      server.end();
    });
    await waitFor(() => expect(screen.getAllByTestId('message-user').map((u) => u.textContent)).toEqual([expect.stringContaining('첫 질문'), expect.stringContaining('질문후속')]));
    const stored = screen.getAllByTestId('message-assistant');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.textContent).toContain('첫 답');
    const live = screen.getByTestId('live-message');
    expect(live.dataset.phase).toBe('done');
    expect(within(live).getByTestId('pn-glossary-suggestions')).toBeTruthy(); // server task chat (follow-up)
    expect(within(stored[0]!).queryByTestId('pn-glossary-suggestions')).toBeNull(); // first figure/equation answer
  });

  it('regenerating the FIRST answer of a figure thread: the live answer offers no suggestions (figure_area)', async () => {
    const T = threadDto('f', { kind: 'figure', anchor: AREA, title: '그림' });
    const data = { threads: [T], messages: { f: [messageDto('u0', 'f', 'user', '그림 설명'), messageDto('a0', 'f', 'assistant', `그림 답 [[G]]\n\n${G}`)] } as Record<string, MessageDto[]> };
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi(data));
    await openThread();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    data.messages.f = [messageDto('u9', 'f', 'user', '그림 설명'), messageDto('a9', 'f', 'assistant', `새 그림 답 [[G]]\n\n${G}`)];
    await act(async () => {
      server.push(ev.accepted({ runId: 'r9', threadId: 'f', messageId: 'a9', task: 'figure_area' }), ev.started(), ev.done(`새 그림 답 [[G]]\n\n${G}`));
      server.end();
    });
    await waitFor(() => expect(screen.getAllByTestId('message-user')).toHaveLength(1));
    expect(screen.queryAllByTestId('message-assistant')).toHaveLength(0);
    const live = screen.getByTestId('live-message');
    expect(live.dataset.phase).toBe('done');
    expect(within(live).queryByTestId('pn-glossary-suggestions')).toBeNull();
  });

  it('a regenerated high-effort chat answer shows "깊게" while live and when done; a regenerated first explain answer does not', async () => {
    const { data } = twoTurn('chat');
    data.messages.t![3] = { ...data.messages.t![3]!, effort: 'high' };
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi(data));
    await openThread();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted({ runId: 'r9', threadId: 't', messageId: 'a9', task: 'chat' }), ev.started('high'), ev.thinking(10)));
    const live = await screen.findByTestId('live-message');
    await waitFor(() => expect(within(live).getByTestId('pn-deep-label')).toBeTruthy());
    await act(async () => {
      server.push(ev.done('다시 생성한 깊은 답'));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('done'));
    expect(within(screen.getByTestId('live-message')).getByTestId('pn-deep-label')).toBeTruthy();

    cleanup();
    resetReader(true);
    const E = threadDto('e', { kind: 'explain', anchor: anchorOf('q'), title: 'q' });
    const r = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [E], messages: { e: [messageDto('u0', 'e', 'user', 'q'), messageDto('a0', 'e', 'assistant', '설명 [[G]]')] } }));
    await openThread();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(r.server.streamCount()).toBe(1));
    await act(async () => r.server.push(ev.accepted({ runId: 'r8', threadId: 'e', messageId: 'a8', task: 'explain_selection' }), ev.started('high')));
    await screen.findByTestId('live-message');
    expect(screen.queryByTestId('pn-deep-label')).toBeNull();
  });
});

/** threadsApi whose threads.get replies are held while `held.on` (the refetch after a done run has not come back yet). */
function heldThreadsApi(data: Parameters<typeof threadsApi>[0]) {
  const inner = threadsApi(data);
  const held = { on: false, waiting: [] as (() => void)[] };
  const handler: JsonHandler = (c) => {
    if (held.on && c.method === 'GET' && /^\/api\/threads\/[^/]+$/.test(c.url)) return new Promise((r) => held.waiting.push(() => r(inner(c) as Awaited<ReturnType<JsonHandler>>)));
    return inner(c);
  };
  return { handler, held };
}

describe('"다시 생성" again before the refetch (review D-R2-02)', () => {
  const regenBodies = (calls: { method: string; url: string; body?: Record<string, unknown> | null }[]) =>
    calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.url) && c.body?.regenerate === true).map((c) => c.body!.text);

  it('chat thread: the second regenerate asks the replaced turn\'s question, not the turn before it', async () => {
    const { data } = twoTurn('chat');
    const { handler, held } = heldThreadsApi(data);
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, handler);
    await openThread();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    held.on = true; // the refetch after this run will not come back
    await act(async () => {
      server.push(ev.accepted({ runId: 'r9', threadId: 't', messageId: 'a9', task: 'chat' }), ev.started(), ev.done('새 후속 답'));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('done'));
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(regenBodies(server.calls)).toEqual(['질문후속', '질문후속']);
    // Same after a follow-up whose refetch has not come back: regenerate asks that follow-up's question.
    await act(async () => {
      server.push(ev.accepted({ runId: 'r10', threadId: 't', messageId: 'a10', task: 'chat' }), ev.started(), ev.done('또 새 답'));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('done'));
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '셋째 질문' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(3));
    await act(async () => {
      server.push(ev.accepted({ runId: 'r11', threadId: 't', messageId: 'a11', task: 'chat' }), ev.started(), ev.done('셋째 답'));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('done'));
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(4));
    expect(regenBodies(server.calls)).toEqual(['질문후속', '질문후속', '셋째 질문']);
    held.on = false;
    for (const w of held.waiting.splice(0)) w();
  });

  it.each(['figure', 'equation'] as const)('%s thread: regenerating the first answer twice keeps its server task (no suggestions, no "깊게")', async (kind) => {
    const T = threadDto('f', { kind, anchor: kind === 'figure' ? AREA : anchorOf('q'), equationId: kind === 'equation' ? 'e1' : null, title: kind });
    const data = { threads: [T], messages: { f: [messageDto('u0', 'f', 'user', '처음 요청'), messageDto('a0', 'f', 'assistant', `첫 답 [[G]]\n\n${G}`)] } as Record<string, MessageDto[]> };
    const { handler, held } = heldThreadsApi(data);
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, handler);
    await openThread();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    held.on = true;
    await act(async () => {
      server.push(ev.accepted({ runId: 'r9', threadId: 'f', messageId: 'a9', task: kind === 'figure' ? 'figure_area' : 'equation_deep' }), ev.started('high'), ev.done(`새 답 [[G]]\n\n${G}`));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('done'));
    expect(within(screen.getByTestId('live-message')).queryByTestId('pn-glossary-suggestions')).toBeNull();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(regenBodies(server.calls)).toEqual(['처음 요청', '처음 요청']);
    await act(async () => server.push(ev.accepted({ runId: 'r10', threadId: 'f', messageId: 'a10', task: kind === 'figure' ? 'figure_area' : 'equation_deep' }), ev.started('high'), ev.thinking(5)));
    await screen.findByTestId('live-message');
    expect(screen.queryByTestId('pn-deep-label')).toBeNull();
    await act(async () => {
      server.push(ev.done(`다시 새 답 [[G]]\n\n${G}`));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('done'));
    const live = screen.getByTestId('live-message');
    expect(within(live).queryByTestId('pn-glossary-suggestions')).toBeNull();
    expect(within(live).queryByTestId('pn-deep-label')).toBeNull();
    held.on = false;
    for (const w of held.waiting.splice(0)) w();
  });
});

// Review D-R3-02: AiTab re-reads threads.get at run.accepted, so while a "다시 생성" runs (and right after it) the stored
// thread holds the OLD turn and the NEW one side by side (the server keeps the old turn until the new answer is stored,
// and drops the new one if the run fails). A second "다시 생성" pressed before the next refetch must still pin the turn
// the server will replace at its real position — counting neither the turn already replaced nor a discarded one.
describe('"다시 생성" again while the stored thread holds the old and the new turn (review D-R3-02)', () => {
  const regenBodies = (calls: { method: string; url: string; body?: Record<string, unknown> | null }[]) =>
    calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.url) && c.body?.regenerate === true).map((c) => c.body!.text);
  const storedIds = (qc: ReturnType<typeof renderWithApi>['qc'], id: string) => (qc.getQueryData(qk.thread(id)) as { messages: MessageDto[] } | undefined)?.messages.map((m) => m.id) ?? [];
  const taskOf = (kind: 'figure' | 'equation') => (kind === 'figure' ? 'figure_area' : 'equation_deep') as 'figure_area' | 'equation_deep';

  it.each(['figure', 'equation'] as const)('%s thread: the first answer regenerated twice (accepted refetch = old + new turn) keeps its server task', async (kind) => {
    const T = threadDto('f', { kind, anchor: kind === 'figure' ? AREA : anchorOf('q'), equationId: kind === 'equation' ? 'e1' : null, title: kind });
    const data = { threads: [T], messages: { f: [messageDto('u0', 'f', 'user', '처음 요청'), messageDto('a0', 'f', 'assistant', `첫 답 [[G]]\n\n${G}`)] } as Record<string, MessageDto[]> };
    const { handler, held } = heldThreadsApi(data);
    const { server, qc } = renderWithApi(<AiTab paperId={PAPER} />, handler);
    await openThread();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    // run.accepted: the server holds the old turn and the new (streaming) one; the refetch returns both.
    data.messages.f = [...data.messages.f!, messageDto('u9', 'f', 'user', '처음 요청'), messageDto('a9', 'f', 'assistant', '', { status: 'streaming' })];
    await act(async () => server.push(ev.accepted({ runId: 'r9', threadId: 'f', messageId: 'a9', task: taskOf(kind) }), ev.started('high')));
    await waitFor(() => expect(storedIds(qc, 'f')).toEqual(['u0', 'a0', 'u9', 'a9']));
    held.on = true; // the refetch after done does not come back yet
    await act(async () => {
      server.push(ev.done(`새 답 [[G]]\n\n${G}`));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('done'));
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(regenBodies(server.calls)).toEqual(['처음 요청', '처음 요청']);
    await act(async () => server.push(ev.accepted({ runId: 'r10', threadId: 'f', messageId: 'a10', task: taskOf(kind) }), ev.started('high'), ev.thinking(5)));
    await screen.findByTestId('live-message');
    expect(screen.queryByTestId('pn-deep-label')).toBeNull();
    await act(async () => {
      server.push(ev.done(`다시 새 답 [[G]]\n\n${G}`));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('done'));
    let live = screen.getByTestId('live-message');
    expect(within(live).queryByTestId('pn-glossary-suggestions')).toBeNull();
    expect(within(live).queryByTestId('pn-deep-label')).toBeNull();
    // The refetches come back with the real state: still none on the live answer.
    data.messages.f = [messageDto('u10', 'f', 'user', '처음 요청'), messageDto('a10', 'f', 'assistant', `다시 새 답 [[G]]\n\n${G}`)];
    held.on = false;
    await act(async () => {
      for (const w of held.waiting.splice(0)) w();
    });
    await waitFor(() => expect(storedIds(qc, 'f')).toEqual(['u10', 'a10']));
    live = screen.getByTestId('live-message');
    expect(within(live).queryByTestId('pn-glossary-suggestions')).toBeNull();
    expect(within(live).queryByTestId('pn-deep-label')).toBeNull();
    expect(screen.queryAllByTestId('pn-glossary-suggestions')).toHaveLength(0);
  });

  it.each(['figure', 'equation'] as const)('%s thread: a FAILED regenerate (its new turn still listed) — pressing again pins the kept old turn', async (kind) => {
    const T = threadDto('f', { kind, anchor: kind === 'figure' ? AREA : anchorOf('q'), equationId: kind === 'equation' ? 'e1' : null, title: kind });
    const data = { threads: [T], messages: { f: [messageDto('u0', 'f', 'user', '처음 요청'), messageDto('a0', 'f', 'assistant', `첫 답 [[G]]\n\n${G}`)] } as Record<string, MessageDto[]> };
    const { handler, held } = heldThreadsApi(data);
    const { server, qc } = renderWithApi(<AiTab paperId={PAPER} />, handler);
    await openThread();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    data.messages.f = [...data.messages.f!, messageDto('u9', 'f', 'user', '처음 요청'), messageDto('a9', 'f', 'assistant', '', { status: 'streaming' })];
    await act(async () => server.push(ev.accepted({ runId: 'r9', threadId: 'f', messageId: 'a9', task: taskOf(kind) }), ev.started('high')));
    await waitFor(() => expect(storedIds(qc, 'f')).toEqual(['u0', 'a0', 'u9', 'a9']));
    held.on = true;
    // The run fails: the server drops the new turn and keeps the old one (the refetch has not come back).
    data.messages.f = data.messages.f.slice(0, 2);
    await act(async () => {
      server.push(ev.error('cli_error'));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('error'));
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(regenBodies(server.calls)).toEqual(['처음 요청', '처음 요청']);
    await act(async () => server.push(ev.accepted({ runId: 'r10', threadId: 'f', messageId: 'a10', task: taskOf(kind) }), ev.started('high'), ev.done(`다시 새 답 [[G]]\n\n${G}`)));
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('done'));
    const live = screen.getByTestId('live-message');
    expect(within(live).queryByTestId('pn-glossary-suggestions')).toBeNull();
    expect(within(live).queryByTestId('pn-deep-label')).toBeNull();
    held.on = false;
    for (const w of held.waiting.splice(0)) w();
  });

  it('chat: a follow-up that failed before any refetch came back — "다시 생성" asks that follow-up\'s question', async () => {
    const T = threadDto('c', { kind: 'chat', title: 'chat' });
    const data = { threads: [T], messages: { c: [messageDto('u0', 'c', 'user', '첫 질문'), messageDto('a0', 'c', 'assistant', '첫 답')] } as Record<string, MessageDto[]> };
    const { handler, held } = heldThreadsApi(data);
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, handler);
    await openThread();
    held.on = true; // no refetch comes back from here on
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '둘째 질문' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted({ runId: 'r1', threadId: 'c', messageId: 'a1', task: 'chat' }), ev.started(), ev.delta('일부'), ev.error('cli_error', '일부'));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('live-message').dataset.phase).toBe('error'));
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(regenBodies(server.calls)).toEqual(['둘째 질문']);
    held.on = false;
    for (const w of held.waiting.splice(0)) w();
  });
});
