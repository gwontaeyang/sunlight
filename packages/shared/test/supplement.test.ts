// supplement v2 serializer properties (BRIEF_S S4, PLAN_M2 3.1). Owner: supervisor. The golden bytes are checked in
// apps/server/test/contract/supplement.format.test.ts.
import { describe, expect, it } from 'vitest';
import { serializeSupplementV2, SUPPLEMENT_CAPS, type SupplementIndexInput } from '../src/contracts/supplement';

const META: SupplementIndexInput['meta'] = { title: 'T', authors: ['A'], arxivId: '2301.00009', arxivVersion: 1, year: 2023, primaryCategory: 'cs.RO' };
const empty = (o: Partial<SupplementIndexInput> = {}): SupplementIndexInput => ({ meta: META, sections: [], equations: [], figures: [], references: [], ...o });
const C = SUPPLEMENT_CAPS;

describe('serializeSupplementV2', () => {
  it('empty structure: every block is present and empty; same input → same bytes', () => {
    const a = serializeSupplementV2(empty());
    expect(a).toEqual(serializeSupplementV2(empty()));
    expect(a.truncated).toBe(false);
    expect(a.text).toBe(
      ['<paper_index v="2">', '<metadata>', 'title: T', 'authors: A', 'arxiv: 2301.00009v1', 'year: 2023', 'category: cs.RO', '</metadata>', '<sections>', '</sections>', '<equations>', '</equations>', '<figures>', '</figures>', '<references>', '</references>', '</paper_index>', ''].join('\n'),
    );
  });

  it('line forms, "-" for nulls, escaping of & < > and collapsing of newlines/whitespace', () => {
    const r = serializeSupplementV2(
      empty({
        meta: { ...META, title: ' A <b>&</b>\nTitle ', year: null, primaryCategory: null },
        sections: [{ htmlId: 'S1', number: 'I', title: 'Intro\n  duction' }, { htmlId: null, number: null, title: 'x < y' }],
        equations: [{ number: '1', sectionNumber: 'I', latex: 'a<b \\\\\n c&d' }, { number: 'A.1', sectionNumber: null, latex: 'x' }],
        figures: [{ kind: 'figure', number: '1', caption: 'Cap & tion' }, { kind: 'table', number: null, caption: 't' }],
        references: [{ label: '[1]', rawText: 'R  one' }, { label: null, rawText: '<two>' }],
      }),
    );
    expect(r.truncated).toBe(false);
    const lines = r.text.split('\n');
    expect(lines).toContain('title: A &lt;b&gt;&amp;&lt;/b&gt; Title');
    expect(lines).toContain('year: unknown');
    expect(lines).toContain('category: unknown');
    expect(lines).toContain('S1 | I | Intro duction');
    expect(lines).toContain('- | - | x &lt; y');
    expect(lines).toContain('(1) | I | a&lt;b \\\\ c&amp;d');
    expect(lines).toContain('(A.1) | - | x');
    expect(lines).toContain('Figure 1 | Cap &amp; tion');
    expect(lines).toContain('Table | t');
    expect(lines).toContain('[1] R one');
    expect(lines).toContain('- &lt;two&gt;');
  });

  it('value caps count characters before escaping and end a cut value with "…"', () => {
    const r = serializeSupplementV2(empty({ sections: [{ htmlId: 'S1', number: '1', title: '&'.repeat(C.sectionTitleChars + 5) }] }));
    expect(r.truncated).toBe(true);
    const line = r.text.split('\n').find((l) => l.startsWith('S1 | 1 | '))!;
    const value = line.slice('S1 | 1 | '.length);
    expect(value.endsWith('…')).toBe(true);
    expect(value.replace(/&amp;/g, '&').length).toBe(C.sectionTitleChars);
    // a value of exactly the cap is not cut
    expect(serializeSupplementV2(empty({ sections: [{ htmlId: 'S1', number: '1', title: 'x'.repeat(C.sectionTitleChars) }] })).truncated).toBe(false);
  });

  it('never splits a surrogate pair when cutting', () => {
    const r = serializeSupplementV2(empty({ references: [{ label: '[1]', rawText: 'a' + '😀'.repeat(C.referenceChars) }] }));
    expect(r.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(r.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('count caps drop from the end and leave a <truncated> line in that block', () => {
    const r = serializeSupplementV2(empty({ figures: Array.from({ length: C.figures + 3 }, (_, i) => ({ kind: 'figure' as const, number: String(i + 1), caption: 'c' })) }));
    expect(r.truncated).toBe(true);
    expect(r.text).toContain(`Figure ${C.figures} | c\n<truncated kind="figures" dropped="3"/>\n</figures>`);
    expect(r.text).not.toContain(`Figure ${C.figures + 1} |`);
  });

  it('equations alone over totalChars (400 × 2,000 chars): output ≤ cap, sections kept, equations cut from the end, later kinds dropped', () => {
    const r = serializeSupplementV2(
      empty({
        sections: [{ htmlId: 'S1', number: 'I', title: 'Intro' }],
        equations: Array.from({ length: 400 }, (_, i) => ({ number: String(i + 1), sectionNumber: 'I', latex: 'x'.repeat(2000) })),
        figures: [{ kind: 'figure', number: '1', caption: 'c' }],
        references: [{ label: '[1]', rawText: 'r' }],
      }),
    );
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(C.totalChars);
    expect(r.text).toContain('S1 | I | Intro');
    expect(r.text).toContain('(1) | I | ');
    expect(r.text).not.toContain('(400) | I | ');
    expect(r.text).toMatch(/<truncated kind="equations" dropped="\d+"\/>\n<\/equations>/);
    expect(r.text).toContain('<truncated kind="figures" dropped="1"/>');
    expect(r.text).toContain('<truncated kind="references" dropped="1"/>');
    expect(r.text).not.toContain('<truncated kind="sections"');
  });

  it('metadata alone over totalChars (title 200,000 chars, 5,000 authors, all "&"): output ≤ cap, metadata keeps its 5-line form', () => {
    const r = serializeSupplementV2({
      meta: { title: '&'.repeat(200_000), authors: Array.from({ length: 5000 }, () => '&'.repeat(300)), arxivId: '&'.repeat(1000), arxivVersion: 3, year: 2020, primaryCategory: '&'.repeat(1000) },
      sections: [],
      equations: [],
      figures: [],
      references: [],
    });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(C.totalChars);
    const meta = r.text.split('\n').slice(1, 8);
    expect(meta[0]).toBe('<metadata>');
    expect(meta.slice(1, 6).map((l) => l.split(':')[0])).toEqual(['title', 'authors', 'arxiv', 'year', 'category']);
    expect(meta[6]).toBe('</metadata>');
    expect(meta[2]!.endsWith(' … (+4900)')).toBe(true);
    expect(meta[3]!.endsWith('…v3')).toBe(true);
  });

  it('worst case of everything at once stays ≤ totalChars and never throws', () => {
    const amp = (n: number) => '&'.repeat(n);
    const r = serializeSupplementV2({
      meta: { title: amp(1e5), authors: Array.from({ length: 3000 }, () => amp(500)), arxivId: amp(500), arxivVersion: Number.NaN, year: Number.POSITIVE_INFINITY, primaryCategory: amp(500) },
      sections: Array.from({ length: 2000 }, () => ({ htmlId: amp(400), number: amp(400), title: amp(400) })),
      equations: Array.from({ length: 2000 }, () => ({ number: amp(400), sectionNumber: amp(400), latex: amp(4000) })),
      figures: Array.from({ length: 2000 }, () => ({ kind: 'table' as const, number: amp(400), caption: amp(1000) })),
      references: Array.from({ length: 2000 }, () => ({ label: amp(400), rawText: amp(1000) })),
    });
    expect(r.text.length).toBeLessThanOrEqual(C.totalChars);
    expect(r.truncated).toBe(true);
    for (const k of ['sections', 'equations', 'figures', 'references']) expect(r.text).toContain(`<${k}>`);
  });

  it('boundary: a text of exactly totalChars is kept whole; one more character truncates and stays ≤ totalChars', () => {
    const lengthWith = (refs: SupplementIndexInput['references']) => serializeSupplementV2(empty({ references: refs })).text.length;
    // fill with 390-char references, then size the last one so the whole text is exactly totalChars
    const refs: SupplementIndexInput['references'] = [];
    let base = lengthWith(refs);
    for (;;) {
      const label = `[${refs.length + 1}]`;
      const next = label.length + 1 + 390 + 1;
      if (base + next > C.totalChars - 300 || refs.length >= C.references - 1) break;
      refs.push({ label, rawText: 'r'.repeat(390) });
      base += next;
    }
    expect(lengthWith(refs)).toBe(base); // nothing was cut so far
    const lastLabel = `[${refs.length + 1}]`;
    const fill = C.totalChars - base - (lastLabel.length + 1 + 1); // "<label> " + raw + "\n"
    expect(fill).toBeGreaterThan(0);
    expect(fill).toBeLessThanOrEqual(C.referenceChars);
    const exact = serializeSupplementV2(empty({ references: [...refs, { label: lastLabel, rawText: 'r'.repeat(fill) }] }));
    expect(exact.text.length).toBe(C.totalChars);
    expect(exact.truncated).toBe(false);
    const over = serializeSupplementV2(empty({ references: [...refs, { label: lastLabel, rawText: 'r'.repeat(fill + 1) }] }));
    expect(over.truncated).toBe(true);
    expect(over.text.length).toBeLessThanOrEqual(C.totalChars);
    expect(over.text).toContain('<truncated kind="references" dropped=');
    const under = serializeSupplementV2(empty({ references: [...refs, { label: lastLabel, rawText: 'r'.repeat(fill - 1) }] }));
    expect(under.text.length).toBe(C.totalChars - 1);
    expect(under.truncated).toBe(false);
  });
});
