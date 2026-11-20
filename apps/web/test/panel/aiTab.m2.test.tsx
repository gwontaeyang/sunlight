// AI tab M2 (BRIEF_D D2): the 7 reader actions, translate (readable only, plain, no follow-up input), the figure
// thread's capture image (blob URL, revoked), findReusableThread's M2 rules, the collapsed selection text,
// run.retrying. Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Anchor } from '@study-paper/shared/contracts/domain';
import { AiTab } from '../../src/panel/AiTab';
import { findReusableThread } from '../../src/panel/threadReuse';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, anchorOf, messageDto, renderWithApi, resetReader, threadDto, threadsApi } from './panelHarness';
import { ev } from './sseFake';
import { TEST_PNG_BASE64, testPngBytes } from './testPng';

afterEach(cleanup);
beforeEach(() => resetReader(true));

const AREA: Anchor = { kind: 'area', rects: [{ page: 2, x: 0.1, y: 0.2, w: 0.4, h: 0.3 }] };
const PNG = TEST_PNG_BASE64;
const posts = (server: { calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] }) => server.calls.filter((c) => c.method === 'POST');
const request = (a: Parameters<ReturnType<typeof useReaderStore.getState>['requestAction']>[0]) => act(() => useReaderStore.getState().requestAction(a));

describe('findReusableThread (M2 rules)', () => {
  const t = (id: string, o: Parameters<typeof threadDto>[1]) => threadDto(id, o);
  it('explain / translate: same kind + same quote, newest COMPLETE thread only', () => {
    const list = [t('e1', { kind: 'explain', anchor: anchorOf('q'), updatedAt: 1 }), t('tr1', { kind: 'translate', anchor: anchorOf('q'), updatedAt: 2 }), t('tr2', { kind: 'translate', anchor: anchorOf('q'), updatedAt: 3, lastMessageStatus: 'error' })];
    expect(findReusableThread(list, { kind: 'translate', anchor: anchorOf('q') })?.id).toBe('tr1');
    expect(findReusableThread(list, { kind: 'explain', anchor: anchorOf('q') })?.id).toBe('e1');
    expect(findReusableThread([t('x', { kind: 'explain', anchor: anchorOf('q'), lastMessageStatus: 'streaming' })], { kind: 'explain', anchor: anchorOf('q') })).toBeNull();
  });
  it('equation + equationId: the newest complete equation thread of that equation; incomplete → null', () => {
    const list = [t('q1', { kind: 'equation', equationId: 'eq-1', updatedAt: 1 }), t('q2', { kind: 'equation', equationId: 'eq-1', updatedAt: 5, lastMessageStatus: 'interrupted' }), t('q3', { kind: 'equation', equationId: 'eq-2', updatedAt: 9 })];
    expect(findReusableThread(list, { kind: 'equation', equationId: 'eq-1' })?.id).toBe('q1');
    expect(findReusableThread([list[1]!], { kind: 'equation', equationId: 'eq-1' })).toBeNull();
  });
  it('a capture (figure, equation with an image) and ask always start new', () => {
    const list = [t('f', { kind: 'figure', anchor: AREA }), t('q', { kind: 'equation', equationId: null, anchor: AREA }), t('c', { kind: 'chat', anchor: anchorOf('q') })];
    expect(findReusableThread(list, { kind: 'figure', anchor: AREA, imagePng: PNG })).toBeNull();
    expect(findReusableThread(list, { kind: 'equation', anchor: AREA, imagePng: PNG })).toBeNull();
    expect(findReusableThread(list, { kind: 'ask', anchor: anchorOf('q') })).toBeNull();
  });
});

describe('AI tab actions', () => {
  it('translate: readable is enough (AI context not ready) → threads.create {kind:"translate"}', async () => {
    resetReader(false); // contextReady false, readable true
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    request({ kind: 'translate', anchor: anchorOf('robust kernel'), text: 'robust kernel' });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(posts(server)[0]).toMatchObject({ url: `/api/papers/${PAPER}/threads`, body: { kind: 'translate', text: 'robust kernel', anchor: { quote: { exact: 'robust kernel' } } } });
    expect(posts(server)[0]!.body!.deep).toBeUndefined();
  });

  it('translate of the same quote re-opens the complete translate thread; its answer is plain, no follow-up input, "다시 생성"', async () => {
    const T = threadDto('tr', { kind: 'translate', anchor: anchorOf('robust kernel'), title: 'robust kernel' });
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [T], messages: { tr: [messageDto('u', 'tr', 'user', 'robust\n  kernel'), messageDto('a', 'tr', 'assistant', '강건 커널 <q>robust kernel</q> [[P]] [x](#sp-cite-1)')] } }));
    await screen.findByTestId('thread-item');
    request({ kind: 'translate', anchor: anchorOf('robust kernel'), text: 'robust kernel' });
    const a = await screen.findByTestId('message-assistant');
    expect(posts(server)).toHaveLength(0);
    expect(within(a).queryAllByTestId('sp-chip')).toHaveLength(0);
    expect(within(a).queryAllByTestId('sp-badge')).toHaveLength(0);
    expect(a.textContent).toContain('<q>robust kernel</q>');
    expect(a.textContent).toContain('[[P]]');
    expect(screen.getByTestId('message-user').textContent).toContain('robust kernel'); // collapsed: one space
    expect(screen.getByTestId('message-user').textContent).not.toContain('\n');
    expect(screen.queryByTestId('followup-input')).toBeNull();
    expect(screen.queryByTestId('pn-deep-toggle')).toBeNull();
    fireEvent.click(screen.getByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(posts(server)[0]).toMatchObject({ url: '/api/threads/tr/messages', body: { regenerate: true } });
    expect(posts(server)[0]!.body!.deep).toBeUndefined();
  });

  it('a live translation streams and ends plain (parsed null)', async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    request({ kind: 'translate', text: 'x y' });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted({ runId: 'rt', threadId: 'tt', messageId: 'mt', task: 'translate_selection' }), ev.started(), ev.delta('번역 <q>x y</q>'), ev.doneParsed('번역 <q>x y</q>', null));
      server.end();
    });
    const live = await screen.findByTestId('live-message');
    await waitFor(() => expect(live.dataset.phase).toBe('done'));
    expect(within(live).queryAllByTestId('sp-chip')).toHaveLength(0);
    expect(live.textContent).toContain('<q>x y</q>');
  });

  it('ask: no run; the question input gets focus with the selection attached; sending creates a chat thread with it', async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    request({ kind: 'ask', anchor: anchorOf('point-to-point residual'), text: 'point-to-point\nresidual' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('followup-input')));
    expect(posts(server)).toHaveLength(0);
    expect(useReaderStore.getState().pendingAction).toBeNull();
    expect(screen.getByTestId('pn-ask-attachment').textContent).toContain('point-to-point residual');
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '이게 왜 필요한가요?' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(posts(server)[0]!.body).toMatchObject({ kind: 'chat', question: '이게 왜 필요한가요?', text: 'point-to-point\nresidual', anchor: { quote: { exact: 'point-to-point residual' } } });
    expect(screen.queryByTestId('pn-ask-attachment')).toBeNull();
  });

  it('figure capture → threads.create {kind:"figure", anchor, imagePng}, always a new thread', async () => {
    const F = threadDto('f-old', { kind: 'figure', anchor: AREA, imageFileId: 'file-1' });
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [F], messages: {} }));
    await screen.findByTestId('thread-item');
    request({ kind: 'figure', anchor: AREA, imagePng: PNG, capture: { widthPx: 40, heightPx: 30 } });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(posts(server)[0]!.body).toMatchObject({ kind: 'figure', anchor: AREA, imagePng: PNG });
  });

  it('equation: equationId re-opens its complete thread; an unfinished one gets a new run; a capture is always new', async () => {
    const done = threadDto('q-done', { kind: 'equation', equationId: 'eq-1', title: '식 (1)' });
    const open = threadDto('q-open', { kind: 'equation', equationId: 'eq-2', lastMessageStatus: 'error' });
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [done, open], messages: { 'q-done': [messageDto('u', 'q-done', 'user', '식 (1)'), messageDto('a', 'q-done', 'assistant', '깊이 읽기 답 [[G]]')] } }));
    await screen.findAllByTestId('thread-item');
    request({ kind: 'equation', equationId: 'eq-1' });
    await screen.findByText('깊이 읽기 답');
    expect(posts(server)).toHaveLength(0);
    expect(screen.getByTestId('panel-notice').textContent).toContain('다시 열었습니다');

    request({ kind: 'equation', equationId: 'eq-2' });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(posts(server)[0]!.body).toMatchObject({ kind: 'equation', equationId: 'eq-2' });
    await act(async () => {
      server.push(ev.accepted({ runId: 'rq', threadId: 'q-new', messageId: 'mq', task: 'equation_deep' }), ev.doneParsed('답', null));
      server.end();
    });
    request({ kind: 'equation', anchor: AREA, imagePng: PNG });
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(posts(server)[1]!.body).toMatchObject({ kind: 'equation', anchor: AREA, imagePng: PNG });
    expect(posts(server)[1]!.body!.equationId).toBeUndefined();
  });

  it('unsupported combinations only show a notice; glossary / note actions are left for their tabs', async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    request({ kind: 'figure', anchor: anchorOf('x') });
    await waitFor(() => expect(screen.getByTestId('panel-notice').textContent).toContain('캡처'));
    request({ kind: 'glossary', anchor: anchorOf('robust kernel'), text: 'robust kernel' });
    await act(async () => {});
    expect(useReaderStore.getState().pendingAction?.kind).toBe('glossary');
    request({ kind: 'note', highlightId: 'h1' });
    await act(async () => {});
    expect(useReaderStore.getState().pendingAction?.kind).toBe('note');
    expect(posts(server)).toHaveLength(0);
  });

  it('the selection text is shown with whitespace and line breaks collapsed', () => {
    useReaderStore.setState({ selection: { anchor: anchorOf('a b'), text: 'We  estimate\nthe\n\n robot pose' } });
    renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    expect(screen.getByTestId('selection-text').textContent).toBe('We estimate the robot pose');
  });

  it('run.retrying clears the text and shows "형식 오류로 다시 요청 중"', async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    request({ kind: 'explain', anchor: anchorOf('robust kernel'), text: 'robust kernel' });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted({ runId: 'rr', threadId: 'tr', messageId: 'mr' }), ev.started(), ev.delta('잘못된 첫 출력')));
    await waitFor(() => expect(screen.getByTestId('run-text').textContent).toContain('잘못된 첫 출력'));
    await act(async () => server.push(ev.retrying()));
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toContain('형식 오류로 다시 요청 중'));
    expect(screen.getByTestId('run-text').textContent).not.toContain('잘못된 첫 출력');
  });
});

describe('figure / equation thread head', () => {
  it('a capture is fetched with papers.capture and shown from a blob URL that is revoked on unmount', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:capture-1');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const F = threadDto('f1', { kind: 'figure', anchor: AREA, imageFileId: 'file-1', title: '그림' });
    const api = threadsApi({ threads: [F], messages: { f1: [messageDto('u', 'f1', 'user', '그림 설명'), messageDto('a', 'f1', 'assistant', '그림 답 [[G]]')] } });
    const png = testPngBytes();
    const { server, unmount } = renderWithApi(<AiTab paperId={PAPER} />, (c) => (c.url === `/api/papers/${PAPER}/captures/file-1` ? { status: 200, png } : api(c)));
    fireEvent.click(await screen.findByTestId('thread-item'));
    const img = (await screen.findByTestId('pn-thread-image')) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:capture-1');
    expect(server.calls.some((c) => c.url === `/api/papers/${PAPER}/captures/file-1`)).toBe(true);
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:capture-1');
    create.mockRestore();
    revoke.mockRestore();
  });
});

describe('"용어 제안" buttons: only where the server can see an AI source (explain_selection / chat answers)', () => {
  const G = '<glossary><term name="robust kernel">outlier 가중치를 줄이는 장치</term></glossary>';
  const thread = (kind: 'explain' | 'chat' | 'figure' | 'equation' | 'translate') => {
    const T = threadDto('t', { kind, title: kind, anchor: anchorOf('q'), equationId: kind === 'equation' ? 'e1' : null });
    return threadsApi({ threads: [T], messages: { t: [messageDto('u1', 't', 'user', 'q'), messageDto('a1', 't', 'assistant', `첫 답 [[G]]\n\n${G}`, { llmCallId: 'run-1' }), messageDto('u2', 't', 'user', '후속'), messageDto('a2', 't', 'assistant', `후속 답 [[G]]\n\n${G}`, { llmCallId: 'run-2' })] } });
  };
  it.each([
    ['explain', [true, true]],
    ['chat', [true, true]],
    ['figure', [false, true]],
    ['equation', [false, true]],
    ['translate', [false, false]],
  ] as const)('%s thread: buttons under [first, follow-up] = %j', async (kind, want) => {
    renderWithApi(<AiTab paperId={PAPER} />, thread(kind));
    fireEvent.click(await screen.findByTestId('thread-item'));
    const answers = await screen.findAllByTestId('message-assistant');
    expect(answers.map((a) => within(a).queryByTestId('pn-glossary-suggestions') !== null)).toEqual(want);
  });

  it('pressing a suggestion stores it with sourceMessageId and llmCallId; nothing is stored before', async () => {
    const api = thread('explain');
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, (c) => (c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary` ? { status: 200, json: { id: 'g1', paperId: PAPER, term: 'robust kernel', definitionKo: 'x', origin: 'llm', createdAt: 1, citations: [] } } : api(c)));
    fireEvent.click(await screen.findByTestId('thread-item'));
    const first = (await screen.findAllByTestId('message-assistant'))[0]!;
    expect(server.calls.some((c) => c.method === 'POST')).toBe(false);
    await act(async () => fireEvent.click(within(first).getByTestId('pn-glossary-suggest')));
    expect(server.calls.find((c) => c.method === 'POST')!.body).toEqual({ term: 'robust kernel', definitionKo: 'outlier 가중치를 줄이는 장치', sourceMessageId: 'a1', llmCallId: 'run-1' });
    expect(within(first).getByTestId('pn-glossary-suggest-state').textContent).toBe('용어집에 저장함');
  });

  it('a duplicate (409) says "이미 있는 용어"', async () => {
    const api = thread('chat');
    renderWithApi(<AiTab paperId={PAPER} />, (c) => (c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary` ? { status: 409, json: { error: { code: 'conflict', message: 'dup' } } } : api(c)));
    fireEvent.click(await screen.findByTestId('thread-item'));
    const first = (await screen.findAllByTestId('message-assistant'))[0]!;
    await act(async () => fireEvent.click(within(first).getByTestId('pn-glossary-suggest')));
    expect(within(first).getByTestId('pn-glossary-suggest-state').textContent).toBe('이미 있는 용어입니다');
  });
});
