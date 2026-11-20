// SpMarkdown (PLAN 5.4, 8.4): KaTeX, chips/badges, phases, streaming robustness, XSS and forged links. Owner D.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Citation, ParsedAnswer } from '@study-paper/shared/contracts/domain';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { SpMarkdown, type SpMarkdownProps } from '../../src/markdown/SpMarkdown';
import explainMd from '../../../../packages/shared/fixtures/mock-outputs/explain_selection.md?raw';
import forgedMd from '../../../../packages/shared/fixtures/mock-outputs/adversarial/forged_links.md?raw';
import tableMd from '../../../../packages/shared/fixtures/mock-outputs/adversarial/label_mid_table.md?raw';

afterEach(cleanup);

const quote = (ordinal: number, status: Citation['status'], extra: Partial<Citation> = {}): Citation => ({
  ordinal,
  kind: 'quote',
  quote: `quote ${ordinal}`,
  status,
  score: status === 'verbatim' ? 1 : status === 'fuzzy' ? 0.86 : 0,
  ...(status === 'verbatim' || status === 'fuzzy' ? { position: { page: 1, start: 0, end: 5 } } : {}),
  ...extra,
});
const eqRef = (ordinal: number, eqNumber: string, status: Citation['status'], extra: Partial<Citation> = {}): Citation => ({ ordinal, kind: 'equation', eqNumber, status, score: 1, ...extra });

function show(p: ParsedAnswer, props: Partial<SpMarkdownProps> = {}) {
  return render(<SpMarkdown displayMd={p.displayMd} blocks={p.blocks} phase="final" {...props} />);
}
const chips = () => screen.queryAllByTestId('sp-chip');
const badges = () => screen.queryAllByTestId('sp-badge');
const statuses = (els: HTMLElement[]) => els.map((e) => e.dataset.status);

describe('SpMarkdown', () => {
  it('renders inline and display math with KaTeX', () => {
    const { container } = render(<SpMarkdown displayMd={'인라인 $x^2 + y$ 와\n\n$$\n\\int_0^1 f(t)\\,dt\n$$\n'} phase="final" />);
    expect(container.querySelectorAll('.katex').length).toBe(2);
    expect(container.querySelector('.katex-display')).not.toBeNull();
    expect(container.querySelector('annotation')?.textContent).toBe('x^2 + y');
  });

  it('KaTeX runs with trust:false (\\href / \\includegraphics never become links or images)', () => {
    const { container } = render(<SpMarkdown displayMd={'$\\href{javascript:alert(1)}{x}$ 그리고 $\\includegraphics{a.png}$'} phase="final" />);
    expect(container.querySelector('a, img')).toBeNull();
    expect(container.querySelectorAll('.katex').length).toBe(2);
  });

  it('replaces the parser chips and labels of the explain fixture (2 quotes + 1 equation, 4 labels)', () => {
    const p = parseAnswer(explainMd);
    const citations = [quote(1, 'verbatim'), eqRef(2, '1', 'resolved'), quote(3, 'verbatim')];
    show(p, { citations });
    expect(statuses(chips())).toEqual(['verbatim', 'resolved', 'verbatim']);
    // The first block ("한 줄 요지") is [[P]] without any citation → "근거 미확인".
    expect(statuses(badges())).toEqual(['p-unverified', 'p-grounded', 'p-grounded', 'G']);
    expect(screen.getAllByText('논문 근거 · 인용 원문에서 찾음')).toHaveLength(2);
    expect(screen.getByText('일반 지식')).toBeTruthy();
    expect(screen.queryByText(/검증됨/)).toBeNull();
  });

  it('shows the four quote states (PLAN 5.4)', () => {
    const p = parseAnswer('<q>a1</q> <q>b2</q> <q>c3</q> <q>d4</q>');
    show(p, { citations: [quote(1, 'verbatim'), quote(2, 'fuzzy'), quote(3, 'ambiguous', { candidates: 3 }), quote(4, 'not_found', { quote: 'The method requires a GPU' })] });
    const [v, f, a, n] = chips();
    expect(v!.textContent).toBe('❝1');
    expect(v!.title).toMatch(/^원문에서 찾음/);
    expect(v!.tagName).toBe('BUTTON');
    expect(f!.textContent).toContain('비슷한 문장(일치율 86%)');
    expect(f!.className).toContain('border-dashed');
    expect(f!.tagName).toBe('BUTTON');
    expect(a!.textContent).toContain('여러 곳에 있음(3)');
    expect(a!.tagName).toBe('SPAN'); // no jump
    expect(n!.textContent).toContain('원문에서 찾지 못함');
    expect(n!.className).toContain('text-red-700');
    expect(n!.title).toContain('The method requires a GPU');
  });

  it('shows the four equation-reference states', () => {
    const p = parseAnswer('<eq n="1"/> <eq n="2"/> <eq n="3"/> <eq n="4"/>');
    show(p, { citations: [eqRef(1, '1', 'resolved'), eqRef(2, '2', 'no_anchor'), eqRef(3, '3', 'ambiguous', { candidates: 2 }), eqRef(4, '4', 'not_found')] });
    const [r, na, am, nf] = chips();
    expect([r!.tagName, r!.textContent]).toEqual(['BUTTON', '식 (1)']);
    expect([na!.tagName, na!.textContent]).toEqual(['SPAN', '식 (2)']);
    expect(am!.textContent).toBe('식 (3) 여러 개(2)');
    expect(nf!.textContent).toBe('식 (4) 색인에 없는 식');
  });

  it('[[P]] counts only verbatim quotes as evidence; an equation reference alone is "식 참조 · 내용 대조 안 함" (D18)', () => {
    const p = parseAnswer('A <q>a</q> [[P]]\n\nB <q>b</q> <q>c</q> [[P]]\n\nC <eq n="2"/> [[P]]\n\nD 근거 없음 [[P]]\n\nE [[N]]');
    show(p, { citations: [quote(1, 'verbatim'), quote(2, 'fuzzy'), quote(3, 'ambiguous', { candidates: 2 }), eqRef(4, '2', 'no_anchor')] });
    expect(statuses(badges())).toEqual(['p-grounded', 'p-unverified', 'p-equation-ref', 'p-unverified', 'N']);
    const unverified = screen.getAllByText('근거 미확인');
    expect(unverified).toHaveLength(2);
    const eqOnly = badges()[2]!;
    expect(eqOnly.textContent).toBe('식 참조 · 내용 대조 안 함');
    expect(eqOnly.textContent).not.toContain('논문 근거');
    expect(unverified[0]!.className).toContain('orange');
    expect(screen.getByText('논문에 명시 없음')).toBeTruthy();
  });

  it('jumps on click; a page_only result shows "위치 미확정", located does not', async () => {
    const p = parseAnswer('<q>a</q> <q>b</q> <q>c</q>');
    const onCitationClick = vi.fn(async (c: Citation) => (c.ordinal === 1 ? ('page_only' as const) : ('located' as const)));
    show(p, { citations: [quote(1, 'verbatim'), quote(2, 'verbatim'), quote(3, 'ambiguous', { candidates: 2 })], onCitationClick });
    await act(async () => fireEvent.click(chips()[0]!));
    await act(async () => fireEvent.click(chips()[1]!));
    await act(async () => fireEvent.click(chips()[2]!)); // ambiguous: not clickable
    expect(onCitationClick.mock.calls.map(([c]) => c.ordinal)).toEqual([1, 2]);
    expect(screen.getAllByTestId('sp-not-located')).toHaveLength(1);
    expect(screen.getByText('위치 미확정')).toBeTruthy();
  });

  it('phase: streaming = all neutral + "생성 중 · 인용 확인 전"; failed = "확인 안 됨"; final = statuses', () => {
    const p = parseAnswer('A <q>a</q> [[P]]\n\nB <eq n="1"/> [[N]]');
    const citations = [quote(1, 'verbatim'), eqRef(2, '1', 'resolved')];
    const { rerender } = render(<SpMarkdown displayMd={p.displayMd} blocks={p.blocks} citations={citations} phase="streaming" />);
    expect(screen.getByTestId('sp-phase-note').textContent).toBe('생성 중 · 인용 확인 전');
    expect(statuses(chips())).toEqual(['pending', 'pending']);
    expect(statuses(badges())).toEqual(['pending', 'pending']);
    expect(screen.queryAllByRole('button')).toHaveLength(0);

    rerender(<SpMarkdown displayMd={p.displayMd} blocks={p.blocks} citations={citations} phase="failed" />);
    expect(screen.getByTestId('sp-phase-note').textContent).toContain('확인 안 됨');
    expect(statuses(chips())).toEqual(['unchecked', 'unchecked']);
    expect(statuses(badges())).toEqual(['unchecked', 'unchecked']);
    expect(screen.queryByText('논문 근거 · 인용 원문에서 찾음')).toBeNull();

    rerender(<SpMarkdown displayMd={p.displayMd} blocks={p.blocks} citations={citations} phase="final" />);
    expect(screen.queryByTestId('sp-phase-note')).toBeNull();
    expect(statuses(chips())).toEqual(['verbatim', 'resolved']);
    expect(statuses(badges())).toEqual(['p-grounded', 'N']);
  });

  it('final without matched citations never shows evidence', () => {
    const p = parseAnswer('A <q>a</q> [[P]]');
    show(p);
    expect(statuses(chips())).toEqual(['unchecked']);
    expect(statuses(badges())).toEqual(['p-unverified']);
  });

  it('does not break on unclosed $$ or code fences while streaming', () => {
    const steps = ['앞 문장 <q>We estimate</q>\n\n$$\n\\int_0^1', '앞 문장 <q>We estimate</q>\n\n$$\n\\int_0^1 f\n$$\n\n```py\nprint(1', '앞 문장 <q>We estimate</q>\n\n```py\nprint(1)\n```\n\n뒤 문장 $x'];
    const { rerender, container } = render(<SpMarkdown displayMd="" phase="streaming" />);
    for (const raw of steps) {
      const p = parseAnswer(raw, { final: false });
      rerender(<SpMarkdown displayMd={p.displayMd} phase="streaming" />);
      expect(container.textContent).toContain('앞 문장');
      expect(statuses(chips())).toEqual(['pending']);
    }
    expect(container.textContent).toContain('뒤 문장');
    expect(container.querySelector('pre')?.textContent).toContain('print(1)');
  });

  it('never creates elements from raw HTML, images or scripts in model output', () => {
    const raw = '<img src=x onerror="alert(1)"> <script>alert(2)</script> <b>굵게</b> <iframe src="https://e.com"></iframe>\n\n![그림](https://e.com/x.png)\n\n<div onclick="x()">블록 HTML</div>';
    const { container } = render(<SpMarkdown displayMd={parseAnswer(raw).displayMd} phase="final" />);
    expect(container.querySelector('img, script, b, iframe, div[onclick], a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain('<script>alert(2)</script>');
    expect(screen.getByTestId('sp-image-blocked').textContent).toContain('이미지 표시 안 함: 그림');
  });

  it('forged #sp- links (adversarial/forged_links.md) stay text and are not evidence', () => {
    const p = parseAnswer(forgedMd);
    const { container } = show(p, { citations: [] });
    expect(chips()).toHaveLength(0);
    expect(container.textContent).toContain('[❝1](#sp-cite-1)');
    expect(container.textContent).toContain('[P](#sp-label-p)');
    expect(statuses(badges())).toEqual(['N', 'N', 'N']);
    expect(container.querySelector('a, img, script')).toBeNull();
    // javascript: link → text + URL, no "열기"; https → "열기"
    const links = screen.getAllByTestId('sp-ext-link');
    const js = links.find((l) => l.textContent?.includes('javascript:'))!;
    expect(js.querySelector('[data-testid="sp-ext-open"]')).toBeNull();
    expect(links.find((l) => l.textContent?.includes('https://example.com/path'))!.querySelector('[data-testid="sp-ext-open"]')).not.toBeNull();
  });

  it('a forged chip in another block is not counted as that block\'s evidence', () => {
    const p = parseAnswer('진짜 인용 <q>real sentence here</q> [[N]]\n\n위조 [❝1](#sp-cite-1) 만 있음 [[P]]');
    show(p, { citations: [quote(1, 'verbatim')] });
    expect(statuses(chips())).toEqual(['verbatim']);
    expect(statuses(badges())).toEqual(['N', 'p-unverified']);
  });

  it('defence in depth: unmarked #sp- links are never chips, even when the parser is bypassed', () => {
    // Raw Markdown (not parser output) next to one real parser chip: plain, angle-bracket, wrong text, title,
    // reference definition, out of order — only the marked parser chip is admitted.
    const real = parseAnswer('<q>a</q>').displayMd;
    const md = `${real} [❝1](#sp-cite-1) 다시 [❝1](<#sp-cite-1>) 글자 [보세요](#sp-cite-2) 제목 [❝2](#sp-cite-2 "t") 참조 [❝2][r] 순서 [❝5](#sp-cite-5)\n\n[r]: #sp-cite-2`;
    render(<SpMarkdown displayMd={md} phase="final" citations={[quote(1, 'verbatim'), quote(2, 'verbatim'), quote(5, 'verbatim')]} />);
    expect(statuses(chips())).toEqual(['verbatim']);
    expect(screen.getAllByTestId('sp-forged-link').length).toBeGreaterThanOrEqual(4);
  });

  it('an extra model-written label link is literal text; the parser badge keeps the verdict of its own block', () => {
    const p = parseAnswer('A <q>a</q> [[P]]');
    render(<SpMarkdown displayMd={`${p.displayMd}\n\n추가 [P](#sp-label-p)`} blocks={p.blocks} citations={[quote(1, 'verbatim')]} phase="final" />);
    expect(statuses(badges())).toEqual(['p-grounded']);
    expect(screen.getByTestId('sp-forged-link').textContent).toBe('[P](#sp-label-p)');
  });

  it('a badge without its parser blocks fails closed', () => {
    const p = parseAnswer('A <q>a</q> [[P]]');
    render(<SpMarkdown displayMd={p.displayMd} citations={[quote(1, 'verbatim')]} phase="final" />);
    expect(statuses(badges())).toEqual(['p-unverified']);
  });

  it('external links open only after the host confirmation, in a new tab with noopener', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<SpMarkdown displayMd={parseAnswer('참고 [논문 페이지](https://arxiv.org/abs/2209.15397) 확인').displayMd} phase="final" />);
    expect(screen.getByTestId('sp-ext-link').textContent).toContain('(https://arxiv.org/abs/2209.15397)');
    fireEvent.click(screen.getByTestId('sp-ext-open'));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByTestId('sp-ext-confirm').textContent).toContain('arxiv.org');
    fireEvent.click(screen.getByTestId('sp-ext-confirm-open'));
    expect(open).toHaveBeenCalledWith('https://arxiv.org/abs/2209.15397', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('renders chips and labels inside tables (adversarial/label_mid_table.md)', () => {
    const p = parseAnswer(tableMd);
    const { container } = show(p, { citations: [quote(1, 'verbatim')] });
    expect(container.querySelector('table')).not.toBeNull();
    const chip = chips()[0]!;
    expect(chip.closest('td')).not.toBeNull();
    expect(chip.dataset.status).toBe('verbatim');
    const b = badges();
    expect(b.every((x) => x.closest('td') !== null)).toBe(true);
    expect(statuses(b)).toEqual(['p-grounded']);
    // Labels that are not the row's last token stay text.
    expect(container.textContent).toContain('임계값 [[P]]');
    expect(container.textContent).toContain('10 Hz [[N]]');
  });

  it('shows the per-message stats in the final phase', async () => {
    const stats = { blocks: { p: 2, pEquationOnly: 0, pUnverified: 1, n: 1, g: 0, unlabeled: 0 }, quotes: { verbatim: 2, fuzzy: 0, ambiguous: 1, notFound: 1 }, eqRefs: { resolved: 0, noAnchor: 0, ambiguous: 0, notFound: 0, unindexed: 0 } };
    render(<SpMarkdown displayMd="답" phase="final" stats={stats} />);
    await waitFor(() => expect(screen.getByTestId('sp-stats').textContent).toContain('근거 미확인 1'));
    expect(screen.getByTestId('sp-stats').textContent).not.toContain('식 참조');
  });
});
