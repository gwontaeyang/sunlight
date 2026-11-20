// PNG structure check and canonical base64 (BRIEF_S S5, PLAN_M2 3.5 · D11 · D32). Owner: supervisor.
import { describe, expect, it } from 'vitest';
import { crc32, inspectPng, inspectPngBytes, isCanonicalBase64, PNG_MAX_CHUNKS } from '../src/image/png';
import { CAPTURE } from '../src/image/capture';
import { assemblePng, ihdrData, makeTestPng, pngChunk, rgbIdatData } from '../../../apps/server/test/helpers/png';

/** A real PNG from Chrome's canvas.toDataURL (24×16, generated once with Playwright + system Chrome). */
const CANVAS_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAABhklEQVR4AbRSPUhCYRQ9vAhyMEohCKEIKjCUIMqw0Adu4qZOgkMoTg4tCi4OLppOIjSI0iA4ibS4CiIlaWWhEFQEBdIQWuDwggh77yEPoef7kfrgfvf77j33HDhcYvAP5ymVGjQcDpaZwB+efquFC5sNUwoFtgsFlpkTmD+oQEqwUzzXYyKBh3gcm+k0ljweDsEJcBWZj496HecWCxQaDbZyOczQeZSCGP3Ifd9HInjOZLBD26FxuXjHJxLoViqoGo1Q6nSsJdMqFS85U5QtcBcK4bVYxH65jEW7neEQDMkCpt4VTm8OoTaboUsmQdCbIsg8bHIC7yck+KJ7bEB1toijjTeQzSYWrNbhqLTECfDBGSvO6A1hrNBGo3wQ0RqvwFevh1ufD/12G6ZaDWqSFCUaB/gl0Mnn0XA6sez1Yj0cHjcnuc4JfHY6uHa7QdF5j96QOYNBMokQkBV4yWZZS9aCQawGAkJ42T3ikrbjm6KwWypBqdfLJhAbILSxGFb8fjHcxP0fAAAA//8KRt9fAAAABklEQVQDAK0F0W49gdBcAAAAAElFTkSuQmCC';

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const reason = (s: string): string | undefined => {
  const r = inspectPng(s);
  return r.ok ? undefined : r.reason;
};
const IHDR = (w = 16, h = 16, o: { bitDepth?: number; colorType?: number } = {}) => pngChunk({ type: 'IHDR', data: ihdrData(w, h, o) });
const IDAT = (w = 16, h = 16) => pngChunk({ type: 'IDAT', data: rgbIdatData(w, h) });
const IEND = () => pngChunk({ type: 'IEND' });
const TEXT = () => pngChunk({ type: 'tEXt', data: Buffer.from('k\0v', 'latin1') });

describe('crc32', () => {
  it('standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('isCanonicalBase64', () => {
  const reencodes = (s: string) => s.length > 0 && Buffer.from(s, 'base64').toString('base64') === s;

  it('equals "decode then re-encode gives the input" on a table (Node and btoa encoders, lengths 1–9, pad-bit variants)', () => {
    const samples: string[] = [];
    const patterns = (n: number): Uint8Array[] => [
      new Uint8Array(n),
      new Uint8Array(n).fill(0xff),
      Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff),
      Uint8Array.from({ length: n }, (_, i) => (i * 101 + 200) & 0xff),
    ];
    for (let n = 1; n <= 9; n++) {
      for (const bytes of patterns(n)) {
        const node = b64(bytes);
        const viaBtoa = btoa(String.fromCharCode(...bytes));
        expect(viaBtoa).toBe(node);
        samples.push(node);
        // Every replacement of the last data character (pad-bit variants included).
        const pad = node.endsWith('==') ? 2 : node.endsWith('=') ? 1 : 0;
        const at = node.length - pad - 1;
        for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/') samples.push(node.slice(0, at) + ch + node.slice(at + 1));
        // padding missing / extra
        samples.push(node.replace(/=+$/, ''), node + '=', node + '==');
      }
    }
    samples.push(' AAAA', 'AAAA ', 'AA\nAA', 'AA-_', 'data:image/png;base64,AAAA', 'AAA', 'A===', '====', '=AAA', 'AA=A', 'Zm9v', 'Zm8=', 'Zg==', 'Zh==', 'Zm9=');
    let checked = 0;
    for (const s of samples) {
      expect(isCanonicalBase64(s), JSON.stringify(s)).toBe(reencodes(s));
      checked++;
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('the empty string is the one exception: re-encodes to itself but is not canonical (needs ≥ 1 character)', () => {
    expect(Buffer.from('', 'base64').toString('base64')).toBe('');
    expect(isCanonicalBase64('')).toBe(false);
  });

  it('pad-bit variants of a valid PNG decode to the same bytes but are rejected', () => {
    const eq2 = b64(makeTestPng({ width: 16, height: 16, padToBytes: 1000 })); // 1000 % 3 = 1 → ends with ==
    const eq1 = b64(makeTestPng({ width: 16, height: 16, padToBytes: 1001 })); // 1001 % 3 = 2 → ends with =
    expect(eq2.endsWith('==')).toBe(true);
    expect(eq1.endsWith('=') && !eq1.endsWith('==')).toBe(true);
    expect(inspectPng(eq2).ok).toBe(true);
    expect(inspectPng(eq1).ok).toBe(true);
    const bump = (s: string, pad: number) => {
      const at = s.length - pad - 1;
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      return s.slice(0, at) + alphabet[alphabet.indexOf(s[at]!) + 1]! + s.slice(at + 1);
    };
    for (const [s, pad] of [[eq2, 2], [eq1, 1]] as const) {
      const v = bump(s, pad);
      expect(Buffer.from(v, 'base64').equals(Buffer.from(s, 'base64'))).toBe(true);
      expect(reason(v)).toBe('not_canonical_base64');
    }
  });
});

describe('inspectPng', () => {
  it('accepts a minimal hand-built PNG and a real canvas PNG', () => {
    expect(inspectPng(b64(assemblePng([IHDR(), IDAT(), IEND()])))).toEqual({ ok: true, width: 16, height: 16, bytes: expect.any(Number) });
    expect(inspectPng(CANVAS_PNG)).toEqual({ ok: true, width: 24, height: 16, bytes: Buffer.from(CANVAS_PNG, 'base64').length });
  });

  it('accepts several consecutive IDATs and an ancillary chunk before IDAT', () => {
    const data = rgbIdatData(16, 16);
    const half = Math.floor(data.length / 2);
    expect(inspectPng(b64(assemblePng([IHDR(), TEXT(), pngChunk({ type: 'IDAT', data: data.subarray(0, half) }), pngChunk({ type: 'IDAT', data: data.subarray(half) }), IEND()]))).ok).toBe(true);
  });

  it('size limits: 1,568 px ok / 1,569 px / 8 px ok / 7 px', () => {
    expect(inspectPng(b64(assemblePng([IHDR(1568, 8), IDAT(1568, 8), IEND()]))).ok).toBe(true);
    expect(reason(b64(assemblePng([IHDR(1569, 8), IDAT(8, 8), IEND()])))).toBe('too_wide');
    expect(reason(b64(assemblePng([IHDR(8, 1569), IDAT(8, 8), IEND()])))).toBe('too_wide');
    expect(reason(b64(assemblePng([IHDR(7, 100), IDAT(7, 100), IEND()])))).toBe('too_small');
  });

  it('exactly 4 MiB passes in one pass; 4 MiB + 1 is too large', () => {
    const exact = makeTestPng({ width: 64, height: 64, padToBytes: CAPTURE.maxBytes });
    expect(exact.length).toBe(4_194_304);
    const t0 = performance.now();
    const r = inspectPng(exact.toString('base64'));
    expect(performance.now() - t0).toBeLessThan(5_000); // loose wall-clock cap; the decision is the byte count below
    expect(r).toEqual({ ok: true, width: 64, height: 64, bytes: 4_194_304 });
    expect(reason(makeTestPng({ width: 64, height: 64, padToBytes: CAPTURE.maxBytes + 1 }).toString('base64'))).toBe('too_large');
    expect(inspectPngBytes(new Uint8Array(CAPTURE.maxBytes + 1))).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects broken structure with a reason', () => {
    const good = assemblePng([IHDR(), IDAT(), IEND()]);
    const cases: [string, Buffer, string][] = [
      ['bad signature', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), good.subarray(8)]), 'bad_signature'],
      ['truncated chunk', good.subarray(0, good.length - 6), 'truncated_chunk'],
      ['bytes after IEND', Buffer.concat([good, Buffer.from([0])]), 'bytes_after_iend'],
      ['IHDR not first', assemblePng([TEXT(), IHDR(), IDAT(), IEND()]), 'ihdr_not_first'],
      ['two IHDR', assemblePng([IHDR(), IHDR(), IDAT(), IEND()]), 'duplicate_ihdr'],
      ['no IDAT (IHDR + IEND, 45 bytes)', assemblePng([IHDR(), IEND()]), 'no_idat'],
      ['split IDAT', assemblePng([IHDR(), IDAT(), TEXT(), IDAT(), IEND()]), 'split_idat'],
      ['IHDR CRC 1 bit', assemblePng([pngChunk({ type: 'IHDR', data: ihdrData(16, 16), badCrc: true }), IDAT(), IEND()]), 'bad_crc'],
      ['IDAT CRC 1 bit', assemblePng([IHDR(), pngChunk({ type: 'IDAT', data: rgbIdatData(16, 16), badCrc: true }), IEND()]), 'bad_crc'],
      ['IEND CRC 1 bit', assemblePng([IHDR(), IDAT(), pngChunk({ type: 'IEND', badCrc: true })]), 'bad_crc'],
      ['type with a non-letter byte', assemblePng([IHDR(), pngChunk({ type: 'tE1t', data: Buffer.from('x') }), IDAT(), IEND()]), 'bad_chunk_type'],
      ['color type 3 without PLTE', assemblePng([IHDR(16, 16, { colorType: 3 }), IDAT(), IEND()]), 'missing_plte'],
      ['IEND length != 0', assemblePng([IHDR(), IDAT(), pngChunk({ type: 'IEND', data: Buffer.from([0]) })]), 'bad_iend'],
      ['bad bit depth', assemblePng([IHDR(16, 16, { bitDepth: 3 }), IDAT(), IEND()]), 'bad_ihdr'],
      ['missing IEND', assemblePng([IHDR(), IDAT()]), 'missing_iend'],
      ['overlong length field', assemblePng([IHDR(), pngChunk({ type: 'IDAT', data: Buffer.from([1, 2]), lengthOverride: 1_000_000 }), IEND()]), 'truncated_chunk'],
    ];
    expect(assemblePng([IHDR(), IEND()]).length).toBe(45);
    for (const [name, png, why] of cases) expect(reason(b64(png)), name).toBe(why);
    // A color-type-3 PNG with its PLTE before IDAT passes.
    expect(inspectPng(b64(assemblePng([IHDR(16, 16, { colorType: 3 }), pngChunk({ type: 'PLTE', data: new Uint8Array(6) }), IDAT(), IEND()]))).ok).toBe(true);
  });

  it('non-canonical base64 forms are rejected before decoding', () => {
    const s = b64(assemblePng([IHDR(), IDAT(), IEND()]));
    for (const bad of [` ${s}`, `${s}\n`, s.slice(0, 40) + '\n' + s.slice(40), s.replace(/\+/g, '-').replace(/\//g, '_') + (/[+/]/.test(s) ? '' : '-'), `data:image/png;base64,${s}`, s.replace(/=+$/, ''), s + '=', '']) {
      expect(reason(bad), JSON.stringify(bad.slice(0, 30))).toBe('not_canonical_base64');
    }
  });

  it(`chunk count: ${PNG_MAX_CHUNKS} passes, ${PNG_MAX_CHUNKS + 1} fails`, () => {
    const build = (total: number) => assemblePng([IHDR(), ...Array.from({ length: total - 3 }, () => TEXT()), IDAT(), IEND()]);
    expect(inspectPng(b64(build(PNG_MAX_CHUNKS))).ok).toBe(true);
    expect(reason(b64(build(PNG_MAX_CHUNKS + 1)))).toBe('too_many_chunks');
  });
});
