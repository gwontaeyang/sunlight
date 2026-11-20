// Randomised adversarial answers (review B1 / m2): fragments of Markdown, HTML, footnotes, definitions, code,
// math, containers and SP-Markup glued at random, run through parser → server citation resolution and stats →
// SpMarkdown DOM. Two properties:
// 1. Safety, always: the DOM never shows more than the stats (grounded badges, verbatim chips), every grounded
//    badge shares its Markdown block with a verbatim chip, and no marker / private token reaches the screen.
// 2. Agreement, almost always: DOM counts equal the stats. A miss means the parser's CommonMark block model
//    and micromark disagree on some contrived nesting; it can only hide a chip (fail closed), never add one.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { computeStats, resolveCitations } from '../../../server/src/llm/citations';
import { SpMarkdown } from '../../src/markdown/SpMarkdown';

afterEach(cleanup);

const PAGES = [{ page: 1, text: 'the robot is now here and it stays.' }];
const FRAG = [
  '<q>the robot is now here</q>', '<q>it stays</q>', ' <q>x y z</q>', '<eq n="1"/>', ' [[P]]', ' [[N]]', '<q>the robot is now here</q> [[P]]\n',
  '`', '$', '$$\n', '```\n', '~~~\n', '<!--', '-->', '<div>', '<b>', '&#91;', '\\', '![', '](', ')', '[', ']', '[x](', '[t](u "', ' "', '"',
  '[r]: ', '[^1]: ', 'https://x.y/', '\n', '\n\n', '    ', '\n    ', '\n   ', '\t', '> ', '> > ', '- ', '\n  - ', '\n-     ', '1. ', '2. ', '\n1)  ',
  '+ ', '| ', '|', '\n|---|---|\n', '#', '***\n', '---\n', '=\n', '*', '_', ':', '(', 'text ',
];

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it('random adversarial answers: the DOM never exceeds the stats, and almost always equals them', () => {
  const rnd = mulberry32(20261116);
  const CASES = 800;
  const disagreements: string[] = [];
  for (let n = 0; n < CASES; n++) {
    let raw = '';
    const len = 3 + Math.floor(rnd() * 24);
    for (let k = 0; k < len; k++) raw += FRAG[Math.floor(rnd() * FRAG.length)];
    const parsed = parseAnswer(raw);
    const citations = resolveCitations(parsed, PAGES, []);
    const stats = computeStats(parsed, citations);
    const { container } = render(<SpMarkdown displayMd={parsed.displayMd} blocks={parsed.blocks} citations={citations} stats={stats} phase="final" />);
    const badges = screen.queryAllByTestId('sp-badge');
    const grounded = badges.filter((b) => b.dataset.status === 'p-grounded');
    const verbatim = screen.queryAllByTestId('sp-chip').filter((c) => c.dataset.status === 'verbatim');
    const ctx = JSON.stringify(raw);
    expect(grounded.length, ctx).toBeLessThanOrEqual(stats.blocks.p);
    expect(verbatim.length, ctx).toBeLessThanOrEqual(stats.quotes.verbatim);
    expect(badges.length, ctx).toBeLessThanOrEqual(parsed.blocks.filter((b) => b.label).length);
    for (const b of grounded) expect(b.closest('p, li, td, th, h1, h2, h3, h4, h5, h6')!.querySelector('[data-testid="sp-chip"][data-status="verbatim"]'), ctx).not.toBeNull();
    expect(container.textContent, ctx).not.toMatch(/[\u0000-\u0004]/);
    const got = [grounded.length, badges.filter((b) => b.dataset.status === 'p-unverified').length, verbatim.length];
    const want = [stats.blocks.p, stats.blocks.pUnverified, stats.quotes.verbatim];
    if (got.join() !== want.join()) disagreements.push(`${ctx} got ${got} want ${want}`);
    cleanup();
  }
  expect(disagreements.length, disagreements.join('\n')).toBeLessThanOrEqual(CASES * 0.005);
}, 60_000);
