// Review D-I10-02: a failed (re)load never takes away what is already on screen, and always offers "다시 시도".
// - Cards: a cards.list refetch that fails while cards are shown keeps the sections (items, "확인함", an open generate
//   stream and its progress) and adds one error line with "다시 시도"; a first load that fails offers "다시 시도" too.
// - Equations / references: a structure load that fails offers "다시 시도"; a failed refetch keeps the list.
// Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaperCardDto, RunDto } from '@study-paper/shared/contracts/api';
import { qk } from '../../src/api/queryKeys';
import { CardsTab } from '../../src/panel/CardsTab';
import { EquationsTab } from '../../src/panel/EquationsTab';
import { ReferencesTab } from '../../src/panel/ReferencesTab';
import { useReaderStore } from '../../src/state/readerStore';
import { card } from './cardFixtures';
import { PAPER, renderWithApi, resetReader } from './panelHarness';
import { ev, type FakeCall, type JsonReply } from './sseFake';
import { structureFixture } from './structureFixture';

class FakeIO {
  constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
  observe() {
    queueMicrotask(() => this.cb([{ isIntersecting: true }]));
  }
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', FakeIO);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  resetReader(true);
  useReaderStore.setState({ paperState: { readable: true, contextReady: true, structureReady: true } });
});

const FAIL: JsonReply = { status: 500, json: { error: { code: 'internal', message: 'boom' } } };
const section = (kind: string) => screen.getAllByTestId('pn-card-section').find((s) => s.dataset.kind === kind)!;

function cardsApi(state: { cards: PaperCardDto[]; failList: boolean }) {
  const lists = { n: 0 };
  const handler = (c: FakeCall): JsonReply | undefined => {
    if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/cards`) {
      lists.n++;
      return state.failList ? FAIL : { status: 200, json: { cards: state.cards } };
    }
    return undefined;
  };
  return { handler, lists };
}

describe('CardsTab: a failed cards.list refetch (review D-I10-02)', () => {
  it('shown cards stay (items, "확인함") with one error line + "다시 시도"; "다시 시도" recovers', async () => {
    const state = { cards: [card('notation')], failList: false };
    const api = cardsApi(state);
    const { qc } = renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    await waitFor(() => expect(within(section('notation')).getAllByTestId('pn-card-item')).toHaveLength(11));
    state.failList = true;
    const failedBefore = api.lists.n;
    await act(async () => qc.invalidateQueries({ queryKey: qk.cards(PAPER) }));
    await waitFor(() => expect(api.lists.n).toBe(failedBefore + 1));
    await act(async () => {});
    expect(screen.queryAllByTestId('pn-card-section')).toHaveLength(3);
    expect(within(section('notation')).getAllByTestId('pn-card-item')).toHaveLength(11);
    const err = await screen.findByTestId('pn-cards-load-error');
    expect(err.textContent).toContain('카드 목록을 새로 불러오지 못했습니다');
    state.failList = false;
    const before = api.lists.n;
    fireEvent.click(within(err).getByTestId('pn-load-retry'));
    await waitFor(() => expect(screen.queryByTestId('pn-cards-load-error')).toBeNull());
    expect(api.lists.n).toBe(before + 1);
    expect(within(section('notation')).getAllByTestId('pn-card-item')).toHaveLength(11);
  });

  it('an open generate stream keeps its progress (the section is not unmounted, the stream not aborted)', async () => {
    const state = { cards: [] as PaperCardDto[], failList: false };
    const api = cardsApi(state);
    const { server, qc } = renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const sec = await waitFor(() => section('summary'));
    fireEvent.click(within(sec).getByTestId('pn-card-generate'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => server.push(ev.acceptedRun({ runId: 'run-s', task: 'summary', artifactId: 'card-summary' }), ev.started('high')));
    state.failList = true;
    const failedBefore = api.lists.n;
    await act(async () => qc.invalidateQueries({ queryKey: qk.cards(PAPER) }));
    await waitFor(() => expect(api.lists.n).toBe(failedBefore + 1));
    await act(async () => {});
    const sec2 = screen.queryAllByTestId('pn-card-section').find((s) => s.dataset.kind === 'summary');
    expect(sec2).toBe(sec); // same element: not unmounted
    expect(within(sec2!).getByTestId('pn-card-progress').textContent).toContain('생각 중');
    expect(within(sec2!).getByTestId('pn-card-cancel')).toBeTruthy();
    await screen.findByTestId('pn-cards-load-error');
    // the stream is still open: its terminal arrives and the list is read again (now successfully)
    state.failList = false;
    state.cards = [card('summary', { id: 'card-summary', runId: 'run-s' })];
    await act(async () => {
      server.push(ev.doneParsed('x', { items: [], outsideText: '', issues: [] }));
      server.end();
    });
    await waitFor(() => expect(screen.queryByTestId('pn-cards-load-error')).toBeNull());
    expect(within(section('summary')).queryByTestId('pn-card-progress')).toBeNull();
    expect(within(section('summary')).queryByTestId('pn-card-error')).toBeNull();
  });

  // Review D-FX2R1-01: the generating watch must not read a failed refetch (the cache still holds the old 'generating'
  // card) as "still generating" — that stopped the watch for good with the "uncertain" line and "다시 생성".
  it('watch: the run turns terminal while one cards.list refetch fails → no "uncertain"; the next poll shows the card', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runDto = (status: RunDto['status']): RunDto => ({ runId: 'run-c', task: 'notation_card', status, errorCode: null, paperId: PAPER, threadId: null, model: 'opus', modelResolved: null, effort: 'high', acceptedAt: 1, startedAt: 1, finishedAt: status === 'running' ? null : 2 });
    const state = { cards: [card('notation', { id: 'card-new', status: 'generating', items: [], runId: 'run-c', createdAt: 20 })] as PaperCardDto[], run: 'running' as RunDto['status'], failsLeft: 0 };
    const counts = { lists: 0, runs: 0 };
    const handler = (c: FakeCall): JsonReply | undefined => {
      if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/cards`) {
        counts.lists++;
        if (state.failsLeft > 0) {
          state.failsLeft--;
          return FAIL;
        }
        return { status: 200, json: { cards: state.cards } };
      }
      if (c.method === 'GET' && /^\/api\/llm\/runs\//.test(c.url)) {
        counts.runs++;
        return { status: 200, json: runDto(state.run) };
      }
      return undefined;
    };
    renderWithApi(<CardsTab paperId={PAPER} />, handler);
    const sec = await waitFor(() => section('notation'));
    await waitFor(() => expect(within(sec).getByTestId('pn-card-progress')).toBeTruthy());
    // the run finishes on the server and the card is complete, but the one list read right after fails
    state.run = 'ok';
    state.cards = [card('notation', { id: 'card-new', runId: 'run-c', createdAt: 20 })];
    state.failsLeft = 1;
    const lists0 = counts.lists;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await waitFor(() => expect(counts.lists).toBe(lists0 + 1));
    await act(async () => {});
    expect(await screen.findByTestId('pn-cards-load-error')).toBeTruthy();
    expect(within(sec).queryByTestId('pn-card-uncertain')).toBeNull();
    expect(within(sec).getByTestId('pn-card-progress')).toBeTruthy();
    expect(within(sec).queryByTestId('pn-card-regenerate')).toBeNull();
    // the next poll (cards.list, 5 s) succeeds: the card shows without any click and the error line goes away
    const runs0 = counts.runs;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
    expect(screen.queryByTestId('pn-cards-load-error')).toBeNull();
    expect(within(sec).queryByTestId('pn-card-uncertain')).toBeNull();
    expect(within(sec).queryByTestId('pn-card-progress')).toBeNull();
    expect(counts.runs).toBe(runs0); // the run is terminal: it is not asked for again
  });

  // Review D-FX2R2-01: the fallback must keep "the run is terminal". When the next successful read still says
  // 'generating' (the PLAN_M2 3.4 mismatch), it is decided the same as without the failed read: "uncertain{terminal}"
  // + "다시 생성", and the polling stops.
  it('watch: run terminal, one cards.list read fails, the next read still says generating → uncertain{terminal} + "다시 생성", polling stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runDto = (status: RunDto['status']): RunDto => ({ runId: 'run-c', task: 'notation_card', status, errorCode: null, paperId: PAPER, threadId: null, model: 'opus', modelResolved: null, effort: 'high', acceptedAt: 1, startedAt: 1, finishedAt: status === 'running' ? null : 2 });
    const state = { cards: [card('notation', { id: 'card-new', status: 'generating', items: [], runId: 'run-c', createdAt: 20 })] as PaperCardDto[], run: 'running' as RunDto['status'], failsLeft: 0 };
    const counts = { lists: 0, runs: 0 };
    const handler = (c: FakeCall): JsonReply | undefined => {
      if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/cards`) {
        counts.lists++;
        if (state.failsLeft > 0) {
          state.failsLeft--;
          return FAIL;
        }
        return { status: 200, json: { cards: state.cards } };
      }
      if (c.method === 'GET' && /^\/api\/llm\/runs\//.test(c.url)) {
        counts.runs++;
        return { status: 200, json: runDto(state.run) };
      }
      return undefined;
    };
    renderWithApi(<CardsTab paperId={PAPER} />, handler);
    const sec = await waitFor(() => section('notation'));
    await waitFor(() => expect(within(sec).getByTestId('pn-card-progress')).toBeTruthy());
    // the run ends but the row stays 'generating' (mismatch), and the one list read right after the run read fails
    state.run = 'ok';
    state.failsLeft = 1;
    const lists0 = counts.lists;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await waitFor(() => expect(counts.lists).toBe(lists0 + 1));
    await act(async () => {});
    expect(await screen.findByTestId('pn-cards-load-error')).toBeTruthy();
    expect(within(sec).queryByTestId('pn-card-uncertain')).toBeNull();
    // the next poll (cards.list, 5 s) succeeds and still says generating: decided like the path without a failed read
    const runs0 = counts.runs;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(within(sec).getByTestId('pn-card-uncertain').dataset.reason).toBe('terminal'));
    expect(within(sec).getByTestId('pn-card-regenerate')).toBeTruthy();
    expect(within(sec).queryByTestId('pn-card-progress')).toBeNull();
    expect(screen.queryByTestId('pn-cards-load-error')).toBeNull();
    expect(counts.runs).toBe(runs0);
    // the polling stopped: no further cards.list or llm.runs.get reads
    const lists1 = counts.lists;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(counts.lists).toBe(lists1);
    expect(counts.runs).toBe(runs0);
  });

  // Review D-FX2R3-01: this section's own stream ended with run.done but the cards.list read right after it failed.
  // The old list does not have the new card, which used to show "아직 만들지 않았습니다" + an enabled "생성" — one more
  // cards.generate (a new LLM run) per click, and nothing re-read the list by itself.
  describe('own run.done, then the cards.list read after it fails (review D-FX2R3-01)', () => {
    const cardUrl = `/api/papers/${PAPER}/cards`;
    function setup(initial: PaperCardDto[] = []) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const state = { cards: initial, failsLeft: 0 };
      const counts = { lists: 0, runs: 0 };
      const handler = (c: FakeCall): JsonReply | undefined => {
        if (c.method === 'GET' && c.url === cardUrl) {
          counts.lists++;
          if (state.failsLeft > 0) {
            state.failsLeft--;
            return FAIL;
          }
          return { status: 200, json: { cards: state.cards } };
        }
        if (c.method === 'GET' && /^\/api\/llm\/runs\//.test(c.url)) counts.runs++;
        const patched = c.method === 'PATCH' ? /^\/api\/card-items\/([^/]+)$/.exec(c.url) : null;
        const item = patched ? initial.flatMap((k) => k.items).find((i) => i.id === patched[1]) : undefined;
        if (item) return { status: 200, json: { ...item, ...(c.body as object) } };
        return undefined;
      };
      const r = renderWithApi(<CardsTab paperId={PAPER} />, handler);
      const generates = () => r.server.calls.filter((c) => c.method === 'POST' && c.url === `${cardUrl}/notation/generate`).length;
      return { ...r, state, counts, generates };
    }
    /** Generates the notation card; the server then answers `after` to cards.list, but the first read after run.done fails. */
    async function generateThenFailRead(t: ReturnType<typeof setup>, after: PaperCardDto[]) {
      const sec = await waitFor(() => section('notation'));
      fireEvent.click(within(sec).getByTestId('pn-card-generate'));
      await waitFor(() => expect(t.server.streamCount()).toBe(1));
      await act(async () => t.server.push(ev.acceptedRun({ runId: 'run-n', task: 'notation_card', artifactId: 'card-new' }), ev.started('high')));
      t.state.cards = after;
      t.state.failsLeft = 1;
      const lists0 = t.counts.lists;
      await act(async () => {
        t.server.push(ev.doneParsed('x', { items: [], outsideText: '', issues: [] }));
        t.server.end();
      });
      await waitFor(() => expect(t.counts.lists).toBe(lists0 + 1));
      await act(async () => {});
      await screen.findByTestId('pn-cards-load-error');
      return sec;
    }
    const expectChecking = (sec: HTMLElement) => {
      expect(within(sec).getByTestId('pn-card-checking').textContent).toContain('생성이 끝났습니다');
      expect(within(sec).queryByTestId('pn-card-generate')).toBeNull();
      expect(within(sec).queryByTestId('pn-card-regenerate')).toBeNull();
      expect(within(sec).queryByText('아직 만들지 않았습니다')).toBeNull();
      expect(within(sec).queryByTestId('pn-card-progress')).toBeNull();
      expect(within(sec).queryByTestId('pn-card-error')).toBeNull();
    };

    it('"checking the result" without generate/regenerate; the next list poll (5 s) shows the card; still 1 cards.generate', async () => {
      const t = setup();
      const sec = await generateThenFailRead(t, [card('notation', { id: 'card-new', runId: 'run-n', createdAt: 20 })]);
      expectChecking(sec);
      expect(t.generates()).toBe(1);
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
      expect(within(sec).queryByTestId('pn-card-checking')).toBeNull();
      expect(screen.queryByTestId('pn-cards-load-error')).toBeNull();
      expect(within(sec).getByTestId('pn-card-regenerate')).toBeTruthy();
      expect(t.generates()).toBe(1);
      expect(t.counts.runs).toBe(0);
      const lists1 = t.counts.lists;
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(t.counts.lists).toBe(lists1);
    });

    it('a list read that keeps failing keeps "checking" (polled every 5 s) and never offers generate', async () => {
      const t = setup();
      const sec = await generateThenFailRead(t, [card('notation', { id: 'card-new', runId: 'run-n', createdAt: 20 })]);
      t.state.failsLeft = 2;
      const lists0 = t.counts.lists;
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => expect(t.counts.lists).toBe(lists0 + 1));
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => expect(t.counts.lists).toBe(lists0 + 2));
      await act(async () => {});
      expectChecking(sec);
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
      expect(t.generates()).toBe(1);
    });

    it('"다시 시도" above is a successful read too: it ends "checking" at once', async () => {
      const t = setup();
      const sec = await generateThenFailRead(t, [card('notation', { id: 'card-new', runId: 'run-n', createdAt: 20 })]);
      expectChecking(sec);
      fireEvent.click(within(screen.getByTestId('pn-cards-load-error')).getByTestId('pn-load-retry'));
      await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
      expect(within(sec).queryByTestId('pn-card-checking')).toBeNull();
      expect(t.generates()).toBe(1);
    });

    it.each([
      { name: 'the card is not in the list', after: () => [] as PaperCardDto[], button: 'pn-card-generate', reason: null },
      { name: 'the card is still generating (mismatch)', after: () => [card('notation', { id: 'card-new', status: 'generating', items: [], runId: 'run-n', createdAt: 20 })], button: 'pn-card-regenerate', reason: 'terminal' },
    ])('the first successful read ends it even when $name; the polling stops', async ({ after, button, reason }) => {
      const t = setup();
      const sec = await generateThenFailRead(t, after());
      expectChecking(sec);
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => expect(within(sec).queryByTestId('pn-card-checking')).toBeNull());
      expect(within(sec).getByTestId(button)).toBeTruthy();
      expect(within(sec).queryByTestId('pn-card-uncertain')?.dataset.reason ?? null).toBe(reason);
      expect(within(sec).queryByTestId('pn-card-progress')).toBeNull();
      expect(t.counts.runs).toBe(0);
      const lists1 = t.counts.lists;
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(t.counts.lists).toBe(lists1);
      expect(t.counts.runs).toBe(0);
      expect(t.generates()).toBe(1);
    });

    // Review D-FX2BR1-01 (a): only a fetch of the list ends the check. Ticking "확인함" on the previous card writes the
    // cache by hand (setQueryData after the PATCH); taking that write for a read would end "checking" and offer
    // "다시 생성" again over the old list.
    it('regenerate over a complete card: ticking "확인함" on the old card (a manual cache write) does not end "checking"', async () => {
      const old = card('notation', { id: 'card-old', runId: 'run-o', createdAt: 10 });
      const t = setup([old]);
      const sec = await waitFor(() => section('notation'));
      await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
      fireEvent.click(within(sec).getByTestId('pn-card-regenerate'));
      fireEvent.click(within(sec).getByTestId('pn-card-regen-confirm'));
      await waitFor(() => expect(t.server.streamCount()).toBe(1));
      await act(async () => t.server.push(ev.acceptedRun({ runId: 'run-n', task: 'notation_card', artifactId: 'card-new' }), ev.started('high')));
      t.state.cards = [card('notation', { id: 'card-new', runId: 'run-n', createdAt: 20 })];
      t.state.failsLeft = 1;
      const lists0 = t.counts.lists;
      await act(async () => {
        t.server.push(ev.doneParsed('x', { items: [], outsideText: '', issues: [] }));
        t.server.end();
      });
      await waitFor(() => expect(t.counts.lists).toBe(lists0 + 1));
      await screen.findByTestId('pn-cards-load-error');
      expectChecking(sec);
      const box = within(sec).getAllByTestId('pn-card-confirm')[0] as HTMLInputElement;
      await act(async () => fireEvent.click(box));
      await waitFor(() => expect(t.server.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1));
      await waitFor(() => expect((within(sec).getAllByTestId('pn-card-confirm')[0] as HTMLInputElement).checked).toBe(true));
      await act(async () => {});
      expectChecking(sec);
      expect(t.counts.lists).toBe(lists0 + 1);
      expect(t.generates()).toBe(1);
      // the next list poll (5 s) is the first successful read: the new card shows
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      await waitFor(() => expect(within(sec).getByTestId('pn-card').dataset.cardId).toBe('card-new'));
      expect(within(sec).queryByTestId('pn-card-checking')).toBeNull();
      expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11);
      expect(t.generates()).toBe(1);
    });

    // Review D-FX2BR1-01 (b): between run.done and the first cards.list read after it (the stream still open, so the
    // read has not even started) the list on screen is the old one: still "checking", not "아직 만들지 않았습니다" + "생성".
    it('run.done received but the stream not closed yet: "checking" before any read; after EOF the card shows', async () => {
      const t = setup();
      const sec = await waitFor(() => section('notation'));
      fireEvent.click(within(sec).getByTestId('pn-card-generate'));
      await waitFor(() => expect(t.server.streamCount()).toBe(1));
      await act(async () => t.server.push(ev.acceptedRun({ runId: 'run-n', task: 'notation_card', artifactId: 'card-new' }), ev.started('high')));
      t.state.cards = [card('notation', { id: 'card-new', runId: 'run-n', createdAt: 20 })];
      const lists0 = t.counts.lists;
      await act(async () => t.server.push(ev.doneParsed('x', { items: [], outsideText: '', issues: [] })));
      await act(async () => {});
      expectChecking(sec);
      expect(t.counts.lists).toBe(lists0);
      expect(screen.queryByTestId('pn-cards-load-error')).toBeNull();
      await act(async () => t.server.end());
      await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
      expect(within(sec).queryByTestId('pn-card-checking')).toBeNull();
      expect(t.counts.lists).toBe(lists0 + 1);
      expect(t.generates()).toBe(1);
    });

    // Review D-FX2BR2-01: the render that ends "checking" must not come before the render with the new list. The end of
    // the check (doneRead ok) used to be set right inside the query cache dispatch (or right after the invalidate
    // promise), while useQuery gets the new data through the notifyManager a timer later: one commit showed the OLD
    // list without "checking" — "아직 만들지 않았습니다" + an enabled "생성" (or the old card + "다시 생성") — and a
    // click there started one more cards.generate.
    const doneParsed = () => ev.doneParsed('x', { items: [], outsideText: '', issues: [] });
    const noOldListOffer = (sec: HTMLElement) =>
      !within(sec).queryByTestId('pn-card-generate') && !within(sec).queryByTestId('pn-card-regenerate') && !sec.textContent!.includes('아직 만들지 않았습니다');

    it.each([
      { name: 'first generate', initial: () => [] as PaperCardDto[] },
      { name: 'regenerate over a complete card', initial: () => [card('notation', { id: 'card-old', runId: 'run-o', createdAt: 10 })] },
    ])('$name, the read after run.done fails: no 1 ms step between the failed read and the new card offers generate on the old list', async ({ initial }) => {
      // A manual clock (RTL's waitFor would wait on the faked timers): walk it 1 ms at a time and look at every step.
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const state = { cards: initial(), failsLeft: 0 };
      const { server } = renderWithApi(<CardsTab paperId={PAPER} />, (c: FakeCall): JsonReply | undefined => {
        if (c.method === 'GET' && c.url === cardUrl) {
          if (state.failsLeft > 0) {
            state.failsLeft--;
            return FAIL;
          }
          return { status: 200, json: { cards: state.cards } };
        }
        return undefined;
      });
      await act(async () => vi.advanceTimersByTimeAsync(10));
      const sec = section('notation');
      if (state.cards.length === 0) fireEvent.click(within(sec).getByTestId('pn-card-generate'));
      else {
        fireEvent.click(within(sec).getByTestId('pn-card-regenerate'));
        fireEvent.click(within(sec).getByTestId('pn-card-regen-confirm'));
      }
      await act(async () => vi.advanceTimersByTimeAsync(10));
      expect(server.streamCount()).toBe(1);
      await act(async () => server.push(ev.acceptedRun({ runId: 'run-n', task: 'notation_card', artifactId: 'card-new' }), ev.started('high')));
      state.cards = [card('notation', { id: 'card-new', runId: 'run-n', createdAt: 20 })];
      state.failsLeft = 1;
      await act(async () => {
        server.push(doneParsed());
        server.end();
      });
      await act(async () => vi.advanceTimersByTimeAsync(10));
      expect(screen.getByTestId('pn-cards-load-error')).toBeTruthy();
      expectChecking(sec);
      const offered: number[] = [];
      for (let ms = 0; ms < 6000 && within(sec).queryByTestId('pn-card')?.dataset.cardId !== 'card-new'; ms++) {
        await act(async () => vi.advanceTimersByTimeAsync(1));
        if (within(sec).queryByTestId('pn-card')?.dataset.cardId !== 'card-new' && !noOldListOffer(sec)) offered.push(ms);
      }
      expect(within(sec).getByTestId('pn-card').dataset.cardId).toBe('card-new');
      expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11);
      expect(offered).toEqual([]);
      expect(server.calls.filter((c) => c.method === 'POST' && c.url === `${cardUrl}/notation/generate`)).toHaveLength(1);
    });

    // The read after run.done that does NOT fail: inside act() React batches the two updates into one commit, so this
    // case only shows with the act environment off (updates scheduled as in a browser), real timers, and every commit
    // recorded by a Profiler.
    it.each([
      { name: 'first generate', initial: () => [] as PaperCardDto[] },
      { name: 'regenerate over a complete card', initial: () => [card('notation', { id: 'card-old', runId: 'run-o', createdAt: 10 })] },
    ])('$name, the read after run.done succeeds: no commit shows the old list without "checking" (act environment off)', async ({ initial }) => {
      const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const actEnv = env.IS_REACT_ACT_ENVIRONMENT;
      const state = { cards: initial() };
      const commits: { offered: boolean; card: string | null }[] = [];
      let record = false;
      const onCommit = () => {
        const sec = record ? screen.queryAllByTestId('pn-card-section').find((s) => s.dataset.kind === 'notation') : undefined;
        if (sec) commits.push({ offered: !noOldListOffer(sec), card: within(sec).queryByTestId('pn-card')?.dataset.cardId ?? null });
      };
      const { server } = renderWithApi(
        <Profiler id="cards" onRender={onCommit}>
          <CardsTab paperId={PAPER} />
        </Profiler>,
        (c: FakeCall): JsonReply | undefined => (c.method === 'GET' && c.url === cardUrl ? { status: 200, json: { cards: state.cards } } : undefined),
      );
      const sec = await waitFor(() => section('notation'));
      if (state.cards.length === 0) fireEvent.click(within(sec).getByTestId('pn-card-generate'));
      else {
        await waitFor(() => expect(within(sec).getAllByTestId('pn-card-item')).toHaveLength(11));
        fireEvent.click(within(sec).getByTestId('pn-card-regenerate'));
        fireEvent.click(within(sec).getByTestId('pn-card-regen-confirm'));
      }
      await waitFor(() => expect(server.streamCount()).toBe(1));
      await act(async () => server.push(ev.acceptedRun({ runId: 'run-n', task: 'notation_card', artifactId: 'card-new' }), ev.started('high')));
      await waitFor(() => expect(within(sec).getByTestId('pn-card-progress')).toBeTruthy());
      state.cards = [card('notation', { id: 'card-new', runId: 'run-n', createdAt: 20 })];
      try {
        env.IS_REACT_ACT_ENVIRONMENT = false;
        record = true;
        server.push(doneParsed());
        server.end();
        const until = Date.now() + 5000;
        while (!commits.some((c) => c.card === 'card-new') && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
        await new Promise((r) => setTimeout(r, 20));
      } finally {
        record = false;
        env.IS_REACT_ACT_ENVIRONMENT = actEnv;
      }
      const first = commits.findIndex((c) => c.card === 'card-new');
      expect(first).toBeGreaterThanOrEqual(0);
      expect(commits.slice(0, first).filter((c) => c.offered)).toEqual([]);
      expect(server.calls.filter((c) => c.method === 'POST' && c.url === `${cardUrl}/notation/generate`)).toHaveLength(1);
    });
  });

  it('the first load fails: the error line has "다시 시도", which loads the sections', async () => {
    const state = { cards: [card('notation')], failList: true };
    const api = cardsApi(state);
    renderWithApi(<CardsTab paperId={PAPER} />, api.handler);
    const err = await screen.findByTestId('pn-cards-load-error');
    expect(err.textContent).toContain('카드를 불러오지 못했습니다');
    expect(screen.queryAllByTestId('pn-card-section')).toHaveLength(0);
    state.failList = false;
    fireEvent.click(within(err).getByTestId('pn-load-retry'));
    await waitFor(() => expect(within(section('notation')).getAllByTestId('pn-card-item')).toHaveLength(11));
    expect(screen.queryByTestId('pn-cards-load-error')).toBeNull();
  });
});

function structureApi(state: { fail: boolean }) {
  const calls = { n: 0 };
  const handler = (c: FakeCall): JsonReply | undefined => {
    if (c.url === `/api/papers/${PAPER}/structure`) {
      calls.n++;
      return state.fail ? FAIL : { status: 200, json: structureFixture() };
    }
    return undefined;
  };
  return { handler, calls };
}

describe.each([
  { name: 'EquationsTab', ui: () => <EquationsTab paperId={PAPER} />, errId: 'pn-eq-load-error', firstText: '수식 색인을 불러오지 못했습니다', item: 'pn-eq-item' },
  { name: 'ReferencesTab', ui: () => <ReferencesTab paperId={PAPER} />, errId: 'pn-ref-load-error', firstText: '참고문헌을 불러오지 못했습니다', item: 'pn-ref-item' },
])('$name: a failed structure load (review D-I10-02)', ({ ui, errId, firstText, item }) => {
  it('first load fails → error + "다시 시도", which loads the list', async () => {
    const state = { fail: true };
    const api = structureApi(state);
    renderWithApi(ui(), api.handler);
    const err = await screen.findByTestId(errId);
    expect(err.textContent).toContain(firstText);
    state.fail = false;
    fireEvent.click(within(err).getByTestId('pn-load-retry'));
    await waitFor(() => expect(screen.getAllByTestId(item).length).toBeGreaterThan(0));
    expect(screen.queryByTestId(errId)).toBeNull();
    expect(api.calls.n).toBe(2);
  });

  it('a failed refetch keeps the list shown, with the error line and "다시 시도"', async () => {
    const state = { fail: false };
    const api = structureApi(state);
    const { qc } = renderWithApi(ui(), api.handler);
    const n = (await screen.findAllByTestId(item)).length;
    state.fail = true;
    await act(async () => qc.invalidateQueries({ queryKey: qk.structure(PAPER) }));
    await waitFor(() => expect(api.calls.n).toBe(2));
    await act(async () => {});
    expect(screen.queryAllByTestId(item)).toHaveLength(n);
    const err = await screen.findByTestId(errId);
    state.fail = false;
    fireEvent.click(within(err).getByTestId('pn-load-retry'));
    await waitFor(() => expect(screen.queryByTestId(errId)).toBeNull());
    expect(screen.getAllByTestId(item)).toHaveLength(n);
  });
});
