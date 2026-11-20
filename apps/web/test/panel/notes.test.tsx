// Notes in the highlights·notes tab (BRIEF_D D8): plain preview (no chips/badges, LaTeX drawn), create / edit /
// delete, links to a highlight and a section, grouping by section (page without one), the reader "note" action, and
// the area highlight thumbnail (papers.capture). Owner D.
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../../src/api/queryClient';
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HighlightDto, NoteDto } from '@study-paper/shared/contracts/api';
import { HighlightsTab } from '../../src/panel/HighlightsTab';
import { NOTE_MORE_CHARS, NOTE_PREVIEW_CHARS, useNoteDraft } from '../../src/panel/NotesSection';
import { PanelApiContext } from '../../src/panel/panelApi';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, renderWithApi, resetReader } from './panelHarness';
import { createFakeServer, type FakeCall, type JsonReply } from './sseFake';
import { structureFixture } from './structureFixture';
import { testPngBytes } from './testPng';

/** IntersectionObserver stand-in: `visible` decides whether observed rows are reported in view (notes render in view only). */
let visible = true;
/** Observers that are still watching (a row that has not been reported in view yet); revealAll() brings them into view. */
const watching = new Set<FakeIO>();
class FakeIO {
  constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
  observe() {
    if (visible) queueMicrotask(() => this.cb([{ isIntersecting: true }]));
    else watching.add(this);
  }
  disconnect() {
    watching.delete(this);
  }
  reveal() {
    this.cb([{ isIntersecting: true }]);
  }
}
vi.stubGlobal('IntersectionObserver', FakeIO);
function revealAll() {
  for (const o of [...watching]) o.reveal();
}

afterEach(() => {
  cleanup();
  visible = true;
  watching.clear();
});
beforeEach(() => {
  resetReader(true);
  useReaderStore.setState({ paperState: { readable: true, contextReady: true, structureReady: true }, currentSectionId: 'S2' });
});

const NOW = 1_700_000_000_000;
const hl = (id: string, o: Partial<HighlightDto> = {}): HighlightDto => ({ id, paperId: PAPER, kind: 'text', color: 1, quote: { exact: 'We estimate\nthe robot pose' }, position: null, page: 1, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }], sectionId: null, comment: null, imageFileId: null, createdAt: NOW, updatedAt: NOW, ...o });
const note = (id: string, bodyMd: string, o: Partial<NoteDto> = {}): NoteDto => ({ id, paperId: PAPER, highlightId: null, sectionId: null, bodyMd, createdAt: NOW, updatedAt: NOW, ...o });

function api(highlights: HighlightDto[], notes: NoteDto[]) {
  return (c: FakeCall): JsonReply | undefined => {
    if (c.url === `/api/papers/${PAPER}/structure`) return { status: 200, json: structureFixture() };
    if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/highlights`) return { status: 200, json: { highlights } };
    if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/notes`) return { status: 200, json: { notes } };
    if (c.method === 'GET' && /^\/api\/papers\/[^/]+\/captures\/cap-\d+$/.test(c.url)) return { status: 200, png: testPngBytes() };
    if (c.method === 'POST' && c.url === `/api/papers/${PAPER}/notes`) {
      const n = note(`n${notes.length + 1}`, String(c.body!.bodyMd), { highlightId: (c.body!.highlightId as string | undefined) ?? null, sectionId: (c.body!.sectionId as string | undefined) ?? null });
      notes.push(n);
      return { status: 200, json: n };
    }
    const m = /^\/api\/notes\/([^/]+)$/.exec(c.url);
    if (m && c.method === 'PATCH') {
      const n = notes.find((x) => x.id === m[1])!;
      n.bodyMd = String(c.body!.bodyMd);
      return { status: 200, json: n };
    }
    if (m && c.method === 'DELETE') {
      notes.splice(notes.findIndex((x) => x.id === m[1]), 1);
      return { status: 204 };
    }
    return undefined;
  };
}

describe('notes', () => {
  it('grouped by section (outline order), then by page; plain preview: no chip / badge, LaTeX drawn', async () => {
    const notes = [note('n1', '방법 노트 <q>We estimate</q> [[P]] $x^2$', { sectionId: 'S2' }), note('n2', '서론 노트', { sectionId: 'S1' }), note('n3', '쪽 노트', { highlightId: 'h1' })];
    const { container } = renderWithApi(<HighlightsTab paperId={PAPER} />, api([hl('h1', { page: 3 })], notes));
    await waitFor(() => expect(screen.getAllByTestId('pn-note-group').map((g) => g.dataset.group)).toEqual(['s:S1', 's:S2', 'p:3']));
    const groups = screen.getAllByTestId('pn-note-group');
    expect(groups[0]!.textContent).toContain('I. Introduction');
    expect(groups[2]!.textContent).toContain('p. 3');
    const n1 = screen.getAllByTestId('pn-note-item').find((i) => i.dataset.noteId === 'n1')!;
    expect(within(n1).queryAllByTestId('sp-chip')).toHaveLength(0);
    expect(within(n1).queryAllByTestId('sp-badge')).toHaveLength(0);
    expect(n1.textContent).toContain('<q>We estimate</q>');
    expect(n1.querySelector('.katex')).not.toBeNull();
    // the linked highlight's quote is shown collapsed
    const n3 = screen.getAllByTestId('pn-note-item').find((i) => i.dataset.noteId === 'n3')!;
    expect(within(n3).getByTestId('pn-note-highlight').textContent).toContain('We estimate the robot pose');
    expect(container.querySelector('a[href]')).toBeNull();
  });

  it('new note (linked to the current section), edit, delete', async () => {
    const notes: NoteDto[] = [];
    const { server } = renderWithApi(<HighlightsTab paperId={PAPER} />, api([], notes));
    fireEvent.click(await screen.findByTestId('pn-note-new'));
    fireEvent.change(screen.getByTestId('pn-note-input'), { target: { value: '# 메모\n\n$a+b$' } });
    fireEvent.click(screen.getByTestId('pn-note-preview-toggle'));
    expect(screen.getByTestId('pn-note-preview').querySelector('.katex')).not.toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId('pn-note-save')));
    expect(server.calls.find((c) => c.method === 'POST')!.body).toEqual({ bodyMd: '# 메모\n\n$a+b$', sectionId: 'S2' });
    const item = await screen.findByTestId('pn-note-item');
    fireEvent.click(within(item).getByTestId('pn-note-edit'));
    fireEvent.change(within(item).getByTestId('pn-note-input'), { target: { value: '고친 메모' } });
    await act(async () => fireEvent.click(within(item).getByTestId('pn-note-save')));
    expect(server.calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/notes/n1', body: { bodyMd: '고친 메모' } });
    await waitFor(() => expect(screen.getByTestId('pn-note-item').textContent).toContain('고친 메모'));
    fireEvent.click(screen.getByTestId('pn-note-delete'));
    await act(async () => fireEvent.click(screen.getByTestId('pn-note-delete-confirm')));
    await waitFor(() => expect(screen.queryAllByTestId('pn-note-item')).toHaveLength(0));
  });

  it('the reader "note" action opens a note on its highlight with the quote', async () => {
    const notes: NoteDto[] = [];
    const { server } = renderWithApi(<HighlightsTab paperId={PAPER} />, api([hl('h1')], notes));
    await screen.findAllByTestId('highlight-item');
    act(() => useReaderStore.getState().requestAction({ kind: 'note', highlightId: 'h1', text: 'We estimate\nthe robot pose' }));
    const input = (await screen.findByTestId('pn-note-input')) as HTMLTextAreaElement;
    expect(input.value).toBe('> We estimate the robot pose\n\n');
    expect(useReaderStore.getState().pendingAction).toBeNull();
    fireEvent.change(input, { target: { value: `${input.value}중요` } });
    await act(async () => fireEvent.click(screen.getByTestId('pn-note-save')));
    expect(server.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ highlightId: 'h1', sectionId: 'S2' });
  });

  // Review D-R3-01: with many highlights the notes section sits far down the scroll area, so a note action must bring
  // the new note editor into view and focus it. The editor and '새 노트' live outside the highlight scroll area.
  describe('the new note editor with 30 highlights (D-R3-01)', () => {
    const many = () => Array.from({ length: 30 }, (_, i) => hl(`h${i}`, { rects: [{ page: 1, x: 0.1, y: 0.02 * i, w: 0.3, h: 0.01 }] }));
    let scrolled: Element[] = [];
    let restore: () => void = () => {};
    beforeEach(() => {
      scrolled = [];
      const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (this: Element) => void };
      const orig = proto.scrollIntoView;
      proto.scrollIntoView = function (this: Element) {
        scrolled.push(this);
      };
      restore = () => {
        proto.scrollIntoView = orig;
      };
    });
    afterEach(() => restore());

    it('the reader "note" action: editor outside the scroll area, scrolled into view, input focused (caret at the end)', async () => {
      renderWithApi(<HighlightsTab paperId={PAPER} />, api(many(), [note('n0', '앞 노트')]));
      await waitFor(() => expect(screen.getAllByTestId('highlight-item')).toHaveLength(30));
      act(() => useReaderStore.getState().requestAction({ kind: 'note', highlightId: 'h3', text: 'We estimate\nthe robot pose' }));
      const editor = await screen.findByTestId('pn-note-editor');
      const input = screen.getByTestId('pn-note-input') as HTMLTextAreaElement;
      await waitFor(() => expect(document.activeElement).toBe(input));
      expect(input.selectionStart).toBe(input.value.length);
      expect(scrolled.some((el) => el === editor || el.contains(editor))).toBe(true);
      expect(screen.getByTestId('pn-highlights-scroll').contains(editor)).toBe(false);
      // a second action while the editor is open re-opens it with the new quote and focuses it again
      input.blur();
      act(() => useReaderStore.getState().requestAction({ kind: 'note', text: '둘째 문장' }));
      await waitFor(() => expect((screen.getByTestId('pn-note-input') as HTMLTextAreaElement).value).toBe('> 둘째 문장\n\n'));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('pn-note-input')));
    });

    // Review D-F1-02: after a save the new note (at the bottom of the scroll area) is brought into view and marked.
    it('a saved new note is scrolled into view and marked "방금 저장"', async () => {
      const notes = [note('n0', '앞 노트')];
      renderWithApi(<HighlightsTab paperId={PAPER} />, api(many(), notes));
      await waitFor(() => expect(screen.getAllByTestId('highlight-item')).toHaveLength(30));
      fireEvent.click(screen.getByTestId('pn-note-new'));
      fireEvent.change(await screen.findByTestId('pn-note-input'), { target: { value: '새 메모' } });
      scrolled = [];
      await act(async () => fireEvent.click(screen.getByTestId('pn-note-save')));
      const row = await waitFor(() => screen.getAllByTestId('pn-note-item').find((i) => i.dataset.noteId === 'n2')!);
      await waitFor(() => expect(scrolled.some((el) => el === row || row.contains(el))).toBe(true));
      expect(within(row).getByTestId('pn-note-saved').textContent).toContain('방금 저장');
      expect(within(row).getByTestId('pn-note-body').textContent).toContain('새 메모');
      expect(screen.queryByTestId('pn-note-editor')).toBeNull();
      // only the newest saved note carries the mark
      const n0 = screen.getAllByTestId('pn-note-item').find((i) => i.dataset.noteId === 'n0')!;
      expect(within(n0).queryByTestId('pn-note-saved')).toBeNull();
    });

    // Rows above the saved note are drawn lazily and grow, which can push it out again: it is kept in view while the
    // scroll area's content changes size, until the user acts.
    it('the saved note is brought back into view when rows of the area grow, until the user acts', async () => {
      const observers: { cb: () => void; targets: Element[]; on: boolean }[] = [];
      class FakeRO {
        o: { cb: () => void; targets: Element[]; on: boolean };
        constructor(cb: () => void) {
          this.o = { cb, targets: [], on: true };
          observers.push(this.o);
        }
        observe(t: Element) {
          this.o.targets.push(t);
        }
        disconnect() {
          this.o.on = false;
        }
      }
      vi.stubGlobal('ResizeObserver', FakeRO);
      try {
        renderWithApi(<HighlightsTab paperId={PAPER} />, api(many(), [note('n0', '앞 노트')]));
        await waitFor(() => expect(screen.getAllByTestId('highlight-item')).toHaveLength(30));
        fireEvent.click(screen.getByTestId('pn-note-new'));
        fireEvent.change(await screen.findByTestId('pn-note-input'), { target: { value: '새 메모' } });
        await act(async () => fireEvent.click(screen.getByTestId('pn-note-save')));
        const row = await waitFor(() => screen.getAllByTestId('pn-note-item').find((i) => i.dataset.noteId === 'n2')!);
        await waitFor(() => expect(observers.some((o) => o.on)).toBe(true));
        const live = observers.find((o) => o.on)!;
        // it watches the children of the scroll area (the highlight list and the notes)
        const scroll = screen.getByTestId('pn-highlights-scroll');
        expect(live.targets).toEqual(Array.from(scroll.children));
        scrolled = [];
        act(() => live.cb());
        expect(scrolled).toEqual([row]);
        // a user action ends it
        fireEvent.pointerDown(document.body);
        expect(live.on).toBe(false);
      } finally {
        vi.unstubAllGlobals();
        vi.stubGlobal('IntersectionObserver', FakeIO);
      }
    });

    it("'새 노트' sits outside the scroll area; pressing it opens a focused editor in view", async () => {
      renderWithApi(<HighlightsTab paperId={PAPER} />, api(many(), []));
      await waitFor(() => expect(screen.getAllByTestId('highlight-item')).toHaveLength(30));
      const button = screen.getByTestId('pn-note-new');
      expect(screen.getByTestId('pn-highlights-scroll').contains(button)).toBe(false);
      fireEvent.click(button);
      const editor = await screen.findByTestId('pn-note-editor');
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('pn-note-input')));
      expect(scrolled.some((el) => el === editor || el.contains(editor))).toBe(true);
      expect(screen.getByTestId('pn-highlights-scroll').contains(editor)).toBe(false);
    });
  });

  // Review D-F1-01: a note action while the editor holds written text must not throw that text away.
  describe('a note action while a draft is open (D-F1-01)', () => {
    it('written text is kept and the new quote is appended (link of the first action kept); unwritten draft is replaced', async () => {
      const notes: NoteDto[] = [];
      const { server } = renderWithApi(<HighlightsTab paperId={PAPER} />, api([hl('h1'), hl('h2')], notes));
      await waitFor(() => expect(screen.getAllByTestId('highlight-item')).toHaveLength(2));
      const input = () => screen.getByTestId('pn-note-input') as HTMLTextAreaElement;
      // an unwritten draft is replaced by the next action (its quote and link)
      act(() => useReaderStore.getState().requestAction({ kind: 'note', highlightId: 'h2', text: '버릴 문장' }));
      await waitFor(() => expect(input().value).toBe('> 버릴 문장\n\n'));
      act(() => useReaderStore.getState().requestAction({ kind: 'note', highlightId: 'h1', text: '첫 문장' }));
      await waitFor(() => expect(input().value).toBe('> 첫 문장\n\n'));
      fireEvent.change(input(), { target: { value: '> 첫 문장\n\n내 메모' } });
      input().blur();
      act(() => useReaderStore.getState().requestAction({ kind: 'note', highlightId: 'h2', text: '둘째\n문장' }));
      await waitFor(() => expect(input().value).toBe('> 첫 문장\n\n내 메모\n\n> 둘째 문장\n\n'));
      await waitFor(() => expect(document.activeElement).toBe(input()));
      expect(input().selectionStart).toBe(input().value.length);
      // N without a selection: the written text stays as it is, the editor is focused again
      input().blur();
      act(() => useReaderStore.getState().requestAction({ kind: 'note' }));
      await waitFor(() => expect(document.activeElement).toBe(input()));
      expect(input().value).toBe('> 첫 문장\n\n내 메모\n\n> 둘째 문장\n\n');
      await act(async () => fireEvent.click(screen.getByTestId('pn-note-save')));
      expect(server.calls.find((c) => c.method === 'POST')!.body).toEqual({ bodyMd: '> 첫 문장\n\n내 메모\n\n> 둘째 문장\n\n', highlightId: 'h1', sectionId: 'S2' });
    });

    it('a note action during notes.create opens its draft after the save instead of being closed by it', async () => {
      let release: () => void = () => {};
      const notes: NoteDto[] = [];
      const base = api([], notes);
      const { server } = renderWithApi(<HighlightsTab paperId={PAPER} />, (c) => {
        if (c.method === 'POST') return new Promise<JsonReply | undefined>((r) => (release = () => r(base(c))));
        return base(c);
      });
      fireEvent.click(await screen.findByTestId('pn-note-new'));
      fireEvent.change(screen.getByTestId('pn-note-input'), { target: { value: '첫 노트' } });
      fireEvent.click(screen.getByTestId('pn-note-save'));
      await waitFor(() => expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(1));
      act(() => useReaderStore.getState().requestAction({ kind: 'note', text: '다음 문장' }));
      await act(async () => release());
      await waitFor(() => expect(screen.getAllByTestId('pn-note-item')).toHaveLength(1));
      await waitFor(() => expect((screen.getByTestId('pn-note-input') as HTMLTextAreaElement).value).toBe('> 다음 문장\n\n'));
      expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
      expect(server.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ bodyMd: '첫 노트' });
    });

    it('a save error is cleared when the draft is closed and opened again', async () => {
      const base = api([], []);
      renderWithApi(<HighlightsTab paperId={PAPER} />, (c) => (c.method === 'POST' ? { status: 500, json: { error: { code: 'internal', message: 'x' } } } : base(c)));
      fireEvent.click(await screen.findByTestId('pn-note-new'));
      fireEvent.change(screen.getByTestId('pn-note-input'), { target: { value: '메모' } });
      await act(async () => fireEvent.click(screen.getByTestId('pn-note-save')));
      await screen.findByText('노트를 저장하지 못했습니다');
      fireEvent.click(within(screen.getByTestId('pn-note-editor')).getByRole('button', { name: '취소' }));
      fireEvent.click(await screen.findByTestId('pn-note-new'));
      await screen.findByTestId('pn-note-editor');
      expect(screen.queryByText('노트를 저장하지 못했습니다')).toBeNull();
    });
  });

  // Review D-S1-01: '취소' is disabled while a save is pending (like the read-only input and the disabled '저장'), so a
  // failed save leaves the written text and its error in that editor instead of dropping them.
  describe('cancel while a save is pending (D-S1-01)', () => {
    const FAIL: JsonReply = { status: 500, json: { error: { code: 'internal', message: 'x' } } };
    const cancelOf = (editor: HTMLElement) => within(editor).getByRole('button', { name: '취소' }) as HTMLButtonElement;

    it('new note: 취소 cannot drop the draft during notes.create; after a failed save the text and the error stay', async () => {
      let fail: () => void = () => {};
      const base = api([], []);
      const { server } = renderWithApi(<HighlightsTab paperId={PAPER} />, (c) => (c.method === 'POST' ? new Promise<JsonReply | undefined>((r) => (fail = () => r(FAIL))) : base(c)));
      fireEvent.click(await screen.findByTestId('pn-note-new'));
      fireEvent.change(screen.getByTestId('pn-note-input'), { target: { value: '오래 쓴 글' } });
      fireEvent.click(screen.getByTestId('pn-note-save'));
      await waitFor(() => expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(1));
      const editor = screen.getByTestId('pn-note-editor');
      expect(cancelOf(editor).disabled).toBe(true);
      fireEvent.click(cancelOf(editor));
      expect(screen.getByTestId('pn-note-editor')).toBe(editor);
      await act(async () => fail());
      const composer = screen.getByTestId('pn-note-composer');
      await within(composer).findByText('노트를 저장하지 못했습니다');
      const input = within(composer).getByTestId('pn-note-input') as HTMLTextAreaElement;
      expect(input.value).toBe('오래 쓴 글');
      expect(input.readOnly).toBe(false);
      expect(cancelOf(composer).disabled).toBe(false);
      expect(screen.queryAllByTestId('pn-note-item')).toHaveLength(0);
    });

    it('editing a saved note: 취소 cannot close the editor during notes.patch; after a failed patch the edit and the error stay', async () => {
      let fail: () => void = () => {};
      const base = api([], [note('n1', '원래 메모')]);
      const { server } = renderWithApi(<HighlightsTab paperId={PAPER} />, (c) => (c.method === 'PATCH' ? new Promise<JsonReply | undefined>((r) => (fail = () => r(FAIL))) : base(c)));
      const item = await screen.findByTestId('pn-note-item');
      fireEvent.click(within(item).getByTestId('pn-note-edit'));
      fireEvent.change(within(item).getByTestId('pn-note-input'), { target: { value: '고친 메모' } });
      fireEvent.click(within(item).getByTestId('pn-note-save'));
      await waitFor(() => expect(server.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1));
      const editor = within(item).getByTestId('pn-note-editor');
      expect(cancelOf(editor).disabled).toBe(true);
      fireEvent.click(cancelOf(editor));
      expect(within(item).getByTestId('pn-note-editor')).toBe(editor);
      await act(async () => fail());
      await within(item).findByText('노트를 저장하지 못했습니다');
      expect((within(item).getByTestId('pn-note-input') as HTMLTextAreaElement).value).toBe('고친 메모');
      expect(cancelOf(within(item).getByTestId('pn-note-editor')).disabled).toBe(false);
    });
  });

  // Review D-S1-02: notes.create closes only the draft it saved. The UI no longer reaches "close + open while saving"
  // (D-S1-01), so the hook is driven directly: a draft opened after closing the saving one survives that save's success.
  it('useNoteDraft: a draft opened after closing the saving one stays open when that save succeeds (D-S1-02)', async () => {
    let release: () => void = () => {};
    const notes: NoteDto[] = [];
    const base = api([], notes);
    const server = createFakeServer((c) => (c.method === 'POST' ? new Promise<JsonReply | undefined>((r) => (release = () => r(base(c)))) : base(c)));
    const qc = createAppQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <PanelApiContext.Provider value={server.client}>{children}</PanelApiContext.Provider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useNoteDraft(PAPER), { wrapper });
    act(() => result.current.open());
    act(() => result.current.setBody('첫 노트'));
    const firstId = result.current.draft!.id;
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.create();
    });
    await waitFor(() => expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(result.current.saving).toBe(true);
    act(() => result.current.close());
    act(() => result.current.open());
    const secondId = result.current.draft!.id;
    expect(secondId).not.toBe(firstId);
    act(() => result.current.setBody('둘째 글'));
    await act(async () => {
      release();
      await saving;
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.draft).toMatchObject({ id: secondId, body: '둘째 글' });
    expect(result.current.saved).toMatchObject({ noteId: 'n1' });
    expect(result.current.error).toBeNull();
    expect(notes.map((n) => n.bodyMd)).toEqual(['첫 노트']);
    // control: with no other draft opened meanwhile, a successful save closes the draft it saved
    act(() => result.current.setBody('셋째 글'));
    await act(async () => {
      const p = result.current.create();
      release();
      await p;
    });
    expect(result.current.draft).toBeNull();
    expect(result.current.saved).toMatchObject({ noteId: 'n2' });
  });

  // Review D-F1-02: the fixed row above the scroll area holds only '새 노트'; the notes list has its own '노트 n개' header.
  it("'노트 n개' header sits at the top of the notes list (inside the scroll area), not above the highlights", async () => {
    renderWithApi(<HighlightsTab paperId={PAPER} />, api([hl('h1'), hl('h2')], [note('n1', '하나'), note('n2', '둘'), note('n3', '셋')]));
    await waitFor(() => expect(screen.getAllByTestId('pn-note-item')).toHaveLength(3));
    const scroll = screen.getByTestId('pn-highlights-scroll');
    const header = await screen.findByTestId('pn-notes-header');
    expect(header.textContent).toBe('노트 3개');
    expect(within(screen.getByTestId('pn-notes')).getByTestId('pn-notes-header')).toBe(header);
    expect(scroll.contains(header)).toBe(true);
    // the header comes after the highlight list in the scroll area
    expect(screen.getByTestId('highlight-list').compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // above the scroll area there is no '노트' label: only the '새 노트' button
    const tab = screen.getByTestId('highlights-tab');
    const above = [...tab.children].filter((c) => c !== scroll).map((c) => c.textContent ?? '').join(' ');
    expect(above.replaceAll('새 노트', '')).not.toContain('노트');
    expect(scroll.contains(screen.getByTestId('pn-note-new'))).toBe(false);
  });

  it('an area highlight shows its capture thumbnail (papers.capture → blob URL)', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    renderWithApi(<HighlightsTab paperId={PAPER} />, api([hl('a1', { kind: 'area', quote: null, imageFileId: 'cap-1' })], []));
    const img = (await screen.findByTestId('pn-highlight-thumb')) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:thumb');
    create.mockRestore();
    revoke.mockRestore();
  });
});

describe('note size (review D-R1-07): bounded rendering', () => {
  it('a 100,000-character note is drawn folded (≤ NOTE_PREVIEW_CHARS), "더 보기" adds NOTE_MORE_CHARS per press', async () => {
    const big = `${'가나다라 마바사 '.repeat(12_500)}`.slice(0, 100_000);
    renderWithApi(<HighlightsTab paperId={PAPER} />, api([], [note('big', big)]));
    const body = await screen.findByTestId('pn-note-body');
    expect(Number(body.dataset.total)).toBe(100_000);
    expect(Number(body.dataset.shown)).toBeLessThanOrEqual(NOTE_PREVIEW_CHARS);
    expect(body.textContent!.length).toBeLessThanOrEqual(NOTE_PREVIEW_CHARS + 100);
    fireEvent.click(within(body).getByTestId('pn-note-more'));
    await waitFor(() => expect(Number(screen.getByTestId('pn-note-body').dataset.shown)).toBe(NOTE_PREVIEW_CHARS + NOTE_MORE_CHARS));
    expect(screen.getByTestId('pn-note-body').textContent!.length).toBeLessThanOrEqual(NOTE_PREVIEW_CHARS + NOTE_MORE_CHARS + 100);
  });

  it('notes out of view are not drawn (no parse / render) until they come into view', async () => {
    visible = false;
    renderWithApi(<HighlightsTab paperId={PAPER} />, api([], [note('a', '첫 노트 본문'), note('b', '둘째 노트 본문')]));
    await waitFor(() => expect(screen.getAllByTestId('pn-note-item')).toHaveLength(2));
    expect(screen.getAllByTestId('pn-note-pending')).toHaveLength(2);
    expect(screen.queryByTestId('pn-note-body')).toBeNull();
    expect(screen.getByTestId('pn-notes').textContent).not.toContain('첫 노트 본문');
  });

  it('area highlight thumbnails are fetched only for rows that came into view (review D-R2-04)', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    visible = false;
    const areas = Array.from({ length: 12 }, (_, i) => hl(`a${i}`, { kind: 'area', quote: null, imageFileId: `cap-${i}`, rects: [{ page: 1, x: 0.1, y: 0.01 * i, w: 0.3, h: 0.01 }] }));
    const { server } = renderWithApi(<HighlightsTab paperId={PAPER} />, api(areas, []));
    await waitFor(() => expect(screen.getAllByTestId('highlight-item')).toHaveLength(12));
    const captureCalls = () => server.calls.filter((c) => c.url.includes('/captures/')).length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(captureCalls()).toBe(0);
    expect(screen.getAllByTestId('pn-highlight-thumb-pending')).toHaveLength(12);
    expect(screen.queryByTestId('pn-highlight-thumb')).toBeNull();
    // The rows come into view: each fetches its own capture once.
    await act(async () => revealAll());
    await waitFor(() => expect(screen.getAllByTestId('pn-highlight-thumb')).toHaveLength(12));
    expect(captureCalls()).toBe(12);
    create.mockRestore();
    revoke.mockRestore();
  });
});
