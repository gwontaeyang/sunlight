import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { OverviewDto } from '@study-paper/shared/contracts/api';
import { splitOverview } from '@study-paper/shared/overview';
import { SEED_PAPER_ID as id } from '../../src/dev/seedFixture';
import { readOverview } from '../../src/overview/store';
import type { RouteCase } from '../helpers/routeCases';

export const cases: RouteCase[] = [
  { route: 'overview.get', name: 'read without starting an AI run', expect: 'ok', params: { id },
    check(r, ctx) {
      expect(OverviewDto.parse(r.json)).toEqual(readOverview(ctx.server.deps.db, id));
    } },
  { route: 'overview.get', name: 'missing paper', expect: 'not_found', params: { id: randomUUID() } },
  { route: 'overview.generate', name: 'generate and verify before announcing completion', expect: 'ok', params: { id },
    body: () => ({ clientRequestId: randomUUID(), regenerate: true }),
    check(r, ctx) {
      const done = r.events.at(-1);
      const first = r.events[0];
      if (done?.event !== 'run.done' || first?.event !== 'run.accepted') throw new Error('overview did not finish');
      expect(first.data.task).toBe('paper_overview');
      expect(splitOverview(done.data.text)).toHaveLength(5);
      expect(done.data.citations.some(c => c.status === 'verbatim')).toBe(true);
      expect(readOverview(ctx.server.deps.db, id)).toEqual({ result: { runId: first.data.runId, text: done.data.text, citations: done.data.citations }, pending: null });
    } },
  { route: 'overview.generate', name: 'missing request id', expect: 'validation', params: { id }, body: {} },
];
