// Every REST route under /api (PLAN appendix A). The server registers all of them at startup; routes
// without a handler answer 501 with the error DTO. Paths use Hono-style :params and are relative to /api.
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** Response framing: json body, SSE stream, binary file (pdf, png), text/markdown, or 204 without body. One kind per route. */
export type RouteResponseKind = 'json' | 'sse' | 'pdf' | 'png' | 'markdown' | 'empty';

export interface RouteDef {
  id: string;
  method: HttpMethod;
  path: string;
  response: RouteResponseKind;
}

export const API_PREFIX = '/api';

export const ROUTES = [
  { id: 'health', method: 'GET', path: '/health', response: 'json' },
  // A — ingest & data
  { id: 'papers.import', method: 'POST', path: '/papers/import', response: 'json' },
  { id: 'jobs.events', method: 'GET', path: '/jobs/:id/events', response: 'sse' },
  { id: 'papers.list', method: 'GET', path: '/papers', response: 'json' },
  { id: 'papers.get', method: 'GET', path: '/papers/:id', response: 'json' },
  { id: 'papers.patch', method: 'PATCH', path: '/papers/:id', response: 'json' },
  { id: 'papers.delete', method: 'DELETE', path: '/papers/:id', response: 'empty' },
  { id: 'papers.pdf', method: 'GET', path: '/papers/:id/pdf', response: 'pdf' },
  { id: 'papers.retryIngest', method: 'POST', path: '/papers/:id/retry-ingest', response: 'json' },
  { id: 'papers.upgradeStructure', method: 'POST', path: '/papers/:id/upgrade-structure', response: 'json' },
  { id: 'papers.capture', method: 'GET', path: '/papers/:id/captures/:fileId', response: 'png' },
  { id: 'highlights.list', method: 'GET', path: '/papers/:id/highlights', response: 'json' },
  { id: 'highlights.create', method: 'POST', path: '/papers/:id/highlights', response: 'json' },
  { id: 'highlights.patch', method: 'PATCH', path: '/highlights/:id', response: 'json' },
  { id: 'highlights.delete', method: 'DELETE', path: '/highlights/:id', response: 'empty' },
  { id: 'papers.structure', method: 'GET', path: '/papers/:id/structure', response: 'json' },
  { id: 'papers.position', method: 'PUT', path: '/papers/:id/position', response: 'empty' },
  { id: 'notes.list', method: 'GET', path: '/papers/:id/notes', response: 'json' },
  { id: 'notes.create', method: 'POST', path: '/papers/:id/notes', response: 'json' },
  { id: 'notes.patch', method: 'PATCH', path: '/notes/:id', response: 'json' },
  { id: 'notes.delete', method: 'DELETE', path: '/notes/:id', response: 'empty' },
  { id: 'progress.list', method: 'GET', path: '/papers/:id/progress', response: 'json' },
  { id: 'progress.put', method: 'PUT', path: '/papers/:id/progress/:sectionId', response: 'json' },
  { id: 'references.find', method: 'POST', path: '/references/find', response: 'json' },
  { id: 'papers.upload', method: 'POST', path: '/papers/upload', response: 'json' },
  { id: 'collections.list', method: 'GET', path: '/collections', response: 'json' },
  { id: 'collections.create', method: 'POST', path: '/collections', response: 'json' },
  { id: 'collections.patch', method: 'PATCH', path: '/collections/:id', response: 'json' },
  { id: 'collections.delete', method: 'DELETE', path: '/collections/:id', response: 'empty' },
  { id: 'review.queue', method: 'GET', path: '/review/queue', response: 'json' },
  { id: 'review.stats', method: 'GET', path: '/review/stats', response: 'json' },
  { id: 'review.grade', method: 'POST', path: '/review/cards/:id/grade', response: 'json' },
  { id: 'review.cards.create', method: 'POST', path: '/review/cards', response: 'json' },
  { id: 'review.cards.patch', method: 'PATCH', path: '/review/cards/:id', response: 'json' },
  { id: 'review.cards.delete', method: 'DELETE', path: '/review/cards/:id', response: 'empty' },
  { id: 'papers.exportMd', method: 'GET', path: '/papers/:id/export.md', response: 'markdown' },
  { id: 'settings.secret.put', method: 'PUT', path: '/settings/secret', response: 'json' },
  { id: 'settings.secret.delete', method: 'DELETE', path: '/settings/secret', response: 'json' },
  { id: 'settings.secret.check', method: 'POST', path: '/settings/secret/check', response: 'json' },
  { id: 'settings.get', method: 'GET', path: '/settings', response: 'json' },
  { id: 'settings.put', method: 'PUT', path: '/settings', response: 'json' },
  // B — LLM & study tasks
  { id: 'threads.list', method: 'GET', path: '/papers/:id/threads', response: 'json' },
  { id: 'threads.get', method: 'GET', path: '/threads/:id', response: 'json' },
  { id: 'threads.delete', method: 'DELETE', path: '/threads/:id', response: 'empty' },
  { id: 'threads.create', method: 'POST', path: '/papers/:id/threads', response: 'sse' },
  { id: 'messages.create', method: 'POST', path: '/threads/:id/messages', response: 'sse' },
  { id: 'llm.runs.get', method: 'GET', path: '/llm/runs/:runId', response: 'json' },
  { id: 'llm.runs.cancel', method: 'POST', path: '/llm/runs/:runId/cancel', response: 'empty' },
  { id: 'llm.health', method: 'GET', path: '/llm/health', response: 'json' },
  { id: 'cards.list', method: 'GET', path: '/papers/:id/cards', response: 'json' },
  { id: 'cards.generate', method: 'POST', path: '/papers/:id/cards/:kind/generate', response: 'sse' },
  { id: 'cardItems.patch', method: 'PATCH', path: '/card-items/:id', response: 'json' },
  { id: 'glossary.list', method: 'GET', path: '/papers/:id/glossary', response: 'json' },
  { id: 'glossary.create', method: 'POST', path: '/papers/:id/glossary', response: 'json' },
  { id: 'glossary.define', method: 'POST', path: '/papers/:id/glossary/define', response: 'sse' },
  { id: 'glossary.patch', method: 'PATCH', path: '/glossary/:id', response: 'json' },
  { id: 'glossary.delete', method: 'DELETE', path: '/glossary/:id', response: 'empty' },
  { id: 'reviewCards.fromSelection', method: 'POST', path: '/papers/:id/review-cards/from-selection', response: 'sse' },
  { id: 'reviewCards.generate', method: 'POST', path: '/papers/:id/review-cards/generate', response: 'sse' },
  { id: 'reviewCards.accept', method: 'POST', path: '/papers/:id/review-cards/accept', response: 'json' },
  { id: 'explainBack.create', method: 'POST', path: '/papers/:id/explain-back', response: 'sse' },
  { id: 'explainBack.list', method: 'GET', path: '/papers/:id/explain-backs', response: 'json' },
  { id: 'usage.summary', method: 'GET', path: '/usage/summary', response: 'json' },
  { id: 'overview.get', method: 'GET', path: '/papers/:id/overview', response: 'json' },
  { id: 'overview.generate', method: 'POST', path: '/papers/:id/overview/generate', response: 'sse' },
  { id: 'studyPath.get', method: 'GET', path: '/papers/:id/study-path', response: 'json' },
  { id: 'studyPath.generate', method: 'POST', path: '/papers/:id/study-path/generate', response: 'sse' },
  { id: 'studyPath.check', method: 'PATCH', path: '/papers/:id/study-path/check', response: 'json' },
] as const satisfies readonly RouteDef[];

export type RouteId = (typeof ROUTES)[number]['id'];
export const ROUTE_BY_ID: Record<RouteId, RouteDef> = Object.fromEntries(ROUTES.map((r) => [r.id, r])) as Record<RouteId, RouteDef>;

/** Fills :params of a route path, encoding each value. Returns the path relative to API_PREFIX. */
export function routePath(id: RouteId, params: Record<string, string> = {}): string {
  return ROUTE_BY_ID[id].path.replace(/:([A-Za-z]+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`missing route param ${k} for ${id}`);
    return encodeURIComponent(v);
  });
}
