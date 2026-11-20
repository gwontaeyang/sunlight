// LaTeX normalization of LaTeXML alttext (PLAN_M2 3.2, P2, D21). Owner A. Pure functions, no KaTeX.
//
// latexNormalize(raw), in this order: `\mbox{\boldmath$x$}` → `\boldsymbol{x}`, `{\mbox{{{R\/}}}}` → `\mathrm{R}`, the
// remaining `\mbox{` → `\text{`, `\/` and `\displaystyle` dropped (a `\\` pair is a token of its own and stays), then
// `&lt;` `&gt;` `&quot;` `&#39;` and a lone `&amp;` decoded, whitespace collapsed. The entities come after the token
// removal (A-I10-02: before it, `&\/amp;` → `&amp;` → `&` took two passes), and an `&amp;` that would form a new
// entity (`&amp;lt;`) is left as it is.
// Idempotent (f(f(x)) = f(x)) on the checked forms only: FORMS and a fixed-seed fuzz of whole tokens
// (latexNormalize.test.ts), and the 44 equations of the synthetic and the two real-paper fixtures (checked once). Not
// for every input: a dropped `\/` or `\displaystyle` that joins its neighbours into a new token leaves that token for a
// second pass (`\display\/style x` → `\displaystyle x` → `x`, `\mbo\/x{a}` → `\mbox{a}` → `\text{a}`; A-F4R1-03). No
// such form was seen in LaTeXML alttext, and the pipeline applies the function once.
// The stored value (equations.latex) is this output cut to the contract's EQUATION_LATEX_MAX (contracts/domain.ts — the
// EquationDto / Citation.latex cap; imported, never a number of its own: X-I10-03); a longer equation keeps its full
// text in latexRaw and gets katexOk = false.

import { EQUATION_LATEX_MAX } from '@study-paper/shared/contracts/domain';

const BOLDMATH = /\\mbox\{\\boldmath\s*\$([^$]*)\$\}/g;
const MBOX_ROMAN = /\{\\mbox\{\{\{([^{}]*?)(?:\\\/)?\}\}\}\}/g;
const MBOX = /\\mbox\{/g;
/** `\\` (kept), `\/` and `\displaystyle` (dropped), scanned left to right as backslash tokens. */
const TOKENS = /\\(\\|\/|displaystyle(?![A-Za-z]))/g;
const ENTITIES = /&(lt|gt|quot|#39);|&amp;(?!(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9A-Fa-f]+);)/g;
const ENTITY_CHAR: Record<string, string> = { lt: '<', gt: '>', quot: '"', '#39': "'" };

export function latexNormalize(raw: string): string {
  return raw
    .replace(BOLDMATH, '\\boldsymbol{$1}')
    .replace(MBOX_ROMAN, '\\mathrm{$1}')
    .replace(MBOX, '\\text{')
    .replace(TOKENS, (m, t: string) => (t === '\\' ? m : ''))
    // entities last (A-I10-02): a token dropped between "&" and an entity tail ("&\/amp;") must leave nothing for a
    // second pass — restored here, the "&amp;" it forms becomes "&" in the same pass
    .replace(ENTITIES, (_m, name: string | undefined) => (name ? ENTITY_CHAR[name]! : '&'))
    .replace(/\s+/g, ' ')
    .trim();
}

/** The stored form: latexNormalize cut to EQUATION_LATEX_MAX (never inside a surrogate pair); `cut` → katexOk false. */
export function normalizeForStore(raw: string): { latex: string; cut: boolean } {
  const full = latexNormalize(raw);
  if (full.length <= EQUATION_LATEX_MAX) return { latex: full, cut: false };
  let end = EQUATION_LATEX_MAX;
  const c = full.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return { latex: full.slice(0, end), cut: true };
}
