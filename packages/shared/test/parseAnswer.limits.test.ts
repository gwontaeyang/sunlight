// parseAnswer work bounds (review B-R1-02, BRIEF_COMMON rule 3). Owner B.
// - The hand-written scans (escapeInline, strip-mode label removal, reserved-link neutralisation) count their steps:
//   100× the input → ≤ 100× the steps + a constant, for every mode.
// - The regular expressions that rescanned a run per start position (label lookbehind, label-at-end tail, lazy <q>
//   / <glossary> / <term> bodies, literal-span masking) are judged with a loose wall-clock bound only (rule: no
//   timing judgement except a loose upper limit). Before the fix these inputs took 2–30 s at 200,000 chars.
// - Review B-R2-01: block-structure shapes (a whitespace run before a failing table delimiter, list-marker runs, a
//   marker run followed by many lines, backtick runs of distinct lengths, nested images, mid-block labels before a
//   long whitespace tail). splitFences / applyLabels / literalSpans / the unsafe-range scan count their work too, so
//   these are judged by steps (same ratio to the input length, plus a constant) as well as by the wall clock.
//   Before the fix: 0.3–60 s at 200,000 chars.
import { describe, expect, it } from 'vitest';
import type { ParseOptions } from '../src/contracts/markupApi';
import { expandTabs, literalSpans, type MarkupWork, parseAnswer, splitFences } from '../src/markup/parseAnswer';

const MODES: [string, ParseOptions][] = [
  ['default', { final: true }],
  ['strip', { final: true, labels: 'strip' }],
  ['plain', { final: true, mode: 'plain' }],
  ['streaming', { final: false }],
];

const steps = (raw: string, opts: ParseOptions) => {
  const w: MarkupWork = { steps: 0 };
  parseAnswer(raw, opts, w);
  return w.steps;
};

/** Whole units only, so 100× the length is exactly 100× the units. */
const fill = (unit: string, n: number) => unit.repeat(Math.max(1, Math.round(n / unit.length)));

describe('parseAnswer: linear work (step counter)', () => {
  const shapes: Record<string, (n: number) => string> = {
    backslashes: (n) => fill('\\', n),
    'backslashes before a label': (n) => fill('\\\\\\[[P]]', n),
    'backslashes before a backtick': (n) => `${fill('\\', n)}\``,
    'open brackets': (n) => fill('[', n),
    'reserved link chain': (n) => fill('[a](#sp-', n),
    'reserved links': (n) => fill('[a](#sp-x) ', n),
    'label tokens': (n) => fill('[[P]] ', n),
  };
  for (const [name, make] of Object.entries(shapes)) {
    for (const [mode, opts] of MODES) {
      it(`${name} (${mode}): 100× the input → ≤ 100× the steps + a constant`, () => {
        const one = steps(make(2_000), opts);
        const hundred = steps(make(200_000), opts);
        expect(one).toBeGreaterThan(0);
        expect(hundred).toBeLessThanOrEqual(100 * one + 5_000);
      });
    }
  }
});

/** Backtick (or other) runs of lengths 1, 2, 3, … separated by `sep` until `n` chars: no run has a closer. */
const distinctRuns = (ch: string, sep: string, n: number) => {
  let s = '';
  for (let k = 1; s.length < n; k++) s += ch.repeat(k) + sep;
  return s;
};

/**
 * Steps allowed for `big` given the steps of `small`: the same steps per input char, 5 % slack (the share of fixed
 * per-item terms shifts a little with the size of a shape) and a constant. A path that rescans per item gives ~100×.
 */
const linearBound = (small: string, big: string, smallSteps: number) => (big.length / small.length) * smallSteps * 1.05 + 5_000;

/** Block-structure shapes (review B-R2-01); each grows with n. */
const blockShapes: Record<string, (n: number) => string> = {
  'NBSP run before a failing table delimiter': (n) => `${fill('\u00a0', n)}x`,
  'EM SPACE run, dash run, then a letter': (n) => `${fill('\u2003', n / 2)}${fill('-', n / 2)}x`,
  '-- and a space run, then a letter': (n) => `--${fill(' ', n)}x`,
  'pipe cells ending in a letter': (n) => `${fill('|-', n)}x`,
  '- marker run': (n) => `${fill('- ', n)}x`,
  '* marker run': (n) => `${fill('* ', n)}x`,
  'ordered marker run': (n) => `${fill('1. ', n)}x`,
  'marker run, then a thematic dash run': (n) => `${fill('- ', n / 2)}${fill('-', n / 2)}x`,
  'marker run with a whitespace tail': (n) => `${fill('- ', n / 2)}x${fill(' ', n / 2)}`,
  'marker run followed by many lines': (n) => `${fill('- ', n / 2)}x\n${fill('y\n', n / 2)}`,
  'deep marker line followed by list items': (n) => `${fill('- ', n / 2)}x\n${fill('- y\n', n / 2)}`,
  'backtick runs of distinct lengths': (n) => distinctRuns('`', 'a', n),
  'dollar runs of distinct lengths': (n) => distinctRuns('$', 'a', n),
  'backtick runs of distinct lengths over lines': (n) => distinctRuns('`', 'a\n', n),
  'nested images': (n) => `${fill('![', n / 2)}${fill(']', n / 2)}`,
  'nested images with citations': (n) => `${fill('![<q>a</q>', n / 2)}${fill(']', n / 20)}`,
  'mid-block labels before a whitespace tail': (n) => `${fill('a. [[P]] ', n / 2)}b${fill(' ', n / 2)}`,
  'many table rows': (n) => fill('| a | b |\n| --- | --- |\n', n),
};

describe('parseAnswer: block structure is linear (step counter, review B-R2-01)', () => {
  for (const [name, make] of Object.entries(blockShapes)) {
    for (const [mode, opts] of MODES) {
      it(`${name} (${mode}): steps per input char do not grow with the input`, () => {
        const small = make(2_000);
        const big = make(200_000);
        const one = steps(small, opts);
        const hundred = steps(big, opts);
        expect(one).toBeGreaterThan(0);
        expect(hundred).toBeLessThanOrEqual(linearBound(small, big, one));
      });
    }
  }
  it('splitFences and literalSpans count their own work (headings.ts and the masking use them directly)', () => {
    for (const make of [blockShapes['- marker run']!, blockShapes['marker run followed by many lines']!, blockShapes['backtick runs of distinct lengths']!]) {
      const small = expandTabs(make(2_000));
      const big = expandTabs(make(200_000));
      const w1: MarkupWork = { steps: 0 };
      const w100: MarkupWork = { steps: 0 };
      splitFences(small, w1);
      splitFences(big, w100);
      literalSpans(small, w1);
      literalSpans(big, w100);
      expect(w1.steps).toBeGreaterThan(0);
      expect(w100.steps).toBeLessThanOrEqual(linearBound(small, big, w1.steps));
    }
  });
});

describe('parseAnswer: no run of the input is rescanned per position (loose wall-clock bound)', () => {
  const N = 200_000;
  const inputs: Record<string, string> = {
    backslashes: fill('\\', N),
    'spaces after a sentence end': `a.${fill(' ', N)}x`,
    'spaces after a label': `x [[P]]${fill(' ', N)}y`,
    'spaces after a label and a pipe': `x [[P]] |${fill(' ', N)}y`,
    'unclosed <q>': fill('<q>', N),
    'unclosed <glossary>': fill('<glossary>', N),
    'unclosed <term>': `<glossary>${fill('<term name="x">', N)}</glossary>`,
    'open brackets': fill('[', N),
    'image openers': fill('![', N),
    'reserved link chain': fill('[a](#sp-', N),
    'inline code spans': fill('`a', N),
    mixed: fill('a. [[P]] <q>b</q> [x](#sp-y) \\`$ ', N),
    ...Object.fromEntries(Object.entries(blockShapes).map(([k, make]) => [k, make(N)])),
  };
  for (const [name, raw] of Object.entries(inputs)) {
    it(`${name}: every mode finishes well inside 1.5 s`, () => {
      for (const [, opts] of MODES) {
        const t = performance.now();
        parseAnswer(raw, opts);
        expect(performance.now() - t).toBeLessThan(1_500);
      }
    });
  }
});
