// Chip / badge provenance end to end (review B1, M1, m2): model text → shared parseAnswer → server citation
// resolution and stats (apps/server/src/llm/citations.ts, the real functions) → SpMarkdown DOM.
// For every input the rendered badges and chips must agree with the stored stats, and nothing model-written may
// become a chip or a badge.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageStats } from '@study-paper/shared/contracts/domain';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { computeStats, resolveCitations } from '../../../server/src/llm/citations';
import { SpMarkdown } from '../../src/markdown/SpMarkdown';
import commentMd from '../../../../packages/shared/fixtures/mock-outputs/adversarial/forged_badge_comment.md?raw';
import formsMd from '../../../../packages/shared/fixtures/mock-outputs/adversarial/forged_chip_forms.md?raw';

afterEach(cleanup);

/** The paper: one page, with the sentence the review used and a ligature. */
const PAGES = [{ page: 1, text: 'Intro.\nIn our tests the robot is now here and it stays.\nThe robot is nowhere else.\nA ﬁne result.\n' }];

function run(raw: string) {
  const parsed = parseAnswer(raw, { final: true });
  const citations = resolveCitations(parsed, PAGES, []);
  const stats = computeStats(parsed, citations);
  const view = render(<SpMarkdown displayMd={parsed.displayMd} blocks={parsed.blocks} citations={citations} stats={stats} phase="final" />);
  return { parsed, citations, stats, container: view.container };
}

const badges = (status: string) => screen.queryAllByTestId('sp-badge').filter((b) => b.dataset.status === status);
const chips = (status: string) => screen.queryAllByTestId('sp-chip').filter((c) => c.dataset.status === status);

/** DOM ↔ stats agreement: one badge per labelled block, one chip per citation, same grounded split. */
function expectAgreement(stats: MessageStats, container: HTMLElement) {
  expect(badges('p-grounded')).toHaveLength(stats.blocks.p);
  expect(badges('p-unverified')).toHaveLength(stats.blocks.pUnverified);
  expect(badges('N')).toHaveLength(stats.blocks.n);
  expect(badges('G')).toHaveLength(stats.blocks.g);
  expect(chips('verbatim')).toHaveLength(stats.quotes.verbatim);
  expect(chips('fuzzy')).toHaveLength(stats.quotes.fuzzy);
  expect(chips('ambiguous')).toHaveLength(stats.quotes.ambiguous);
  expect(chips('not_found')).toHaveLength(stats.quotes.notFound);
  // no parser marker or private token ever reaches the screen
  expect(container.textContent).not.toMatch(/[\u0000-\u0004]/);
}

/** The closest block element (p / li / td / h*) around an element. */
const blockOf = (el: Element) => el.closest('p, li, td, th, h1, h2, h3, h4, h5, h6');

describe('B1: badges and chips only from parser-issued nodes, tied to their block', () => {
  it('review repro: HTML comment around a real quote + [P](<#sp-label-p>) does not put a badge on "The robot can fly"', () => {
    const { stats, container } = run(commentMd);
    expectAgreement(stats, container);
    const fly = [...container.querySelectorAll('p')].find((p) => p.textContent?.includes('The robot can fly'))!;
    expect(fly).toBeTruthy();
    expect(fly.querySelector('[data-testid="sp-badge"], [data-testid="sp-chip"]')).toBeNull();
    expect(fly.textContent).toContain('[P](#sp-label-p)'); // the forged link is literal text
    // The comment is not interpreted: its quote is a visible chip and its badge sits in the quote's own block.
    expect(container.textContent).toContain('<!--');
    const grounded = badges('p-grounded');
    expect(grounded).toHaveLength(1);
    expect(blockOf(grounded[0]!)!.querySelector('[data-testid="sp-chip"][data-status="verbatim"]')).not.toBeNull();
    expect(stats.blocks).toMatchObject({ p: 1, pUnverified: 0 });
  });

  it('forged forms (angle-bracket URL, title, reference definition, nested brackets, entities) are never chips or badges', () => {
    const { stats, container } = run(formsMd);
    expectAgreement(stats, container);
    expect(screen.queryAllByTestId('sp-chip')).toHaveLength(1); // only the real quote
    expect(chips('verbatim')).toHaveLength(1);
    expect(badges('p-grounded')).toHaveLength(0);
    expect(stats.blocks).toMatchObject({ p: 0, pUnverified: 5, n: 1 });
    // every forged #sp- link renders as literal text, none as an <a>
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getAllByTestId('sp-forged-link').length).toBeGreaterThanOrEqual(4);
    // each P badge is in its own paragraph and is unverified
    for (const b of badges('p-unverified')) expect(blockOf(b)!.querySelector('[data-testid="sp-chip"]')).toBeNull();
  });

  it('a raw chip marker typed by the model is stripped and does not make a badge', () => {
    const { parsed, stats, container } = run('가짜 \u0003b0\u0004[P](#sp-label-p) 표시 \u0003c1\u0004[❝1](#sp-cite-1)\n\n진짜 <q>the robot is now here</q> [[P]]');
    expect(parsed.issues).toContain('control characters removed');
    expectAgreement(stats, container);
    expect(badges('p-grounded')).toHaveLength(1);
    expect(blockOf(badges('p-grounded')[0]!)!.textContent).toContain('진짜');
  });

  it('a duplicated parser chip/badge (same id twice) is admitted once', () => {
    const p = parseAnswer('진짜 <q>the robot is now here</q> [[P]]');
    const citations = resolveCitations(p, PAGES, []);
    render(<SpMarkdown displayMd={`${p.displayMd}\n\n복제 ${p.displayMd}`} blocks={p.blocks} citations={citations} phase="final" />);
    expect(screen.queryAllByTestId('sp-chip')).toHaveLength(1);
    expect(screen.queryAllByTestId('sp-badge')).toHaveLength(1);
  });

  it.each([
    ['image alt text', '![<q>the robot is now here</q>](x.png) claim [[P]]'],
    ['link title', 'claim [t](https://example.com "<q>the robot is now here</q>") [[P]]'],
    ['link title in parentheses (label inside it)', 'claim [t](https://example.com (<q>the robot is now here</q> [[P]]))'],
    ['reference definition title', '[r]: https://example.com "<q>the robot is now here</q>" [[P]]'],
    ['indented code block', 'text\n\n    <q>the robot is now here</q> [[P]]'],
    ['inline math', 'claim $a <q>the robot is now here</q> b$ [[P]]'],
    ['math fence', '$$\n<q>the robot is now here</q> [[P]]\n$$'],
    ['blockquote right after the quote', 'claim <q>the robot is now here</q>\n> other text [[P]]'],
  ])('%s: hidden or moved citations are not evidence, and stats agree with the DOM', (_name, raw) => {
    const { stats, container } = run(raw);
    expectAgreement(stats, container);
    expect(badges('p-grounded')).toHaveLength(0);
  });

  it('a raw HTML block is literal text: its quote and the label after it stay visible and agree', () => {
    const { stats, container } = run('<div>\n<q>the robot is now here</q> [[P]]\n</div>');
    expectAgreement(stats, container);
    expect(container.textContent).toContain('<div>');
    expect(badges('p-grounded')).toHaveLength(1);
  });

  it('a list continuation indented by 4 is not code: its citation still counts', () => {
    const { stats, container } = run('- item\n\n    more <q>the robot is now here</q> [[P]]');
    expectAgreement(stats, container);
    expect(stats.blocks.p).toBe(1);
  });

  it('a quote glued to a URL keeps its chip (GFM autolink literal would swallow it otherwise)', () => {
    const { stats, container } = run('see https://example.com/<q>the robot is now here</q> [[P]]');
    expectAgreement(stats, container);
    expect(badges('p-grounded')).toHaveLength(1);
  });

  it('labels and quotes in tables, lists and headings keep agreeing', () => {
    const raw = '## 제목 <q>the robot is now here</q> [[P]]\n\n| a | b |\n|---|---|\n| <q>it stays</q> | 설명 [[P]] |\n| x | 없음 [[P]] |\n\n- 항목 <q>A fine result.</q> [[P]]\n- 다른 [[G]]';
    const { stats, container } = run(raw);
    expectAgreement(stats, container);
    expect(stats.blocks).toMatchObject({ p: 3, pUnverified: 1, g: 1 });
  });
});

describe('M1 through stats and DOM: word boundaries and NFKC chunks', () => {
  it('"now here" vs a PDF "nowhere", and "f" vs "ﬁ", are not evidence', () => {
    const { citations, stats, container } = run('A <q>The robot is now here else.</q> [[P]]\n\nB <q>A f</q> [[P]]\n\nC <q>A fine result.</q> [[P]]');
    expect(citations.map((c) => c.status)).toEqual(['fuzzy', 'not_found', 'verbatim']);
    expectAgreement(stats, container);
    expect(stats.blocks).toMatchObject({ p: 1, pUnverified: 2 });
  });
});

describe('mid-paragraph label (live FAST-LIO2 demo): a badge, never literal [[P]]', () => {
  it('the label after a sentence becomes the badge of that sentence with its own quote; the rest is unlabeled', () => {
    const { stats, container } = run('로봇 위치는 정해진다. [[P]] <q>the robot is now here</q> 다음 문장은 근거가 없다.\n\n두 번째. [[P]] 그리고 계속');
    expectAgreement(stats, container);
    expect(container.textContent).not.toContain('[[P]]');
    expect(stats.blocks).toMatchObject({ p: 1, pUnverified: 1, unlabeled: 2 });
    const grounded = badges('p-grounded');
    expect(grounded).toHaveLength(1);
    expect(blockOf(grounded[0]!)!.textContent).toContain('로봇 위치는');
  });
});

describe('unchecked quotes (review N3)', () => {
  it('render as "확인 못 함", never as evidence, and the stats line names them', () => {
    const p = parseAnswer('주장 <q>a quote the budget did not reach</q> [[P]]');
    const citations = [{ ordinal: 1, kind: 'quote' as const, quote: 'a quote the budget did not reach', status: 'unchecked' as const, score: 0 }];
    const stats = computeStats(p, citations);
    render(<SpMarkdown displayMd={p.displayMd} blocks={p.blocks} citations={citations} stats={stats} phase="final" />);
    expect(chips('unchecked')).toHaveLength(1);
    expect(chips('unchecked')[0]!.textContent).toContain('확인 못 함');
    expect(badges('p-unverified')).toHaveLength(1);
    expect(stats.quotes.unchecked).toBe(1);
    expect(screen.getByTestId('sp-stats').textContent).toContain('확인 못 함 1');
  });
});
