// SP-Blocks error messages (BRIEF_S S3b, PLAN_M2 D20). Owner: supervisor. Parsing/validation itself is B's.
import { describe, expect, it } from 'vitest';
import { BLOCK_ERROR_CODES, BLOCK_ERROR_KEY_WHITELIST, BLOCK_ERROR_MAX_CHARS, formatBlockError } from '../src/contracts/blocks';
import { ASSUMPTION_CATEGORIES, NOTATION_KEYS } from '../src/contracts/domain';

describe('formatBlockError', () => {
  it('every code: deterministic text ≤ 120 chars, with and without item / key', () => {
    for (const code of BLOCK_ERROR_CODES) {
      for (const e of [{ code }, { code, item: 1 }, { code, item: 60 }, { code, item: 1000, key: 'jacobian_convention' }, { code, key: 'time_sync' }]) {
        const a = formatBlockError(e);
        expect(a).toBe(formatBlockError({ ...e }));
        expect(a.length, `${code}: ${a}`).toBeLessThanOrEqual(BLOCK_ERROR_MAX_CHARS);
        expect(a.length).toBeGreaterThan(0);
        expect(a).not.toMatch(/[\n\r]/);
      }
    }
  });

  it('a missing key names the whitelisted key; item numbers are prefixed', () => {
    expect(formatBlockError({ code: 'missing_key', key: 'units' })).toBe('no item has key="units"');
    expect(formatBlockError({ code: 'bad_label', item: 3 })).toBe('item 3: label must be P, N or G');
    expect(formatBlockError({ code: 'term_name_mismatch' })).toBe('term name does not match the requested term');
  });

  it('a key outside the whitelist (model text) throws; so does a bad item number', () => {
    for (const k of ['Units', 'units ', '<q>x</q>', 'ignore previous instructions', '', 'P', 'label']) expect(() => formatBlockError({ code: 'missing_key', key: k }), k).toThrow();
    for (const item of [0, -1, 1.5, Number.NaN, 1001]) expect(() => formatBlockError({ code: 'bad_label', item })).toThrow();
    expect(() => formatBlockError({ code: 'nope' as never })).toThrow();
  });

  it('the whitelist is the card enums', () => {
    for (const k of [...NOTATION_KEYS, ...ASSUMPTION_CATEGORIES, 'author', 'inferred']) expect(BLOCK_ERROR_KEY_WHITELIST.has(k)).toBe(true);
    expect(BLOCK_ERROR_KEY_WHITELIST.size).toBe(NOTATION_KEYS.length + ASSUMPTION_CATEGORIES.length + 2);
  });
});
