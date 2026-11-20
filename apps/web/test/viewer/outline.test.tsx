// Outline + reading progress (BRIEF_C C7): tree from parentId, current section (unanchored sections skipped), the
// 4-step state cycle with progress.put, the "이해 이상 n / 전체 m" count, disabled items without a PDF position, and
// the no-structure screen with the upgrade control. fetch is stubbed with contract-shaped responses.
import { QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { createAppQueryClient } from '../../src/api/queryClient';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListProgressResponse, PaperDetailDto, ProgressDto, PutProgressRequest, StructureResponse, type SectionDto } from '@study-paper/shared/contracts/api';
import { formatSseEvent } from '@study-paper/shared/contracts/sse';
import type { NormRect } from '@study-paper/shared/contracts/domain';
import { resetUpgrades } from '../../src/library/upgrade';
import { useReaderStore } from '../../src/state/readerStore';
import { NO_ANCHOR_TITLE, Outline, OUTLINE_COLLAPSED_KEY } from '../../src/viewer/Outline';
import { buildOutlineTree, currentSectionAt, nextReadingState, progressSummary } from '../../src/viewer/sections';

const PAPER = '00000000-0000-4000-8000-0000000000aa';
const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const rect = (page: number, y: number): NormRect => ({ page, x: 0.1, y, w: 0.3, h: 0.02 });
/** papers.get of PAPER (an M1 paper without structure), with `over` applied. */
const paperDetail = (over: Record<string, unknown>) =>
  PaperDetailDto.parse({
    ...{ id: PAPER, source: 'arxiv', arxivId: null, arxivVersion: null, title: 'P', authors: [], year: null, status: 'inbox', ingestStatus: 'done' },
    ...{ state: { readable: true, contextReady: true, structureReady: true }, ai: { available: true, reason: null }, pageCount: 2, collectionId: null, tags: [] },
    ...{ createdAt: 1, updatedAt: 1, lastOpenedAt: null, structureSource: 'none', supplementVersion: 1, structureUpgradeAvailable: false },
    ...{ abstract: null, doi: null, venue: null, primaryCategory: null, publishedAt: null, codeUrl: null, projectUrl: null, citationCount: null, contextMode: 'pdf' },
    ...{ ingestWarnings: [], readableAt: 1, contextReadyAt: 1, structureReadyAt: 1, lastPosition: null, lastJob: null },
    structureUpgrade: { available: false, reason: null, job: null },
    ...over,
  });
const sec = (n: number, o: Partial<SectionDto>): SectionDto => ({ id: id(n), parentId: null, htmlId: null, number: null, title: `S${n}`, level: 1, ordinal: n, pdfPage: null, pdfOffset: null, pdfRect: null, ...o });

// I (p1), II (p2 y .1), II-A (p2 y .5, child of II), II-B (no anchor, child of II), III (p3, no rect)
const SECTIONS: SectionDto[] = [
  sec(1, { number: 'I', title: 'Introduction', pdfPage: 1, pdfRect: rect(1, 0.12) }),
  sec(2, { number: 'II', title: 'Method', pdfPage: 2, pdfRect: rect(2, 0.1) }),
  sec(3, { number: 'II-A', title: 'Robust Kernel', level: 2, parentId: id(2), pdfPage: 2, pdfRect: rect(2, 0.5) }),
  sec(4, { number: 'II-B', title: 'Implementation Details', level: 2, parentId: id(2) }),
  sec(5, { number: 'III', title: 'Experiments', pdfPage: 3 }),
];

describe('sections model', () => {
  it('builds the tree from parentId in ordinal order; a missing or cyclic parent becomes a root', () => {
    const tree = buildOutlineTree([...SECTIONS].reverse());
    expect(tree.map((n) => n.section.number)).toEqual(['I', 'II', 'III']);
    expect(tree[1]!.children.map((n) => n.section.number)).toEqual(['II-A', 'II-B']);
    const odd = buildOutlineTree([sec(1, { parentId: id(9) }), sec(2, { parentId: id(3) }), sec(3, { parentId: id(2) }), sec(4, { parentId: id(4) })]);
    expect(odd.map((n) => n.section.id).sort()).toEqual([id(1), id(2), id(3), id(4)].sort());
  });

  it('current section = the last anchored heading at or before the viewport top (unanchored skipped)', () => {
    expect(currentSectionAt(SECTIONS, { page: 1, top: 0 })).toBeNull();
    expect(currentSectionAt(SECTIONS, { page: 1, top: 0.12 })).toBe(id(1));
    expect(currentSectionAt(SECTIONS, { page: 2, top: 0.05 })).toBe(id(1));
    expect(currentSectionAt(SECTIONS, { page: 2, top: 0.3 })).toBe(id(2));
    expect(currentSectionAt(SECTIONS, { page: 2, top: 0.9 })).toBe(id(3)); // II-B (no anchor) never becomes current
    expect(currentSectionAt(SECTIONS, { page: 3, top: 0 })).toBe(id(5)); // page without rect = top of the page
    expect(currentSectionAt(SECTIONS, null)).toBeNull();
    expect(currentSectionAt([], { page: 9, top: 1 })).toBeNull();
  });

  it('state cycle and summary', () => {
    expect(['unread', 'skimmed', 'understood', 'reimplementable'].map((s) => nextReadingState(s as never))).toEqual(['skimmed', 'understood', 'reimplementable', 'unread']);
    expect(progressSummary(SECTIONS, new Map([[id(1), 'understood'], [id(2), 'reimplementable'], [id(3), 'skimmed']] as const))).toEqual({ understood: 2, total: 5 });
  });
});

// ---------------------------------------------------------------------------------------------
// Component

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let routes: Record<string, (init: RequestInit) => Response>;
const calls: { method: string; url: string; body?: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  routes = {};
  window.localStorage.removeItem(OUTLINE_COLLAPSED_KEY);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const h = routes[`${method} ${url}`];
      return h ? h(init) : json({ error: { code: 'not_found', message: `no mock for ${method} ${url}` } }, 404);
    }),
  );
  useReaderStore.getState().registerNavigator(null);
  useReaderStore.getState().openPaper(PAPER, { readable: true, contextReady: true, structureReady: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetUpgrades();
});

function serve(sections: SectionDto[], progress: ProgressDto[] = []) {
  const structure = StructureResponse.parse({ structureSource: sections.length ? 'latexml' : 'none', sections, equations: [], figures: [], references: [] });
  routes[`GET /api/papers/${PAPER}/structure`] = () => json(structure);
  const store = new Map(progress.map((p) => [p.sectionId, p]));
  routes[`GET /api/papers/${PAPER}/progress`] = () => json(ListProgressResponse.parse({ progress: [...store.values()] }));
  for (const s of sections) {
    routes[`PUT /api/papers/${PAPER}/progress/${s.id}`] = (init) => {
      const body = PutProgressRequest.parse(JSON.parse(String(init.body)));
      const dto = ProgressDto.parse({ sectionId: s.id, state: body.state, updatedAt: 1 });
      store.set(s.id, dto);
      return json(dto);
    };
  }
}
function renderOutline(props: { upgradeAvailable?: boolean } = {}) {
  const qc = createAppQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Outline paperId={PAPER} upgradeAvailable={props.upgradeAvailable ?? false} upgradeJob={null} />
    </QueryClientProvider>,
  );
}
const item = (number: string) => screen.getAllByTestId('rd-outline-item').find((e) => e.getAttribute('data-section-number') === number)!;
const link = (number: string) => within(item(number)).getAllByTestId('rd-outline-link')[0]!;
const toggle = (number: string) => within(item(number)).getAllByTestId('rd-progress-toggle')[0]!;

describe('<Outline>', () => {
  it('renders the tree; a click jumps through the store; an unanchored section is disabled with the reason and never jumps', async () => {
    serve(SECTIONS);
    const jumps: string[] = [];
    useReaderStore.getState().registerNavigator({
      jumpToCitation: async () => 'page_only',
      jumpToAnchor: () => {},
      jumpToEquation: async () => 'no_anchor',
      jumpToSection: async (sid) => (jumps.push(sid), 'located'),
      jumpToPage: () => {},
      back: () => false,
    });
    renderOutline();
    await screen.findByTestId('rd-outline-tree');
    expect(screen.getAllByTestId('rd-outline-item').map((e) => e.getAttribute('data-section-number'))).toEqual(['I', 'II', 'II-A', 'II-B', 'III']);
    expect(item('II').contains(item('II-A'))).toBe(true);
    fireEvent.click(link('II-A'));
    expect(jumps).toEqual([id(3)]);
    const none = link('II-B');
    expect(none.getAttribute('aria-disabled')).toBe('true');
    expect(none.getAttribute('title')).toBe(NO_ANCHOR_TITLE);
    fireEvent.click(none);
    expect(jumps).toEqual([id(3)]);
  });

  it('highlights readerStore.currentSectionId', async () => {
    serve(SECTIONS);
    renderOutline();
    await screen.findByTestId('rd-outline-tree');
    act(() => useReaderStore.getState().setCurrentSectionId(id(3)));
    expect(item('II-A').getAttribute('data-current')).toBe('true');
    expect(item('I').getAttribute('data-current')).toBe('false');
    expect(link('II-A').getAttribute('aria-current')).toBe('location');
  });

  it('the state toggle cycles 안 읽음 → 훑음 → 이해 with progress.put each time; the count follows', async () => {
    serve(SECTIONS, [{ sectionId: id(1), state: 'understood', updatedAt: 1 }]);
    renderOutline();
    await waitFor(() => expect(screen.getByTestId('rd-progress-summary').textContent).toBe('이해 이상 1 / 전체 5'));
    expect(toggle('II-A').textContent).toBe('안 읽음');
    fireEvent.click(toggle('II-A'));
    expect(toggle('II-A').textContent).toBe('훑음');
    fireEvent.click(toggle('II-A'));
    expect(toggle('II-A').textContent).toBe('이해');
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => [c.url, c.body])).toEqual([
      [`/api/papers/${PAPER}/progress/${id(3)}`, { state: 'skimmed' }],
      [`/api/papers/${PAPER}/progress/${id(3)}`, { state: 'understood' }],
    ]);
    expect(screen.getByTestId('rd-progress-summary').textContent).toBe('이해 이상 2 / 전체 5');
    fireEvent.click(toggle('II-A'));
    fireEvent.click(toggle('II-A'));
    expect(toggle('II-A').getAttribute('data-state')).toBe('unread'); // 재구현 가능 → 안 읽음
  });

  it('a failed progress.put shows the error and reloads the stored states', async () => {
    serve(SECTIONS);
    routes[`PUT /api/papers/${PAPER}/progress/${id(1)}`] = () => json({ error: { code: 'not_implemented', message: 'M2' } }, 501);
    renderOutline();
    await screen.findByTestId('rd-outline-tree');
    // the buttons work once progress.list has answered (C-I10-03)
    await waitFor(() => expect((toggle('I') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle('I'));
    expect(await screen.findByTestId('rd-progress-error')).toBeTruthy();
    await waitFor(() => expect(toggle('I').textContent).toBe('안 읽음'));
  });

  it('progress.list failed: state buttons disabled, "읽기 상태를 불러오지 못했습니다" + 다시 시도, a click sends no PUT; retry shows the stored states (C-I10-03)', async () => {
    serve(SECTIONS, [{ sectionId: id(2), state: 'understood', updatedAt: 1 }]);
    const ok = routes[`GET /api/papers/${PAPER}/progress`]!;
    routes[`GET /api/papers/${PAPER}/progress`] = () => json({ error: { code: 'internal', message: 'boom' } }, 500);
    renderOutline();
    const err = await screen.findByTestId('rd-progress-load-error');
    expect(err.textContent).toContain('읽기 상태를 불러오지 못했습니다');
    for (const n of ['I', 'II', 'II-A', 'II-B', 'III']) expect((toggle(n) as HTMLButtonElement).disabled, n).toBe(true);
    fireEvent.click(toggle('II'));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    // the server's 이해 was never overwritten; 다시 시도 reads it
    routes[`GET /api/papers/${PAPER}/progress`] = ok;
    fireEvent.click(within(err).getByTestId('rd-progress-retry'));
    await waitFor(() => expect(toggle('II').textContent).toBe('이해'));
    expect(screen.queryByTestId('rd-progress-load-error')).toBeNull();
    expect((toggle('II') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(toggle('II'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ state: 'reimplementable' }]));
  });

  it('recovers reading states and saves the next change while the browser stays offline', async () => {
    serve(SECTIONS, [{ sectionId: id(2), state: 'understood', updatedAt: 1 }]);
    const path = `GET /api/papers/${PAPER}/progress`;
    const stored = routes[path]!;
    routes[path] = () => json({ error: { code: 'internal', message: 'fixture' } }, 500);
    renderOutline();
    const error = await screen.findByTestId('rd-progress-load-error');
    try {
      act(() => void window.dispatchEvent(new Event('offline')));
      expect(onlineManager.isOnline()).toBe(false);
      routes[path] = stored;
      fireEvent.click(within(error).getByTestId('rd-progress-retry'));
      await waitFor(() => expect(toggle('II').textContent).toBe('이해'));
      fireEvent.click(toggle('II'));
      await waitFor(() => expect(calls.filter((r) => r.method === 'PUT').map((r) => r.body)).toEqual([{ state: 'reimplementable' }]));
    } finally { onlineManager.setOnline(true); }
  });

  it('a failed progress.put followed by a failed reload: the optimistic state is not trusted — buttons disabled, no PUT; retry shows the stored state (C3-R1-02)', async () => {
    serve(SECTIONS, [{ sectionId: id(1), state: 'understood', updatedAt: 1 }]);
    const ok = routes[`GET /api/papers/${PAPER}/progress`]!;
    const okPut = routes[`PUT /api/papers/${PAPER}/progress/${id(1)}`]!;
    // the PUT fails, and from then on progress.list fails too (the reload after the failed PUT)
    routes[`PUT /api/papers/${PAPER}/progress/${id(1)}`] = () => {
      routes[`GET /api/papers/${PAPER}/progress`] = () => json({ error: { code: 'internal', message: 'boom' } }, 500);
      return json({ error: { code: 'not_implemented', message: 'M2' } }, 501);
    };
    renderOutline();
    await screen.findByTestId('rd-outline-tree');
    await waitFor(() => expect(toggle('I').textContent).toBe('이해'));
    expect((toggle('I') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(toggle('I'));
    expect(await screen.findByTestId('rd-progress-error')).toBeTruthy();
    const err = await screen.findByTestId('rd-progress-load-error');
    expect(err.textContent).toContain('읽기 상태를 불러오지 못했습니다');
    // the cache still holds the optimistic 재구현 가능 the server never stored: every button stays inert on it
    for (const n of ['I', 'II', 'II-A', 'II-B', 'III']) expect((toggle(n) as HTMLButtonElement).disabled, n).toBe(true);
    const puts = () => calls.filter((c) => c.method === 'PUT');
    expect(puts()).toHaveLength(1);
    fireEvent.click(toggle('I'));
    fireEvent.click(toggle('II'));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(puts()).toHaveLength(1);
    // 다시 시도 reads the server's 이해 back and enables the buttons; the next click cycles from it
    routes[`GET /api/papers/${PAPER}/progress`] = ok;
    routes[`PUT /api/papers/${PAPER}/progress/${id(1)}`] = okPut;
    fireEvent.click(within(err).getByTestId('rd-progress-retry'));
    await waitFor(() => expect(toggle('I').textContent).toBe('이해'));
    expect(screen.queryByTestId('rd-progress-load-error')).toBeNull();
    for (const n of ['I', 'II', 'II-A']) expect((toggle(n) as HTMLButtonElement).disabled, n).toBe(false);
    fireEvent.click(toggle('I'));
    await waitFor(() => expect(puts().map((c) => c.body)).toEqual([{ state: 'reimplementable' }, { state: 'reimplementable' }]));
  });

  it('progress.list still loading: state buttons disabled, no PUT (C-I10-03)', async () => {
    serve(SECTIONS, [{ sectionId: id(1), state: 'understood', updatedAt: 1 }]);
    const ok = routes[`GET /api/papers/${PAPER}/progress`]!;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    routes[`GET /api/papers/${PAPER}/progress`] = (init) => gate.then(() => ok(init)) as unknown as Response;
    renderOutline();
    await screen.findByTestId('rd-outline-tree');
    expect((toggle('I') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle('I'));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    release();
    await waitFor(() => expect(toggle('I').textContent).toBe('이해'));
    expect((toggle('I') as HTMLButtonElement).disabled).toBe(false);
  });

  /** The notice sits above the outline list and outside its scroll box (seen without scrolling a long outline). */
  const expectAboveTheList = (notice: HTMLElement) => {
    const tree = screen.getByTestId('rd-outline-tree');
    expect(notice.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING, 'the list comes after the notice').toBeTruthy();
    expect(tree.parentElement!.contains(notice), 'not inside the outline scroll box').toBe(false);
  };

  it('progress.list failed: the notice and 다시 시도 are above the outline list, and the count shows no value (C-FX-03)', async () => {
    serve(SECTIONS, [{ sectionId: id(2), state: 'understood', updatedAt: 1 }]);
    const ok = routes[`GET /api/papers/${PAPER}/progress`]!;
    routes[`GET /api/papers/${PAPER}/progress`] = () => json({ error: { code: 'internal', message: 'boom' } }, 500);
    renderOutline();
    const err = await screen.findByTestId('rd-progress-load-error');
    expectAboveTheList(err);
    expect(screen.getByTestId('rd-progress-summary').textContent).toBe('이해 이상 – / 전체 5'); // not "0 / 5": nothing was read
    routes[`GET /api/papers/${PAPER}/progress`] = ok;
    fireEvent.click(within(err).getByTestId('rd-progress-retry'));
    await waitFor(() => expect(screen.getByTestId('rd-progress-summary').textContent).toBe('이해 이상 1 / 전체 5'));
  });

  it('progress.list still loading: the count shows no value until the states arrive (C-FX-03)', async () => {
    serve(SECTIONS, [{ sectionId: id(1), state: 'understood', updatedAt: 1 }]);
    const ok = routes[`GET /api/papers/${PAPER}/progress`]!;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    routes[`GET /api/papers/${PAPER}/progress`] = (init) => gate.then(() => ok(init)) as unknown as Response;
    renderOutline();
    await screen.findByTestId('rd-outline-tree');
    expect(screen.getByTestId('rd-progress-summary').textContent).toBe('이해 이상 – / 전체 5');
    release();
    await waitFor(() => expect(screen.getByTestId('rd-progress-summary').textContent).toBe('이해 이상 1 / 전체 5'));
  });

  it('a failed progress.put: its notice is above the outline list too (C-FX-03)', async () => {
    serve(SECTIONS);
    routes[`PUT /api/papers/${PAPER}/progress/${id(1)}`] = () => json({ error: { code: 'not_implemented', message: 'M2' } }, 501);
    renderOutline();
    await screen.findByTestId('rd-outline-tree');
    await waitFor(() => expect((toggle('I') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle('I'));
    expectAboveTheList(await screen.findByTestId('rd-progress-error'));
  });

  it('a failed progress.put: the notice is drawn over the list, not in its flow; 닫기 and the next click clear it (C-FX4-R1-01)', async () => {
    serve(SECTIONS);
    const okPut = routes[`PUT /api/papers/${PAPER}/progress/${id(1)}`]!;
    routes[`PUT /api/papers/${PAPER}/progress/${id(1)}`] = () => json({ error: { code: 'internal', message: 'boom' } }, 500);
    renderOutline();
    await screen.findByTestId('rd-outline-tree');
    await waitFor(() => expect((toggle('I') as HTMLButtonElement).disabled).toBe(false));
    const scrollBox = screen.getByTestId('rd-outline-tree').parentElement!;
    // the in-flow elements of the outline outside the list's scroll box (happy-dom has no layout: this is the structure
    // the list's place depends on; the e2e measures the place itself)
    const flow = () =>
      Array.from(screen.getByTestId('rd-outline').querySelectorAll('*'))
        .filter((e) => !e.closest('[data-testid="rd-progress-error-overlay"]') && !scrollBox.contains(e) && e !== scrollBox)
        .map((e) => e.tagName + (e.getAttribute('data-testid') ?? '') + e.className);
    const before = flow();
    fireEvent.click(toggle('I'));
    const err = await screen.findByTestId('rd-progress-error');
    // drawn over the top of the list's box: absolute, in a relative wrapper that also holds the scroll box
    const overlay = screen.getByTestId('rd-progress-error-overlay');
    expect(overlay.contains(err)).toBe(true);
    expect(overlay.className.split(/\s+/)).toEqual(expect.arrayContaining(['absolute', 'inset-x-0', 'top-0']));
    expect(overlay.parentElement!.className.split(/\s+/)).toContain('relative');
    expect(overlay.parentElement).toBe(scrollBox.parentElement);
    expect(overlay.contains(scrollBox)).toBe(false);
    // nothing was added to the flow above or around the list
    await waitFor(() => expect(toggle('I').textContent).toBe('안 읽음'));
    expect(flow()).toEqual(before);
    // 닫기 removes it, without a PUT
    fireEvent.click(within(err).getByTestId('rd-progress-error-close'));
    expect(screen.queryByTestId('rd-progress-error')).toBeNull();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    // a new failure shows it again; the next click that reaches a button clears it (and saves)
    fireEvent.click(toggle('I'));
    expect(await screen.findByTestId('rd-progress-error')).toBeTruthy();
    await waitFor(() => expect((toggle('I') as HTMLButtonElement).disabled).toBe(false));
    routes[`PUT /api/papers/${PAPER}/progress/${id(1)}`] = okPut;
    fireEvent.click(toggle('I'));
    expect(screen.queryByTestId('rd-progress-error')).toBeNull();
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ state: 'skimmed' }, { state: 'skimmed' }, { state: 'skimmed' }]));
  });

  it('a failed progress.put: 닫기 is at the notice\'s left end, away from the state buttons at the right end of each row (C-FX4-R2-01)', async () => {
    serve(SECTIONS);
    routes[`PUT /api/papers/${PAPER}/progress/${id(1)}`] = () => json({ error: { code: 'internal', message: 'boom' } }, 500);
    renderOutline();
    await screen.findByTestId('rd-outline-tree');
    await waitFor(() => expect((toggle('I') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle('I'));
    const err = await screen.findByTestId('rd-progress-error');
    // happy-dom has no layout: the order in the flex row is what puts 닫기 on the left (the e2e clicks the spot itself)
    const close = within(err).getByTestId('rd-progress-error-close');
    const kids = Array.from(err.children);
    expect(kids[0]).toBe(close);
    expect(kids.slice(1).some((k) => k.textContent?.includes('읽기 상태를 저장하지 못했습니다'))).toBe(true);
    expect(close.className.split(/\s+/)).not.toContain('ml-auto');
  });

  it('collapse is remembered per browser', async () => {
    serve(SECTIONS);
    const { unmount } = renderOutline();
    await screen.findByTestId('rd-outline-tree');
    fireEvent.click(screen.getByTestId('rd-outline-collapse'));
    expect(screen.queryByTestId('rd-outline-tree')).toBeNull();
    unmount();
    renderOutline();
    expect(screen.getByTestId('rd-outline').getAttribute('data-collapsed')).toBe('true');
  });

  it('no structure: "목차 없음"; with an upgrade available, the upgrade button; never a progress request', async () => {
    serve([]);
    const first = renderOutline();
    expect((await screen.findByTestId('rd-outline-empty')).textContent).toContain('목차 없음');
    expect(screen.queryByTestId('rd-upgrade-button')).toBeNull();
    first.unmount();
    renderOutline({ upgradeAvailable: true });
    await screen.findByTestId('rd-outline-empty');
    expect(screen.getByTestId('rd-upgrade-button').textContent).toBe('구조 색인 만들기');
    expect(screen.queryByTestId('rd-progress-summary')).toBeNull();
    expect(calls.some((c) => c.url.includes('/progress'))).toBe(false);
  });

  it('a final upgrade failure keeps its reason after papers.get turns structureUpgrade.available off (no button)', async () => {
    serve([]);
    const JOB = '00000000-0000-4000-8000-0000000000c9';
    routes[`POST /api/papers/${PAPER}/upgrade-structure`] = () => json({ jobId: JOB });
    routes[`GET /api/jobs/${JOB}/events`] = () =>
      new Response([formatSseEvent({ event: 'job.step', data: { step: 'html', status: 'error' } }), formatSseEvent({ event: 'job.error', data: { code: 'not_found', message: 'HTTP 404' } })].join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    routes[`GET /api/papers/${PAPER}`] = () => json(paperDetail({ ingestWarnings: ['html_not_found: HTTP 404'] }));
    const qc = createAppQueryClient();
    const view = (available: boolean) => (
      <QueryClientProvider client={qc}>
        <Outline paperId={PAPER} upgradeAvailable={available} upgradeJob={null} />
      </QueryClientProvider>
    );
    const r = render(view(true));
    fireEvent.click(await screen.findByTestId('rd-upgrade-button'));
    fireEvent.click(screen.getByTestId('rd-upgrade-confirm-yes'));
    const err = await screen.findByTestId('rd-upgrade-error');
    r.rerender(view(false)); // the reader's papers.get now says available:false (BRIEF_A A6)
    expect(screen.getByTestId('rd-upgrade-error')).toBe(err);
    expect(err.getAttribute('data-kind')).toBe('final');
    expect(err.textContent).toContain('arXiv에 이 논문의 HTML 버전이 없습니다');
    expect(screen.queryByTestId('rd-upgrade-button')).toBeNull();
  });
});
