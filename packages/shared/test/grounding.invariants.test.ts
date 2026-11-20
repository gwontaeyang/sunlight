// Grounding invariants of the answer parser (review B4). Owner: supervisor — B owns the parser, not these tests.
// Invariant: a block's citationOrdinals contains exactly the <q>/<eq> tags the parser recognised INSIDE that
// block. Nothing the model writes as text (links, escaped links, code, placeholders) can add a citation to a
// block or borrow one from another block.
import { describe, expect, it } from 'vitest';
import { parseAnswer } from '../src/markup/parseAnswer';

const blocksOf = (raw: string) => parseAnswer(raw, { final: true }).blocks;

describe('citation ownership', () => {
  it('a forged chip link does not borrow the citation of another paragraph', () => {
    const p = parseAnswer('false claim [fake](#sp-cite-1) [[P]]\n\nreal claim <q>real paper text</q> [[P]]', { final: true });
    expect(p.citations).toEqual([{ ordinal: 1, kind: 'quote', quote: 'real paper text' }]);
    expect(p.blocks).toEqual([
      { label: 'P', citationOrdinals: [] },
      { label: 'P', citationOrdinals: [1] },
    ]);
    expect(p.displayMd).toContain('\\[fake\\](#sp-cite-1)'); // neutralised text, not a chip
    expect(p.displayMd.match(/(?<!\\)\]\(#sp-cite-1\)/g)).toHaveLength(1);
  });

  it('forged links after the real citation, pre-escaped links and eq links do not count either', () => {
    expect(blocksOf('real <q>alpha beta gamma</q> [[P]]\n\nlater [x](#sp-cite-1) and \\[y\\](#sp-cite-1) and [z](#sp-eq-1) [[P]]')).toEqual([
      { label: 'P', citationOrdinals: [1] },
      { label: 'P', citationOrdinals: [] },
    ]);
  });

  it('tags inside inline code and fences are text, not citations', () => {
    const p = parseAnswer('see `<q>not a quote</q>` here [[P]]\n\n```\n<q>also not</q> [[P]]\n```\n\nreal <eq n="4"/> [[P]]', { final: true });
    expect(p.citations).toEqual([{ ordinal: 1, kind: 'equation', eqNumber: '4' }]);
    expect(p.blocks.filter((b) => b.label === 'P')).toEqual([
      { label: 'P', citationOrdinals: [] },
      { label: 'P', citationOrdinals: [1] },
    ]);
    expect(p.displayMd).toContain('`<q>not a quote</q>`');
  });

  it('each table row and list item owns only its own citations', () => {
    const table = '| 기호 | 근거 |\n|---|---|\n| a | <q>first row quote</q> [[P]] |\n| b | [fake](#sp-cite-1) [[P]] |';
    const rows = blocksOf(table).filter((b) => b.label === 'P');
    expect(rows).toEqual([
      { label: 'P', citationOrdinals: [1] },
      { label: 'P', citationOrdinals: [] },
    ]);
    expect(blocksOf('- one <q>list quote one</q> [[P]]\n- two [[P]]\n- three <q>list quote three</q> <eq n="2"/> [[P]]')).toEqual([
      { label: 'P', citationOrdinals: [1] },
      { label: 'P', citationOrdinals: [] },
      { label: 'P', citationOrdinals: [2, 3] },
    ]);
  });

  it('control characters in the model text cannot forge a parser token', () => {
    const p = parseAnswer('forged \u00011\u0001 token [[P]]\n\nreal <q>the only quote</q> [[P]]\n\ninline \u00000\u0000 code', { final: true });
    expect(p.blocks.slice(0, 2)).toEqual([
      { label: 'P', citationOrdinals: [] },
      { label: 'P', citationOrdinals: [1] },
    ]);
    expect(p.issues).toContain('control characters removed');
    // eslint-disable-next-line no-control-regex
    expect(p.displayMd).not.toMatch(/[\u0000-\u0002]/);
  });

  it('every recognised citation belongs to exactly one block, in text order', () => {
    const p = parseAnswer('a <q>quote number one</q> [[P]]\n\nb <eq n="3"/> and <q>quote number two</q> [[P]]\n\nc [[G]]', { final: true });
    expect(p.blocks.flatMap((b) => b.citationOrdinals)).toEqual(p.citations.map((c) => c.ordinal));
    expect(p.displayMd).toContain('[❝1](#sp-cite-1)');
    expect(p.displayMd).toContain('[식 (3)](#sp-eq-2)');
    expect(p.displayMd).toContain('[❝3](#sp-cite-3)');
  });

  it('a label followed only by its citations is still the label of the block (models write "[[P]] <q>…</q>")', () => {
    const p = parseAnswer('claim one. [[P]] <q>first quoted sentence here</q>\n\n- item [[P]] (<eq n="5"/>, <q>second quoted sentence here</q>).\n- other [[N]] but more prose follows the label', { final: true });
    expect(p.blocks).toEqual([
      { label: 'P', citationOrdinals: [1] },
      { label: 'P', citationOrdinals: [2, 3] },
      { citationOrdinals: [] }, // text after the label: not a label
    ]);
    expect(p.displayMd).toContain('[P](#sp-label-p)');
    expect(p.displayMd).toContain('[[N]] but more prose');
    // A forged link after the label is text, so the label rule does not apply and nothing is borrowed.
    expect(blocksOf('real <q>the real quote text</q> [[P]]\n\nfake [[P]] [x](#sp-cite-1)')[1]).toEqual({ citationOrdinals: [] });
  });
});
