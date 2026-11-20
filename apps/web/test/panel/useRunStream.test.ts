// useRunStream (PLAN 2.3): event order, queue/thinking, run.error with partial text, stream_interrupted, abort,
// cancel while queued, retry with the same clientRequestId. Real api client + streamRoute over a fake fetch.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isThinking } from '../../src/panel/ThreadView';
import { ApiError } from '../../src/api/client';
import { toRunError, useRunStream, type RunRequest } from '../../src/panel/useRunStream';
import { createFakeServer, ev } from './sseFake';

afterEach(cleanup);

const PAPER = '00000000-0000-4000-8000-000000000001';
const explainReq: RunRequest = { route: 'threads.create', params: { id: PAPER }, body: { kind: 'explain', text: '선택한 문장' } };

function setup() {
  const server = createFakeServer();
  const onSettled = vi.fn();
  const hook = renderHook(() => useRunStream({ client: server.client, onSettled }));
  const st = () => hook.result.current.state;
  return { server, hook, st, onSettled };
}

describe('useRunStream', () => {
  it('normal order: accepted → started → response → delta… → done; ids and cache read are stored', async () => {
    const { server, hook, st, onSettled } = setup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    expect(st().phase).toBe('starting');
    await waitFor(() => expect(server.streamCount()).toBe(1));
    const body = server.calls[0]!.body!;
    expect(body.kind).toBe('explain');
    expect(typeof body.clientRequestId).toBe('string');

    await act(async () => server.push(ev.accepted({ runId: 'r9', threadId: 't9', messageId: 'm9' })));
    await waitFor(() => expect(st().runId).toBe('r9'));
    expect([st().threadId, st().messageId, st().phase]).toEqual(['t9', 'm9', 'accepted']);

    await act(async () => server.push(ev.started(), ev.response(31542), ev.delta('설명 '), ev.delta('계속')));
    await waitFor(() => expect(st().text).toBe('설명 계속'));
    expect(st().phase).toBe('running');
    expect(st().cacheRead).toBe(31542);

    await act(async () => {
      server.push(ev.done('설명 계속 끝'));
      server.end();
      await p;
    });
    expect(st().phase).toBe('done');
    expect(st().text).toBe('설명 계속 끝');
    expect(st().done?.parsed).toBeTruthy();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('run.queued shows the position, run.thinking the estimated tokens', async () => {
    const { server, hook, st } = setup();
    act(() => void hook.result.current.start(explainReq));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted(), ev.queued(2)));
    await waitFor(() => expect(st().phase).toBe('queued'));
    expect(st().queuedPosition).toBe(2);
    await act(async () => server.push(ev.started(), ev.thinking(120)));
    await waitFor(() => expect(st().thinkingTokens).toBe(120));
    expect(st().phase).toBe('running');
    expect(st().queuedPosition).toBeNull();
  });

  it('run.error keeps the partial text and maps the code to Korean', async () => {
    const { server, hook, st } = setup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted(), ev.started(), ev.delta('부분'), ev.error('idle_timeout', '부분 텍스트'));
      server.end();
      await p;
    });
    expect(st().phase).toBe('error');
    expect(st().text).toBe('부분 텍스트');
    expect(st().error).toMatchObject({ code: 'idle_timeout', source: 'run', retryable: true });
    expect(st().error!.message).toContain('멈춰');
  });

  it('a stream cut without a terminal event → stream_interrupted with the text so far', async () => {
    const { server, hook, st } = setup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted(), ev.delta('여기까지'));
      server.end();
      await p;
    });
    expect(st().phase).toBe('error');
    expect(st().error?.code).toBe('stream_interrupted');
    expect(st().error?.message).toBe('연결이 끊겼습니다 — 결과는 thread를 다시 열어 확인하세요');
    expect(st().text).toBe('여기까지');
    expect(st().runId).toBe('r1');
  });

  it('HTTP 409 context_not_ready before any event → "색인 준비 중"', async () => {
    const server = createFakeServer();
    server.fetchFn.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 'context_not_ready', message: 'not ready' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    const { result } = renderHook(() => useRunStream({ client: server.client }));
    await act(async () => result.current.start(explainReq));
    expect(result.current.state.error).toMatchObject({ code: 'context_not_ready', source: 'http' });
    expect(result.current.state.error!.message).toContain('색인 준비 중');
  });

  it('409 with details.reason payload_version (a request id from an older server) → explicit message, not "다른 요청"', async () => {
    const server = createFakeServer();
    server.fetchFn.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 'conflict', message: 'older server version', details: { reason: 'payload_version', runId: 'r0' } } }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    const { result } = renderHook(() => useRunStream({ client: server.client }));
    await act(async () => result.current.start(explainReq));
    expect(result.current.state.error).toMatchObject({ code: 'payload_version', retryable: false, source: 'http' });
    expect(result.current.state.error!.message).toContain('서버가 업데이트되어');
  });

  it('run.error superseded (the answer was replaced by a regenerate) → "다시 생성되어 교체되었습니다", not retryable', async () => {
    const { server, hook, st } = setup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted(), { event: 'run.error', data: { code: 'superseded', message: 'replaced', retryable: false } });
      server.end();
      await p;
    });
    expect(st().phase).toBe('error');
    expect(st().error).toMatchObject({ code: 'superseded', retryable: false, source: 'run' });
    expect(st().error!.message).toContain('이 답변은 다시 생성되어 교체되었습니다');
  });

  it('bad_stream (event before run.accepted) is a general error', async () => {
    const { server, hook, st } = setup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.delta('x'));
      await p;
    });
    expect(st().error?.code).toBe('bad_stream');
    expect(st().error?.message).toBe('서버 응답 형식이 올바르지 않습니다');
  });

  it('abort() closes the connection and keeps the partial text', async () => {
    const { server, hook, st, onSettled } = setup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted(), ev.delta('부분')));
    await waitFor(() => expect(st().text).toBe('부분'));
    await act(async () => {
      hook.result.current.abort();
      await p;
    });
    expect(st().phase).toBe('error');
    expect(st().error?.source).toBe('aborted');
    expect(st().text).toBe('부분');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('unmount aborts the open stream', async () => {
    const { server, hook } = setup();
    act(() => void hook.result.current.start(explainReq));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    const init = server.fetchFn.mock.calls[0]![1] as RequestInit;
    hook.unmount();
    expect(init.signal?.aborted).toBe(true);
  });

  it('cancel while queued calls llm.runs.cancel; the stream ends with run.error cancelled', async () => {
    const { server, hook, st } = setup();
    server.onCancel(() => {
      server.push(ev.error('cancelled'));
      server.end();
    });
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted({ runId: 'r-q' }), ev.queued(1)));
    await waitFor(() => expect(st().phase).toBe('queued'));
    await act(async () => {
      await hook.result.current.cancel();
      await p;
    });
    const cancelCall = server.calls.find((c) => c.url.endsWith('/cancel'))!;
    expect(cancelCall).toMatchObject({ method: 'POST', url: '/api/llm/runs/r-q/cancel' });
    expect(st().phase).toBe('error');
    expect(st().error).toMatchObject({ code: 'cancelled', message: '취소했습니다' });
  });

  it('cancel falls back to closing the connection when the cancel route fails', async () => {
    const server = createFakeServer((c) => (c.url.endsWith('/cancel') ? { status: 501, json: { error: { code: 'not_implemented', message: 'x' } } } : undefined));
    const { result } = renderHook(() => useRunStream({ client: server.client }));
    let p!: Promise<void>;
    act(() => {
      p = result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.accepted(), ev.queued(1)));
    await waitFor(() => expect(result.current.state.phase).toBe('queued'));
    await act(async () => {
      await result.current.cancel();
      await p;
    });
    expect(result.current.state.error?.source).toBe('aborted');
  });

  it('retry re-sends the same request with the same clientRequestId; a new start gets a new one', async () => {
    const { server, hook, st } = setup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted(), ev.delta('부분'));
      server.end();
      await p;
    });
    expect(st().error?.code).toBe('stream_interrupted');
    const firstId = server.calls[0]!.body!.clientRequestId;

    act(() => {
      p = hook.result.current.retry();
    });
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(st().text).toBe(''); // the attached stream replays from run.accepted
    await act(async () => {
      server.push(ev.accepted(), ev.delta('부분'), ev.delta(' 이어서'), ev.done('부분 이어서'));
      server.end();
      await p;
    });
    expect(server.calls[1]!.body!.clientRequestId).toBe(firstId);
    expect(server.calls[1]!.body!.text).toBe('선택한 문장');
    expect(st().phase).toBe('done');

    act(() => void hook.result.current.start(explainReq));
    await waitFor(() => expect(server.streamCount()).toBe(3));
    expect(server.calls[2]!.body!.clientRequestId).not.toBe(firstId);
  });

  // ---- M2 (BRIEF_D D2 · S review R1-02: event-by-event checks moved here from e2e) ----
  it('run.started.effort is kept; "thinking" (running, no text) holds until the first text', async () => {
    const { server, hook, st } = setup();
    act(() => void hook.result.current.start({ route: 'threads.create', params: { id: PAPER }, body: { kind: 'chat', question: '질문', deep: true } }));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(server.calls[0]!.body!.deep).toBe(true);
    await act(async () => server.push(ev.accepted({ task: 'chat' })));
    await waitFor(() => expect(st().phase).toBe('accepted'));
    expect([st().effort, isThinking(st())]).toEqual([null, false]);
    await act(async () => server.push(ev.started('high')));
    await waitFor(() => expect(st().effort).toBe('high'));
    expect(isThinking(st())).toBe(true);
    await act(async () => server.push(ev.thinking(500)));
    await waitFor(() => expect(st().thinkingTokens).toBe(500));
    expect(isThinking(st())).toBe(true);
    await act(async () => server.push(ev.delta('첫 글자')));
    await waitFor(() => expect(st().text).toBe('첫 글자'));
    expect(isThinking(st())).toBe(false);
    expect(st().effort).toBe('high');
  });

  it('run.retrying clears the accumulated text (the stream still ends with exactly one terminal event)', async () => {
    const { server, hook, st, onSettled } = setup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start({ route: 'cards.generate', params: { id: PAPER, kind: 'notation' }, body: {} });
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(server.calls[0]!.url).toBe(`/api/papers/${PAPER}/cards/notation/generate`);
    await act(async () => server.push(ev.acceptedRun({ task: 'notation_card', artifactId: 'card-1' }), ev.started(), ev.delta('<item key="x"')));
    await waitFor(() => expect(st().text).toBe('<item key="x"'));
    expect(st().artifactId).toBe('card-1');
    await act(async () => server.push(ev.retrying()));
    await waitFor(() => expect(st().retrying).toBe(true));
    expect(st().text).toBe('');
    expect(st().phase).toBe('running');
    await act(async () => server.push(ev.delta('다시')));
    await waitFor(() => expect(st().text).toBe('다시'));
    await act(async () => {
      server.push(ev.doneParsed('다시', { items: [], outsideText: '', issues: [] }));
      server.end();
      await p;
    });
    expect(st().phase).toBe('done');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('an event after the terminal event is a contract error (one terminal only)', async () => {
    const { server, hook, st } = setup();
    let p!: Promise<void>;
    act(() => {
      p = hook.result.current.start(explainReq);
    });
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.accepted(), ev.done('끝'), ev.retrying());
      server.end();
      await p;
    });
    expect(st().phase).toBe('error');
    expect(st().error?.code).toBe('bad_stream');
  });

  it('409 card_generating maps to its own code with the ConflictDetails kept', async () => {
    const server = createFakeServer(() => ({ status: 409, json: { error: { code: 'conflict', message: 'generating', details: { reason: 'card_generating', runId: 'run-x', cardId: 'card-x' } } } }));
    const hook = renderHook(() => useRunStream({ client: server.client }));
    await act(async () => hook.result.current.start({ route: 'cards.generate', params: { id: PAPER, kind: 'notation' }, body: {} }));
    expect(hook.result.current.state.error).toMatchObject({ code: 'card_generating', source: 'http', details: { reason: 'card_generating', runId: 'run-x', cardId: 'card-x' } });
  });
});

describe('toRunError: disconnect wording by route (review D-R1-04)', () => {
  it('threads keep the M1 text; a card says it keeps generating; a glossary request may be cancelled', () => {
    const cut = new ApiError(0, 'stream_interrupted', 'cut');
    expect(toRunError(cut, false, 'messages.create').message).toBe('연결이 끊겼습니다 — 결과는 thread를 다시 열어 확인하세요');
    expect(toRunError(cut, false, 'threads.create').message).toBe('연결이 끊겼습니다 — 결과는 thread를 다시 열어 확인하세요');
    expect(toRunError(cut, false, 'cards.generate').message).toBe('연결이 끊겼습니다 — 생성은 서버에서 계속되고 끝나면 여기에 표시됩니다');
    expect(toRunError(cut, false, 'glossary.define').message).not.toContain('thread');
    expect(toRunError(new Error('x'), true, 'cards.generate')).toMatchObject({ code: 'aborted', source: 'aborted', message: '연결을 닫았습니다 — 생성은 서버에서 계속되고 끝나면 여기에 표시됩니다' });
  });
});
