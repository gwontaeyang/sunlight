// Contract gate for every later merge (PLAN 9.2-11): all routes registered, implemented routes match the
// api.ts schemas on the seed DB + MockLlm, unimplemented routes answer exactly the 501 DTO, SSE starts with
// run.accepted and ends with exactly one terminal event, mock outputs pass the v0 parser.
import { readFileSync } from 'node:fs';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_SCHEMAS, type RouteSchemas } from '@study-paper/shared/contracts/api';
import { ErrorDtoSchema } from '@study-paper/shared/contracts/errors';
import { ROUTE_MANIFEST } from '@study-paper/shared/contracts/routeManifest';
import { API_PREFIX, ROUTES, routePath, type RouteId } from '@study-paper/shared/contracts/routes';
import { parseSseEvent, RUN_TERMINAL_EVENTS, type SseEvent } from '@study-paper/shared/contracts/sse';
import { TaskId } from '@study-paper/shared/contracts/tasks';
import { matchQuote } from '@study-paper/shared/anchor/matchQuote';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import { readMockFile, readMockManifest } from '@study-paper/shared/mock-outputs';
import { collectHandlers } from '../../src/app';
import { citations, messages, pageTexts, papers } from '../../src/db/schema';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { startTestServer, type TestServer } from '../helpers/server';

/** Appendix A transcribed independently of routeManifest.ts: "METHOD path" → owner, milestone. */
const APPENDIX_A: Record<string, [owner: 'A' | 'B' | 'supervisor', milestone: 0 | 1 | 2 | 3 | 4]> = {
  'GET /health': ['supervisor', 0],
  'POST /papers/import': ['A', 1],
  'GET /jobs/:id/events': ['A', 1],
  'GET /papers': ['A', 1],
  'GET /papers/:id': ['A', 1],
  'PATCH /papers/:id': ['A', 1],
  'DELETE /papers/:id': ['A', 1],
  'GET /papers/:id/pdf': ['A', 1],
  'POST /papers/:id/retry-ingest': ['A', 1],
  'POST /papers/:id/upgrade-structure': ['A', 2],
  'GET /papers/:id/captures/:fileId': ['A', 2],
  'GET /papers/:id/highlights': ['A', 1],
  'POST /papers/:id/highlights': ['A', 1],
  'PATCH /highlights/:id': ['A', 1],
  'DELETE /highlights/:id': ['A', 1],
  'GET /papers/:id/structure': ['A', 2],
  'PUT /papers/:id/position': ['A', 2],
  'GET /papers/:id/notes': ['A', 2],
  'POST /papers/:id/notes': ['A', 2],
  'PATCH /notes/:id': ['A', 2],
  'DELETE /notes/:id': ['A', 2],
  'GET /papers/:id/progress': ['A', 2],
  'PUT /papers/:id/progress/:sectionId': ['A', 2],
  'POST /papers/upload': ['A', 4],
  'GET /collections': ['A', 4],
  'POST /collections': ['A', 4],
  'PATCH /collections/:id': ['A', 4],
  'DELETE /collections/:id': ['A', 4],
  'GET /review/queue': ['A', 4],
  'GET /review/stats': ['A', 4],
  'POST /review/cards/:id/grade': ['A', 4],
  'POST /review/cards': ['A', 4],
  'PATCH /review/cards/:id': ['A', 4],
  'DELETE /review/cards/:id': ['A', 4],
  'GET /papers/:id/export.md': ['A', 4],
  'PUT /settings/secret': ['A', 3],
  'DELETE /settings/secret': ['A', 3],
  'POST /settings/secret/check': ['A', 3],
  'GET /settings': ['A', 3],
  'PUT /settings': ['A', 3],
  'GET /papers/:id/threads': ['B', 1],
  'GET /threads/:id': ['B', 1],
  'DELETE /threads/:id': ['B', 1],
  'POST /papers/:id/threads': ['B', 1],
  'POST /threads/:id/messages': ['B', 1],
  'GET /llm/runs/:runId': ['B', 1],
  'POST /llm/runs/:runId/cancel': ['B', 1],
  'GET /llm/health': ['B', 1],
  'GET /papers/:id/cards': ['B', 2],
  'POST /papers/:id/cards/:kind/generate': ['B', 2],
  'PATCH /card-items/:id': ['B', 2],
  'GET /papers/:id/glossary': ['B', 2],
  'POST /papers/:id/glossary': ['B', 2],
  'POST /papers/:id/glossary/define': ['B', 2],
  'PATCH /glossary/:id': ['B', 2],
  'DELETE /glossary/:id': ['B', 2],
  'POST /papers/:id/review-cards/generate': ['B', 4],
  'POST /papers/:id/review-cards/accept': ['B', 4],
  'POST /papers/:id/explain-back': ['B', 4],
  'GET /papers/:id/explain-backs': ['B', 4],
  'GET /usage/summary': ['B', 3],
  'GET /papers/:id/study-path': ['B', 3],
  'POST /papers/:id/study-path/generate': ['B', 3],
  'PATCH /papers/:id/study-path/check': ['B', 3],
};

const FAKE_ID = '11111111-1111-4111-8111-111111111111';
const paramsFor = (path: string): Record<string, string> => Object.fromEntries([...path.matchAll(/:([A-Za-z]+)/g)].map((m) => [m[1]!, m[1] === 'kind' ? 'notation' : FAKE_ID]));

function sseEvents(text: string): SseEvent[] {
  return text
    .split(/\n\n/)
    .filter((b) => b.trim())
    .map((block) => {
      const ev = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? 'null';
      return parseSseEvent(ev, JSON.parse(data));
    });
}

describe('route manifest', () => {
  it('ROUTES ids are unique and every route is in the manifest exactly once', () => {
    const ids = ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ROUTE_MANIFEST.map((m) => m.route).sort()).toEqual([...ids].sort());
  });
  it('owner and milestone match appendix A', () => {
    const fromManifest = Object.fromEntries(
      ROUTE_MANIFEST.map((m) => {
        const r = ROUTES.find((x) => x.id === m.route)!;
        return [`${r.method} ${r.path}`, [m.owner, m.milestone]];
      }),
    );
    expect(fromManifest).toEqual(APPENDIX_A);
  });
  it('every route has a schema entry', () => {
    expect(Object.keys(API_SCHEMAS).sort()).toEqual(ROUTES.map((r) => r.id).sort());
  });
  it('every task id has a mock output', () => {
    const m = readMockManifest();
    expect(Object.keys(m.tasks).sort()).toEqual([...TaskId.options].sort());
  });
});

describe('routes over HTTP (seed DB + MockLlm)', () => {
  let s: TestServer;
  let implemented: Set<RouteId>;
  beforeAll(async () => {
    s = await startTestServer({ env: 'prod', seed: true });
    implemented = collectHandlers(s.deps).implemented;
  });
  afterAll(async () => {
    await s.close();
  });
  const call = (method: string, path: string, body?: unknown) =>
    s.req(API_PREFIX + path, { method, headers: { 'X-SP-Token': s.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('the S0 walking-skeleton routes stay implemented', () => {
    for (const r of ['health', 'papers.get', 'papers.list', 'papers.pdf', 'threads.create'] as const) expect(implemented.has(r), r).toBe(true);
  });

  it('every unimplemented route answers exactly the 501 DTO', async () => {
    for (const r of ROUTES) {
      if (implemented.has(r.id)) continue;
      const noBody = r.method === 'GET' || r.method === 'DELETE' || r.id === 'papers.upload';
      const res = await call(r.method, routePath(r.id, paramsFor(r.path)), noBody ? undefined : {});
      expect(res.status, `${r.method} ${r.path}`).toBe(501);
      expect(ErrorDtoSchema.parse(JSON.parse(res.text))).toEqual({ error: { code: 'not_implemented', message: `${r.id} is not implemented yet` } });
    }
  });

  it('GET /health matches the schema', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    const body = (API_SCHEMAS.health as RouteSchemas).response!.parse(JSON.parse(res.text));
    expect(body).toMatchObject({ ok: true, db: { ok: true, lastMigration: '0004_study_path' }, llm: 'mock' });
  });

  it('GET /papers and GET /papers/:id match the schemas', async () => {
    const list = API_SCHEMAS['papers.list'].response.parse(JSON.parse((await call('GET', '/papers')).text));
    expect(list.papers.map((p) => p.id)).toEqual([SEED_PAPER_ID]);
    const detail = API_SCHEMAS['papers.get'].response.parse(JSON.parse((await call('GET', `/papers/${SEED_PAPER_ID}`)).text));
    expect(detail.state).toEqual({ readable: true, contextReady: true, structureReady: true });
    expect(detail.pageCount).toBe(2);
  });

  it('GET /papers/:id 404 and 400 use the error DTO', async () => {
    const nf = await call('GET', `/papers/${FAKE_ID}`);
    expect(nf.status).toBe(404);
    expect(ErrorDtoSchema.parse(JSON.parse(nf.text)).error.code).toBe('not_found');
    const bad = await call('GET', `/papers/${'x'.repeat(80)}`);
    expect(bad.status).toBe(400);
    expect(ErrorDtoSchema.parse(JSON.parse(bad.text)).error.code).toBe('validation');
  });

  it('GET /papers/:id/pdf streams the PDF bytes', async () => {
    const res = await call('GET', `/papers/${SEED_PAPER_ID}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.body.equals(readFileSync(new URL('../fixtures/synthetic.pdf', import.meta.url)))).toBe(true);
  });

  it('POST /papers/:id/threads streams run.accepted … exactly one terminal, and persists message + citations', async () => {
    const res = await call('POST', `/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text: 'We estimate the robot pose', clientRequestId: crypto.randomUUID() });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const evs = sseEvents(res.text);
    expect(evs[0]!.event).toBe('run.accepted');
    const terminals = evs.filter((e) => (RUN_TERMINAL_EVENTS as readonly string[]).includes(e.event));
    expect(terminals).toHaveLength(1);
    expect(evs.at(-1)!.event).toBe('run.done');
    expect(evs.map((e) => e.event)).toEqual(expect.arrayContaining(['run.started', 'run.response_started', 'run.delta']));
    const done = evs.at(-1) as Extract<SseEvent, { event: 'run.done' }>;
    expect(done.data.citations.map((c) => c.status)).toEqual(['verbatim', 'resolved', 'verbatim']);
    expect(done.data.stats).toMatchObject({ blocks: { p: 2, pUnverified: 1, g: 1 }, quotes: { verbatim: 2 }, eqRefs: { resolved: 1 } });
    const accepted = evs[0] as Extract<SseEvent, { event: 'run.accepted' }>;
    const msg = s.deps.db.select().from(messages).where(eq(messages.id, accepted.data.messageId!)).get()!;
    expect(msg.status).toBe('complete');
    const stored = s.deps.db.select().from(citations).where(eq(citations.ownerId, msg.id)).all();
    expect(stored).toHaveLength(parseAnswer(msg.contentMd).citations.length);
  });

  it('POST /papers/:id/threads before context_ready → 409 context_not_ready', async () => {
    s.deps.db.update(papers).set({ contextReadyAt: null }).where(eq(papers.id, SEED_PAPER_ID)).run();
    try {
      const res = await call('POST', `/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text: 'x', clientRequestId: crypto.randomUUID() });
      expect(res.status).toBe(409);
      expect(ErrorDtoSchema.parse(JSON.parse(res.text)).error.code).toBe('context_not_ready');
    } finally {
      s.deps.db.update(papers).set({ contextReadyAt: Date.now() }).where(eq(papers.id, SEED_PAPER_ID)).run();
    }
  });

  it('POST /papers/:id/threads with an invalid body → 400 DTO', async () => {
    const res = await call('POST', `/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', clientRequestId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(ErrorDtoSchema.parse(JSON.parse(res.text)).error.code).toBe('validation');
  });

  it('mock outputs pass the v0 parser and match their expectations on the synthetic paper', () => {
    const pages = s.deps.db.select({ page: pageTexts.page, text: pageTexts.text }).from(pageTexts).where(eq(pageTexts.paperId, SEED_PAPER_ID)).orderBy(asc(pageTexts.page)).all();
    const manifest = readMockManifest();
    for (const [task, entry] of Object.entries(manifest.tasks)) {
      const raw = readMockFile(entry.file);
      if (!entry.expect) {
        expect(() => JSON.parse(raw)).not.toThrow();
        continue;
      }
      const parsed = parseAnswer(raw);
      const quotes = parsed.citations.filter((c) => c.kind === 'quote').map((c) => matchQuote(pages, { exact: c.quote! }).status);
      const count = (st: string) => quotes.filter((q) => q === st).length;
      expect({ task, verbatim: count('verbatim'), ambiguous: count('ambiguous'), notFound: count('not_found') }).toEqual({ task, ...entry.expect.quotes });
      expect({ task, eqRefs: parsed.citations.filter((c) => c.kind === 'equation').length }).toEqual({ task, eqRefs: entry.expect.eqRefs });
      expect({ task, issues: parsed.issues }).toEqual({ task, issues: [] });
      if (entry.expect.labels) expect({ task, labels: parsed.blocks.map((b) => b.label ?? null) }).toEqual({ task, labels: entry.expect.labels });
      if (entry.expect.glossary !== undefined) expect(parsed.glossary).toHaveLength(entry.expect.glossary);
    }
    for (const [name, entry] of Object.entries(manifest.adversarial)) {
      const parsed = parseAnswer(readMockFile(entry.file));
      expect({ name, quotes: parsed.citations.filter((c) => c.kind === 'quote').length }).toEqual({ name, quotes: entry.expect.quotes });
      expect(parsed.issues.length, name).toBeGreaterThanOrEqual(entry.expect.minIssues);
      if (entry.expect.labels) expect({ name, labels: parsed.blocks.map((b) => b.label ?? null) }).toEqual({ name, labels: entry.expect.labels });
      if (name === 'forged_links') expect(parsed.displayMd).toContain('\\[❝1\\](#sp-cite-1)'); // model-written chip neutralised
    }
  });
});
