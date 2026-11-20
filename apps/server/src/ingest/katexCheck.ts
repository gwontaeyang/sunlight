// KaTeX check of the stored equation LaTeX (PLAN_M2 3.2, D21). Owner A.
// Calls S's renderLatexSafe (shared/latex/katexSafe.ts — the same function the web uses to draw, so katexOk and the
// screen agree; its options and the one `\operatorname` retry live there). The stored latex is never changed here.
// Budget: 3 s for all of them; what is left when the budget runs out is katexOk = false + warning katex_budget. The
// budget only affects katexOk — the supplement bytes do not depend on it. An event-loop yield before an equation when 20
// were checked since the last one or KATEX_YIELD_MS passed (A-I10-01: near the 4,000-character cap one equation can take
// tens of ms, and 20 of them held the loop 0.3–1.6 s); one equation cannot be split, so the longest stretch is about one
// equation's time. One clock read per equation decides both the yield and the budget.
import katex from 'katex';
import { renderLatexSafe } from '@study-paper/shared/latex/katexSafe';
import { normalizeForStore } from './latexNormalize';
import type { ParsedEquation } from './latexml';
import type { StoredLatex } from './structureStore';
import { IngestError } from './errors';

export const KATEX_BUDGET_MS = 3_000;
export const KATEX_YIELD_EVERY = 20;
/** A yield before the next equation once this many ms passed since the last one (A-I10-01). */
export const KATEX_YIELD_MS = 30;

export interface KatexCheckOptions {
  budgetMs?: number;
  now?: () => number;
  signal?: AbortSignal;
  /** The event-loop yield (tests count them); setImmediate by default. */
  yieldNow?: () => Promise<void>;
}

/** One formula (display mode). */
export function katexCheck(latex: string): boolean {
  return renderLatexSafe((l, o) => katex.renderToString(l, o), latex, { displayMode: true }).ok;
}

/** Every formula in order; false for the ones not checked within the budget (`budgetExceeded`). */
export async function katexCheckAll(latex: readonly string[], opts: KatexCheckOptions = {}): Promise<{ ok: boolean[]; budgetExceeded: boolean }> {
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? KATEX_BUDGET_MS;
  const yieldNow = opts.yieldNow ?? (() => new Promise<void>((r) => setImmediate(r)));
  const start = now();
  const ok: boolean[] = [];
  let exceeded = false;
  let lastYield = start;
  for (let i = 0; i < latex.length; i++) {
    const t = exceeded ? lastYield : now(); // no clock read once the budget is gone (the rest is false)
    if (i > 0 && (i % KATEX_YIELD_EVERY === 0 || t - lastYield >= KATEX_YIELD_MS)) {
      await yieldNow();
      lastYield = t;
    }
    if (opts.signal?.aborted) throw new IngestError('cancelled', 'KaTeX check cancelled');
    if (exceeded || t - start >= budget) {
      exceeded = true;
      ok.push(false);
      continue;
    }
    ok.push(katexCheck(latex[i]!));
  }
  return { ok, budgetExceeded: exceeded };
}

/** Persist the renderer's verdict only when both extraction and storage kept the entire equation. */
export async function prepareStoredEquations(
  equations: readonly Pick<ParsedEquation, 'latexRaw' | 'latexCut'>[],
  opts: KatexCheckOptions = {},
): Promise<{ latex: StoredLatex[]; budgetExceeded: boolean }> {
  const normalized = equations.map((equation) => normalizeForStore(equation.latexRaw));
  const checked = await katexCheckAll(normalized.map((entry) => entry.latex), opts);
  const latex = normalized.map((entry, i) => ({
    latex: entry.latex,
    katexOk: !equations[i]!.latexCut && !entry.cut && checked.ok[i] === true,
  }));
  return { latex, budgetExceeded: checked.budgetExceeded };
}
