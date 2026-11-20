// Review D-I10-01: a connection cut ABNORMALLY after the response started (the body read rejects — a TypeError, what
// fetch reports for a reset connection or an incomplete chunked body) is a dropped connection like a clean EOF without a
// terminal event: `stream_interrupted` (source 'stream'), so every consumer takes its existing reconnect path. A state
// that already received its terminal event (run.done / run.error) is never overwritten by a transport error after it.
// One test per consumer: the hook, glossary (same-id re-send → replay), cards ("다시 연결", no stale error line once the
// card is complete), thread answers ("다시 연결" + "thread 다시 열기"). Owner D.
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaperCardDto, RunDto } from '@study-paper/shared/contracts/api';
import type { Citation, ParsedBlocks } from '@study-paper/shared/contracts/domain';
import { AiTab } from '../../src/panel/AiTab';
import { CardsTab } from '../../src/panel/CardsTab';
import { GlossaryTab } from '../../src/panel/GlossaryTab';
import { useRunStream, type RunRequest } from '../../src/panel/useRunStream';
import { useReaderStore } from '../../src/state/readerStore';
import { card } from './cardFixtures';
import { PAPER, anchorOf, renderWithApi, resetReader, threadsApi } from './panelHarness';
import { createFakeServer, ev, type FakeCall, type JsonReply } from './sseFake';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => resetReader(true));

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const explainReq: RunRequest = { route: 'threads.create', params: { id: PAPER }, body: { kind: 'explain', text: '선택한 문장' } };

function hookSetup(onEvent?: () => void) {
  const server = createFakeServer();
  const onSettled = vi.fn();
  const hook = renderHook(() => useRunStream({ client: server.client, onSettled, onEvent }));
  return { server, hook, st: () => hook.result.current.state, onSettled };
}

describe('useRunStream: an abnormal cut (review D-I10-01)', () => {
  it('a body read rejected after the response started → stream_interrupted (source stream), partial text and ids kept', async () => {
    const { server, hook, st } = hookSetup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted(), ev.started(), ev.delta('여기까지'));
      await new Promise((r) => setTimeout(r, 10));
      server.fail();
      await p;
    });
    expect(st().phase).toBe('error');
    expect(st().error).toMatchObject({ code: 'stream_interrupted', source: 'stream', retryable: true });
    expect(st().error?.message).toBe('연결이 끊겼습니다 — 결과는 thread를 다시 열어 확인하세요');
    expect(st().text).toBe('여기까지');
    expect(st().runId).toBe('r1');
  });

  it('a cut before any event (headers only) is the same stream_interrupted', async () => {
    const { server, hook, st } = hookSetup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.fail();
      await p;
    });
    expect(st().error).toMatchObject({ code: 'stream_interrupted', source: 'stream' });
  });

  it('run.done, then a transport error before EOF: phase stays done (done kept, no error); onSettled once', async () => {
    const { server, hook, st, onSettled } = hookSetup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted(), ev.started(), ev.delta('답'), ev.done('완성된 답'));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(st().phase).toBe('done');
    await act(async () => {
      server.fail();
      await p;
    });
    expect(st().phase).toBe('done');
    expect(st().error).toBeUndefined();
    expect(st().done?.text).toBe('완성된 답');
    expect(st().text).toBe('완성된 답');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]![0]).toMatchObject({ phase: 'done' });
  });

  it('run.error, then a transport error: the run error stays (not replaced by a connection error)', async () => {
    const { server, hook, st } = hookSetup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted(), ev.delta('부분'), ev.error('idle_timeout', '부분 답'));
      await new Promise((r) => setTimeout(r, 10));
      server.fail();
      await p;
    });
    expect(st().phase).toBe('error');
    expect(st().error).toMatchObject({ code: 'idle_timeout', source: 'run' });
    expect(st().text).toBe('부분 답');
  });

  it('abort() after run.done keeps the done state', async () => {
    const { server, hook, st } = hookSetup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted(), ev.done('끝'));
      await new Promise((r) => setTimeout(r, 10));
      hook.result.current.abort();
      await p;
    });
    expect(st().phase).toBe('done');
    expect(st().error).toBeUndefined();
  });

  it('an exception thrown by the consumer (onEvent) is not a dropped connection: no stream_interrupted', async () => {
    const { server, hook, st } = hookSetup(() => {
      throw new Error('consumer bug');
    });
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted());
      await p;
    });
    expect(st().phase).toBe('error');
    expect(st().error?.code).toBe('unknown');
    expect(st().error?.source).not.toBe('stream');
  });

  // Review D-FX2R1-02 (a): only a body read after the response started is a cut connection.
  it('a non-ApiError thrown BEFORE the response started (client.request) stays "unknown", not stream_interrupted', async () => {
    const server = createFakeServer();
    const client = {
      ...server.client,
      request: async () => {
        throw new RangeError('before any response');
      },
    } as unknown as typeof server.client;
    const hook = renderHook(() => useRunStream({ client }));
    await act(async () => {
      await hook.result.current.start(explainReq);
    });
    const s = hook.result.current.state;
    expect(s.phase).toBe('error');
    expect(s.error?.code).toBe('unknown');
    expect(s.error?.source).not.toBe('stream');
    expect(s.error?.detail).toContain('before any response');
  });

  // Review D-FX2R1-02 (b): the consumer's exception at the TERMINAL event is not swallowed either.
  it('the consumer (onEvent) throws at run.done → "unknown" (as at any other event) and the stack goes to console.error', async () => {
    const server = createFakeServer();
    const bug = new Error('consumer bug at done');
    const onSettled = vi.fn();
    const hook = renderHook(() =>
      useRunStream({
        client: server.client,
        onSettled,
        onEvent: (e) => {
          if (e.event === 'run.done') throw bug;
        },
      }),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted(), ev.done('끝'));
      await p;
    });
    const s = hook.result.current.state;
    expect(s.phase).toBe('error');
    expect(s.error?.code).toBe('unknown');
    expect(s.error?.source).not.toBe('stream');
    expect(s.done?.text).toBe('끝'); // the received result stays in the state
    expect(spy.mock.calls.some((c) => c.includes(bug))).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// ---- glossary.define ----

const QUOTE = 'The robust kernel down-weights outliers in the residual.';
const BODY = `이 논문에서 robust kernel은 outlier 가중치를 줄인다. <q>${QUOTE}</q>`;
const PARSED: ParsedBlocks = { items: [{ tag: 'term', attrs: { name: 'robust kernel' }, body: BODY, children: [] }], outsideText: '', issues: [] };
const CITES: Citation[] = [{ ordinal: 1, kind: 'quote', quote: QUOTE, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 10 } }];
const glossaryApi = (c: FakeCall): JsonReply | undefined => (c.method === 'GET' && c.url === `/api/papers/${PAPER}/glossary` ? { status: 200, json: { terms: [] } } : undefined);
const defines = (server: { calls: FakeCall[] }) => server.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/glossary/define'));

async function requestDefinition(server: ReturnType<typeof renderWithApi>['server']) {
  await screen.findByText('용어집이 비어 있습니다');
  fireEvent.change(screen.getByTestId('pn-glossary-define-term'), { target: { value: 'robust kernel' } });
  fireEvent.click(screen.getByTestId('pn-glossary-define-start'));
  await waitFor(() => expect(server.streamCount()).toBe(1));
}

describe('glossary.define: an abnormal cut (review D-I10-01)', () => {
  it('cut after run.started → re-sent ONCE with the SAME id; the replay shows the suggestion, no error line', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi);
    await requestDefinition(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.started());
      await new Promise((r) => setTimeout(r, 10));
      server.fail();
    });
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(defines(server)[1]!.body!.clientRequestId).toBe(defines(server)[0]!.body!.clientRequestId);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.doneParsed('x', PARSED, CITES));
      server.end();
    });
    expect(await screen.findByTestId('pn-glossary-suggestion')).toBeTruthy();
    expect(screen.queryByTestId('pn-glossary-define-error')).toBeNull();
    await settle();
    expect(server.streamCount()).toBe(2);
  });

  it('a second abnormal cut of the re-sent request → "다시 연결" (same id), not an automatic loop', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi);
    await requestDefinition(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }));
      await new Promise((r) => setTimeout(r, 10));
      server.fail();
    });
    await waitFor(() => expect(server.streamCount()).toBe(2));
    await act(async () => {
      server.fail();
    });
    const again = await screen.findByTestId('pn-glossary-define-reconnect');
    await settle();
    expect(server.streamCount()).toBe(2);
    expect(screen.queryByTestId('pn-glossary-define-error')).toBeNull();
    fireEvent.click(again);
    await waitFor(() => expect(server.streamCount()).toBe(3));
    expect(defines(server)[2]!.body!.clientRequestId).toBe(defines(server)[0]!.body!.clientRequestId);
  });

  it('run.done, then a transport error: the suggestion stays and nothing is re-sent', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi);
    await requestDefinition(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.doneParsed('x', PARSED, CITES));
      await new Promise((r) => setTimeout(r, 10));
      server.fail();
    });
    await settle();
    expect(screen.getByTestId('pn-glossary-suggestion')).toBeTruthy();
    expect(screen.queryByTestId('pn-glossary-define-error')).toBeNull();
    expect(screen.queryByTestId('pn-glossary-define-reconnect')).toBeNull();
    expect(server.streamCount()).toBe(1);
  });
});

// ---- cards.generate ----

const runDto = (runId: string, status: RunDto['status']): RunDto => ({ runId, task: 'notation_card', status, errorCode: null, paperId: PAPER, threadId: null, model: 'opus', modelResolved: null, effort: 'high', acceptedAt: 1, startedAt: 1, finishedAt: status === 'running' ? null : 2 });

function cardsApi(state: { cards: PaperCardDto[]; runs: Record<string, RunDto['status'][]> }) {
  return (c: FakeCall): JsonReply | undefined => {
    if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/cards`) return { status: 200, json: { cards: state.cards } };
    const run = /^\/api\/llm\/runs\/([^/]+)$/.exec(c.url);
    if (c.method === 'GET' && run) {
      const seq = state.runs[run[1]!] ?? ['running'];
      return { status: 200, json: runDto(run[1]!, seq.length > 1 ? seq.shift()! : seq[0]!) };
    }
    return undefined;
  };
}
const section = (kind: string) => screen.getAllByTestId('pn-card-section').find((s) => s.dataset.kind === kind)!;

describe('cards.generate: an abnormal cut (review D-I10-01)', () => {
  it('cut after run.started → card wording + "다시 연결"; the error line goes once the card is complete', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = { cards: [] as PaperCardDto[], runs: { 'run-c': ['running', 'ok'] as RunDto['status'][] } };
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, cardsApi(state));
    const sec = await waitFor(() => section('notation'));
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    state.cards = [card('notation', { id: 'card-new', status: 'generating', items: [], runId: 'run-c', createdAt: 20 })];
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-c', task: 'notation_card', artifactId: 'card-new' }), ev.started('high'));
      await vi.advanceTimersByTimeAsync(10);
      server.fail();
    });
    const err = await within(sec).findByTestId('pn-card-error');
    expect(err.dataset.code).toBe('stream_interrupted');
    expect(err.textContent).toContain('생성은 서버에서 계속되고 끝나면 여기에 표시됩니다');
    expect(within(err).getByTestId('pn-card-reconnect')).toBeTruthy();
    await waitFor(() => expect(within(sec).getByTestId('pn-card-progress')).toBeTruthy());
    state.cards = [card('notation', { id: 'card-new', runId: 'run-c', createdAt: 20 })];
    for (let i = 0; i < 3; i++) await act(async () => vi.advanceTimersByTimeAsync(2000));
    await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
    expect(within(sec).queryByTestId('pn-card-error')).toBeNull();
  });

  it('"다시 연결" re-sends with the same clientRequestId', async () => {
    const state = { cards: [] as PaperCardDto[], runs: {} };
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, cardsApi(state));
    const sec = await waitFor(() => section('summary'));
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-s', task: 'summary' }));
      await new Promise((r) => setTimeout(r, 10));
      server.fail();
    });
    const err = await within(sec).findByTestId('pn-card-error');
    expect(err.dataset.code).toBe('stream_interrupted');
    fireEvent.click(within(err).getByTestId('pn-card-reconnect'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    const gens = server.calls.filter((c) => c.method === 'POST' && c.url.includes('/cards/'));
    expect(gens[1]!.body!.clientRequestId).toBe(gens[0]!.body!.clientRequestId);
  });
});

// ---- thread answers ----

describe('thread answer: an abnormal cut (review D-I10-01)', () => {
  it('cut after deltas → "연결이 끊겼습니다" + "다시 연결" + "thread 다시 열기"', async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    act(() => useReaderStore.getState().requestAction({ kind: 'explain', anchor: anchorOf('We estimate the robot pose'), text: 'We estimate the robot pose' }));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted({ runId: 'rt', threadId: 'tt', messageId: 'mt', task: 'explain_selection' }), ev.started(), ev.delta('부분 답'));
      await new Promise((r) => setTimeout(r, 10));
      server.fail();
    });
    const err = await screen.findByTestId('run-error');
    expect(err.dataset.code).toBe('stream_interrupted');
    expect(err.textContent).toContain('연결이 끊겼습니다 — 결과는 thread를 다시 열어 확인하세요');
    expect(screen.getByTestId('run-retry')).toBeTruthy();
    expect(screen.getByTestId('run-reopen')).toBeTruthy();
  });

  it('run.done, then a transport error: the answer stays done (no error, no "다시 연결")', async () => {
    const { server } = renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    await screen.findByText('아직 대화가 없습니다');
    act(() => useReaderStore.getState().requestAction({ kind: 'explain', anchor: anchorOf('We estimate the robot pose'), text: 'We estimate the robot pose' }));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted({ runId: 'rt', threadId: 'tt', messageId: 'mt', task: 'explain_selection' }), ev.started(), ev.delta('완성된 답'), ev.done('완성된 답'));
      await new Promise((r) => setTimeout(r, 10));
      server.fail();
    });
    await settle();
    const live = screen.getByTestId('live-message');
    expect(live.dataset.phase).toBe('done');
    expect(screen.queryByTestId('run-error')).toBeNull();
    expect(screen.queryByTestId('run-retry')).toBeNull();
  });
});
