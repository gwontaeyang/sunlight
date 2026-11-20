// Equation display (PLAN_M2 D21, 3.3, BRIEF_D D3/D5). Owner D.
// The ONE place where model- or paper-derived LaTeX becomes HTML: S's renderLatexSafe(katex.renderToString, …) with its
// fixed options (trust:false, strict:'ignore', maxExpand:1000, \operatorname fallback for an unknown command) — the same
// function the server's katexOk check uses. Anything else (server katexOk=false, or a render failure here) is shown
// as the source code text. "LaTeX 복사" always copies the server's `latex` string itself, never the display fallback.
import katex from 'katex';
import { useMemo, useState } from 'react';
import { renderLatexSafe, type KatexRenderToString } from '@study-paper/shared/latex/katexSafe';

const render = katex.renderToString as unknown as KatexRenderToString;

export function LatexView({ latex, katexOk = true, displayMode = true }: { latex: string; katexOk?: boolean; displayMode?: boolean }) {
  const r = useMemo(() => (katexOk ? renderLatexSafe(render, latex, { displayMode }) : ({ ok: false } as const)), [latex, katexOk, displayMode]);
  if (!r.ok) {
    return (
      <code data-testid="pn-latex-code" className="block whitespace-pre-wrap break-all rounded bg-gray-50 px-1 font-mono text-sl-label text-gray-700" title="KaTeX로 그리지 못해 원문을 표시합니다">
        {latex}
      </code>
    );
  }
  // renderLatexSafe's output only (trust:false — no \href, \url, \htmlClass …).
  return <span data-testid="pn-latex" className="block overflow-x-auto" dangerouslySetInnerHTML={{ __html: r.html }} />;
}

/** Copies the server's LaTeX string (clipboard API); resolves false when the clipboard is unavailable. */
export async function copyLatex(latex: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(latex);
    return true;
  } catch {
    return false;
  }
}

export function CopyLatexButton({ latex, testId = 'pn-eq-copy' }: { latex: string; testId?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button
      type="button"
      data-testid={testId}
      className="rounded border border-gray-300 px-1.5 text-sl-label hover:bg-gray-100"
      onClick={() => void copyLatex(latex).then((ok) => setState(ok ? 'ok' : 'fail'))}
    >
      {state === 'ok' ? '복사함' : state === 'fail' ? '복사 실패' : 'LaTeX 복사'}
    </button>
  );
}
