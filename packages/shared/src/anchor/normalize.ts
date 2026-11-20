// N1 / N2 normalisation (PLAN 5.3, redesigned after review M1). Owner C. Public signatures change only through
// the supervisor.
//
// N1 (used for `verbatim`): NFKC → remove soft hyphen → unify quote and dash shapes → every whitespace run becomes
// ONE space (word boundaries are kept: `nowhere` ≠ `now here`) → the whitespace after a PDF line-end hyphen
// (`-` + optional spaces/tabs + newline + the next line's indentation) is removed, so `asso-\nciation` becomes
// `asso-ciation` with that hyphen marked optional by lineEndHyphenFlags(). Case and in-line hyphens are kept.
// Where a space may be missing on one side only (matchQuote's word-boundary rule) is decided by the matcher,
// not here. The result carries an index map back to the original string so a match in normalised space becomes
// a UTF-16 [start, end) range in the original text (1:N and N:1 safe; a collapsed space maps to its whole run).
// N2 (used only for `fuzzy`): N1 + remove every hyphen and space + lower case.
//
// NFKC and the index map (review M12): the original is cut into "normalisation chunks" such that
// NFKC(whole string) === concat(NFKC(chunk)). Every output unit maps to the [start, end) of its chunk.
// Chunk rule:
//   - a combining mark (\p{M}) always stays in the chunk of the code point before it (canonical reordering
//     and composition happen among a starter and its marks);
//   - a code point below U+0300 always starts a new chunk (no canonical composition has a second element
//     below U+0300 and their NFKC forms start with a starter);
//   - a code point whose NFKC form starts with a mark (U+FF9E/FF9F → U+3099/309A) joins too: marks that follow
//     it can still reorder/compose with the starter before it;
//   - any other code point starts a new chunk only if NFKC(chunk + cp) === NFKC(chunk) + NFKC(cp); otherwise
//     it joins the chunk. This keeps Hangul Jamo (L+V(+T) → syllable, LV syllable + T), halfwidth kana with
//     a halfwidth voiced mark (U+FF9E/FF9F → U+3099/309A) and similar non-mark compositions in one chunk.
// A match may only start at the first unit of a chunk and end at the last unit of one (isChunkStart /
// isChunkEnd): `f` never matches half of `ﬁ`.
// The equality NFKC(whole) === concat(NFKC(chunks)) is checked by normalize.test.ts on a fixed corpus and on
// seeded random strings (Latin + marks of mixed combining classes, Jamo, Hangul syllables, halfwidth kana,
// ligatures, fullwidth forms, surrogate pairs). Known difference only in N2: lower-casing is per code point,
// so the context-dependent Greek final sigma (Σ → ς at word end) becomes σ (N2 is never used for `verbatim`).

export interface Normalized {
  /** Normalised text. */
  text: string;
  /** For each UTF-16 unit of `text`: start index (inclusive) of its source unit in the original string. */
  start: Uint32Array;
  /** For each UTF-16 unit of `text`: end index (exclusive) of its source unit in the original string. */
  end: Uint32Array;
}

const SINGLE_QUOTES = /[‘’‚‛′`´]/g;
const DOUBLE_QUOTES = /[“”„‟″«»]/g;
const DASHES = /[‐‑‒–—―−﹘﹣－]/g;
const SOFT_HYPHEN = '­';
const WHITESPACE = /\s/u;
const MARK = /\p{M}/u;

function shapeFold(s: string): string {
  return s.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(DASHES, '-');
}

export interface NfkcChunk {
  /** [start, end) in the original string. */
  start: number;
  end: number;
  /** NFKC of original.slice(start, end). */
  nfkc: string;
}

/** Splits `original` into chunks whose NFKC forms concatenate to NFKC(original) (see the header). */
export function nfkcChunks(original: string): NfkcChunk[] {
  const chunks: NfkcChunk[] = [];
  let chunkStart = 0;
  let chunkRaw = '';
  let chunkNfkc: string | null = null; // cached NFKC of chunkRaw (null = stale)
  const close = (end: number) => {
    if (chunkRaw) chunks.push({ start: chunkStart, end, nfkc: chunkNfkc ?? chunkRaw.normalize('NFKC') });
  };
  let i = 0;
  for (const cp of original) {
    const code = cp.codePointAt(0)!;
    let join = false;
    if (chunkRaw) {
      if (MARK.test(cp)) join = true;
      else if (code >= 0x300) {
        const own = cp.normalize('NFKC');
        // NFKC starting with a mark (e.g. U+FF9F → U+309A): later marks may still compose with the chunk.
        if (MARK.test(String.fromCodePoint(own.codePointAt(0) ?? 0x20))) join = true;
        else {
          const before = chunkNfkc ?? chunkRaw.normalize('NFKC');
          chunkNfkc = before;
          join = (chunkRaw + cp).normalize('NFKC') !== before + own;
        }
      }
    }
    if (join) {
      chunkRaw += cp;
      chunkNfkc = null;
    } else {
      close(i);
      chunkStart = i;
      chunkRaw = cp;
      chunkNfkc = null;
    }
    i += cp.length;
  }
  close(i);
  return chunks;
}

/** Per-chunk fold before the cross-chunk pass: shape fold, drop soft hyphens, any whitespace → ' '. */
function chunkFold(nfkc: string): string {
  let out = '';
  for (const ch of shapeFold(nfkc)) out += WHITESPACE.test(ch) ? ' ' : ch;
  return out;
}

/**
 * N1 fold of an already NFKC-normalised string, without index map (reference for tests): shape fold, drop soft
 * hyphens, elide the whitespace after a line-end hyphen, collapse every whitespace run to one space.
 */
export function n1Fold(nfkc: string): string {
  const elided = nfkc.replace(LINE_END_HYPHEN_WS, '$1').replace(SOFT_LINE_END_WS, '');
  return shapeFold(elided).split(SOFT_HYPHEN).join('').replace(/\s+/gu, ' ');
}
/** Line-end hyphen + spaces/tabs + newline (LF or CRLF) + any whitespace: the whitespace part is elided by N1. */
const LINE_END_HYPHEN_WS = /([-‐])[ \t]*\r?\n\s*/gu;
const SOFT_LINE_END_WS = /\u00AD[ \t]*\r?\n\s*/gu;

/** True when original[index..] is optional spaces/tabs + a newline (LF or CRLF). */
function isLineEndAfter(original: string, index: number): boolean {
  for (let i = index; i < original.length; i++) {
    const c = original[i];
    if (c === '\n') return true;
    if (c === '\r') return original[i + 1] === '\n';
    if (c !== ' ' && c !== '\t') return false;
  }
  return false;
}

/** N1 normalisation with an index map to the original string. */
export function normalizeN1(original: string): Normalized {
  const units: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const c of nfkcChunks(original)) {
    const folded = chunkFold(c.nfkc);
    for (let k = 0; k < folded.length; k++) {
      units.push(folded[k]!);
      starts.push(c.start);
      ends.push(c.end);
    }
  }
  // Cross-chunk pass: collapse whitespace runs, elide the run after a line-end hyphen.
  const outChars: string[] = [];
  const outStart: number[] = [];
  const outEnd: number[] = [];
  let afterLineEndHyphen = false;
  for (let k = 0; k < units.length; k++) {
    const u = units[k]!;
    if (u === SOFT_HYPHEN) {
      // Dropped; a soft hyphen at a line end also takes the line break with it (`asso\u00AD\nciation`).
      afterLineEndHyphen = afterLineEndHyphen || isLineEndAfter(original, ends[k]!);
      continue;
    }
    if (u === ' ') {
      if (afterLineEndHyphen) continue;
      const last = outChars.length - 1;
      if (last >= 0 && outChars[last] === ' ') {
        outEnd[last] = Math.max(outEnd[last]!, ends[k]!);
        continue;
      }
    } else {
      afterLineEndHyphen = u === '-' && ends[k]! - starts[k]! === 1 && isLineEndHyphenAt(original, starts[k]!);
    }
    outChars.push(u);
    outStart.push(starts[k]!);
    outEnd.push(ends[k]!);
  }
  return { text: outChars.join(''), start: Uint32Array.from(outStart), end: Uint32Array.from(outEnd) };
}

/** True when N1 unit `k` is the first unit of its source chunk (a match may start here). */
export function isChunkStart(n: Normalized, k: number): boolean {
  return k <= 0 || k >= n.text.length || n.start[k] !== n.start[k - 1];
}
/** True when N1 unit `k - 1` is the last unit of its source chunk (a match may end at `k`, exclusive). */
export function isChunkEnd(n: Normalized, k: number): boolean {
  return k <= 0 || k >= n.text.length || n.start[k] !== n.start[k - 1];
}

/** N2 = N1 + remove all hyphens and spaces + lower case. Used only for `fuzzy` (never for `verbatim`). */
export function normalizeN2(original: string): Normalized {
  const n = normalizeN1(original);
  const outChars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let k = 0;
  for (const cp of n.text) {
    const from = k;
    k += cp.length;
    if (cp === '-' || cp === ' ') continue;
    const lower = cp.toLowerCase();
    for (let u = 0; u < lower.length; u++) {
      outChars.push(lower[u]!);
      starts.push(n.start[from]!);
      ends.push(n.end[k - 1]!);
    }
  }
  return { text: outChars.join(''), start: Uint32Array.from(starts), end: Uint32Array.from(ends) };
}

/** Convenience: N1 text only. */
export function n1(s: string): string {
  return normalizeN1(s).text;
}

/** Hyphen code points that count as a PDF line-end hyphen when followed by optional spaces and a newline. */
const LINE_END_HYPHENS = new Set(['-', '‐']);

/** True when original[index] is a hyphen that ends a line (`-` + optional spaces/tabs + `\n`, PLAN 5.3 step 1). */
export function isLineEndHyphenAt(original: string, index: number): boolean {
  if (!LINE_END_HYPHENS.has(original[index] ?? '')) return false;
  return isLineEndAfter(original, index + 1);
}

/**
 * For each unit of the N1 text of `original`: 1 if it is a line-end hyphen of the original (matchQuote treats it
 * as optional, so `asso-\nciation` matches both `asso-ciation` and `association`, also inside one quote).
 */
export function lineEndHyphenFlags(original: string, n: Normalized): Uint8Array {
  const flags = new Uint8Array(n.text.length);
  for (let k = 0; k < n.text.length; k++) {
    if (n.text[k] === '-' && n.end[k]! - n.start[k]! === 1 && isLineEndHyphenAt(original, n.start[k]!)) flags[k] = 1;
  }
  return flags;
}

/**
 * Variant of the N1 page text where hyphens that end a PDF line are removed, so `asso-\nciation` also matches
 * `association`. Returns null when the page has no such hyphen. Kept for callers of the S0 API; matchQuote
 * itself treats each line-end hyphen as optional (see lineEndHyphenFlags), which also handles quotes that mix
 * kept and dropped line-end hyphens.
 */
export function normalizeN1WithoutLineEndHyphens(original: string): Normalized | null {
  const n = normalizeN1(original);
  const flags = lineEndHyphenFlags(original, n);
  if (!flags.includes(1)) return null;
  const keep: number[] = [];
  for (let k = 0; k < n.text.length; k++) if (!flags[k]) keep.push(k);
  return { text: keep.map((k) => n.text[k]).join(''), start: Uint32Array.from(keep.map((k) => n.start[k]!)), end: Uint32Array.from(keep.map((k) => n.end[k]!)) };
}

/** Maps a [start, end) range of normalised text back to the original string. */
export function toOriginalRange(n: Normalized, start: number, end: number): { start: number; end: number } {
  if (end <= start) throw new Error('empty range');
  return { start: n.start[start]!, end: n.end[end - 1]! };
}
