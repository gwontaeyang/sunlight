// Capture PNG check (PLAN_M2 3.5, D11, D32). Owner: supervisor. Pure TypeScript, no dependency, no Buffer — the
// web uses isCanonicalBase64 through the Base64Png request schema, the server uses inspectPng before storing.
//
// inspectPng checks the STRUCTURE only, in one synchronous pass over the bytes:
//   canonical base64 → decoded size ≤ CAPTURE.maxBytes → PNG signature → every chunk: length inside the remaining
//   bytes, type = 4 ASCII letters, CRC32 matches, ≤ MAX_CHUNKS chunks → the first chunk is IHDR and the only IHDR
//   (length 13, CAPTURE.minSidePx ≤ side ≤ CAPTURE.maxSidePx, valid bit depth / color type / methods) → color type 3
//   has a PLTE before the IDATs → ≥ 1 IDAT and all IDATs consecutive → IEND (length 0) is the last chunk and nothing
//   follows it.
// LIMIT: the compressed IDAT data is NOT inflated and pixels are not decoded. A broken zlib stream or too few rows
// pass this check (the picture then shows broken and the model call ends with a CLI error) — PLAN_M2 3.5.
import { CAPTURE } from './capture';

/** Most chunks a capture PNG may have. */
export const PNG_MAX_CHUNKS = 10_000;
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();
const CANONICAL_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The one textual form of a byte string (D32): standard alphabet, padded, length % 4 = 0, and the unused low bits of
 * the last data character are zero (`…A==`, never `…B==`). Equivalent to "decoding and re-encoding gives the input"
 * for every non-empty string (png.test compares against Buffer). The empty string is not canonical here.
 */
export function isCanonicalBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0 || !CANONICAL_RE.test(s)) return false;
  if (s.endsWith('==')) {
    const c = s[s.length - 3]!;
    return c === 'A' || c === 'Q' || c === 'g' || c === 'w';
  }
  if (s.endsWith('=')) return B64_INDEX[s.charCodeAt(s.length - 2)]! % 4 === 0;
  return true;
}

/** Decodes a string that passed isCanonicalBase64. */
function decodeBase64(s: string): Uint8Array {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64_INDEX[s.charCodeAt(i)]!;
    const b = B64_INDEX[s.charCodeAt(i + 1)]!;
    const c = s[i + 2] === '=' ? 0 : B64_INDEX[s.charCodeAt(i + 2)]!;
    const d = s[i + 3] === '=' ? 0 : B64_INDEX[s.charCodeAt(i + 3)]!;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >>> 16) & 0xff;
    if (o < out.length) out[o++] = (n >>> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

/** Decoded byte count of a base64 string of this length and padding (no decoding). */
export function base64DecodedLength(s: string): number {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor(s.length / 4) * 3 - pad;
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO-HDLC / PNG), table method. crc32(bytes of "123456789") = 0xCBF43926. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type PngRejectReason =
  | 'not_canonical_base64'
  | 'too_large'
  | 'bad_signature'
  | 'truncated_chunk'
  | 'bad_chunk_type'
  | 'bad_crc'
  | 'too_many_chunks'
  | 'ihdr_not_first'
  | 'bad_ihdr'
  | 'duplicate_ihdr'
  | 'too_small'
  | 'too_wide'
  | 'missing_plte'
  | 'bad_plte'
  | 'split_idat'
  | 'no_idat'
  | 'bad_iend'
  | 'missing_iend'
  | 'bytes_after_iend';

export type PngInspection = { ok: true; width: number; height: number; bytes: number } | { ok: false; reason: PngRejectReason };

// Allowed bit depths per color type (PNG spec 11.2.2).
const BIT_DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

const isLetter = (b: number): boolean => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const u32 = (d: Uint8Array, i: number): number => ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0;
const typeOf = (d: Uint8Array, i: number): string => String.fromCharCode(d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!);

/** Structure check of a capture PNG given as base64 (see the header). */
export function inspectPng(base64: string): PngInspection {
  if (!isCanonicalBase64(base64)) return { ok: false, reason: 'not_canonical_base64' };
  // Size first, from the string length alone (no decoding of an oversized input).
  if (base64DecodedLength(base64) > CAPTURE.maxBytes) return { ok: false, reason: 'too_large' };
  return inspectPngBytes(decodeBase64(base64));
}

/** Same check on decoded bytes (tests, helpers). */
export function inspectPngBytes(d: Uint8Array): PngInspection {
  if (d.length > CAPTURE.maxBytes) return { ok: false, reason: 'too_large' };
  if (d.length < PNG_SIGNATURE.length) return { ok: false, reason: 'bad_signature' };
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (d[i] !== PNG_SIGNATURE[i]) return { ok: false, reason: 'bad_signature' };
  let pos = PNG_SIGNATURE.length;
  let chunks = 0;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let sawPlte = false;
  let idatState: 'none' | 'in' | 'after' = 'none';
  while (pos < d.length) {
    if (d.length - pos < 12) return { ok: false, reason: 'truncated_chunk' };
    const len = u32(d, pos);
    if (len > d.length - pos - 12) return { ok: false, reason: 'truncated_chunk' };
    const typePos = pos + 4;
    if (!isLetter(d[typePos]!) || !isLetter(d[typePos + 1]!) || !isLetter(d[typePos + 2]!) || !isLetter(d[typePos + 3]!)) return { ok: false, reason: 'bad_chunk_type' };
    const dataPos = pos + 8;
    const end = dataPos + len;
    if (crc32(d, typePos, end) !== u32(d, end)) return { ok: false, reason: 'bad_crc' };
    if (++chunks > PNG_MAX_CHUNKS) return { ok: false, reason: 'too_many_chunks' };
    const type = typeOf(d, typePos);
    if (chunks === 1) {
      if (type !== 'IHDR') return { ok: false, reason: 'ihdr_not_first' };
      if (len !== 13) return { ok: false, reason: 'bad_ihdr' };
      width = u32(d, dataPos);
      height = u32(d, dataPos + 4);
      const bitDepth = d[dataPos + 8]!;
      colorType = d[dataPos + 9]!;
      const compression = d[dataPos + 10]!;
      const filter = d[dataPos + 11]!;
      const interlace = d[dataPos + 12]!;
      if (!(BIT_DEPTHS[colorType]?.includes(bitDepth) ?? false) || compression !== 0 || filter !== 0 || interlace > 1) return { ok: false, reason: 'bad_ihdr' };
      if (width < CAPTURE.minSidePx || height < CAPTURE.minSidePx) return { ok: false, reason: 'too_small' };
      if (width > CAPTURE.maxSidePx || height > CAPTURE.maxSidePx) return { ok: false, reason: 'too_wide' };
    } else if (type === 'IHDR') {
      return { ok: false, reason: 'duplicate_ihdr' };
    } else if (type === 'PLTE') {
      // One PLTE, before the image data, never for grayscale types.
      if (sawPlte || idatState !== 'none' || colorType === 0 || colorType === 4 || len === 0 || len % 3 !== 0 || len > 768) return { ok: false, reason: 'bad_plte' };
      sawPlte = true;
    } else if (type === 'IDAT') {
      if (idatState === 'after') return { ok: false, reason: 'split_idat' };
      if (colorType === 3 && !sawPlte) return { ok: false, reason: 'missing_plte' };
      idatState = 'in';
    } else if (type === 'IEND') {
      if (len !== 0) return { ok: false, reason: 'bad_iend' };
      if (idatState === 'none') return { ok: false, reason: 'no_idat' };
      if (end + 4 !== d.length) return { ok: false, reason: 'bytes_after_iend' };
      return { ok: true, width, height, bytes: d.length };
    } else if (idatState === 'in') {
      idatState = 'after';
    }
    pos = end + 4;
  }
  return { ok: false, reason: chunks === 0 ? 'ihdr_not_first' : 'missing_iend' };
}
