// SP_GATE_MILESTONE may only raise the gate (X-I10-01). Owner: supervisor.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gateStage, routeDue, ROUTE_MANIFEST, GATED_STAGE, GATED_MILESTONE } from '@study-paper/shared/contracts/routeManifest';
import { gateMilestone } from '../helpers/gate';
import { TASK_SPECS } from '@study-paper/shared/contracts/tasks';
import { REPO_ROOT } from '../helpers/proc';

describe('gateMilestone: SP_GATE_MILESTONE only raises the gate', () => {
  it('unset, empty, lower (1, 0) → GATED_MILESTONE: the M2 gates still run', () => {
    expect(GATED_MILESTONE).toBe(2);
    for (const v of [undefined, '', '1', '0', '2']) expect(gateMilestone({ SP_GATE_MILESTONE: v }), String(v)).toBe(2);
  });

  it('a higher integer raises it; a value that is not an integer throws (the gate file fails, it does not skip)', () => {
    expect(gateMilestone({ SP_GATE_MILESTONE: '3' })).toBe(3);
    for (const v of ['abc', '1.5', '-1', ' 2', '2a']) expect(() => gateMilestone({ SP_GATE_MILESTONE: v }), v).toThrow(/non-negative integer/);
  });

  it('the three gate files take the gate from this helper only (none reads SP_GATE_MILESTONE itself)', () => {
    for (const f of ['m1.gate.test.ts', 'm2.gate.test.ts', 'routes.gate.test.ts']) {
      const src = readFileSync(join(REPO_ROOT, 'apps', 'server', 'test', 'contract', f), 'utf8');
      expect(src, f).toMatch(/^const gate = gateMilestone\(\);$/m);
      expect(src, f).not.toMatch(/process\.env\.SP_GATE_MILESTONE/);
    }
  });
});

describe('M3 stage gates', () => {
  it('never lowers an accepted stage, rejects typos and opens c2 exactly at c2', () => {
    expect(GATED_STAGE).toBe('c2');
    expect(gateStage(undefined)).toBe(GATED_STAGE);
    expect(gateStage('a', 'c1')).toBe('c1');
    expect(gateStage('d', 'c1')).toBe('d');
    expect(() => gateStage('C1')).toThrow(/SP_GATE_STAGE/);
    const due = (stage: 'a' | 'b' | 'c1' | 'c2') => ROUTE_MANIFEST.filter((r) => r.milestone > 2 && routeDue(r, 2, stage)).map((r) => r.route);
    expect(due('a')).toEqual([]);
    expect(due('c1')).toEqual(due('c2'));
    expect(due('b')).toEqual(due('c2'));
    expect(due('c2')).toEqual(['settings.get', 'settings.put', 'settings.secret.put', 'settings.secret.delete', 'settings.secret.check', 'usage.summary']);
    expect(ROUTE_MANIFEST.filter((r) => r.milestone === 4)).toHaveLength(16);
    expect(ROUTE_MANIFEST).toHaveLength(61);
    expect(Object.values(TASK_SPECS).filter((s) => s.milestone === 4).map((s) => s.id)).toEqual(['cards_from_highlights', 'explain_back_grade', 'pdf_metadata']);
  });
});
