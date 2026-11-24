import { readSettings } from '../byok/settings';
import { HttpError, routeBody, routeParams, type RouteModule } from '../deps';
import { liveStudyPaper } from '../studyPath/store';
import { reviewSelectionPosition } from '../study/selectionAnchor';
import { streamRun } from './threads';

export const reviewGenerateRoutes: RouteModule = (deps) => ({
  'reviewCards.fromSelection': async (c) => {
    const { id: paperId } = routeParams(c, 'reviewCards.fromSelection');
    const { clientRequestId, page, selection, prefix, suffix } = await routeBody(c, 'reviewCards.fromSelection');
    const quote = { exact: selection, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
    const identity = { route: 'reviewCards.fromSelection', paperId, page, quote };
    const existing = deps.runs.findExisting({ clientRequestId, paperId, identity });
    if (existing) return streamRun(c, existing, 'selection_questions');
    liveStudyPaper(deps.db, paperId);
    const pos = reviewSelectionPosition(deps.db, paperId, page, quote);
    if (!pos || !selection.trim()) throw new HttpError(400, 'validation', '선택한 구간의 위치를 확인할 수 없습니다. 문장을 다시 선택해 주세요.');
    const handle = deps.runTask({
      task: 'selection_questions', clientRequestId, paperId, identity,
      reviewSelection: { page, start: pos.start, quote },
      inputs: { selection, page: String(page), answerLanguage: readSettings(deps.sqlite)['llm.answerLanguage'] },
    });
    return streamRun(c, handle, 'selection_questions');
  },
});
