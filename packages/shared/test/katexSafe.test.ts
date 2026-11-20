// renderLatexSafe (BRIEF_S S5, PLAN_M2 D21). Owner: supervisor. Uses the katex of the server/web workspaces.
import katex from 'katex';
import { describe, expect, it, vi } from 'vitest';
import { renderLatexSafe, type KatexRenderToString } from '../src/latex/katexSafe';

const render = katex.renderToString as unknown as KatexRenderToString;

describe('renderLatexSafe', () => {
  it('plain LaTeX renders; options are the fixed set', () => {
    const spy = vi.fn(render);
    const r = renderLatexSafe(spy, 'r_{i}=R\\,p_{i}+t-q_{i}', { displayMode: true });
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toEqual({ throwOnError: true, strict: 'ignore', trust: false, maxExpand: 1000, displayMode: true, macros: {} });
  });

  it('one undefined command (\\Tr) → one retry with \\operatorname → ok', () => {
    const spy = vi.fn(render);
    const r = renderLatexSafe(spy, '\\Tr(\\mathbf{P})', { displayMode: false });
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![1]).toMatchObject({ macros: { '\\Tr': '\\operatorname{Tr}' } });
    if (r.ok) expect(r.html).toContain('Tr');
  });

  it('two different undefined commands → false (one retry only)', () => {
    const spy = vi.fn(render);
    expect(renderLatexSafe(spy, '\\undefinedmacro{x}+\\undefinedmacrotwo{y}', { displayMode: true })).toEqual({ ok: false });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a recursive \\def ends (maxExpand) with false', () => {
    const t0 = Date.now();
    expect(renderLatexSafe(render, '\\def\\a{\\a}\\a', { displayMode: true })).toEqual({ ok: false });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('trust stays off and other errors are false; the input string is not changed', () => {
    const input = '\\href{javascript:alert(1)}{x}';
    const copy = `${input}`;
    const r = renderLatexSafe(render, input, { displayMode: false });
    if (r.ok) expect(r.html).not.toMatch(/href="javascript/); // shown as text, never a link
    expect(input).toBe(copy);
    expect(renderLatexSafe(render, '\\frac{1}{', { displayMode: true })).toEqual({ ok: false });
  });

  it('a \\def in one formula does not leak into the next call', () => {
    expect(renderLatexSafe(render, '\\def\\foo{x}\\foo', { displayMode: true }).ok).toBe(true);
    const spy = vi.fn(render);
    renderLatexSafe(spy, '\\foo', { displayMode: true });
    expect(spy.mock.calls[0]![1]).toMatchObject({ macros: {} });
  });
});
