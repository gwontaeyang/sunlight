// PDF links (PLAN_M2 3.8, BRIEF_C C4). Owner C.
// pdf.js (6.5) renders the annotation layer with its PDFLinkService. Internal links sit in a
// <section class="linkAnnotation" data-internal-link> with an onclick: destinations as <a href="#…">, and named
// actions (NextPage, GoBack, …), attachments and optional-content links as <a href=""> (no baseUrl is set). URL links
// are <a href="https://…"> in a section without that attribute. One capture-phase click handler on the reader
// decides before pdf.js does:
//   ① internal link to a citation destination (named destination `cite.…`, the hyperref / natbib / biblatex name of a
//      bibliography entry) whose rect holds exactly one citation number in the text layer ("[12]", "12", "12,") and
//      the paper's references have exactly ONE item with that ordinal or label → focus the references panel, no move.
//      Fix round 1 (C-R1-03): figure, equation, footnote, algorithm and section links also show a single number
//      ("Fig. 3", "(5)", a footnote mark), so the number alone never makes a link a citation: any other named
//      destination (`figure.…`, `equation.…`, `Hfootnote.…`, `algocf.…`, …) and every explicit destination is ②
//   ② any other internal link → push the position stack, then pdf.js moves as usual
//   ③ http(s) link → confirm showing the host, then a new tab (noopener noreferrer); every other scheme is ignored
// The number is read only from the text layer glyphs inside the link rect (bounded work); nothing is guessed.
import type { ReferenceDto } from '@study-paper/shared/contracts/api';

/** "[12]", "12", "12," / "12;" / "12]" — one number of 1–3 digits (BRIEF_C C4). */
export const CITATION_NUMBER_RE = /^\[?\s*(\d{1,3})\s*[\],;]?$/;
/** Upper bound of glyphs examined per click (text layer characters inside / around the link rect). */
export const LINK_TEXT_MAX_CHARS = 4000;

/** The citation number shown in a link, or null when the text is not exactly one number. */
export function citationNumber(text: string): number | null {
  const m = CITATION_NUMBER_RE.exec(text.trim());
  return m ? Number(m[1]) : null;
}

/** A reference label as a number: "[12]" or "12" → 12; anything else (e.g. "[Smith20]") → null. */
function labelNumber(label: string | null): number | null {
  if (label === null) return null;
  const m = /^\[?(\d{1,3})\]?$/.exec(label.trim());
  return m ? Number(m[1]) : null;
}

/** The one reference whose ordinal or label is `n`; null when none or more than one item has it. */
export function referenceForNumber(n: number, references: readonly ReferenceDto[]): ReferenceDto | null {
  const hits = references.filter((r) => r.ordinal === n || labelNumber(r.label) === n);
  return hits.length === 1 ? hits[0]! : null;
}

export type LinkDecision =
  | { kind: 'reference'; referenceOrdinal: number }
  | { kind: 'internal' }
  | { kind: 'external'; url: string; host: string }
  | { kind: 'ignore' };

/**
 * The named destination of an internal link href ("#cite.ref1" → "cite.ref1"; pdf.js escape()s it), or null for an
 * explicit destination (pdf.js writes those as a JSON array, "#%5B…") or no destination.
 */
export function namedDestination(href: string | null): string | null {
  if (!href) return null;
  const i = href.indexOf('#');
  if (i < 0) return null;
  let dest = href.slice(i + 1);
  try {
    dest = unescape(dest);
  } catch {
    return null;
  }
  return dest && !dest.startsWith('[') ? dest : null;
}

/** A destination that is a bibliography entry: hyperref's `cite.<key>` (natbib / biblatex use the same prefix). */
export function isCitationDestination(href: string | null): boolean {
  return /^cite\./.test(namedDestination(href) ?? '');
}

/** What a link with this href does. `internal` = pdf.js marked it as an internal link (see isInternalLink). */
export function classifyLink(o: { href: string | null; internal: boolean; text: string; references: readonly ReferenceDto[] }): LinkDecision {
  if (o.internal) {
    if (!isCitationDestination(o.href)) return { kind: 'internal' };
    const n = citationNumber(o.text);
    const ref = n === null ? null : referenceForNumber(n, o.references);
    return ref ? { kind: 'reference', referenceOrdinal: ref.ordinal } : { kind: 'internal' };
  }
  const href = o.href?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: 'ignore' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'ignore' };
  if (!url.hostname) return { kind: 'ignore' };
  return { kind: 'external', url: url.href, host: url.host };
}

interface BoxLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const inside = (x: number, y: number, b: BoxLike) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
const overlaps = (a: BoxLike, b: BoxLike) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * The text-layer characters whose glyph centre lies inside `rect` (client coordinates), in DOM order. Only text
 * nodes whose span overlaps the rect are measured, at most `maxChars` characters in total (then '' — unknown).
 */
export function textInRect(layer: Element, rect: BoxLike, maxChars = LINK_TEXT_MAX_CHARS): string {
  const doc = layer.ownerDocument;
  const walker = doc.createTreeWalker(layer, 4 /* NodeFilter.SHOW_TEXT */);
  const range = doc.createRange();
  let budget = maxChars;
  let out = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const parent = t.parentElement;
    if (!parent || !overlaps(parent.getBoundingClientRect(), rect)) continue;
    const len = t.data.length;
    if (len > budget) return '';
    budget -= len;
    for (let i = 0; i < len; i++) {
      range.setStart(t, i);
      range.setEnd(t, i + 1);
      const b = range.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      if (inside(b.left + b.width / 2, b.top + b.height / 2, rect)) out += t.data[i];
    }
  }
  return out;
}

export interface LinkHandlerContext {
  references(): readonly ReferenceDto[];
  /** ① a citation number with exactly one reference. */
  focusReference(ordinal: number): void;
  /** ② before pdf.js follows an internal link. */
  beforeInternalJump(): void;
  /** ③ ask the user (host shown) before opening. */
  confirmExternal(url: string, host: string): void;
}

/**
 * pdf.js marks an internal link on its annotation section (`data-internal-link`, C-R2-02); a '#…' href is the same
 * thing for a destination link. pdf.js 6.5 never sets a class `internalLink`.
 */
export function isInternalLink(a: Element): boolean {
  if (a.closest('section')?.hasAttribute('data-internal-link')) return true;
  const href = a.getAttribute('href');
  return href !== null && href.startsWith('#');
}

/**
 * The capture-phase click and auxclick handler of the reader (see the module comment). A middle click (auxclick)
 * would open the href in a new tab without the confirmation (C-R1-07): an external link gets the same confirmation,
 * an internal one is dropped (a new tab of "#dest" is no place in this paper). Other auxclick buttons (right click)
 * are left to the browser.
 */
export function handleLinkClick(e: MouseEvent, ctx: LinkHandlerContext): void {
  const target = e.target as Element | null;
  const a = target?.closest?.('.annotationLayer a') as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.getAttribute('href');
  const internal = isInternalLink(a);
  if (e.type === 'auxclick') {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    if (internal) return;
    const d = classifyLink({ href, internal: false, text: '', references: [] });
    if (d.kind === 'external') ctx.confirmExternal(d.url, d.host);
    return;
  }
  let text = '';
  if (internal && isCitationDestination(href)) {
    const pageEl = a.closest('.page');
    const layer = pageEl?.querySelector('.textLayer');
    const box = (a.closest('section') ?? a).getBoundingClientRect();
    if (layer) text = textInRect(layer, box);
  }
  const d = classifyLink({ href, internal, text, references: ctx.references() });
  if (d.kind === 'internal') {
    ctx.beforeInternalJump();
    return; // pdf.js follows the link
  }
  e.preventDefault();
  e.stopPropagation();
  if (d.kind === 'reference') ctx.focusReference(d.referenceOrdinal);
  else if (d.kind === 'external') ctx.confirmExternal(d.url, d.host);
}

/** Opens a confirmed external link in a new tab without opener / referrer. */
export function openExternal(url: string, open: (url: string, target: string, features: string) => unknown = (u, t, f) => window.open(u, t, f)): void {
  const d = classifyLink({ href: url, internal: false, text: '', references: [] });
  if (d.kind !== 'external') return;
  open(d.url, '_blank', 'noopener,noreferrer');
}
