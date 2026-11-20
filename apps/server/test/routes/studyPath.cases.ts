import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { StudyPathDto } from '@study-paper/shared/contracts/api';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { readStudyPath } from '../../src/studyPath/store';
import type { CaseContext, RouteCase } from '../helpers/routeCases';
import { sseEvents } from './threads.cases';

const id = SEED_PAPER_ID;
const missing = '00000000-0000-4000-8000-00000000dead';

async function createPath(ctx: CaseContext) {
  const s = ctx.server;
  const r = await s.req('/api/papers/' + id + '/study-path/generate', {
    method: 'POST',
    headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: randomUUID(), regenerate: true }),
  });
  const events = sseEvents(r.text);
  const first = events[0];
  if (first?.event !== 'run.accepted' || events.at(-1)?.event !== 'run.done') throw new Error('study path fixture did not finish: ' + events.at(-1)?.event);
  ctx.vars.runId = first.data.runId;
}

export const cases: RouteCase[] = [
  { route: 'studyPath.get', name: 'retrieve the current paper lesson', expect: 'ok', setup: createPath, params: { id },
    check(r, ctx) {
      const dto = StudyPathDto.parse(r.json);
      expect(dto.result?.runId).toBe(ctx.vars.runId);
      expect(dto.result?.checked).toContain(false);
      expect(dto.pending).toBe(null);
    } },
  { route: 'studyPath.get', name: 'missing paper', expect: 'not_found', params: { id: missing } },
  { route: 'studyPath.generate', name: 'manual generation persists its successful terminal', expect: 'ok', params: { id },
    body: () => ({ clientRequestId: randomUUID(), regenerate: true }),
    check(r, ctx) {
      const done = r.events.at(-1);
      const first = r.events[0];
      if (first?.event !== 'run.accepted' || done?.event !== 'run.done') throw new Error('expected a successful lesson: ' + done?.event);
      const stored = readStudyPath(ctx.server.deps.db, id);
      expect(stored.result).toMatchObject({ runId: first.data.runId, text: done.data.text, citations: done.data.citations });
      expect(stored.pending).toBe(null);
    } },
  { route: 'studyPath.generate', name: 'requires a request id', expect: 'validation', params: { id }, body: {} },
  { route: 'studyPath.check', name: 'change one checklist item', expect: 'ok', setup: createPath, params: { id },
    body: (ctx: CaseContext) => ({ runId: ctx.vars.runId, index: 0, checked: true }),
    check(r) { expect(StudyPathDto.parse(r.json).result?.checked[0]).toBe(true); } },
  { route: 'studyPath.check', name: 'reject an obsolete revision', expect: 'conflict', setup: createPath, params: { id },
    body: () => ({ runId: randomUUID(), index: 0, checked: true }) },
];
