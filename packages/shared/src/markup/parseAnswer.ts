// SP-Markup v1 parser (PLAN 5.1, 5.2). Owner B (chip provenance redesigned after review B1).
//
// Rules:
// - Tags and labels are recognised only outside code and math: fenced code (``` / ~~~), math fences ($$),
//   indented code blocks, inline code and inline math ($…$). The scanner follows the CommonMark / micromark
//   rules the renderer uses (same delimiters, backslash escapes, no crossing of a blank line).
// - <q>…</q>: one verbatim span; no nesting (nested → text + issue), ≤ 600 chars and ≤ 40 per message
//   (beyond → plain text + issue), empty → text + issue. Whitespace inside is collapsed.
// - <eq n="4"/>: self-closing only, n = [A-Za-z]?\.?\d+[a-z]?; other <eq …> shapes stay text (+ issue). ≤ 40 per content
//   (MAX_EQ_REFS_PER_MESSAGE, S-2 — a message or one card item body), counted apart from <q>; beyond → the escaped tag
//   text (never a chip) + one issue per extra reference. An extra reference is plain text for the label rules too.
// - [[P]] / [[N]] / [[G]]: a label as the LAST token of a block (paragraph, list item, heading, table row —
//   i.e. the end of the row's last cell); citations and punctuation may still follow it. Inside a block (not a
//   table row) a label right after a sentence end (. ! ? 。) or right after a citation closes a labelled SEGMENT:
//   the parser block covers the text since the previous segment, the label and the citations directly after
//   it; the rest of the block is the next segment. Any other label (mid-sentence, escaped \[[P]]) is text.
// - Raw HTML is never interpreted: every `<` left in model text (outside code/math) that could open a tag,
//   comment or autolink is backslash-escaped, so the Markdown AST has no html node that could hide a citation
//   or a label (it renders as the same literal text). Backticks and dollars the parser did not pair into a
//   code/math span are escaped too, so the renderer cannot form a span (and hide a chip) the parser did not see,
//   and so is `[^` (GFM footnotes are not shown next to the text, so they stay literal text).
// - Chip provenance (review B1): the parser alone issues chips. Each chip is written as
//   `\u0003<kind><id>\u0004[text](#sp-…)`: kind `c` = quote citation, `e` = equation reference (id = citation
//   ordinal), `b` = label badge (id = index into `blocks`). Control characters are removed from the model text
//   first and Markdown entities cannot produce them, so model-written links (`[x](#sp-…)`, `<#sp-…>`, titles,
//   reference definitions, nesting) never carry the marker; the renderer admits only marked links and pairs a
//   badge with ITS block by id, never by counting.
// - A citation or label that would land where Markdown hides or moves it (image alt text, a link title or
//   destination, a link reference definition) is demoted to plain text + issue, so stats (from `blocks`) and
//   the rendered chips/badges agree. Ordinals are renumbered 1, 2, 3, … over the surviving citations.
// - Optional trailing <glossary><term name="…">…</term></glossary> (outside code): the last one is taken
//   (≤ 3 terms), earlier ones stay text + issue.
// - Unknown tags stay text. An unclosed <q> or a stray </q> in the final text stays text + issue.
// - Streaming (final: false): the text is cut by streamingSafePrefix() first — an open <q> body, a half-written
//   known tag, an open <glossary> and a trailing [[ fragment are held back — and no end-of-text issues are made.
// - Options (M2, PLAN_M2 3.4; the type is contracts/markupApi.ts). The defaults (markup + badge) are the M1 output
//   byte for byte (parseAnswer.compat.test.ts). mode 'plain' (translations, notes, user memos): <q>, <eq>, labels and
//   <glossary> are not interpreted — they stay as (escaped) text, citations / blocks / glossary are empty, HTML and
//   link neutralisation is the same. labels 'strip' (notation / assumption card item bodies, whose label is the item
//   attribute): every unescaped [[P]] / [[N]] / [[G]] outside code is removed from the display and no block gets a
//   label (an issue counts them); quote and equation chips stay. In strip mode an HTML comment (`<!-- … -->`) is
//   text: a <q> / <eq> inside it is not a citation (the comment shows as literal text, but a card item never takes a
//   citation the model hid in a comment — blocks_adversarial/forged_item_badge).
import type { ParsedAnswer, ParsedBlock, RawCitation, TermSuggestion } from '../contracts/domain';
import type { ParseOptions } from '../contracts/markupApi';
import {
  EQ_TAG_SOURCE,
  GLOSSARY_SOURCE,
  GLOSSARY_TERM_SOURCE,
  KNOWN_TAG_PREFIXES,
  LABEL_TOKEN_SOURCE,
  MAX_GLOSSARY_TERMS,
  MAX_QUOTE_CHARS,
  MAX_EQ_REFS_PER_MESSAGE,
  MAX_QUOTES_PER_MESSAGE,
  QUOTE_CLOSE,
  QUOTE_OPEN,
  RESERVED_HREF_PREFIX,
  STREAM_HOLDBACK_MAX_CHARS,
  chipHref,
  chipText,
} from './grammar';

type Segment = { code: boolean; text: string };

/** Marker before every parser-issued chip link (see the header). U+0003 / U+0004 never survive in model text. */
export const CHIP_MARK_OPEN = '\u0003';
export const CHIP_MARK_CLOSE = '\u0004';
export type ChipKind = 'c' | 'e' | 'b';
export const chipMark = (kind: ChipKind, id: number) => `${CHIP_MARK_OPEN}${kind}${id}${CHIP_MARK_CLOSE}`;
/** A chip marker at the end of a string (the renderer reads it from the text node before the link). */
export const CHIP_MARK_AT_END_RE = /\u0003([ceb])(\d+)\u0004$/;
/** Every chip marker (to strip leftovers wherever a marker did not end up right before its link). */
export const CHIP_MARK_RE = /\u0003[ceb]\d+\u0004/g;

const LIST_ITEM_RE = /^([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const BLOCKQUOTE_PREFIX_RE = /^( {0,3}>[ \t]?)+/;
/** LIST_ITEM_RE at a given offset (sticky): `$` is the end of the whole string, i.e. of the tail it starts. */
const LIST_ITEM_AT_RE = /([-*+]|\d{1,9}[.)])([ \t]+|$)/y;

/** Index of the last character that `String.prototype.trim` keeps (`\s` is the same set), or -1. */
function lastNonWhitespace(s: string, work: MarkupWork): number {
  let i = s.length - 1;
  while (i >= 0 && WS_RE.test(s[i]!)) i--;
  work.steps += s.length - i;
  return i;
}

/** The deepest entry of a strictly increasing stack that is ≤ `ind` (0 when none). One work step (≤ 53 halvings). */
function deepestAtMost(stack: readonly number[], ind: number, work: MarkupWork): number {
  let lo = 0;
  let hi = stack.length; // answer index is lo - 1 after the loop
  work.steps++;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stack[mid]! <= ind) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? stack[lo - 1]! : 0;
}

interface SuffixThematic {
  at(off: number): boolean;
}

/**
 * `THEMATIC_BREAK_RE.test(s.slice(off))` for any offset, after one right-to-left pass over `s`: the suffix is a thematic
 * break when it starts (after at most 3 spaces) with `-`, `*` or `_` and holds nothing but that character (3 or more
 * times), spaces and tabs.
 */
function suffixThematic(s: string, work: MarkupWork): SuffixThematic {
  const n = s.length;
  const marks = new Int32Array(n + 1); // characters other than space / tab in s[p..]
  let uniformFrom = n; // smallest p where all of those characters in s[p..] are the same one
  let ch = '';
  let uniform = true;
  for (let p = n - 1; p >= 0; p--) {
    const c = s[p]!;
    if (c === ' ' || c === '\t') marks[p] = marks[p + 1]!;
    else {
      marks[p] = marks[p + 1]! + 1;
      if (uniform && ch !== '' && c !== ch) uniform = false;
      ch = c;
    }
    if (uniform) uniformFrom = p;
  }
  work.steps += n + 1;
  return {
    at(off: number): boolean {
      let p = off;
      while (p < n && p - off < 3 && s[p] === ' ') p++;
      const c = s[p];
      if (c !== '-' && c !== '*' && c !== '_') return false;
      return p >= uniformFrom && marks[p]! >= 3;
    },
  };
}

/** Indentation in columns (tab = next multiple of 4). */
function indentOf(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** Tabs → spaces up to the next multiple of 4 (CommonMark tab stops), so block structure needs no tab rules. */
export function expandTabs(text: string): string {
  if (!text.includes('\t')) return text;
  return text
    .split('\n')
    .map((line) => {
      let out = '';
      for (const ch of line) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch;
      return out;
    })
    .join('\n');
}

/**
 * Splits text into code (fenced code, $$ math fences, indented code blocks — kept verbatim) and normal segments,
 * following the CommonMark block rules closely enough for those three (tabs already expanded):
 * - list items are tracked by their content column: a continuation indented by 4+ columns is not code, while
 *   `-     x` starts code inside the item; an empty item followed by a blank line is closed; an empty item or an
 *   ordered item not starting at 1 cannot interrupt a paragraph; a fence may open right after a list marker and
 *   ends with its list item;
 * - an indented line is code only when no paragraph is open (after a blank line, a heading, a thematic break, a
 *   setext underline, a closed fence, or at the start of a blockquote);
 * - blockquote markers are looked through; entering or leaving a blockquote resets the list context, and a
 *   fence opened inside a blockquote ends at the first line outside it.
 */
export function splitFences(text: string, work: MarkupWork = { steps: 0 }): Segment[] {
  const lines = text.split('\n');
  const out: Segment[] = [];
  let cur: string[] = [];
  let mode = 'text' as 'text' | 'fence' | 'math' | 'indent';
  let fenceChar = '';
  let fenceLen = 0;
  let codeBase = 0;
  let fenceQuoted = false;
  let openParagraph = false;
  let prevQuoted = false;
  let emptyItemPending = false;
  const lists: number[] = [];
  const flush = (code: boolean) => {
    if (cur.length) out.push({ code, text: cur.join('\n') });
    cur = [];
  };
  const popTo = (ind: number) => {
    while (lists.length && lists[lists.length - 1]! > ind) lists.pop();
  };
  const openFence = (seq: string, kind: 'fence' | 'math', base: number, quoted: boolean, line: string) => {
    flush(false);
    mode = kind;
    fenceChar = seq[0]!;
    fenceLen = seq.length;
    codeBase = base;
    fenceQuoted = quoted;
    cur.push(line);
  };
  const FENCE_OPEN = /^(`{3,})[^`]*$|^(~{3,})/;
  const MATH_OPEN = /^(\${2,})[^$]*$/;
  for (const rawLine of lines) {
    // A fixed number of anchored, linear passes over the line below (regexes, indentOf, trims).
    work.steps += rawLine.length + 1;
    const quoted = BLOCKQUOTE_PREFIX_RE.test(rawLine);
    const line = rawLine.replace(BLOCKQUOTE_PREFIX_RE, '');
    const ind = indentOf(line);
    const body = line.trimStart();
    const blank = body.trim() === '';
    if (mode === 'fence' || mode === 'math') {
      // A fence opened outside a blockquote sees `>` as content: judge the raw line then.
      const fl = fenceQuoted ? line : rawLine;
      const find = indentOf(fl);
      const containerEnded = (fenceQuoted && !quoted) || (fl.trim() !== '' && codeBase > 0 && find < codeBase);
      if (!containerEnded) {
        cur.push(rawLine);
        const close = mode === 'fence' ? new RegExp(`^\\${fenceChar}{${fenceLen},}[ ]*$`) : new RegExp(`^\\$\{${fenceLen},}[ ]*$`);
        if (find - codeBase <= 3 && close.test(fl.trimStart())) {
          flush(true);
          mode = 'text';
          openParagraph = false;
        }
        prevQuoted = quoted;
        continue;
      }
      flush(true);
      mode = 'text';
      openParagraph = false;
    }
    if (quoted !== prevQuoted) {
      lists.length = 0;
      if (quoted) openParagraph = false; // a new blockquote starts with no open paragraph
    }
    prevQuoted = quoted;
    if (mode === 'indent') {
      if (blank || ind >= codeBase + 4) {
        cur.push(rawLine);
        continue;
      }
      flush(true);
      mode = 'text';
      openParagraph = false;
    }
    if (blank) {
      cur.push(rawLine);
      if (emptyItemPending) lists.pop(); // an item that starts empty ends at a blank line
      emptyItemPending = false;
      openParagraph = false;
      continue;
    }
    emptyItemPending = false;
    if (!openParagraph) popTo(ind);
    // The list item this line can belong to: the deepest one whose content column it reaches. `lists` is strictly
    // increasing (every push is past the previous top), so a binary search finds it without copying the stack, which a
    // line of many markers makes long (review B-R2-01).
    const eff = deepestAtMost(lists, ind, work);
    const rel = ind - eff;
    const fence = rel <= 3 ? FENCE_OPEN.exec(body) : null;
    const math = rel <= 3 ? MATH_OPEN.exec(body) : null;
    if (fence || math) {
      popTo(ind);
      openFence(fence ? (fence[1] ?? fence[2]!) : math![1]!, fence ? 'fence' : 'math', eff, quoted, rawLine);
      continue;
    }
    if (!openParagraph && rel >= 4) {
      flush(false);
      mode = 'indent';
      codeBase = eff;
      cur.push(rawLine);
      continue;
    }
    const thematic = THEMATIC_BREAK_RE.test(line);
    const li = rel <= 3 && !thematic ? LIST_ITEM_RE.exec(body) : null;
    if (li) {
      const rest = body.slice(li[0].length);
      const empty = rest.trim() === '';
      const interrupting = openParagraph && (lists.length === 0 || ind >= lists[lists.length - 1]!);
      if (!(interrupting && (empty || (/\d/.test(li[1]!) && !/^0*1[.)]$/.test(li[1]!))))) {
        popTo(ind);
        // Peel the container markers that start this line: list items, possibly nested (`2. - x`), and a
        // blockquote opened inside an item (`1. > x`).
        // The tail of the line is tracked as an offset into `body` (never sliced or rescanned per marker): whether the
        // rest is blank and whether it is a thematic break come from one right-to-left pass (review B-R2-01).
        let at = ind;
        let m: RegExpExecArray | null = li;
        let off = 0; // the tail is body.slice(off)
        let kind: 'paragraph' | 'empty' | 'code' | 'fence' = 'paragraph';
        let codeAt = 0;
        const lastSolid = lastNonWhitespace(body, work);
        let suffix: SuffixThematic | null = null;
        while (m) {
          work.steps += m[0].length + 1;
          const spaces = indentOf(m[2] ?? '');
          const restAt = off + m[0].length;
          const content = at + m[1]!.length + (spaces === 0 || spaces > 4 ? 1 : spaces);
          lists.push(content);
          if (restAt > lastSolid) {
            kind = 'empty';
            break;
          }
          if (spaces > 4) {
            kind = 'code'; // `-     code`: the item starts with an indented code block
            codeAt = content;
            break;
          }
          off = restAt;
          at = content;
          if (body[off] === '>') {
            const inner = body.slice(off).replace(/^(>[ ]?)+/, '');
            if (indentOf(inner) >= 4) {
              kind = 'code'; // a blockquote opened here has no paragraph yet
              codeAt = Number.MAX_SAFE_INTEGER;
            }
            break;
          }
          suffix ??= suffixThematic(body, work);
          if (suffix.at(off)) m = null;
          else {
            LIST_ITEM_AT_RE.lastIndex = off;
            m = LIST_ITEM_AT_RE.exec(body);
          }
        }
        const tail = body.slice(off);
        if (kind === 'empty') {
          emptyItemPending = true;
          openParagraph = false;
          cur.push(rawLine);
          continue;
        }
        if (kind === 'code') {
          flush(false);
          mode = 'indent';
          codeBase = codeAt;
          cur.push(rawLine);
          continue;
        }
        const restFence = FENCE_OPEN.exec(tail) ?? MATH_OPEN.exec(tail);
        if (restFence) {
          openFence(restFence[1] ?? restFence[2]!, restFence[0].startsWith('$') ? 'math' : 'fence', at, quoted, rawLine);
          continue;
        }
        openParagraph = true;
        cur.push(rawLine);
        continue;
      }
    }
    const heading: boolean = /^#{1,6}(?:[ \t]|$)/.test(body) && rel <= 3;
    const setext: boolean = openParagraph && /^(?:=+|-+)[ \t]*$/.test(body) && rel <= 3;
    openParagraph = !(heading || setext || thematic);
    cur.push(rawLine);
  }
  flush(mode !== 'text');
  // Re-join with the newline that split() removed between segments.
  return out.map((s, i) => (i < out.length - 1 ? { ...s, text: `${s.text}\n` } : s));
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
/** A line that starts a new Markdown block: inline code / math never continues across it. */
const BLOCK_START_LINE = /^\s*(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}\s|\||>|<|`{3,}|~{3,})/;

/**
 * Inline code and inline math spans ([start, end) incl. delimiters) of a text segment, CommonMark-style: a run
 * of N backticks (or N dollars) is closed by the next run of exactly N, a backslash escapes an opener, and a
 * span never crosses a blank line or the start of a new block.
 *
 * Linear (review B-R2-01): instead of scanning forward from every opener (an opener that finds no closer rescanned
 * the rest of its paragraph, so runs of many distinct lengths cost O(n·√n)), the maximal runs of each character
 * and length and the stop lines are listed once; an opener of N then takes the first run of exactly N that starts
 * after it, if no stop line comes first. Same spans as the forward scan: that scan steps over whole maximal runs
 * from the end of the opener's run, so the first run of exactly N it meets is the first such maximal run after it.
 */
export function literalSpans(text: string, work: MarkupWork = { steps: 0 }): [number, number][] {
  const spans: [number, number][] = [];
  // Maximal runs of ` and $, by character and length, in text order.
  const runs = new Map<string, { starts: number[]; next: number }>();
  for (let p = 0; p < text.length; ) {
    const c = text[p]!;
    if (c !== '`' && c !== '$') {
      p++;
      continue;
    }
    let k = 1;
    while (text[p + k] === c) k++;
    const key = c + k;
    const list = runs.get(key);
    if (list) list.starts.push(p);
    else runs.set(key, { starts: [p], next: 0 });
    p += k;
  }
  // Stop lines: a '\n' whose next line is blank or starts a new block ends every span search that reaches it.
  const stops: number[] = [];
  for (let j = text.indexOf('\n'); j >= 0; ) {
    const nl = text.indexOf('\n', j + 1);
    const next = text.slice(j + 1, nl < 0 ? text.length : nl);
    if (next.trim() === '' || BLOCK_START_LINE.test(next)) stops.push(j);
    j = nl;
  }
  work.steps += 2 * text.length + 2;
  let stopAt = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < text.length && ASCII_PUNCT.test(text[i + 1]!)) {
      i += 2;
      continue;
    }
    if (c !== '`' && c !== '$') {
      i++;
      continue;
    }
    let n = 1;
    while (text[i + n] === c) n++;
    const from = i + n; // the forward scan started here; openers come in text order, so `from` only grows
    while (stopAt < stops.length && stops[stopAt]! < from) stopAt++;
    const limit = stopAt < stops.length ? stops[stopAt]! : Infinity;
    const list = runs.get(c + n);
    let found = -1;
    if (list) {
      while (list.next < list.starts.length && list.starts[list.next]! < from) list.next++;
      const p = list.starts[list.next];
      if (p !== undefined && p < limit) found = p;
    }
    work.steps += n + 1;
    if (found >= 0) {
      spans.push([i, found + n]);
      i = found + n;
    } else i += n;
  }
  return spans;
}

/** Same length as `text`, inline code / math spans blanked (for position searches). */
function maskLiteralSpans(text: string, work: MarkupWork = { steps: 0 }): string {
  // One piece per span (rebuilding the whole string per span was quadratic on many spans — review B-R1-02).
  const pieces: string[] = [];
  let at = 0;
  for (const [s, e] of literalSpans(text, work)) {
    pieces.push(text.slice(at, s), '\u0000'.repeat(e - s));
    at = e;
  }
  if (!pieces.length) return text;
  pieces.push(text.slice(at));
  return pieces.join('');
}

const PLACEHOLDER = (i: number) => `\u0000${i}\u0000`;
const PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;

/**
 * Work counter for the linearity test (reviews B-R1-02, B-R2-01): one step per character the hand-written scans look
 * at (escapeInline, the strip-mode label removal, neutraliseReservedLinks, literalSpans, the table delimiter row, the
 * list-marker peel), and for the block passes (splitFences, applyLabels, the unsafe-range scan) the length of each
 * line or block a fixed number of anchored regexes run over. So a loop that runs a regex over the rest of a line or
 * block once per item shows up as super-linear steps. The regular expressions themselves are written so that they
 * never rescan a run of the input per start position (see each one); that part is judged by a wall-clock bound.
 */
export interface MarkupWork {
  steps: number;
}

const WS_RE = /\s/;

/**
 * Model-written links to #sp-… become plain text (defence in depth: the renderer never admits them anyway).
 * Same result as `text.replace(/\[([^\]\n]*)\]\((#sp-[^)\s]*)\)/g, '\\[$1\\]($2)')` in one pass: a `[` reaches the
 * first `]` or newline after it, and every other `[` before that point reaches the same one, so a failed start
 * is never retried inside its own label; the destination run is scanned once (cached) for a whole chain of
 * `[a](#sp-[a](#sp-…` starts.
 */
function neutraliseReservedLinks(text: string, work: MarkupWork): string {
  const OPEN = `](${RESERVED_HREF_PREFIX}`;
  let out = '';
  let copied = 0;
  let i = 0;
  let destFrom = -1;
  let destEnd = -1; // [destFrom, destEnd): a scanned run without `)` or whitespace; text[destEnd] ends it (or end)
  while (i < text.length) {
    const p = text.indexOf('[', i);
    if (p < 0) break;
    let q = p + 1;
    while (q < text.length && text[q] !== ']' && text[q] !== '\n') q++;
    work.steps += q - i + 1;
    if (q >= text.length) break;
    i = q + 1;
    if (text[q] !== ']' || !text.startsWith(OPEN, q)) continue;
    const from = q + OPEN.length;
    let r: number;
    if (from >= destFrom && from <= destEnd) r = destEnd;
    else {
      r = from;
      while (r < text.length && text[r] !== ')' && !WS_RE.test(text[r]!)) r++;
      work.steps += r - from + 1;
      destFrom = from;
      destEnd = r;
    }
    if (r >= text.length || text[r] !== ')') continue;
    out += `${text.slice(copied, p)}\\[${text.slice(p + 1, q)}\\](${text.slice(q + 2, r)})`;
    copied = r + 1;
    i = r + 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

const ESCAPE_AFTER_LT_RE = /[A-Za-z/!?]/;

/**
 * Backslash-escapes, where not already escaped, every `<` that could start raw HTML (a tag, closing tag, comment,
 * declaration, processing instruction) or an autolink — so the renderer never sees an html node; `a < b` and
 * `x<5` stay as written — and every backtick / dollar outside the code and math spans the parser found, so the
 * renderer cannot pair them into a span the parser did not see (it renders the same literal characters).
 * Used only on text outside literal spans (they are placeholders at that point).
 * One pass with a running backslash count (same result as the M1 `/(\\*)(<(?=[A-Za-z/!?])|`|\$|\[(?=\^))/g`
 * replace, which rescanned a backslash run from every position in it — review B-R1-02): a target character
 * preceded by an even run (zero included) gets one more backslash.
 */
function escapeInline(text: string, work: MarkupWork): string {
  let out = '';
  let copied = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\') {
      run++;
      continue;
    }
    const target = c === '`' || c === '$' || (c === '<' && i + 1 < text.length && ESCAPE_AFTER_LT_RE.test(text[i + 1]!)) || (c === '[' && text[i + 1] === '^');
    if (target && run % 2 === 0) {
      out += `${text.slice(copied, i)}\\`;
      copied = i;
    }
    run = 0;
  }
  work.steps += text.length + 1;
  return out === '' ? text : out + text.slice(copied);
}

/**
 * Strip mode: removes every `[[P]]` / `[[N]]` / `[[G]]` that is not escaped (an odd run of backslashes right before
 * `[[` escapes it), until none is left: a removal can join the text around it into a new token (`[[[[P]]P]]` →
 * `[[P]]`, review B-I10-01), so the kept characters are a stack and each pushed `]` checks whether the stack now
 * ends in a token. Each character is pushed once and popped at most once; the backslash run before any stack
 * position is kept with it, so the escape check is O(1). Returns the text and how many tokens were removed.
 */
function stripLabelTokens(text: string, work: MarkupWork): { text: string; removed: number } {
  const kept: string[] = [];
  const runs: number[] = []; // runs[j] = backslashes ending at kept[j] (0 when kept[j] is not a backslash)
  let removed = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = kept.length;
    runs.push(c === '\\' ? (n > 0 ? runs[n - 1]! : 0) + 1 : 0);
    kept.push(c);
    const t = n - 4; // the token's first index if the stack now ends in one
    if (c === ']' && t >= 0 && kept[n - 1] === ']' && (kept[n - 2] === 'P' || kept[n - 2] === 'N' || kept[n - 2] === 'G') && kept[t + 1] === '[' && kept[t] === '[' && (t > 0 ? runs[t - 1]! : 0) % 2 === 0) {
      kept.length = t;
      runs.length = t;
      removed++;
    }
  }
  work.steps += text.length + 1;
  return { text: removed === 0 ? text : kept.join(''), removed };
}

/**
 * `re` (global) over `text`, where `re` is `OPEN([\s\S]*?)CLOSE` or an alternation starting with it: a lazy body
 * that finds no CLOSE scans to the end of the text, so a start after the last CLOSE would rescan the tail once per
 * start (quadratic on many unclosed OPENs). Every match of that alternative ends at or before the end of the last
 * CLOSE, and no match of the other alternatives crosses that point (none contains CLOSE's last character `>` before
 * its own end), so the text after it is run with `tailRe` (the other alternatives only, or nothing) — same matches,
 * same order (review B-R1-02).
 */
function replaceBeforeLastClose(text: string, close: string, re: RegExp, tailRe: RegExp | null, fn: (m: string, inner: string | undefined, eqN: string | undefined) => string): string {
  const last = text.lastIndexOf(close);
  const cut = last < 0 ? 0 : last + close.length;
  const head = cut > 0 ? text.slice(0, cut).replace(re, (m: string, inner: string | undefined, eqN: string | undefined) => fn(m, inner, eqN)) : '';
  const rest = text.slice(cut);
  return head + (tailRe ? rest.replace(tailRe, (m: string, eqN: string) => fn(m, undefined, eqN)) : rest);
}

export type { ParseOptions };

/** Private tokens: citation (by provisional ordinal) and label (by block index). Replaced by chips at the end. */
const citationToken = (ordinal: number) => `\u0001${ordinal}\u0001`;
const CITATION_TOKEN_RE = /\u0001(\d+)\u0001/g;
/**
 * An equation reference past MAX_EQ_REFS_PER_MESSAGE (S-2): text, not a citation. Its own token (index into
 * `extraEqSources`) uses another control character than the citation token, so CITATION_TOKEN_RE never matches it nor
 * across it (its closing mark + model digits + a citation's opening mark) and the label rules treat it as any other
 * word (review B-F1-01): a label right after it is not "after a citation", and it is not a citation that may follow a
 * block-end label. The malformed-<eq> check never sees the tag. Replaced by the escaped tag text at the end.
 */
const extraEqToken = (i: number) => `\u0005${i}\u0005`;
const EXTRA_EQ_TOKEN_RE = /\u0005(\d+)\u0005/g;
const labelToken = (block: number) => `\u0002${block}\u0002`;
const LABEL_TOKEN_RE = /\u0002(\d+)\u0002/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const BAD_EQ_RE = /<eq\b[^>\n]{0,80}>/;
/** A whitespace-free run ending right before a chip that GFM would turn into an autolink literal (it would swallow the chip). */
const AUTOLINK_TAIL_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|@)\S*$/i;

interface GlossaryHit {
  seg: number;
  start: number;
  end: number;
  inner: string;
}

/** An HTML comment (to its end, or to the end of the text when it is not closed). */
const GLOSSARY_CLOSE = '</glossary>';
const TERM_CLOSE = '</term>';
const HTML_COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;

/** `work` (tests only) counts the steps of the hand-written scans (MarkupWork). */
export function parseAnswer(raw: string, opts: ParseOptions = { final: true }, work: MarkupWork = { steps: 0 }): ParsedAnswer {
  const final = opts.final !== false;
  const plain = opts.mode === 'plain';
  const strip = !plain && opts.labels === 'strip';
  const issues: string[] = [];
  const citations: RawCitation[] = [];
  const sources: string[] = []; // original tag text per provisional ordinal (for demotion)
  const extraEqSources: string[] = []; // original tag text of the <eq> past MAX_EQ_REFS_PER_MESSAGE
  const glossary: TermSuggestion[] = [];

  // Control characters never survive: the parser uses U+0000–U+0005 as private placeholders and chip markers, so
  // model text cannot forge a placeholder, a citation token or a chip marker.
  const cleaned = raw.replace(CONTROL_CHARS_RE, '');
  if (cleaned.length !== raw.length) issues.push('control characters removed');
  raw = expandTabs(final ? cleaned : streamingSafePrefix(cleaned));

  const segments = splitFences(raw, work);

  // Glossary: the last <glossary> block outside code and math.
  let hit: GlossaryHit | null = null;
  let glossaryBlocks = 0;
  segments.forEach((seg, i) => {
    if (seg.code || plain) return;
    const masked = maskLiteralSpans(seg.text, work);
    // Only up to the end of the last </glossary>: a lazy body never matches past it (replaceBeforeLastClose).
    const lastClose = masked.lastIndexOf(GLOSSARY_CLOSE);
    if (lastClose < 0) return;
    for (const m of masked.slice(0, lastClose + GLOSSARY_CLOSE.length).matchAll(new RegExp(GLOSSARY_SOURCE, 'g'))) {
      glossaryBlocks++;
      hit = { seg: i, start: m.index, end: m.index + m[0].length, inner: seg.text.slice(m.index + '<glossary>'.length, m.index + m[0].length - '</glossary>'.length) };
    }
  });
  if (hit) {
    const g: GlossaryHit = hit;
    if (glossaryBlocks > 1) issues.push('more than one <glossary>: only the last one is used');
    const lastTerm = g.inner.lastIndexOf(TERM_CLOSE);
    for (const t of g.inner.slice(0, lastTerm < 0 ? 0 : lastTerm + TERM_CLOSE.length).matchAll(new RegExp(GLOSSARY_TERM_SOURCE, 'g'))) {
      if (glossary.length >= MAX_GLOSSARY_TERMS) {
        issues.push(`glossary: more than ${MAX_GLOSSARY_TERMS} terms, extra terms ignored`);
        break;
      }
      const term = t[1]!.trim();
      const definition = t[2]!.trim();
      if (term && definition) glossary.push({ term, definition });
    }
    const s = segments[g.seg]!;
    segments[g.seg] = { code: false, text: s.text.slice(0, g.start) + s.text.slice(g.end) };
  }

  // Literal spans (inline code / math) become placeholders until the very end.
  const saved: string[] = [];
  const restore = (s: string) => s.replace(PLACEHOLDER_RE, (_, i: string) => saved[Number(i)]!);

  let ordinal = 0;
  let quoteCount = 0;
  let eqRefCount = 0;
  let strippedLabels = 0;
  let commentTags = 0;
  const parts = segments.map((seg) => {
    if (seg.code) return { code: true, text: seg.text };
    let text = '';
    let at = 0;
    for (const [s, e] of literalSpans(seg.text, work)) {
      text += seg.text.slice(at, s) + PLACEHOLDER(saved.length);
      saved.push(seg.text.slice(s, e));
      at = e;
    }
    text += seg.text.slice(at);
    let s = neutraliseReservedLinks(text, work);
    if (plain) return { code: false, text: escapeInline(s, work) };
    // <q>…</q> and <eq n="…"/> in one left-to-right pass so ordinals follow the text order.
    const tagRe = new RegExp(`<q>([\\s\\S]*?)</q>|${EQ_TAG_SOURCE}`, 'g');
    const eqTagRe = new RegExp(EQ_TAG_SOURCE, 'g');
    const replaceTags = (part: string) => replaceBeforeLastClose(part, QUOTE_CLOSE, tagRe, eqTagRe, (m, inner, eqN) => {
      if (eqN !== undefined) {
        if (eqRefCount >= MAX_EQ_REFS_PER_MESSAGE) {
          // S-2: past the limit the reference stays text (extraEqToken; written back as the escaped tag at the end).
          issues.push(`more than ${MAX_EQ_REFS_PER_MESSAGE} <eq> in one message: extra kept as text`);
          extraEqSources.push(m);
          return extraEqToken(extraEqSources.length - 1);
        }
        eqRefCount++;
        ordinal++;
        sources.push(m);
        citations.push({ ordinal, kind: 'equation', eqNumber: eqN });
        return citationToken(ordinal);
      }
      const body = restore(inner ?? '');
      if (body.includes(QUOTE_OPEN)) {
        issues.push('nested <q> kept as text');
        return m;
      }
      const quote = body.replace(/\s+/g, ' ').trim();
      if (!quote) {
        issues.push('empty <q> kept as text');
        return m;
      }
      if (quote.length > MAX_QUOTE_CHARS) {
        issues.push(`<q> longer than ${MAX_QUOTE_CHARS} chars kept as text`);
        return inner ?? '';
      }
      if (quoteCount >= MAX_QUOTES_PER_MESSAGE) {
        issues.push(`more than ${MAX_QUOTES_PER_MESSAGE} <q> in one message: extra kept as text`);
        return inner ?? '';
      }
      quoteCount++;
      ordinal++;
      citations.push({ ordinal, kind: 'quote', quote });
      sources.push(m);
      return citationToken(ordinal);
    });
    if (strip) {
      // HTML comments are text in strip mode: tags inside them are not interpreted (see the header).
      let rebuilt = '';
      let at = 0;
      for (const c of s.matchAll(HTML_COMMENT_RE)) {
        rebuilt += replaceTags(s.slice(at, c.index)) + c[0];
        at = c.index + c[0].length;
        if (/<q>|<eq\b/.test(c[0])) commentTags++;
      }
      s = rebuilt + replaceTags(s.slice(at));
      const stripped = stripLabelTokens(s, work);
      s = stripped.text;
      strippedLabels += stripped.removed;
    } else s = replaceTags(s);
    if (final) {
      if (s.includes(QUOTE_OPEN)) issues.push('unclosed <q> kept as text');
      if (s.includes(QUOTE_CLOSE)) issues.push('stray </q> kept as text');
      if (BAD_EQ_RE.test(s)) issues.push('<eq> that is not <eq n="…"/> kept as text');
    }
    return { code: false, text: escapeInline(s, work) };
  });

  if (strippedLabels) issues.push(`${strippedLabels} label token(s) removed (labels: strip)`);
  if (commentTags) issues.push(`${commentTags} HTML comment(s) with tags kept as text`);
  if (plain) return { displayMd: restore(joinSegments(parts)), citations: [], blocks: [], glossary: [], issues };

  const labelled = applyLabels(parts, work);
  const blocks = labelled.blocks;

  // Demote citations / labels that Markdown would hide or move (see the header).
  const demotedCitations = new Set<number>();
  const demotedLabels = new Set<number>();
  for (const b of labelled.blockTexts) {
    for (const [s, e] of unsafeRanges(b, work)) {
      work.steps += e - s;
      markTokens(b.slice(s, e), demotedCitations, demotedLabels);
    }
  }
  if (demotedCitations.size) issues.push(`${demotedCitations.size} citation(s) inside a link title, image text or link definition kept as text`);
  if (demotedLabels.size) issues.push(`${demotedLabels.size} label(s) inside a link title, image text or link definition kept as text`);

  // Renumber the surviving citations 1, 2, 3, … in text order.
  const renumber = new Map<number, number>();
  const finalCitations: RawCitation[] = [];
  for (const c of citations) {
    if (demotedCitations.has(c.ordinal)) continue;
    renumber.set(c.ordinal, finalCitations.length + 1);
    finalCitations.push({ ...c, ordinal: finalCitations.length + 1 });
  }
  const finalBlocks: ParsedBlock[] = blocks.map((b, k) => {
    const out: ParsedBlock = { citationOrdinals: b.citationOrdinals.filter((o) => renumber.has(o)).map((o) => renumber.get(o)!) };
    if (b.label && !demotedLabels.has(k)) out.label = b.label;
    return out;
  });

  // Tokens → chips. Only now do citation and label tokens become (marked) chip links.
  const body = labelled.displayMd;
  const out = body
    .replace(CITATION_TOKEN_RE, (_m, n: string, offset: number, whole: string) => {
      const old = Number(n);
      const ordinalNow = renumber.get(old);
      if (ordinalNow === undefined) return escapeInline(sources[old - 1] ?? '', work);
      const c = finalCitations[ordinalNow - 1]!;
      const chip = c.kind === 'equation' ? chipMark('e', ordinalNow) + `[${chipText.eq(c.eqNumber ?? '')}](${chipHref.eq(ordinalNow)})` : chipMark('c', ordinalNow) + `[${chipText.cite(ordinalNow)}](${chipHref.cite(ordinalNow)})`;
      return spacedAfter(whole, offset, chip);
    })
    .replace(LABEL_TOKEN_RE, (_m, k: string, offset: number, whole: string) => {
      const idx = Number(k);
      const label = blocks[idx]?.label;
      if (!label) return '';
      if (demotedLabels.has(idx)) return `\\[\\[${label}]]`;
      return spacedAfter(whole, offset, chipMark('b', idx) + `[${chipText.label(label)}](${chipHref.label(label)})`);
    })
    .replace(EXTRA_EQ_TOKEN_RE, (_m, i: string) => escapeInline(extraEqSources[Number(i)] ?? '', work));
  return { displayMd: restore(out), citations: finalCitations, blocks: finalBlocks, glossary, issues };
}

/** The segments back together (the same joining applyLabels does). */
const joinSegments = (parts: readonly Segment[]) => parts.map((p) => p.text).join('');

/** A space before a chip that would otherwise be glued to a URL-like run (GFM autolink literal). */
function spacedAfter(text: string, offset: number, chip: string): string {
  const before = text.slice(Math.max(0, offset - 300), offset);
  return AUTOLINK_TAIL_RE.test(before) ? ` ${chip}` : chip;
}

function markTokens(s: string, citations: Set<number>, labels: Set<number>) {
  for (const m of s.matchAll(CITATION_TOKEN_RE)) citations.add(Number(m[1]));
  for (const m of s.matchAll(LABEL_TOKEN_RE)) labels.add(Number(m[1]));
}

/** A link reference definition (not rendered). */
const DEFINITION_START_RE = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?\[(?:\\.|[^\\\]])+\]:/;

/**
 * Ranges of one block's text where Markdown would hide or relocate a chip: image alt text (`![` … `]`), the
 * tail of an inline link after `](` up to its `)` (destination and title), and the whole block when it starts
 * with a link reference definition. Conservative (a superset): a demoted chip is plain text for both the stats
 * and the renderer, so over-marking never makes them disagree.
 *
 * Returned merged (sorted, disjoint): nested images (`![![![…]]]`) give nested ranges whose total length grows with
 * the square of the depth, and each range used to be scanned for tokens on its own (review B-R2-01). Merging finds
 * the same tokens: a range starts at `!` or `(` and ends after `]`, `)` or at the end of the text, and a token
 * (`\u0001…\u0001` / `\u0002…\u0002`) holds none of those, so no token crosses a range edge and a token lies inside
 * the union exactly when it lies inside one of the ranges.
 */
function unsafeRanges(text: string, work: MarkupWork): [number, number][] {
  work.steps += text.length + 1;
  if (DEFINITION_START_RE.test(text)) return [[0, text.length]];
  return mergeRanges(rawUnsafeRanges(text), work);
}

function mergeRanges(ranges: [number, number][], work: MarkupWork): [number, number][] {
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  work.steps += ranges.length + 1;
  const out: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function rawUnsafeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const open: { image: boolean; at: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      open.push({ image: true, at: i });
      i++;
      continue;
    }
    if (c === '[') {
      open.push({ image: false, at: i });
      continue;
    }
    if (c !== ']') continue;
    const o = open.pop();
    if (!o) continue;
    if (o.image) out.push([o.at, i + 1]);
    if (text[i + 1] === '(') {
      const close = linkTailEnd(text, i + 1);
      out.push([i + 1, close]);
      if (o.image) out.push([o.at, close]);
      i = close - 1;
    }
  }
  return out;
}

/** End (exclusive) of an inline link tail starting at `(`: balanced parens, quoted titles; end of text if open. */
function linkTailEnd(text: string, at: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = at; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && /\s/.test(text[i - 1] ?? '')) {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

/** A label right after a sentence end or a citation, with the citations that directly follow it. */
// The lookbehind sits after the literal `[[` (it re-reads those two characters), so it runs only where a label can
// start: placed first, it ran at every position and rescanned a run of spaces once per position (review B-R1-02).
const MID_LABEL_RE = new RegExp(`\\[\\[(?<=(?:[.!?。！？]|\\u0001\\d+\\u0001)[ \\t]*\\[\\[)(P|N|G)\\]\\]((?:[ \\t.,;:()]*\\u0001\\d+\\u0001)*[ \\t.,;:)]*)`, 'g');
const tokenOrdinals = (s: string) => [...s.matchAll(CITATION_TOKEN_RE)].map((c) => Number(c[1]));

// The label is the last token of its block; citations (and their punctuation) may still follow it:
// models often write `… [[P]] <q>…</q>`. Any other text after the label makes it plain text.
// `[\s.,;:)]*(?:\|\s*)?$` accepts the same tails as M1's `[\s.,;:)]*\|?\s*$` (\s is inside the class) without two
// adjacent whitespace loops that retried every split of a long run of spaces before a failing end (review B-R1-02).
const LABEL_AT_END = new RegExp(`(^|[^\\\\])${LABEL_TOKEN_SOURCE}((?:[\\s.,;:()]*\\u0001\\d+\\u0001)*[\\s.,;:)]*(?:\\|\\s*)?)$`);
/**
 * GFM table delimiter row (| --- | :-: |): table structure, not a block. One pass; accepts the same lines as M1's
 * `/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/`, whose adjacent optional whitespace loops (`\s*\|?\s*`) retried
 * every split of a long whitespace run before failing (review B-R2-01).
 */
function isTableDelimiter(line: string, work: MarkupWork): boolean {
  const n = line.length;
  let i = 0;
  const skipWs = () => {
    while (i < n && WS_RE.test(line[i]!)) i++;
  };
  work.steps += n + 1;
  skipWs();
  if (line[i] === '|') i++;
  for (;;) {
    skipWs();
    if (line[i] === ':') i++;
    if (line[i] !== '-') return false;
    while (line[i] === '-') i++;
    if (line[i] === ':') i++;
    skipWs();
    if (i >= n) return true;
    if (line[i] !== '|') return false;
    i++;
    skipWs();
    if (i >= n) return true; // a closing pipe
  }
}
const HEADING_RE = /^\s*#{1,6}\s/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** A line that starts a new parser block (list item, heading, table row, blockquote start, thematic break). */
function isBlockStart(line: string, prev: string): boolean {
  if (/^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|\|)/.test(line)) return true;
  if (THEMATIC_BREAK_RE.test(line)) return true;
  return /^\s{0,3}>/.test(line) && !/^\s{0,3}>/.test(prev);
}

/** Splits non-code text into blocks (paragraphs, list items, table rows, headings) and resolves labels. */
function applyLabels(segments: Segment[], work: MarkupWork): { displayMd: string; blocks: ParsedBlock[]; blockTexts: string[] } {
  const blocks: ParsedBlock[] = [];
  const blockTexts: string[] = [];
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.code) {
      out.push(seg.text);
      continue;
    }
    const lines = seg.text.split('\n');
    // Group line indexes into blocks.
    const groups: number[][] = [];
    let cur: number[] = [];
    lines.forEach((line, i) => {
      // A fixed number of anchored, linear passes over this line and the previous one (trim, block-start regexes).
      work.steps += line.length + (cur.length ? lines[cur[cur.length - 1]!]!.length : 0) + 1;
      if (line.trim() === '') {
        if (cur.length) groups.push(cur);
        cur = [];
        return;
      }
      const prev = cur.length ? lines[cur[cur.length - 1]!]! : '';
      if (cur.length && (isBlockStart(line, prev) || /^\s*\|/.test(prev) || HEADING_RE.test(prev) || THEMATIC_BREAK_RE.test(prev))) {
        groups.push(cur);
        cur = [];
      }
      cur.push(i);
    });
    if (cur.length) groups.push(cur);
    for (const g of groups) {
      if (g.length === 1 && isTableDelimiter(lines[g[0]!]!, work)) continue;
      const lastIdx = g[g.length - 1]!;
      const original = g.map((idx) => lines[idx]!).join('\n');
      // A label that closes a sentence inside the block (after . ! ? or right after a citation) ends a labelled
      // segment: `…구한다. [[P]] <eq/> <q>…</q> State는 …` → segment 1 = up to the label and the citations right
      // after it (labelled), the rest continues as the next segment. Table rows keep the end-of-row rule only.
      let segStart = 0;
      work.steps += original.length + 1; // MID_LABEL_RE, LABEL_AT_END and the token scans: linear passes over the block
      if (!/^\s*\|/.test(lines[g[0]!]!)) {
        let rebuilt = '';
        let copied = 0;
        // Whether only whitespace follows a label: one backward scan for the block, not a trim of the rest per label
        // (that rescanned trailing whitespace once per label — review B-R2-01).
        const lastSolid = lastNonWhitespace(original, work);
        for (const m of original.matchAll(MID_LABEL_RE)) {
          const end = m.index + m[0].length;
          if (end > lastSolid) break; // the block's own end label (below)
          const index = blocks.length;
          blocks.push({ label: m[1] as 'P' | 'N' | 'G', citationOrdinals: tokenOrdinals(original.slice(segStart, end)) });
          rebuilt += original.slice(copied, m.index) + labelToken(index) + m[2]!;
          copied = end;
          segStart = end;
        }
        if (copied > 0) {
          const parts = (rebuilt + original.slice(copied)).split('\n');
          g.forEach((idx, k) => (lines[idx] = parts[k]!));
        }
      }
      const block: ParsedBlock = { citationOrdinals: tokenOrdinals(original.slice(segStart)) };
      const index = blocks.length;
      const m = LABEL_AT_END.exec(lines[lastIdx]!);
      if (m) {
        block.label = m[2] as 'P' | 'N' | 'G';
        lines[lastIdx] = lines[lastIdx]!.replace(LABEL_AT_END, (_all, pre: string, _l: string, tail: string) => `${pre}${labelToken(index)}${tail}`);
      }
      blocks.push(block);
      blockTexts.push(g.map((idx) => lines[idx]!).join('\n')); // with label tokens (for the demotion scan)
    }
    out.push(lines.join('\n'));
  }
  return { displayMd: out.join(''), blocks, blockTexts };
}

/**
 * Streaming display (PLAN 5.2): the prefix of `raw` that is safe to show while the answer is still streaming.
 * Held back (outside code only): the body of a `<q>` that is not closed yet (≤ 700 chars back), a half-written
 * known tag at the end (≤ 700 chars), an open `<glossary>` block, and a trailing `[`, `[[`, `[[P`, `[[P]`.
 * Text inside an open code fence or a closed inline code / math span is never held back (it is code).
 */
export function streamingSafePrefix(raw: string): string {
  const segs = splitFences(raw);
  const last = segs.at(-1);
  if (!last || last.code) return raw; // ends inside an open fence: everything is code
  const base = raw.length - last.text.length;
  const masked = maskLiteralSpans(last.text);
  let cut = raw.length;
  const holdFrom = (i: number) => (cut = Math.min(cut, base + i));

  const g = masked.lastIndexOf('<glossary>');
  if (g >= 0 && masked.indexOf('</glossary>', g) < 0) holdFrom(g);
  const q = masked.lastIndexOf(QUOTE_OPEN);
  if (q >= 0 && masked.indexOf(QUOTE_CLOSE, q) < 0 && masked.length - q <= STREAM_HOLDBACK_MAX_CHARS) holdFrom(q);
  const lt = masked.lastIndexOf('<');
  if (lt >= 0 && masked.length - lt <= STREAM_HOLDBACK_MAX_CHARS && !masked.slice(lt).includes('>')) {
    const tail = masked.slice(lt);
    if (KNOWN_TAG_PREFIXES.some((t) => t.startsWith(tail) || tail.startsWith(t))) holdFrom(lt);
  }
  const lab = /\[(\[([PNG](\])?)?)?$/.exec(raw.slice(0, cut));
  if (lab && lab.index >= base) cut = lab.index;
  return raw.slice(0, cut);
}
