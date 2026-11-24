import { readSettings } from '../byok/settings';
import { routeBody, routeJson, routeParams, type RouteModule } from '../deps';
import { readOverview, startOverviewRows } from '../overview/store';
import { liveStudyPaper } from '../studyPath/store';
import { streamRun } from './threads';

export const overviewRoutes: RouteModule = (deps) => ({
  'overview.get': (c) => {
    const { id } = routeParams(c, 'overview.get');
    liveStudyPaper(deps.db, id);
    return routeJson(c, 'overview.get', readOverview(deps.db, id));
  },
  'overview.generate': async (c) => {
    const { id: paperId } = routeParams(c, 'overview.generate');
    const { clientRequestId, regenerate = false } = await routeBody(c, 'overview.generate');
    const identity = { route: 'overview.generate', paperId, regenerate };
    const existing = deps.runs.findExisting({ clientRequestId, paperId, identity });
    if (existing) return streamRun(c, existing, 'paper_overview');
    const handle = deps.runTask({
      task: 'paper_overview', paperId, clientRequestId, identity,
      inputs: { answerLanguage: readSettings(deps.sqlite)['llm.answerLanguage'] },
      startRows: startOverviewRows(paperId, regenerate),
    });
    return streamRun(c, handle, 'paper_overview');
  },
});
