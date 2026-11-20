// Owner B. Routes: 'glossary.list', 'glossary.create', 'glossary.define', 'glossary.patch', 'glossary.delete'
// (PLAN_M2 3.4 rule 6, D9, D29). The term logic is study/glossary.ts.
// glossary.define is a run (task glossary_define): request id first (rule 1a) → paper (404) and readiness (409) →
// runTask; its suggestion is stored as the run's result, never as a term — the user stores it with glossary.create.
import { eq } from 'drizzle-orm';
import { papers } from '../db/schema';
import { HttpError, notFound, routeBody, routeJson, routeParams, type RouteModule } from '../deps';
import { createTerm, defineIdentity, deleteTerm, listTerms, patchTerm } from '../study/glossary';
import { streamRun } from './threads';

/**
 * A term the model can answer for (review B-R1-04): the answer's <term name="…"> must equal the requested term under
 * normalizeTerm, and an SP-Blocks attribute value cannot hold `"`, `<` or `>` while control characters are removed
 * from the output before parsing — such a term could never validate and every request would end parse_failed after
 * paid calls. Whitespace (tab, newline) is fine: normalizeTerm collapses it.
 */
// eslint-disable-next-line no-control-regex
const UNDEFINABLE_TERM_RE = /["<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const definableTerm = (term: string): boolean => !UNDEFINABLE_TERM_RE.test(term);

export const glossaryRoutes: RouteModule = (deps) => {
  const livePaper = (paperId: string) => {
    const p = deps.db.select({ contextReadyAt: papers.contextReadyAt, deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, paperId)).get();
    if (!p || p.deletingAt !== null) throw notFound('paper');
    return p;
  };
  return {
    'glossary.list': (c) => {
      const { id: paperId } = routeParams(c, 'glossary.list');
      livePaper(paperId);
      return routeJson(c, 'glossary.list', { terms: listTerms(deps.db, paperId) });
    },

    'glossary.create': async (c) => {
      const { id: paperId } = routeParams(c, 'glossary.create');
      const body = await routeBody(c, 'glossary.create');
      livePaper(paperId);
      return routeJson(c, 'glossary.create', createTerm(deps.db, paperId, body));
    },

    'glossary.define': async (c) => {
      const { id: paperId } = routeParams(c, 'glossary.define');
      const body = await routeBody(c, 'glossary.define');
      const identity = defineIdentity(paperId, body);
      const existing = deps.runs.findExisting({ clientRequestId: body.clientRequestId, paperId, identity });
      if (existing) return streamRun(c, existing, 'glossary_define');
      const paper = livePaper(paperId);
      if (paper.contextReadyAt === null) throw new HttpError(409, 'context_not_ready', 'paper context is not ready yet');
      if (!body.term.trim()) throw new HttpError(400, 'validation', 'term is empty');
      if (!definableTerm(body.term)) throw new HttpError(400, 'validation', 'term contains a character that cannot be a term name (" < > or a control character)');
      const handle = deps.runTask({ task: 'glossary_define', clientRequestId: body.clientRequestId, paperId, inputs: { term: body.term, selection: body.selection }, identity });
      return streamRun(c, handle, 'glossary_define');
    },

    'glossary.patch': async (c) => {
      const { id } = routeParams(c, 'glossary.patch');
      const body = await routeBody(c, 'glossary.patch');
      if (body.term === undefined && body.definitionKo === undefined) throw new HttpError(400, 'validation', 'nothing to change (term or definitionKo)');
      return routeJson(c, 'glossary.patch', patchTerm(deps.db, id, body));
    },

    'glossary.delete': (c) => {
      const { id } = routeParams(c, 'glossary.delete');
      deleteTerm(deps.db, id);
      return c.body(null, 204);
    },
  };
};
