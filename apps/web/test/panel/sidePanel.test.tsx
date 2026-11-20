// Side panel M2 (BRIEF_D D1): six tabs, actions open their tab, panelFocus opens a tab and highlights its target
// (consumed once), inactive tabs stay mounted (a stream keeps running), "구조 색인 없음", grounding notice on every tab.
// Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteDto } from '@study-paper/shared/contracts/api';
import { GROUNDING_NOTICE, PANEL_TABS, SidePanel } from '../../src/panel/SidePanel';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, anchorOf, renderWithApi, resetReader, threadsApi } from './panelHarness';
import type { FakeCall } from './sseFake';
import { ev } from './sseFake';
import { structureFixture } from './structureFixture';

afterEach(cleanup);
beforeEach(() => {
  resetReader(true);
  useReaderStore.setState({ paperState: { readable: true, contextReady: true, structureReady: true }, panelFocus: null });
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

const threads = threadsApi({ threads: [], messages: {} });
const api = (c: FakeCall) => (c.url === `/api/papers/${PAPER}/structure` ? { status: 200, json: structureFixture() } : threads(c));
const selected = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!.textContent;

describe('SidePanel tabs', () => {
  it('shows the six tabs; the grounding notice stays visible on every tab', () => {
    renderWithApi(<SidePanel paperId={PAPER} />, api);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['AI', '하이라이트·노트', '카드', '수식', '참고문헌', '용어집']);
    for (const t of PANEL_TABS) {
      fireEvent.click(screen.getByTestId(t.testId));
      expect(selected()).toBe(t.label);
      expect(screen.getByTestId('grounding-notice').textContent).toBe(GROUNDING_NOTICE);
    }
  });

  it('a reader action opens its tab: glossary → 용어집, note → 하이라이트·노트, translate → AI', async () => {
    renderWithApi(<SidePanel paperId={PAPER} />, api);
    fireEvent.click(screen.getByTestId('pn-tab-cards'));
    act(() => useReaderStore.getState().requestAction({ kind: 'glossary', anchor: anchorOf('robust kernel'), text: 'robust kernel' }));
    await waitFor(() => expect(selected()).toBe('용어집'));
    act(() => useReaderStore.getState().requestAction({ kind: 'note', highlightId: 'h1' }));
    await waitFor(() => expect(selected()).toBe('하이라이트·노트'));
    act(() => useReaderStore.getState().requestAction({ kind: 'translate', text: 'x' }));
    await waitFor(() => expect(selected()).toBe('AI'));
  });

  it('panelFocus → the references tab with the item highlighted; the focus is consumed', async () => {
    renderWithApi(<SidePanel paperId={PAPER} />, api);
    act(() => useReaderStore.getState().focusPanel({ tab: 'references', referenceOrdinal: 2 }));
    await waitFor(() => expect(selected()).toBe('참고문헌'));
    expect(useReaderStore.getState().panelFocus).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('pn-ref-item').find((i) => i.dataset.ordinal === '2')!.dataset.focused).toBe('1'));
  });

  it('panelFocus → the equations tab with the equation highlighted; the hidden panel opens', async () => {
    localStorage.setItem('sp.sidePanel', JSON.stringify({ width: 400, hidden: true }));
    renderWithApi(<SidePanel paperId={PAPER} />, api);
    expect(screen.getByTestId('panel-show')).toBeTruthy();
    act(() => useReaderStore.getState().focusPanel({ tab: 'equations', equationId: 'E2' }));
    await waitFor(() => expect(selected()).toBe('수식'));
    expect(screen.queryByTestId('panel-show')).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('pn-eq-item').find((i) => i.dataset.equationId === 'E2')!.dataset.focused).toBe('1'));
  });

  it('inactive tabs stay mounted: an answer keeps streaming while another tab is open', async () => {
    const { server } = renderWithApi(<SidePanel paperId={PAPER} />, api);
    await screen.findByText('아직 대화가 없습니다');
    fireEvent.change(screen.getByTestId('followup-input'), { target: { value: '질문' } });
    fireEvent.click(screen.getByTestId('followup-send'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    fireEvent.click(screen.getByTestId('pn-tab-cards'));
    await act(async () => {
      server.push(ev.accepted({ task: 'chat', threadId: 't9', messageId: 'm9' }), ev.started(), ev.delta('탭 밖에서 받은 답'), ev.done('탭 밖에서 받은 답'));
      server.end();
    });
    fireEvent.click(screen.getByTestId('panel-tab-ai'));
    await waitFor(() => expect(within(screen.getByTestId('live-message')).getByTestId('run-text').textContent).toContain('탭 밖에서 받은 답'));
  });

  it('a paper without structure: the equations and references tabs say "구조 색인 없음"', () => {
    useReaderStore.setState({ paperState: { readable: true, contextReady: true, structureReady: false } });
    renderWithApi(<SidePanel paperId={PAPER} />, api);
    fireEvent.click(screen.getByTestId('pn-tab-equations'));
    expect(screen.getAllByTestId('pn-no-structure')).toHaveLength(2);
  });
});

describe('SidePanel focus requests scroll every time (review D-R1-05)', () => {
  const scrolled = () => {
    const calls: Element[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      calls.push(this);
    });
    return { calls, restore: () => spy.mockRestore() };
  };
  const focus = (f: Parameters<ReturnType<typeof useReaderStore.getState>['focusPanel']>[0]) => act(() => useReaderStore.getState().focusPanel(f));

  it('the same reference asked for twice (another tab in between) scrolls twice', async () => {
    if (typeof HTMLElement.prototype.scrollIntoView !== 'function') HTMLElement.prototype.scrollIntoView = () => {};
    const sc = scrolled();
    renderWithApi(<SidePanel paperId={PAPER} />, api);
    focus({ tab: 'references', referenceOrdinal: 2 });
    await waitFor(() => expect(sc.calls.filter((e) => (e as HTMLElement).dataset.ordinal === '2')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('pn-tab-cards'));
    focus({ tab: 'references', referenceOrdinal: 2 });
    await waitFor(() => expect(selected()).toBe('참고문헌'));
    await waitFor(() => expect(sc.calls.filter((e) => (e as HTMLElement).dataset.ordinal === '2')).toHaveLength(2));
    focus({ tab: 'equations', equationId: 'E2' });
    focus({ tab: 'equations', equationId: 'E2' });
    await waitFor(() => expect(sc.calls.filter((e) => (e as HTMLElement).dataset.equationId === 'E2')).toHaveLength(2));
    sc.restore();
  });

  it('a note focus scrolls to the note (and again on the next request)', async () => {
    if (typeof HTMLElement.prototype.scrollIntoView !== 'function') HTMLElement.prototype.scrollIntoView = () => {};
    const sc = scrolled();
    const n: NoteDto = { id: 'n7', paperId: PAPER, highlightId: null, sectionId: null, bodyMd: '노트 본문', createdAt: 1, updatedAt: 1 };
    renderWithApi(<SidePanel paperId={PAPER} />, (c) =>
      c.method === 'GET' && c.url === `/api/papers/${PAPER}/notes` ? { status: 200, json: { notes: [n] } } : c.method === 'GET' && c.url === `/api/papers/${PAPER}/highlights` ? { status: 200, json: { highlights: [] } } : api(c),
    );
    await screen.findByTestId('pn-note-item');
    focus({ tab: 'highlights', noteId: 'n7' });
    await waitFor(() => expect(selected()).toBe('하이라이트·노트'));
    await waitFor(() => expect(sc.calls.filter((e) => (e as HTMLElement).dataset.noteId === 'n7')).toHaveLength(1));
    expect(screen.getByTestId('pn-note-item').dataset.focused).toBe('1');
    focus({ tab: 'highlights', noteId: 'n7' });
    await waitFor(() => expect(sc.calls.filter((e) => (e as HTMLElement).dataset.noteId === 'n7')).toHaveLength(2));
    sc.restore();
  });
});
