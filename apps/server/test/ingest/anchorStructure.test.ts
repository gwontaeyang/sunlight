// Owner A. anchorStructure (PLAN_M2 3.2): the synthetic PDFs (M2 and the M1 one an upgrade sees), the rule's negative
// cases with the synthetic page texts t1–t6 of 05_m2/plan_probes/anchor5.mts, the budget, the known limit, and the
// real papers against the adjudicated gold (structure-gold.json; skipped without the fixtures).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { anchorStructure, isProse, prefixForms, type AnchorEquationIn, type AnchorPage, type AnchorResult, type AnchorSectionIn } from '../../src/ingest/anchorStructure';
import { parse, type ParsedStructure } from '../../src/ingest/latexml';
import { extractPageTexts } from '../../src/ingest/pdfText';
import { startTestServer, type TestServer } from '../helpers/server';

const FIXTURES = new URL('../fixtures/', import.meta.url);
const SYN_HTML = readFileSync(new URL('synthetic-m2.html', FIXTURES), 'utf8');
async function pagesOf(pdf: Buffer): Promise<AnchorPage[]> {
  const ex = await extractPageTexts(new Uint8Array(pdf));
  return ex.pages.map((p) => ({ page: p.page, text: p.text, items: p.items }));
}
const run = (s: ParsedStructure, pages: AnchorPage[], work?: number) => anchorStructure(s.sections, s.equations, s.figures, pages, work === undefined ? {} : { work });
const byNumber = (s: ParsedStructure, r: AnchorResult, kind: 'sections' | 'equations', n: string) => r[kind].filter((_, i) => s[kind][i]!.number === n);
const one = (text: string): AnchorPage[] => [{ page: 1, text, items: [] }];
const eqs = (...e: [string, string?][]): AnchorEquationIn[] => e.map(([number, ctx]) => ({ number, contextBefore: ctx ?? null, sectionIndex: null }));
const NO_SECTIONS: AnchorSectionIn[] = [];

describe('synthetic-m2.html on synthetic-m2.pdf and on the M1 synthetic.pdf', () => {
  const parsed = parse(SYN_HTML);
  const servers: TestServer[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  it('M2 PDF: I, II, II-A ("A. Robust Kernel", not the lower-case body words), (1), (2), the figure on page 1; II-B, the table, 3, 4, A.1 → null; equal to the SEED_M2 seed', async () => {
    const pages = await pagesOf(readFileSync(new URL('synthetic-m2.pdf', FIXTURES)));
    const r = await run(parsed, pages);
    const page = (kind: 'sections' | 'equations', n: string) => byNumber(parsed, r, kind, n).map((x) => x?.page ?? null);
    expect([page('sections', 'I'), page('sections', 'II'), page('sections', 'II-A'), page('sections', 'II-B')]).toEqual([[1], [2], [2], [null]]);
    const iiA = byNumber(parsed, r, 'sections', 'II-A')[0]!;
    const p2 = pages.find((p) => p.page === 2)!.text;
    expect(p2.slice(iiA.start, iiA.start + 'Robust Kernel'.length)).toBe('Robust Kernel');
    expect(p2.slice(p2.lastIndexOf('\n', iiA.start - 1) + 1, iiA.start)).toBe('A. ');
    expect([page('equations', '1'), page('equations', '2'), page('equations', '3'), page('equations', '4'), page('equations', 'A.1')]).toEqual([[1], [2], [null], [null], [null, null]]);
    expect(r.figures).toEqual([1, null]);
    expect(r.budgetExhausted).toBe(false);
    expect(r.orderViolations).toBe(0);

    // The seed's positions (computed by S at seed time from the same PDF) are the same rows.
    const s = await startTestServer({ env: 'test', papers: ['links', 'm2'] });
    servers.push(s);
    const q = <T>(sql: string) => s.deps.sqlite.prepare(sql).all(SEED_M2_PAPER_ID) as T[];
    const secRows = q<{ htmlId: string; pdfPage: number | null; pdfOffset: number | null; pdfRectJson: string | null }>(`SELECT htmlId, pdfPage, pdfOffset, pdfRectJson FROM sections WHERE paperId = ? ORDER BY ordinal`);
    expect(secRows).toEqual(parsed.sections.map((x, i) => ({ htmlId: x.htmlId, pdfPage: r.sections[i]?.page ?? null, pdfOffset: r.sections[i]?.start ?? null, pdfRectJson: r.sections[i]?.rect ? JSON.stringify(r.sections[i]!.rect) : null })));
    const eqRows = q<{ htmlId: string; pdfPage: number | null; pdfOffset: number | null; pdfRectJson: string | null }>(`SELECT htmlId, pdfPage, pdfOffset, pdfRectJson FROM equations WHERE paperId = ? ORDER BY ordinal`);
    expect(eqRows).toEqual(parsed.equations.map((x, i) => ({ htmlId: x.htmlId, pdfPage: r.equations[i]?.page ?? null, pdfOffset: r.equations[i]?.start ?? null, pdfRectJson: r.equations[i]?.rect ? JSON.stringify(r.equations[i]!.rect) : null })));
    const figRows = q<{ htmlId: string; pdfPage: number | null }>(`SELECT htmlId, pdfPage FROM figures WHERE paperId = ? ORDER BY rowid`);
    expect(figRows).toEqual(parsed.figures.map((f, i) => ({ htmlId: f.htmlId, pdfPage: r.figures[i] ?? null })));
  });

  it('M1 PDF (the upgrade target): only I, II, (1), (2) — II-A, II-B and the figure are null', async () => {
    const r = await run(parsed, await pagesOf(readFileSync(new URL('synthetic.pdf', FIXTURES))));
    expect(parsed.sections.map((x, i) => [x.number, r.sections[i]?.page ?? null])).toEqual([
      ['I', 1],
      ['II', 2],
      ['II-A', null],
      ['II-B', null],
    ]);
    expect(parsed.equations.map((x, i) => [x.number, r.equations[i]?.page ?? null])).toEqual([
      ['1', 1],
      ['2', 2],
      ['3', null],
      ['4', null],
      [null, null],
      ['A.1', null],
      ['A.1', null],
    ]);
    expect(r.figures).toEqual([null, null]);
  });
});

describe('section rule', () => {
  it('prefix forms: number, number., and the IEEE last component (III-A → A. / A), IV-A1 → 1. / 1))', () => {
    expect(prefixForms(null)).toEqual(['']);
    expect(prefixForms('III')).toEqual(['III', 'III.']);
    expect(prefixForms('III-A')).toEqual(['III-A', 'III-A.', 'A.', 'A)']);
    expect(prefixForms('IV-A1')).toEqual(['IV-A1', 'IV-A1.', '1.', '1)']);
  });
  it('a title that also occurs in the body: only the line-head hit', async () => {
    const t = 'Intro.\nI. ROBUST KERNEL\nThe Robust Kernel is used here.\nRobust Kernel helps more.\n';
    const r = await anchorStructure([{ number: 'I', title: 'Robust Kernel' }], [], [], one(t));
    expect(r.sections[0]?.start).toBe(t.indexOf('ROBUST KERNEL'));
  });
  it('the title alone on a line WITHOUT its number (figure text) is never taken for a numbered section', async () => {
    const t = 'Fig. 2\nSystem Overview\nmore figure text\n';
    const r = await anchorStructure([{ number: 'III', title: 'System Overview' }], [], [], one(t));
    expect(r.sections[0]).toBeNull();
    const t2 = `${t}III. SYSTEM OVERVIEW\nbody\n`;
    expect((await anchorStructure([{ number: 'III', title: 'System Overview' }], [], [], one(t2))).sections[0]?.start).toBe(t2.indexOf('SYSTEM OVERVIEW'));
  });
  it('a run-in heading "1) Propagation: Assume…" (line tail starts with ":") is a line-head hit', async () => {
    const t = 'text\n1) Propagation: Assume the state is known.\n';
    expect((await anchorStructure([{ number: 'IV-B1', title: 'Propagation' }], [], [], one(t))).sections[0]?.start).toBe(t.indexOf('Propagation'));
  });
  it('the same heading twice: the order window decides when the neighbours are anchored, otherwise null', async () => {
    const t = 'A. Setup\nbody\nB. Results\nmore\nA. Setup\nx\nC. Discussion\n';
    const secs: AnchorSectionIn[] = [
      { number: 'II-B', title: 'Results' },
      { number: 'II-A', title: 'Setup' },
      { number: 'II-C', title: 'Discussion' },
    ];
    const r = await anchorStructure(secs, [], [], one(t));
    expect(r.sections.map((x) => x?.start ?? null)).toEqual([t.indexOf('Results'), t.lastIndexOf('Setup'), t.indexOf('Discussion')]);
    expect(r.sectionStages).toEqual(['s1', 's2', 's1']);
    const lonely = await anchorStructure([{ number: 'II-A', title: 'Setup' }], [], [], one(t));
    expect(lonely.sections[0]).toBeNull();
  });
  it('an order violation (unique hits in the wrong document order) → both null', async () => {
    const t = 'II. METHOD\nbody\nI. INTRODUCTION\n';
    const r = await anchorStructure([{ number: 'I', title: 'Introduction' }, { number: 'II', title: 'Method' }], [], [], one(t));
    expect(r.sections).toEqual([null, null]);
    expect(r.orderViolations).toBe(1);
  });
});

// The synthetic inputs of anchor5.mts, unchanged.
const ctxA = 'the voxel occupancy is then defined as follows';
const t1 = `Intro text.\n${ctxA}\nf(x) = the average number of points inside each voxel (1)\nSome more words here.\nSee (1)\nnext line\ng(x) = 2 (2)\n`;
const t2 = `Intro.\nas defined by the continuous kinematic model in (1)\n${ctxA}\nx = a + b (1)\ntail text\ny = c (2)\n`;
const t3 = `Intro.\nx = a + b (1) ,\nwhich follows from the continuous kinematic model in (1)\n`;
const t4 = `Intro.\nx = a + b (1)\nwe refer to (1) in the text below.\n`;
const t6 = `Intro.\nSee (1)\n${ctxA}\nx = a + b (1) ,\nmore text\n`;
const t5 = `Intro.\nx = a + b (1) ,\nSee (1)\n`;
const starts = (r: AnchorResult) => r.equations.map((x) => x?.start ?? null);

describe('equation rule (anchor5.mts synthetic cases)', () => {
  it('prose filter: ≥ 5 lower-case words of ≥ 3 letters before the hit', () => {
    expect(isProse('as defined by the continuous kinematic model in ')).toBe(true);
    expect(isProse('x = a + b ')).toBe(false);
  });
  it('Codex M1: the real line reads as prose (\\text{…}) + a short line-end "See (1)" → null without context, null with context', async () => {
    expect(starts(await anchorStructure(NO_SECTIONS, eqs(['1'], ['2']), [], one(t1)))).toEqual([null, t1.indexOf('(2)')]);
    expect(starts(await anchorStructure(NO_SECTIONS, eqs(['1', ctxA], ['2']), [], one(t1)))).toEqual([null, t1.indexOf('(2)')]);
  });
  it('a prose body reference at a line end before the real tag: context → the real tag (stage 2); no context → null', async () => {
    const r = await anchorStructure(NO_SECTIONS, eqs(['1', ctxA], ['2']), [], one(t2));
    expect(starts(r)).toEqual([t2.indexOf('(1)', t2.indexOf('x = a')), t2.indexOf('(2)')]);
    expect(r.equationStages[0]).toBe('s2');
    expect(starts(await anchorStructure(NO_SECTIONS, eqs(['1'], ['2']), [], one(t2)))).toEqual([null, t2.indexOf('(2)')]);
  });
  it('the real tag not at a line end and only a prose reference at a line end → null', async () => {
    expect(starts(await anchorStructure(NO_SECTIONS, eqs(['1']), [], one(t3)))).toEqual([null]);
  });
  it('a unique line-end tag → stage 1', async () => {
    const r = await anchorStructure(NO_SECTIONS, eqs(['1']), [], one(t4));
    expect(starts(r)).toEqual([t4.indexOf('(1)')]);
    expect(r.equationStages).toEqual(['s1']);
  });
  it('a short line-end reference BEFORE the located context, the real tag not at a line end → null', async () => {
    expect(starts(await anchorStructure(NO_SECTIONS, eqs(['1', ctxA]), [], one(t6)))).toEqual([null]);
  });
  it('known limit: the real tag not at a line end + ONE short non-prose "See (1)" after it → stage 1 confirms the reference line (current behaviour, fixed by this test)', async () => {
    // Not an accuracy criterion: PLAN_M2 3.2 "남는 한계". If a rule change alters this, report it — do not silently update.
    const r = await anchorStructure(NO_SECTIONS, eqs(['1']), [], one(t5));
    expect(starts(r)).toEqual([t5.indexOf('(1)', t5.indexOf('See'))]);
  });
  it('an equation before its section page → null; budget 0 → everything null + budget flag', async () => {
    const pages: AnchorPage[] = [
      { page: 1, text: 'x = y (1)\n', items: [] },
      { page: 2, text: 'I. INTRODUCTION\n', items: [] },
    ];
    const r = await anchorStructure([{ number: 'I', title: 'Introduction' }], [{ number: '1', contextBefore: null, sectionIndex: 0 }], [], pages);
    expect(r.sections[0]?.page).toBe(2);
    expect(r.equations).toEqual([null]);
    const parsed = parse(SYN_HTML);
    const zero = await run(parsed, await pagesOf(readFileSync(new URL('synthetic-m2.pdf', FIXTURES))), 0);
    expect(zero.sections.every((x) => x === null) && zero.equations.every((x) => x === null) && zero.figures.every((x) => x === null)).toBe(true);
    expect(zero.budgetExhausted).toBe(true);
  });
});

describe('real papers against the adjudicated gold (skipped without the fixtures)', () => {
  const FIX = join(process.env.SP_DATA_DIR ?? '/nonexistent', 'fixtures');
  const gold = JSON.parse(readFileSync(new URL('structure-gold.json', FIXTURES), 'utf8')) as Record<string, { sections: { htmlId: string; page: number; start: number }[]; equations: { htmlId: string; page: number; start: number }[] }>;
  const cases: [string, { sections: number; equations: number; s1: number; s2: number }][] = [
    ['2209.15397v2', { sections: 18, equations: 14, s1: 15, s2: 0 }],
    ['2107.06829v1', { sections: 46, equations: 17, s1: 17, s2: 2 }],
  ];
  for (const [id, min] of cases) {
    const ok = existsSync(join(FIX, `${id}.html`)) && existsSync(join(FIX, `${id}.pdf`));
    it.skipIf(!ok)(`${id}: sections ≥ ${min.sections}, equations ≥ ${min.equations} equal to gold (page, start); 0 mismatches, 0 order violations`, async () => {
      const s = parse(readFileSync(join(FIX, `${id}.html`), 'utf8'));
      const r = await run(s, await pagesOf(readFileSync(join(FIX, `${id}.pdf`))));
      const score = (kind: 'sections' | 'equations') => {
        const g = new Map(gold[id]![kind].map((x) => [x.htmlId, x]));
        let match = 0;
        let nul = 0;
        const wrong: string[] = [];
        s[kind].forEach((item, i) => {
          if (kind === 'equations' && (item as { number: string | null }).number === null) return;
          const want = g.get(item.htmlId!);
          const got = r[kind][i];
          if (!got) nul++;
          else if (want && got.page === want.page && got.start === want.start) match++;
          else wrong.push(`${item.htmlId} ${got.page}:${got.start}`);
        });
        return { match, nul, wrong };
      };
      const sec = score('sections');
      const eq = score('equations');
      expect(sec.wrong).toEqual([]);
      expect(eq.wrong).toEqual([]);
      expect(sec.match).toBeGreaterThanOrEqual(min.sections);
      expect(eq.match).toBeGreaterThanOrEqual(min.equations);
      expect(r.orderViolations).toBe(0);
      const numbered = r.equationStages.filter((_, i) => s.equations[i]!.number !== null);
      // measured (probe anchor5.mts vs gold): KISS-ICP 15 = s1 15; FAST-LIO2 19 = s1 17 + s2 2
      expect({ s1: numbered.filter((x) => x === 's1').length, s2: numbered.filter((x) => x === 's2').length }).toEqual({ s1: min.s1, s2: min.s2 });
      console.log(`[anchor gold] ${id}: sections match ${sec.match}/${s.sections.length} null ${sec.nul} mismatch ${sec.wrong.length}; equations match ${eq.match} null ${eq.nul} mismatch ${eq.wrong.length}; stages ${JSON.stringify({ s1: min.s1, s2: min.s2 })}`);
    }, 60_000);
  }
});
