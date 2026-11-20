// Linear pre-scan of an HTML document before linkedom's parseHTML (PLAN_M2 P7 · 3.2 · 9절 39, review A-R2-02). Owner A.
//
// parseHTML is one synchronous call; the 4 MB input cap does not bound its time: it is linear in the element count but
// quadratic in the nesting depth (htmlparser2 looks an end tag up in its open-element stack — A measured a 180,000-deep
// table at 12.7 s, 300,000 nested <b> at 28.9 s). So the markup is scanned once, linearly, and parseHTML runs only when
//   start tags ≤ 300,000 · estimated nesting depth ≤ 256 · attributes per tag ≤ 256 · tag/attribute name ≤ 64 chars
//   · non-element nodes ≤ 600,000 (bound) · htmlparser2 foreign-context length ≤ 64
// (attributes and names bound linkedom's per-element accessor costs — attribute lookups walk the element's attribute
// list, tagName upper-cases the name — that the extraction's work counter charges as one unit per element, review
// A-R3-02. Non-element nodes are not start tags but cost parse time and memory just the same: every "<" that starts no
// tag cuts a text node, so 4 MB of "<" is 4.19 M text nodes and a 34 s parse — review A-F2-01. htmlparser2's
// foreignContext array gets an entry (unshift) per math/svg/integration open tag and loses it only at an end tag of
// that very name; left behind by an ancestor's end tag or a foreign self-closing tag it grows with the start tags, not
// the depth, and the parse time grows with its square — review A-F2-02.)
//
// The depth estimate must never be smaller than the depth of the DOM linkedom builds (htmlparser2 10's tree rules, which
// linkedom follows: one DOM level per htmlparser2 stack entry). It replays htmlparser2's tokenizer and stack:
//   - void elements are not stacked (their depth still counts: they sit one level below the open elements);
//   - an end tag pops up to the nearest open element of that name; without one it is ignored — except `</p>` (an empty
//     p is created) and `</br>` (a br is created), which count one level below the open elements like htmlparser2;
//   - an open tag first pops the open elements it implies closed (htmlparser2's openImpliesClose — modelled, otherwise
//     `<p><div></p>` repeated would let the estimate fall behind: the parser's p is closed by <div>, so its `</p>` makes
//     a new empty p and the div stays open);
//   - `/>` never closes anything here. Where htmlparser2 does close it (inside math/svg — its foreign context), the
//     element stays on our stack as a "ghost": it counts for the depth of what follows (deeper than the parser — the
//     safe side) but no end tag or implied close matches it, so every pop decision is the parser's own;
//   - raw-text elements are skipped to their end tag, picked like htmlparser2's tokenizer does: by the first letter and
//     the rest of the name, not the whole name — script and style, but also t/x + "itle", "extarea", "mp" (so <tmp> reads
//     raw text up to "</xmp", <xitle> up to "</title", <xextarea> up to "</textarea", and stays open: that end tag has
//     another name — review A-F1-01). Comments (`<!--…-->`),
//     CDATA (`<![CDATA[…]]>`), declarations (`<!…>`) and processing instructions (`<?…>`) are skipped, and a `<` or `>`
//     inside a quoted attribute value is never a tag.
// The non-element node bound is never below the text, comment and CDATA nodes linkedom creates (one per htmlparser2
// ontext/oncomment event; declarations and processing instructions are counted too though linkedom makes no node):
//   - a "<" whose text section (htmlparser2's sectionStart up to it) is not empty: +1 for that text; a "<" that starts no
//     tag (and "</>") stays in the next section like in the tokenizer;
//   - every comment, CDATA section, bogus comment ("</1x>"), declaration and processing instruction: +1; a raw-text
//     body: +1; trailing text at the end of the input: +1;
//   - every "&" in the whole input: +3 (in text and <title> raw text an entity emits the text before it and up to two
//     code points as separate text events; counting every "&" — also in attributes and comments — only adds).
// The foreign-context length is htmlparser2's exactly (same pushes and pops, [false] at the start).
// Each element is pushed and popped once; open elements are counted per name, so a pop is amortised O(1) and the whole
// scan is linear in the input. It stops at the first limit it passes.
//
// openImpliesClose, the void set and the foreign/integration sets are copied from htmlparser2 10.1.0 (src/Parser.ts,
// MIT licence, "Copyright 2010, 2011, Chris Winberry <chris@winberry.net>" — node_modules/htmlparser2/LICENSE).

export const PRESCAN_LIMITS = { startTags: 300_000, depth: 256, attributesPerTag: 256, nameChars: 64, nonElementNodes: 600_000, foreignContext: 64 } as const;

export interface MarkupScan {
  /** Start tags seen (plus the elements `</p>` and `</br>` create), up to the stop. */
  startTags: number;
  /** Estimated maximum element depth (≥ the depth of linkedom's DOM; the root html element is depth 1). */
  maxDepth: number;
  /** Most attributes on one tag (duplicates counted). */
  maxAttributes: number;
  /** Longest tag or attribute name. */
  maxNameChars: number;
  /** Upper bound of the text, comment and CDATA nodes the parse creates (≥ linkedom's count), up to the stop. */
  nonElementNodes: number;
  /** Longest htmlparser2 foreignContext (it starts with one entry), up to the stop. */
  maxForeignContext: number;
  /** The first limit passed (the scan stopped there), or null. */
  over: keyof typeof PRESCAN_LIMITS | null;
}

const pTag = new Set(['p']);
const formTags = new Set(['input', 'option', 'optgroup', 'select', 'button', 'datalist', 'textarea']);
const tableSectionTags = new Set(['thead', 'tbody']);
const ddtTags = new Set(['dd', 'dt']);
const rtpTags = new Set(['rt', 'rp']);
const OPEN_IMPLIES_CLOSE = new Map<string, Set<string>>([
  ['tr', new Set(['tr', 'th', 'td'])],
  ['th', new Set(['th'])],
  ['td', new Set(['thead', 'th', 'td'])],
  ['body', new Set(['head', 'link', 'script'])],
  ['li', new Set(['li'])],
  ['p', pTag],
  ['h1', pTag],
  ['h2', pTag],
  ['h3', pTag],
  ['h4', pTag],
  ['h5', pTag],
  ['h6', pTag],
  ['select', formTags],
  ['input', formTags],
  ['output', formTags],
  ['button', formTags],
  ['datalist', formTags],
  ['textarea', formTags],
  ['option', new Set(['option'])],
  ['optgroup', new Set(['optgroup', 'option'])],
  ['dd', ddtTags],
  ['dt', ddtTags],
  ['address', pTag],
  ['article', pTag],
  ['aside', pTag],
  ['blockquote', pTag],
  ['details', pTag],
  ['div', pTag],
  ['dl', pTag],
  ['fieldset', pTag],
  ['figcaption', pTag],
  ['figure', pTag],
  ['footer', pTag],
  ['form', pTag],
  ['header', pTag],
  ['hr', pTag],
  ['main', pTag],
  ['nav', pTag],
  ['ol', pTag],
  ['pre', pTag],
  ['section', pTag],
  ['table', pTag],
  ['ul', pTag],
  ['rt', rtpTags],
  ['rp', rtpTags],
  ['tbody', tableSectionTags],
  ['tfoot', tableSectionTags],
]);
const VOID = new Set(['area', 'base', 'basefont', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'img', 'input', 'isindex', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const FOREIGN = new Set(['math', 'svg']);
const INTEGRATION = new Set(['mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml', 'foreignobject', 'desc', 'title']);
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) | 0x20));
/**
 * The raw-text ("special") end sequence an open tag name starts, or null — htmlparser2 10.1.0's Tokenizer
 * (stateBeforeTagName → stateBeforeSpecialS/T → startSpecial(sequence, 4) → stateSpecialStartSequence, MIT): the first
 * letter s picks script (second letter c) or style (t); the first letter t or x picks title (i), textarea (e) or xmp
 * (m); the rest of the name must then equal the rest of that sequence, ASCII-case-insensitively, and end there.
 */
export function rawTextSequence(rawName: string): 'script' | 'style' | 'title' | 'textarea' | 'xmp' | null {
  const lower = asciiLower(rawName);
  const first = lower.charAt(0);
  const rest = lower.slice(1);
  if (first === 's') return rest === 'cript' ? 'script' : rest === 'tyle' ? 'style' : null;
  if (first === 't' || first === 'x') return rest === 'itle' ? 'title' : rest === 'extarea' ? 'textarea' : rest === 'mp' ? 'xmp' : null;
  return null;
}

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const DASH = 0x2d;
const LBRACKET = 0x5b;
const EQ = 0x3d;
const DQ = 0x22;
const SQ = 0x27;
const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0c || c === 0x0d;
const isEndOfTagSection = (c: number) => c === SLASH || c === GT || isWs(c);
const isAlpha = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);

/**
 * The raw text of a special element starting at `from`: the index just after the end tag's name ("</script" — the
 * character there is whitespace or ">"), or -1 when the input ends first. A port of htmlparser2 10.1.0's
 * Tokenizer.stateInSpecialTag (MIT): the sequence match uses (c | 0x20); without a partial match the scan jumps to the
 * next literal "<" (title looks at every character, which only matters for entities — the match is the same).
 */
function skipRawText(html: string, from: number, name: string): number {
  const seq = [LT, SLASH, ...Array.from(name, (ch) => ch.charCodeAt(0))];
  const n = html.length;
  const title = name === 'title';
  let k = 0;
  for (let idx = from; idx < n; idx++) {
    const c = html.charCodeAt(idx);
    if (k === seq.length) {
      if (c === GT || isWs(c)) return idx;
      k = 0;
    }
    if ((c | 0x20) === seq[k]) k++;
    else if (k === 0) {
      if (!title) {
        const lt = html.indexOf('<', idx + 1);
        if (lt < 0) return -1;
        idx = lt; // the loop steps past it with k = 1
        k = 1;
      }
    } else k = Number(c === LT);
  }
  return -1;
}

class Limit extends Error {
  constructor(readonly which: keyof typeof PRESCAN_LIMITS) {
    super(which);
  }
}

/** Scan `html` once (see the file comment). Never throws. */
export function scanMarkup(html: string): MarkupScan {
  const n = html.length;
  const out: MarkupScan = { startTags: 0, maxDepth: 0, maxAttributes: 0, maxNameChars: 0, nonElementNodes: 0, maxForeignContext: 1, over: null };
  // stack[i] = element name; ghost[i] = closed by the parser (foreign self-closing) but kept here for depth.
  const stack: string[] = [];
  /** Indices into `stack` of the entries the parser has (not ghosts), bottom → top. */
  const real: number[] = [];
  const open = new Map<string, number>();
  /** htmlparser2's foreignContext, top = last ([false] in HTML mode). */
  const foreign: boolean[] = [false];

  const depthAt = (d: number) => {
    if (d > out.maxDepth) out.maxDepth = d;
    if (d > PRESCAN_LIMITS.depth) throw new Limit('depth');
  };
  const name = (len: number) => {
    if (len > out.maxNameChars) out.maxNameChars = len;
    if (len > PRESCAN_LIMITS.nameChars) throw new Limit('nameChars');
  };
  const nodes = (k: number) => {
    out.nonElementNodes += k;
    if (out.nonElementNodes > PRESCAN_LIMITS.nonElementNodes) throw new Limit('nonElementNodes');
  };
  const created = () => {
    out.startTags++;
    if (out.startTags > PRESCAN_LIMITS.startTags) throw new Limit('startTags');
  };
  /** Pop the parser's top element (and every ghost above it). */
  const popReal = () => {
    const i = real.pop()!;
    const nm = stack[i]!;
    open.set(nm, open.get(nm)! - 1);
    stack.length = i;
    return nm;
  };
  const openTag = (raw: string): boolean => {
    name(raw.length);
    const nm = raw.toLowerCase();
    const implies = OPEN_IMPLIES_CLOSE.get(nm);
    if (implies) while (real.length > 0 && implies.has(stack[real[real.length - 1]!]!)) popReal();
    created();
    if (VOID.has(nm)) {
      depthAt(stack.length + 1);
      return false;
    }
    real.push(stack.length);
    stack.push(nm);
    open.set(nm, (open.get(nm) ?? 0) + 1);
    depthAt(stack.length);
    if (FOREIGN.has(nm) || INTEGRATION.has(nm)) {
      foreign.push(FOREIGN.has(nm));
      if (foreign.length > out.maxForeignContext) out.maxForeignContext = foreign.length;
      if (foreign.length > PRESCAN_LIMITS.foreignContext) throw new Limit('foreignContext');
    }
    return true;
  };
  const selfClosed = (stacked: boolean) => {
    // htmlparser2: closes the element only in a foreign context; here it becomes a ghost (stays for the depth).
    if (!stacked || foreign[foreign.length - 1] !== true) return;
    const i = real.pop()!;
    const nm = stack[i]!;
    open.set(nm, open.get(nm)! - 1);
  };
  const closeTag = (raw: string) => {
    name(raw.length);
    const nm = raw.toLowerCase();
    if (FOREIGN.has(nm) || INTEGRATION.has(nm)) foreign.pop();
    if (!VOID.has(nm)) {
      if ((open.get(nm) ?? 0) > 0) {
        while (popReal() !== nm);
      } else if (nm === 'p') {
        created(); // an empty <p></p> one level below the open elements
        depthAt(stack.length + 1);
      }
    } else if (nm === 'br') {
      created();
      depthAt(stack.length + 1);
    }
  };

  try {
    for (let a = html.indexOf('&'); a >= 0; a = html.indexOf('&', a + 1)) nodes(3);
    let i = 0;
    /** htmlparser2's sectionStart for text (or before it — that only adds). */
    let textFrom = 0;
    while (i < n) {
      const lt = html.indexOf('<', i);
      if (lt < 0) break;
      if (lt > textFrom) nodes(1); // the text before this "<"
      // A "<" that starts no tag, "</>" and a token cut off by the end of the input leave the text section at this "<"
      // (htmlparser2 keeps its sectionStart there); a complete token moves it to the token's end below.
      textFrom = lt;
      const c = html.charCodeAt(lt + 1);
      if (c === BANG) {
        nodes(1); // a comment, CDATA section (a comment in HTML mode) or declaration
        const d = html.charCodeAt(lt + 2);
        if (d === DASH && html.charCodeAt(lt + 3) === DASH) {
          const e = html.indexOf('-->', lt + 2); // "<!-->" and "<!--->" are complete comments in htmlparser2
          i = e < 0 ? n : e + 3;
        } else if (d === LBRACKET && html.startsWith('CDATA[', lt + 3)) {
          const e = html.indexOf(']]>', lt + 9);
          i = e < 0 ? n : e + 3;
        } else {
          // a declaration: the character after "<!" (or after "<!-") is consumed without a check, then up to ">"
          const from = d === DASH ? lt + 4 : d === LBRACKET ? lt + 3 : lt + 3;
          const e = html.indexOf('>', from);
          i = e < 0 ? n : e + 1;
        }
        textFrom = i;
        continue;
      }
      if (c === QUESTION) {
        nodes(1); // a processing instruction
        const e = html.indexOf('>', lt + 2);
        i = e < 0 ? n : e + 1;
        textFrom = i;
        continue;
      }
      if (c === SLASH) {
        let p = lt + 2;
        while (p < n && isWs(html.charCodeAt(p))) p++;
        if (p >= n) break;
        const f = html.charCodeAt(p);
        if (f === GT) {
          i = p + 1; // "</>": no event, and it stays in the text section that started at its "<"
          continue;
        }
        if (!isAlpha(f)) {
          nodes(1);
          const e = html.indexOf('>', p); // a bogus comment
          i = e < 0 ? n : e + 1;
          textFrom = i;
          continue;
        }
        let q = p;
        while (q < n && html.charCodeAt(q) !== GT && !isWs(html.charCodeAt(q))) q++;
        if (q >= n) break; // unterminated end tag at the end of the input: no event
        closeTag(html.slice(p, q));
        const e = html.indexOf('>', q);
        i = e < 0 ? n : e + 1;
        // an end tag without '>' before the end of the input: htmlparser2 emits it and then the rest as trailing text
        textFrom = e < 0 ? lt : i;
        continue;
      }
      if (!isAlpha(c)) {
        i = lt + 1; // text; the next character is looked at again
        continue;
      }
      // an open tag: the name, then the attributes up to ">" (quoted values may hold "<" and ">")
      let p = lt + 1;
      while (p < n && !isEndOfTagSection(html.charCodeAt(p))) p++;
      if (p >= n) break;
      const rawName = html.slice(lt + 1, p);
      const stacked = openTag(rawName);
      let attrs = 0;
      let selfClosing = false;
      let ended = false;
      let st = 0; // 0 before name, 1 in name, 2 after name, 3 before value, 4 unquoted value, 5 in "/"
      let nameStart = 0;
      while (p < n && !ended) {
        const ch = html.charCodeAt(p);
        switch (st) {
          case 0:
            if (ch === GT) ended = true;
            else if (ch === SLASH) st = 5;
            else if (!isWs(ch)) {
              st = 1;
              nameStart = p;
            }
            p++;
            break;
          case 1:
            if (ch === EQ || isEndOfTagSection(ch)) {
              attrs++;
              if (attrs > out.maxAttributes) out.maxAttributes = attrs;
              if (attrs > PRESCAN_LIMITS.attributesPerTag) throw new Limit('attributesPerTag');
              name(p - nameStart);
              st = 2; // look at this character again
            } else p++;
            break;
          case 2:
            if (ch === EQ) {
              st = 3;
              p++;
            } else if (ch === SLASH || ch === GT) st = 0;
            else if (!isWs(ch)) {
              st = 1;
              nameStart = p;
              p++;
            } else p++;
            break;
          case 3:
            if (ch === DQ || ch === SQ) {
              const e = html.indexOf(ch === DQ ? '"' : "'", p + 1);
              p = e < 0 ? n : e + 1;
              st = 0;
            } else if (!isWs(ch)) st = 4;
            else p++;
            break;
          case 4:
            if (isWs(ch) || ch === GT) st = 0;
            else p++;
            break;
          case 5:
            if (ch === GT) {
              ended = true;
              selfClosing = true;
              p++;
            } else if (!isWs(ch)) st = 0;
            else p++;
            break;
        }
      }
      if (!ended) break; // the input ended inside the tag
      i = p;
      textFrom = i;
      if (selfClosing) {
        selfClosed(stacked);
        continue;
      }
      const special = rawTextSequence(rawName);
      if (special !== null) {
        // htmlparser2's stateInSpecialTag, character for character: the end sequence "</name" is compared with
        // (c | 0x20) — so "\x1c\x0f" also reads as "</" — and must be followed by whitespace or ">".
        nodes(1); // the raw text (one text event; entities in <title> are in the "&" count)
        const end = skipRawText(html, i, special);
        if (end < 0) break; // raw text to the end of the input
        closeTag(html.slice(end - special.length, end)); // the end tag as written ("</XMP" for <tmp>): pops by that name
        if (html.charCodeAt(end) === GT) i = end + 1;
        else {
          const e = html.indexOf('>', end);
          i = e < 0 ? n : e + 1;
          if (e < 0) continue; // no '>' up to the end: trailing text after the end tag (textFrom stays before it)
        }
        textFrom = i;
      }
    }
    if (textFrom < n) nodes(1); // trailing text (or what an unfinished token leaves)
  } catch (e) {
    if (!(e instanceof Limit)) throw e;
    out.over = e.which;
  }
  return out;
}
