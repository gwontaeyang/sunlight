// Quote → position matching (PLAN 5.3, hypothesis-style quote anchoring implemented from the plan; no code
// copied). Owner C. Signature changes go through the supervisor.
//
// 1. N1 exact search, page by page (pages are never concatenated: a quote crossing a page boundary is not
//    supported). Each PDF line-end hyphen (`-` + optional spaces + `\n`) is optional, independently, so one
//    quote may keep one line-end hyphen (`point-to-\npoint` = `point-to-point`) and drop another
//    (`asso-\nciation` = `association`).
//    Word-boundary rule (review M1): N1 keeps one space per whitespace run. A space present on one side only
//    is equivalent to none ONLY when it does not separate two word characters (letters/digits) or when one of
//    them is a no-space script character (Han, Hiragana, Katakana). So `10 Hz.` = `10 Hz .`, `Fig. 1` = `Fig.1`,
//    but `nowhere` ≠ `now here` and `10Hz` ≠ `10 Hz`. A PDF line break is whitespace in PageText, so it is a word
//    boundary too. pdf.js item boundaries are NOT evidence of a word boundary (review N1: items split words too),
//    so matching uses the page text only — the server (page_texts.text) and the browser (text-layer DOM text,
//    equal by the parity gate) give the same answer.
//    A match starts at the first unit of an NFKC chunk and ends at the last unit of one (`f` never matches
//    half of `ﬁ`), and the original span is re-verified against the quote before it is returned.
// 2. One N1 hit in the searched pages → `verbatim`. Several → prefix/suffix (N1, same rules) filter; one
//    left → `verbatim`, otherwise `ambiguous` with `candidates` (no position).
// 3. No N1 hit and N1 length ≥ 12 → N2 (N1 + no hyphens/spaces + lower case) via a bit-parallel search on the N2
//    page text: maxErrors = min(32, ceil(len × 0.2)), score = 1 − errors/len, accepted when ≥ 0.8 → `fuzzy` with
//    the best location. An exact N2 hit (errors 0) gets score 1 − lev(N1 quote, N1 page span)/len, clamped to
//    [0.8, 0.99], so `non-linear` vs `nonlinear` is fuzzy with a score < 1. `fuzzy` never counts as verbatim.
// 4. Otherwise `not_found`.
// Work budget (reviews B2, N3): every step is charged to a deterministic work budget in "units" (about 1 ns of
// work each): one exact-DP state (memoised over (page unit, quote unit), so
// polynomial), one 32-character block step of the fuzzy bit-parallel search (Myers/Hyyrö, O(page × ⌈quote/32⌉),
// own implementation — approx-string-match computed a start for every candidate end and had no bound), one
// Levenshtein cell. One quote may use MAX_QUOTE_WORK units; resolveCitations() also passes an answer-wide
// WorkBudget (MAX_ANSWER_WORK) shared by all its quotes. Input caps: a quote longer than MAX_NEEDLE_CHARS N1
// units, or pages longer than MAX_TEXT_CHARS in total, are not searched (page normalisation is linear in the
// text and cached per page text, so the text cap bounds it). Whatever is not finished within the budget or the caps is `unchecked` (never
// `not_found`, never evidence); findExactHits → [] and quoteEqualsN1 → false in that case.
// pageHint: that page is searched first. N1 uniqueness is always document-wide (or page-wide with pageOnly).
// For `fuzzy`, an accepted match on the hint page wins over better matches on other pages.
import type { QuoteStatus, TextPositionSelector, TextQuoteSelector } from '../contracts/domain';
import { isChunkEnd, isChunkStart, lineEndHyphenFlags, normalizeN1, normalizeN2, toOriginalRange, type Normalized } from './normalize';

export interface PageTextLike {
  page: number;
  text: string;
}
export interface MatchOptions {
  /** Page searched first; with `pageOnly` the search is restricted to it (web DOM re-anchoring). */
  pageHint?: number;
  pageOnly?: boolean;
  /** Shared budget of a larger job (one answer's citations); this call also stays within MAX_QUOTE_WORK. */
  budget?: WorkBudget;
}
export interface QuoteMatch {
  status: QuoteStatus;
  /** 1 for verbatim, errors-based for fuzzy, 0 otherwise. */
  score: number;
  /** Only for `verbatim` / `fuzzy` (single location). */
  position?: TextPositionSelector;
  /** Only for `ambiguous`: number of N1 matches left after prefix/suffix filtering. */
  candidates?: number;
}

/** Quotes whose N1 form (spaces not counted) is shorter than this only get the exact (N1) stage. */
export const MIN_FUZZY_N1_LENGTH = 12;
export const FUZZY_MIN_SCORE = 0.8;
export const FUZZY_MAX_ERRORS = 32;
export const fuzzyMaxErrors = (len: number) => Math.min(FUZZY_MAX_ERRORS, Math.ceil(len * 0.2));
/** Work units (≈ 1 ns each, measured on the dev machine; only their ratio matters for determinism). */
export const WORK_UNITS = { exactState: 130, myersBlockStep: 3, levenshteinCell: 2 } as const;
/** Per-quote work cap (≈ 25 ms) and per-answer cap (≈ 150 ms). */
export const MAX_QUOTE_WORK = 25_000_000;
export const MAX_ANSWER_WORK = 150_000_000;
/** Quotes longer than this (N1 units) are not searched (`unchecked`). Model quotes are ≤ 600 chars. */
export const MAX_NEEDLE_CHARS = 4000;
/** Total page text one search may cover (a 40-page paper is ~200 k). Beyond it the quote is `unchecked`. */
export const MAX_TEXT_CHARS = 500_000;

interface PageCore {
  text: string;
  n1: Normalized;
  /** Line-end hyphen flags over n1.text. */
  optional: Uint8Array;
  n2?: Normalized;
}
interface PreparedPage {
  page: number;
  text: string;
  n1: Normalized;
  optional: Uint8Array;
  core: PageCore;
}

/** Normalised forms by page text, least recently used dropped (the server reads page_texts for every answer). */
const textCache = new Map<string, PageCore>();
const TEXT_CACHE_SIZE = 256;
function coreOf(text: string, cache: boolean): PageCore {
  const hit = textCache.get(text);
  if (hit) {
    textCache.delete(text);
    textCache.set(text, hit);
    return hit;
  }
  const n1 = normalizeN1(text);
  const core: PageCore = { text, n1, optional: lineEndHyphenFlags(text, n1) };
  if (cache) {
    textCache.set(text, core);
    if (textCache.size > TEXT_CACHE_SIZE) textCache.delete(textCache.keys().next().value!);
  }
  return core;
}
const preparedCache = new WeakMap<PageTextLike, PreparedPage>();
function prepare(p: PageTextLike, cache = true): PreparedPage {
  const cached = preparedCache.get(p);
  if (cached && cached.text === p.text && cached.page === p.page) return cached;
  const core = coreOf(p.text, cache);
  const prepared: PreparedPage = { page: p.page, text: p.text, n1: core.n1, optional: core.optional, core };
  if (cache) preparedCache.set(p, prepared);
  return prepared;
}
const n2Of = (pp: PreparedPage): Normalized => (pp.core.n2 ??= normalizeN2(pp.text));
const tooMuchText = (pages: readonly PageTextLike[]) => pages.reduce((n, p) => n + p.text.length, 0) > MAX_TEXT_CHARS;

const WORD = /^[\p{L}\p{N}]$/u;
const NO_SPACE_SCRIPT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;
/** The whole code point that ends right before UTF-16 index `i` (a surrogate pair counts as one character). */
function cpBefore(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}
/** The whole code point that starts at UTF-16 index `i`. */
function cpAt(s: string, i: number): string | undefined {
  if (i >= s.length) return undefined;
  return String.fromCodePoint(s.codePointAt(i)!);
}
/** True when a space between the code points `a` and `b` is a word boundary that must be present on both sides. */
function hardBoundary(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return WORD.test(a) && WORD.test(b) && !NO_SPACE_SCRIPT.test(a) && !NO_SPACE_SCRIPT.test(b);
}

/**
 * Deterministic work budget (units, see WORK_UNITS). A child budget also charges its parent, and is exhausted
 * when either is. resolveCitations() creates one per answer; matchQuote() makes a per-quote child.
 */
export class WorkBudget {
  used = 0;
  constructor(
    readonly limit: number,
    private readonly parent?: WorkBudget,
  ) {}
  get exhausted(): boolean {
    return this.used > this.limit || (this.parent?.exhausted ?? false);
  }
  /** Adds `units`; false once this budget or its parent is over its limit. */
  take(units = 1): boolean {
    this.used += units;
    if (this.parent) this.parent.take(units);
    return !this.exhausted;
  }
  /** Like take(), but throws BudgetExhausted. */
  charge(units: number): void {
    if (!this.take(units)) throw new BudgetExhausted();
  }
}
type Budget = WorkBudget;
class BudgetExhausted extends Error {}

/**
 * Memoised DP over states (i = page N1 unit, j = needle unit): the smallest end i (exclusive) reachable when the
 * whole needle is consumed, or -1. With `target` ≥ 0 only that exact end counts (1 / -1). Transitions only grow
 * i or j, so the state graph is a DAG; it is walked with an explicit stack (no recursion depth limit).
 */
class Matcher {
  private memo = new Map<number, number>();
  private readonly w: number;
  constructor(
    private readonly pp: PreparedPage,
    private readonly needle: string,
    private readonly budget: Budget,
    private readonly target = -1,
  ) {
    this.w = needle.length + 1;
  }

  private successors(i: number, j: number): number[] {
    const { text } = this.pp.n1;
    const out: number[] = [];
    if (i >= text.length || (this.target >= 0 && i > this.target)) return out;
    const pc = text[i]!;
    const nc = this.needle[j]!;
    const w = this.w;
    if (pc === nc) out.push((i + 1) * w + j + 1);
    if (this.pp.optional[i]) out.push((i + 1) * w + j); // line-end hyphen dropped
    // Boundaries are judged on whole code points (review A2: a supplementary-plane letter is one surrogate pair).
    if (pc === ' ' && nc !== ' ' && !hardBoundary(cpBefore(text, i), cpAt(text, i + 1))) out.push((i + 1) * w + j); // extra page space
    if (nc === ' ' && pc !== ' ' && !hardBoundary(cpBefore(this.needle, j), cpAt(this.needle, j + 1))) out.push(i * w + j + 1); // extra quote space
    return out;
  }

  /** Result for state (i, j): end index / 1 when reachable (see class doc), -1 otherwise. */
  solve(i0: number, j0: number): number {
    const m = this.needle.length;
    const w = this.w;
    const leaf = (i: number) => (this.target < 0 ? i : i === this.target ? 1 : -1);
    const start = i0 * w + j0;
    if (j0 === m) return leaf(i0);
    const stack: number[] = [start];
    while (stack.length) {
      const key = stack[stack.length - 1]!;
      if (this.memo.has(key)) {
        stack.pop();
        continue;
      }
      const i = Math.floor(key / w);
      const j = key - i * w;
      const succ = this.successors(i, j);
      let pending = false;
      let best = -1;
      for (const s of succ) {
        const si = Math.floor(s / w);
        const sj = s - si * w;
        const v = sj === m ? leaf(si) : this.memo.get(s);
        if (v === undefined) {
          this.budget.charge(WORK_UNITS.exactState);
          stack.push(s);
          pending = true;
        } else if (v >= 0 && (best < 0 || v < best)) best = v;
      }
      if (pending) continue;
      this.memo.set(key, best);
      stack.pop();
    }
    return this.memo.get(start)!;
  }
}

/** Needle units in N1 without leading/trailing space. */
const needleOf = (s: string) => normalizeN1(s).text.trim();

/** Exact N1 matches of `needle` on a prepared page, as N1 index ranges (one per start, shortest end). */
function exactRangesOnPage(pp: PreparedPage, needle: string, budget: Budget): { s: number; e: number }[] {
  const out: { s: number; e: number }[] = [];
  const text = pp.n1.text;
  const first = needle[0];
  if (first === undefined) return out;
  const matcher = new Matcher(pp, needle, budget);
  for (let s = text.indexOf(first); s >= 0; s = text.indexOf(first, s + 1)) {
    if (!isChunkStart(pp.n1, s)) continue;
    budget.charge(WORK_UNITS.exactState);
    const e = matcher.solve(s, 0);
    if (e < 0 || !isChunkEnd(pp.n1, e)) continue;
    // Re-verify the original span on its own (review M1): its N1 must equal the quote under the same rules.
    const r = toOriginalRange(pp.n1, s, e);
    if (!spanEquals(pp, r.start, r.end, needle, budget)) continue;
    out.push({ s, e });
  }
  return out;
}

/** The original page span [start, end) as a whole equals `needle` (N1 rules). */
function spanEquals(pp: PreparedPage, start: number, end: number, needle: string, budget: Budget): boolean {
  return wholeEquals(pp.text.slice(start, end), needle, budget);
}

/** `text` as a whole (ignoring leading/trailing whitespace) equals `needle` under the N1 matching rules. */
function wholeEquals(text: string, needle: string, budget: Budget): boolean {
  if (!needle) return false;
  const pp = prepare({ page: 0, text }, false);
  const t = pp.n1.text;
  let a = 0;
  let b = t.length;
  while (a < b && t[a] === ' ') a++;
  while (b > a && t[b - 1] === ' ') b--;
  if (a >= b) return false;
  return new Matcher(pp, needle, budget, b).solve(a, 0) === 1;
}

/** True when `pre` (N1) ends at N1 index `s` (a page space right before `s` may sit between them). */
function prefixMatches(pp: PreparedPage, pre: string, s: number, budget: Budget): boolean {
  if (!pre) return true;
  const ends = pp.n1.text[s - 1] === ' ' ? [s, s - 1] : [s];
  for (const end of ends) {
    // A match of `pre` ending at `end` spans pre.length units ± skipped spaces/hyphens.
    let slack = 0;
    for (let k = Math.max(0, end - pre.length - 64); k < end; k++) slack += pp.optional[k]! + (pp.n1.text[k] === ' ' ? 1 : 0);
    for (const ch of pre) if (ch === ' ') slack++;
    const matcher = new Matcher(pp, pre, budget, end);
    for (let k = Math.max(0, end - pre.length - slack); k <= end - pre.length + slack && k < end; k++) {
      if (pp.n1.text[k] === pre[0] && isChunkStart(pp.n1, k) && matcher.solve(k, 0) === 1) return true;
    }
  }
  return false;
}

/** True when `suf` (N1) starts at N1 index `e` (a page space at `e` may sit between them). */
function suffixMatches(pp: PreparedPage, suf: string, e: number, budget: Budget): boolean {
  if (!suf) return true;
  const matcher = new Matcher(pp, suf, budget);
  if (matcher.solve(e, 0) >= 0) return true;
  return pp.n1.text[e] === ' ' && matcher.solve(e + 1, 0) >= 0;
}

/** Orders pages by pageHint (first) and applies pageOnly. */
function orderPages(pages: readonly PageTextLike[], opts: MatchOptions): PageTextLike[] {
  if (opts.pageHint === undefined) return [...pages];
  const hint = pages.filter((p) => p.page === opts.pageHint);
  return opts.pageOnly ? hint : [...hint, ...pages.filter((p) => p.page !== opts.pageHint)];
}

export interface QuoteHit {
  page: number;
  /** [start, end) in PageText.text (UTF-16). */
  start: number;
  end: number;
  /** Whether prefix/suffix of the selector (if any) match around this hit. */
  contextOk: boolean;
}

/**
 * Every exact (N1) hit of the selector in the searched pages, in page order (pageHint first), with the
 * prefix/suffix check result. Exposed for the web DOM re-anchoring (choosing among same-page hits).
 * Returns [] when the work cap is hit (see the header).
 */
export function findExactHits(pages: readonly PageTextLike[], selector: TextQuoteSelector, opts: MatchOptions = {}): QuoteHit[] {
  return exactSearch(pages, selector, opts).hits;
}

function exactSearch(pages: readonly PageTextLike[], selector: TextQuoteSelector, opts: MatchOptions, budget = new WorkBudget(MAX_QUOTE_WORK, opts.budget)): { hits: QuoteHit[]; exhausted: boolean } {
  const needle = needleOf(selector.exact);
  if (!needle) return { hits: [], exhausted: false };
  const pre = selector.prefix ? needleOf(selector.prefix).slice(-MAX_NEEDLE_CHARS) : '';
  const suf = selector.suffix ? needleOf(selector.suffix).slice(0, MAX_NEEDLE_CHARS) : '';
  const ordered = orderPages(pages, opts);
  if (needle.length > MAX_NEEDLE_CHARS || tooMuchText(ordered) || budget.exhausted) return { hits: [], exhausted: true };
  const hits: QuoteHit[] = [];
  try {
    const prepared = ordered.map((p) => prepare(p));
    for (const pp of prepared) {
      const seen = new Set<number>();
      for (const { s, e } of exactRangesOnPage(pp, needle, budget)) {
        const r = toOriginalRange(pp.n1, s, e);
        if (seen.has(r.start)) continue;
        seen.add(r.start);
        hits.push({ page: pp.page, start: r.start, end: r.end, contextOk: prefixMatches(pp, pre, s, budget) && suffixMatches(pp, suf, e, budget) });
      }
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) return { hits: [], exhausted: true };
    throw err;
  }
  return { hits, exhausted: false };
}

/** Levenshtein distance (two rows), charged to the budget. Used only to score exact N2 hits. */
function levenshtein(a: string, b: string, budget: Budget): number {
  if (a === b) return 0;
  budget.charge((a.length + 1) * (b.length + 1) * WORK_UNITS.levenshteinCell);
  let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let k = 1; k <= b.length; k++) {
      cur[k] = Math.min(prev[k]! + 1, cur[k - 1]! + 1, prev[k - 1]! + (a[i - 1] === b[k - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/**
 * Bit-parallel edit distance (Myers 1999 in the block form of Hyyrö 2003; own implementation). out[j] = the
 * fewest edits that turn `pattern` into a substring of `text` ending at j (inclusive). `anchored`: the substring
 * must start at 0 (out[j] = distance(pattern, text[0..j])). Cost: text.length × ⌈m/32⌉ block steps.
 */
export function editDistanceEnds(text: string, pattern: string, anchored: boolean, budget: WorkBudget = new WorkBudget(Number.MAX_SAFE_INTEGER)): Int32Array {
  const m = pattern.length;
  const out = new Int32Array(text.length);
  if (m === 0) {
    if (anchored) for (let j = 0; j < text.length; j++) out[j] = j + 1; // delete text[0..j]
    return out;
  }
  const blocks = (m + 31) >> 5;
  budget.charge(text.length * blocks * WORK_UNITS.myersBlockStep);
  const peq = new Map<string, Int32Array>();
  for (let i = 0; i < m; i++) {
    const c = pattern[i]!;
    let masks = peq.get(c);
    if (!masks) peq.set(c, (masks = new Int32Array(blocks)));
    masks[i >> 5]! |= 1 << (i & 31);
  }
  const none = new Int32Array(blocks);
  const pv = new Int32Array(blocks).fill(-1);
  const mv = new Int32Array(blocks);
  const score = new Int32Array(blocks);
  for (let b = 0; b < blocks; b++) score[b] = Math.min((b + 1) * 32, m);
  const lastTop = 1 << ((m - 1) & 31);
  for (let j = 0; j < text.length; j++) {
    const eqs = peq.get(text[j]!) ?? none;
    let hin = anchored ? 1 : 0;
    for (let b = 0; b < blocks; b++) {
      const top = b === blocks - 1 ? lastTop : 1 << 31;
      const p = pv[b]!;
      const mm = mv[b]!;
      let eq = eqs[b]!;
      const xv = eq | mm;
      if (hin < 0) eq |= 1;
      const xh = (((eq & p) + p) ^ p) | eq;
      let ph = mm | ~(xh | p);
      let mh = p & xh;
      const hout = ph & top ? 1 : mh & top ? -1 : 0;
      ph <<= 1;
      mh <<= 1;
      if (hin < 0) mh |= 1;
      else if (hin > 0) ph |= 1;
      pv[b] = mh | ~(xv | ph);
      mv[b] = ph & xv;
      score[b]! += hout;
      hin = hout;
    }
    out[j] = score[blocks - 1]!;
  }
  return out;
}

/** First index k with arr[k] >= v (arr ascending). */
function lowerBound(arr: Uint32Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const isSep = (c: string | undefined) => c === '-' || c === ' ';
/**
 * Differences between two N1 strings whose N2 forms are equal (only case, '-' and ' ' differ): a greedy
 * alignment that pairs equal units, counts a case change or a separator on one side as one edit. An upper bound
 * of their Levenshtein distance, O(length).
 */
function separatorCaseDiff(a: string, text: string, from: number, to: number): number {
  let i = 0;
  let k = from;
  let diff = 0;
  while (i < a.length || k < to) {
    const ca = a[i];
    const cb = k < to ? text[k] : undefined;
    if (ca !== undefined && ca === cb) {
      i++;
      k++;
    } else if (isSep(ca) && !isSep(cb)) {
      diff++;
      i++;
    } else if (isSep(cb) && !isSep(ca)) {
      diff++;
      k++;
    } else {
      diff++;
      if (ca !== undefined) i++;
      if (cb !== undefined) k++;
    }
  }
  return diff;
}

interface FuzzyCandidate {
  page: number;
  start: number;
  end: number;
  score: number;
}

/** Best approximate (N2) match on one page, or null; all work charged to `budget`. */
function bestFuzzyOnPage(pp: PreparedPage, needleN1: string, needleN2: string, budget: Budget): FuzzyCandidate | null {
  const n2 = n2Of(pp);
  const len = needleN2.length;
  const maxErrors = fuzzyMaxErrors(len);
  const ends = editDistanceEnds(n2.text, needleN2, false, budget);
  let minErr = Infinity;
  for (let j = 0; j < ends.length; j++) if (ends[j]! < minErr) minErr = ends[j]!;
  if (minErr > maxErrors || 1 - minErr / len < FUZZY_MIN_SCORE) return null;
  if (minErr === 0) {
    // Exact N2 hits differ from the quote only in case, hyphens and spaces. EVERY hit is ranked by an O(quote)
    // alignment count of those differences (charged to the budget; if it runs out the quote is `unchecked`), the
    // first hit with the smallest count wins, and its score is 1 − Levenshtein(N1 quote, N1 span) / length,
    // clamped to [0.8, 0.99] (review a2: no hit is skipped).
    let best: { start: number; end: number; s1: number; e1: number; diff: number } | null = null;
    for (let j = 0; j < ends.length; j++) {
      if (ends[j] !== 0) continue;
      const r = toOriginalRange(n2, j + 1 - len, j + 1);
      const s1 = lowerBound(pp.n1.start, r.start);
      const e1 = lowerBound(pp.n1.start, r.end);
      budget.charge((needleN1.length + e1 - s1) * WORK_UNITS.levenshteinCell);
      const diff = separatorCaseDiff(needleN1, pp.n1.text, s1, e1);
      if (!best || diff < best.diff) best = { start: r.start, end: r.end, s1, e1, diff };
      if (diff === 0) break;
    }
    if (!best) return null;
    const lev = levenshtein(needleN1, pp.n1.text.slice(best.s1, best.e1), budget);
    return { page: pp.page, start: best.start, end: best.end, score: Math.min(0.99, Math.max(FUZZY_MIN_SCORE, 1 - lev / Math.max(1, needleN1.length))) };
  }
  // The first end with the fewest errors; its start from an anchored search backwards over len + maxErrors.
  let end = 0;
  while (ends[end] !== minErr) end++;
  const from = Math.max(0, end + 1 - len - maxErrors);
  const back = editDistanceEnds([...n2.text.slice(from, end + 1)].reverse().join(''), [...needleN2].reverse().join(''), true, budget);
  let k = 0;
  while (k < back.length - 1 && back[k] !== minErr) k++;
  const r = toOriginalRange(n2, end - k, end + 1);
  return { page: pp.page, start: r.start, end: r.end, score: 1 - minErr / len };
}

export function matchQuote(pages: readonly PageTextLike[], selector: TextQuoteSelector, opts: MatchOptions = {}): QuoteMatch {
  const needle = needleOf(selector.exact);
  if (!needle) return { status: 'not_found', score: 0 };
  const budget = new WorkBudget(MAX_QUOTE_WORK, opts.budget);

  const { hits, exhausted } = exactSearch(pages, selector, opts, budget);
  if (exhausted) return { status: 'unchecked', score: 0 }; // work budget or input cap: unverified, never evidence
  if (hits.length === 1) {
    const h = hits[0]!;
    return { status: 'verbatim', score: 1, position: { page: h.page, start: h.start, end: h.end } };
  }
  if (hits.length > 1) {
    const filtered = selector.prefix || selector.suffix ? hits.filter((h) => h.contextOk) : hits;
    if (filtered.length === 1) {
      const h = filtered[0]!;
      return { status: 'verbatim', score: 1, position: { page: h.page, start: h.start, end: h.end } };
    }
    return { status: 'ambiguous', score: 0, candidates: filtered.length > 0 ? filtered.length : hits.length };
  }

  if (needle.replace(/ /g, '').length < MIN_FUZZY_N1_LENGTH) return { status: 'not_found', score: 0 };
  const needleN2 = normalizeN2(selector.exact).text;
  if (!needleN2) return { status: 'not_found', score: 0 };
  let best: FuzzyCandidate | null = null;
  try {
    for (const p of orderPages(pages, opts)) {
      const c = bestFuzzyOnPage(prepare(p), needle, needleN2, budget);
      if (!c) continue;
      if (opts.pageHint !== undefined && p.page === opts.pageHint) {
        best = c; // pageHint wins for fuzzy
        break;
      }
      if (!best || c.score > best.score) best = c;
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: 'unchecked', score: 0 };
    throw err;
  }
  if (!best) return { status: 'not_found', score: 0 };
  return { status: 'fuzzy', score: best.score, position: { page: best.page, start: best.start, end: best.end } };
}

/**
 * True when `text` as a whole equals `quote` in N1, allowing the line-end hyphens of `text` to be kept or
 * dropped and the same word-boundary rule as matchQuote.
 * Used by the web re-check of a DOM Range (PLAN 5.3: the Range text must equal the quote before anything is
 * highlighted). False when the work cap is hit.
 */
export function quoteEqualsN1(quote: string, text: string): boolean {
  const needle = needleOf(quote);
  if (!needle) return false;
  if (needle.length > MAX_NEEDLE_CHARS || text.length > MAX_TEXT_CHARS) return false;
  const budget = new WorkBudget(MAX_QUOTE_WORK);
  try {
    return wholeEquals(text, needle, budget);
  } catch (err) {
    if (err instanceof BudgetExhausted) return false;
    throw err;
  }
}
