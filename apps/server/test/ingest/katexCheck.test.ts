// Owner A. katexCheck uses S's renderLatexSafe and never changes the stored latex; the time budget affects katexOk only
// (the supplement v2 bytes do not depend on it).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { serializeSupplementV2 } from '@study-paper/shared/contracts/supplement';
import { SEED_M2_META } from '../../src/dev/seedFixture';
import { katexCheck, katexCheckAll, KATEX_YIELD_EVERY, KATEX_YIELD_MS } from '../../src/ingest/katexCheck';
import { latexNormalize, normalizeForStore } from '../../src/ingest/latexNormalize';
import { parse, type ParsedStructure } from '../../src/ingest/latexml';
import { buildSupplementInput, type StoredLatex } from '../../src/ingest/structureStore';

/** The serializer input exactly as the pipeline builds it (it gets katexOk with the latex and must ignore it). */
const input = (p: ParsedStructure, latex: StoredLatex[]) => buildSupplementInput(p, latex, SEED_M2_META);

describe('katexCheck', () => {
  it('\\Tr (undefined in KaTeX) passes through the one \\operatorname retry; the stored latex keeps \\Tr and no \\operatorname', () => {
    const stored = latexNormalize('\\displaystyle\\Tr(\\mathbf{A})');
    expect(katexCheck(stored)).toBe(true);
    expect(stored).toBe('\\Tr(\\mathbf{A})');
    expect(stored).not.toContain('\\operatorname');
  });
  it('two different undefined commands, a recursive \\def (macro bomb) → false, and it ends', () => {
    expect(katexCheck('\\undefinedmacro{x}+\\undefinedmacrotwo{y}')).toBe(false);
    const t0 = Date.now();
    expect(katexCheck('\\def\\a{\\a\\a}\\a')).toBe(false);
    expect(katexCheck('\\def\\b{\\b x}\\b')).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
  it('the budget: what is left when it runs out is false + budgetExceeded; a yield every 20', async () => {
    let t = 0;
    const list = Array.from({ length: 50 }, (_, i) => `x_{${i}}`);
    const r = await katexCheckAll(list, { budgetMs: 25, now: () => t++ });
    expect(r.budgetExceeded).toBe(true);
    // the clock advances 1 ms per read: start = 0, item k is checked at k + 1 → items 0…23 fit in 25 ms
    expect(r.ok.indexOf(false)).toBe(24);
    expect(r.ok.slice(24).every((x) => !x)).toBe(true);
    expect(KATEX_YIELD_EVERY).toBe(20);
    expect(await katexCheckAll(list)).toEqual({ ok: list.map(() => true), budgetExceeded: false });
  });
  it('a yield also when KATEX_YIELD_MS passed since the last one: long equations do not hold the event loop for 20 of them (A-I10-01)', async () => {
    expect(KATEX_YIELD_MS).toBe(30);
    // injected clock: every read (one per equation) advances it by `step` ms, as if each equation took that long
    const run = async (n: number, step: number) => {
      let t = 0;
      let yields = 0;
      const list = Array.from({ length: n }, (_, i) => `x_{${i}}`);
      const r = await katexCheckAll(list, { budgetMs: 1e9, now: () => (t += step), yieldNow: async () => void yields++ });
      expect(r).toEqual({ ok: list.map(() => true), budgetExceeded: false }); // katexOk and the budget as before
      return yields;
    };
    expect(await run(10, 35)).toBe(9); // ≥ 30 ms per equation → a yield before every next one
    expect(await run(12, 10)).toBe(4); // 10 ms each → a yield once 30 ms have gathered (before equations 2, 5, 8, 11)
    expect(await run(45, 0)).toBe(2); // a fast clock: the count rule still yields every 20 (before 20 and 40)
  });
  it('budget 0 → every katexOk false, yet the supplement v2 bytes are the same (they never read katexOk)', async () => {
    const parsed = parse(readFileSync(new URL('../fixtures/synthetic-m2.html', import.meta.url), 'utf8'));
    const norm = parsed.equations.map((e) => normalizeForStore(e.latexRaw).latex);
    const full = await katexCheckAll(norm);
    const none = await katexCheckAll(norm, { budgetMs: 0 });
    expect(none.ok.every((x) => !x)).toBe(true);
    expect(full.ok.filter((x) => x).length).toBe(6); // 7 rows, eq 4 fails
    const withFull = norm.map((latex, i) => ({ latex, katexOk: full.ok[i]! }));
    const withNone = norm.map((latex, i) => ({ latex, katexOk: none.ok[i]! }));
    expect(withNone).not.toEqual(withFull); // the two inputs really differ in katexOk
    const a = serializeSupplementV2(input(parsed, withFull)).text;
    const b = serializeSupplementV2(input(parsed, withNone)).text;
    expect(createHash('sha256').update(b).digest('hex')).toBe(createHash('sha256').update(a).digest('hex'));
    // the pipeline-level check (budget 0 through a real import → same v2 body) is in pipeline.m2.states.test.ts
  });
});

describe('real papers (PLAN_M2 3.2 table; skipped without the fixtures)', () => {
  const FIX = `${process.env.SP_DATA_DIR ?? '/nonexistent'}/fixtures`;
  for (const [id, min, total] of [
    ['2209.15397v2', 14, 15],
    ['2107.06829v1', 18, 19],
  ] as const) {
    const file = `${FIX}/${id}.html`;
    it.skipIf(!existsSync(file))(`${id}: katexOk ≥ ${min}/${total} numbered equations; supplement v2 twice → the same sha, ≤ 120,000 chars`, async () => {
      const parsed = parse(readFileSync(file, 'utf8'));
      const numbered = parsed.equations.filter((e) => e.number !== null);
      expect(numbered).toHaveLength(total);
      const norm = parsed.equations.map((e) => normalizeForStore(e.latexRaw));
      const k = await katexCheckAll(norm.map((n) => n.latex));
      const ok = parsed.equations.filter((e, i) => e.number !== null && k.ok[i] && !norm[i]!.cut).length;
      expect(ok).toBeGreaterThanOrEqual(min);
      const latex = norm.map((n, i) => ({ latex: n.latex, katexOk: k.ok[i]! }));
      const a = serializeSupplementV2(input(parsed, latex)).text;
      const b = serializeSupplementV2(input(parse(readFileSync(file, 'utf8')), latex)).text;
      expect(createHash('sha256').update(a).digest('hex')).toBe(createHash('sha256').update(b).digest('hex'));
      expect(a.length).toBeLessThanOrEqual(120_000);
      console.log(`[katex] ${id}: katexOk ${ok}/${total}, supplement v2 ${a.length} chars`);
    });
  }
});
