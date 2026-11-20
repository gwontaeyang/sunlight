// D-B2-01 (coordinator 추가 지시 5): since B 수정 2 a run can end in run.error{code:'result_deleted', retryable:false}
// in two new ways — a LIVE stream whose owner (message / card / suggestion) was deleted while it ran, and a re-send of a
// running request id after a deletion, answered run.accepted + run.error{result_deleted} with no run.delta. Every D run
// consumer treats both as an ordinary terminal error: no re-attach with the same id (automatic or offered), no
// done / saved state, received partial text never shown as a finished result, no crash. One test per consumer family:
// thread answers (chat / ask, explain, translate, figure, equation — AiTab + ThreadView), "다시 생성", cards, glossary.
// Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaperCardDto } from '@study-paper/shared/contracts/api';
import type { Anchor } from '@study-paper/shared/contracts/domain';
import type { SseEvent } from '@study-paper/shared/contracts/sse';
import type { TaskId } from '@study-paper/shared/contracts/tasks';
import { AiTab } from '../../src/panel/AiTab';
import { CardsTab } from '../../src/panel/CardsTab';
import { GlossaryTab } from '../../src/panel/GlossaryTab';
import { ThreadView } from '../../src/panel/ThreadView';
import { IDLE_RUN, applyRunEvent, useRunStream } from '../../src/panel/useRunStream';
import { usePanelApi } from '../../src/panel/panelApi';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, anchorOf, messageDto, renderWithApi, resetReader, threadDto, threadsApi } from './panelHarness';
import { ev, type FakeCall, type JsonReply } from './sseFake';
import { TEST_PNG_BASE64 } from './testPng';

afterEach(cleanup);
beforeEach(() => resetReader(true));

/**
 * A run.error{result_deleted} (retryable:false). With `partialText` it is the contract's general shape (sse.ts allows
 * partialText on run.error); without it, it is what B 수정 2's server really sends (RESULT_DELETED in runManager.ts,
 * the same constant for live, attach and replay): no partialText, so the text received as run.delta is all there is.
 */
const deleted = (partialText?: string): SseEvent => ({ event: 'run.error', data: { code: 'result_deleted', message: 'result_deleted', retryable: false, ...(partialText !== undefined ? { partialText } : {}) } });
/** B 수정 2's exact terminal (review D-S1-03): `RESULT_DELETED` of runManager.ts, no partialText. */
const RESULT_DELETED: SseEvent = { event: 'run.error', data: { code: 'result_deleted', message: 'the result of this request no longer exists', retryable: false } };
const posts = (server: { calls: FakeCall[] }) => server.calls.filter((c) => c.method === 'POST' && !c.url.endsWith('/cancel'));
/** Lets pending effects (an automatic re-send would start here) run. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

describe('useRunStream reducer: run.error{result_deleted}', () => {
  it('is a terminal error (not done, not retryable) that keeps the partial text only as the failed text', () => {
    let s = applyRunEvent(IDLE_RUN, ev.accepted({ runId: 'r', task: 'chat' }) as never);
    s = applyRunEvent(s, ev.delta('부분') as never);
    s = applyRunEvent(s, deleted('부분 답') as never);
    expect(s.phase).toBe('error');
    expect(s.done).toBeUndefined();
    expect(s.error).toMatchObject({ code: 'result_deleted', retryable: false, source: 'run' });
    expect(s.text).toBe('부분 답');
    // the re-send answer: accepted + error, no delta
    const r = applyRunEvent(applyRunEvent(IDLE_RUN, ev.accepted({ runId: 'r', task: 'chat' }) as never), deleted() as never);
    expect(r).toMatchObject({ phase: 'error', text: '', events: ['run.accepted', 'run.error'] });
    expect(r.done).toBeUndefined();
  });

  it("B's real live terminal (no partialText, review D-S1-03): the text received as run.delta stays as the failed text", () => {
    let s = applyRunEvent(IDLE_RUN, ev.accepted({ runId: 'r', task: 'chat' }) as never);
    s = applyRunEvent(s, ev.started() as never);
    s = applyRunEvent(s, ev.delta('완성된 ') as never);
    s = applyRunEvent(s, ev.delta('답') as never);
    s = applyRunEvent(s, RESULT_DELETED as never);
    expect(s.phase).toBe('error');
    expect(s.done).toBeUndefined();
    expect(s.error).toMatchObject({ code: 'result_deleted', retryable: false, source: 'run' });
    expect(s.text).toBe('완성된 답');
  });
});

// ---- thread answers (AiTab → ThreadView / LiveMessage) ----

const AREA: Anchor = { kind: 'area', rects: [{ page: 2, x: 0.1, y: 0.2, w: 0.4, h: 0.3 }] };
const PARTIAL = '부분 답 <q>We estimate the robot pose</q> [[P]]\n\n<glossary><term name="robust kernel">outlier 가중치</term></glossary>';

type Family = 'chat' | 'explain' | 'translate' | 'figure' | 'equation';
const TASK: Record<Family, TaskId> = { chat: 'chat', explain: 'explain_selection', translate: 'translate_selection', figure: 'figure_area', equation: 'equation_deep' };

/** Starts the family's first run the way the panel does (question input or reader action). */
async function startThreadRun(family: Family) {
  if (family === 'chat') {
    // "ask": the selection is attached to the question input; sending creates the chat thread
    act(() => useReaderStore.getState().requestAction({ kind: 'ask', anchor: anchorOf('We estimate'), text: 'We estimate' }));
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '무슨 뜻?' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    return;
  }
  const a =
    family === 'figure'
      ? { kind: 'figure' as const, anchor: AREA, imagePng: TEST_PNG_BASE64 }
      : family === 'equation'
        ? { kind: 'equation' as const, equationId: 'eq-1' }
        : { kind: family, anchor: anchorOf('We estimate the robot pose'), text: 'We estimate the robot pose' };
  act(() => useReaderStore.getState().requestAction(a));
}

/** Nothing of the failed run is presented as a stored / finished answer, and nothing re-attaches to it. */
function expectOrdinaryTerminal(live: HTMLElement) {
  expect(live.dataset.phase).toBe('error');
  const err = screen.getByTestId('run-error');
  expect(err.dataset.code).toBe('result_deleted');
  expect(err.textContent).toContain('이 요청의 결과가 더 이상 없습니다');
  expect(screen.queryByTestId('run-retry')).toBeNull(); // no "다시 연결" (same id)
  expect(screen.queryByTestId('run-reopen')).toBeNull();
  expect(screen.queryByTestId('run-cancel')).toBeNull();
  expect(screen.queryByTestId('regenerate-kept')).toBeNull();
  expect(within(live).queryByTestId('pn-glossary-suggestions')).toBeNull(); // done-only footer
  expect(within(live).queryAllByTestId('sp-chip').filter((c) => c.dataset.status === 'verbatim')).toHaveLength(0);
  expect(within(live).queryAllByTestId('sp-badge').filter((b) => b.dataset.status === 'p-grounded')).toHaveLength(0);
}

describe.each(['chat', 'explain', 'translate', 'figure', 'equation'] as const)('%s answer ended by result_deleted', (family) => {
  it('live stream: run.error{result_deleted} after deltas → error, partial text only as "중단 전까지 받은 부분", no retry', async () => {
    // the owner is gone: threads.get of the new thread answers 404
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    await startThreadRun(family);
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted({ runId: 'rd', threadId: 'td', messageId: 'md', task: TASK[family] }), ev.started(), ev.delta('부분 답 '), deleted(PARTIAL));
      server.end();
    });
    const live = await screen.findByTestId('live-message');
    await waitFor(() => expect(live.dataset.phase).toBe('error'));
    expectOrdinaryTerminal(live);
    expect(live.textContent).toContain('부분 답');
    expect(screen.getByTestId('run-error').textContent).toContain('중단 전까지 받은 부분');
    if (family !== 'translate') expect(within(live).getByTestId('sp-phase-note').textContent).toContain('확인 안 됨');
    await settle();
    expect(server.streamCount()).toBe(1); // no automatic re-send
    expect(screen.queryByTestId('regenerate')).toBeNull(); // no stored answer to regenerate
    expect(screen.queryAllByTestId('message-assistant')).toHaveLength(0);
  });

  it("B's real live terminal: the whole answer arrived as run.delta, then RESULT_DELETED without partialText (D-S1-03)", async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    await startThreadRun(family);
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted({ runId: 'rd', threadId: 'td', messageId: 'md', task: TASK[family] }), ev.started(), ev.delta(PARTIAL.slice(0, 20)), ev.delta(PARTIAL.slice(20)), RESULT_DELETED);
      server.end();
    });
    const live = await screen.findByTestId('live-message');
    await waitFor(() => expect(live.dataset.phase).toBe('error'));
    expectOrdinaryTerminal(live);
    // the accumulated deltas are kept, shown only as the part received before the stop, never as a checked answer
    const runText = screen.getByTestId('run-text');
    expect(runText.textContent).toContain('부분 답');
    if (family === 'translate') expect(runText.textContent).toContain('<q>We estimate the robot pose</q>'); // plain mode: the markup as text
    expect(screen.getByTestId('run-error').textContent).toContain('중단 전까지 받은 부분');
    if (family !== 'translate') {
      expect(within(live).getByTestId('sp-phase-note').textContent).toContain('확인 안 됨');
      // the quote is drawn as a chip, but not as a found (verbatim) one
      expect(within(live).getAllByTestId('sp-chip').length).toBeGreaterThan(0);
    }
    await settle();
    expect(server.streamCount()).toBe(1);
    expect(screen.queryByTestId('regenerate')).toBeNull();
    expect(screen.queryAllByTestId('message-assistant')).toHaveLength(0);
  });

  it('re-send after a cut: run.accepted + run.error{result_deleted} (no delta) → error, no text, no further retry', async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    await startThreadRun(family);
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted({ runId: 'rd', threadId: 'td', messageId: 'md', task: TASK[family] }), ev.started(), ev.delta('끊기기 전 글'));
      server.end();
    });
    await waitFor(() => expect(screen.getByTestId('run-error').dataset.code).toBe('stream_interrupted'));
    fireEvent.click(screen.getByTestId('run-retry'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(posts(server)[1]!.body!.clientRequestId).toBe(posts(server)[0]!.body!.clientRequestId);
    await act(async () => {
      server.push(ev.accepted({ runId: 'rd', threadId: 'td', messageId: 'md', task: TASK[family] }), deleted());
      server.end();
    });
    const live = screen.getByTestId('live-message');
    await waitFor(() => expect(live.dataset.phase).toBe('error'));
    expectOrdinaryTerminal(live);
    // no answer text at all: only the failed-phase note ("중단된 답변 · 인용 확인 안 됨") is left in the text area
    const runText = screen.getByTestId('run-text');
    const note = within(runText).getByTestId('sp-phase-note').textContent!;
    expect(note).toContain('확인 안 됨');
    expect(runText.textContent!.replace(note, '').trim()).toBe('');
    expect(live.textContent).not.toContain('끊기기 전 글');
    expect(screen.getByTestId('run-error').textContent).not.toContain('중단 전까지 받은 부분');
    expect(screen.getByTestId('run-events').textContent).toBe('run.accepted → run.error');
    await settle();
    expect(server.streamCount()).toBe(2);
  });
});

describe('"다시 생성" ended by result_deleted (the thread was deleted while it ran)', () => {
  const T1 = threadDto('t1', { kind: 'explain', title: 'We estimate the robot pose', anchor: anchorOf('We estimate the robot pose') });
  const MSGS = [messageDto('u1', 't1', 'user', 'We estimate the robot pose'), messageDto('a1', 't1', 'assistant', '요지')];
  function Harness() {
    const run = useRunStream({ client: usePanelApi() });
    return <ThreadView paperId={PAPER} threadId="t1" run={run} contextReady />;
  }

  it('does not claim the previous answer was kept, offers no retry', async () => {
    const data = { threads: [T1], messages: { t1: [...MSGS] } };
    const { server } = renderWithApi(<Harness />, threadsApi(data));
    fireEvent.click(await screen.findByTestId('regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted({ runId: 'r7', threadId: 't1', messageId: 'a7' }), ev.started(), ev.delta('새 답 일부')));
    data.threads = []; // deleted in another window
    await act(async () => {
      server.push(deleted('새 답 일부'));
      server.end();
    });
    const live = screen.getByTestId('live-message');
    await waitFor(() => expect(live.dataset.phase).toBe('error'));
    expectOrdinaryTerminal(live);
    expect(live.textContent).not.toContain('그대로 두었습니다');
    await settle();
    expect(server.streamCount()).toBe(1);
  });
});

// ---- cards ----

describe('cards: generation ended by result_deleted (the card row was deleted)', () => {
  function cardsApi(cards: PaperCardDto[]) {
    return (c: FakeCall): JsonReply | undefined => (c.method === 'GET' && c.url === `/api/papers/${PAPER}/cards` ? { status: 200, json: { cards } } : undefined);
  }
  const section = () => screen.getAllByTestId('pn-card-section').find((s) => s.dataset.kind === 'notation')!;
  function expectCardTerminal(sec: HTMLElement) {
    const err = within(sec).getByTestId('pn-card-error');
    expect(err.dataset.code).toBe('result_deleted');
    expect(err.textContent).toContain('이 요청의 결과가 더 이상 없습니다');
    expect(within(sec).queryByTestId('pn-card-reconnect')).toBeNull();
    expect(within(sec).queryByTestId('pn-card-progress')).toBeNull();
    expect(within(sec).queryByTestId('pn-card-cancel')).toBeNull();
    expect(within(sec).queryAllByTestId('pn-card-item')).toHaveLength(0);
    expect(within(sec).queryByTestId('pn-card-failed')).toBeNull();
    // a new request is possible (a fresh id), the deleted run is not re-attached
    expect(within(sec).getByTestId('pn-card-generate')).toBeTruthy();
  }

  it('live stream: no card, no reconnect, the received SP-Blocks text is never shown', async () => {
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, cardsApi([]));
    const sec = await waitFor(() => section());
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'rc', task: 'notation_card', artifactId: 'card-del' }), ev.started('high'), ev.delta('<item key="frame_notation" label="N">비밀 원문</item>'), deleted('<item key="frame_notation" label="N">비밀 원문</item>'));
      server.end();
    });
    await waitFor(() => expect(within(sec).getByTestId('pn-card-error')).toBeTruthy());
    expectCardTerminal(sec);
    expect(sec.textContent).not.toContain('비밀 원문');
    expect(sec.textContent).not.toContain('<item');
    await settle();
    expect(server.streamCount()).toBe(1);
  });

  it("B's real live terminal (deltas, then RESULT_DELETED without partialText): same, the deltas are never shown (D-S1-03)", async () => {
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, cardsApi([]));
    const sec = await waitFor(() => section());
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'rc', task: 'notation_card', artifactId: 'card-del' }), ev.started('high'), ev.delta('<item key="frame_notation" label="N">비밀 원문</item>'), RESULT_DELETED);
      server.end();
    });
    await waitFor(() => expect(within(sec).getByTestId('pn-card-error')).toBeTruthy());
    expectCardTerminal(sec);
    expect(sec.textContent).not.toContain('비밀 원문');
    expect(sec.textContent).not.toContain('<item');
    await settle();
    expect(server.streamCount()).toBe(1);
  });

  it('re-send after a cut ("다시 연결", same id) → accepted + result_deleted → error, no further reconnect', async () => {
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, cardsApi([]));
    const sec = await waitFor(() => section());
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'rc', task: 'notation_card', artifactId: 'card-del' }), ev.started('high'), ev.delta('<item key="a" label="N">끊기기 전</item>'));
      server.end();
    });
    fireEvent.click(await within(sec).findByTestId('pn-card-reconnect'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(posts(server)[1]!.body!.clientRequestId).toBe(posts(server)[0]!.body!.clientRequestId);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'rc', task: 'notation_card', artifactId: 'card-del' }), deleted());
      server.end();
    });
    await waitFor(() => expect(within(sec).getByTestId('pn-card-error').dataset.code).toBe('result_deleted'));
    expectCardTerminal(sec);
    expect(sec.textContent).not.toContain('끊기기 전');
    await settle();
    expect(server.streamCount()).toBe(2);
  });
});

// ---- glossary ----

describe('glossary: a definition request ended by result_deleted', () => {
  function glossaryApi() {
    return (c: FakeCall): JsonReply | undefined => (c.method === 'GET' && c.url === `/api/papers/${PAPER}/glossary` ? { status: 200, json: { terms: [] } } : undefined);
  }
  const defines = (server: { calls: FakeCall[] }) => server.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/glossary/define'));
  async function request(server: ReturnType<typeof renderWithApi>['server']) {
    await screen.findByText('용어집이 비어 있습니다');
    fireEvent.change(screen.getByTestId('pn-glossary-define-term'), { target: { value: 'robust kernel' } });
    fireEvent.click(screen.getByTestId('pn-glossary-define-start'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
  }
  function expectGlossaryTerminal() {
    const lost = screen.getByTestId('pn-glossary-define-lost');
    expect(lost.dataset.code).toBe('result_deleted');
    expect(screen.queryByTestId('pn-glossary-suggestion')).toBeNull();
    expect(screen.queryByTestId('pn-glossary-suggestion-save')).toBeNull();
    expect(screen.queryByTestId('pn-glossary-saved')).toBeNull();
    expect(screen.queryByTestId('pn-glossary-define-reconnect')).toBeNull(); // no "다시 연결" (same id)
    expect(screen.queryByTestId('pn-glossary-define-progress')).toBeNull();
    return lost;
  }

  it('live stream: no suggestion, nothing to save, the partial definition is not shown; "다시 요청" is a NEW id', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi());
    await request(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.started(), ev.delta('<term name="robust kernel">부분 정의'), deleted('<term name="robust kernel">부분 정의'));
      server.end();
    });
    await screen.findByTestId('pn-glossary-define-lost');
    const lost = expectGlossaryTerminal();
    expect(screen.getByTestId('pn-glossary-define').textContent).not.toContain('부분 정의');
    await settle();
    expect(server.streamCount()).toBe(1); // not re-sent automatically
    fireEvent.click(within(lost).getByTestId('pn-glossary-define-again'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(defines(server)[1]!.body!.clientRequestId).not.toBe(defines(server)[0]!.body!.clientRequestId);
  });

  it("B's real live terminal (deltas, then RESULT_DELETED without partialText): same, the partial definition is not shown (D-S1-03)", async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi());
    await request(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.started(), ev.delta('<term name="robust kernel">부분 정의'), RESULT_DELETED);
      server.end();
    });
    await screen.findByTestId('pn-glossary-define-lost');
    expectGlossaryTerminal();
    expect(screen.getByTestId('pn-glossary-define').textContent).not.toContain('부분 정의');
    await settle();
    expect(server.streamCount()).toBe(1);
  });

  it('the automatic same-id re-send after a cut answers accepted + result_deleted → no second automatic re-send', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi());
    await request(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.started(), ev.delta('<term name="robust kernel">끊기기 전'));
      server.end();
    });
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(defines(server)[1]!.body!.clientRequestId).toBe(defines(server)[0]!.body!.clientRequestId);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), deleted());
      server.end();
    });
    await screen.findByTestId('pn-glossary-define-lost');
    expectGlossaryTerminal();
    expect(screen.getByTestId('pn-glossary-define').textContent).not.toContain('끊기기 전');
    await settle();
    expect(server.streamCount()).toBe(2);
  });
});
