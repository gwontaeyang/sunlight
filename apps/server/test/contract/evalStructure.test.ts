// compareWithGold / checkNumberSequence (BRIEF_INTEGRATION I5) on a synthetic gold. Owner: supervisor.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkNumberSequence, compareWithGold, summaryLine, type GoldItem, type ParserItem } from '../../../../scripts/lib/structureEval';
import { REPO_ROOT, runProbe } from '../helpers/proc';
import { tempDir } from '../helpers/tmp';

import { structureOf } from '../../../../scripts/lib/evalStructureInput';
import { prepareStoredEquations } from '../../src/ingest/katexCheck';
import { startTestServer } from '../helpers/server';
import { freshId, importAndWait } from '../ingest/helpers';
import { offlineDir, SYN_M2_HTML, SYN_M2_PDF } from '../ingest/m2helpers';
import { katexCheckAll } from '../../src/ingest/katexCheck';
import { normalizeForStore } from '../../src/ingest/latexNormalize';

const g = (htmlId: string, page: number, start: number, number: string | null = null): GoldItem => ({ htmlId, number, page, start });
const p = (htmlId: string | null, pos: [number, number] | null, number: string | null = null): ParserItem => ({ htmlId, number, pos: pos ? { page: pos[0], start: pos[1] } : null });
const SEC_GOLD = [g('S1', 1, 100), g('S2', 1, 900), g('S3', 2, 50)];

describe('compareWithGold', () => {
  it('equal (page, start) → matched; nothing else counted', () => {
    const r = compareWithGold('sections', SEC_GOLD, [p('S1', [1, 100]), p('S2', [1, 900]), p('S3', [2, 50])]);
    expect(r).toMatchObject({ gold: 3, matched: 3, null: 0, mismatched: 0, extra: 0, missing: 0, orderViolations: 0 });
  });

  it('start off by 1 → mismatched (not matched), with the gold and the actual position', () => {
    const r = compareWithGold('sections', SEC_GOLD, [p('S1', [1, 100]), p('S2', [1, 901]), p('S3', [2, 50])]);
    expect(r).toMatchObject({ matched: 2, mismatched: 1, null: 0 });
    expect(r.mismatchedItems).toEqual([{ htmlId: 'S2', number: null, gold: { page: 1, start: 900 }, actual: { page: 1, start: 901 } }]);
  });

  it('same start on another page → mismatched', () => {
    const r = compareWithGold('sections', SEC_GOLD, [p('S1', [2, 100]), p('S2', [2, 900]), p('S3', [3, 50])]);
    expect(r).toMatchObject({ matched: 0, mismatched: 3 });
  });

  it('no position → null (not mismatched)', () => {
    const r = compareWithGold('sections', SEC_GOLD, [p('S1', [1, 100]), p('S2', null), p('S3', [2, 50])]);
    expect(r).toMatchObject({ matched: 2, null: 1, mismatched: 0 });
    expect(r.nullItems).toEqual([{ htmlId: 'S2', number: null, gold: { page: 1, start: 900 }, actual: null }]);
  });

  it('a confirmed item the gold does not have → extra; an unconfirmed one is not counted', () => {
    const r = compareWithGold('sections', SEC_GOLD, [p('S1', [1, 100]), p('S1.SS1', [1, 500]), p('S1.SS2', null), p('S2', [1, 900]), p('S3', [2, 50])]);
    expect(r).toMatchObject({ matched: 3, extra: 1, missing: 0 });
    expect(r.extraItems.map((x) => x.htmlId)).toEqual(['S1.SS1']);
  });

  it('a gold item the parser does not have → missing', () => {
    const r = compareWithGold('sections', SEC_GOLD, [p('S1', [1, 100]), p('S3', [2, 50])]);
    expect(r).toMatchObject({ matched: 2, missing: 1 });
    expect(r.missingItems).toEqual([{ htmlId: 'S2', number: null, gold: { page: 1, start: 900 }, actual: null }]);
  });

  it('a second parser item with an already used key → extra (one gold item is matched once)', () => {
    const r = compareWithGold('sections', SEC_GOLD, [p('S1', [1, 100]), p('S1', [1, 100]), p('S2', [1, 900]), p('S3', [2, 50])]);
    expect(r).toMatchObject({ matched: 3, extra: 1 });
  });

  it('order: confirmed positions must strictly increase in document order (nulls skipped)', () => {
    // S2 and S3 swapped on the page: each matches its gold but the order breaks once.
    const gold = [g('S1', 1, 100), g('S2', 1, 900), g('S3', 1, 500)];
    const r = compareWithGold('sections', gold, [p('S1', [1, 100]), p('S2', [1, 900]), p('S3', [1, 500])]);
    expect(r).toMatchObject({ matched: 3, orderViolations: 1 });
    expect(r.orderViolationPairs.map((x) => [x.before.htmlId, x.after.htmlId])).toEqual([['S2', 'S3']]);
    // equal positions are a violation too; a null in between does not reset the comparison
    const r2 = compareWithGold('sections', SEC_GOLD, [p('S1', [1, 100]), p('S2', null), p('S3', [1, 100])]);
    expect(r2.orderViolations).toBe(1);
    expect(compareWithGold('sections', SEC_GOLD, [p('S1', [1, 100]), p('S2', null), p('S3', [2, 50])]).orderViolations).toBe(0);
  });

  it('equations are keyed by number AND htmlId: the right htmlId with another number is not a gold item', () => {
    const gold = [g('S3.E1', 3, 10, '1'), g('S3.E2', 3, 80, '2')];
    const r = compareWithGold('equations', gold, [p('S3.E1', [3, 10], '1'), p('S3.E2', [3, 80], '3')]);
    expect(r).toMatchObject({ matched: 1, extra: 1, missing: 1 });
  });

  it('a gold with a repeated key is refused', () => {
    expect(() => compareWithGold('sections', [g('S1', 1, 1), g('S1', 1, 2)], [])).toThrow(/twice/);
  });
});

describe('checkNumberSequence', () => {
  it('1…max in DOM order, unnumbered rows skipped → ok', () => {
    expect(checkNumberSequence(['1', null, '2', '3'])).toMatchObject({ max: 3, gaps: [], repeated: [], outOfOrder: false, ok: true });
  });
  it('a gap → not ok, the missing number listed', () => {
    expect(checkNumberSequence(['1', '2', '4'])).toMatchObject({ gaps: [3], ok: false });
  });
  it('a repeat or a reorder → not ok', () => {
    expect(checkNumberSequence(['1', '2', '2', '3'])).toMatchObject({ repeated: [2], ok: false });
    expect(checkNumberSequence(['1', '3', '2'])).toMatchObject({ gaps: [], outOfOrder: true, ok: false });
  });
  it('non-integer numbers (appendix A.1) are listed apart and do not count', () => {
    expect(checkNumberSequence(['1', 'A.1', '2'])).toMatchObject({ nonInteger: ['A.1'], ok: true });
  });
});

describe('summaryLine', () => {
  it('is the fixed phrase of the brief', () => {
    expect(summaryLine({ gold: 100, matched: 98, null: 2, mismatched: 0 })).toBe('판정 gold 100개 중 일치 98 · null 2 · 불일치 0 (범위: IEEE 2단 논문 2편)');
  });
});

describe('eval-structure and persisted equations', () => {
  it('judges good, renderer-rejected and truncated equations identically at both entry points', async () => {
    const html = SYN_M2_HTML.replace(/(id="S1\.E1\.m1"[^>]*alttext=")[^"]+/, '$1' + 'x'.repeat(4001));
    const evaluated = await structureOf(html);
    expect(evaluated.latex.slice(0, 4).map((e) => e.katexOk)).toEqual([false, true, true, false]);
    const id = freshId();
    const server = await startTestServer({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html }]) });
    try {
      const { paper } = await importAndWait(server.deps, id);
      const stored = server.deps.sqlite.prepare('SELECT latex, katexOk FROM equations WHERE paperId = ? ORDER BY ordinal').all(paper.id);
      expect(stored).toEqual(evaluated.latex.map(({ latex, katexOk }) => ({ latex, katexOk: Number(katexOk) })));
      const cut = await prepareStoredEquations([{ latexRaw: 'x', latexCut: true }, { latexRaw: 'x', latexCut: false }]);
      expect(cut.latex.map((e) => e.katexOk)).toEqual([false, true]);
    } finally {
      await server.close();
    }
  });
});

describe('eval-structure.ts usage (exit 2, nothing written)', () => {
  const script = join(REPO_ROOT, 'scripts/eval-structure.ts');
  it('no --out → 2', async () => {
    const r = await runProbe(script, { SP_FIXTURES_DIR: tempDir() });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--out <dir> is required/);
  });
  it('neither SP_FIXTURES_DIR nor SP_DATA_DIR → 2 (the default data directory is never read)', async () => {
    const out = join(tempDir(), 'out');
    const r = await runProbe(script, { SP_FIXTURES_DIR: undefined, SP_DATA_DIR: undefined }, ['--out', out]);
    expect(r.status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
  it('a fixture directory without the papers → 2, no output directory', async () => {
    const out = join(tempDir(), 'out');
    const r = await runProbe(script, { SP_FIXTURES_DIR: tempDir() }, ['--out', out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/fixture 2209\.15397v2\.pdf not found/);
    expect(existsSync(out)).toBe(false);
  });
});

describe('eval-structure and persisted equations: a LaTeX cut by the parser (S-a fix round)', () => {
  it('stores katexOk false through the import pipeline exactly as the evaluator does, though the stored text renders', async () => {
    // \displaystyle runs push the alttext past LATEX_RAW_MAX (parser cut, ELLIPSIS) and are dropped by normalization,
    // so the stored text is short, uncut and renders: only latexCut can make katexOk false.
    const html = SYN_M2_HTML.replace(/(id="S1\.E1\.m1"[^>]*alttext=")[^"]+/, '$1' + 'a+b_{1}' + ' \\displaystyle'.repeat(1600));
    const evaluated = await structureOf(html);
    const cutAt = evaluated.parsed.equations.findIndex((e) => e.latexCut);
    expect(cutAt).toBeGreaterThanOrEqual(0);
    const stored = normalizeForStore(evaluated.parsed.equations[cutAt]!.latexRaw);
    expect(stored.cut).toBe(false);
    expect((await katexCheckAll([stored.latex])).ok).toEqual([true]);
    expect(evaluated.latex[cutAt]).toEqual({ latex: stored.latex, katexOk: false });
    const id = freshId();
    const server = await startTestServer({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html }]) });
    try {
      const { paper } = await importAndWait(server.deps, id);
      const rows = server.deps.sqlite.prepare('SELECT latex, katexOk FROM equations WHERE paperId = ? ORDER BY ordinal').all(paper.id);
      expect(rows).toEqual(evaluated.latex.map(({ latex, katexOk }) => ({ latex, katexOk: Number(katexOk) })));
      expect(rows[cutAt]).toEqual({ latex: stored.latex, katexOk: 0 });
    } finally {
      await server.close();
    }
  });
});
