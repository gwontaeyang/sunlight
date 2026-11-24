import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ReferenceCandidate, ReferenceDto } from '@study-paper/shared/contracts/api';
import { ReferencesTab } from '../../src/panel/ReferencesTab';
import { useReaderStore } from '../../src/state/readerStore';
import { PAPER, renderWithApi, resetReader } from './panelHarness';
import type { JsonHandler, JsonReply } from './sseFake';
import { LINKS_PAPER, structureFixture } from './structureFixture';

const find = '/api/references/find';
const arxiv: ReferenceCandidate = {
  source: 'arxiv', title: 'Scan Alignment', authors: ['Author A'], year: 2024, arxivId: '2401.00011v1',
  absUrl: 'https://arxiv.org/abs/2401.00011v1', pdfUrl: 'https://arxiv.org/pdf/2401.00011v1', doi: null,
  score: 1, inLibraryPaperId: null,
};
const journal: ReferenceCandidate = {
  source: 'crossref', title: 'Grid Alignment', authors: [], year: null, arxivId: null, doi: '10.5555/grid',
  absUrl: 'https://doi.org/10.5555/grid', pdfUrl: null, score: 0.6, inLibraryPaperId: null,
};
const success = (candidates: ReferenceCandidate[], unavailable: string[] = []): JsonReply => ({ status: 200, json: { candidates, unavailable } });

function show(findReply: JsonHandler, citation: Partial<ReferenceDto> = {}) {
  const structure = structureFixture();
  Object.assign(structure.references[0]!, citation);
  const { server } = renderWithApi(<ReferencesTab paperId={PAPER} />, call => {
    if (call.url === `/api/papers/${PAPER}/structure`) return { status: 200, json: structure };
    if (call.url === find) return findReply(call);
    if (call.url === '/api/papers/import') return { status: 200, json: { paperId: LINKS_PAPER, jobId: 'job-1', existing: false } };
  });
  return server;
}

beforeEach(() => {
  resetReader(true);
  useReaderStore.setState({ paperState: { readable: true, contextReady: true, structureReady: true } });
});
afterEach(cleanup);

it('searches once on the first click for an unparsed citation and lets the reader refine the query', async () => {
  const original = 'A. Author. A paper without an identifier. 2020.';
  const server = show(() => success([]));
  const button = await screen.findByTestId('pn-ref-find');
  expect(screen.getAllByTestId('pn-ref-find')).toHaveLength(1);
  expect(server.calls.filter(c => c.url === find)).toHaveLength(0);
  fireEvent.click(button);
  await screen.findByTestId('pn-ref-find-empty');
  const query = screen.getByTestId('pn-ref-query') as HTMLInputElement;
  expect(query.value).toBe(original);
  expect(server.calls.filter(c => c.url === find)).toEqual([{ method: 'POST', url: find, body: { title: original } }]);
  fireEvent.change(query, { target: { value: '  Scan Alignment  ' } });
  fireEvent.click(screen.getByTestId('pn-ref-search'));
  await screen.findByTestId('pn-ref-find-empty');
  expect(server.calls.filter(c => c.url === find).map(c => c.body?.title)).toEqual([original, 'Scan Alignment']);
});

it.each(['“A quoted title,”', '"A quoted title"'])('uses the quoted title in a raw bibliography entry (%s)', async quote => {
  const server = show(() => success([]), { rawText: `Author A, ${quote} Journal, 2024.` });
  fireEvent.click(await screen.findByTestId('pn-ref-find'));
  await screen.findByTestId('pn-ref-find-empty');
  expect((screen.getByTestId('pn-ref-query') as HTMLInputElement).value).toBe('A quoted title');
  expect(server.calls.filter(c => c.url === find).map(c => c.body?.title)).toEqual(['A quoted title']);
});

it('sends indexed metadata, distinguishes DOI-only, open PDF and Library matches, and confirms arXiv import separately', async () => {
  const server = show(() => success([arxiv, journal, {
    ...journal, doi: '10.5555/open', title: 'Open Grid Alignment',
    pdfUrl: 'https://journal.example/paper.pdf', inLibraryPaperId: LINKS_PAPER,
  }]), { title: 'Scan Alignment', authors: ['Author A'], year: 2024 });
  fireEvent.click(await screen.findByTestId('pn-ref-find'));
  const [first, closed, open] = (await screen.findAllByTestId('pn-ref-candidate')).map(row => within(row));
  expect(server.calls.find(c => c.url === find)?.body).toEqual({ title: 'Scan Alignment', authors: ['Author A'], year: 2024 });
  expect(first!.getByTestId('pn-ref-candidate-source').textContent).toBe('arXiv');
  expect(first!.getByText('Author A · 2024')).toBeTruthy();
  expect(first!.getAllByTestId('sp-ext-link').map(link => link.textContent)).toEqual([
    expect.stringContaining('https://arxiv.org/abs/2401.00011v1'), expect.stringContaining('https://arxiv.org/pdf/2401.00011v1'),
  ]);
  expect(closed!.queryByTestId('pn-ref-import')).toBeNull();
  expect(closed!.getAllByTestId('sp-ext-link')).toHaveLength(1);
  expect(closed!.getByText(/공개 PDF 링크를 확인하지 못했습니다/)).toBeTruthy();
  expect(open!.queryByTestId('pn-ref-import')).toBeNull();
  expect(open!.getByTestId('pn-ref-in-library')).toBeTruthy();
  const pdf = open!.getAllByTestId('sp-ext-link').find(link => link.textContent?.includes('PDF 받기'))!;
  fireEvent.click(within(pdf).getByTestId('sp-ext-open'));
  expect(within(pdf).getByTestId('sp-ext-confirm').textContent).toContain('journal.example');
  expect(server.calls.filter(c => c.url === '/api/papers/import')).toHaveLength(0);
  fireEvent.click(first!.getByTestId('pn-ref-import'));
  expect(server.calls.filter(c => c.url === '/api/papers/import')).toHaveLength(0);
  fireEvent.click(first!.getByTestId('pn-ref-import-go'));
  expect((await first!.findByTestId('pn-ref-import-result')).textContent).toContain('가져오기를 시작했습니다');
  expect(server.calls.filter(c => c.url === '/api/papers/import').map(c => c.body?.input)).toEqual(['2401.00011v1']);
});

it('explains offline mode and keeps one provider’s results when the other is unavailable', async () => {
  let off = true;
  const server = show(() => off ? {
    status: 503, json: { error: { code: 'reference_search_unavailable', message: 'private upstream diagnostic', details: { reason: 'network_off' } } },
  } : success([journal], ['arxiv']), { title: 'Grid Alignment' });
  fireEvent.click(await screen.findByTestId('pn-ref-find'));
  expect((await screen.findByRole('alert')).textContent).toContain('외부 네트워크가 꺼져');
  expect(screen.queryByText(/private upstream diagnostic/)).toBeNull();
  off = false;
  fireEvent.click(screen.getByTestId('pn-ref-search'));
  expect((await screen.findByTestId('pn-ref-find-partial')).textContent).toContain('arXiv');
  expect(screen.getByTestId('pn-ref-candidate').textContent).toContain('Crossref');
  expect(server.calls.filter(c => c.url === find)).toHaveLength(2);
});

it('aborts a closed search and ignores a late reply after the next search', async () => {
  let resolve!: (reply: JsonReply) => void;
  let count = 0;
  const server = show(() => ++count === 1 ? new Promise<JsonReply>(r => { resolve = r; }) : success([journal]), { title: 'Grid Alignment' });
  fireEvent.click(await screen.findByTestId('pn-ref-find'));
  await waitFor(() => expect(count).toBe(1));
  const original = server.fetchFn.mock.calls.find(([url]) => url === find)![1]!.signal!;
  expect(original.aborted).toBe(false);
  fireEvent.click(screen.getByTestId('pn-ref-find-close'));
  expect(original.aborted).toBe(true);
  fireEvent.click(screen.getByTestId('pn-ref-find'));
  await screen.findByTestId('pn-ref-candidate');
  await act(async () => resolve(success([arxiv])));
  expect(screen.getByTestId('pn-ref-candidate').textContent).toContain('Grid Alignment');
  expect(screen.queryByText('Scan Alignment')).toBeNull();
});
