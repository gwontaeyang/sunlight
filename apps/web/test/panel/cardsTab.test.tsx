// Cards tab (BRIEF_D D4): generation progress (no SP-Blocks text), run.retrying, cancel, 409 card_generating → polling
// llm.runs.get(details.runId) without an error, another 409 → error, parse_failed raw output as text, "확인함" / memo
// optimistic + restore + per-item order, regenerate confirmation, coming back to a generating card (fake timers),
// header counts, a summary card's block badges. Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardItemDto, PaperCardDto, RunDto } from '@study-paper/shared/contracts/api';
import { cardBadgeCounts, itemBadge } from '@study-paper/shared/contracts/grounding';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import summaryMd from '../../../../packages/shared/fixtures/mock-outputs/summary.md?raw';
import { pairStored } from '../../src/markdown/renderStored';
import { CardsTab, REGENERATE_CONFIRM, RUN_GET_FAIL_LIMIT } from '../../src/panel/CardsTab';
import { card, matchedCitations } from './cardFixtures';
import { PAPER, renderWithApi, resetReader } from './panelHarness';
import { ev, type FakeCall, type JsonReply } from './sseFake';

// Counts S's pairCitations calls (one pairing per item object — a patch re-pairs only the patched item).
const pairCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('@study-paper/shared/contracts/grounding', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@study-paper/shared/contracts/grounding')>();
  return {
    ...orig,
    pairCitations: (parsed: Parameters<typeof orig.pairCitations>[0], stored: Parameters<typeof orig.pairCitations>[1]) => {
      pairCalls.n++;
      return orig.pairCitations(parsed, stored);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => resetReader(true));

const runDto = (runId: string, status: RunDto['status']): RunDto => ({ runId, task: 'notation_card', status, errorCode: null, paperId: PAPER, threadId: null, model: 'opus', modelResolved: null, effort: 'high', acceptedAt: 1, startedAt: 1, finishedAt: status === 'running' ? null : 2 });

/** In-memory cards API: cards.list, cardItems.patch (optional override), llm.runs.get (status sequence). */
function cardsApi(state: { cards: PaperCardDto[]; runs?: Record<string, RunDto['status'][]>; patch?: (c: FakeCall, item: CardItemDto) => JsonReply | Promise<JsonReply> }) {
  const listCalls = { n: 0 };
  const handler = async (c: FakeCall): Promise<JsonReply | undefined> => {
    if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/cards`) {
      listCalls.n++;
      return { status: 200, json: { cards: state.cards } };
    }
    const run = /^\/api\/llm\/runs\/([^/]+)$/.exec(c.url);
    if (c.method === 'GET' && run) {
      const seq = state.runs?.[run[1]!] ?? ['running'];
      return { status: 200, json: runDto(run[1]!, seq.length > 1 ? seq.shift()! : seq[0]!) };
    }
    const item = /^\/api\/card-items\/([^/]+)$/.exec(c.url) ?? /^\/api\/cards\/items\/([^/]+)$/.exec(c.url);
    if (c.method === 'PATCH' && item) {
      const it = state.cards.flatMap((k) => k.items).find((x) => x.id === item[1])!;
      if (state.patch) return state.patch(c, it);
      Object.assign(it, c.body);
      return { status: 200, json: it };
    }
    return undefined;
  };
  return { handler, listCalls };
}

const section = (kind: string) => screen.getAllByTestId('pn-card-section').find((s) => s.dataset.kind === kind)!;

describe('CardsTab', () => {
  it('generation: progress without the SP-Blocks text, run.retrying, cancel; done → cards.list again', async () => {
    const api = cardsApi({ cards: [] });
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('notation'));
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(server.calls.find((c) => c.method === 'POST')).toMatchObject({ url: `/api/papers/${PAPER}/cards/notation/generate` });
    await act(async () => server.push(ev.acceptedRun({ runId: 'rc', task: 'notation_card', artifactId: 'card-new' }), ev.queued(2)));
    await waitFor(() => expect(within(sec).getByTestId('pn-card-progress').textContent).toContain('대기 중 · 순번 2'));
    await act(async () => server.push(ev.started('high')));
    await waitFor(() => expect(within(sec).getByTestId('pn-card-progress').textContent).toContain('생각 중'));
    await act(async () => server.push(ev.delta('<item key="frame_notation" label="N">비밀 원문</item>')));
    await waitFor(() => expect(within(sec).getByTestId('pn-card-progress').textContent).toMatch(/받은 글자 \d+자/));
    expect(sec.textContent).not.toContain('비밀 원문');
    expect(sec.textContent).not.toContain('<item');
    await act(async () => server.push(ev.retrying()));
    await waitFor(() => expect(within(sec).getByTestId('pn-card-progress').textContent).toContain('형식 오류로 다시 요청 중'));
    server.onCancel(() => {
      server.push(ev.error('cancelled'));
      server.end();
    });
    const before = api.listCalls.n;
    await act(async () => fireEvent.click(within(sec).getByTestId('pn-card-cancel')));
    await waitFor(() => expect(server.calls.some((c) => c.method === 'POST' && c.url === '/api/llm/runs/rc/cancel')).toBe(true));
    await waitFor(() => expect(api.listCalls.n).toBeGreaterThan(before));
    expect(within(sec).queryByTestId('pn-card-progress')).toBeNull();
  });

  it('409 card_generating → no error, "생성 중", polling llm.runs.get(details.runId) until done, then the card', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = { cards: [] as PaperCardDto[], runs: { 'run-other': ['running', 'running', 'ok'] as RunDto['status'][] } };
    const api = cardsApi(state);
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, (c) =>
      c.method === 'POST' && c.url.endsWith('/cards/notation/generate') ? { status: 409, json: { error: { code: 'conflict', message: 'generating', details: { reason: 'card_generating', runId: 'run-other', cardId: 'card-x' } } } } : api.handler(c),
    );
    const sec = await waitFor(() => section('notation'));
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    await waitFor(() => expect(within(sec).getByTestId('pn-card-progress').textContent).toContain('생성 중'));
    expect(within(sec).queryByTestId('pn-card-error')).toBeNull();
    const runGets = () => server.calls.filter((c) => c.url === '/api/llm/runs/run-other').length;
    await waitFor(() => expect(runGets()).toBe(1));
    state.cards = [card('notation', { runId: 'run-other' })];
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await waitFor(() => expect(runGets()).toBe(2));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
    expect(within(sec).queryByTestId('pn-card-progress')).toBeNull();
    expect(within(sec).queryByTestId('pn-card-error')).toBeNull();
    const n = runGets();
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(runGets()).toBe(n); // polling stopped
  });

  it('another 409 (payload_version) is shown as an error', async () => {
    const api = cardsApi({ cards: [] });
    renderWithApi(<CardsTab paperId={PAPER} />, (c) =>
      c.method === 'POST' && c.url.endsWith('/generate') ? { status: 409, json: { error: { code: 'conflict', message: 'x', details: { reason: 'payload_version', runId: 'r-old' } } } } : api.handler(c),
    );
    const sec = await waitFor(() => section('notation'));
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    expect((await within(sec).findByTestId('pn-card-error')).dataset.code).toBe('payload_version');
  });

  it('parse_failed: notice + raw output as text only (never elements) + "다시 생성"; the previous complete card stays', async () => {
    const raw = '<img src=x onerror="alert(1)"><script>alert(2)</script><item key="x">깨진 출력';
    const api = cardsApi({ cards: [card('notation', { createdAt: 5 }), card('notation', { id: 'card-bad', status: 'parse_failed', rawOutput: raw, items: [], createdAt: 9, errorCode: 'parse_failed' })] });
    renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('notation'));
    const pre = await within(sec).findByTestId('pn-card-raw');
    expect(pre.textContent).toBe(raw);
    expect(sec.querySelector('img, script')).toBeNull();
    expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11);
    expect(within(sec).getByTestId('pn-card-regenerate')).toBeTruthy();
  });

  it('error / interrupted cards show the reason', async () => {
    const api = cardsApi({ cards: [card('summary', { status: 'error', errorCode: 'total_timeout', items: [] }), card('assumptions', { status: 'interrupted', items: [] })] });
    renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    await waitFor(() => expect(within(section('summary')).getByTestId('pn-card-failed').textContent).toContain('전체 시간 한도'));
    expect(within(section('assumptions')).getByTestId('pn-card-failed').textContent).toContain('중단');
  });

  it('regenerate asks first: "확인함" is reset, notation memos are kept', async () => {
    const api = cardsApi({ cards: [card('notation')] });
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('notation'));
    await within(sec).findAllByTestId('pn-card-item');
    fireEvent.click(within(sec).getByTestId('pn-card-regenerate'));
    expect(server.streamCount()).toBe(0);
    expect(within(sec).getByTestId('pn-card-regen-dialog').textContent).toContain(REGENERATE_CONFIRM);
    expect(REGENERATE_CONFIRM).toBe("항목의 '확인함'이 초기화됩니다(표기 카드의 메모는 유지)");
    fireEvent.click(within(sec).getByTestId('pn-card-regen-confirm'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
  });

  it('"확인함" and memo: optimistic, serialised per item, restored from the server on failure', async () => {
    const holds: ((r: JsonReply) => void)[] = [];
    const order: string[] = [];
    const state = {
      cards: [card('notation')],
      patch: (c: FakeCall, it: CardItemDto) =>
        new Promise<JsonReply>((resolve) => {
          order.push(JSON.stringify(c.body));
          holds.push((r) => {
            if (r.status === 200) Object.assign(it, c.body);
            resolve(r.status === 200 ? { status: 200, json: { ...it } } : r);
          });
        }),
    };
    const api = cardsApi(state);
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('notation'));
    const first = (await within(sec).findAllByTestId('pn-card-item'))[0]!;
    const box = within(first).getByTestId('pn-card-confirm') as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true); // optimistic
    fireEvent.click(within(first).getByTestId('pn-card-note-edit'));
    fireEvent.change(within(first).getByTestId('pn-card-note-input'), { target: { value: '오른쪽 곱 규약' } });
    fireEvent.click(within(first).getByTestId('pn-card-note-save'));
    expect(within(first).getByTestId('pn-card-note').textContent).toContain('오른쪽 곱 규약');
    await waitFor(() => expect(order).toHaveLength(1)); // the memo patch waits for the first one
    await act(async () => holds[0]!({ status: 200 }));
    await waitFor(() => expect(order).toHaveLength(2));
    expect(order).toEqual(['{"confirmed":true}', '{"userNote":"오른쪽 곱 규약"}']);
    await act(async () => holds[1]!({ status: 500, json: { error: { code: 'internal', message: 'x' } } }));
    await waitFor(() => expect(within(first).getByTestId('pn-card-patch-error')).toBeTruthy());
    await waitFor(() => expect(within(first).queryByTestId('pn-card-note')).toBeNull()); // restored: no memo on the server
    expect((within(first).getByTestId('pn-card-confirm') as HTMLInputElement).checked).toBe(true); // the successful patch stays
    expect(server.calls.filter((c) => c.method === 'PATCH').every((c) => c.url === '/api/card-items/it-1')).toBe(true);
  });

  it('coming back to a generating card: polls its runId every 2 s; without a runId, cards.list every 5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = { cards: [card('notation', { id: 'card-gen', status: 'generating', items: [], runId: 'run-bg', createdAt: 20 }), card('summary', { id: 'card-sum', status: 'generating', items: [], runId: null })], runs: { 'run-bg': ['running', 'ok'] as RunDto['status'][] } };
    const api = cardsApi(state);
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    await waitFor(() => expect(within(section('notation')).getByTestId('pn-card-progress')).toBeTruthy());
    expect(within(section('summary')).getByTestId('pn-card-progress')).toBeTruthy();
    await waitFor(() => expect(server.calls.filter((c) => c.url === '/api/llm/runs/run-bg')).toHaveLength(1));
    const lists = api.listCalls.n;
    state.cards = [card('notation', { runId: 'run-bg', createdAt: 20 }), state.cards[1]!];
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await waitFor(() => expect(within(section('notation')).getAllByTestId('pn-card-item')).toHaveLength(11));
    expect(api.listCalls.n).toBeGreaterThan(lists);
    // summary: no runId → cards.list every 5 s
    const l2 = api.listCalls.n;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(api.listCalls.n).toBeGreaterThan(l2));
  });

  it('header counts = cardBadgeCounts of the item badges (notation fixture), summary is not counted', async () => {
    const notation = card('notation');
    notation.items[1]!.confirmed = true;
    const api = cardsApi({ cards: [notation, card('summary', { items: [{ ...notation.items[5]!, id: 'sum-1', key: 'summary', label: null, title: null }] })] });
    renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('notation'));
    await within(sec).findAllByTestId('pn-card-item');
    const want = cardBadgeCounts(notation.items.map((it) => itemBadge(it.label, pairStored(it.bodyMd, it.citations, { labels: 'strip' }).paired)));
    expect(want).toMatchObject({ grounded_quote: 4, equation_ref: 1, not_stated: 6, unconfirmed: 0 });
    const counts = within(sec).getByTestId('pn-card-counts');
    const shown = Object.fromEntries([...counts.querySelectorAll('[data-count]')].map((e) => [(e as HTMLElement).dataset.count, e.textContent]));
    expect(shown).toEqual({ grounded_quote: '논문 근거 4', equation_ref: '식 참조만 1', not_stated: '명시 없음 6', confirmed: '확인함 1 / 11' });
    const badges = within(sec).getAllByTestId('pn-item-badge').map((b) => b.dataset.badge);
    expect(badges.filter((b) => b === 'grounded_quote')).toHaveLength(4);
    // summary item: no item badge and no header counts
    const sum = section('summary');
    expect(within(sum).queryByTestId('pn-card-counts')).toBeNull();
    expect(within(sum).queryByTestId('pn-item-badge')).toBeNull();
  });

  it('summary card: the body keeps its [[P]]/[[N]] block badges (labels badge, as the server stores it), no item badge or counts', async () => {
    // Review D-RP1-03: the server stores a summary from parseAnswer(text, { final: true }) — labels 'badge' — and the
    // block badges are the summary's only grounding marks. With 'strip' they would all vanish.
    const blocks = parseAnswer(summaryMd, { final: true }).blocks.filter((b) => b.label);
    expect(blocks.map((b) => b.label)).toEqual(['P', 'P', 'P', 'P', 'N']);
    const sumItem: CardItemDto = { id: 'sum-1', ordinal: 1, key: 'summary', category: null, label: null, title: null, bodyMd: summaryMd, attrs: {}, confirmed: false, userNote: null, citations: matchedCitations(summaryMd, 'badge') };
    const api = cardsApi({ cards: [card('summary', { items: [sumItem] })] });
    renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sum = await waitFor(() => section('summary'));
    const item = await within(sum).findByTestId('pn-card-item');
    const badges = within(item).getAllByTestId('sp-badge');
    expect(badges).toHaveLength(blocks.length);
    expect(badges.map((b) => b.dataset.status)).toEqual(['p-grounded', 'p-unverified', 'p-grounded', 'p-equation-ref', 'N']);
    // each "p-grounded" badge sits in a block with a verbatim quote chip
    for (const b of badges.filter((x) => x.dataset.status === 'p-grounded')) expect(b.closest('p, li')!.querySelector('[data-testid="sp-chip"][data-status="verbatim"]')).not.toBeNull();
    expect(within(item).getAllByTestId('sp-chip').map((c) => c.dataset.status)).toEqual(['verbatim', 'verbatim', 'resolved', 'resolved']);
    expect(within(sum).queryByTestId('pn-item-badge')).toBeNull();
    expect(within(sum).queryByTestId('pn-card-counts')).toBeNull();
  });

  it('assumptions: grouped by category (server titles), limitation shows 저자 명시 / 추론', async () => {
    const api = cardsApi({ cards: [card('assumptions')] });
    renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('assumptions'));
    const groups = await within(sec).findAllByTestId('pn-card-category');
    expect(groups.map((g) => g.dataset.category)).toEqual(['motion', 'computation', 'limitation']);
    expect(groups[2]!.textContent).toContain('한계');
    expect(within(groups[2]!).getByTestId('pn-card-stated').textContent).toBe('추론');
    expect(within(groups[0]!).queryByTestId('pn-card-stated')).toBeNull();
  });
});

describe('CardsTab watch: always a way out (review D-R1-02) and a cut connection (D-R1-04)', () => {
  it('run terminal but cards.list still says generating → "생성 상태를 확인하지 못했습니다" + "다시 생성", polling stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = { cards: [card('notation', { id: 'card-gen', status: 'generating', items: [], runId: 'run-dead', createdAt: 20 })], runs: { 'run-dead': ['interrupted'] as RunDto['status'][] } };
    const api = cardsApi(state);
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('notation'));
    const uncertain = await within(sec).findByTestId('pn-card-uncertain');
    expect(uncertain.dataset.reason).toBe('terminal');
    expect(uncertain.textContent).toContain('생성 상태를 확인하지 못했습니다');
    expect(within(sec).queryByTestId('pn-card-progress')).toBeNull();
    const runGets = () => server.calls.filter((c) => c.url === '/api/llm/runs/run-dead').length;
    expect(runGets()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(runGets()).toBe(1); // no further polling of a terminal run
    // The server cleans the mismatched row up on the next generate request.
    fireEvent.click(within(sec).getByTestId('pn-card-regenerate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    expect(server.calls.find((c) => c.method === 'POST')).toMatchObject({ url: `/api/papers/${PAPER}/cards/notation/generate` });
    expect(within(sec).queryByTestId('pn-card-uncertain')).toBeNull();
  });

  it(`llm.runs.get keeps failing → at most ${RUN_GET_FAIL_LIMIT} calls, then cards.list every 5 s with the "다시 생성" button; a late completion still shows`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = { cards: [card('notation', { id: 'card-gen', status: 'generating', items: [], runId: 'run-404', createdAt: 20 })] };
    const api = cardsApi(state);
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, (c) => (c.url === '/api/llm/runs/run-404' ? { status: 404, json: { error: { code: 'not_found', message: 'run' } } } : api.handler(c)));
    const sec = await waitFor(() => section('notation'));
    const runGets = () => server.calls.filter((c) => c.url === '/api/llm/runs/run-404').length;
    await waitFor(() => expect(runGets()).toBe(1));
    for (let i = 0; i < RUN_GET_FAIL_LIMIT + 2; i++) await act(async () => vi.advanceTimersByTimeAsync(2000));
    await waitFor(() => expect(within(sec).getByTestId('pn-card-uncertain').dataset.reason).toBe('unknown'));
    expect(within(sec).getByTestId('pn-card-regenerate')).toBeTruthy();
    expect(within(sec).queryByTestId('pn-card-progress')).toBeNull();
    const lists = api.listCalls.n;
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(runGets()).toBe(RUN_GET_FAIL_LIMIT);
    expect(api.listCalls.n).toBeGreaterThan(lists); // cards.list polling continues
    state.cards = [card('notation', { runId: 'run-404', createdAt: 20 })];
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
    expect(within(sec).queryByTestId('pn-card-uncertain')).toBeNull();
  });

  it('a cut stream: card wording (not the thread one) + "다시 연결"; gone once the card is complete', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = { cards: [] as PaperCardDto[], runs: { 'run-c': ['running', 'ok'] as RunDto['status'][] } };
    const api = cardsApi(state);
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('notation'));
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    state.cards = [card('notation', { id: 'card-new', status: 'generating', items: [], runId: 'run-c', createdAt: 20 })];
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-c', task: 'notation_card', artifactId: 'card-new' }), ev.started('high'));
      server.end();
    });
    const err = await within(sec).findByTestId('pn-card-error');
    expect(err.textContent).toContain('생성은 서버에서 계속되고 끝나면 여기에 표시됩니다');
    expect(err.textContent).not.toContain('thread');
    expect(within(err).getByTestId('pn-card-reconnect')).toBeTruthy();
    await waitFor(() => expect(within(sec).getByTestId('pn-card-progress')).toBeTruthy());
    state.cards = [card('notation', { id: 'card-new', runId: 'run-c', createdAt: 20 })];
    for (let i = 0; i < 3; i++) await act(async () => vi.advanceTimersByTimeAsync(2000));
    await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
    expect(within(sec).queryByTestId('pn-card-error')).toBeNull();
  });

  it('a stream cut BEFORE run.accepted (no artifactId): the error line goes once the watched card is complete (review D-R2-03)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = { cards: [] as PaperCardDto[], runs: { 'run-c': ['running', 'ok'] as RunDto['status'][] } };
    const api = cardsApi(state);
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('notation'));
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    state.cards = [card('notation', { id: 'card-new', status: 'generating', items: [], runId: 'run-c', createdAt: 20 })];
    await act(async () => server.end()); // no event at all
    const err = await within(sec).findByTestId('pn-card-error');
    expect(err.dataset.code).toBe('stream_interrupted');
    expect(err.textContent).toContain('생성은 서버에서 계속되고 끝나면 여기에 표시됩니다');
    await waitFor(() => expect(within(sec).getByTestId('pn-card-progress')).toBeTruthy());
    state.cards = [card('notation', { id: 'card-new', runId: 'run-c', createdAt: 20 })];
    for (let i = 0; i < 3; i++) await act(async () => vi.advanceTimersByTimeAsync(2000));
    await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
    expect(within(sec).queryByTestId('pn-card-error')).toBeNull();
    // A new run's error is shown again (the dismissal belongs to that one cut).
    fireEvent.click(within(sec).getByTestId('pn-card-regenerate'));
    fireEvent.click(await within(sec).findByTestId('pn-card-regen-confirm'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    await act(async () => server.end());
    expect((await within(sec).findByTestId('pn-card-error')).dataset.code).toBe('stream_interrupted');
  });
});

describe('CardsTab pairing per item (review D-R1-03)', () => {
  it('a "확인함" patch re-pairs only the patched item (pairCitations +≤1), not every item of the card', async () => {
    const api = cardsApi({ cards: [card('notation')] });
    const { server } = renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('notation'));
    const items = await within(sec).findAllByTestId('pn-card-item');
    expect(items).toHaveLength(11);
    const before = pairCalls.n;
    expect(before).toBeGreaterThanOrEqual(11);
    await act(async () => fireEvent.click(within(items[2]!).getByTestId('pn-card-confirm')));
    await waitFor(() => expect(server.calls.some((c) => c.method === 'PATCH')).toBe(true));
    await waitFor(() => expect((within(section('notation')).getAllByTestId('pn-card-confirm')[2] as HTMLInputElement).checked).toBe(true));
    await act(async () => vi.waitFor(() => Promise.resolve()));
    expect(pairCalls.n - before).toBeLessThanOrEqual(1);
  });
});
