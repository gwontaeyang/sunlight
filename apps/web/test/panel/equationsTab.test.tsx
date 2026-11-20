// Equations tab (BRIEF_D D5): numbered list with section numbers, unnumbered folded, KaTeX / code, jump → result
// note, LaTeX copy of the stored latex, "깊이 읽기", structure-less notice. Owner D.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EquationsTab } from '../../src/panel/EquationsTab';
import { useReaderStore, type JumpResult } from '../../src/state/readerStore';
import { PAPER, renderWithApi, resetReader } from './panelHarness';
import { structureFixture } from './structureFixture';

/** IntersectionObserver stand-in: `visible` decides whether observed rows are reported in view. */
let visible = true;
class FakeIO {
  constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
  observe() {
    if (visible) queueMicrotask(() => this.cb([{ isIntersecting: true }]));
  }
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', FakeIO);

afterEach(() => {
  cleanup();
  visible = true;
});
let jumpToEquation: ReturnType<typeof vi.fn<(id: string) => Promise<JumpResult>>>;
let requestAction: ReturnType<typeof vi.fn<(a: unknown) => void>>;
beforeEach(() => {
  resetReader(true);
  jumpToEquation = vi.fn(async () => 'located' as JumpResult);
  requestAction = vi.fn<(a: unknown) => void>();
  useReaderStore.setState({ paperState: { readable: true, contextReady: true, structureReady: true }, jumpToEquation, requestAction });
});

const api = () => renderWithApi(<EquationsTab paperId={PAPER} />, (c) => (c.url === `/api/papers/${PAPER}/structure` ? { status: 200, json: structureFixture() } : undefined));

describe('EquationsTab', () => {
  it('numbered equations with their section, unnumbered folded; KaTeX, \\Tr drawn, katexOk=false as code', async () => {
    api();
    const items = await screen.findAllByTestId('pn-eq-item');
    await waitFor(() => expect(items[1]!.querySelector('.katex')).not.toBeNull());
    const list = screen.getByTestId('pn-eq-list');
    const numbered = within(list).getAllByTestId('pn-eq-item');
    expect(numbered.map((i) => i.dataset.equationId)).toEqual(['E1', 'E2', 'E4']);
    expect(numbered[0]!.textContent).toContain('(1)');
    expect(numbered[0]!.textContent).toContain('I절');
    expect(numbered[1]!.textContent).toContain('II절');
    expect(numbered[1]!.querySelector('.katex')).not.toBeNull(); // \Tr via renderLatexSafe
    expect(within(numbered[2]!).getByTestId('pn-latex-code').textContent).toBe('\\undefinedmacro{x} + \\undefinedmacrotwo');
    expect(screen.getByTestId('pn-eq-unnumbered').querySelector('summary')!.textContent).toBe('번호 없는 식 2개');
    expect(items).toHaveLength(5);
  });

  it('KaTeX is rendered only for rows in view (IntersectionObserver)', async () => {
    visible = false;
    api();
    const items = await screen.findAllByTestId('pn-eq-item');
    await act(async () => {});
    expect(items.every((i) => i.querySelector('.katex, [data-testid="pn-latex-code"]') === null)).toBe(true);
  });

  it('a click jumps (jumpToEquation); located → no note, no_anchor → "PDF 위치 없음"', async () => {
    api();
    const items = await screen.findAllByTestId('pn-eq-item');
    await act(async () => fireEvent.click(within(items[0]!).getByTestId('pn-eq-jump')));
    expect(jumpToEquation).toHaveBeenCalledWith('E1');
    expect(within(items[0]!).queryByText('PDF 위치 없음')).toBeNull();
    jumpToEquation.mockResolvedValueOnce('no_anchor');
    const e4 = items.find((i) => i.dataset.equationId === 'E4')!;
    await act(async () => fireEvent.click(within(e4).getByTestId('pn-eq-jump')));
    expect(jumpToEquation).toHaveBeenLastCalledWith('E4');
    expect(within(e4).getByText('PDF 위치 없음')).toBeTruthy();
  });

  it('LaTeX copy gives the stored latex; "깊이 읽기" requests an equation action', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    api();
    const e2 = (await screen.findAllByTestId('pn-eq-item')).find((i) => i.dataset.equationId === 'E2')!;
    await act(async () => fireEvent.click(within(e2).getByTestId('pn-eq-copy')));
    expect(writeText).toHaveBeenCalledWith('\\Tr(\\mathbf{R}) = 1 + 2\\cos\\theta');
    fireEvent.click(within(e2).getByTestId('pn-eq-deep'));
    expect(requestAction).toHaveBeenCalledWith({ kind: 'equation', equationId: 'E2' });
  });

  it('unnumbered rows have no "깊이 읽기" (the server reads only numbered equations in depth — review D-R3-03)', async () => {
    api();
    const items = await screen.findAllByTestId('pn-eq-item');
    const deep = (id: string) => within(items.find((i) => i.dataset.equationId === id)!).queryByTestId('pn-eq-deep');
    expect(['E1', 'E2', 'E4'].map((id) => deep(id) !== null)).toEqual([true, true, true]);
    expect(['E3', 'E5'].map((id) => deep(id))).toEqual([null, null]);
    // copy and jump stay; the fold says how to read such an equation instead
    const e3 = items.find((i) => i.dataset.equationId === 'E3')!;
    expect(within(e3).getByTestId('pn-eq-copy')).toBeTruthy();
    expect(within(e3).getByTestId('pn-eq-jump')).toBeTruthy();
    expect(screen.getByTestId('pn-eq-unnumbered-note').textContent).toContain('영역');
  });

  it('a focused equation is highlighted (unnumbered: the fold opens)', async () => {
    renderWithApi(<EquationsTab paperId={PAPER} focusEquationId="E5" />, (c) => (c.url === `/api/papers/${PAPER}/structure` ? { status: 200, json: structureFixture() } : undefined));
    await waitFor(() => expect(screen.getAllByTestId('pn-eq-item').find((i) => i.dataset.equationId === 'E5')!.dataset.focused).toBe('1'));
    expect((screen.getByTestId('pn-eq-unnumbered') as HTMLDetailsElement).open).toBe(true);
  });

  it('a paper without structure: "구조 색인 없음" and no request', () => {
    useReaderStore.setState({ paperState: { readable: true, contextReady: true, structureReady: false } });
    const { server } = api();
    expect(screen.getByTestId('pn-no-structure').textContent).toContain('구조 색인 없음');
    expect(screen.getByTestId('pn-no-structure').textContent).toContain('Library');
    expect(server.calls).toHaveLength(0);
  });
});
