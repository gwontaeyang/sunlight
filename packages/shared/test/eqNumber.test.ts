// Equation-number normalization (coordinator note 3(a), BRIEF_S S2). Owner: supervisor.
import { describe, expect, it } from 'vitest';
import { eqNumberKey, normalizeEqNumber } from '../src/contracts/domain';

describe('normalizeEqNumber / eqNumberKey', () => {
  it.each([
    ['Equation 4', '4'],
    ['equation (4)', '4'],
    ['Eq. (4a)', '4a'],
    ['eq 4', '4'],
    ['EQ.4', '4'],
    [' (4) ', '4'],
    ['(A.1)', 'A.1'],
    ['4a', '4a'],
  ])('boundary table: %j → %j', (input, want) => {
    expect(normalizeEqNumber(input)).toBe(want);
  });

  it('keeps case; the key ignores it', () => {
    expect(normalizeEqNumber('(A.1)')).toBe('A.1');
    expect(eqNumberKey('A.1')).toBe(eqNumberKey('a.1'));
    expect(eqNumberKey('4A')).toBe(eqNumberKey('4a'));
    expect(eqNumberKey('Eq. (A.1)')).toBe('a.1');
  });

  it('different numbers keep different keys', () => {
    expect(eqNumberKey('4')).not.toBe(eqNumberKey('14'));
    expect(eqNumberKey('1')).not.toBe(eqNumberKey('11'));
    expect(eqNumberKey('Eq. 4')).not.toBe(eqNumberKey('Eq. 14'));
  });

  it('"equation" is stripped as a whole word, not as "eq" + "uation" (M1 server bug)', () => {
    expect(normalizeEqNumber('Equation 1')).toBe('1');
    expect(normalizeEqNumber('EQUATION(2)')).toBe('2');
    expect(normalizeEqNumber('equation12')).toBe('12');
  });

  it('a word that merely starts with "eq" is not stripped (no over-stripping)', () => {
    // A letter right after "eq"/"equation" means it is another word: left as it is, so it matches no index number
    // rather than turning into a different one ("eqn 4" would otherwise become "n 4", "equal" → "ual").
    expect(normalizeEqNumber('eqn 4')).toBe('eqn 4');
    expect(normalizeEqNumber('Equations 4')).toBe('Equations 4');
    expect(normalizeEqNumber('equal')).toBe('equal');
  });

  it('"eq." is always a prefix, even right before a letter', () => {
    expect(normalizeEqNumber('Eq.A.1')).toBe('A.1');
    expect(normalizeEqNumber('eq.(4)')).toBe('4');
    expect(eqNumberKey('Eq.A.1')).toBe(eqNumberKey('(a.1)'));
  });

  it('one pair of wrapping parentheses only; inner text and unbalanced forms are kept', () => {
    expect(normalizeEqNumber('((4))')).toBe('(4)');
    expect(normalizeEqNumber('(4')).toBe('(4');
    expect(normalizeEqNumber('4)')).toBe('4)');
    expect(normalizeEqNumber('( 4 )')).toBe('4');
  });

  it('empty and prefix-only inputs give an empty number', () => {
    expect(normalizeEqNumber('')).toBe('');
    expect(normalizeEqNumber('  ')).toBe('');
    expect(normalizeEqNumber('Eq.')).toBe('');
    expect(normalizeEqNumber('()')).toBe('');
  });

  it('a non-ASCII letter right after "eq" / "equation" is a letter too (integration decision T1, \\p{L}): left as it is', () => {
    expect(normalizeEqNumber('eqα 4')).toBe('eqα 4');
    expect(normalizeEqNumber('equation한')).toBe('equation한');
    expect(normalizeEqNumber('Equationé 2')).toBe('Equationé 2');
    // a digit, a space or a parenthesis is not a letter: still a prefix
    expect(normalizeEqNumber('eq4')).toBe('4');
    expect(normalizeEqNumber('equation (한)')).toBe('한');
  });

  it('an ASCII letter right after a bare "eq" / "equation" keeps the whole input (the two optional rows of BRIEF_S)', () => {
    expect(normalizeEqNumber('eqA.1')).toBe('eqA.1');
    expect(normalizeEqNumber('EquationA.1')).toBe('EquationA.1');
  });
});
