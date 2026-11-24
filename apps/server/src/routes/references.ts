import { and, asc, inArray, isNull, or, sql } from 'drizzle-orm';
import type { ReferenceCandidate } from '@study-paper/shared/contracts/api';
import { papers } from '../db/schema';
import { HttpError, routeBody, routeJson, type AppDeps, type RouteModule } from '../deps';
import { parseArxivInput } from '../ingest/arxivId';
import { ingestService } from '../ingest/pipeline';
import { ReferenceSearchError } from '../ingest/referenceSearch';
import { NetworkBudgetError, NetworkDisabledError } from '../security/network';

const failureMessages = {
  network_off: '외부 네트워크가 꺼져 있어 참고문헌을 검색할 수 없습니다.',
  budget: '외부 요청 한도에 도달했습니다.',
  busy: '진행 중인 검색이 많습니다. 잠시 후 다시 시도하세요.',
  timeout: '참고문헌 검색 시간이 초과됐습니다. 잠시 후 다시 시도하세요.',
  providers: '참고문헌 검색 서비스를 이용할 수 없습니다. 잠시 후 다시 시도하세요.',
};

/** A similar title is a search result. Only an identifier can establish that this copy is in the Library. */
function matchLibrary(deps: AppDeps, candidates: ReferenceCandidate[]): ReferenceCandidate[] {
  if (!candidates.length) return candidates;
  const keys = candidates.map(c => ({
    arxivId: c.arxivId ? parseArxivInput(c.arxivId)?.id : undefined,
    doi: c.doi?.toLowerCase(),
  }));
  const matches = deps.db.select({ id: papers.id, arxivId: papers.arxivId, doi: papers.doi }).from(papers)
    .where(and(isNull(papers.deletingAt), or(
      inArray(papers.arxivId, keys.flatMap(k => k.arxivId ? [k.arxivId] : [])),
      inArray(sql<string>`lower(${papers.doi})`, keys.flatMap(k => k.doi ? [k.doi] : [])),
    ))).orderBy(asc(papers.createdAt), asc(papers.id)).all();
  return candidates.map((candidate, i) => {
    const key = keys[i]!;
    const paper = (key.arxivId && matches.find(p => p.arxivId === key.arxivId)) ||
      (key.doi && matches.find(p => p.doi?.toLowerCase() === key.doi));
    return { ...candidate, inLibraryPaperId: paper ? paper.id : null };
  });
}

export const referencesRoutes: RouteModule = deps => ({
  'references.find': async c => {
    const query = await routeBody(c, 'references.find');
    const signal = AbortSignal.any([c.req.raw.signal, deps.shutdown]);
    try {
      signal.throwIfAborted();
      const { candidates, unavailable } = await ingestService(deps).findReferences(query, signal);
      signal.throwIfAborted();
      return routeJson(c, 'references.find', { candidates: matchLibrary(deps, candidates), unavailable });
    } catch (e) {
      // Never put provider response bodies, titles or transport error messages into the HTTP error.
      let reason: keyof typeof failureMessages;
      if (e instanceof NetworkBudgetError) reason = 'budget';
      else if (e instanceof NetworkDisabledError) reason = 'network_off';
      else if (signal.aborted) reason = 'providers';
      else if (e instanceof ReferenceSearchError) reason = e.kind === 'unavailable' ? 'providers' : e.kind;
      else throw e;
      throw new HttpError(503, 'reference_search_unavailable', failureMessages[reason], { reason });
    }
  },
});
