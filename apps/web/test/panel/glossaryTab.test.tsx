// Glossary tab (BRIEF_D D7): origin 3 kinds, "정의 요청" → suggestion → stored only on "저장" (llmCallId), editing
// first, 409 duplicate, a dropped connection re-sent with the same id (replay), a cancelled replay → "다시 요청" with a new
// id (no automatic re-send), result_deleted, the reader "glossary" action, manual add, edit and delete. Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GlossaryTermDto } from '@study-paper/shared/contracts/api';
import type { Citation, ParsedBlocks } from '@study-paper/shared/contracts/domain';
import { GlossaryTab } from '../../src/panel/GlossaryTab';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, anchorOf, renderWithApi, resetReader } from './panelHarness';
import { ev, type FakeCall, type JsonReply } from './sseFake';

afterEach(cleanup);
beforeEach(() => resetReader(true));

const QUOTE = 'The robust kernel down-weights outliers in the residual.';
const BODY = `이 논문에서 robust kernel은 outlier 가중치를 줄인다. <q>${QUOTE}</q>`;
const PARSED: ParsedBlocks = { items: [{ tag: 'term', attrs: { name: 'robust kernel' }, body: BODY, children: [] }], outsideText: '', issues: [] };
const CITES: Citation[] = [{ ordinal: 1, kind: 'quote', quote: QUOTE, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 10 } }];
const term = (id: string, t: string, origin: GlossaryTermDto['origin'], def: string | null = null): GlossaryTermDto => ({ id, paperId: PAPER, term: t, definitionKo: def, origin, createdAt: 1, citations: [] });

function glossaryApi(terms: GlossaryTermDto[], o: { create?: (c: FakeCall) => JsonReply | undefined } = {}) {
  return (c: FakeCall): JsonReply | undefined => {
    if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/glossary`) return { status: 200, json: { terms } };
    if (c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary`) {
      const r = o.create?.(c);
      if (r) return r;
      const t = term(`g${terms.length + 1}`, String(c.body!.term), c.body!.llmCallId ? 'llm' : 'manual', (c.body!.definitionKo as string | undefined) ?? null);
      terms.push(t);
      return { status: 200, json: t };
    }
    const m = /^\/api\/glossary\/([^/]+)$/.exec(c.url);
    if (m && c.method === 'PATCH') {
      const t = terms.find((x) => x.id === m[1])!;
      Object.assign(t, c.body, { origin: 'llm_edited' });
      return { status: 200, json: t };
    }
    if (m && c.method === 'DELETE') {
      terms.splice(terms.findIndex((x) => x.id === m[1]), 1);
      return { status: 204 };
    }
    return undefined;
  };
}
const defines = (server: { calls: FakeCall[] }) => server.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/glossary/define'));
const creates = (server: { calls: FakeCall[] }) => server.calls.filter((c) => c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary`);

async function requestDefinition(server: ReturnType<typeof renderWithApi>['server'], t = 'robust kernel') {
  fireEvent.change(screen.getByTestId('pn-glossary-define-term'), { target: { value: t } });
  fireEvent.click(screen.getByTestId('pn-glossary-define-start'));
  await waitFor(() => expect(server.streamCount()).toBeGreaterThan(0));
}

describe('GlossaryTab', () => {
  it('shows the origin as the server decided: llm "AI 제안", llm_edited "AI 제안 · 수정됨", manual "직접 추가"', async () => {
    renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi([term('a', 'alpha', 'llm'), term('b', 'beta', 'llm_edited'), term('c', 'gamma', 'manual')]));
    const items = await screen.findAllByTestId('pn-glossary-item');
    const origins = items.map((i) => within(i).getByTestId('pn-glossary-origin'));
    expect(origins.map((o) => [o.dataset.origin, o.textContent])).toEqual([
      ['llm', 'AI 제안'],
      ['llm_edited', 'AI 제안 · 수정됨'],
      ['manual', '직접 추가'],
    ]);
    expect(origins[2]!.textContent).not.toContain('AI 제안');
  });

  it('"정의 요청" → the suggestion is shown but stored only when "저장" is pressed (with llmCallId)', async () => {
    const terms: GlossaryTermDto[] = [];
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi(terms));
    await screen.findByText('용어집이 비어 있습니다');
    await requestDefinition(server);
    expect(defines(server)[0]!.body).toMatchObject({ term: 'robust kernel' });
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.started(), ev.doneParsed(`<term name="robust kernel">${BODY}</term>`, PARSED, CITES));
      server.end();
    });
    const sug = await screen.findByTestId('pn-glossary-suggestion');
    expect(within(sug).getByTestId('sp-chip').dataset.status).toBe('verbatim');
    expect(creates(server)).toHaveLength(0);
    expect(screen.queryAllByTestId('pn-glossary-item')).toHaveLength(0);
    await act(async () => fireEvent.click(screen.getByTestId('pn-glossary-suggestion-save')));
    expect(creates(server)[0]!.body).toEqual({ term: 'robust kernel', definitionKo: BODY, llmCallId: 'run-def' });
    await waitFor(() => expect(screen.getAllByTestId('pn-glossary-item')).toHaveLength(1));
  });

  it('the suggestion may be edited before saving; a duplicate (409) says "이미 있는 용어"', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi([], { create: (c) => (c.body!.definitionKo === '고친 정의' ? undefined : { status: 409, json: { error: { code: 'conflict', message: 'dup' } } }) }));
    await screen.findByText('용어집이 비어 있습니다');
    await requestDefinition(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.doneParsed('x', PARSED, CITES));
      server.end();
    });
    await act(async () => fireEvent.click(await screen.findByTestId('pn-glossary-suggestion-save')));
    expect(await screen.findByText('이미 있는 용어입니다')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pn-glossary-suggestion-modify'));
    fireEvent.change(screen.getByTestId('pn-glossary-suggestion-edit'), { target: { value: '고친 정의' } });
    await act(async () => fireEvent.click(screen.getByTestId('pn-glossary-suggestion-save')));
    expect(creates(server).at(-1)!.body).toEqual({ term: 'robust kernel', definitionKo: '고친 정의', llmCallId: 'run-def' });
  });

  it('a connection dropped after run.done: re-sent once with the SAME id, the replay shows the suggestion', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi([]));
    await screen.findByText('용어집이 비어 있습니다');
    await requestDefinition(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }));
      server.end(); // cut without a terminal event
    });
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(defines(server)[1]!.body!.clientRequestId).toBe(defines(server)[0]!.body!.clientRequestId);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.doneParsed('x', PARSED, CITES));
      server.end();
    });
    expect(await screen.findByTestId('pn-glossary-suggestion')).toBeTruthy();
    expect(server.streamCount()).toBe(2);
  });

  it('dropped before run.done: the replay is run.error{cancelled} → no automatic request; "다시 요청" uses a NEW id', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi([]));
    await screen.findByText('용어집이 비어 있습니다');
    await requestDefinition(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.started());
      server.end();
    });
    await waitFor(() => expect(server.streamCount()).toBe(2));
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.error('cancelled'));
      server.end();
    });
    const lost = await screen.findByTestId('pn-glossary-define-lost');
    expect(lost.textContent).toContain('연결이 끊겨 취소됨');
    await act(async () => {});
    expect(server.streamCount()).toBe(2); // not re-sent automatically
    fireEvent.click(within(lost).getByTestId('pn-glossary-define-again'));
    await waitFor(() => expect(server.streamCount()).toBe(3));
    expect(defines(server)[2]!.body!.clientRequestId).not.toBe(defines(server)[0]!.body!.clientRequestId);
  });

  it('result_deleted: "다시 요청" notice', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi([]));
    await screen.findByText('용어집이 비어 있습니다');
    await requestDefinition(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.error('result_deleted'));
      server.end();
    });
    const lost = await screen.findByTestId('pn-glossary-define-lost');
    expect(lost.dataset.code).toBe('result_deleted');
    expect(within(lost).getByTestId('pn-glossary-define-again')).toBeTruthy();
  });

  it('a user cancel is not re-sent and not shown as a lost connection', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi([]));
    await screen.findByText('용어집이 비어 있습니다');
    await requestDefinition(server);
    server.onCancel(() => {
      server.push(ev.error('cancelled'));
      server.end();
    });
    await act(async () => server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' })));
    await act(async () => fireEvent.click(await screen.findByTestId('pn-glossary-define-cancel')));
    await waitFor(() => expect(screen.getByText('취소했습니다')).toBeTruthy());
    expect(screen.queryByTestId('pn-glossary-define-lost')).toBeNull();
    expect(server.streamCount()).toBe(1);
  });

  it('the reader "glossary" action fills the term and starts the request', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi([]));
    await screen.findByText('용어집이 비어 있습니다');
    act(() => useReaderStore.getState().requestAction({ kind: 'glossary', anchor: anchorOf('robust\n kernel'), text: 'robust\n kernel' }));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(defines(server)[0]!.body).toMatchObject({ term: 'robust kernel' });
    expect(useReaderStore.getState().pendingAction).toBeNull();
  });

  it('manual add, duplicate 409, edit and delete', async () => {
    const terms = [term('a', 'alpha', 'llm', '정의 A')];
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi(terms, { create: (c) => (c.body!.term === 'alpha' ? { status: 409, json: { error: { code: 'conflict', message: 'dup' } } } : undefined) }));
    await screen.findAllByTestId('pn-glossary-item');
    fireEvent.click(screen.getByTestId('pn-glossary-add'));
    fireEvent.change(screen.getByTestId('pn-glossary-add-term'), { target: { value: 'alpha' } });
    await act(async () => fireEvent.click(screen.getByTestId('pn-glossary-add-save')));
    expect(await screen.findByText('이미 있는 용어입니다')).toBeTruthy();
    fireEvent.change(screen.getByTestId('pn-glossary-add-term'), { target: { value: 'beta' } });
    fireEvent.change(screen.getByTestId('pn-glossary-add-def'), { target: { value: '베타 정의' } });
    await act(async () => fireEvent.click(screen.getByTestId('pn-glossary-add-save')));
    expect(creates(server).at(-1)!.body).toEqual({ term: 'beta', definitionKo: '베타 정의' });
    await waitFor(() => expect(screen.getAllByTestId('pn-glossary-item')).toHaveLength(2));
    const a = screen.getAllByTestId('pn-glossary-item')[0]!;
    fireEvent.click(within(a).getByTestId('pn-glossary-edit'));
    fireEvent.change(within(a).getByTestId('pn-glossary-edit-def'), { target: { value: '고친 A' } });
    await act(async () => fireEvent.click(within(a).getByTestId('pn-glossary-edit-save')));
    expect(server.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ definitionKo: '고친 A' });
    await waitFor(() => expect(within(screen.getAllByTestId('pn-glossary-item')[0]!).getByTestId('pn-glossary-origin').textContent).toBe('AI 제안 · 수정됨'));
    fireEvent.click(within(screen.getAllByTestId('pn-glossary-item')[0]!).getByTestId('pn-glossary-delete'));
    await act(async () => fireEvent.click(screen.getByTestId('pn-glossary-delete-confirm')));
    await waitFor(() => expect(screen.getAllByTestId('pn-glossary-item')).toHaveLength(1));
  });
});

describe('GlossaryTab review fixes (D-R1-06)', () => {
  it('"저장" of a suggestion is locked while it is being saved: a double click sends glossary.create once', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const terms: GlossaryTermDto[] = [];
    const base = glossaryApi(terms);
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, async (c) => {
      if (c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary`) await held;
      return base(c);
    });
    await screen.findByText('용어집이 비어 있습니다');
    await requestDefinition(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.doneParsed(BODY, PARSED, CITES));
      server.end();
    });
    const save = await screen.findByTestId('pn-glossary-suggestion-save');
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(creates(server)).toHaveLength(1));
    expect((screen.getByTestId('pn-glossary-suggestion-save') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    await screen.findByTestId('pn-glossary-saved');
    expect(creates(server)).toHaveLength(1);
    expect(screen.queryByTestId('pn-glossary-error')).toBeNull();
  });

  it('run.error{cancelled} the user did not ask for (no reconnect) → "취소됨" + "다시 요청" with a NEW id', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi([]));
    await screen.findByText('용어집이 비어 있습니다');
    await requestDefinition(server);
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.error('cancelled'));
      server.end();
    });
    const lost = await screen.findByTestId('pn-glossary-define-lost');
    expect(lost.dataset.code).toBe('cancelled');
    expect(lost.textContent).toContain('취소됨');
    expect(lost.textContent).not.toContain('연결이 끊겨');
    expect(server.streamCount()).toBe(1); // not re-sent automatically
    fireEvent.click(within(lost).getByTestId('pn-glossary-define-again'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(defines(server)[1]!.body!.clientRequestId).not.toBe(defines(server)[0]!.body!.clientRequestId);
  });
});

// Coordinator note D-5: glossary_define now really gets one SP-Blocks repair (S-1: repairMinRemainingMs = 60 s), so its
// stream may carry run.retrying. As for cards, the text received before it is dropped: the progress line says
// "형식 오류로 다시 요청 중…" until the repaired output starts, and the suggestion comes only from run.done.
describe('glossary.define with run.retrying (S-1)', () => {
  it('run.retrying clears the received text; the suggestion is the repaired run.done only', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, glossaryApi([]));
    await screen.findByText('용어집이 비어 있습니다');
    await requestDefinition(server);
    await act(async () => server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.started(), ev.delta('<term name="robust kernel">깨진 첫 출력')));
    const progress = await screen.findByTestId('pn-glossary-define-progress');
    await waitFor(() => expect(progress.textContent).toBe('정의 받는 중…'));
    await act(async () => server.push(ev.retrying(['item 1: a tag is not closed'])));
    await waitFor(() => expect(screen.getByTestId('pn-glossary-define-progress').textContent).toBe('형식 오류로 다시 요청 중…'));
    expect(screen.getByTestId('pn-glossary-define').textContent).not.toContain('깨진 첫 출력');
    await act(async () => server.push(ev.delta('<term name="robust kernel">고친')));
    await waitFor(() => expect(screen.getByTestId('pn-glossary-define-progress').textContent).toBe('정의 받는 중…'));
    await act(async () => {
      server.push(ev.doneParsed(`<term name="robust kernel">${BODY}</term>`, PARSED, CITES));
      server.end();
    });
    const sug = await screen.findByTestId('pn-glossary-suggestion');
    expect(sug.textContent).toContain('outlier 가중치를 줄인다');
    expect(screen.getByTestId('pn-glossary-define').textContent).not.toContain('깨진 첫 출력');
    expect(screen.queryByTestId('pn-glossary-define-progress')).toBeNull();
    expect(defines(server)).toHaveLength(1); // the repair is the server's; the client sends nothing again
  });
});
