// Equation reference chip (PLAN_M2 3.3, BRIEF_D D3): 5 states, resolved click → readerStore.jumpToEquation + popover
// (KaTeX through renderLatexSafe, "LaTeX 복사" = the server's latex, "깊이 읽기"), katexOk=false → code, \Tr renders,
// unindexed + "색인에서 찾기" only when the current structure has exactly one equation with that number. Owner D.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EquationDto, StructureResponse } from '@study-paper/shared/contracts/api';
import type { Citation } from '@study-paper/shared/contracts/domain';
import { StructureContext } from '../../src/markdown/chips';
import { pairStored, StoredMarkup } from '../../src/markdown/renderStored';
import { useReaderStore, type JumpResult } from '../../src/state/readerStore';

afterEach(cleanup);

const LATEX = '\\Tr(\\mathbf{R}) = 1 + 2\\cos\\theta';
const eqc = (ordinal: number, n: string, status: Citation['status'], extra: Partial<Citation> = {}): Citation => ({ ordinal, kind: 'equation', eqNumber: n, status, score: 1, ...extra });

const equation = (id: string, number: string | null): EquationDto => ({ id, sectionId: null, htmlId: null, number, ordinal: 1, latexRaw: 'x', latex: 'x', katexOk: true, pdfPage: 2, pdfOffset: 10, pdfRect: null });
const structure = (equations: EquationDto[]): StructureResponse => ({ structureSource: 'latexml', sections: [], equations, figures: [], references: [] });

function show(raw: string, citations: Citation[], s?: StructureResponse) {
  return render(
    <StructureContext.Provider value={s}>
      <StoredMarkup {...pairStored(raw, citations)} />
    </StructureContext.Provider>,
  );
}
const chip = () => screen.getByTestId('sp-chip');

let jumpToEquation: ReturnType<typeof vi.fn<(id: string) => Promise<JumpResult>>>;
let requestAction: ReturnType<typeof vi.fn<(a: unknown) => void>>;
beforeEach(() => {
  jumpToEquation = vi.fn(async () => 'located' as JumpResult);
  requestAction = vi.fn<(a: unknown) => void>();
  useReaderStore.setState({ jumpToEquation, requestAction });
});

describe('EqRefChip', () => {
  it('shows the five states', () => {
    show('<eq n="1"/> <eq n="2"/> <eq n="3"/> <eq n="4"/> <eq n="5"/>', [
      eqc(1, '1', 'resolved', { equationId: 'e1', latex: LATEX, katexOk: true }),
      eqc(2, '2', 'no_anchor', { equationId: 'e2', latex: 'x^2', katexOk: true }),
      eqc(3, '3', 'ambiguous', { candidates: 2, eqCandidates: [{ equationId: 'a', sectionNumber: 'II-A', pdfPage: 2 }, { equationId: 'b', sectionNumber: null, pdfPage: null }] }),
      eqc(4, '4', 'not_found'),
      eqc(5, '5', 'unindexed'),
    ]);
    const chips = screen.getAllByTestId('sp-chip');
    expect(chips.map((c) => c.dataset.status)).toEqual(['resolved', 'no_anchor', 'ambiguous', 'not_found', 'unindexed']);
    expect(chips.map((c) => c.textContent)).toEqual(['식 (1)', '식 (2)', '식 (3) 여러 개(2)', '식 (4) 색인에 없는 식', '식 (5)']);
    expect(chips[3]!.className).toContain('text-red-700');
    expect(screen.queryByTestId('pn-eq-find-index')).toBeNull(); // no structure → no "색인에서 찾기"
  });

  it.each([
    ['located', null],
    ['page_only', '위치 미확정'],
    ['no_anchor', 'PDF 위치 없음'],
  ] as const)('resolved click → jumpToEquation(id) + popover; result %s', async (result, note) => {
    jumpToEquation.mockResolvedValue(result);
    show('<eq n="1"/>', [eqc(1, '1', 'resolved', { equationId: 'e1', latex: LATEX, katexOk: true })]);
    await act(async () => fireEvent.click(chip()));
    expect(jumpToEquation).toHaveBeenCalledWith('e1');
    const pop = screen.getByTestId('pn-eq-popover');
    expect(pop.querySelector('.katex')).not.toBeNull(); // \Tr is drawn (renderLatexSafe's \operatorname fallback)
    expect(screen.queryByTestId('pn-latex-code')).toBeNull();
    if (note) expect(screen.getByText(note)).toBeTruthy();
    else expect(screen.queryByText('위치 미확정') ?? screen.queryByText('PDF 위치 없음')).toBeNull();
  });

  it('"LaTeX 복사" copies the server latex (not the display fallback); "깊이 읽기" requests an equation action', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    show('<eq n="1"/>', [eqc(1, '1', 'resolved', { equationId: 'e1', latex: LATEX, katexOk: true })]);
    await act(async () => fireEvent.click(chip()));
    await act(async () => fireEvent.click(screen.getByTestId('pn-eq-copy')));
    expect(writeText).toHaveBeenCalledWith(LATEX);
    expect(screen.getByTestId('pn-eq-copy').textContent).toBe('복사함');
    fireEvent.click(screen.getByTestId('pn-eq-deep'));
    expect(requestAction).toHaveBeenCalledWith({ kind: 'equation', equationId: 'e1' });
  });

  it('katexOk=false shows the LaTeX source as code', async () => {
    show('<eq n="4"/>', [eqc(1, '4', 'no_anchor', { equationId: 'e4', latex: '\\undefinedmacro{x} + \\undefinedmacrotwo', katexOk: false })]);
    await act(async () => fireEvent.click(chip()));
    expect(screen.getByTestId('pn-latex-code').textContent).toBe('\\undefinedmacro{x} + \\undefinedmacrotwo');
    expect(screen.getByTestId('pn-eq-popover').querySelector('.katex')).toBeNull();
    expect(jumpToEquation).not.toHaveBeenCalled(); // no_anchor: popover only
  });

  it('a resolved reference without latex (cut beyond 4,000 chars) offers the number and the jump only', async () => {
    show('<eq n="7"/>', [eqc(1, '7', 'resolved', { equationId: 'e7', katexOk: true })]);
    await act(async () => fireEvent.click(chip()));
    expect(jumpToEquation).toHaveBeenCalledWith('e7');
    expect(screen.queryByTestId('pn-eq-popover')).toBeNull();
  });

  it('ambiguous: the candidate list (section number · page) jumps to the clicked candidate', async () => {
    show('<eq n="3"/>', [eqc(1, '3', 'ambiguous', { candidates: 2, eqCandidates: [{ equationId: 'a', sectionNumber: 'II-A', pdfPage: 2 }, { equationId: 'b', sectionNumber: null, pdfPage: null }] })]);
    fireEvent.click(chip());
    const items = screen.getAllByTestId('pn-eq-candidate');
    expect(items.map((i) => i.textContent)).toEqual(['II-A절 · p. 2', '절 미상 · page 미상']);
    await act(async () => fireEvent.click(items[1]!));
    expect(jumpToEquation).toHaveBeenCalledWith('b');
  });

  it.each([
    [[equation('only', '5')], true],
    [[], false],
    [[equation('x1', '5'), equation('x2', '(5)')], false],
  ] as const)('unindexed + structure %#: "색인에서 찾기" only when exactly one equation has the number', async (eqs, offered) => {
    show('<eq n="5"/>', [eqc(1, '5', 'unindexed')], structure([...eqs, equation('other', '6')]));
    expect(chip().dataset.status).toBe('unindexed');
    const find = screen.queryByTestId('pn-eq-find-index');
    expect(find !== null).toBe(offered);
    if (find) {
      await act(async () => fireEvent.click(find));
      expect(jumpToEquation).toHaveBeenCalledWith('only');
      expect(chip().dataset.status).toBe('unindexed'); // the state never changes
    }
  });
});
