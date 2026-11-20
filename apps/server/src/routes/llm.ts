// Owner B. Routes: 'llm.runs.get', 'llm.runs.cancel', 'llm.health'.
import { eq } from 'drizzle-orm';
import { Effort, LlmErrorCode, ModelAlias, TaskId, VERIFIED_CLI_VERSION } from '@study-paper/shared/contracts/tasks';
import { llmCalls } from '../db/schema';
import { notFound, routeJson, routeParams, type RouteModule } from '../deps';

export const llmRoutes: RouteModule = (deps) => ({
  'llm.runs.get': (c) => {
    const { runId } = routeParams(c, 'llm.runs.get');
    const r = deps.db.select().from(llmCalls).where(eq(llmCalls.runId, runId)).get();
    if (!r) throw notFound('run');
    const code = LlmErrorCode.safeParse(r.errorCode);
    return routeJson(c, 'llm.runs.get', {
      runId: r.runId,
      task: TaskId.parse(r.task),
      status: r.status,
      errorCode: code.success ? code.data : null,
      paperId: r.paperId,
      threadId: r.threadId,
      model: ModelAlias.parse(r.model),
      modelResolved: r.modelResolved,
      effort: Effort.parse(r.effort),
      acceptedAt: r.acceptedAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    });
  },

  /** Queued → removed, running → child stopped; terminal → 204 without change; unknown → 404. */
  'llm.runs.cancel': (c) => {
    const { runId } = routeParams(c, 'llm.runs.cancel');
    if (deps.runs.cancel(runId) === 'unknown') throw notFound('run');
    return c.body(null, 204);
  },

  'llm.health': async (c) => {
    const mode = deps.backends.mode();
    const h = mode === 'api' ? { cliFound: false, cliVersion: null, detail: deps.backends.available() ? null : 'API key required' } : await deps.llm.health();
    return routeJson(c, 'llm.health', { cliFound: h.cliFound, cliVersion: h.cliVersion, verifiedVersion: VERIFIED_CLI_VERSION, versionMatches: h.cliVersion === VERIFIED_CLI_VERSION, mode, detail: h.detail });
  },
});
