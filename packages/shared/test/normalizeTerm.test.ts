// Term normalization (BRIEF_S S2 v3.4). Owner: supervisor.
import { describe, expect, it } from 'vitest';
import { normalizeTerm } from '../src/contracts/domain';

describe('normalizeTerm', () => {
  it('full-width characters equal their half-width form (NFKC)', () => {
    expect(normalizeTerm('ＩＣＰ')).toBe('icp');
    expect(normalizeTerm('ＬｉＤＡＲ　ｏｄｏｍｅｔｒｙ')).toBe('lidar odometry');
    expect(normalizeTerm('１２３')).toBe('123');
  });
  it('composed (NFC) and decomposed (NFD) forms give the same value', () => {
    const nfc = '정합 é'.normalize('NFC');
    const nfd = '정합 é'.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    expect(normalizeTerm(nfc)).toBe(normalizeTerm(nfd));
    expect(normalizeTerm(nfd)).toBe('정합 é'.normalize('NFC'));
  });
  it('whitespace: runs, leading/trailing, tabs and newlines → one space', () => {
    expect(normalizeTerm('  robust\t\tkernel \n function  ')).toBe('robust kernel function');
    expect(normalizeTerm('a b')).toBe('a b');
    expect(normalizeTerm(' \n\t ')).toBe('');
  });
  it('case-insensitive', () => {
    expect(normalizeTerm('Iterative Closest Point')).toBe(normalizeTerm('ITERATIVE closest POINT'));
    expect(normalizeTerm('SE(3)')).toBe('se(3)');
  });
});
