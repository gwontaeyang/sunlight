// Owner A. The upgrade decision table (BRIEF_A A6) — every row, first match wins.
import { describe, expect, it } from 'vitest';
import type { JobDto } from '@study-paper/shared/contracts/api';
import { STRUCTURE_FINAL_WARNINGS } from '@study-paper/shared/contracts/domain';
import { structureUpgradeState, warningCodes, type UpgradePaperFields } from '../../src/ingest/structureUpgradeState';

const m1: UpgradePaperFields = { source: 'arxiv', deletingAt: null, structureReadyAt: 1, supplementVersion: 1, structureSource: 'none', ingestWarningsJson: '[]' };
const job: JobDto = { id: '00000000-0000-4000-8000-0000000000aa', kind: 'upgrade_structure', paperId: null, status: 'failed', steps: [], error: 'timeout: x' };
const st = (p: Partial<UpgradePaperFields>, j: JobDto | null = null) => structureUpgradeState({ ...m1, ...p }, j);

describe('structureUpgradeState', () => {
  it('row 1: not arXiv, being deleted, or not ingested (structureReadyAt null) → false', () => {
    expect(st({ source: 'upload' })).toEqual({ available: false, reason: null, job: null });
    expect(st({ deletingAt: 5 })).toEqual({ available: false, reason: null, job: null });
    expect(st({ structureReadyAt: null })).toEqual({ available: false, reason: null, job: null });
    expect(st({ structureReadyAt: null, ingestWarningsJson: '["html_deferred"]' }).available).toBe(false);
  });
  it('row 2: already v2, or a structure source other than none (latexml, pdf-outline, null) → false', () => {
    expect(st({ supplementVersion: 2 }).available).toBe(false);
    expect(st({ supplementVersion: 2, structureSource: 'latexml', ingestWarningsJson: '["html_deferred"]' }).available).toBe(false);
    for (const structureSource of ['latexml', 'pdf-outline', null]) expect(st({ structureSource }).available).toBe(false);
    expect(st({ supplementVersion: null }).available).toBe(false);
  });
  it('row 3: any final structure warning → false (also next to html_deferred, and with a description)', () => {
    for (const w of STRUCTURE_FINAL_WARNINGS) {
      expect(st({ ingestWarningsJson: JSON.stringify([w]) }).available, w).toBe(false);
      expect(st({ ingestWarningsJson: JSON.stringify(['html_deferred', `${w}: details`]) }).available, w).toBe(false);
    }
  });
  it('row 4: html_deferred → true, html_deferred', () => {
    expect(st({ ingestWarningsJson: '["html_deferred"]' })).toEqual({ available: true, reason: 'html_deferred', job: null });
    expect(st({ ingestWarningsJson: '["katex_budget","html_deferred: network_disabled"]' })).toMatchObject({ available: true, reason: 'html_deferred' });
  });
  it('row 5: an M1 paper without structure warnings → true, m1_paper; non-structure warnings do not matter; job is passed through', () => {
    expect(st({})).toEqual({ available: true, reason: 'm1_paper', job: null });
    expect(st({ ingestWarningsJson: '["supplement_truncated"]' }, job)).toEqual({ available: true, reason: 'm1_paper', job });
    expect(st({ ingestWarningsJson: 'not json' })).toMatchObject({ available: true, reason: 'm1_paper' });
    expect(st({ supplementVersion: 2 }, job)).toEqual({ available: false, reason: null, job });
  });
  it('warning codes: `<code>` and `<code>: <description>`', () => {
    expect([...warningCodes('["a","b: c d", 3]')]).toEqual(['a', 'b']);
    expect([...warningCodes(null)]).toEqual([]);
  });
});
