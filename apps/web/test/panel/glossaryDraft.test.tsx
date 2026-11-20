// Review D-I10-03: an AI suggestion whose definition the user edited ("고쳐서 저장") and did not save yet is never lost
// to a new definition request. With such a draft, the reader "glossary" action (G) and "정의 요청" only fill the term
// input, start nothing, and say to save or discard first; "버리기" discards it, after which a request starts. An
// unedited suggestion does not block (the coordinator's rule covers an edited draft). Review D-FX2R1-03: no request
// starts while a save is in flight either. Owner D.
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const EDITED = '내가 고친 정의: outlier의 영향을 줄이는 가중 함수';

const api = (c: FakeCall): JsonReply | undefined => {
  if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/glossary`) return { status: 200, json: { terms: [] } };
  if (c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary`) return { status: 200, json: { id: 'g1', paperId: PAPER, term: c.body!.term, definitionKo: c.body!.definitionKo, origin: 'llm_edited', createdAt: 1, citations: [] } };
  return undefined;
};
const defines = (server: { calls: FakeCall[] }) => server.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/glossary/define'));
const creates = (server: { calls: FakeCall[] }) => server.calls.filter((c) => c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary`);
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const termInput = () => screen.getByTestId('pn-glossary-define-term') as HTMLInputElement;

/** "정의 요청" for robust kernel → suggestion shown → "고쳐서 저장" (optionally editing the definition). */
async function suggestionInEdit(server: ReturnType<typeof renderWithApi>['server'], edit: boolean) {
  await screen.findByText('용어집이 비어 있습니다');
  fireEvent.change(termInput(), { target: { value: 'robust kernel' } });
  fireEvent.click(screen.getByTestId('pn-glossary-define-start'));
  await waitFor(() => expect(server.streamCount()).toBe(1));
  await act(async () => {
    server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.doneParsed('x', PARSED, CITES));
    server.end();
  });
  fireEvent.click(await screen.findByTestId('pn-glossary-suggestion-modify'));
  if (edit) fireEvent.change(screen.getByTestId('pn-glossary-suggestion-edit'), { target: { value: EDITED } });
}

describe('glossary: an edited, unsaved suggestion is kept (review D-I10-03)', () => {
  it('G while editing → only the term input is filled; the edited text stays; no request; a notice says save or discard', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, api);
    await suggestionInEdit(server, true);
    act(() => useReaderStore.getState().requestAction({ kind: 'glossary', anchor: anchorOf('fixed threshold'), text: 'fixed threshold' }));
    await settle();
    expect(termInput().value).toBe('fixed threshold');
    expect(screen.getByTestId('pn-glossary-suggestion')).toBeTruthy();
    expect((screen.getByTestId('pn-glossary-suggestion-edit') as HTMLTextAreaElement).value).toBe(EDITED);
    expect(defines(server)).toHaveLength(1);
    expect(server.streamCount()).toBe(1);
    expect(screen.getByTestId('pn-glossary-define-blocked').textContent).toContain('저장하거나 버린 뒤');
    expect(useReaderStore.getState().pendingAction).toBeNull(); // the action was consumed (not left to fire later)
  });

  it('"정의 요청" while editing is held the same way', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, api);
    await suggestionInEdit(server, true);
    fireEvent.change(termInput(), { target: { value: 'loop closure' } });
    fireEvent.click(screen.getByTestId('pn-glossary-define-start'));
    await settle();
    expect(defines(server)).toHaveLength(1);
    expect((screen.getByTestId('pn-glossary-suggestion-edit') as HTMLTextAreaElement).value).toBe(EDITED);
    expect(screen.getByTestId('pn-glossary-define-blocked')).toBeTruthy();
  });

  it('saving the edited draft stores it; the next request then starts', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, api);
    await suggestionInEdit(server, true);
    act(() => useReaderStore.getState().requestAction({ kind: 'glossary', anchor: anchorOf('fixed threshold'), text: 'fixed threshold' }));
    await settle();
    fireEvent.click(screen.getByTestId('pn-glossary-suggestion-save'));
    await screen.findByTestId('pn-glossary-saved');
    expect(creates(server)[0]!.body).toMatchObject({ term: 'robust kernel', definitionKo: EDITED, llmCallId: 'run-def' });
    expect(screen.queryByTestId('pn-glossary-define-blocked')).toBeNull();
    fireEvent.click(screen.getByTestId('pn-glossary-define-start'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(defines(server)[1]!.body).toMatchObject({ term: 'fixed threshold' });
  });

  it('"버리기" discards the suggestion and its draft; the next request then starts', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, api);
    await suggestionInEdit(server, true);
    act(() => useReaderStore.getState().requestAction({ kind: 'glossary', anchor: anchorOf('fixed threshold'), text: 'fixed threshold' }));
    await settle();
    fireEvent.click(screen.getByTestId('pn-glossary-suggestion-discard'));
    expect(screen.queryByTestId('pn-glossary-suggestion')).toBeNull();
    expect(screen.queryByTestId('pn-glossary-define-blocked')).toBeNull();
    expect(creates(server)).toHaveLength(0);
    fireEvent.click(screen.getByTestId('pn-glossary-define-start'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(defines(server)[1]!.body).toMatchObject({ term: 'fixed threshold' });
  });

  it('an unedited suggestion (edit opened, text unchanged) does not block G', async () => {
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, api);
    await suggestionInEdit(server, false);
    act(() => useReaderStore.getState().requestAction({ kind: 'glossary', anchor: anchorOf('fixed threshold'), text: 'fixed threshold' }));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(defines(server)[1]!.body).toMatchObject({ term: 'fixed threshold' });
    expect(screen.queryByTestId('pn-glossary-define-blocked')).toBeNull();
  });
});

// Review D-FX2R1-03: while a save (glossary.create) is in flight, G / "정의 요청" start nothing — a request started then
// was aborted by the save's completion (run.reset()), throwing away a started LLM call without a word. The term input
// is filled, a notice says to wait, "정의 요청" is disabled; once the save ends the request can be made.
describe('glossary: a definition request while a save is in flight (review D-FX2R1-03)', () => {
  it.each([false, true])('G while saving (draft edited: %s) → one define request only, nothing aborted; after the save the request starts', async (edit) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const heldApi = async (c: FakeCall): Promise<JsonReply | undefined> => {
      if (c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary`) await held;
      return api(c);
    };
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, heldApi);
    await suggestionInEdit(server, edit);
    fireEvent.click(screen.getByTestId('pn-glossary-suggestion-save'));
    await waitFor(() => expect(creates(server)).toHaveLength(1));
    act(() => useReaderStore.getState().requestAction({ kind: 'glossary', anchor: anchorOf('fixed threshold'), text: 'fixed threshold' }));
    await settle();
    expect(termInput().value).toBe('fixed threshold');
    expect(defines(server)).toHaveLength(1);
    expect(server.streamCount()).toBe(1);
    expect(screen.getByTestId('pn-glossary-define-blocked').textContent).toContain('저장 중');
    expect((screen.getByTestId('pn-glossary-define-start') as HTMLButtonElement).disabled).toBe(true);
    // the save completes: saved, the notice goes, and "정의 요청" now starts the held term
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('pn-glossary-saved')).toBeTruthy();
    expect(screen.queryByTestId('pn-glossary-define-blocked')).toBeNull();
    expect(defines(server)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('pn-glossary-define-start'));
    await waitFor(() => expect(server.streamCount()).toBe(2));
    expect(defines(server)[1]!.body).toMatchObject({ term: 'fixed threshold' });
    expect(screen.getByTestId('pn-glossary-define-progress')).toBeTruthy();
  });

  it('G while the save of an EDITED draft fails → still held for the draft (edited text kept, no request)', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const failingApi = async (c: FakeCall): Promise<JsonReply | undefined> => {
      if (c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary`) {
        await held;
        return { status: 500, json: { error: { code: 'internal', message: 'boom' } } };
      }
      return api(c);
    };
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, failingApi);
    await suggestionInEdit(server, true);
    fireEvent.click(screen.getByTestId('pn-glossary-suggestion-save'));
    await waitFor(() => expect(creates(server)).toHaveLength(1));
    act(() => useReaderStore.getState().requestAction({ kind: 'glossary', anchor: anchorOf('fixed threshold'), text: 'fixed threshold' }));
    await settle();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('pn-glossary-error')).toBeTruthy();
    expect(screen.getByTestId('pn-glossary-define-blocked').dataset.reason).toBe('edited');
    expect((screen.getByTestId('pn-glossary-suggestion-edit') as HTMLTextAreaElement).value).toBe(EDITED);
    expect(defines(server)).toHaveLength(1);
  });
});

// Review D-FX2R2-02: the save sends the text as it was when "저장" was pressed and, on success, clears the draft. So
// while the save is in flight the definition cannot be edited (textarea read-only) and "고쳐서 저장" cannot open an
// editor (disabled), like the note editor (D-S1-01); after a failed save both work again.
describe('glossary: the suggestion cannot be edited while its save is in flight (review D-FX2R2-02)', () => {
  const heldSave = (outcome: 'ok' | 'fail') => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const handler = async (c: FakeCall): Promise<JsonReply | undefined> => {
      if (c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary`) {
        await held;
        if (outcome === 'fail') return { status: 500, json: { error: { code: 'internal', message: 'boom' } } };
      }
      return api(c);
    };
    return { handler, release: () => act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); }) };
  };
  const editBox = () => screen.getByTestId('pn-glossary-suggestion-edit') as HTMLTextAreaElement;

  it.each(['ok', 'fail'] as const)('edited draft: the textarea is read-only while saving (save %s); editable again after a failure', async (outcome) => {
    const h = heldSave(outcome);
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, h.handler);
    await suggestionInEdit(server, true);
    expect(editBox().readOnly).toBe(false);
    fireEvent.click(screen.getByTestId('pn-glossary-suggestion-save'));
    await waitFor(() => expect(creates(server)).toHaveLength(1));
    expect(editBox().readOnly).toBe(true);
    await h.release();
    expect(creates(server)[0]!.body).toMatchObject({ definitionKo: EDITED });
    if (outcome === 'ok') {
      expect(screen.getByTestId('pn-glossary-saved')).toBeTruthy();
      expect(screen.queryByTestId('pn-glossary-suggestion-edit')).toBeNull();
    } else {
      expect(screen.getByTestId('pn-glossary-error')).toBeTruthy();
      expect(editBox().readOnly).toBe(false);
      fireEvent.change(editBox(), { target: { value: `${EDITED} (더 고침)` } });
      expect(editBox().value).toBe(`${EDITED} (더 고침)`);
    }
  });

  it('unedited suggestion: "고쳐서 저장" is disabled while saving; enabled again after a failed save', async () => {
    const h = heldSave('fail');
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, h.handler);
    await screen.findByText('용어집이 비어 있습니다');
    fireEvent.change(termInput(), { target: { value: 'robust kernel' } });
    fireEvent.click(screen.getByTestId('pn-glossary-define-start'));
    await waitFor(() => expect(server.streamCount()).toBe(1));
    await act(async () => {
      server.push(ev.acceptedRun({ runId: 'run-def', task: 'glossary_define' }), ev.doneParsed('x', PARSED, CITES));
      server.end();
    });
    const modify = () => screen.getByTestId('pn-glossary-suggestion-modify') as HTMLButtonElement;
    expect(modify().disabled).toBe(false);
    fireEvent.click(screen.getByTestId('pn-glossary-suggestion-save'));
    await waitFor(() => expect(creates(server)).toHaveLength(1));
    expect(modify().disabled).toBe(true);
    fireEvent.click(modify());
    expect(screen.queryByTestId('pn-glossary-suggestion-edit')).toBeNull();
    await h.release();
    expect(screen.getByTestId('pn-glossary-error')).toBeTruthy();
    expect(modify().disabled).toBe(false);
    fireEvent.click(modify());
    expect(editBox().readOnly).toBe(false);
  });
});

// Review D-FX2R3-02: the save state shown must match the save. A failed save's error line goes with "버리기" (the
// suggestion it was about is gone), and "저장 중" ends with glossary.create — the glossary.list refetch after a
// successful save is not part of the save, so G / "정의 요청" are not held (or disabled) while it is in flight.
describe('glossary: the save state shown matches the save (review D-FX2R3-02)', () => {
  it('a failed save, then "버리기" → the save error line goes with the suggestion', async () => {
    const failing = (c: FakeCall): JsonReply | undefined =>
      c.method === 'POST' && c.url === `/api/papers/${PAPER}/glossary` ? { status: 409, json: { error: { code: 'conflict', message: 'dup' } } } : api(c);
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, failing);
    await suggestionInEdit(server, true);
    fireEvent.click(screen.getByTestId('pn-glossary-suggestion-save'));
    await screen.findByTestId('pn-glossary-error');
    fireEvent.click(screen.getByTestId('pn-glossary-suggestion-discard'));
    expect(screen.queryByTestId('pn-glossary-suggestion')).toBeNull();
    expect(screen.queryByTestId('pn-glossary-error')).toBeNull();
    expect(creates(server)).toHaveLength(1);
  });

  it('a successful save is done when glossary.create answers: G during the list refetch starts its request at once', async () => {
    const list = { n: 0, release: null as (() => void) | null };
    const heldList = async (c: FakeCall): Promise<JsonReply | undefined> => {
      if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/glossary` && ++list.n > 1) await new Promise<void>((r) => (list.release = r));
      return api(c);
    };
    const { server } = renderWithApi(<GlossaryTab paperId={PAPER} />, heldList);
    await suggestionInEdit(server, true);
    fireEvent.click(screen.getByTestId('pn-glossary-suggestion-save'));
    await screen.findByTestId('pn-glossary-saved');
    await waitFor(() => expect(list.release).not.toBeNull()); // the refetch after the save is in flight (held)
    await settle();
    expect(screen.queryByTestId('pn-glossary-suggestion')).toBeNull();
    expect((screen.getByTestId('pn-glossary-define-start') as HTMLButtonElement).disabled).toBe(false);
    act(() => useReaderStore.getState().requestAction({ kind: 'glossary', anchor: anchorOf('fixed threshold'), text: 'fixed threshold' }));
    await settle();
    expect(screen.queryByTestId('pn-glossary-define-blocked')).toBeNull();
    expect(defines(server)).toHaveLength(2);
    expect(defines(server)[1]!.body).toMatchObject({ term: 'fixed threshold' });
    expect(screen.getByTestId('pn-glossary-define-progress')).toBeTruthy();
    await act(async () => {
      list.release!();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('pn-glossary-define-progress')).toBeTruthy(); // the refetch's end does not touch the request
  });
});
