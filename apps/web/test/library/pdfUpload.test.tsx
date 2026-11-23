import type { ReactElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIMITS } from '@study-paper/shared/contracts/api';
import { createAppQueryClient } from '../../src/api/queryClient';
import { qk } from '../../src/api/queryKeys';
import { PdfUpload } from '../../src/library/PdfUpload';
import { UploadPaperTitle } from '../../src/library/UploadPaperTitle';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(node: ReactElement = <PdfUpload />) {
  const qc = createAppQueryClient();
  qc.setQueryData(qk.papers, { papers: [] });
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  return qc;
}
function drop(...files: File[]) {
  fireEvent.drop(screen.getByTestId('rd-upload-drop'), { dataTransfer: { files } });
}
const ok = (existing: boolean) => Response.json({ paperId: 'paper-1', jobId: null, existing });

it('sends the selected PDF as raw bytes with its URI-encoded filename and refreshes the Library after storage', async () => {
  const fetch = vi.fn().mockResolvedValue(ok(false));
  vi.stubGlobal('fetch', fetch);
  const qc = mount();
  const file = new File(['%PDF-1.7\n'], '논문 1.PDF', { type: 'application/pdf' });
  const picker = screen.getByTestId('rd-upload-file');
  const open = vi.spyOn(picker, 'click');
  fireEvent.click(screen.getByRole('button', { name: 'PDF 올리기' }));
  expect(open).toHaveBeenCalledOnce();
  fireEvent.change(picker, { target: { files: [file] } });
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(await screen.findByText(/PDF를 저장했습니다/)).toBeTruthy();
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/papers/upload', expect.objectContaining({
    method: 'POST', body: file, headers: expect.objectContaining({
      'Content-Type': 'application/pdf', 'X-SP-Filename': encodeURIComponent(file.name),
    }),
  }));
  expect(qc.getQueryState(qk.papers)?.isInvalidated).toBe(true);
});

it('accepts drops and prevents a second request while the first upload is being processed', async () => {
  let finish!: (res: Response) => void;
  const fetch = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal('fetch', fetch);
  mount();
  const file = new File(['%PDF-1.7\n'], 'one.pdf');
  drop(file);
  drop(file);
  await screen.findByText(/목차를 확인하고 있습니다/);
  expect((screen.getByTestId('rd-upload-button') as HTMLButtonElement).disabled).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { finish(ok(true)); });
  expect(await screen.findByText('이미 Library에 있는 PDF입니다.')).toBeTruthy();
});

it('rejects non-PDF, empty, oversized and multi-file drops before making any request', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  mount();
  const empty = new File([], 'empty.pdf');
  const oversized = new File(['x'], 'large.pdf');
  Object.defineProperty(oversized, 'size', { value: LIMITS.uploadBytes + 1 });
  drop(new File(['%PDF-1.7'], 'wrong.txt'));
  expect(screen.getByRole('alert').textContent).toContain('확장자');
  drop(empty);
  expect(screen.getByRole('alert').textContent).toContain('비어 있습니다');
  drop(oversized);
  expect(screen.getByRole('alert').textContent).toContain('50 MiB');
  drop(empty, oversized);
  expect(screen.getByRole('alert').textContent).toContain('하나씩');
  expect(fetch).not.toHaveBeenCalled();
});

it('shows the server rejection and allows the same filename to be reselected', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: { code: 'validation', message: 'invalid_pdf' } }, { status: 400 }))
    .mockResolvedValueOnce(ok(false));
  vi.stubGlobal('fetch', fetch);
  mount();
  const bad = new File(['not a PDF'], 'paper.pdf');
  fireEvent.change(screen.getByTestId('rd-upload-file'), { target: { files: [bad] } });
  expect((await screen.findByRole('alert')).textContent).toContain('PDF를 열 수 없습니다');
  fireEvent.change(screen.getByTestId('rd-upload-file'), { target: { files: [new File(['%PDF-1.7'], bad.name)] } });
  expect(await screen.findByText(/PDF를 저장했습니다/)).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('preserves a title draft on server failure, rejects a blank title and cancels with Escape', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ error: { code: 'internal', message: 'failure' } }, { status: 500 }));
  vi.stubGlobal('fetch', fetch);
  mount(<UploadPaperTitle id="paper-1" title="원래 제목" />);
  fireEvent.click(screen.getByTestId('rd-upload-title-edit'));
  const input = screen.getByLabelText('PDF 제목') as HTMLInputElement;
  expect(input.value).toBe('원래 제목');
  fireEvent.change(input, { target: { value: ' ' } });
  expect((screen.getByTestId('rd-upload-title-save') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: ' 새 제목 ' } });
  fireEvent.click(screen.getByTestId('rd-upload-title-save'));
  expect((await screen.findByRole('alert')).textContent).toContain('제목을 저장하지 못했습니다');
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/papers/paper-1', expect.objectContaining({
    method: 'PATCH', body: JSON.stringify({ title: '새 제목' }),
  }));
  expect(input.value).toBe(' 새 제목 ');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByLabelText('PDF 제목')).toBeNull();
  fireEvent.click(screen.getByTestId('rd-upload-title-edit'));
  expect((screen.getByLabelText('PDF 제목') as HTMLInputElement).value).toBe('원래 제목');
});
