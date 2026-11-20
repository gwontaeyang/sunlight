// Highlights tab + side panel shell (tabs, hide/show, width, fixed notice). Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HighlightDto } from '@study-paper/shared/contracts/api';
import { HighlightsTab } from '../../src/panel/HighlightsTab';
import { GROUNDING_NOTICE, PANEL_DEFAULT_WIDTH, SidePanel } from '../../src/panel/SidePanel';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, anchorOf, renderWithApi, resetReader, threadsApi } from './panelHarness';

afterEach(cleanup);
beforeEach(() => {
  resetReader(true);
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

const hl = (id: string, color: number, page: number, exact: string, comment: string | null = null): HighlightDto => ({
  id,
  paperId: PAPER,
  kind: 'text',
  color,
  quote: { exact },
  position: null,
  page,
  rects: [{ page, x: 0.1, y: 0.2, w: 0.5, h: 0.02 }],
  sectionId: null,
  comment,
  imageFileId: null,
  createdAt: 1,
  updatedAt: 1,
});

function highlightsApi(list: HighlightDto[]) {
  return (c: { method: string; url: string; body: Record<string, unknown> | undefined }) => {
    if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/highlights`) return { status: 200, json: { highlights: list } };
    const m = /^\/api\/highlights\/([^/]+)$/.exec(c.url);
    if (m && c.method === 'PATCH') {
      const h = list.find((x) => x.id === m[1])!;
      h.comment = (c.body!.comment as string | null) ?? null;
      return { status: 200, json: h };
    }
    if (m && c.method === 'DELETE') {
      list.splice(
        list.findIndex((x) => x.id === m[1]),
        1,
      );
      return { status: 204 };
    }
    return undefined;
  };
}

describe('HighlightsTab', () => {
  it('lists highlights by page, filters by colour, edits a comment, deletes, and jumps', async () => {
    const list = [hl('h2', 2, 3, 'robust kernel'), hl('h1', 1, 1, 'We estimate the robot pose', '핵심 문장')];
    const jumpToAnchor = vi.fn();
    useReaderStore.setState({ jumpToAnchor });
    const { server } = renderWithApi(<HighlightsTab paperId={PAPER} />, highlightsApi(list));
    await waitFor(() => expect(screen.getAllByTestId('highlight-item')).toHaveLength(2));
    const items = screen.getAllByTestId('highlight-item');
    expect(items.map((i) => i.dataset.highlightId)).toEqual(['h1', 'h2']); // page order
    expect(within(items[0]!).getByTestId('highlight-comment').textContent).toBe('핵심 문장');

    fireEvent.click(screen.getByTestId('highlight-filter-2'));
    expect(screen.getAllByTestId('highlight-item').map((i) => i.dataset.highlightId)).toEqual(['h2']);
    fireEvent.click(screen.getByTestId('highlight-filter-all'));

    fireEvent.click(within(screen.getAllByTestId('highlight-item')[0]!).getByTestId('highlight-jump'));
    expect(jumpToAnchor).toHaveBeenCalledWith({ kind: 'text', quote: { exact: 'We estimate the robot pose' }, rects: list.find((h) => h.id === 'h1')!.rects });

    const second = screen.getAllByTestId('highlight-item')[1]!;
    fireEvent.click(within(second).getByTestId('highlight-comment-edit'));
    fireEvent.change(within(second).getByTestId('highlight-comment-input'), { target: { value: '나중에 다시 보기' } });
    await act(async () => fireEvent.click(within(second).getByTestId('highlight-comment-save')));
    await waitFor(() => expect(screen.getAllByTestId('highlight-comment').map((c) => c.textContent)).toContain('나중에 다시 보기'));
    expect(server.calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/highlights/h2', body: { comment: '나중에 다시 보기' } });

    fireEvent.click(within(screen.getAllByTestId('highlight-item')[0]!).getByTestId('pn-highlight-delete'));
    await act(async () => fireEvent.click(screen.getByTestId('highlight-delete-confirm')));
    await waitFor(() => expect(screen.getAllByTestId('highlight-item')).toHaveLength(1));
    expect(server.calls.some((c) => c.method === 'DELETE' && c.url === '/api/highlights/h1')).toBe(true);
  });

  it('shows the error when the list route fails', async () => {
    renderWithApi(<HighlightsTab paperId={PAPER} />, () => ({ status: 501, json: { error: { code: 'not_implemented', message: 'x' } } }));
    expect(await screen.findByText('하이라이트를 불러오지 못했습니다')).toBeTruthy();
  });
});

describe('SidePanel', () => {
  it('switches tabs, hides/shows, resizes by keyboard, and keeps the grounding notice', async () => {
    renderWithApi(<SidePanel paperId={PAPER} />, (c) => threadsApi({ threads: [], messages: {} })(c) ?? highlightsApi([])(c));
    const panel = screen.getByTestId('side-panel');
    expect(screen.getByTestId('grounding-notice').textContent).toBe(GROUNDING_NOTICE);
    expect(panel.style.width).toBe(`${PANEL_DEFAULT_WIDTH}px`);

    fireEvent.click(screen.getByTestId('panel-tab-highlights'));
    expect(screen.getByTestId('highlights-tab').parentElement!.className).not.toContain('hidden');
    expect(screen.getByTestId('ai-tab').parentElement!.className).toContain('hidden');

    fireEvent.keyDown(screen.getByTestId('panel-resize'), { key: 'ArrowLeft' });
    expect(panel.style.width).toBe(`${PANEL_DEFAULT_WIDTH + 24}px`);

    fireEvent.click(screen.getByTestId('panel-hide'));
    expect(panel.dataset.hidden).toBe('true');
    expect(screen.getByTestId('panel-show')).toBeTruthy();

    // A reader action brings the AI tab back into view.
    act(() => useReaderStore.getState().requestAction({ kind: 'explain', anchor: anchorOf('x'), text: 'x' }));
    await waitFor(() => expect(panel.dataset.hidden).toBe('false'));
    expect(screen.getByTestId('ai-tab').parentElement!.className).not.toContain('hidden');
    expect(panel.style.width).toBe(`${PANEL_DEFAULT_WIDTH + 24}px`);
    expect(screen.queryByText(/검증됨/)).toBeNull();
  });
});
