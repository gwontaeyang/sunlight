// Contract: the server's equation-reference decision uses the contracts' eqNumberKey (coordinator note 3(a),
// BRIEF_S S2/S9). Owner: supervisor. Two behaviour changes from M1: "Equation N" now meets the index's "N" (M1 turned
// it into "uation N" → not_found), and numbers compare case-insensitively ("A.1" = "a.1").
// The SP-Markup grammar only accepts <eq n="[A-Za-z]?.?\d+[a-z]?"/>, so "Equation 1" cannot come out of parseAnswer;
// those cases build the ParsedAnswer directly (as any other producer of RawCitation would).
import { describe, expect, it } from 'vitest';
import type { ParsedAnswer, RawCitation } from '@study-paper/shared/contracts/domain';
import { eqNumberKey, normalizeEqNumber as contractNormalize } from '@study-paper/shared/contracts/domain';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { normalizeEqNumber, resolveCitations, type EquationIndexRow } from '../../src/llm/citations';

const PAGES = [{ page: 1, text: 'one' }];
const eqRefs = (...numbers: string[]): ParsedAnswer => ({
  displayMd: '',
  citations: numbers.map((n, i): RawCitation => ({ ordinal: i + 1, kind: 'equation', eqNumber: n })),
  blocks: [],
  glossary: [],
  issues: [],
});
const status = (parsed: ParsedAnswer, index: EquationIndexRow[]) => resolveCitations(parsed, PAGES, index).map((c) => c.status);

describe('resolveCitations compares equation numbers with eqNumberKey', () => {
  it('citations.ts re-exports the contracts function (one definition)', () => {
    expect(normalizeEqNumber).toBe(contractNormalize);
    expect(normalizeEqNumber('Equation 1')).toBe('1');
  });

  it('<eq n="Equation 1"/> against the index number "1" → resolved', () => {
    const index = [{ number: '1', pdfPage: 3 }, { number: '2', pdfPage: 4 }];
    const [c] = resolveCitations(eqRefs('Equation 1'), PAGES, index);
    expect(c).toMatchObject({ kind: 'equation', eqNumber: 'Equation 1', status: 'resolved', score: 1 });
    // the stored eqNumber stays what the model wrote; only the comparison is normalised
    expect(status(eqRefs('equation (1)', 'Eq. 2', 'EQ.1'), index)).toEqual(['resolved', 'resolved', 'resolved']);
  });

  it('<eq n="A.1"/> against the index entry "a.1" → resolved (case-insensitive), from real SP-Markup', () => {
    const index = [{ number: 'a.1', pdfPage: 9 }, { number: '1', pdfPage: 3 }];
    const parsed = parseAnswer('see <eq n="A.1"/>');
    expect(parsed.citations).toEqual([{ ordinal: 1, kind: 'equation', eqNumber: 'A.1' }]);
    expect(resolveCitations(parsed, PAGES, index)).toEqual([{ ordinal: 1, kind: 'equation', eqNumber: 'A.1', status: 'resolved', score: 1 }]);
    expect(status(eqRefs('4A'), [{ number: '(4a)', pdfPage: 1 }])).toEqual(['resolved']);
  });

  it('a near miss stays not_found ("11" vs "1", "1" vs "11", "14" vs "4")', () => {
    expect(status(eqRefs('11'), [{ number: '1', pdfPage: 3 }])).toEqual(['not_found']);
    expect(status(eqRefs('Equation 1'), [{ number: '11', pdfPage: 3 }])).toEqual(['not_found']);
    expect(status(eqRefs('14'), [{ number: '(4)', pdfPage: 3 }])).toEqual(['not_found']);
    expect(eqNumberKey('11')).not.toBe(eqNumberKey('1'));
  });

  it('two index rows equal under the key → ambiguous (case no longer separates them)', () => {
    const [c] = resolveCitations(eqRefs('A.1'), PAGES, [{ number: 'A.1', pdfPage: 2 }, { number: 'a.1', pdfPage: 5 }]);
    expect(c).toMatchObject({ status: 'ambiguous', candidates: 2, score: 0 });
  });
});
