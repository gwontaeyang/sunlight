// Vendored PdfLoader (review M10): a new document never shows the previous error, progress or document.
import { StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTask {
  source: unknown;
  promise: Promise<unknown>;
  resolve(doc: unknown): void;
  reject(e: Error): void;
  destroy: ReturnType<typeof vi.fn>;
  onProgress: ((p: { loaded: number; total: number }) => void) | null;
}
const tasks: FakeTask[] = [];

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: (source: unknown) => {
    let resolve!: (d: unknown) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    const task: FakeTask = { source, promise, resolve, reject, destroy: vi.fn(), onProgress: null };
    tasks.push(task);
    return task;
  },
}));

const { PdfLoader } = await import('../../src/vendor/pdf-highlighter/components/PdfLoader');

const docA = { url: 'a' };
const docB = { url: 'b' };
const pdf = (name: string) => ({ numPages: 1, name });

function Loader({ source }: { source: object }) {
  return (
    <PdfLoader
      document={source}
      workerSrc="/worker.js"
      onError={() => {}}
      errorMessage={(e) => <div data-testid="error">{e.message}</div>}
      beforeLoad={(p) => <div data-testid="progress">{p.loaded}</div>}
    >
      {(doc) => <div data-testid="doc">{(doc as unknown as { name: string }).name}</div>}
    </PdfLoader>
  );
}

beforeEach(() => {
  tasks.length = 0;
});
afterEach(cleanup);

describe('PdfLoader', () => {
  it('failure → success on a new document: the previous error is gone', async () => {
    const { rerender } = render(<Loader source={docA} />);
    await act(async () => tasks[0]!.reject(new Error('HTTP 500')));
    expect(screen.getByTestId('error').textContent).toBe('HTTP 500');

    rerender(<Loader source={docB} />);
    expect(screen.queryByTestId('error')).toBeNull(); // not shown while B loads
    expect(tasks[0]!.destroy).toHaveBeenCalled();
    await act(async () => tasks[1]!.resolve(pdf('B')));
    expect(screen.getByTestId('doc').textContent).toBe('B');
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('progress of the previous document is not shown for the next one', async () => {
    const { rerender } = render(<Loader source={docA} />);
    await act(async () => tasks[0]!.onProgress!({ loaded: 5, total: 10 }));
    expect(screen.getByTestId('progress').textContent).toBe('5');
    rerender(<Loader source={docB} />);
    expect(screen.queryByTestId('progress')).toBeNull();
  });

  it('fast change A → B: a late result of A is ignored', async () => {
    const { rerender } = render(<Loader source={docA} />);
    rerender(<Loader source={docB} />);
    await act(async () => tasks[1]!.resolve(pdf('B')));
    await act(async () => tasks[0]!.resolve(pdf('A')));
    await act(async () => tasks[0]!.reject(new Error('late A error')));
    expect(screen.getByTestId('doc').textContent).toBe('B');
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('a late error of a superseded load does not replace the new document', async () => {
    const { rerender } = render(<Loader source={docA} />);
    rerender(<Loader source={docB} />);
    await act(async () => tasks[0]!.reject(new Error('A failed late')));
    await act(async () => tasks[1]!.resolve(pdf('B')));
    expect(screen.getByTestId('doc').textContent).toBe('B');
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('StrictMode double effect: the first task is destroyed and its result ignored, the second renders', async () => {
    render(
      <StrictMode>
        <Loader source={docA} />
      </StrictMode>,
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.destroy).toHaveBeenCalled();
    await act(async () => tasks[0]!.reject(new Error('Worker was destroyed')));
    expect(screen.queryByTestId('error')).toBeNull();
    await act(async () => tasks[1]!.resolve(pdf('A2')));
    expect(screen.getByTestId('doc').textContent).toBe('A2');
  });

  it('back to a document that failed before starts a fresh load (no stale error)', async () => {
    const { rerender } = render(<Loader source={docA} />);
    await act(async () => tasks[0]!.reject(new Error('A failed')));
    rerender(<Loader source={docB} />);
    await act(async () => tasks[1]!.resolve(pdf('B')));
    rerender(<Loader source={docA} />);
    expect(screen.queryByTestId('error')).toBeNull();
    expect(tasks).toHaveLength(3);
    await act(async () => tasks[2]!.resolve(pdf('A-ok')));
    expect(screen.getByTestId('doc').textContent).toBe('A-ok');
  });
});
