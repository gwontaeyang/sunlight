// Owner A. Contract cases of the jobs route module (see ../helpers/routeCases.ts).
import { expect } from 'vitest';
import { FakeArxivSource, freshId, importAndWait, useSource } from '../ingest/helpers';
import type { RouteCase } from '../helpers/routeCases';

const MISSING = '00000000-0000-4000-8000-00000000dead';

export const cases: RouteCase[] = [
  {
    route: 'jobs.events',
    name: 'finished import replays steps and states, then job.done',
    expect: 'ok',
    setup: async (ctx) => {
      const id = freshId();
      useSource(ctx.server.deps, new FakeArxivSource({ [id]: { version: 1 } }));
      const { res } = await importAndWait(ctx.server.deps, id);
      ctx.vars.jobId = res.jobId!;
      ctx.vars.paperId = res.paperId;
    },
    params: (ctx) => ({ id: ctx.vars.jobId! }),
    check: (r, ctx) => {
      expect(r.events.map((e) => (e.event === 'job.step' ? `step:${e.data.step}:${e.data.status}` : e.event === 'job.state' ? `state:${e.data.state}` : e.event))).toEqual([
        'step:resolve:ok',
        'step:metadata:ok',
        'step:pdf:ok',
        'step:text:ok',
        'step:html:skipped',
        'step:structure:skipped',
        'step:anchor:skipped',
        'step:supplement:ok',
        'state:readable',
        'state:context_ready',
        'state:structure_ready',
        'job.done',
      ]);
      expect(r.events.at(-1)).toEqual({ event: 'job.done', data: { paperId: ctx.vars.paperId } });
    },
  },
  {
    route: 'jobs.events',
    name: 'failed import ends with job.error',
    expect: 'ok',
    setup: async (ctx) => {
      const id = freshId();
      useSource(ctx.server.deps, new FakeArxivSource({})); // arXiv has no such paper
      ctx.vars.jobId = (await importAndWait(ctx.server.deps, id)).res.jobId!;
    },
    params: (ctx) => ({ id: ctx.vars.jobId! }),
    check: (r) => {
      expect(r.events.at(-1)).toMatchObject({ event: 'job.error', data: { code: 'not_found' } });
      expect(r.events).toContainEqual({ event: 'job.step', data: expect.objectContaining({ step: 'metadata', status: 'error' }) });
    },
  },
  { route: 'jobs.events', name: 'unknown job', expect: 'not_found', params: { id: MISSING } },
  { route: 'jobs.events', name: 'over-long id', expect: 'validation', params: { id: 'j'.repeat(65) } },
];
