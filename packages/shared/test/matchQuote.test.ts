import { describe, expect, it } from 'vitest';
import { editDistanceEnds, findExactHits, fuzzyMaxErrors, matchQuote, MAX_ANSWER_WORK, MAX_NEEDLE_CHARS, MAX_QUOTE_WORK, MAX_TEXT_CHARS, quoteEqualsN1, WorkBudget } from '../src/anchor/matchQuote';

const HEADER = 'SYNTHETIC TEST PAPER - NOT A REAL PUBLICATION';
const pages = [
  {
    page: 1,
    text: `${HEADER}\nWe estimate the pose by minimizing the point-to-\npoint residual between consecutive scans. The data asso-\nciation uses a fixed threshold of 0.5 m and a robust kernel.\nThe system is non-linear in the rotation.\n`,
  },
  { page: 2, text: `${HEADER}\nThe robust kernel down-weights outliers.\nWithout the robust kernel it fails.\nThe method runs at 10 Hz on a single CPU core.\n` },
];
const slice = (page: number, r: { start: number; end: number }) => pages[page - 1]!.text.slice(r.start, r.end);

describe('matchQuote: verbatim (N1 exact)', () => {
  it('a unique quote is verbatim with its page and UTF-16 range', () => {
    const r = matchQuote(pages, { exact: 'The method runs at 10 Hz on a single CPU core.' });
    expect(r).toMatchObject({ status: 'verbatim', score: 1 });
    expect(r.position?.page).toBe(2);
    expect(slice(2, r.position!)).toBe('The method runs at 10 Hz on a single CPU core.');
  });
  it('line-end hyphen kept (point-to-point)', () => {
    const r = matchQuote(pages, { exact: 'minimizing the point-to-point residual' });
    expect(r.status).toBe('verbatim');
    expect(slice(1, r.position!)).toBe('minimizing the point-to-\npoint residual');
  });
  it('line-end hyphen dropped (association)', () => {
    const r = matchQuote(pages, { exact: 'The data association uses a fixed threshold' });
    expect(r.status).toBe('verbatim');
    expect(slice(1, r.position!)).toBe('The data asso-\nciation uses a fixed threshold');
  });
  it('one quote that keeps one line-end hyphen and drops another', () => {
    const r = matchQuote(pages, { exact: 'the point-to-point residual between consecutive scans. The data association uses' });
    expect(r.status).toBe('verbatim');
    expect(slice(1, r.position!)).toBe('the point-to-\npoint residual between consecutive scans. The data asso-\nciation uses');
  });
  it('the line-end hyphen written by the quote itself also matches (selection text)', () => {
    expect(matchQuote(pages, { exact: 'The data asso-\nciation uses' }).status).toBe('verbatim');
    expect(matchQuote(pages, { exact: 'The data asso-ciation uses' }).status).toBe('verbatim');
  });
  it('whitespace amount and quote/dash shapes do not matter, case and word boundaries do', () => {
    expect(matchQuote(pages, { exact: 'The  method runs\nat 10 Hz on a single CPU core.' }).status).toBe('verbatim');
    expect(matchQuote(pages, { exact: 'the method runs at 10 hz on a single cpu core.' }).status).toBe('fuzzy');
    // review M1: a space between two letters/digits must be on both sides
    expect(matchQuote(pages, { exact: 'The method runs at 10Hz on a single CPU core.' }).status).toBe('fuzzy');
    expect(matchQuote(pages, { exact: 'The method runs at 10 Hz on a singleCPU core.' }).status).toBe('fuzzy');
    // next to punctuation a space may be missing on either side
    expect(matchQuote(pages, { exact: 'The method runs at 10 Hz on a single CPU core .' }).status).toBe('verbatim');
  });
});

describe('matchQuote: ambiguous and prefix/suffix', () => {
  it('a repeated running header is ambiguous', () => {
    const r = matchQuote(pages, { exact: HEADER });
    expect(r).toMatchObject({ status: 'ambiguous', candidates: 2, score: 0 });
    expect(r.position).toBeUndefined();
  });
  it('robust kernel occurs 3 times → ambiguous(3)', () => {
    expect(matchQuote(pages, { exact: 'robust kernel' })).toMatchObject({ status: 'ambiguous', candidates: 3 });
  });
  it('prefix resolves to one place', () => {
    const r = matchQuote(pages, { exact: 'robust kernel', prefix: 'Without the ' });
    expect(r.status).toBe('verbatim');
    expect(r.position?.page).toBe(2);
    expect(slice(2, r.position!)).toBe('robust kernel');
    expect(pages[1]!.text.slice(r.position!.start - 12, r.position!.start)).toBe('Without the ');
  });
  it('suffix resolves to one place', () => {
    const r = matchQuote(pages, { exact: 'robust kernel', suffix: ' down-weights' });
    expect(r.status).toBe('verbatim');
    expect(pages[1]!.text.slice(r.position!.end, r.position!.end + 13)).toBe(' down-weights');
  });
  it('prefix crossing a line-end hyphen still matches (32-char DOM context)', () => {
    const r = matchQuote(pages, { exact: 'robust kernel', prefix: 'ciation uses a fixed threshold of 0.5 m and a ' });
    expect(r.status).toBe('verbatim');
    expect(r.position?.page).toBe(1);
    const r2 = matchQuote(pages, { exact: 'robust kernel', prefix: 'association uses a fixed threshold of 0.5 m and a ' });
    expect(r2.position?.page).toBe(1);
  });
  it('prefix/suffix never extend past the page', () => {
    const p = [
      { page: 1, text: 'alpha beta gamma\nalpha beta' },
      { page: 2, text: 'xx alpha beta yy' },
    ];
    expect(matchQuote(p, { exact: 'alpha beta', suffix: ' gamma' })).toMatchObject({ status: 'verbatim', position: { page: 1, start: 0 } });
    expect(matchQuote(p, { exact: 'alpha beta', prefix: 'gamma\n' })).toMatchObject({ status: 'verbatim', position: { page: 1, start: 17 } });
    // the page ends right after the quote: a suffix the page cannot contain excludes that hit
    expect(matchQuote(p, { exact: 'alpha beta', prefix: 'gamma\n', suffix: ' and more' })).toMatchObject({ status: 'ambiguous', candidates: 3 });
  });
  it('prefix/suffix that match nothing keep the quote ambiguous with all candidates', () => {
    expect(matchQuote(pages, { exact: 'robust kernel', prefix: 'nowhere ' })).toMatchObject({ status: 'ambiguous', candidates: 3 });
  });
  it('prefix/suffix matching two of three → ambiguous(2)', () => {
    expect(matchQuote(pages, { exact: 'robust kernel', prefix: 'he ' })).toMatchObject({ status: 'ambiguous', candidates: 2 });
  });
});

describe('matchQuote: pageHint / pageOnly', () => {
  it('pageOnly restricts the search to one page', () => {
    expect(matchQuote(pages, { exact: HEADER }, { pageHint: 2, pageOnly: true })).toMatchObject({ status: 'verbatim', position: { page: 2 } });
    expect(matchQuote(pages, { exact: 'The method runs at 10 Hz' }, { pageHint: 1, pageOnly: true }).status).toBe('not_found');
  });
  it('pageHint without pageOnly keeps document-wide uniqueness', () => {
    expect(matchQuote(pages, { exact: HEADER }, { pageHint: 2 }).status).toBe('ambiguous');
    expect(matchQuote(pages, { exact: 'The method runs at 10 Hz' }, { pageHint: 1 })).toMatchObject({ status: 'verbatim', position: { page: 2 } });
  });
  it('pageHint wins for fuzzy even when another page scores higher', () => {
    const p = [
      { page: 1, text: 'the filter converges after 12 iterations on average' },
      { page: 2, text: 'the filter converges after 10 iterations on average' },
    ];
    const q = { exact: 'the filter converges after 10 iterations in average' };
    expect(matchQuote(p, q)).toMatchObject({ status: 'fuzzy', position: { page: 2 } });
    expect(matchQuote(p, q, { pageHint: 1 })).toMatchObject({ status: 'fuzzy', position: { page: 1 } });
  });
  it('a quote crossing a page boundary is not verbatim (pages are never concatenated)', () => {
    const r = matchQuote(pages, { exact: 'a robust kernel.\nThe system is non-linear in the rotation.\nSYNTHETIC TEST PAPER - NOT A REAL PUBLICATION\nThe robust kernel down-weights outliers.' });
    expect(r.status).not.toBe('verbatim');
  });
  it('findExactHits lists every hit with its context check', () => {
    const hits = findExactHits(pages, { exact: 'robust kernel', prefix: 'Without the ' });
    expect(hits.map((h) => [h.page, h.contextOk])).toEqual([
      [1, false],
      [2, false],
      [2, true],
    ]);
  });
});

describe('matchQuote: fuzzy', () => {
  it('non-linear vs nonlinear is fuzzy (N2), score < 1', () => {
    const r = matchQuote(pages, { exact: 'The system is nonlinear in the rotation.' });
    expect(r.status).toBe('fuzzy');
    expect(r.score).toBeGreaterThanOrEqual(0.8);
    expect(r.score).toBeLessThan(1);
    expect(slice(1, r.position!)).toBe('The system is non-linear in the rotation.');
  });
  it('a changed number is not verbatim (fuzzy at best)', () => {
    const r = matchQuote(pages, { exact: 'uses a fixed threshold of 0.7 m and a robust kernel.' });
    expect(r.status).toBe('fuzzy');
    expect(r.score).toBeLessThan(1);
  });
  it('a negated sentence is not verbatim', () => {
    expect(matchQuote(pages, { exact: 'The method does not run at 10 Hz on a single CPU core.' }).status).not.toBe('verbatim');
  });
  it('a changed word is not verbatim', () => {
    expect(matchQuote(pages, { exact: 'We estimate the pose by maximizing the point-to-point residual' }).status).not.toBe('verbatim');
  });
  it('approx threshold boundary: score = 1 − errors/len ≥ 0.8 is accepted, below is not_found', () => {
    // N2 length 20 → maxErrors 4 → 4 substitutions = 0.8 (accepted), 5 = rejected
    const base = 'abcdefghijklmnopqrst';
    const p = [{ page: 1, text: `zz ${base} zz` }];
    expect(fuzzyMaxErrors(20)).toBe(4);
    const four = 'XbcdeXghijXlmnoXqrst'; // 4 errors, N2 lower-cases to x
    const r4 = matchQuote(p, { exact: four });
    expect(r4.status).toBe('fuzzy');
    expect(r4.score).toBeCloseTo(0.8, 10);
    expect(matchQuote(p, { exact: 'XbcdeXghijXlmnoXqrXt' }).status).toBe('not_found');
    // N2 length 12 → maxErrors ceil(2.4) = 3, but 3/12 = 0.75 < 0.8 → not_found; 2/12 → fuzzy
    const p12 = [{ page: 1, text: 'aa abcdefghijkl aa' }];
    expect(matchQuote(p12, { exact: 'XbcdeXghiXkl' }).status).toBe('not_found');
    expect(matchQuote(p12, { exact: 'XbcdefghiXkl' })).toMatchObject({ status: 'fuzzy' });
  });
  it('maxErrors is capped at 32 for long quotes', () => {
    expect(fuzzyMaxErrors(600)).toBe(32);
  });
  it('quotes shorter than 12 N1 chars get the exact stage only', () => {
    expect(matchQuote(pages, { exact: 'robust kernal' }).status).toBe('fuzzy'); // 12 N1 chars
    expect(matchQuote(pages, { exact: 'robst kernel' }).status).toBe('not_found'); // 11 N1 chars
    expect(matchQuote(pages, { exact: '10 Hz' }).status).toBe('verbatim');
    expect(matchQuote(pages, { exact: '11 Hz' }).status).toBe('not_found');
  });
  it('not_found for an invented sentence and for empty input', () => {
    expect(matchQuote(pages, { exact: 'The method requires a GPU with 24 GB of memory.' }).status).toBe('not_found');
    expect(matchQuote(pages, { exact: ' \n ' })).toEqual({ status: 'not_found', score: 0 });
  });
});

describe('quoteEqualsN1 (DOM re-check)', () => {
  it('accepts N1-equal text and line-end hyphen variants, rejects anything else', () => {
    expect(quoteEqualsN1('The data association', 'The data asso-\nciation')).toBe(true);
    expect(quoteEqualsN1('The data asso-ciation', 'The data asso-\nciation')).toBe(true);
    expect(quoteEqualsN1('point-to-point', 'point-to-\npoint')).toBe(true);
    expect(quoteEqualsN1('The data association', 'The data association uses')).toBe(false);
    expect(quoteEqualsN1('non-linear', 'nonlinear')).toBe(false);
    expect(quoteEqualsN1('', '')).toBe(false);
  });
});

describe('matchQuote: word boundaries and NFKC chunks (review M1)', () => {
  const robot = [{ page: 1, text: 'The robot is nowhere.\nIt was a ﬁne day.' }];
  it('a space between two letters must be on both sides', () => {
    expect(matchQuote(robot, { exact: 'The robot is now here.' }).status).not.toBe('verbatim');
    expect(matchQuote([{ page: 1, text: 'The robot is now here.' }], { exact: 'The robot is nowhere.' }).status).not.toBe('verbatim');
    expect(quoteEqualsN1('The robot is now here.', 'The robot is nowhere.')).toBe(false);
    expect(quoteEqualsN1('The robot is nowhere.', 'The robot is now\nhere.')).toBe(false); // a line break is a word boundary
    expect(matchQuote(robot, { exact: 'The robot is nowhere.' }).status).toBe('verbatim');
  });
  it('a space next to punctuation, or in a no-space script, may be missing on one side', () => {
    const p = [{ page: 1, text: 'see Fig. 1 and [12] , 文字\n列 here' }];
    expect(matchQuote(p, { exact: 'see Fig.1 and [12],' }).status).toBe('verbatim');
    expect(matchQuote(p, { exact: '文字列 here' }).status).toBe('verbatim');
  });
  it('a pdf.js item boundary is not a word boundary (review N1): extra item fields are ignored', () => {
    // PageText objects carry `items`; a split inside "nowhere" must not make "now here" verbatim.
    const page = { page: 1, text: 'nowhere', items: [{ start: 0, len: 3, rect: null }, { start: 3, len: 4, rect: null }] };
    expect(matchQuote([page], { exact: 'now here' }).status).not.toBe('verbatim');
    const fragmented = { page: 1, text: 'it goes nowhere fast', items: [{ start: 0, len: 11 }, { start: 11, len: 9 }] };
    expect(matchQuote([fragmented], { exact: 'goes now here fast' }).status).not.toBe('verbatim');
    expect(quoteEqualsN1('now here', 'nowhere')).toBe(false);
    expect(matchQuote([page], { exact: 'nowhere' }).status).toBe('verbatim');
  });
  it('a quote matching only part of an NFKC-expanded character is not verbatim', () => {
    expect(matchQuote([{ page: 1, text: 'ﬁ' }], { exact: 'f' }).status).not.toBe('verbatim');
    expect(matchQuote([{ page: 1, text: 'x ﬁ y' }], { exact: 'x f' }).status).not.toBe('verbatim');
    expect(matchQuote([{ page: 1, text: 'eﬃcient' }], { exact: 'ef' }).status).not.toBe('verbatim');
    expect(quoteEqualsN1('f', 'ﬁ')).toBe(false);
    expect(findExactHits([{ page: 1, text: 'a ﬁ b' }], { exact: 'i b' })).toEqual([]);
    const r = matchQuote(robot, { exact: 'It was a fine day.' });
    expect(r.status).toBe('verbatim');
    expect(robot[0]!.text.slice(r.position!.start, r.position!.end)).toBe('It was a ﬁne day.');
  });
  it('line-end hyphens keep working with word boundaries', () => {
    const p = [{ page: 1, text: 'the point-to-\npoint data asso-\nciation and asso- \n  ciation' }];
    expect(matchQuote(p, { exact: 'the point-to-point data association' }).status).toBe('verbatim');
    expect(matchQuote(p, { exact: 'the point-to- point data asso-ciation' }).status).toBe('verbatim');
    expect(matchQuote(p, { exact: 'the point-to-point data asso ciation' }).status).not.toBe('verbatim');
    expect(matchQuote(p, { exact: 'and association' }).status).toBe('verbatim');
  });
});

// Gates are the deterministic work units (WorkBudget.used, the same on every machine and under any load);
// wall-clock checks are only a loose sanity bound (SANITY_MS) so parallel test load cannot make them flaky.
const SANITY_MS = 5000;

describe('matchQuote: bounded work on line-end hyphen runs (review B2)', () => {
  // PDF text '-\n' × n + 'X' vs quote '-' × n/2 + 'Y': the old search tried every consume/skip combination
  // (n = 26 took ~0.7 s, n = 30 did not finish in 12 s).
  it.each([18, 26, 30, 64, 200, 1000, 2000, 4000])('n = %i finishes fast and is never verbatim', (n) => {
    const pages = [{ page: 1, text: `${'-\n'.repeat(n)}X` }];
    const budget = new WorkBudget(Number.MAX_SAFE_INTEGER);
    const t0 = performance.now();
    const r = matchQuote(pages, { exact: `${'-'.repeat(n / 2)}Y` }, { budget });
    const hits = findExactHits(pages, { exact: `${'-'.repeat(n / 2)}X` }, { pageHint: 1, pageOnly: true });
    const eq = quoteEqualsN1(`${'-'.repeat(n / 2)}X`, pages[0]!.text);
    const ms = performance.now() - t0;
    expect(['not_found', 'unchecked']).toContain(r.status); // unchecked once the work budget runs out
    expect(budget.used).toBeLessThanOrEqual(MAX_QUOTE_WORK + 1_000_000); // one quote's cap (+ one step)
    expect(hits.length).toBeLessThanOrEqual(n);
    expect(typeof eq).toBe('boolean');
    expect(ms).toBeLessThan(SANITY_MS);
  });
  it('the DP finds the right answer when the page is small enough for the work cap', () => {
    const pages = [{ page: 1, text: `${'-\n'.repeat(12)}X` }];
    expect(quoteEqualsN1(`${'-'.repeat(6)}X`, `${'-\n'.repeat(6)}X`)).toBe(true);
    expect(quoteEqualsN1('X', `${'-\n'.repeat(6)}X`)).toBe(true);
    expect(findExactHits(pages, { exact: `${'-'.repeat(6)}X` })).toHaveLength(13 - 6);
  });
  it('the work cap degrades to unchecked (never not_found, never verbatim) instead of blocking', () => {
    const pages = [{ page: 1, text: 'a'.repeat(20000) }];
    const budget = new WorkBudget(Number.MAX_SAFE_INTEGER);
    const t0 = performance.now();
    expect(matchQuote(pages, { exact: `${'a'.repeat(599)}b` }, { budget }).status).toBe('unchecked');
    expect(budget.used).toBeGreaterThan(MAX_QUOTE_WORK); // stopped by the per-quote cap …
    expect(budget.used).toBeLessThanOrEqual(MAX_QUOTE_WORK + 1_000_000); // … right after reaching it
    expect(findExactHits(pages, { exact: `${'a'.repeat(599)}b` })).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(SANITY_MS);
  });
  it('40 adversarial quotes over long hyphen pages share one answer budget', () => {
    const pages = Array.from({ length: 4 }, (_, k) => ({ page: k + 1, text: `${'-\n'.repeat(2000)}X` }));
    const budget = new WorkBudget(MAX_ANSWER_WORK);
    const t0 = performance.now();
    for (let q = 0; q < 40; q++) expect(matchQuote(pages, { exact: `${'-'.repeat(500 + q)}Y` }, { budget }).status).toBe('unchecked');
    expect(budget.used).toBeLessThanOrEqual(MAX_ANSWER_WORK + MAX_QUOTE_WORK);
    expect(performance.now() - t0).toBeLessThan(SANITY_MS);
  });
});

describe('matchQuote: the whole citation resolution of one answer is bounded (review N3)', () => {
  const page = [{ page: 1, text: 'a'.repeat(20000) }];
  // Codex reproduction: 40 × ('B' + 'a' × 299) against 'a' × 20000 took ~7.9 s (fuzzy stage had no bound).
  it.each([
    ['B + a×299 (fuzzy, few errors)', `B${'a'.repeat(299)}`],
    ['A×600 (exact N2 hits everywhere)', 'A'.repeat(600)],
    ['a×599 + b (exact DP worst case)', `${'a'.repeat(599)}b`],
  ])('%s: 40 quotes stay within the answer budget (deterministic units)', (_name, q) => {
    const budget = new WorkBudget(MAX_ANSWER_WORK);
    const t0 = performance.now();
    const statuses = Array.from({ length: 40 }, () => matchQuote(page, { exact: q }, { budget }).status);
    const ms = performance.now() - t0;
    for (const st of statuses) expect(['fuzzy', 'not_found', 'unchecked']).toContain(st);
    // the gate: the units used never pass the cap by more than one charge of one quote (≈ 150 ms of work)
    expect(budget.used).toBeLessThanOrEqual(MAX_ANSWER_WORK + MAX_QUOTE_WORK);
    expect(ms).toBeLessThan(SANITY_MS); // was ~7.9 s for the first input before the budget
  });
  it('same input, same budget → same statuses (no wall clock involved)', () => {
    const run = () => {
      const budget = new WorkBudget(MAX_ANSWER_WORK);
      return Array.from({ length: 40 }, () => matchQuote(page, { exact: 'A'.repeat(600) }, { budget }).status).join();
    };
    expect(run()).toBe(run());
  });
  it('input caps: an over-long quote or too much page text is unchecked', () => {
    expect(matchQuote([{ page: 1, text: 'abc' }], { exact: 'x'.repeat(MAX_NEEDLE_CHARS + 1) }).status).toBe('unchecked');
    expect(matchQuote([{ page: 1, text: 'b'.repeat(MAX_TEXT_CHARS + 1) }], { exact: 'some quote text' }).status).toBe('unchecked');
  });
  it('the budget is exhausted for later quotes once an answer has used it up', () => {
    const budget = new WorkBudget(50_000);
    expect(matchQuote([{ page: 1, text: 'The robust kernel down-weights outliers.' }], { exact: 'robust kernel down-weights' }, { budget }).status).toBe('verbatim');
    expect(budget.used).toBeLessThan(50_000);
    expect(matchQuote([{ page: 1, text: 'x'.repeat(100_000) }], { exact: 'a quote that is not there at all' }, { budget }).status).toBe('unchecked');
    expect(matchQuote([{ page: 1, text: 'The robust kernel down-weights outliers.' }], { exact: 'robust kernel down-weights' }, { budget }).status).toBe('unchecked');
  });
});

describe('editDistanceEnds (bit-parallel, own implementation) equals the textbook DP', () => {
  const brute = (t: string, p: string, anchored: boolean) => {
    let prev = Array.from({ length: p.length + 1 }, (_, i) => i);
    const out: number[] = [];
    for (let j = 0; j < t.length; j++) {
      const cur = [anchored ? j + 1 : 0];
      for (let i = 1; i <= p.length; i++) cur[i] = Math.min(prev[i]! + 1, cur[i - 1]! + 1, prev[i - 1]! + (p[i - 1] === t[j] ? 0 : 1));
      out.push(cur[p.length]!);
      prev = cur;
    }
    return out;
  };
  it('random strings, 1–4 blocks of 32, semi-global and anchored', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let n = 0; n < 400; n++) {
      const al = 'abc'.slice(0, 1 + Math.floor(rnd() * 3));
      const p = Array.from({ length: 1 + Math.floor(rnd() * 120) }, () => al[Math.floor(rnd() * al.length)]).join('');
      const t = Array.from({ length: Math.floor(rnd() * 150) }, () => al[Math.floor(rnd() * al.length)]).join('');
      for (const anchored of [false, true]) expect([...editDistanceEnds(t, p, anchored)]).toEqual(brute(t, p, anchored));
    }
  });
});

describe('word boundaries on whole code points (review A2)', () => {
  const v = (text: string, exact: string) => matchQuote([{ page: 1, text }], { exact }).status;
  it('supplementary-plane letters and digits are word characters: a space next to them matters', () => {
    expect(v('𐐀bc', '𐐀 bc')).not.toBe('verbatim'); // U+10400 DESERET CAPITAL LONG I (a letter)
    expect(v('𐐀 bc', '𐐀bc')).not.toBe('verbatim');
    expect(v('a𐐀b', 'a 𐐀b')).not.toBe('verbatim');
    expect(v('a 𐐀b', 'a𐐀b')).not.toBe('verbatim');
    expect(v('x𑁒y', 'x 𑁒y')).not.toBe('verbatim'); // U+11052 BRAHMI NUMBER ONE (a number)
    expect(v('ab 𐐀 cd', 'ab 𐐀 cd')).toBe('verbatim');
    expect(v('ab 𐐀\ncd', 'ab 𐐀 cd')).toBe('verbatim');
  });
  it('emoji are not word characters: a space next to them may be missing', () => {
    expect(v('go😀now', 'go 😀 now')).toBe('verbatim');
    expect(v('go 😀 now', 'go😀now')).toBe('verbatim');
  });
  it('CJK (also supplementary-plane Han) needs no space; Hangul does', () => {
    expect(v('文字列', '文字 列')).toBe('verbatim');
    expect(v('𠀀字', '𠀀 字')).toBe('verbatim'); // U+20000, CJK Extension B
    expect(v('정합방법', '정합 방법')).not.toBe('verbatim');
  });
  it('PDF math alphanumerics (U+1D400–1D7FF) are folded by NFKC before the boundary check', () => {
    expect(v('let 𝑥 be the state', 'let x be the state')).toBe('verbatim'); // 𝑥 = U+1D465 → x
    expect(v('let 𝑥𝑦 be', 'let x y be')).not.toBe('verbatim'); // 𝑥𝑦 → xy: a space between letters must exist
    expect(v('pose 𝐓 and', 'pose T and')).toBe('verbatim');
  });
});

describe('editDistanceEnds with an empty pattern (review a1)', () => {
  it('semi-global: 0 everywhere; anchored: delete the prefix', () => {
    expect([...editDistanceEnds('abc', '', false)]).toEqual([0, 0, 0]);
    expect([...editDistanceEnds('abc', '', true)]).toEqual([1, 2, 3]);
  });
});

describe('exact N2 hits are all ranked (review a2)', () => {
  it('the closest of many case/hyphen variants wins, not the first four', () => {
    const text = `${'ABCDEFGHIJKLMNOP '.repeat(4)}abcdefghijklmnop`;
    const r = matchQuote([{ page: 1, text }], { exact: 'abcdefghijk-lmnop' });
    expect(r.status).toBe('fuzzy');
    expect(text.slice(r.position!.start, r.position!.end)).toBe('abcdefghijklmnop');
    expect(r.score).toBeCloseTo(1 - 1 / 17, 5);
  });
  it('ties keep the first hit; the scan stays inside the work budget', () => {
    const tie = matchQuote([{ page: 1, text: 'Point-to-point. Point-to-point.' }], { exact: 'point-to-point' });
    expect(tie).toMatchObject({ status: 'fuzzy', position: { start: 0 } });
    // 2 separator edits beat 4 case edits even though the case variant comes first
    const text = 'Point-to-point ICP. point to point icp.';
    const r = matchQuote([{ page: 1, text }], { exact: 'point-to-point icp' });
    expect(text.slice(r.position!.start, r.position!.end)).toBe('point to point icp');
  });
});
