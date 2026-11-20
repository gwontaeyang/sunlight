// Equation references against a real equation index (PLAN_M2 3.3, BRIEF_B B6): the five states with equationId and
// candidates, number forms compared with the contracts' eqNumberKey only, rows without a number ignored. Forms the
// <eq> grammar never produces ("(4)", "Eq. 4", "Equation 4", "4A") go in as RawCitation directly (as S's
// eqNumber.resolve.test does); the grammar is not widened. Owner B.
import { describe, expect, it } from 'vitest';
import type { ParsedAnswer, RawCitation } from '@study-paper/shared/contracts/domain';
import { EQUATION_LATEX_MAX } from '@study-paper/shared/contracts/domain';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { SEED_M2_PAPER_ID, SEED_UPGRADE_PAPER_ID, seedFixture } from '../../src/dev/seedFixture';
import { resolveCitations, type EquationIndexRow } from '../../src/llm/citations';
import { equationIndex } from '../../src/llm/citationStore';
import { makeRunEnv } from './runEnv';

const PAGES = [{ page: 1, text: 'one' }];
const refs = (...numbers: string[]): ParsedAnswer => ({ displayMd: '', citations: numbers.map((n, i): RawCitation => ({ ordinal: i + 1, kind: 'equation', eqNumber: n })), blocks: [], glossary: [], issues: [] });
const row = (number: string | null, pdfPage: number | null, id?: string): EquationIndexRow => ({ number, pdfPage, ...(id ? { id, latex: `L${id}`, katexOk: true, sectionNumber: 'II' } : {}) });

describe('the five states', () => {
  const index = [row('1', 2, 'e1'), row('2', null, 'e2'), row('A.1', null, 'a1'), row('A.1', null, 'a2'), row(null, 3, 'unnumbered')];
  it('resolved / no_anchor carry equationId (+ latex, katexOk); ambiguous carries candidates; not_found; unindexed', () => {
    const c = resolveCitations(refs('1', '2', 'A.1', '9'), PAGES, index);
    expect(c[0]).toEqual({ ordinal: 1, kind: 'equation', eqNumber: '1', status: 'resolved', score: 1, equationId: 'e1', latex: 'Le1', katexOk: true });
    expect(c[1]).toMatchObject({ status: 'no_anchor', equationId: 'e2', score: 1 });
    expect(c[2]).toEqual({
      ordinal: 3,
      kind: 'equation',
      eqNumber: 'A.1',
      status: 'ambiguous',
      score: 0,
      candidates: 2,
      eqCandidates: [
        { equationId: 'a1', sectionNumber: 'II', pdfPage: null },
        { equationId: 'a2', sectionNumber: 'II', pdfPage: null },
      ],
    });
    expect(c[3]).toEqual({ ordinal: 4, kind: 'equation', eqNumber: '9', status: 'not_found', score: 0 });
    expect(resolveCitations(refs('1'), PAGES, [])[0]!.status).toBe('unindexed');
  });
  it('rows without a number are not an index (only unnumbered rows → unindexed); index rows without ids carry no equationId key', () => {
    expect(resolveCitations(refs('1'), PAGES, [row(null, 1, 'x')])[0]!.status).toBe('unindexed');
    const [c] = resolveCitations(refs('1'), PAGES, [row('1', 1)]);
    expect('equationId' in c!).toBe(false);
    expect('eqCandidates' in resolveCitations(refs('3'), PAGES, [row('3', 1), row('3', 2)])[0]!).toBe(false);
  });
  it('a LaTeX longer than EQUATION_LATEX_MAX is not attached', () => {
    const [c] = resolveCitations(refs('1'), PAGES, [{ number: '1', pdfPage: 1, id: 'e', latex: 'x'.repeat(EQUATION_LATEX_MAX + 1), katexOk: false }]);
    expect(c).toMatchObject({ equationId: 'e', katexOk: false });
    expect('latex' in c!).toBe(false);
  });
  it('at most 8 candidates', () => {
    const many = Array.from({ length: 12 }, (_, i) => row('5', null, `c${i}`));
    expect(resolveCitations(refs('5'), PAGES, many)[0]).toMatchObject({ candidates: 12, eqCandidates: expect.any(Array) });
    expect(resolveCitations(refs('5'), PAGES, many)[0]!.eqCandidates).toHaveLength(8);
  });
});

describe('number forms (eqNumberKey)', () => {
  const index = [row('4', 1, 'four'), row('A.1', 2, 'app'), row('4a', 1, 'fourA')];
  it.each([
    ['4', 'four'],
    ['(4)', 'four'],
    ['Eq. 4', 'four'],
    ['Equation 4', 'four'],
    ['A.1', 'app'],
    ['a.1', 'app'],
    ['4a', 'fourA'],
    ['4A', 'fourA'],
  ])('%s → %s', (n, id) => {
    expect(resolveCitations(refs(n), PAGES, index)[0]).toMatchObject({ status: 'resolved', equationId: id, eqNumber: n });
  });
  it('forms the frozen prefix rule leaves alone stay not_found (eqn 4, Equations 4, eqA.1)', () => {
    expect(resolveCitations(refs('eqn 4', 'Equations 4', 'eqA.1'), PAGES, index).map((c) => c.status)).toEqual(['not_found', 'not_found', 'not_found']);
  });
  it('the real markup reaches the same states for 4, A.1, 4a and a.1 (the grammar is unchanged: "Equation 4" is no tag)', () => {
    const parsed = parseAnswer('<eq n="4"/> <eq n="A.1"/> <eq n="4a"/> <eq n="a.1"/> <eq n="Equation 4"/>');
    expect(parsed.citations.map((c) => c.eqNumber)).toEqual(['4', 'A.1', '4a', 'a.1']);
    expect(resolveCitations(parsed, PAGES, index).map((c) => c.status)).toEqual(['resolved', 'resolved', 'resolved', 'resolved']);
  });
  it('index rows equal only in case → ambiguous with 2 candidates', () => {
    expect(resolveCitations(refs('A.1'), PAGES, [row('A.1', 1, 'x'), row('a.1', 2, 'y')])[0]).toMatchObject({ status: 'ambiguous', candidates: 2 });
  });
});

describe('work per reference does not grow with the index (review B-R2-04)', () => {
  /** Index rows whose `number` reads are counted. */
  const counted = (n: number) => {
    const reads = { n: 0 };
    const rows = Array.from({ length: n }, (_, i): EquationIndexRow => {
      const r = row(String(i + 1), 1, `e${i + 1}`);
      const number = r.number;
      Object.defineProperty(r, 'number', { get: () => (reads.n++, number), enumerable: true });
      return r;
    });
    return { rows, reads };
  };
  it('16,000 references against 1,000 rows read each row number a fixed number of times (not once per reference)', () => {
    const many = Array.from({ length: 16_000 }, (_, i) => String((i % 1_200) + 1)); // resolved and not_found
    const { rows, reads } = counted(1_000);
    const c = resolveCitations(refs(...many), PAGES, rows);
    expect(c).toHaveLength(16_000);
    expect(c[6]).toMatchObject({ status: 'resolved', equationId: 'e7' });
    expect(c[1_100]).toMatchObject({ status: 'not_found' });
    expect(reads.n).toBeLessThanOrEqual(4 * 1_000);
    // the same count for 10 references: the work is per row, plus one lookup per reference
    const small = counted(1_000);
    resolveCitations(refs(...many.slice(0, 10)), PAGES, small.rows);
    expect(reads.n).toBe(small.reads.n);
  });
  it('the ambiguous candidates come out in index order through the grouped lookup', () => {
    const c = resolveCitations(refs('3', '3'), PAGES, [row('3', 1, 'x'), row('1', 1, 'y'), row('(3)', 2, 'z')]);
    expect(c.map((x) => x.eqCandidates?.map((e) => e.equationId))).toEqual([
      ['x', 'z'],
      ['x', 'z'],
    ]);
  });
});

describe('the seeded equation index (equationIndex)', () => {
  it('SEED_M2: 1 and 2 resolved (anchored), group 3, katexOk=false 4, duplicate A.1 → ambiguous with both ids; the upgrade seed has no index', async () => {
    const env = await makeRunEnv();
    await seedFixture(env.db, env.sqlite, env.paths, Date.now(), { papers: ['upgrade', 'm2'] });
    const index = equationIndex(env.db, SEED_M2_PAPER_ID);
    expect(index.every((r) => r.number !== null && r.id)).toBe(true);
    const c = resolveCitations(parseAnswer('<eq n="1"/> <eq n="2"/> <eq n="4"/> <eq n="A.1"/>'), PAGES, index);
    expect(c.map((x) => x.status)).toEqual(['resolved', 'resolved', expect.stringMatching(/resolved|no_anchor/), 'ambiguous']);
    expect(c[0]).toMatchObject({ latex: 'r_{i}=R\\,p_{i}+t-q_{i}', katexOk: true });
    expect(c[2]).toMatchObject({ katexOk: false });
    expect(c[3]!.eqCandidates).toHaveLength(2);
    expect(c[3]!.eqCandidates!.every((x) => x.pdfPage === null)).toBe(true);
    expect(resolveCitations(parseAnswer('<eq n="1"/>'), PAGES, equationIndex(env.db, SEED_UPGRADE_PAPER_ID))[0]!.status).toBe('unindexed');
    env.close();
  });
});
