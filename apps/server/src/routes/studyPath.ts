import { asc, eq, sql } from 'drizzle-orm';
import { readSettings } from '../byok/settings';
import { paperReferences } from '../db/schema';
import { HttpError, routeBody, routeJson, routeParams, type RouteModule } from '../deps';
import { checkStudyPath, liveStudyPaper, readStudyPath, startStudyPathRows } from '../studyPath/store';
import { streamRun } from './threads';

export const studyPathRoutes: RouteModule = (deps) => ({
  'studyPath.get': (c) => {
    const { id } = routeParams(c, 'studyPath.get');
    liveStudyPaper(deps.db, id);
    return routeJson(c, 'studyPath.get', readStudyPath(deps.db, id));
  },
  'studyPath.generate': async (c) => {
    const { id: paperId } = routeParams(c, 'studyPath.generate');
    const { clientRequestId, regenerate = false } = await routeBody(c, 'studyPath.generate');
    const identity = { route: 'studyPath.generate', paperId, regenerate };
    const existing = deps.runs.findExisting({ clientRequestId, paperId, identity });
    if (existing) return streamRun(c, existing, 'study_path');
    const paper = liveStudyPaper(deps.db, paperId);
    if (paper.readyAt === null) throw new HttpError(409, 'context_not_ready', 'paper context is not ready yet');
    const settings = readSettings(deps.sqlite);
    const codeLanguage = settings['study.codeLanguage'];
    const references = deps.db.select({
      idx: paperReferences.ordinal,
      title: sql<string>`substr(coalesce(${paperReferences.title}, ${paperReferences.rawText}), 1, 256)`,
    }).from(paperReferences).where(eq(paperReferences.paperId, paperId)).orderBy(asc(paperReferences.ordinal)).limit(64).all();
    const handle = deps.runTask({
      task: 'study_path', paperId, clientRequestId, identity,
      inputs: { codeLanguage, answerLanguage: settings['llm.answerLanguage'], references: JSON.stringify(references) },
      startRows: startStudyPathRows(paperId, regenerate, codeLanguage),
    });
    return streamRun(c, handle, 'study_path');
  },
  'studyPath.check': async (c) => {
    const { id } = routeParams(c, 'studyPath.check');
    const { runId, index, checked } = await routeBody(c, 'studyPath.check');
    return routeJson(c, 'studyPath.check', checkStudyPath(deps.db, id, runId, index, checked));
  },
});
