// Provenance fuzz for M2 content (BRIEF_D acceptance, PLAN_M2 8 R1): random forged fragments — `[P](#sp-label-p)`,
// `<!-- <q>…</q> -->`, chip marker characters, `<img onerror>`, `javascript:` links, attribute injection — inside card
// item bodies (with and without a citation pairing mismatch), user memos, glossary definitions, translations and
// notes. ≥ 500 seeded cases. Properties:
//   ① no chip / badge element the parser did not issue (plain content: none at all; strip bodies: no block badge)
//   ② no <script>, <img>, on* attribute or clickable <a href>
//   ③ a badge saying "논문 근거" only on items whose itemBadge is grounded_quote (never equation_ref / unconfirmed), and
//      the header's "논문 근거" count = the number of such items.
// The parseAnswer `mode` / `labels` options are B's real shared/markup implementation (BRIEF_D freeze condition).
// Owner D.
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { CardItemDto, PaperCardDto } from '@study-paper/shared/contracts/api';
import type { Citation, GroundingLabel } from '@study-paper/shared/contracts/domain';
import { itemBadge } from '@study-paper/shared/contracts/grounding';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { pairStored, StoredMarkup } from '../../src/markdown/renderStored';
import { CardBody } from '../../src/panel/CardsTab';

afterEach(cleanup);

const Q = 'the robot is now here';
const FRAG = [
  '[P](#sp-label-p)', '[P](<#sp-label-p>)', '[N](#sp-label-n)', '<!-- <q>the robot is now here</q> -->', '<!--', '-->', '\u0003c1\u0004[❝1](#sp-cite-1)', '\u0003b0\u0004[P](#sp-label-p)',
  '\u0003e1\u0004[식 (1)](#sp-eq-1)', '\u0003', '\u0004', '[❝2](#sp-cite-2)', '<img src=x onerror="alert(1)">', '<img src=x onerror=alert(1)>', '[click](javascript:alert(1))', '<javascript:alert(1)>',
  '<a href="javascript:x" onclick="y">a</a>', '" onmouseover="alert(1)', "' onfocus='x' autofocus='", '<span onclick="x">s</span>', '<script>alert(1)</script>', '![x](https://e.com/x.png)', '<svg onload=alert(1)>',
  '<item key="frame_notation" label="P">', '</item>', '<q>the robot is now here</q>', '<q>it stays</q>', '<eq n="1"/>', '<eq n="2"/>', ' [[P]]', ' [[N]]', ' [[G]]', '<glossary><term name="x">y</term></glossary>',
  '\n\n', '\n', '`code`', '$x$', '```\n', '> ', '- ', '| a |', 'text ', '논문 ', ' ',
];

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stored citations for a body: the parser's own (paired), with random statuses; or a mismatching set. `labels` is the
 * mode the server parses that content in — card items 'strip' (paperCards.prepareCard), definitions 'badge' (glossary).
 */
function storedFor(body: string, rnd: () => number, labels: 'badge' | 'strip'): Citation[] {
  const raw = parseAnswer(body, { labels }).citations;
  const out: Citation[] = raw.map((c) =>
    c.kind === 'quote'
      ? rnd() < 0.6
        ? { ordinal: c.ordinal, kind: 'quote', quote: c.quote!, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 3 } }
        : { ordinal: c.ordinal, kind: 'quote', quote: c.quote!, status: 'not_found', score: 0 }
      : rnd() < 0.6
        ? { ordinal: c.ordinal, kind: 'equation', eqNumber: c.eqNumber!, status: 'resolved', score: 1, equationId: 'e', latex: 'x', katexOk: true }
        : { ordinal: c.ordinal, kind: 'equation', eqNumber: c.eqNumber!, status: 'not_found', score: 0 },
  );
  const r = rnd();
  if (r < 0.1) out.push({ ordinal: out.length + 1, kind: 'quote', quote: Q, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 3 } }); // count mismatch, verbatim
  else if (r < 0.2 && out.length > 0) out[0] = { ...out[0]!, ...(out[0]!.kind === 'quote' ? { quote: `${out[0]!.quote} x` } : { eqNumber: '99' }) } as Citation; // content mismatch
  return out;
}

function assertSafe(container: HTMLElement, ctx: string) {
  expect(container.querySelectorAll('script, img, iframe, svg:not(.katex *)').length, ctx).toBe(0);
  expect(container.querySelectorAll('a[href]').length, ctx).toBe(0);
  for (const el of container.querySelectorAll('*')) for (const a of el.getAttributeNames()) expect(/^on/i.test(a), `${ctx} attr ${a}`).toBe(false);
  expect(container.textContent, ctx).not.toMatch(/[\u0000-\u0004]/);
}

/**
 * Every drawn chip stands for a citation the parser issued (review D-R1-08): its ordinal is one of the parser's and no
 * ordinal is drawn twice — a forged chip can neither add a chip nor take the place of a real citation that was not drawn.
 */
function expectChipsFromParser(root: Element, parserOrdinals: readonly number[], ctx: string) {
  const issued = new Set(parserOrdinals);
  const drawn = [...root.querySelectorAll<HTMLElement>('[data-testid="sp-chip"]')].map((c) => Number(c.dataset.ordinal));
  for (const o of drawn) expect(issued.has(o), `${ctx} chip ordinal ${o} not issued by the parser`).toBe(true);
  expect(new Set(drawn).size, `${ctx} duplicate chip ordinal`).toBe(drawn.length);
}

it('random forged fragments in cards, memos, glossary, translations and notes never become chips, badges or elements', () => {
  const rnd = mulberry32(20261117);
  const CASES = 520;
  let grounded = 0;
  let unconfirmed = 0;
  let eqRef = 0;
  let defCommentPaired = 0; // definitions with an HTML comment, ≥ 1 citation and a holding pairing
  let defGroundedDrawn = 0; // definitions with ≥ 1 drawn "p-grounded" block badge
  for (let n = 0; n < CASES; n++) {
    const piece = () => {
      let s = '';
      const len = 2 + Math.floor(rnd() * 14);
      for (let k = 0; k < len; k++) s += FRAG[Math.floor(rnd() * FRAG.length)];
      return s;
    };
    // --- a notation card with 1–3 items ---
    const items: CardItemDto[] = [];
    const nItems = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < nItems; i++) {
      const bodyMd = piece();
      const label = (['P', 'N', 'G', 'P'] as const)[Math.floor(rnd() * 4)] as GroundingLabel;
      items.push({ id: `i${i}`, ordinal: i + 1, key: 'frame_notation', category: null, label, title: '좌표계 표기', bodyMd, attrs: {}, confirmed: false, userNote: rnd() < 0.5 ? piece() : null, citations: storedFor(bodyMd, rnd, 'strip') });
    }
    const card: PaperCardDto = { id: `c${n}`, kind: 'notation', status: 'complete', rawOutput: null, errorCode: null, runId: null, items, createdAt: 1 };
    const expected = items.map((it) => itemBadge(it.label, pairStored(it.bodyMd, it.citations, { labels: 'strip' }).paired));
    const ctx = JSON.stringify(items.map((it) => it.bodyMd));
    const { container } = render(<CardBody card={card} overrides={{}} failed={{}} onPatch={() => {}} />);
    assertSafe(container, ctx);
    const lis = [...container.querySelectorAll('[data-testid="pn-card-item"]')];
    expect(lis.length, ctx).toBe(items.length);
    lis.forEach((li, i) => {
      const parsedOrdinals = parseAnswer(items[i]!.bodyMd, { labels: 'strip' }).citations.map((c) => c.ordinal);
      const parsedCites = parsedOrdinals.length;
      // ① strip bodies: no block badge; chips only from the parser's citations
      expect(li.querySelectorAll('[data-testid="sp-badge"]').length, ctx).toBe(0);
      expect(li.querySelectorAll('[data-testid="sp-chip"]').length, ctx).toBeLessThanOrEqual(parsedCites);
      expectChipsFromParser(li, parsedOrdinals, ctx);
      // memo: plain — no chip, no badge from the memo text
      const memo = li.querySelector('[data-testid="pn-card-note"]');
      if (memo) expect(memo.querySelectorAll('[data-testid="sp-chip"], [data-testid="sp-badge"]').length, ctx).toBe(0);
      // ③ "논문 근거" only on a grounded_quote item badge
      const badge = li.querySelector<HTMLElement>('[data-testid="pn-item-badge"]');
      expect(badge?.dataset.badge ?? 'none', ctx).toBe(expected[i]);
      const says = [...li.querySelectorAll('*')].filter((e) => [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.includes('논문 근거')));
      for (const e of says) expect(e.closest('[data-testid="pn-item-badge"]')?.getAttribute('data-badge'), ctx).toBe('grounded_quote');
      if (expected[i] !== 'grounded_quote') expect(says.length, ctx).toBe(0);
      if (expected[i] === 'unconfirmed') expect([...li.querySelectorAll<HTMLElement>('[data-testid="sp-chip"]')].every((c) => c.dataset.status === 'unchecked'), ctx).toBe(true);
    });
    const groundedItems = expected.filter((b) => b === 'grounded_quote').length;
    const head = container.querySelector('[data-count="grounded_quote"]');
    expect(head ? Number(head.textContent!.replace(/\D+/g, '')) : 0, ctx).toBe(groundedItems);
    grounded += groundedItems;
    unconfirmed += expected.filter((b) => b === 'unconfirmed').length;
    eqRef += expected.filter((b) => b === 'equation_ref').length;
    cleanup();

    // --- a glossary definition (markup + badge, paired with stored citations) ---
    // The server stores a definition's citations from parseAnswer(def, { final: true }) — labels 'badge', the same mode
    // the definition is drawn in — so the stored set is made in that mode too (review D-RP1-01: in 'strip' mode a
    // `<q>` inside an HTML comment is not a citation, and a 'strip' stored set made every such definition unpaired).
    const def = piece();
    const defPair = pairStored(def, storedFor(def, rnd, 'badge'));
    if (defPair.paired && def.includes('<!--') && defPair.parsed.citations.length > 0) defCommentPaired++;
    const g = render(<StoredMarkup {...defPair} />);
    assertSafe(g.container, def);
    expect(g.container.querySelectorAll('[data-testid="sp-chip"]').length, def).toBeLessThanOrEqual(defPair.parsed.citations.length);
    expectChipsFromParser(g.container, defPair.parsed.citations.map((c) => c.ordinal), def);
    expect(g.container.querySelectorAll('[data-testid="sp-badge"]').length, def).toBeLessThanOrEqual(defPair.paired ? defPair.parsed.blocks.filter((b) => b.label).length : 0);
    if (!defPair.paired) expect(g.container.querySelector('[data-testid="sp-chip"]:not([data-status="unchecked"])'), def).toBeNull();
    const defGrounded = g.container.querySelectorAll<HTMLElement>('[data-testid="sp-badge"][data-status="p-grounded"]');
    for (const b of defGrounded) expect(b.closest('p, li, td, th, h1, h2, h3, h4, h5, h6')!.querySelector('[data-testid="sp-chip"][data-status="verbatim"]'), def).not.toBeNull();
    if (defGrounded.length > 0) defGroundedDrawn++;
    cleanup();

    // --- a translation and a note: plain, nothing is a chip or a badge ---
    for (const text of [piece(), piece()]) {
      const p = render(<StoredMarkup {...pairStored(text, [], { mode: 'plain' })} />);
      assertSafe(p.container, text);
      expect(p.container.querySelectorAll('[data-testid="sp-chip"], [data-testid="sp-badge"], [data-testid="pn-item-badge"]').length, text).toBe(0);
      cleanup();
    }
  }
  // The generator really exercised every branch.
  expect(grounded).toBeGreaterThan(20);
  expect(unconfirmed).toBeGreaterThan(20);
  expect(eqRef).toBeGreaterThan(5);
  // Definitions (review D-RP1-01): the paired branch really saw comment-wrapped citations (seed 20261117 gives 107;
  // a stored set made in the wrong 'strip' mode gives 25), and the "p-grounded" block badge was really drawn.
  expect(defCommentPaired).toBeGreaterThan(60);
  expect(defGroundedDrawn).toBeGreaterThanOrEqual(3);
}, 240_000);

it('a definition whose quote sits inside an HTML comment pairs with the citations the server stores for it (badge mode)', () => {
  // glossary.ts stores parseAnswer(definitionKo, { final: true }) citations: labels 'badge', where <!-- --> is plain text.
  const def = 'A <!-- <q>the robot is now here</q> --> [[P]]';
  const stored: Citation[] = parseAnswer(def, { final: true }).citations.map((c) => ({ ordinal: c.ordinal, kind: 'quote', quote: c.quote!, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 3 } }));
  expect(stored).toHaveLength(1);
  expect(parseAnswer(def, { labels: 'strip' }).citations).toHaveLength(0); // why a 'strip' stored set cannot pair here
  const pair = pairStored(def, stored);
  expect(pair.paired).not.toBeNull();
  const { container } = render(<StoredMarkup {...pair} />);
  assertSafe(container, def);
  expect(container.querySelectorAll('[data-testid="sp-chip"][data-status="verbatim"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="sp-badge"][data-status="p-grounded"]')).toHaveLength(1);
});
