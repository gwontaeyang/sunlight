// Structure → PDF positions (PLAN_M2 3.2, D5/D6; prototype 05_m2/plan_probes/anchor5.mts). Owner A.
//
// Only the frozen matcher is used (shared/anchor: findExactHits, matchQuote, WorkBudget, n1) on page_texts.text — no
// string comparison of our own decides a position (no lower-casing, no whitespace stripping, no regex search for the
// location). Case and number differences are handled by building candidate strings from the HTML side; the rest is
// uniqueness, line conditions and document order. Not found → null (no jump), never a guess.
//
// Sections: candidates {title, title.toUpperCase()} (skipped when N1 is shorter than 4); the hits of BOTH are merged
// (one per start position) and kept when
//   line head: the text from the line start to the hit, trimmed, EQUALS one of prefixForms(number) — no number → '';
//              a number → `n`, `n.`, and for IEEE `III-A` / `IV-A1` the last component X as `X.` / `X)`. A numbered
//              section therefore never sits on a line without its number (figure text "System Overview").
//   line tail: the text from the hit end to the line end is blank or starts with ':' / '.' (run-in headings).
//   stage 1: exactly one hit in the document → confirmed.
//   stage 2: the hits between the nearest confirmed sections before/after (page, offset; open interval) — exactly
//            one → confirmed; repeated until nothing changes.
// Equations: L = hits of "(n)" whose line ends right after the tag (blank to the newline); K = L without prose lines
//   (≥ 5 lower-case words of ≥ 3 letters between the line start and the hit). The prose filter only REMOVES
//   confirmable hits; uniqueness, "first hit after the context" and windows always count over L (Codex M1: a filter
//   must never create uniqueness). A confirmed hit is in K and, when the context was located, not before it.
//   stage 1: |L| = 1 and that hit is confirmable.
//   stage 2: the end (≤ 80 chars, N1 ≥ 12) of contextBefore is `verbatim`: the first L hit after it on that page (else
//            the first L hit of the next page), if confirmable.
//   stage 3: exactly one L hit between the confirmed neighbours (document order) and it is confirmable; repeated.
//   Known limit (kept by a regression test): a real tag not at a line end + ONE short non-prose reference "See (1)"
//   at a line end after the context → stage 1 confirms that reference line.
// Invariants: confirmed sections, and confirmed numbered equations, strictly increase in document order (a violating
// pair → both null); an equation is never on a page before its section's page (→ null).
// Figures: the first ≤ 80 characters of the caption found `verbatim` (one location) → its page only.
// Cost: one WorkBudget (ANCHOR_WORK ≈ 1.5 s) for everything, plus the matcher's own per-quote cap (a call that runs
// out of either is "unknown" → null, never "no hit"). An event-loop yield every 8 items. A spent budget → the rest
// null + warning anchor_budget. pdfRect = the rect of the page_texts item that contains the offset (display only).
import { findExactHits, matchQuote, MAX_QUOTE_WORK, WorkBudget, type PageTextLike } from '@study-paper/shared/anchor/matchQuote';
import { n1 } from '@study-paper/shared/anchor/normalize';
import type { NormRect } from '@study-paper/shared/contracts/domain';
import { IngestError } from './errors';

export const ANCHOR_WORK = 1_500_000_000;
export const ANCHOR_YIELD_EVERY = 8;
export const CONTEXT_TAIL_CHARS = 80;
export const CONTEXT_MIN_N1 = 12;
export const TITLE_MIN_N1 = 4;

export interface AnchorPage {
  page: number;
  text: string;
  /** page_texts.itemsJson parsed: {start, len, rect} per text item. */
  items: { start: number; len: number; rect: NormRect }[];
}
export interface AnchorSectionIn {
  number: string | null;
  title: string;
}
export interface AnchorEquationIn {
  number: string | null;
  contextBefore: string | null;
  /** Index into the sections input, or null. */
  sectionIndex: number | null;
}
export interface AnchorPosition {
  page: number;
  start: number;
  rect: NormRect | null;
}
export type EquationStage = 's1' | 's2' | 's3';
export interface AnchorResult {
  sections: (AnchorPosition | null)[];
  equations: (AnchorPosition | null)[];
  /** How each equation was confirmed (null when not). */
  equationStages: (EquationStage | null)[];
  sectionStages: ('s1' | 's2' | null)[];
  figures: (number | null)[];
  budgetExhausted: boolean;
  orderViolations: number;
}
export interface AnchorOptions {
  /** Total work units (tests inject 0). */
  work?: number;
  signal?: AbortSignal;
}

interface Hit {
  page: number;
  start: number;
  end: number;
}
const key = (h: { page: number; start: number }) => h.page * 1e8 + h.start;

/** Line-head forms of a section number (see the header). */
export function prefixForms(number: string | null): string[] {
  if (number === null || number === '') return [''];
  const forms = new Set<string>([number, `${number}.`]);
  if (number.includes('-')) {
    const last = /(\d+|[A-Z]+)$/.exec(number)?.[1];
    if (last) {
      forms.add(`${last}.`);
      forms.add(`${last})`);
    }
  }
  return [...forms];
}

const PROSE_WORD = /\b[a-z]{3,}\b/g;
/** A prose line: ≥ 5 lower-case words of ≥ 3 letters before the hit (P4: "…the continuous kinematic model (1)"). */
export const isProse = (lineHead: string) => (lineHead.match(PROSE_WORD) ?? []).length >= 5;

class Budgeted {
  readonly total: WorkBudget;
  spent = false;
  constructor(limit: number) {
    this.total = new WorkBudget(limit);
  }
  /** Runs one matcher call on a fresh per-call budget; null = the call ran out (result unknown). */
  call<T>(f: (b: WorkBudget) => T, failed: (r: T) => boolean = () => false): T | null {
    if (this.spent || this.total.exhausted) {
      this.spent = true;
      return null;
    }
    const b = new WorkBudget(MAX_QUOTE_WORK, this.total);
    const r = f(b);
    if (b.exhausted || this.total.exhausted || failed(r)) {
      if (this.total.exhausted) this.spent = true;
      return null;
    }
    return r;
  }
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

export async function anchorStructure(sections: readonly AnchorSectionIn[], equations: readonly AnchorEquationIn[], figures: readonly { caption: string }[], pages: readonly AnchorPage[], opts: AnchorOptions = {}): Promise<AnchorResult> {
  const like: PageTextLike[] = pages.map((p) => ({ page: p.page, text: p.text }));
  const byPage = new Map(pages.map((p) => [p.page, p] as const));
  const textOf = (pg: number) => byPage.get(pg)?.text ?? '';
  const lineBounds = (pg: number, start: number, end: number) => {
    const t = textOf(pg);
    const ls = t.lastIndexOf('\n', start - 1) + 1;
    let le = t.indexOf('\n', end);
    if (le < 0) le = t.length;
    return { head: t.slice(ls, start), tail: t.slice(end, le) };
  };
  const rectAt = (pg: number, offset: number): NormRect | null => byPage.get(pg)?.items.find((i) => offset >= i.start && offset < i.start + i.len)?.rect ?? null;
  const budget = new Budgeted(opts.work ?? ANCHOR_WORK);
  let unknown = false; // some call ran out of its own per-quote cap
  let count = 0;
  const tick = async () => {
    if (++count % ANCHOR_YIELD_EVERY === 0) await yieldNow();
    if (opts.signal?.aborted) throw new IngestError('cancelled', 'anchoring cancelled');
  };
  const hitsOf = (exact: string): Hit[] | null => {
    const r = budget.call((b) => findExactHits(like, { exact }, { budget: b }));
    if (r === null) {
      unknown = true;
      return null;
    }
    return r.map((h) => ({ page: h.page, start: h.start, end: h.end }));
  };

  // ---- sections
  const secHits: (Hit[] | null)[] = [];
  for (const s of sections) {
    await tick();
    if (n1(s.title).length < TITLE_MIN_N1) {
      secHits.push(null);
      continue;
    }
    const forms = prefixForms(s.number);
    const seen = new Map<number, Hit>();
    let failed = false;
    for (const cand of new Set([s.title, s.title.toUpperCase()])) {
      const hs = hitsOf(cand);
      if (hs === null) {
        failed = true;
        break;
      }
      for (const h of hs) {
        const { head, tail } = lineBounds(h.page, h.start, h.end);
        if (!forms.includes(head.trim())) continue;
        if (!/^\s*(?:$|[:.])/.test(tail)) continue;
        if (!seen.has(key(h))) seen.set(key(h), h);
      }
    }
    secHits.push(failed ? null : [...seen.values()].sort((a, b) => key(a) - key(b)));
  }
  const secFixed: (Hit | null)[] = sections.map(() => null);
  const secStage: ('s1' | 's2' | null)[] = sections.map(() => null);
  secHits.forEach((h, i) => {
    if (h && h.length === 1) {
      secFixed[i] = h[0]!;
      secStage[i] = 's1';
    }
  });
  for (let changed = true, rounds = 0; changed && rounds <= sections.length; rounds++) {
    changed = false;
    secHits.forEach((hs, i) => {
      if (secFixed[i] || !hs || hs.length < 2) return;
      const [lo, hi] = window(secFixed, i);
      const c = hs.filter((h) => key(h) > lo && key(h) < hi);
      if (c.length === 1) {
        secFixed[i] = c[0]!;
        secStage[i] = 's2';
        changed = true;
      }
    });
  }
  let orderViolations = enforceOrder(secFixed, secStage);

  // ---- equations
  interface EqWork {
    L: Hit[];
    K: Set<number>;
    ctxEnd: { page: number; start: number } | null;
    known: boolean;
  }
  const eqWork: EqWork[] = [];
  for (const e of equations) {
    await tick();
    if (e.number === null) {
      eqWork.push({ L: [], K: new Set(), ctxEnd: null, known: false });
      continue;
    }
    const hs = hitsOf(`(${e.number})`);
    if (hs === null) {
      eqWork.push({ L: [], K: new Set(), ctxEnd: null, known: false });
      continue;
    }
    const L: Hit[] = [];
    const K = new Set<number>();
    for (const h of hs) {
      const { head, tail } = lineBounds(h.page, h.start, h.end);
      if (!/^\s*$/.test(tail)) continue; // line-end condition
      L.push(h);
      if (!isProse(head)) K.add(key(h));
    }
    L.sort((a, b) => key(a) - key(b));
    let ctxEnd: EqWork['ctxEnd'] = null;
    const tail = (e.contextBefore ?? '').slice(-CONTEXT_TAIL_CHARS);
    if (n1(tail).length >= CONTEXT_MIN_N1) {
      const m = budget.call(
        (b) => matchQuote(like, { exact: tail }, { budget: b }),
        (r) => r.status === 'unchecked',
      );
      if (m === null) {
        // the context could not be checked: without it the rules are stricter, never looser — but a located
        // context also forbids hits before it, so an unknown context makes the whole equation unknown
        unknown = true;
        eqWork.push({ L: [], K: new Set(), ctxEnd: null, known: false });
        continue;
      }
      if (m.status === 'verbatim' && m.position) ctxEnd = { page: m.position.page, start: m.position.end };
    }
    eqWork.push({ L, K, ctxEnd, known: true });
  }
  const ok = (w: EqWork, h: Hit) => w.K.has(key(h)) && (w.ctxEnd === null || key(h) >= key(w.ctxEnd));
  const eqFixed: (Hit | null)[] = equations.map(() => null);
  const eqStage: (EquationStage | null)[] = equations.map(() => null);
  eqWork.forEach((w, i) => {
    if (w.known && w.L.length === 1 && ok(w, w.L[0]!)) {
      eqFixed[i] = w.L[0]!;
      eqStage[i] = 's1';
    }
  });
  eqWork.forEach((w, i) => {
    if (eqFixed[i] || !w.known || w.K.size === 0 || !w.ctxEnd) return;
    const pos = w.ctxEnd;
    const h = w.L.find((x) => x.page === pos.page && x.start >= pos.start) ?? w.L.find((x) => x.page === pos.page + 1);
    if (h && ok(w, h)) {
      eqFixed[i] = h;
      eqStage[i] = 's2';
    }
  });
  // Windows over the numbered equations only (unnumbered rows have no tag and do not take part in the order).
  const numbered = equations.map((e, i) => (e.number !== null ? i : -1)).filter((i) => i >= 0);
  for (let changed = true, rounds = 0; changed && rounds <= numbered.length; rounds++) {
    changed = false;
    numbered.forEach((i, j) => {
      const w = eqWork[i]!;
      if (eqFixed[i] || !w.known || w.K.size === 0) return;
      let lo = -1;
      let hi = Number.POSITIVE_INFINITY;
      for (let k = j - 1; k >= 0; k--) {
        const f = eqFixed[numbered[k]!];
        if (f) {
          lo = key(f);
          break;
        }
      }
      for (let k = j + 1; k < numbered.length; k++) {
        const f = eqFixed[numbered[k]!];
        if (f) {
          hi = key(f);
          break;
        }
      }
      const c = w.L.filter((h) => key(h) > lo && key(h) < hi);
      if (c.length === 1 && ok(w, c[0]!)) {
        eqFixed[i] = c[0]!;
        eqStage[i] = 's3';
        changed = true;
      }
    });
  }
  {
    const sub = numbered.map((i) => eqFixed[i]!);
    const subStage = numbered.map((i) => eqStage[i]!);
    orderViolations += enforceOrder(sub, subStage);
    numbered.forEach((i, j) => {
      eqFixed[i] = sub[j] ?? null;
      eqStage[i] = sub[j] ? subStage[j]! : null;
    });
  }
  // An equation never sits on a page before its (anchored) section's page.
  equations.forEach((e, i) => {
    const f = eqFixed[i];
    const s = e.sectionIndex !== null ? secFixed[e.sectionIndex] : null;
    if (f && s && f.page < s.page) {
      eqFixed[i] = null;
      eqStage[i] = null;
    }
  });

  // ---- figures
  const figPages: (number | null)[] = [];
  for (const f of figures) {
    await tick();
    const head = f.caption.slice(0, CONTEXT_TAIL_CHARS);
    if (!head.trim()) {
      figPages.push(null);
      continue;
    }
    const m = budget.call(
      (b) => matchQuote(like, { exact: head }, { budget: b }),
      (r) => r.status === 'unchecked',
    );
    if (m === null) unknown = true;
    figPages.push(m && m.status === 'verbatim' && m.position ? m.position.page : null);
  }

  const pos = (h: Hit | null): AnchorPosition | null => (h ? { page: h.page, start: h.start, rect: rectAt(h.page, h.start) } : null);
  return {
    sections: secFixed.map(pos),
    equations: eqFixed.map(pos),
    equationStages: eqStage,
    sectionStages: secStage,
    figures: figPages,
    budgetExhausted: budget.spent || unknown,
    orderViolations,
  };
}

/** The open (lo, hi) key window between the nearest fixed items before and after index i. */
function window(fixed: readonly (Hit | null)[], i: number): [number, number] {
  let lo = -1;
  let hi = Number.POSITIVE_INFINITY;
  for (let j = i - 1; j >= 0; j--) {
    const f = fixed[j];
    if (f) {
      lo = key(f);
      break;
    }
  }
  for (let j = i + 1; j < fixed.length; j++) {
    const f = fixed[j];
    if (f) {
      hi = key(f);
      break;
    }
  }
  return [lo, hi];
}

/** Confirmed positions must strictly increase in list order; each violating pair goes back to null. Returns the count. */
function enforceOrder<S>(fixed: (Hit | null)[], stage: (S | null)[]): number {
  let violations = 0;
  let prev = -1;
  for (let i = 0; i < fixed.length; i++) {
    const f = fixed[i];
    if (!f) continue;
    if (prev >= 0 && key(f) <= key(fixed[prev]!)) {
      violations++;
      fixed[prev] = null;
      stage[prev] = null;
      fixed[i] = null;
      stage[i] = null;
      // the next item compares against the last confirmed one before the pair
      prev = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (fixed[j]) {
          prev = j;
          break;
        }
      }
      continue;
    }
    prev = i;
  }
  return violations;
}
