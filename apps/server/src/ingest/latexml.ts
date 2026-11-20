// arXiv LaTeXML HTML → document structure (PLAN_M2 3.2, P1). Owner A. linkedom only.
//
// parse(html) is synchronous and throws StructureError; parseStructure(html) is what the pipeline uses: it yields to
// the event loop before and after linkedom's parseHTML (one synchronous call that cannot be split, the one named
// exception to common rule 3) and inside the extraction, and never throws: {ok:false, warning}. parseHTML's time is
// bounded by the 4 MB fetch limit AND the linear markup pre-scan in front of it (markupScan.ts — PLAN_M2 P7 · 9절 39:
// start tags ≤ 300,000, estimated nesting depth ≤ 256, attributes per tag ≤ 256, names ≤ 64 chars, otherwise
// structure_too_large without parsing); the 4 MB limit alone does not bound it (quadratic in the depth).
//
// Rules:
// - sections: section.ltx_section | ltx_subsection | ltx_subsubsection | ltx_appendix in document order. Heading = the
//   first h1–h6 among the section's first HEADING_CHILD_SCAN element children (LaTeXML writes it as the first child).
//   number = the heading's first .ltx_tag (trimmed, as printed: "III-A"), title = the heading text without .ltx_tag and
//   .ltx_note, whitespace collapsed. level 1–3, parent = the nearest enclosing parsed section. Text reads (title, tag,
//   caption, reference) take the presentation MathML glyphs of a <math> and skip <annotation>/<annotation-xml> (the TeX
//   source and content MathML; review A-R3-04).
// - equations: one row per .ltx_tag_equation AND .ltx_tag_equationgroup (FAST-LIO2's (2)(6)(10)(17)(18) are group
//   tags). Holder: group tag → the nearest table.ltx_equationgroup[id]; otherwise the nearest tbody[id] → tr[id] →
//   table[id]. Rows of a group holder that carry their own .ltx_tag_equation are separate equations. latexRaw = per
//   row the alttexts of its <math> joined by a space; ≥ 2 rows → \begin{gathered} r1 \\ r2 \end{gathered}; cut at
//   20,000 chars. A display equation table without any tag is a row with number null. number = the tag without one
//   pair of parentheses ("(4)" → "4", "(A.1)" → "A.1").
//   contextBefore: the nearest previous sibling of the equation's table that is a paragraph (div.ltx_para / p) with
//   text after its last inline math (≤ 300 chars, the end of it) — the rule the anchor probe used (anchor5.mts).
//   contextAfter: the first paragraph after the table (its next siblings, else the next siblings of the enclosing
//   paragraph), the text before its first inline math (≤ 300 chars).
//   equation_number_gap: the integer numbers must cover 1…max (the parser missed an equation otherwise).
// - figures: figure.ltx_figure | figure.ltx_table not nested in another figure, with a figcaption among its first
//   FIGURE_CHILD_SCAN element children. number = the caption's .ltx_tag without the word and the colon ("Figure 1: " →
//   "1", "TABLE I: " → "I").
// - references: li.ltx_bibitem → ordinal, label (.ltx_tag_bibitem), rawText (.ltx_bibblock joined), htmlId; arxivId
//   and doi taken from rawText by regular expressions only.
// - codeUrl: the first <a href> of the paper body whose URL parses with protocol https:, hostname exactly github.com, no
//   userinfo and no port. Never a substring test. The body is .ltx_page_main (else the .ltx_document); a link inside a
//   page-frame element there (footer, nav, header, .ltx_page_header/footer/navbar/logo, a class starting "arxiv-") is
//   not read — the arXiv page carries github.com/arXiv/html_feedback in its footer on every paper (review A-R3-01). At
//   most ANCHORS_MAX links are looked at, hrefs over HREF_MAX characters are skipped.
// - arXiv mentions "arXiv:<id>v<N>", as distinct (id, version) pairs (≤ MENTION_PAIRS_MAX, more → overflow = unknown):
//   arxivMentions scans the raw HTML (the html step's version check); textMentions reads the text linkedom built — entities
//   decoded, inline elements run on; blocks, line breaks and table cells separate; a sup or sub separates only where it
//   holds text — before its first text and after its end — and one that draws nothing runs on (A-FX-01, A-FX5-R1-01)
//   — for the structure step's check (M-M2-R2-5). Its walk visits every node and is charged to the same work counter
//   (textWork), yielding like the rest of the extraction.
//   Stricter than a reader (the HTML may be refused, never accepted wrongly): an inline element other than sup/sub, or an
//   unknown one, runs on even where it is drawn apart — a digit in it right after the paper's own version reads as a
//   longer version (`arXiv:<id>v1<span>3</span>` → v13, a mismatch); so does a digit right after an empty sup or sub
//   (`arXiv:<id>v1<sup></sup>3` → v13).
//   Known limits of the parsed-text check (A-F4R1-05, A-F4R2-03, A-F4B1-02): it reads linkedom's text, not the HTML
//   parser's, so it does not see a mention that only the parser joins or decodes. The forms below are examples
//   (checked against parse5 8.1.1), not a closed list: an entity inside a <textarea> (linkedom keeps it undecoded);
//   one split by a CDATA section inside an svg or math (linkedom makes a comment of it); one split by a NUL (the parser
//   drops it — in body text, a table cell or a select); one split by a tag the parser drops or moves, where linkedom
//   makes an element — or, for a stray </body> or </html>, closes the body there and puts the text after it outside
//   the body (after </html>: outside the html element too) — and the walk separates the text (e.g. td, th, tr, tbody,
//   thead, tfoot, caption, head, body or html in body text, a nested <form>, a tag the parser drops inside a <select>
//   such as div or td; a stray </body> or </html>; text moved out of a table);
//   an entity inside a <style>/<script> the parser reads as text (in svg, math or select) — the raw scan keeps that
//   content undecoded and the walk skips it by name. The raw scan misses these too, so both checks say "same".
//   Not seen by design (A-FX-01): a mention split by the start or end of a sup or sub that holds text — a part drawn
//   raised or lowered, such as the version in a <sup>/<sub> (`arXiv:<id>v<sup>2</sup>`) or the version after one
//   (`<sup>arXiv:<id></sup>v2`, A-FX5-R2-01); the walk separates such a sup or sub so that a footnote mark after the own version is not read as a longer version, and the raw scan stops at the
//   tag, so both checks say "same". A sup or sub that draws nothing (empty, or only comments, script, style, template or
//   empty elements) does not separate, so the mention it splits is read (`arXiv:<id><sup></sup>v2`, A-FX5-R1-01).
//   arxivMentions has its own limit (A-F4R3-01, its doc comment).
// Limits: > 2,000 sections, > 20,000 <math>, > 2,000 bibitems → structure_too_large (no structure). Rows kept up to
// SUPPLEMENT_CAPS counts (sections 400, equations 400, figures 200, references 400) in document order, the rest dropped
// with structure_truncated. Equations by kind: all numbered ones up to 400, unnumbered rows only in the room left (total
// ≤ 400). A value cut at a parser character or walk cap (title, tag, caption, reference text, latexRaw) is never stored
// as if complete: it ends with "…" and structure_truncated is added (decision S-4); a cut reference has unknown ids
// (null); a cut latexRaw sets latexCut, and the pipeline stores katexOk false for it (review A-R3-03).
// Work (common rule 3): every look at the tree after parseHTML goes through bounded walks — subtree walks with a step
// cap, ancestor climbs with ANCESTOR_MAX, sibling scans with a count cap, text reads with a character cap — that charge
// one counter (`work`: nodes visited + characters read / CHARS_PER_UNIT). A walk that hits its cap gives "unknown" for
// that item (null context, cut text, a table that is not taken as an equation). Holder results are memoised per
// holder, so tags sharing one holder do not walk it again. The event loop gets a turn whenever YIELD_WORK units were
// charged since the last one; the extraction gives up with structure_too_large past WORK_MAX units. Sibling scans step
// over text and comment nodes one by one and count them (linkedom's *ElementSibling accessors are not used — they skip
// them uncounted). Not counted: the whole-document querySelectorAll calls (one native pass each, a fixed number of
// them) and linkedom's per-element accessor costs (attribute list walks, tagName), which the markup pre-scan bounds by a
// constant (≤ 256 attributes per tag, names ≤ 64 chars — review A-R3-02).
import { parseHTML } from 'linkedom';
import type { IngestWarningCode } from '@study-paper/shared/contracts/domain';
import { SUPPLEMENT_CAPS } from '@study-paper/shared/contracts/supplement';
import { IngestError } from './errors';
import { PRESCAN_LIMITS, scanMarkup } from './markupScan';

export const STRUCTURE_LIMITS = { sections: 2_000, maths: 20_000, bibitems: 2_000 } as const;
export const STORED_CAPS = { sections: SUPPLEMENT_CAPS.sections, equations: SUPPLEMENT_CAPS.equations, figures: SUPPLEMENT_CAPS.figures, references: SUPPLEMENT_CAPS.references } as const;
export const LATEX_RAW_MAX = 20_000;
export const CONTEXT_MAX = 300;

// ---- work bounds
/** Work units charged between two event-loop yields. */
export const YIELD_WORK = 20_000;
/** Total work units of one extraction; past this the structure is unknown (structure_too_large). */
export const WORK_MAX = 8_000_000;
/** Characters read per work unit. */
export const CHARS_PER_UNIT = 16;
/** Ancestors looked at by one climb (closest-section, holder, figure nesting). */
export const ANCESTOR_MAX = 1_024;
/** Element children of a section looked at for its heading / of a figure for its caption. */
export const HEADING_CHILD_SCAN = 16;
export const FIGURE_CHILD_SCAN = 256;
/** Nodes one text walk (heading, tag, caption, bibitem) may visit. */
export const TEXT_STEPS = 5_000;
export const TITLE_CHARS = 2_000;
export const TAG_CHARS = 200;
export const CAPTION_CHARS = 8_000;
export const REFERENCE_CHARS = 8_000;
/** Nodes one equation-holder walk may visit (math interiors are skipped), and characters of alttext it collects. */
export const HOLDER_STEPS = 20_000;
export const HOLDER_CHARS = 3 * LATEX_RAW_MAX;
/**
 * Sibling scans (heading, caption, context) step node by node and charge every node passed — text and comment nodes
 * too, which linkedom's *ElementSibling accessors would skip without a count (review A-R3-02) — at most this many
 * nodes per element they may look at; past that the scan stops ("unknown").
 */
export const SIBLING_NODES_PER_ELEMENT = 4;
/** Context: siblings looked at per direction, nodes and characters read per paragraph walk. */
export const CONTEXT_SIBLINGS_MAX = 32;
export const CONTEXT_NODE_MAX = 5_000;
export const CONTEXT_CHARS_MAX = 65_536;
/** Links checked for the code URL, and the longest href parsed. */
export const ANCHORS_MAX = 20_000;
export const HREF_MAX = 2_048;
/**
 * Upper bound of the work one item (a section, an equation row, a figure, a reference, a link) charges — the largest is
 * an equation: its tag text, two climbs, one holder walk, two contexts. A walk charges at most twice its step cap
 * (entered nodes + levels climbed back). The extraction yields as soon as YIELD_WORK units have gathered, so the work
 * between two yields stays ≤ YIELD_WORK + ITEM_WORK_MAX.
 */
export const ITEM_WORK_MAX =
  1 + 2 * TEXT_STEPS + Math.ceil(TAG_CHARS / CHARS_PER_UNIT) + 2 * ANCESTOR_MAX + 2 * HOLDER_STEPS + Math.ceil(HOLDER_CHARS / CHARS_PER_UNIT) + 2 * (2 * SIBLING_NODES_PER_ELEMENT * CONTEXT_SIBLINGS_MAX + 2 * CONTEXT_NODE_MAX + Math.ceil(CONTEXT_CHARS_MAX / CHARS_PER_UNIT));

export interface ParsedSection {
  htmlId: string | null;
  number: string | null;
  title: string;
  level: number;
  /** Index into sections (an earlier one), or null. */
  parentIndex: number | null;
}
export interface ParsedEquation {
  htmlId: string | null;
  number: string | null;
  latexRaw: string;
  /** latexRaw was cut at a parser cap (it ends with ELLIPSIS): only part of the rows — never drawn as the whole
   *  equation, the pipeline stores katexOk false (review A-R3-03). */
  latexCut: boolean;
  /** Index into sections, or null. */
  sectionIndex: number | null;
  contextBefore: string | null;
  contextAfter: string | null;
  group: boolean;
}
export interface ParsedFigure {
  htmlId: string | null;
  kind: 'figure' | 'table';
  number: string | null;
  caption: string;
  sectionIndex: number | null;
}
export interface ParsedReference {
  htmlId: string | null;
  label: string | null;
  rawText: string;
  arxivId: string | null;
  doi: string | null;
}
export interface ParsedStructure {
  sections: ParsedSection[];
  /** Document order (numbered and unnumbered). */
  equations: ParsedEquation[];
  figures: ParsedFigure[];
  references: ParsedReference[];
  ltxErrors: number;
  codeUrl: string | null;
  /** The raw scan's distinct "arXiv:<id>v<N>" pairs in order of first appearance (arxivMentions; at most MENTION_PAIRS_MAX). */
  arxivMentions: ArxivMention[];
  /** The distinct pairs in the text linkedom built (entities decoded, inline elements run on; blocks, line breaks, cells
   *  and a sup or sub that holds text separate; not comments, script, style, template) — the structure step's version
   *  check (M-M2-R2-5, A-FX-01, A-FX5-R1-01). */
  textMentions: MentionList;
  warnings: IngestWarningCode[];
  /** Work units the extraction charged (nodes visited + characters read / CHARS_PER_UNIT). */
  work: number;
  /** The part of `work` the parsed-text walk for the version check charged (every node of the document + its text). */
  textWork: number;
  /** The most work charged between two event-loop yields of the extraction (after parseHTML). */
  maxWorkBetweenYields: number;
}

export class StructureError extends Error {
  constructor(
    readonly warning: 'structure_too_large' | 'structure_parse_failed',
    message: string,
  ) {
    super(message);
    this.name = 'StructureError';
  }
}

// Minimal view of the linkedom node/element API we use.
interface DomNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  firstChild: DomNode | null;
  lastChild: DomNode | null;
  nextSibling: DomNode | null;
  previousSibling: DomNode | null;
  parentNode: DomNode | null;
}
interface El extends DomNode {
  tagName: string;
  classList: { contains(c: string): boolean; readonly size: number; [Symbol.iterator](): Iterator<string> };
  parentElement: El | null;
  // (previousElementSibling / nextElementSibling / firstElementChild are left out on purpose: they skip non-element
  // nodes without a count — SiblingScan below steps over them and charges each one)
  getAttribute(n: string): string | null;
  querySelectorAll(sel: string): ArrayLike<El>;
}
interface Doc {
  /** The document's children in order. linkedom keeps text before the first element here (it puts the doctype first and
   *  gives it no nextSibling), so the text walk starts from this list, not from documentElement. */
  childNodes: ArrayLike<DomNode>;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
}

const TEXT_NODE = 3;
const CDATA_NODE = 4;
const ELEMENT_NODE = 1;

const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const all = (root: Doc, sel: string): El[] => Array.from(root.querySelectorAll(sel));
const idOf = (el: El | null | undefined): string | null => {
  const v = el?.getAttribute('id');
  return v ? v : null;
};
const hasIdAttr = (el: El) => el.getAttribute('id') !== null;
const has = (el: El, c: string) => el.classList.contains(c);
const asEl = (n: DomNode) => n as El;
const isTextNode = (n: DomNode) => n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE;

const SECTION_SEL = 'section.ltx_section, section.ltx_subsection, section.ltx_subsubsection, section.ltx_appendix';
const levelOf = (s: El) => (has(s, 'ltx_subsubsection') ? 3 : has(s, 'ltx_subsection') ? 2 : 1);
const isPara = (el: El) => has(el, 'ltx_para') || el.tagName === 'P';
const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
/** MathML annotations (the TeX source, content MathML): never read as text — a title, tag, caption or reference reads
 *  the presentation glyphs only, which is also what the PDF shows (review A-R3-04). Equations use alttext. */
const ANNOTATIONS = new Set(['ANNOTATION', 'ANNOTATION-XML']);
const isAnnotation = (el: El) => ANNOTATIONS.has(el.tagName);

/** The one work counter of an extraction. */
class Work {
  n = 0;
  private lastYield = 0;
  maxBetween = 0;
  /** Values cut at a parser cap (stored with a trailing ELLIPSIS → structure_truncated, decision S-4). */
  cuts = 0;
  charge(units: number): void {
    this.n += units;
    if (this.n > WORK_MAX) throw new StructureError('structure_too_large', `structure extraction work over ${WORK_MAX} units`);
  }
  chars(count: number): void {
    if (count > 0) this.charge(Math.ceil(count / CHARS_PER_UNIT));
  }
  /** True when the extraction should yield now (and records the stretch since the last yield). */
  due(): boolean {
    if (this.n - this.lastYield < YIELD_WORK) return false;
    this.mark();
    return true;
  }
  mark(): void {
    this.maxBetween = Math.max(this.maxBetween, this.n - this.lastYield);
    this.lastYield = this.n;
  }
}

/**
 * Element siblings one at a time, from `from` (itself included) in one direction, charging every node passed. At most
 * `maxElements` elements and SIBLING_NODES_PER_ELEMENT × maxElements nodes; `cut` tells that the node budget ran out
 * before the siblings did (the caller treats the answer as unknown).
 */
class SiblingScan {
  cut = false;
  private nodesLeft: number;
  private elementsLeft: number;
  constructor(
    private n: DomNode | null,
    private readonly back: boolean,
    private readonly w: Work,
    maxElements: number,
  ) {
    this.elementsLeft = maxElements;
    this.nodesLeft = SIBLING_NODES_PER_ELEMENT * maxElements;
  }
  next(): El | null {
    while (this.n && this.elementsLeft > 0) {
      if (this.nodesLeft-- <= 0) {
        this.cut = true;
        return null;
      }
      this.w.charge(1);
      const cur = this.n;
      this.n = this.back ? cur.previousSibling : cur.nextSibling;
      if (cur.nodeType === ELEMENT_NODE) {
        this.elementsLeft--;
        return asEl(cur);
      }
    }
    return null;
  }
}

const DESCEND = 0;
const SKIP = 1;
const STOP = 2;
type Step = typeof DESCEND | typeof SKIP | typeof STOP;

/**
 * Pre-order walk of root's descendants (root itself is not visited). `enter` decides per node: descend, skip its
 * subtree, or stop the walk; `leave` is called for an element once its subtree is done. At most `maxSteps` steps
 * (nodes entered + levels climbed); returns false when the walk was cut there.
 */
function walk(root: DomNode, w: Work, maxSteps: number, enter: (n: DomNode) => Step, leave?: (el: El) => void): boolean {
  let steps = 0;
  let n: DomNode | null = root.firstChild;
  try {
    while (n) {
      if (++steps > maxSteps) return false;
      const r = enter(n);
      if (r === STOP) return true;
      if (r === DESCEND && n.nodeType === ELEMENT_NODE) {
        const c = n.firstChild;
        if (c) {
          n = c;
          continue;
        }
      }
      let m: DomNode = n;
      for (;;) {
        if (leave && m.nodeType === ELEMENT_NODE) leave(asEl(m));
        const s = m.nextSibling;
        if (s) {
          n = s;
          break;
        }
        steps++;
        const p = m.parentNode;
        if (!p || p === root) {
          n = null;
          break;
        }
        m = p;
      }
    }
    return true;
  } finally {
    w.charge(steps);
  }
}

/** First ancestor of `el` (itself when `self`) that passes `test`, within ANCESTOR_MAX; null otherwise. */
function climb(el: El, w: Work, test: (p: El) => boolean, self = false): El | null {
  let p: El | null = self ? el : el.parentElement;
  let k = 0;
  for (; p && k < ANCESTOR_MAX; k++, p = p.parentElement) {
    if (test(p)) {
      w.charge(k + 1);
      return p;
    }
  }
  w.charge(k);
  return null;
}

/** Marks a value cut at a parser cap (decision S-4 — never stored as if complete). */
export const ELLIPSIS = '…';

/** `s` cut to at most `max` characters ending with ELLIPSIS (a surrogate pair is never split). */
function withEllipsis(s: string, max: number): string {
  let end = Math.min(s.length, max - 1);
  if (end > 0 && end < s.length) {
    const c = s.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
  }
  return s.slice(0, end) + ELLIPSIS;
}

/**
 * Squashed text of `root`'s descendants, skipping the subtrees of elements carrying one of `skip`; at most `maxChars`.
 * A value cut there — more text after `maxChars` characters, or the walk stopped at TEXT_STEPS — ends with ELLIPSIS
 * and is counted in `w.cuts` (→ structure_truncated).
 */
function textOf(root: El, w: Work, maxChars: number, skip: readonly string[] = []): string {
  const parts: string[] = [];
  let len = 0;
  let cut = false;
  const ended = walk(root, w, TEXT_STEPS, (n) => {
    if (n.nodeType === ELEMENT_NODE) return isAnnotation(asEl(n)) || skip.some((c) => has(asEl(n), c)) ? SKIP : DESCEND;
    if (!isTextNode(n)) return SKIP;
    const v = n.nodeValue ?? '';
    if (v.length === 0) return SKIP;
    if (len >= maxChars) {
      cut = true; // more text after the cap
      return STOP;
    }
    const piece = v.length > maxChars - len ? v.slice(0, maxChars - len) : v;
    if (piece.length < v.length) cut = true;
    parts.push(piece);
    len += piece.length;
    return cut ? STOP : SKIP;
  });
  w.chars(len);
  const text = squash(parts.join(''));
  if (!cut && ended) return text;
  w.cuts++;
  return text + ELLIPSIS;
}

/** First descendant element of `root` (pre-order) with class `cls`, or null. */
function firstWithClass(root: El, w: Work, cls: string): El | null {
  let found: El | null = null;
  walk(root, w, TEXT_STEPS, (n) => {
    if (n.nodeType !== ELEMENT_NODE) return SKIP;
    if (has(asEl(n), cls)) {
      found = asEl(n);
      return STOP;
    }
    return DESCEND;
  });
  return found;
}

// ---- equation holders (memoised per holder and mode)

interface Row {
  hasMath: boolean;
  ownTag: boolean;
  raw: string[];
}
/** 'plain': a tag holder (every row with math); 'group': a group tag holder (rows without their own equation tag);
 *  'untagged': a display table that is a candidate unnumbered row (null when it holds a tag or the walk was cut). */
type HolderMode = 'plain' | 'group' | 'untagged';

const isSpace = (c: number) =>
  c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

const rowText = (r: Row) => squash(r.raw.join(' '));

/** A holder's latexRaw and whether it was cut at a cap (then it ends with ELLIPSIS and the equation gets katexOk false). */
interface HolderLatex {
  raw: string;
  cut: boolean;
}

/** latexRaw of row texts (non-empty ones), at most LATEX_RAW_MAX characters; `cut` (or a longer join) → ELLIPSIS. */
function joinTexts(texts: readonly string[], cut: boolean): HolderLatex {
  const joined = texts.length > 1 ? `\\begin{gathered} ${texts.join(' \\\\ ')} \\end{gathered}` : (texts[0] ?? '');
  if (!cut && joined.length <= LATEX_RAW_MAX) return { raw: joined, cut: false };
  return { raw: withEllipsis(joined, LATEX_RAW_MAX), cut: true };
}

/**
 * Walk a holder once: rows (tr) in document order with their math alttexts (a math belongs to its innermost row; a
 * holder that is itself a tr is one row), whether a row carries its own .ltx_tag_equation, whether any equation tag is
 * inside. 'plain'/'group' stop once the joined text is past LATEX_RAW_MAX with ≥ 2 rows (the cut result is the same);
 * 'untagged' stops at the first tag (→ null). Returns latexRaw, or null for 'untagged' when the table is not an
 * unnumbered row (a tag inside, no row with math, or the walk was cut before the end — unknown). latexRaw is cut (ends
 * with ELLIPSIS, `cut`) when the walk stopped at HOLDER_STEPS, an alttext was cut or dropped at HOLDER_CHARS, or the
 * join is longer than LATEX_RAW_MAX — part of the rows is never stored as the whole equation (review A-R3-03).
 */
function holderLatex(holder: El, mode: HolderMode, w: Work): HolderLatex | null {
  const rootRow = holder.tagName === 'TR';
  const rows: Row[] = [];
  const open: Row[] = [];
  if (rootRow) {
    const r: Row = { hasMath: false, ownTag: false, raw: [] };
    rows.push(r);
    open.push(r);
  }
  let chars = 0;
  let charsCut = false;
  let tagged = false;
  const texts: string[] = [];
  let textsLen = 0;
  let enough = false;
  const eligible = (r: Row) => (rootRow ? true : r.hasMath) && !(mode === 'group' && r.ownTag);
  const complete = (r: Row) => {
    if (mode === 'untagged' || !eligible(r)) return;
    const t = rowText(r);
    if (!t) return;
    texts.push(t);
    textsLen += t.length + 4;
    if (texts.length >= 2 && textsLen > LATEX_RAW_MAX + 32) enough = true;
  };
  const ended = walk(
    holder,
    w,
    HOLDER_STEPS,
    (n) => {
      if (enough) return STOP;
      if (n.nodeType !== ELEMENT_NODE) return SKIP;
      const el = asEl(n);
      if (el.tagName === 'TR' && !rootRow) {
        const r: Row = { hasMath: false, ownTag: false, raw: [] };
        rows.push(r);
        open.push(r);
        return DESCEND;
      }
      if (el.nodeName.toLowerCase() === 'math') {
        const cur = open[open.length - 1];
        if (cur) {
          cur.hasMath = true;
          const a = el.getAttribute('alttext') ?? '';
          if (chars < HOLDER_CHARS) {
            const piece = a.length > HOLDER_CHARS - chars ? a.slice(0, HOLDER_CHARS - chars) : a;
            if (piece.length < a.length) charsCut = true;
            chars += piece.length;
            cur.raw.push(piece);
          } else if (a.length > 0) charsCut = true;
        }
        return SKIP; // the MathML inside is never read
      }
      const eqTag = has(el, 'ltx_tag_equation');
      if (eqTag || has(el, 'ltx_tag_equationgroup')) {
        tagged = true;
        if (mode === 'untagged') return STOP;
        const cur = open[open.length - 1];
        if (eqTag && cur) cur.ownTag = true;
      }
      return DESCEND;
    },
    (el) => {
      if (el.tagName === 'TR' && !rootRow) {
        const r = open.pop();
        if (r) complete(r);
      }
    },
  );
  w.chars(chars);
  if (mode === 'untagged') {
    if (tagged || !ended) return null;
    const withMath = rows.filter((r) => r.hasMath);
    if (withMath.length === 0) return null;
    return joinTexts(withMath.map(rowText).filter((t) => t.length > 0), charsCut);
  }
  if (rootRow) complete(rows[0]!);
  return joinTexts(texts, charsCut || !ended || enough);
}

// ---- context

/**
 * The text of `el` between one end (`fromEnd`: the end) and its first <math> from that end, squashed; or null when the
 * walk gave up (the budget of the context call — CONTEXT_NODE_MAX nodes, CONTEXT_CHARS_MAX characters read, shared by
 * the paragraphs one context looks at — ran out). Only the CONTEXT_MAX non-space characters next to that end are
 * guaranteed exact — the callers keep at most CONTEXT_MAX characters of the result from that end.
 */
interface ContextBudget {
  nodes: number;
  chars: number;
}
const contextBudget = (): ContextBudget => ({ nodes: CONTEXT_NODE_MAX, chars: CONTEXT_CHARS_MAX });
function textToMath(el: El, fromEnd: boolean, w: Work, b: ContextBudget): string | null {
  const root = el as DomNode;
  const parts: string[] = [];
  let have = 0;
  let visited = 0;
  let read = 0;
  let n: DomNode | null = fromEnd ? root.lastChild : root.firstChild;
  try {
    while (n) {
      if (++visited > b.nodes) return null;
      if (n.nodeType === ELEMENT_NODE) {
        if (n.nodeName.toLowerCase() === 'math') break;
        const inner = fromEnd ? n.lastChild : n.firstChild;
        if (inner) {
          n = inner;
          continue;
        }
      } else if (isTextNode(n)) {
        // Count non-space characters from our end until the remaining need is met (or the node ends).
        const data = n.nodeValue ?? '';
        const need = CONTEXT_MAX - have;
        let count = 0;
        let i = 0;
        const L = data.length;
        while (i < L && count < need) {
          if (++read > b.chars) return null;
          if (!isSpace(data.charCodeAt(fromEnd ? L - 1 - i : i))) count++;
          i++;
        }
        parts.push(i === L ? data : fromEnd ? data.slice(L - i) : data.slice(0, i));
        have += count;
        if (have >= CONTEXT_MAX) break;
      }
      // next node in the walk direction; climb while the current subtree is done
      let m: DomNode | null = n;
      while (m && m !== root && !(fromEnd ? m.previousSibling : m.nextSibling)) {
        m = m.parentNode;
        visited++;
      }
      n = !m || m === root ? null : fromEnd ? m.previousSibling : m.nextSibling;
    }
  } finally {
    b.nodes -= visited;
    b.chars -= read;
    w.charge(visited);
    w.chars(read);
  }
  if (fromEnd) parts.reverse();
  return squash(parts.join(''));
}

function contextBefore(table: El | null, w: Work): string | null {
  const b = contextBudget();
  const sib = new SiblingScan(table?.previousSibling ?? null, true, w, CONTEXT_SIBLINGS_MAX);
  for (let prev = sib.next(); prev; prev = sib.next()) {
    if (!isPara(prev)) continue;
    const tail = textToMath(prev, true, w, b);
    if (tail === null) return null;
    if (tail) return tail.slice(-CONTEXT_MAX);
  }
  return null;
}

function contextAfter(table: El | null, w: Work): string | null {
  const b = contextBudget();
  /** The context from the first paragraph among the siblings after `start`; undefined when there is none within
   *  CONTEXT_SIBLINGS_MAX elements, null when unknown (a budget ran out). */
  const scan = (start: DomNode | null): string | null | undefined => {
    const sib = new SiblingScan(start, false, w, CONTEXT_SIBLINGS_MAX);
    for (let n = sib.next(); n; n = sib.next()) {
      if (!isPara(n)) continue;
      const head = textToMath(n, false, w, b);
      if (head === null) return null;
      if (head) return head.slice(0, CONTEXT_MAX);
    }
    return sib.cut ? null : undefined;
  };
  if (!table) return null;
  const inPara = scan(table.nextSibling);
  if (inPara !== undefined) return inPara;
  const para = table.parentElement && isPara(table.parentElement) ? table.parentElement : null;
  return para ? (scan(para.nextSibling) ?? null) : null;
}

/** "Figure 1: " → "1", "TABLE I:" → "I", "1:" → "1"; empty → null. */
function figureNumber(tag: string): string | null {
  const t = squash(tag).replace(/[:.]\s*$/, '').trim();
  if (!t) return null;
  const parts = t.split(' ');
  return parts[parts.length - 1]!;
}

const ARXIV_NEW = /(?:arXiv:\s*|arxiv\.org\/abs\/)(\d{4}\.\d{4,5})(?:v\d+)?(?!\d)/i;
const ARXIV_OLD = /(?:arXiv:\s*|arxiv\.org\/abs\/)([a-z][a-z.-]*\/\d{7})(?:v\d+)?(?!\d)/i;
const DOI = /\b(10\.\d{4,9}\/[^\s"<>]+)/;
export function referenceIds(rawText: string): { arxivId: string | null; doi: string | null } {
  const a = ARXIV_NEW.exec(rawText) ?? ARXIV_OLD.exec(rawText);
  const d = DOI.exec(rawText);
  return { arxivId: a ? a[1]! : null, doi: d ? d[1]!.replace(/[.,;:)\]]+$/, '') : null };
}

/** https + hostname exactly github.com + no userinfo + no port, parsed with URL (never a substring test). */
export function githubCodeUrl(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username !== '' || u.password !== '' || u.port !== '') return null;
  return u.href;
}

const MENTION = /arXiv:(\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})v(\d+)/g;
/** A comment ends at "-->" or "--!>" (the HTML tokenizer's comment end states). */
const COMMENT_END = /--!?>/g;
const HIDE = 1; // script/style: raw text the reader never sees — hidden in HTML content
const KEEP = 2; // (escapable) raw text that is text: a "<!--" there is not a comment, so it is skipped as kept text
const PLAINTEXT = 3; // the rest of the document is text
const SVG = 4;
const MATH = 5;
const SELECT = 6;
const FRAMESET = 7;
/** The start tags the scan acts on. */
const START_KIND = new Map<string, number>([
  ['script', HIDE], ['style', HIDE],
  ['title', KEEP], ['textarea', KEEP], ['xmp', KEEP], ['iframe', KEEP], ['noembed', KEEP], ['noframes', KEEP], ['noscript', KEEP],
  ['plaintext', PLAINTEXT], ['svg', SVG], ['math', MATH], ['select', SELECT], ['frameset', FRAMESET],
]);
/**
 * By lower-case first letter: 1 = a start tag name of START_KIND can start with it (lengths 3–9), 2 = an end tag that
 * closes select/frameset can (lengths 6, 8). Outside svg/math any other tag is never cut, lower-cased or looked up
 * (review A-F7-03); inside, every tag's name is cut once for the open-element stack (ForeignStack).
 */
const NAME_FIRST = new Uint8Array(128);
for (const ch of 'tixnpm') NAME_FIRST[ch.charCodeAt(0)] = 1;
for (const ch of 'sf') NAME_FIRST[ch.charCodeAt(0)] = 3;

// ---- the open elements inside svg/math (A-F4R1-02)
const F_FOREIGN = 0; // an svg/MathML element that is not an integration point
const F_POINT = 1; // an integration point: the parser reads its children as HTML
const F_HTML = 2; // an HTML element: a child of an integration point or of an HTML element, or a breakout tag
/** svg foreignObject/desc/title, MathML mi/mo/mn/ms/mtext and annotation-xml (whatever its encoding: more HTML, stricter). */
const INTEGRATION_POINTS = new Set(['foreignobject', 'desc', 'title', 'mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml']);
/** The names that are integration points in each namespace (A-F4R2-01): elsewhere the name is a plain foreign element. An
 *  annotation-xml is one only with an HTML encoding, which the scan does not read — never sure. */
const SVG_POINTS = new Set(['foreignobject', 'desc', 'title']);
const MATH_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);
const NS_HTML = 0;
const NS_SVG = 1;
const NS_MATH = 2;
/** HTML start tags the parser never leaves open (void elements, and the ones "in body" drops). */
const NEVER_OPEN = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Start tags that break out of foreign content: the parser makes them HTML elements (and <font> with a color, face or
 *  size attribute — TagInfo.fontExit). */
const BREAKOUT = new Set(['b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var']);
/** At most this many open elements are followed inside svg/math; one more keeps the rest of the document as text. */
export const FOREIGN_STACK_MAX = 65_536;

/**
 * The elements open inside svg/math, as far as the scan can tell (the parser's tree-construction rules, parse5 8.1.1).
 * It keeps every element the parser keeps open, and may keep more — the scan only closes what the parser surely closes:
 * - an end tag with the name of the top element pops it (an element the parser closes in another way stays)
 * - a "</svg>" / "</math>" pops down to its element, as the parser's foreign-content rule does, only when neither an
 *   HTML element (then the parser reads the end tag by the HTML rules, which ignore it: an integration point is special)
 *   nor another svg/math element is open above it (that one may be the only real one: the parser may have closed this
 *   svg already, e.g. by an end tag of an HTML element outside the stack — A-F4R1-02)
 * - a breakout tag (start tags in BREAKOUT, <font> with color/face/size, the end tags </p> and </br>) pops the svg/math
 *   elements above the nearest HTML element or integration point, as the parser does
 * Where the parser may have closed more than the scan (an end tag that pops nothing here — the ignored "</svg>" /
 * "</math>" among them — or an integration point by name only, which a breakout passes in the parser), the scan's top
 * may be above the parser's current node, and a start tag the scan would read as foreign is an HTML element in the
 * parser; a later breakout or pop-down would drop it and close the svg the parser keeps open (A-F4R2-01). So from then on
 * (`stale`, until the stack is empty) every element opened is kept as an HTML element: breakouts and pop-downs stop at it.
 * `svg` / `math` count the open svg / math elements. Each step is O(1) amortized.
 */
class ForeignStack {
  private readonly names: string[] = [];
  private readonly kinds: number[] = [];
  private readonly htmlAt: number[] = []; // the highest F_HTML entry at or below (−1: none)
  private readonly svgAt: number[] = []; // the highest svg entry at or below (−1: none)
  private readonly mathAt: number[] = [];
  private readonly rootAt: number[] = []; // the highest svg or math entry at or below
  private readonly nsAt: number[] = []; // the namespace an element opened in this one gets (NS_*)
  /** The parser may have closed elements the scan keeps (see above); reset when the stack is empty. */
  private stale = false;
  svg = 0;
  math = 0;
  get size(): number {
    return this.names.length;
  }
  /** Whether a start tag here is read as HTML (the top is an integration point or an HTML element). */
  htmlContext(): boolean {
    const t = this.names.length - 1;
    return t >= 0 && this.kinds[t] !== F_FOREIGN;
  }
  /** An svg / math start tag (not "/>"). false: the stack is full (FOREIGN_STACK_MAX). */
  openRoot(name: 'svg' | 'math'): boolean {
    return this.push(name, F_FOREIGN);
  }
  /**
   * Any other start tag inside svg/math, after the breakout it may cause. In HTML content (the top is an integration
   * point or an HTML element) or while stale: an HTML element, which "/>" does not close (void elements are never
   * pushed). In svg/math content: "/>" closes it; an integration point in its own namespace is one, a name-only one
   * (annotation-xml, an svg mi, a MathML desc) makes the stack stale. false: the stack is full.
   */
  open(name: string, selfClosing: boolean): boolean {
    const t = this.names.length - 1;
    if (t < 0) return true;
    if (this.stale || this.kinds[t] !== F_FOREIGN) return NEVER_OPEN.has(name) || this.push(name, F_HTML);
    if (selfClosing) return true;
    if (!INTEGRATION_POINTS.has(name)) return this.push(name, F_FOREIGN);
    if (this.nsAt[t] === NS_SVG ? SVG_POINTS.has(name) : MATH_POINTS.has(name)) return this.push(name, F_POINT);
    this.stale = true;
    return this.push(name, F_HTML);
  }
  private push(name: string, kind: number): boolean {
    const t = this.names.length;
    if (t >= FOREIGN_STACK_MAX) return false;
    const root = kind === F_FOREIGN && (name === 'svg' || name === 'math');
    // an svg/math opened in HTML content has its own namespace; in svg/math content an element gets its parent's
    const inHtml = t === 0 || this.kinds[t - 1] !== F_FOREIGN;
    this.nsAt.push(kind === F_HTML ? NS_HTML : root && inHtml ? (name === 'svg' ? NS_SVG : NS_MATH) : t > 0 ? this.nsAt[t - 1]! : NS_HTML);
    this.names.push(name);
    this.kinds.push(kind);
    this.htmlAt.push(kind === F_HTML ? t : t > 0 ? this.htmlAt[t - 1]! : -1);
    this.svgAt.push(root && name === 'svg' ? t : t > 0 ? this.svgAt[t - 1]! : -1);
    this.mathAt.push(root && name === 'math' ? t : t > 0 ? this.mathAt[t - 1]! : -1);
    this.rootAt.push(root ? t : t > 0 ? this.rootAt[t - 1]! : -1);
    if (root) {
      if (name === 'svg') this.svg++;
      else this.math++;
    }
    return true;
  }
  private pop(): void {
    const t = this.names.length - 1;
    if (this.svgAt[t] === t) this.svg--;
    else if (this.mathAt[t] === t) this.math--;
    this.names.pop();
    this.kinds.pop();
    this.htmlAt.pop();
    this.svgAt.pop();
    this.mathAt.pop();
    this.rootAt.pop();
    this.nsAt.pop();
    if (this.names.length === 0) this.stale = false;
  }
  /** A breakout tag in svg/math content: the svg/math elements above the nearest HTML element or integration point
   *  close (an integration point here may be none in the parser — annotation-xml without an HTML encoding, an svg
   *  title in MathML — so the scan closes no more than the parser does). */
  breakout(): void {
    while (this.names.length > 0 && this.kinds[this.names.length - 1] === F_FOREIGN) this.pop();
  }
  end(name: string): void {
    const t = this.names.length - 1;
    if (t < 0) return;
    if (this.names[t] === name) {
      this.pop();
      return;
    }
    if (name === 'svg' || name === 'math') {
      const at = (name === 'svg' ? this.svgAt : this.mathAt)[t]!;
      // popped unless: none open; an HTML element above it (the parser ignores the end tag); another svg/math above it
      if (at >= 0 && this.htmlAt[t]! <= at && this.rootAt[t] === at) {
        while (this.names.length > at) this.pop();
        return;
      }
    }
    this.stale = true; // nothing is popped here: the parser may pop more
  }
}
const isAsciiLetter = (c: number) => ((c | 32) - 97) >>> 0 < 26;
/** "<script" in any case: after a "<!--" in script content it may start the double-escaped state (ER-A-01). */
const SCRIPT_OPEN = /<script/gi;
const rawEnds = new Map<string, RegExp>();
/** The element's own end tag: "</name" followed by whitespace, "/" or ">" (any case). */
function rawEnd(name: string): RegExp {
  let re = rawEnds.get(name);
  if (!re) rawEnds.set(name, (re = new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi')));
  return re;
}
/** The HTML tokenizer's whitespace (tab, LF, FF, CR, space). */
const isHtmlSpace = (c: number) => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;

/** What tagEnd tells about a tag: "/>" in the self-closing state; with `fontCheck`, whether it has a color, face or size
 *  attribute (a <font> with one breaks out of foreign content, one without does not). */
interface TagInfo {
  selfClosing: boolean;
  fontCheck: boolean;
  fontExit: boolean;
}
/** The attribute name html[from, to) is color, face or size (any case). */
function isFontExitAttr(html: string, from: number, to: number): boolean {
  const len = to - from;
  if (len !== 4 && len !== 5) return false;
  const a = html.slice(from, to).toLowerCase();
  return a === 'color' || a === 'face' || a === 'size';
}

/** Work counters of the scan: characters examined, and tag names cut and looked up. */
export interface MentionMeter {
  chars: number;
  names?: number;
}

/**
 * Index after the ">" that ends a tag whose attributes start at `j` (the length when the document ends inside it);
 * `tag.selfClosing` tells whether the tag ends with "/>" in the tokenizer's self-closing start tag state. A quote starts
 * a quoted value only right after "=" (the tokenizer's attribute states), so a "<!--" or "<script" inside an attribute
 * value never starts anything and a stray quote elsewhere never hides a ">"; a "/" inside an unquoted value is the value's.
 */
function tagEnd(html: string, j: number, meter: MentionMeter, tag: TagInfo): number {
  const n = html.length;
  const start = j;
  // 0 before attribute name · 1 attribute name · 2 after attribute name · 3 before attribute value · 4 unquoted value
  let state = 0;
  let slash = false; // the last character was a "/" in the self-closing start tag state
  let end = n;
  let nameAt = -1; // where the attribute name being read starts
  tag.selfClosing = false;
  tag.fontExit = false;
  for (; j < n; j++) {
    const c = html.charCodeAt(j);
    if (c === 62) {
      end = j + 1;
      tag.selfClosing = slash;
      break;
    }
    const ws = isHtmlSpace(c);
    slash = false;
    if (state === 0) {
      if (c === 47) slash = true;
      else if (!ws) {
        state = 1;
        nameAt = j;
      }
    } else if (state === 1) {
      if (ws || c === 47 || c === 61) {
        if (tag.fontCheck && isFontExitAttr(html, nameAt, j)) tag.fontExit = true;
        nameAt = -1;
      }
      if (ws) state = 2;
      else if (c === 47) {
        state = 0;
        slash = true;
      } else if (c === 61) state = 3;
    } else if (state === 2) {
      if (c === 47) {
        state = 0;
        slash = true;
      } else if (c === 61) state = 3;
      else if (!ws) {
        state = 1;
        nameAt = j;
      }
    } else if (state === 3) {
      if (c === 34 || c === 39) {
        const q = html.indexOf(c === 34 ? '"' : "'", j + 1);
        if (q < 0) break; // the document ends inside the value
        j = q;
        state = 0;
      } else if (!ws) state = 4;
    } else if (ws) state = 0;
  }
  if (tag.fontCheck && nameAt >= 0 && isFontExitAttr(html, nameAt, end === n ? n : end - 1)) tag.fontExit = true; // ended by ">"
  meter.chars += end - start;
  return end;
}

/**
 * The HTML with comment bodies and <script>/<style> content left out (reviews A-P2-01, A-F7-01) — what remains is the
 * text and the tags, in order. One pass, each character examined a bounded number of times (`meter.chars` counts them):
 * - a comment runs to "-->" / "--!>", or to the end of the document when it is never closed; "<!-->" and "<!--->" are
 *   empty comments
 * - script/style content runs to its own end tag, or to the end of the document. It is hidden only in HTML content: not
 *   while an svg or math element is open (ForeignStack: the elements open inside svg/math, closed only where the parser
 *   surely closes them — an HTML element left open in an integration point keeps the svg/math open, as the parser
 *   ignores the "</svg>" then; a breakout tag closes it, A-F4R1-02; where the parser may have closed more than the scan,
 *   every element opened after that is kept as HTML until the stack is empty, A-F4R2-01) or a select or frameset start
 *   tag is open (counted by name, closed only by its own end tag) — there script/style are foreign elements or ignored
 *   tags whose content can be text — and not for "<script/>" / "<style/>". Those are kept like title/textarea content
 *   up to their end tag; without one, scanning goes on (no raw text in foreign content, all hidden in HTML — either way the scan hides
 *   no more than the parser). More than FOREIGN_STACK_MAX elements open inside svg/math keep the rest as text
 * - while an svg, math, select or frameset is open, a raw text element (title, textarea, xmp, iframe, noembed, noframes,
 *   noscript, and the kept script/style) whose skipped part holds a "<" keeps the rest of the document as text: the
 *   parser reads markup there (a comment, an attribute value, a breakout out of the svg) and the scan cannot tell where
 *   it starts again (ER-A-01). "<svg><title>Icon</title>" and "<svg><style>css</style>" are skipped as before
 * - a hidden script whose content has "<!--" and then "<script" may be in the double-escaped state, where a "</script>"
 *   does not end it: the rest from that "<!--" is kept as text (ER-A-01)
 * - "<![CDATA[" outside svg/math is a bogus comment that ends at the first ">"; inside, when that ">" is not the one of
 *   "]]>", the two readings differ and the rest of the document is kept as text
 * - "<!--" inside an attribute value, a title/textarea (and the other raw text elements) or a doctype/bogus comment is
 *   not a comment
 * Stricter than the parser (a mention counted although the parser hides it — the HTML may be refused, never accepted
 * wrongly): inside a doctype or bogus comment; "<style/>" / "<script/>" in HTML; script/style in svg/math/select;
 * "<svg><style/></svg>" with a "</style>" later (skipped to it: the svg stays open, the script and style content after
 * it counts); "<svg><title/>" (an empty svg title — no "</title" follows, so the rest of the document is kept as text);
 * an svg/math the parser closed in a way the scan does not follow (an end tag of an HTML element around it, an
 * HTML element left open in an integration point, another svg/math opened above it) stays open in the scan; after an
 * end tag that pops nothing in svg/math or a name-only integration point (annotation-xml, an svg mi, a MathML desc),
 * every element up to the end of that svg/math is kept as HTML — a breakout or "</svg>" does not close past it
 * The scan is not a tree builder: where it cannot follow the parser's state it keeps the rest of the document as text
 * or keeps an element open. "Hides no mention the parser shows" holds only for what was checked: the forms in the
 * parse5 8.1.1 table (arxivMentions.test.ts) and the generator sets below, each compared with parse5 8.1.1. Each count
 * of a random or exhaustive run is the sum of each run's distinct strings (mulberry32 or exhaustive; each run counts
 * its own distinct strings, overlap between runs is not removed); the name enumeration is a count of forms:
 * - 5,282,037, none hidden: the A-F7-01 token set with svg/math/select, integration points, self-closing tags and
 *   CDATA (3–28 tokens): 1,785,117; the early review's five sets: 2,497,100; a structured set around integration
 *   points (svg/math, an integration point, HTML elements, "</svg>" / "</math>", closers, then raw text with the
 *   mention — A-F4R1-02, where the A 수정 4 scan hid 14 of 99,996): 999,820. These sets were not built around svg/math
 *   nested in an integration point and closed out of order
 * - for that class (A-F4R2-01; the A 수정 4 fix pass 1 scan hid 158 of 294,156 in the reviewer's structured set),
 *   12,715,258 more, none hidden (the sets above re-run as well): every token sequence (up to 6–8 tokens) after
 *   "<svg><foreignObject>" from four small token sets (svg/math open and close, <a>, </a>, <br>, <img>, </p>, "/>"
 *   forms, mi, annotation-xml, </foreignObject>): 10,831,324; the reviewer's structured set around nested roots and
 *   name-only integration points (4 seeds): 1,176,800; random strings of nested roots, integration points and HTML
 *   names: 699,084; each of 161 element names in 5 integration points and 10 forms: 8,050 forms (7,567 distinct
 *   strings — a form without an integration point repeats per point)
 * These sets were not built around the A-F4R3-01 forms below, and none of their strings reaches one: a table part start
 * tag read as HTML above a nested svg/math does occur (the review counted 5,979 of the 5,282,037), but never with a
 * table open under the nested svg/math and the closing order that form needs. A form outside these sets can still
 * differ. (The first such claim, "about 630,000 strings", came from an LCG that cycled after ~1,300 distinct strings
 * per run and is withdrawn.)
 * Known limit, not fixed (A-F4R3-01): a table part start tag (caption, col, colgroup, table, tbody, td, tfoot, th,
 * thead, tr) read as HTML in an integration point closes up to the table scope, which an integration point does not
 * stop, so the parser can close a nested svg/math there that the scan keeps (no stale state is set). A later
 * formatting element (<a>, <font>) is then foreign in the scan but HTML in the parser, which may reopen it inside the
 * outer integration point — the parser ignores the "</svg>" that closes the svg in the scan, and the scan hides a
 * <style>/<script> content the parser shows as svg text (e.g. "<svg><foreignObject><table><td><svg><foreignObject>
 * <td></td></foreignObject><a></svg></td></table>x</foreignObject></svg></a></foreignObject><style>M</style>"). The
 * parsed text misses it too (linkedom reads that content as style), so both checks can say "same". The reviewer's
 * enumeration of this class (18,900 forms, parse5 shows all): 10,752 hidden. The two real-paper fixtures have no
 * table part inside a foreignObject.
 * What the raw HTML cannot show — a mention written with an entity or split by an inline element (not a sup or sub that
 * holds text) — the structure step reads from the parsed text (textMentions, M-M2-R2-5; its own limits are in the file
 * header).
 */
function textOutsideCommentsAndScripts(html: string, meter: MentionMeter): string {
  const n = html.length;
  const kept: string[] = [];
  const tag: TagInfo = { selfClosing: false, fontCheck: false, fontExit: false };
  const noEnd = new Set<string>();
  let names = 0;
  const fs = new ForeignStack(); // the open svg / math elements and what is open inside them (an over-count keeps text)
  let select = 0; // open select / frameset start tags not yet closed by their own end tag
  let frameset = 0;
  let nextOpen = -1; // the first "<!--" at or after the position it was searched from (n: none)
  let nextScript = -1; // the first "<script" after nextOpen + 4 (n: none)
  let from = 0; // start of the run being kept
  let i = 0;
  while (i < n) {
    const at = html.indexOf('<', i);
    if (at < 0) {
      meter.chars += n - i;
      break;
    }
    meter.chars += at + 1 - i;
    i = at + 1;
    const c = html.charCodeAt(i); // NaN at the end
    if (c === 33 && html.startsWith('--', i + 1)) {
      kept.push(html.slice(from, at));
      i += 3;
      let end: number;
      if (html.charCodeAt(i) === 62) end = i + 1;
      else if (html.startsWith('->', i)) end = i + 2;
      else {
        COMMENT_END.lastIndex = i;
        const m = COMMENT_END.exec(html);
        end = m ? m.index + m[0].length : n;
        meter.chars += end - i;
      }
      from = i = end;
    } else if (c === 33 || c === 63 || (c === 47 && !isAsciiLetter(html.charCodeAt(i + 1)))) {
      // doctype / bogus comment ("<!", "<?", "</" + non-letter): kept, ends at the first ">"
      const e = html.indexOf('>', i);
      const end = e < 0 ? n : e + 1;
      meter.chars += end - i;
      if (c === 33 && fs.svg + fs.math > 0 && html.startsWith('[CDATA[', i + 1) && !html.startsWith(']]', end - 3)) {
        // In svg/math "<![CDATA[" runs to "]]>", in HTML (after content broke out of svg, or in an integration point)
        // it ends at the first ">": here they differ, and the scan cannot tell which — the rest is kept as text
        meter.chars += n - end;
        break;
      }
      i = end;
    } else if (c === 47 || isAsciiLetter(c)) {
      const endTag = c === 47;
      const nameStart = endTag ? i + 1 : i;
      let k = nameStart + 1;
      while (k < n) {
        const d = html.charCodeAt(k);
        if (d === 62 || d === 47 || isHtmlSpace(d)) break;
        k++;
      }
      meter.chars += k - i;
      const len = k - nameStart;
      const inForeign = fs.size > 0;
      // a <font> start tag in svg/math content: its attributes decide whether it breaks out (A-F4R1-02)
      tag.fontCheck = !endTag && len === 4 && inForeign && !fs.htmlContext() && (html.charCodeAt(nameStart) | 32) === 102 && html.slice(nameStart + 1, k).toLowerCase() === 'ont';
      if (k < n && html.charCodeAt(k) === 62) {
        i = k + 1;
        tag.selfClosing = false;
        tag.fontExit = false;
      } else i = tagEnd(html, k, meter, tag);
      const first = NAME_FIRST[html.charCodeAt(nameStart) | 32] ?? 0;
      if (endTag) {
        if (!inForeign && (!(first & 2) || (len !== 6 && len !== 8))) continue;
        names++;
        const name = html.slice(nameStart, k).toLowerCase();
        if (name === 'select') select = Math.max(0, select - 1);
        else if (name === 'frameset') frameset = Math.max(0, frameset - 1);
        // '</p>' and '</br>' in svg/math content break out of it, like the start tags below (parse5 8.1.1)
        if ((name === 'p' || name === 'br') && !fs.htmlContext()) fs.breakout();
        fs.end(name);
        continue;
      }
      if (i >= n || (!inForeign && (!first || len < 3 || len > 9))) continue;
      names++;
      const name = html.slice(nameStart, k).toLowerCase();
      const kind = START_KIND.get(name);
      if (kind === SVG || kind === MATH) {
        if (tag.selfClosing) continue;
        if (!fs.openRoot(name as 'svg' | 'math')) {
          meter.chars += n - i; // deeper than the scan follows: the rest is kept as text
          break;
        }
        continue;
      }
      if (inForeign) {
        // a breakout tag in svg/math content closes the svg/math elements up to an HTML element or integration point
        if (!fs.htmlContext() && (BREAKOUT.has(name) || tag.fontExit)) fs.breakout();
        if (!fs.open(name, tag.selfClosing)) {
          meter.chars += n - i;
          break;
        }
      }
      if (kind === undefined) continue;
      if (kind === PLAINTEXT) {
        meter.chars += n - i;
        break;
      }
      if (kind === SELECT) {
        select++; // "/>" does not close an HTML select
        continue;
      }
      if (kind === FRAMESET) {
        frameset++; // counted like a select: there a <style> start tag is ignored, its content is no raw text
        continue;
      }
      const foreign = fs.svg + fs.math + select + frameset > 0;
      const hide = kind === HIDE && !foreign && !tag.selfClosing;
      // an end tag missing after i is missing after any later position: searched for once per name
      let found: number | undefined;
      if (!noEnd.has(name)) {
        const re = rawEnd(name);
        re.lastIndex = i;
        found = re.exec(html)?.index;
        meter.chars += (found ?? n) - i;
        if (found === undefined) noEnd.add(name);
      }
      // a script/style kept as text without its own end tag: as foreign content ("<svg><style/>") it has no raw text;
      // as HTML it hides the rest — either way scanning on hides no more than the parser does
      if (found === undefined && kind === HIDE && !hide) continue;
      const close = found ?? n;
      if (foreign && found !== undefined) {
        // Inside svg/math/select/frameset the parser may read the skipped part as markup (a comment, an attribute value,
        // a breakout) and restart elsewhere: a "<" there (before the end tag's own) and the rest is kept as text (ER-A-01)
        const lt = html.indexOf('<', i); // ≤ found: the end tag starts with "<"
        meter.chars += lt - i;
        if (lt < found) {
          meter.chars += n - lt;
          break;
        }
      }
      if (hide && name === 'script') {
        // "<!--" and then "<script" in script content: the double-escaped state, where a "</script>" does not end the
        // script — the scan cannot follow it, so the rest from that "<!--" is kept as text (ER-A-01)
        // (the next "<!--" and the next "<script" after it are found once and kept while ahead: each search starts past
        // the previous answer, so all of them together go over the document at most once each)
        if (nextOpen < i) {
          const p = html.indexOf('<!--', i);
          meter.chars += (p < 0 ? n : p) - i;
          nextOpen = p < 0 ? n : p;
        }
        if (nextOpen < close) {
          if (nextScript < nextOpen + 4) {
            SCRIPT_OPEN.lastIndex = nextOpen + 4;
            const p = SCRIPT_OPEN.exec(html)?.index;
            meter.chars += (p ?? n) - (nextOpen + 4);
            nextScript = p ?? n;
          }
          if (nextScript < close) {
            kept.push(html.slice(from, i));
            from = nextOpen;
            meter.chars += n - from;
            break;
          }
        }
      }
      if (hide) {
        kept.push(html.slice(from, i));
        from = close;
      }
      i = close;
    }
    // else: a "<" that starts nothing
  }
  kept.push(html.slice(from));
  meter.names = (meter.names ?? 0) + names;
  return kept.join('');
}

/** One "arXiv:<id>v<N>" mention. */
export interface ArxivMention {
  id: string;
  version: number;
}
/** At most this many distinct (id, version) pairs are kept; one more makes the list overflow (M-M2-R2-5). */
export const MENTION_PAIRS_MAX = 1_000;
/**
 * The distinct (id, version) pairs of a text, in order of first appearance. `overflow`: the text has more than
 * MENTION_PAIRS_MAX distinct pairs — the pairs after the cap are unknown, so the version is unknown (versionVerdict).
 */
export interface MentionList {
  mentions: ArxivMention[];
  overflow: boolean;
}

/** Collects the distinct pairs of one or more texts (text pieces never split a mention: each is matched alone). */
export class MentionCollector {
  readonly mentions: ArxivMention[] = [];
  overflow = false;
  private readonly seen = new Set<string>();
  /** Matches `text`; returns the characters the matcher went over (the whole text, or up to the overflow). */
  add(text: string): number {
    if (this.overflow) return 0;
    MENTION.lastIndex = 0;
    for (const m of text.matchAll(MENTION)) {
      const version = Number(m[2]);
      const key = `${m[1]!} ${version}`;
      if (this.seen.has(key)) continue;
      if (this.mentions.length >= MENTION_PAIRS_MAX) {
        this.overflow = true;
        return m.index + m[0].length;
      }
      this.seen.add(key);
      this.mentions.push({ id: m[1]!, version });
    }
    return text.length;
  }
  list(): MentionList {
    return { mentions: this.mentions, overflow: this.overflow };
  }
}

/** The answer of the version check for the paper `id` at `version`. */
export type VersionVerdict = { kind: 'same' } | { kind: 'other'; version: number } | { kind: 'unknown' };
/**
 * Another version of `id` among the pairs → other; none, but the list overflowed → unknown (the pairs past the cap
 * could hold one — the pipeline treats it as a mismatch, the conservative side); else same (no mention also counts).
 */
export function versionVerdict(list: MentionList, id: string, version: number): VersionVerdict {
  const other = list.mentions.find((m) => m.id === id && m.version !== version);
  if (other) return { kind: 'other', version: other.version };
  return list.overflow ? { kind: 'unknown' } : { kind: 'same' };
}

/**
 * Every "arXiv:<id>v<N>" in the HTML's text — not inside a comment (an unterminated one runs to the end of the
 * document) nor inside <script>/<style> content in HTML (reviews A-P2-01, A-F7-01) — as distinct (id, version) pairs in
 * order of first appearance, at most MENTION_PAIRS_MAX (more → `overflow`). The whole input is scanned whatever the
 * number of mentions (M-M2-R2-5: the decision is not bound to the list). Linear: `meter` (optional) receives the
 * characters examined and the tag names looked up.
 */
export function arxivMentions(html: string, meter: MentionMeter = { chars: 0 }): MentionList {
  const text = textOutsideCommentsAndScripts(html, meter);
  const c = new MentionCollector();
  meter.chars += c.add(text);
  return c.list();
}

const FRAME_TAGS = new Set(['FOOTER', 'NAV', 'HEADER']);
const FRAME_CLASSES = ['ltx_page_header', 'ltx_page_footer', 'ltx_page_navbar', 'ltx_page_logo'];
/** The references: a link there is a cited work's (a tool's repository), not the paper's own code (review A-F1-02). */
const REFERENCE_CLASSES = ['ltx_bibliography', 'ltx_biblist', 'ltx_bibitem', 'ltx_bibblock'];
/**
 * An element whose links are never the paper's code link: the page frame (footer/nav/header, LaTeXML's page
 * header/footer/navbar/logo, arXiv's own `arxiv-*`) or the references (`.ltx_bibliography` and its items).
 */
function notCodeLinkSource(el: El, w: Work): boolean {
  if (FRAME_TAGS.has(el.tagName)) return true;
  w.charge(el.classList.size);
  for (const c of el.classList) if (FRAME_CLASSES.includes(c) || REFERENCE_CLASSES.includes(c) || c.startsWith('arxiv-')) return true;
  return false;
}

// ---- the parser's text (the structure step's version check, M-M2-R2-5)

/** Elements whose content is no text a reader sees: never read for the version check (the A 수정 3 rule). */
const NOT_TEXT = new Set(['SCRIPT', 'STYLE', 'TEMPLATE']);
/** Elements whose start and end separate the text around them; any other element (an inline one, an unknown one) runs
 *  on — `arXiv:2301.<b>00002</b>v2` reads as one mention, as it is drawn. SUP and SUB are RAISED, not here. */
const TEXT_BREAKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BR', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEAD', 'HEADER', 'HR', 'HTML', 'LI', 'MAIN', 'MATH', 'NAV', 'OL', 'OPTION', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TITLE', 'TR', 'UL']);
/** Text drawn raised or lowered (A-FX-01): no continuation of the text around it — LaTeXML's footnote mark or a
 *  superscript citation right after the paper's own version (`v1<sup class="ltx_note_mark">1</sup>`) is not a longer
 *  version. Such an element separates only where it holds text (A-FX5-R1-01): before its first text and after its end;
 *  one that draws nothing (empty, or only comments, script, style, template or empty elements) runs on like an inline
 *  element, so `arXiv:2301.00002<sup></sup>v2` reads as one mention. */
const RAISED = new Set(['SUP', 'SUB']);
/** Characters of text matched in one piece between two yield checks (pieces end where no mention can run on). */
export const TEXT_SLICE = 65_536;
/** A character that can be part of a mention (letters, digits, ".", ":", "/", "-"); any other ends every mention. */
const inMention = (c: number) => ((c | 32) - 97) >>> 0 < 26 || (c - 48) >>> 0 < 10 || c === 46 || c === 58 || c === 47 || c === 45;
const NOT_IN_MENTION = /[^A-Za-z0-9.:/-]/g;

/**
 * The text of the document run through MentionCollector piece by piece, as the walk hands it over. Pending text is
 * matched only up to a character no mention contains (a cut), so the pairs equal one match over the whole text. Each
 * character is looked at a bounded number of times — the search for a cut at the end of each text (at most TEXT_SLICE
 * characters back), the search for a slice end, the match — and charged to the extraction's Work; the matching yields
 * between slices of about TEXT_SLICE characters when the work is due. A run of characters that can all belong to a
 * mention has no cut and is matched in one slice (one regular-expression pass, at most the 4 MB input).
 */
class TextMentions {
  private readonly c = new MentionCollector();
  private parts: string[] = [];
  private len = 0;
  /** Offset in the pending text of a character that no mention contains (the last one found), or -1. */
  private cut = -1;
  /** Characters looked at and not yet charged (charged in whole work units). */
  private looked = 0;
  constructor(private readonly w: Work) {}
  private charge(chars: number): void {
    this.looked += chars;
    if (this.looked >= CHARS_PER_UNIT) {
      const units = Math.floor(this.looked / CHARS_PER_UNIT);
      this.w.charge(units);
      this.looked -= units * CHARS_PER_UNIT;
    }
  }
  /** Adds text that runs on from the text before it; true when enough is pending to match (call flushDue). */
  push(s: string): boolean {
    if (s.length === 0 || this.c.overflow) return false;
    const stop = Math.max(0, s.length - TEXT_SLICE);
    let k = s.length - 1;
    while (k >= stop && inMention(s.charCodeAt(k))) k--;
    this.charge(s.length - k);
    if (k >= stop) this.cut = this.len + k;
    this.parts.push(s);
    this.len += s.length;
    return this.cut >= TEXT_SLICE;
  }
  /** The text before and after do not run on (a block boundary). */
  separate(): boolean {
    return this.push(' ');
  }
  /** RAISED elements open around the walk's position (entered with children, end not reached yet). */
  private raised = 0;
  /** How many of the outermost open RAISED elements hold text already (separated before it); the rest hold none yet. */
  private raisedWithText = 0;
  /** A RAISED element with children is entered: it separates only once text is found in it (A-FX5-R1-01). */
  enterRaised(): void {
    this.raised++;
  }
  /** The end of the innermost open RAISED element: separates when it held text. */
  leaveRaised(): boolean {
    const held = this.raisedWithText === this.raised;
    this.raised--;
    if (!held) return false;
    this.raisedWithText = this.raised;
    return this.separate();
  }
  /** A text node of the document: in an open RAISED element that holds no text yet, separated from the text before. */
  text(s: string): boolean {
    if (s.length === 0) return false;
    let due = false;
    if (this.raisedWithText < this.raised) {
      this.raisedWithText = this.raised;
      due = this.separate();
    }
    return this.push(s) || due;
  }
  *flushDue(): Generator<void, void, void> {
    yield* this.flush(this.cut);
  }
  /** Matches the pending text up to `end` (a cut, or its length) in slices, keeping the rest pending. */
  private *flush(end: number): Generator<void, void, void> {
    const text = this.parts.length === 1 ? this.parts[0]! : this.parts.join('');
    let from = 0;
    while (from < end && !this.c.overflow) {
      let to = Math.min(end, from + TEXT_SLICE);
      if (to < end) {
        NOT_IN_MENTION.lastIndex = to;
        const m = NOT_IN_MENTION.exec(text);
        to = m && m.index < end ? m.index : end;
      }
      this.charge(2 * (to - from)); // the slice-end search and the match
      this.c.add(text.slice(from, to));
      from = to;
      if (this.w.due()) yield;
    }
    const rest = text.slice(end);
    this.parts = rest.length > 0 ? [rest] : [];
    this.len = rest.length;
    this.cut = -1;
  }
  *end(): Generator<void, MentionList, void> {
    if (!this.c.overflow) yield* this.flush(this.len);
    this.w.chars(this.looked);
    this.looked = 0;
    return this.c.list();
  }
}

/**
 * The mentions in the text linkedom built for the whole document: text and CDATA nodes in document order — every child
 * of the document `kids` and its subtree, so text before the first element (linkedom keeps it at document level) and
 * after the last one counts — not inside script, style or template (comments, the doctype are no text nodes); entities
 * are as the parser decoded them, inline elements run on, TEXT_BREAKS elements (blocks, line breaks, cells) separate, a
 * RAISED element (sup, sub) separates only where it holds text. One pre-order walk per child, every node entered and
 * level climbed charged to `w`, yielding when due.
 */
function* parsedTextMentions(kids: ArrayLike<DomNode>, w: Work): Generator<void, MentionList, void> {
  const t = new TextMentions(w);
  for (let k = 0; k < kids.length; k++) {
    const top = kids[k]!;
    let n: DomNode | null = top;
    while (n) {
      if (w.due()) yield;
      w.charge(1);
      if (n.nodeType === ELEMENT_NODE) {
        const name = n.nodeName.toUpperCase();
        if (!NOT_TEXT.has(name)) {
          if (TEXT_BREAKS.has(name) && t.separate()) yield* t.flushDue();
          const c: DomNode | null = n.firstChild;
          if (c) {
            if (RAISED.has(name)) t.enterRaised(); // its end comes when the walk climbs out of it
            n = c;
            continue;
          }
        }
      } else if (isTextNode(n) && t.text(n.nodeValue ?? '')) yield* t.flushDue();
      let m: DomNode = n;
      for (;;) {
        if (m === top) {
          n = null; // the next child of the document comes from `kids` (the doctype has no nextSibling)
          break;
        }
        const s = m.nextSibling;
        if (s) {
          n = s;
          break;
        }
        w.charge(1);
        const p = m.parentNode!; // inside `top`, below it
        const pName = p.nodeName.toUpperCase();
        if (TEXT_BREAKS.has(pName) && t.separate()) yield* t.flushDue(); // the end of p
        else if (RAISED.has(pName) && t.leaveRaised()) yield* t.flushDue();
        m = p;
      }
    }
  }
  return yield* t.end();
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** Section heading: the first h1–h6 among the first HEADING_CHILD_SCAN element children. */
function headingOf(s: El, w: Work): El | null {
  const sib = new SiblingScan(s.firstChild, false, w, HEADING_CHILD_SCAN);
  for (let c = sib.next(); c; c = sib.next()) if (HEADINGS.has(c.tagName)) return c;
  return null;
}

/** The extraction as a generator: every `yield` is a point where parseStructure gives the event loop a turn. */
function* extract(html: string, out: { result?: ParsedStructure }): Generator<void, void, void> {
  if (!/<html[\s>]/i.test(html)) throw new StructureError('structure_parse_failed', 'not an HTML document');
  const scan = scanMarkup(html);
  if (scan.over !== null) {
    const what = { startTags: `more than ${PRESCAN_LIMITS.startTags} start tags`, depth: `nesting depth over ${PRESCAN_LIMITS.depth}`, attributesPerTag: `a tag with more than ${PRESCAN_LIMITS.attributesPerTag} attributes`, nameChars: `a tag or attribute name over ${PRESCAN_LIMITS.nameChars} characters`, nonElementNodes: `more than ${PRESCAN_LIMITS.nonElementNodes} non-element nodes (text, comments)`, foreignContext: `a foreign (MathML/SVG) context longer than ${PRESCAN_LIMITS.foreignContext}` }[scan.over];
    throw new StructureError('structure_too_large', `markup pre-scan: ${what} (not parsed)`);
  }
  yield;
  let doc: Doc;
  try {
    doc = parseHTML(html).document as unknown as Doc;
  } catch (e) {
    throw new StructureError('structure_parse_failed', `HTML parse failed: ${(e as Error).message}`);
  }
  yield;
  if (!doc.querySelector('.ltx_document')) throw new StructureError('structure_parse_failed', 'not a LaTeXML document (no .ltx_document)');
  const secEls = all(doc, SECTION_SEL);
  yield;
  const mathCount = doc.querySelectorAll('math').length;
  yield;
  const bibEls = all(doc, 'li.ltx_bibitem');
  if (secEls.length > STRUCTURE_LIMITS.sections) throw new StructureError('structure_too_large', `${secEls.length} sections (limit ${STRUCTURE_LIMITS.sections})`);
  if (mathCount > STRUCTURE_LIMITS.maths) throw new StructureError('structure_too_large', `${mathCount} <math> elements (limit ${STRUCTURE_LIMITS.maths})`);
  if (bibEls.length > STRUCTURE_LIMITS.bibitems) throw new StructureError('structure_too_large', `${bibEls.length} bibliography items (limit ${STRUCTURE_LIMITS.bibitems})`);
  const warnings: IngestWarningCode[] = [];
  const w = new Work();
  let truncated = false;
  yield;

  // ---- sections
  const keptSec = secEls.slice(0, STORED_CAPS.sections);
  if (secEls.length > keptSec.length) truncated = true;
  const secIndex = new Map<El, number>();
  keptSec.forEach((s, i) => secIndex.set(s, i));
  /** Index of the nearest enclosing kept section (strict ancestor), or null (also when the climb gave up). */
  const sectionOf = (el: El): number | null => {
    const p = climb(el, w, (a) => secIndex.has(a));
    return p ? secIndex.get(p)! : null;
  };
  const sections: ParsedSection[] = [];
  for (const s of keptSec) {
    w.charge(1);
    const h = headingOf(s, w);
    const tagEl = h ? firstWithClass(h, w, 'ltx_tag') : null;
    const tag = tagEl ? textOf(tagEl, w, TAG_CHARS) : '';
    const title = h ? textOf(h, w, TITLE_CHARS, ['ltx_tag', 'ltx_note']) : '';
    sections.push({ htmlId: idOf(s), number: tag || null, title, level: levelOf(s), parentIndex: sectionOf(s) });
    if (w.due()) yield;
  }
  w.mark();
  yield;

  // ---- equations (numbered tags and untagged display tables, document order)
  // Caps per kind: every numbered equation up to STORED_CAPS.equations is kept (the supplement and <eq n> need them);
  // unnumbered display rows only fill the room the numbered ones leave, so the total stays ≤ STORED_CAPS.equations.
  // Context and LaTeX are taken only for kept rows, and the loop stops once both quotas are full.
  const equations: ParsedEquation[] = [];
  const TAGS = '.ltx_tag_equation, .ltx_tag_equationgroup';
  const numberedTotal = doc.querySelectorAll(TAGS).length;
  w.mark();
  yield;
  const numberedCap = STORED_CAPS.equations;
  const unnumberedRoom = STORED_CAPS.equations - Math.min(numberedTotal, numberedCap);
  let numberedKept = 0;
  let unnumberedKept = 0;
  let tagsSeen = 0;
  const eqEls = all(doc, `${TAGS}, table.ltx_equation, table.ltx_equationgroup`);
  w.mark();
  yield;
  const memo: Record<HolderMode, Map<El, HolderLatex | null>> = { plain: new Map(), group: new Map(), untagged: new Map() };
  const latexOf = (holder: El, mode: HolderMode): HolderLatex | null => {
    const m = memo[mode];
    if (m.has(holder)) return m.get(holder)!;
    const v = holderLatex(holder, mode, w);
    m.set(holder, v);
    return v;
  };
  /** latexRaw of an untagged display table that is an equation row of its own (not part of a group, has a row with
   *  math), else null. */
  const untaggedLatex = (el: El): HolderLatex | null => {
    if (climb(el, w, (a) => a.tagName === 'TABLE' && has(a, 'ltx_equationgroup'))) return null; // part of a group
    return latexOf(el, 'untagged');
  };
  let next = 0;
  for (; next < eqEls.length; next++) {
    if (numberedKept >= numberedCap && unnumberedKept >= unnumberedRoom) break;
    if (w.due()) yield;
    const el = eqEls[next]!;
    w.charge(1);
    if (el.tagName === 'TABLE') {
      if (unnumberedKept >= unnumberedRoom) {
        if (untaggedLatex(el) !== null) truncated = true;
        continue;
      }
      const lx = untaggedLatex(el);
      if (lx === null) continue;
      unnumberedKept++;
      if (lx.cut) w.cuts++;
      equations.push({ htmlId: idOf(el), number: null, latexRaw: lx.raw, latexCut: lx.cut, sectionIndex: sectionOf(el), contextBefore: contextBefore(el, w), contextAfter: contextAfter(el, w), group: has(el, 'ltx_equationgroup') });
      continue;
    }
    tagsSeen++;
    const raw = textOf(el, w, TAG_CHARS);
    const number = raw.replace(/^\((.*)\)$/, '$1').trim() || null;
    if (number === null ? unnumberedKept >= unnumberedRoom : numberedKept >= numberedCap) {
      truncated = true;
      continue;
    }
    if (number === null) unnumberedKept++;
    else numberedKept++;
    const group = has(el, 'ltx_tag_equationgroup');
    // One climb for every holder kind and the enclosing table (closest() semantics, the tag itself included).
    let tbodyId: El | null = null;
    let trId: El | null = null;
    let tableId: El | null = null;
    let groupId: El | null = null;
    let table: El | null = null;
    climb(
      el,
      w,
      (a) => {
        const t = a.tagName;
        if (t === 'TBODY') {
          if (!tbodyId && hasIdAttr(a)) tbodyId = a;
        } else if (t === 'TR') {
          if (!trId && hasIdAttr(a)) trId = a;
        } else if (t === 'TABLE') {
          table ??= a;
          if (!tableId && hasIdAttr(a)) tableId = a;
          if (!groupId && has(a, 'ltx_equationgroup') && hasIdAttr(a)) groupId = a;
        }
        return group ? groupId !== null : tbodyId !== null && table !== null;
      },
      true,
    );
    const holder: El | null = group ? groupId : (tbodyId ?? trId ?? tableId);
    const lx = (holder ? latexOf(holder, group ? 'group' : 'plain') : null) ?? { raw: '', cut: false };
    if (lx.cut) w.cuts++;
    equations.push({ htmlId: idOf(holder), number, latexRaw: lx.raw, latexCut: lx.cut, sectionIndex: sectionOf(el), contextBefore: contextBefore(table, w), contextAfter: contextAfter(table, w), group });
  }
  // Stopped with both quotas full: anything left that would have been a row was dropped.
  if (!truncated && next < eqEls.length) {
    if (numberedTotal > tagsSeen) truncated = true; // a tag left = a row dropped
    else {
      for (let k = next; k < eqEls.length; k++) {
        if (w.due()) yield;
        const el = eqEls[k]!;
        w.charge(1);
        if (el.tagName === 'TABLE' && untaggedLatex(el) !== null) {
          truncated = true;
          break;
        }
      }
    }
  }
  // equation_number_gap: the integer numbers (document order) must cover 1…max.
  const ints = equations.map((e) => e.number).filter((n): n is string => n !== null && /^\d+$/.test(n)).map(Number);
  if (ints.length > 0) {
    const max = Math.max(...ints);
    const seen = new Set(ints);
    if (max <= 100_000) {
      for (let k = 1; k <= max; k++) {
        if (!seen.has(k)) {
          warnings.push('equation_number_gap');
          break;
        }
      }
    }
  }
  w.mark();
  yield;

  // ---- figures / tables
  const figures: ParsedFigure[] = [];
  const figEls = all(doc, 'figure.ltx_figure, figure.ltx_table');
  w.mark();
  yield;
  for (const f of figEls) {
    if (w.due()) yield;
    w.charge(1);
    if (climb(f, w, (a) => a.tagName === 'FIGURE')) continue; // sub-panel of another figure
    let cap: El | null = null;
    const sib = new SiblingScan(f.firstChild, false, w, FIGURE_CHILD_SCAN);
    for (let c = sib.next(); c; c = sib.next()) {
      if (c.tagName === 'FIGCAPTION') {
        cap = c;
        break;
      }
    }
    if (!cap) continue;
    if (figures.length >= STORED_CAPS.figures) {
      truncated = true;
      break;
    }
    const tagEl = firstWithClass(cap, w, 'ltx_tag');
    const tag = tagEl ? textOf(tagEl, w, TAG_CHARS) : '';
    figures.push({ htmlId: idOf(f), kind: has(f, 'ltx_table') ? 'table' : 'figure', number: figureNumber(tag), caption: textOf(cap, w, CAPTION_CHARS, ['ltx_tag']), sectionIndex: sectionOf(f) });
  }
  w.mark();
  yield;

  // ---- references
  const references: ParsedReference[] = [];
  for (const li of bibEls) {
    if (w.due()) yield;
    w.charge(1);
    if (references.length >= STORED_CAPS.references) {
      truncated = true;
      break;
    }
    // rawText: the text of each .ltx_bibblock (squashed), joined by a space; label: the first .ltx_tag_bibitem.
    const blocks: string[][] = [];
    let inBlock: El | null = null;
    let len = 0;
    let cut = false;
    const ended = walk(
      li,
      w,
      TEXT_STEPS,
      (n) => {
        if (n.nodeType === ELEMENT_NODE) {
          if (isAnnotation(asEl(n))) return SKIP;
          if (!inBlock && has(asEl(n), 'ltx_bibblock')) {
            inBlock = asEl(n);
            blocks.push([]);
          }
          return DESCEND;
        }
        if (!inBlock || !isTextNode(n)) return SKIP;
        const v = n.nodeValue ?? '';
        if (v.length === 0) return SKIP;
        if (len >= REFERENCE_CHARS) {
          cut = true; // more block text after the cap
          return STOP;
        }
        const piece = v.length > REFERENCE_CHARS - len ? v.slice(0, REFERENCE_CHARS - len) : v;
        if (piece.length < v.length) cut = true;
        blocks[blocks.length - 1]!.push(piece);
        len += piece.length;
        return cut ? STOP : SKIP;
      },
      (el) => {
        if (el === inBlock) inBlock = null;
      },
    );
    w.chars(len);
    const text = squash(blocks.map((b) => squash(b.join(''))).join(' '));
    const labelEl = firstWithClass(li, w, 'ltx_tag_bibitem');
    const label = (labelEl ? textOf(labelEl, w, TAG_CHARS) : '') || null;
    if (cut || !ended) {
      // cut at a cap: "…", and the ids are unknown — the cut may fall inside one (review A-R3-03)
      w.cuts++;
      references.push({ htmlId: idOf(li), label, rawText: text + ELLIPSIS, arxivId: null, doi: null });
    } else references.push({ htmlId: idOf(li), label, rawText: text, ...referenceIds(text) });
  }
  w.mark();
  yield;

  // ---- the rest
  let codeUrl: string | null = null;
  const body = doc.querySelector('.ltx_page_main') ?? doc.querySelector('.ltx_document');
  const links = body ? Array.from(body.querySelectorAll('a[href]')) : [];
  w.mark();
  yield;
  // Inside a frame element or the references? Climb towards the body, memoising the answer for every element passed
  // (each element is climbed through once — linear in all).
  const inFrame = new Map<El, boolean>();
  const framed = (a: El): boolean => {
    const passed: El[] = [];
    let v = false;
    for (let p: El | null = a; p && p !== body; p = p.parentElement) {
      const known = inFrame.get(p);
      if (known !== undefined) {
        v = known;
        break;
      }
      w.charge(1);
      passed.push(p);
      if (notCodeLinkSource(p, w)) {
        v = true;
        break;
      }
    }
    for (const e of passed) inFrame.set(e, v);
    return v;
  };
  for (let k = 0; k < links.length && k < ANCHORS_MAX; k++) {
    if (w.due()) yield;
    const href = links[k]!.getAttribute('href') ?? '';
    w.charge(1);
    if (href.length > HREF_MAX || !href.includes(':')) continue; // no scheme: new URL(href) throws without a base
    w.chars(href.length);
    const u = githubCodeUrl(href);
    if (u && !framed(links[k]!)) {
      codeUrl = u;
      break;
    }
  }
  w.mark();
  yield;
  // ---- the parser's text: the version check sees what linkedom made of entities and inline elements (M-M2-R2-5)
  const textStart = w.n;
  const textMentions = yield* parsedTextMentions(doc.childNodes, w);
  const textWork = w.n - textStart;
  w.mark();
  yield;
  const ltxErrors = doc.querySelectorAll('.ltx_ERROR').length;
  if (truncated || w.cuts > 0) warnings.push('structure_truncated');
  if (sections.length === 0 && equations.length === 0 && references.length === 0) throw new StructureError('structure_parse_failed', 'the document has no sections, equations or references');
  out.result = { sections, equations, figures, references, ltxErrors, codeUrl, arxivMentions: arxivMentions(html).mentions, textMentions, warnings, work: w.n, textWork, maxWorkBetweenYields: w.maxBetween };
}

/** Synchronous parse (tests, scripts). Throws StructureError. */
export function parse(html: string): ParsedStructure {
  const out: { result?: ParsedStructure } = {};
  for (const _ of extract(html, out)) void _;
  return out.result!;
}

export type StructureParseResult = { ok: true; structure: ParsedStructure } | { ok: false; warning: 'structure_too_large' | 'structure_parse_failed'; message: string };

/** Pipeline entry: yields around parseHTML and inside the extraction; never throws (except an abort via `signal`). */
export async function parseStructure(html: string, signal?: AbortSignal): Promise<StructureParseResult> {
  const out: { result?: ParsedStructure } = {};
  try {
    await yieldNow();
    for (const _ of extract(html, out)) {
      void _;
      await yieldNow();
      if (signal?.aborted) throw new IngestError('cancelled', 'structure extraction cancelled');
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e instanceof StructureError) return { ok: false, warning: e.warning, message: e.message };
    return { ok: false, warning: 'structure_parse_failed', message: `structure extraction failed: ${(e as Error).message}` };
  }
  return { ok: true, structure: out.result! };
}
