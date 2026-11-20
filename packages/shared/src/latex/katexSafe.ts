// Safe KaTeX rendering (PLAN_M2 D21, 3.2). Owner: supervisor — frozen. The server's katexCheck (A) and the web's
// equation display (D) call this same function, so `equations.katexOk` and what the screen shows agree.
// - KaTeX itself is passed in (shared has no dependency on it): renderLatexSafe(katex.renderToString, latex, …).
// - Options are fixed: throwOnError true, strict 'ignore', trust false (no \href/\url/\htmlClass …), maxExpand 1000
//   (a recursive \def ends with an error instead of running away).
// - "Undefined control sequence: \X" → ONE retry with macros { '\X': '\operatorname{X}' } (a display fallback only;
//   the stored LaTeX is never changed). A second undefined command, or any other error → { ok: false }.
// - A fresh macros object per call: \def inside one formula cannot leak into the next.

export type KatexRenderToString = (latex: string, options: Record<string, unknown>) => string;
export type SafeRender = { ok: true; html: string } | { ok: false };

const FIXED = { throwOnError: true, strict: 'ignore', trust: false, maxExpand: 1000 } as const;
const UNDEFINED_RE = /Undefined control sequence: (\\[A-Za-z@]+)/;

export function renderLatexSafe(renderToString: KatexRenderToString, latex: string, opts: { displayMode: boolean }): SafeRender {
  const attempt = (macros: Record<string, string>): { html: string } | { error: unknown } => {
    try {
      return { html: renderToString(latex, { ...FIXED, displayMode: opts.displayMode, macros }) };
    } catch (error) {
      return { error };
    }
  };
  const first = attempt({});
  if ('html' in first) return { ok: true, html: first.html };
  const m = UNDEFINED_RE.exec(first.error instanceof Error ? first.error.message : String(first.error));
  if (!m) return { ok: false };
  const name = m[1]!;
  const second = attempt({ [name]: `\\operatorname{${name.slice(1)}}` });
  return 'html' in second ? { ok: true, html: second.html } : { ok: false };
}
