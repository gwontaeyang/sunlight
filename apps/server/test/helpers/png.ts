// Test PNG builder (BRIEF_S S5). Owner: supervisor. CRCs are computed with the shared crc32, so the output passes
// inspectPng unless a test deliberately breaks it. e2e/helpers.ts re-exports these (C·D mock PNGs, gate G4).
import { deflateSync } from 'node:zlib';
import { crc32, PNG_SIGNATURE } from '@study-paper/shared/image/png';

export interface TestChunk {
  type: string;
  data?: Uint8Array;
  /** Write a CRC that is off by one bit. */
  badCrc?: boolean;
  /** Write this length field instead of data.length (truncated / overlong chunk tests). */
  lengthOverride?: number;
}

/** One chunk: length, type, data, CRC32(type + data). */
export function pngChunk(c: TestChunk): Buffer {
  const data = Buffer.from(c.data ?? new Uint8Array(0));
  const type = Buffer.from(c.type, 'latin1');
  if (type.length !== 4) throw new Error('chunk type must be 4 bytes');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(c.lengthOverride ?? data.length, 0);
  type.copy(head, 4);
  const crc = crc32(new Uint8Array(Buffer.concat([type, data])));
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((c.badCrc ? crc ^ 1 : crc) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

export function ihdrData(width: number, height: number, o: { bitDepth?: number; colorType?: number } = {}): Uint8Array {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = o.bitDepth ?? 8;
  b[9] = o.colorType ?? 2;
  b[10] = 0;
  b[11] = 0;
  b[12] = 0;
  return b;
}

/** Signature + the given chunks (already encoded). */
export function assemblePng(chunks: readonly Buffer[], o: { signature?: readonly number[] } = {}): Buffer {
  return Buffer.concat([Buffer.from(o.signature ?? PNG_SIGNATURE), ...chunks]);
}

/** zlib stream of an RGB image (filter byte 0 per row, a simple gradient so it is a real picture). */
export function rgbIdatData(width: number, height: number): Buffer {
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const p = y * row + 1 + x * 3;
      raw[p] = (x * 255) / Math.max(1, width - 1);
      raw[p + 1] = (y * 255) / Math.max(1, height - 1);
      raw[p + 2] = 128;
    }
  }
  return deflateSync(raw);
}

export interface MakeTestPngOptions {
  width: number;
  height: number;
  /**
   * Total PNG size in bytes: an ancillary `tEXt` chunk (valid CRC) placed before IDAT is padded so the file is exactly
   * this long (gate G4: exactly 4 MiB, +1, +2, +3). Throws when smaller than the unpadded PNG + 12.
   */
  padToBytes?: number;
  /** Extra chunks inserted before IDAT (e.g. an ancillary tEXt). */
  extraChunks?: readonly TestChunk[];
}

/** A valid RGB PNG with correct CRCs. */
export function makeTestPng(o: MakeTestPngOptions): Buffer {
  const head = [pngChunk({ type: 'IHDR', data: ihdrData(o.width, o.height) }), ...(o.extraChunks ?? []).map(pngChunk)];
  const tail = [pngChunk({ type: 'IDAT', data: rgbIdatData(o.width, o.height) }), pngChunk({ type: 'IEND' })];
  const base = assemblePng([...head, ...tail]);
  if (o.padToBytes === undefined) return base;
  const fill = o.padToBytes - base.length - 12;
  if (fill < 0) throw new Error(`padToBytes ${o.padToBytes} is below the unpadded size ${base.length} + 12`);
  // tEXt = keyword, NUL, text (Latin-1).
  const text = Buffer.alloc(fill, 0x61);
  if (fill >= 2) {
    text.write('p', 0, 'latin1');
    text[1] = 0;
  }
  const out = assemblePng([...head, pngChunk({ type: 'tEXt', data: text }), ...tail]);
  if (out.length !== o.padToBytes) throw new Error('padding arithmetic');
  return out;
}

/** base64 of makeTestPng (always canonical — Node's encoder). */
export function makeTestPngBase64(o: MakeTestPngOptions): string {
  return makeTestPng(o).toString('base64');
}

/** Width/height from the IHDR of a base64 PNG (no checks). */
export function pngSize(base64: string): { width: number; height: number } {
  const b = Buffer.from(base64.slice(0, 64), 'base64');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
