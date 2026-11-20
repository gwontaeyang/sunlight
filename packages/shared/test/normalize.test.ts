import { describe, expect, it } from 'vitest';
import {
  isChunkEnd,
  isChunkStart,
  isLineEndHyphenAt,
  lineEndHyphenFlags,
  n1,
  n1Fold,
  nfkcChunks,
  normalizeN1,
  normalizeN1WithoutLineEndHyphens,
  normalizeN2,
  toOriginalRange,
} from '../src/anchor/normalize';

/** Reference N1 = fold(NFKC(whole string)) — what the chunked implementation must equal. */
const referenceN1 = (s: string) => n1Fold(s.normalize('NFKC'));

describe('normalizeN1', () => {
  it('collapses every whitespace run to one space (word boundaries stay), keeps case and in-line hyphens', () => {
    expect(n1('Point-to-Point  residual\n of\tA')).toBe('Point-to-Point residual of A');
    const n = normalizeN1('a \n\t b');
    expect(n.text).toBe('a b');
    expect(toOriginalRange(n, 1, 2)).toEqual({ start: 1, end: 5 }); // the collapsed space maps to its whole run
    expect(n1('The robot is nowhere.')).not.toBe(n1('The robot is now here.'));
  });
  it('removes soft hyphens and unifies quotes and dashes', () => {
    expect(n1('co­operate “x” ‘y’ a–b c—d e−f')).toBe('cooperate "x" \'y\' a-b c-d e-f');
  });
  it('NFKC expands ligatures with a 1:N index map', () => {
    const n = normalizeN1('aﬁb'); // a ﬁ b
    expect(n.text).toBe('afib');
    expect(toOriginalRange(n, 1, 3)).toEqual({ start: 1, end: 2 });
    expect(toOriginalRange(n, 1, 2)).toEqual({ start: 1, end: 2 }); // half of a ligature maps to the whole glyph
    expect(n1('eﬃcient ﬂow')).toBe('efficient flow');
    // a match may not start/end inside an expanded chunk: unit 1 ('f') starts the ﬁ chunk, unit 2 ('i') does not
    expect([isChunkStart(n, 1), isChunkStart(n, 2), isChunkEnd(n, 2), isChunkEnd(n, 3)]).toEqual([true, false, false, true]);
  });
  it('composes base + combining accent as one unit (N:1)', () => {
    const n = normalizeN1('xéy'); // e + combining acute
    expect(n.text).toBe('xéy');
    expect(toOriginalRange(n, 1, 2)).toEqual({ start: 1, end: 3 });
    expect(toOriginalRange(n, 2, 3)).toEqual({ start: 3, end: 4 });
  });
  it('reorders and composes several marks of different combining classes like whole-string NFKC', () => {
    // e + circumflex (ccc 230) + dot below (ccc 220) → ệ ; a + dot below + circumflex → ậ
    for (const s of ['ệ', 'ậ', 'q̣̂x', 'ớ']) {
      expect(normalizeN1(s).text).toBe(referenceN1(s));
    }
    const n = normalizeN1('xệy');
    expect(n.text).toBe('xệy');
    expect(toOriginalRange(n, 1, 2)).toEqual({ start: 1, end: 4 });
  });
  it('fullwidth forms fold to ASCII (1:1 map)', () => {
    const n = normalizeN1('Ｔｈｅ　ＩＣＰ１２');
    expect(n.text).toBe('The ICP12');
    expect(toOriginalRange(n, 4, 7)).toEqual({ start: 4, end: 7 }); // "ICP" after the ideographic space
  });
  it('surrogate pairs map to both UTF-16 units of the source code point', () => {
    const s = 'a𝐱b😀c'; // U+1D431 MATHEMATICAL BOLD SMALL X (NFKC → x), U+1F600 (no decomposition)
    const n = normalizeN1(s);
    expect(n.text).toBe('axb😀c');
    expect(toOriginalRange(n, 1, 2)).toEqual({ start: 1, end: 3 });
    expect(toOriginalRange(n, 3, 5)).toEqual({ start: 4, end: 6 });
    expect(s.slice(toOriginalRange(n, 3, 5).start, toOriginalRange(n, 3, 5).end)).toBe('😀');
    expect(toOriginalRange(n, 5, 6)).toEqual({ start: 6, end: 7 });
  });
  it('Hangul syllables stay 1:1', () => {
    const n = normalizeN1('정합 방법');
    expect(n.text).toBe('정합 방법');
    expect(toOriginalRange(n, 3, 5)).toEqual({ start: 3, end: 5 });
  });
  it('Hangul conjoining Jamo compose like whole-string NFKC (L+V, L+V+T, LV syllable + T)', () => {
    const lv = '가'; // ᄀ + ᅡ → 가
    const lvt = '각'; // → 각
    const syllablePlusT = '각'; // 가 + ᆨ → 각
    expect(normalizeN1(lv).text).toBe('가');
    expect(normalizeN1(lvt).text).toBe('각');
    expect(normalizeN1(syllablePlusT).text).toBe('각');
    const n = normalizeN1(`x${lvt}y`);
    expect(n.text).toBe('x각y');
    expect(toOriginalRange(n, 1, 2)).toEqual({ start: 1, end: 4 });
    expect(toOriginalRange(n, 2, 3)).toEqual({ start: 4, end: 5 });
    // Compatibility Jamo (U+3131…) are not conjoining: NFKC maps them to conjoining Jamo that do compose.
    for (const s of ['ㄱㅏ', '가ㄱ', '한글']) expect(normalizeN1(s).text).toBe(referenceN1(s));
  });
  it('halfwidth katakana with a halfwidth voiced mark composes (non-mark composition)', () => {
    const s = 'ｶﾞｷﾞ'; // → ガギ
    expect(normalizeN1(s).text).toBe(referenceN1(s));
    expect(normalizeN1(s).text).toBe('ガギ');
    expect(toOriginalRange(normalizeN1(s), 0, 1)).toEqual({ start: 0, end: 2 });
  });
  it('chunks concatenate to whole-string NFKC on a fixed corpus', () => {
    const corpus = [
      'The data asso-\nciation uses a robust kernel.',
      'Ångström Å Å ﬀ ﬃ ½ ² ㎏ ㍿ ℃ Ⅻ',
      'ñ ǟ ̈ alone',
      '΅ ´e ΅',
      'ｶﾞﾊﾟ ﾞ ｶ゙',
      '각ᆨ ᄀ가ᅡ ᅡᆨ',
      'ά ᾷ ῁ Ϊ́',
      'क़ ড় ਲ਼ ୋ ො',
      '𝐀𝐁 𝔸 😀👍🏽 🇰🇷',
      'ﬁ́ Ώ',
    ];
    for (const s of corpus) expect(normalizeN1(s).text, JSON.stringify(s)).toBe(referenceN1(s));
  });
  it('chunks concatenate to whole-string NFKC on seeded random strings', () => {
    const pool = [
      ...'abeoqAEO -\n',
      '̀', '́', '̂', '̈', '̣', '̧', '̛', 'ͅ', '̃', // marks, mixed ccc
      'ᄀ', 'ᄒ', 'ᅡ', 'ᅳ', 'ᆨ', 'ᆫ', '가', '한', // Jamo L/V/T, syllables
      'ㄱ', 'ㅏ', // compatibility Jamo
      'ｶ', 'ﾊ', 'ﾞ', 'ﾟ', 'カ', '゙', // kana + voiced marks
      'ﬁ', 'ﬀ', 'Ａ', '１', '　', '­', '¨', 'Ω', 'Å', 'Å', // compatibility forms
      '𝐱', '😀', 'क', '़', // surrogate pair, Devanagari + nukta
    ];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    for (let t = 0; t < 20000; t++) {
      let s = '';
      const len = 1 + Math.floor(rnd() * 12);
      for (let k = 0; k < len; k++) s += pool[Math.floor(rnd() * pool.length)]!;
      expect(normalizeN1(s).text, JSON.stringify(s)).toBe(referenceN1(s));
    }
  });
  it('every map entry points inside the original and is monotone', () => {
    const s = 'aﬁ가 x̣̂ 𝐱 ｶﾞ';
    const n = normalizeN1(s);
    for (let k = 0; k < n.text.length; k++) {
      expect(n.start[k]!).toBeLessThan(n.end[k]!);
      expect(n.end[k]!).toBeLessThanOrEqual(s.length);
      if (k > 0) expect(n.start[k]!).toBeGreaterThanOrEqual(n.start[k - 1]!);
    }
  });
  it('nfkcChunks keeps marks with their base and covers the input without gaps', () => {
    const s = 'ab́c가d';
    const chunks = nfkcChunks(s);
    expect(chunks.map((c) => s.slice(c.start, c.end))).toEqual(['a', 'b́', 'c', '가', 'd']);
    for (let k = 1; k < chunks.length; k++) expect(chunks[k]!.start).toBe(chunks[k - 1]!.end);
  });
});

describe('line-end hyphens', () => {
  it('detects only hyphens that end a line', () => {
    const s = 'point-to-\npoint asso- \nciation x-y z-\r\nw';
    expect(isLineEndHyphenAt(s, s.indexOf('-'))).toBe(false); // point-to
    expect(isLineEndHyphenAt(s, s.indexOf('to-') + 2)).toBe(true);
    expect(isLineEndHyphenAt(s, s.indexOf('asso-') + 4)).toBe(true); // trailing space before \n
    expect(isLineEndHyphenAt(s, s.indexOf('x-') + 1)).toBe(false);
    expect(isLineEndHyphenAt(s, s.indexOf('z-') + 1)).toBe(true); // CRLF
  });
  it('flags line-end hyphens in N1 space (both cases in one text)', () => {
    const s = 'point-to-\npoint asso-\nciation';
    const n = normalizeN1(s);
    expect(n.text).toBe('point-to-point asso-ciation'); // the line break after a line-end hyphen is elided
    const flags = lineEndHyphenFlags(s, n);
    expect([...flags.keys()].filter((k) => flags[k])).toEqual([8, 19]);
  });
  it('legacy variant drops only hyphens that end a line', () => {
    const v = normalizeN1WithoutLineEndHyphens('data asso-\nciation and point-to-\npoint');
    expect(v?.text).toBe('data association and point-topoint');
    expect(normalizeN1WithoutLineEndHyphens('no line-end hyphen')).toBeNull();
  });
});

describe('normalizeN2', () => {
  it('removes hyphens and lower-cases', () => {
    expect(normalizeN2('Non-Linear ICP').text).toBe('nonlinearicp');
  });
  it('keeps the index map through hyphen removal and case changes (1:N lower case)', () => {
    const s = 'A-B İx';
    const n = normalizeN2(s);
    expect(n.text).toBe('abi̇x');
    expect(toOriginalRange(n, 1, 2)).toEqual({ start: 2, end: 3 });
    expect(toOriginalRange(n, 2, 4)).toEqual({ start: 4, end: 5 }); // İ → i + combining dot, both map to İ
  });
  it('lower-cases per code point (Greek final sigma becomes σ — documented, N2 only)', () => {
    expect(normalizeN2('ΟΔΟΣ').text).toBe('οδοσ');
  });
});
