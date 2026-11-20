// Owner B. Contract cases of the llm route module (see ../helpers/routeCases.ts).
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { RouteCase } from '../helpers/routeCases';
import { explainOnSeed } from './threads.cases';

const MISSING = '00000000-0000-4000-8000-00000000dead';

export const cases: RouteCase[] = [
  {
    route: 'llm.runs.get',
    name: 'a finished run',
    expect: 'ok',
    setup: (ctx) => explainOnSeed(ctx),
    params: (ctx) => ({ runId: ctx.vars.runId! }),
    check: (r, ctx) => expect(r.json).toMatchObject({ runId: ctx.vars.runId, task: 'explain_selection', status: 'ok', threadId: ctx.vars.threadId, model: 'opus', errorCode: null }),
  },
  {
    route: 'llm.runs.get',
    name: 'a historical deep run keeps its recorded Fable model',
    expect: 'ok',
    setup: (ctx) => {
      ctx.vars.runId = randomUUID();
      ctx.server.deps.sqlite.prepare(
        "INSERT INTO llm_calls (runId, clientRequestId, task, model, modelResolved, effort, status, acceptedAt) VALUES (?, ?, 'equation_deep', 'fable', 'legacy-fable', 'high', 'ok', 1)",
      ).run(ctx.vars.runId, randomUUID());
    },
    params: (ctx) => ({ runId: ctx.vars.runId! }),
    check: (r, ctx) => expect(r.json).toMatchObject({ runId: ctx.vars.runId, task: 'equation_deep', model: 'fable', modelResolved: 'legacy-fable', effort: 'high', status: 'ok' }),
  },
  { route: 'llm.runs.get', name: 'unknown run', expect: 'not_found', params: { runId: MISSING } },
  {
    route: 'llm.runs.cancel',
    name: 'a finished run: 204 and nothing changes',
    expect: 'ok',
    setup: (ctx) => explainOnSeed(ctx),
    params: (ctx) => ({ runId: ctx.vars.runId! }),
    check: (_r, ctx) => expect(ctx.server.deps.sqlite.prepare(`SELECT status FROM llm_calls WHERE runId = ?`).get(ctx.vars.runId)).toEqual({ status: 'ok' }),
  },
  { route: 'llm.runs.cancel', name: 'unknown run', expect: 'not_found', params: { runId: MISSING } },
  {
    route: 'llm.health',
    name: 'mock mode reports the verified CLI version',
    expect: 'ok',
    check: (r) => expect(r.json).toMatchObject({ mode: 'mock', verifiedVersion: '2.1.325', versionMatches: false }),
  },
];
