// References tab (BRIEF_D D6): [n] list as text, focus highlight, "Library에 있음" opens that paper, "가져오기" with an
// arXiv-id confirmation → papers.import, an item without an id has neither, DOI / arXiv only behind "열기". Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReferencesTab } from '../../src/panel/ReferencesTab';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, renderWithApi, resetReader } from './panelHarness';
import { LINKS_PAPER, structureFixture } from './structureFixture';

afterEach(cleanup);
beforeEach(() => {
  resetReader(true);
  useReaderStore.setState({ paperState: { readable: true, contextReady: true, structureReady: true } });
  window.history.replaceState(null, '', `/paper/${PAPER}`);
});

function show(focusOrdinal: number | null = null) {
  return renderWithApi(<ReferencesTab paperId={PAPER} focusOrdinal={focusOrdinal} />, (c) => {
    if (c.url === `/api/papers/${PAPER}/structure`) return { status: 200, json: structureFixture() };
    if (c.method === 'POST' && c.url === '/api/papers/import') return { status: 200, json: { paperId: 'new-paper', jobId: 'job-1', existing: false } };
    return undefined;
  });
}
const item = (n: number) => screen.getAllByTestId('pn-ref-item').find((i) => i.dataset.ordinal === String(n))!;

describe('ReferencesTab', () => {
  it('lists [n] with the raw text as plain text (no link elements)', async () => {
    const { container } = show();
    await screen.findAllByTestId('pn-ref-item');
    expect(screen.getAllByTestId('pn-ref-item').map((i) => i.dataset.ordinal)).toEqual(['1', '2', '3']);
    expect(item(1).textContent).toContain('[1]A. Author. A paper without an identifier.');
    expect(container.querySelector('a')).toBeNull();
  });

  it('[1] without an id: neither "Library에 있음" nor "가져오기"', async () => {
    show();
    await screen.findAllByTestId('pn-ref-item');
    expect(within(item(1)).queryByTestId('pn-ref-in-library')).toBeNull();
    expect(within(item(1)).queryByTestId('pn-ref-import')).toBeNull();
    expect(within(item(1)).queryByTestId('sp-ext-link')).toBeNull();
  });

  it('[2] in the Library: "Library에 있음" opens that paper', async () => {
    show();
    await screen.findAllByTestId('pn-ref-item');
    expect(within(item(2)).queryByTestId('pn-ref-import')).toBeNull();
    fireEvent.click(within(item(2)).getByTestId('pn-ref-in-library'));
    expect(window.location.pathname).toBe(`/paper/${LINKS_PAPER}`);
  });

  it('[3] arXiv only: "가져오기" asks with the arXiv id, then papers.import', async () => {
    const { server } = show();
    await screen.findAllByTestId('pn-ref-item');
    fireEvent.click(within(item(3)).getByTestId('pn-ref-import'));
    expect(server.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(within(item(3)).getByTestId('pn-ref-import-confirm').textContent).toContain('arXiv 2301.00099');
    await act(async () => fireEvent.click(within(item(3)).getByTestId('pn-ref-import-go')));
    const post = server.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/papers/import');
    expect(post.body).toMatchObject({ input: '2301.00099' });
    expect(typeof post.body!.clientRequestId).toBe('string');
    await waitFor(() => expect(within(item(3)).getByTestId('pn-ref-import-result').textContent).toContain('가져오기를 시작했습니다'));
  });

  it('DOI / arXiv pages only through the "열기" confirmation', async () => {
    show();
    await screen.findAllByTestId('pn-ref-item');
    const links = within(item(3)).getAllByTestId('sp-ext-link');
    expect(links.map((l) => l.textContent)).toEqual([expect.stringContaining('https://arxiv.org/abs/2301.00099'), expect.stringContaining('https://doi.org/10.1109/LRA.2023.1234567')]);
    fireEvent.click(within(links[1]!).getByTestId('sp-ext-open'));
    expect(within(links[1]!).getByTestId('sp-ext-confirm').textContent).toContain('doi.org');
  });

  it('panelFocus.referenceOrdinal highlights the item', async () => {
    show(2);
    await waitFor(() => expect(item(2).dataset.focused).toBe('1'));
    expect(item(1).dataset.focused).toBeUndefined();
  });

  it('a paper without structure: "구조 색인 없음"', () => {
    useReaderStore.setState({ paperState: { readable: true, contextReady: true, structureReady: false } });
    show();
    expect(screen.getByTestId('pn-no-structure').textContent).toContain('구조 색인 없음');
  });
});
