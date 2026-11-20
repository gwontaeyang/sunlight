// e2e/helpers.ts contract checks (BRIEF_S S10). Owner: supervisor. Runs in the root vitest project `e2e-helpers`
// (npm test), never in Playwright (testMatch '**/*.spec.ts').
import { describe, expect, it } from 'vitest';
import type { PaperDetailDto } from '../packages/shared/src/contracts/api';
import type { SseEvent } from '../packages/shared/src/contracts/sse';
import * as seed from '../apps/server/src/dev/seedFixture';
import { startTestServer } from '../apps/server/test/helpers/server';
import {
  checkMockReply,
  checkMockRequest,
  createMockStore,
  deletePapersByArxivId,
  makeTestPng,
  makeTestPngBase64,
  mockSse,
  OFFLINE_ARXIV,
  OFFLINE_ARXIV_K1,
  offlineAtomFeed,
  offlineAtomFeedOf,
  pngSize,
  realJson,
  RESET_POSITION,
  resetSeedState,
  routePath,
  routeUrlPattern,
  SEED_LINKS_PAPER_ID,
  SEED_LINKS_TITLE,
  SEED_M2_PAPER_ID,
  SEED_M2_TITLE,
  SEED_PAPER_ID,
  SEED_TITLE,
  SEED_UPGRADE_PAPER_ID,
  SEED_UPGRADE_TITLE,
  tokenFromHtml,
} from './helpers';
import { readFileSync } from 'node:fs';
import { injectToken } from '../apps/server/src/web';
import { generateToken } from '../apps/server/src/security/token';
import { tokenFromHtml as scriptTokenFromHtml } from '../scripts/lib/localApi';

const ID = SEED_M2_PAPER_ID;
const accepted: SseEvent = { event: 'run.accepted', data: { runId: 'r', task: 'notation_card', artifactId: 'c' } };
const errorEv: SseEvent = { event: 'run.error', data: { code: 'parse_failed', message: 'x', retryable: false } };

describe('seed constants match the server seeds', () => {
  it('ids and titles', () => {
    expect([SEED_PAPER_ID, SEED_TITLE, SEED_M2_PAPER_ID, SEED_M2_TITLE, SEED_UPGRADE_PAPER_ID, SEED_UPGRADE_TITLE, SEED_LINKS_PAPER_ID, SEED_LINKS_TITLE]).toEqual([
      seed.SEED_PAPER_ID,
      seed.SEED_TITLE,
      seed.SEED_M2_PAPER_ID,
      seed.SEED_M2_TITLE,
      seed.SEED_UPGRADE_PAPER_ID,
      seed.SEED_UPGRADE_TITLE,
      seed.SEED_LINKS_PAPER_ID,
      seed.SEED_LINKS_TITLE,
    ]);
  });
});

describe('checkMockReply', () => {
  it('json: the response schema decides; a wrong shape or a non-2xx json reply fails', () => {
    expect(() => checkMockReply('papers.upgradeStructure', { kind: 'json', body: { jobId: 'j1' } })).not.toThrow();
    expect(() => checkMockReply('papers.upgradeStructure', { kind: 'json', body: { job: 'j1' } })).toThrow();
    expect(() => checkMockReply('papers.upgradeStructure', { kind: 'json', body: { jobId: 'j1' }, status: 409 })).toThrow(/2xx/);
    expect(() => checkMockReply('papers.structure', { kind: 'json', body: { structureSource: null, sections: [], equations: [], figures: [], references: [] } })).not.toThrow();
    expect(() => checkMockReply('papers.structure', { kind: 'json', body: { sections: [] } })).toThrow();
  });

  it('errors: the error DTO and the status of its code', () => {
    expect(() => checkMockReply('cards.generate', { kind: 'error', status: 409, code: 'conflict', details: { reason: 'card_generating', runId: 'r', cardId: 'c' } })).not.toThrow();
    expect(() => checkMockReply('cards.generate', { kind: 'error', status: 400, code: 'conflict' })).toThrow(/status 409/);
  });

  it('the reply kind must be the route kind', () => {
    expect(() => checkMockReply('papers.structure', { kind: 'sse', events: [accepted, errorEv] })).toThrow(/answers json/);
    expect(() => checkMockReply('papers.position', { kind: 'empty' })).not.toThrow();
    expect(() => checkMockReply('papers.position', { kind: 'json', body: {} })).toThrow();
  });

  it('sse: starts with run.accepted, exactly one terminal, terminal last, events parse; job streams likewise', () => {
    expect(() => checkMockReply('cards.generate', { kind: 'sse', events: [accepted, { event: 'run.retrying', data: { reason: 'validation', errors: ['item 1: label must be P, N or G'] } }, errorEv] })).not.toThrow();
    expect(() => checkMockReply('cards.generate', { kind: 'sse', events: [errorEv] })).toThrow(/run.accepted/);
    expect(() => checkMockReply('cards.generate', { kind: 'sse', events: [accepted] })).toThrow(/terminal/);
    expect(() => checkMockReply('cards.generate', { kind: 'sse', events: [accepted, errorEv, errorEv] })).toThrow(/terminal/);
    expect(() => checkMockReply('cards.generate', { kind: 'sse', events: [accepted, errorEv, { event: 'run.delta', data: { text: 'x' } }] })).toThrow();
    expect(() => checkMockReply('cards.generate', { kind: 'sse', events: [accepted, { event: 'run.delta', data: { nope: 1 } } as unknown as SseEvent, errorEv] })).toThrow();
    expect(() => checkMockReply('cards.generate', { kind: 'sse', events: [] })).toThrow(/empty/);
    expect(() => checkMockReply('jobs.events', { kind: 'sse', events: [{ event: 'job.step', data: { step: 'html', status: 'ok' } }, { event: 'job.done', data: { paperId: ID } }] })).not.toThrow();
    expect(() => checkMockReply('jobs.events', { kind: 'sse', events: [accepted, { event: 'job.done', data: { paperId: ID } }] })).toThrow(/in a job stream/);
  });

  it('png: inspectPng must pass (a broken CRC or a non-PNG fails)', () => {
    const png = makeTestPng({ width: 20, height: 12 });
    expect(() => checkMockReply('papers.capture', { kind: 'png', body: png })).not.toThrow();
    const broken = Buffer.from(png);
    broken[broken.length - 1]! ^= 1;
    expect(() => checkMockReply('papers.capture', { kind: 'png', body: broken })).toThrow(/inspectPng/);
    expect(() => checkMockReply('papers.capture', { kind: 'png', body: Buffer.from('not a png') })).toThrow();
    expect(pngSize(makeTestPngBase64({ width: 33, height: 9 }))).toEqual({ width: 33, height: 9 });
  });
});

describe('checkMockRequest and URL patterns', () => {
  it('request params / body are validated with the contract', () => {
    expect(() => checkMockRequest('papers.position', { params: { id: ID }, query: {}, body: { page: 2, zoom: 1, mode: 'page-width', top: 0.25 } })).not.toThrow();
    expect(() => checkMockRequest('papers.position', { params: { id: ID }, query: {}, body: { page: 0, zoom: 1 } })).toThrow();
    expect(() => checkMockRequest('papers.structure', { params: { id: ID }, query: {}, body: { x: 1 } })).toThrow(/no JSON body/);
    expect(() => checkMockRequest('papers.capture', { params: { id: ID, fileId: 'f1' }, query: {}, body: undefined })).not.toThrow();
  });
  it('route URL patterns capture the params and ignore other paths', () => {
    const re = routeUrlPattern('papers.capture');
    expect(re.exec(`http://127.0.0.1:4511/api/papers/${ID}/captures/f-1?x=1`)?.groups).toEqual({ id: ID, fileId: 'f-1' });
    expect(re.test(`http://127.0.0.1:4511/api/papers/${ID}/captures`)).toBe(false);
    expect(routeUrlPattern('papers.get').test(`http://127.0.0.1:4511/api/papers/${ID}/structure`)).toBe(false);
  });
  it('mockSse frames every event', () => {
    expect(mockSse([accepted, errorEv]).split('\n\n').filter(Boolean)).toHaveLength(2);
  });
});

describe('createMockStore', () => {
  it('a position PUT survives a "reload" and comes back through papers.get; values are copies', () => {
    const store = createMockStore({ position: null });
    const put = { page: 3, zoom: 1.25, mode: 'page-width' as const, top: 0.4 };
    checkMockRequest('papers.position', { params: { id: ID }, query: {}, body: put });
    store.set('position', put);
    put.page = 99; // the stored copy is not affected
    const detail = (lastPosition: unknown) => ({
      id: ID, source: 'arxiv', arxivId: '2301.00004', arxivVersion: 1, title: SEED_M2_TITLE, authors: ['Test Author'], year: 2023, status: 'inbox', ingestStatus: 'done',
      state: { readable: true, contextReady: true, structureReady: true }, ai: { available: true, reason: null }, pageCount: 2, collectionId: null, tags: [], createdAt: 1, updatedAt: 1, lastOpenedAt: null,
      structureSource: 'latexml', supplementVersion: 2, structureUpgradeAvailable: false, abstract: null, doi: null, venue: null, primaryCategory: null, publishedAt: null, codeUrl: null, projectUrl: null, citationCount: null, contextMode: 'pdf',
      ingestWarnings: [], readableAt: 1, contextReadyAt: 1, structureReadyAt: 1, lastPosition, lastJob: null, structureUpgrade: { available: false, reason: null, job: null },
    }) satisfies Omit<PaperDetailDto, 'lastPosition'> & { lastPosition: unknown };
    const reply = { kind: 'json' as const, body: detail(store.get('position')) };
    expect(() => checkMockReply('papers.get', reply)).not.toThrow();
    expect((reply.body.lastPosition as { page: number }).page).toBe(3);
    expect(store.update<number>('progressPuts', (n) => (n ?? 0) + 1)).toBe(1);
    expect(store.keys().sort()).toEqual(['position', 'progressPuts']);
    store.delete('position');
    expect(store.has('position')).toBe(false);
  });
});

describe('routePath and realJson (a real response, contract-checked, for mocks that change a field or two)', () => {
  it('routePath fills and encodes params and appends the query; a missing param throws', () => {
    expect(routePath('papers.get', { id: ID })).toBe(`/api/papers/${ID}`);
    expect(routePath('papers.capture', { id: ID, fileId: 'a b' })).toBe(`/api/papers/${ID}/captures/a%20b`);
    expect(routePath('papers.list', {}, { q: 'x y' })).toBe('/api/papers?q=x+y');
    expect(() => routePath('papers.get', {})).toThrow(/missing param id/);
  });

  it('realJson: papers.get / papers.list / papers.structure from a real server parse with the response schemas; non-json routes, bad requests and non-2xx answers throw', async () => {
    const s = await startTestServer({ env: 'prod', papers: ['m1', 'm2'] });
    try {
      const baseURL = `http://127.0.0.1:${s.port}`;
      const detail = await realJson<PaperDetailDto>(baseURL, 'papers.get', { params: { id: SEED_M2_PAPER_ID }, token: s.token });
      expect(detail.id).toBe(SEED_M2_PAPER_ID);
      const list = await realJson<{ papers: { id: string }[] }>(baseURL, 'papers.list', { token: s.token });
      expect(list.papers.map((p) => p.id)).toEqual(expect.arrayContaining([SEED_PAPER_ID, SEED_M2_PAPER_ID]));
      await expect(realJson(baseURL, 'papers.structure', { params: { id: SEED_M2_PAPER_ID }, token: s.token })).resolves.toBeTruthy();
      await expect(realJson(baseURL, 'papers.pdf', { params: { id: SEED_PAPER_ID }, token: s.token })).rejects.toThrow(/not json/);
      await expect(realJson(baseURL, 'papers.position', { params: { id: ID }, body: { page: 0, zoom: 1 }, token: s.token })).rejects.toThrow();
      await expect(realJson(baseURL, 'papers.get', { params: { id: '99999999-9999-4999-8999-999999999999' }, token: s.token })).rejects.toThrow(/answered 404/);
    } finally {
      await s.close();
    }
  }, 30_000);
});

describe('resetSeedState', () => {
  it('clears highlights and threads of the given papers only; the default is the M1 seed paper', async () => {
    const s = await startTestServer({ env: 'prod', papers: ['m1', 'm2', 'links'] });
    try {
      const baseURL = `http://127.0.0.1:${s.port}`;
      const send = (method: string, path: string, body?: unknown) =>
        s.req(`/api${path}`, { method, headers: { 'X-SP-Token': s.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const count = async (paperId: string) => ({
        highlights: (JSON.parse((await send('GET', `/papers/${paperId}/highlights`)).text) as { highlights: unknown[] }).highlights.length,
        threads: (JSON.parse((await send('GET', `/papers/${paperId}/threads`)).text) as { threads: unknown[] }).threads.length,
      });
      const papers = [SEED_PAPER_ID, SEED_M2_PAPER_ID, SEED_LINKS_PAPER_ID];
      const fill = async () => {
        for (const id of papers) {
          const h = await send('POST', `/papers/${id}/highlights`, { kind: 'text', color: 1, quote: { exact: 'robust kernel' }, page: 1, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }] });
          expect(h.status, h.text).toBe(200);
          const t = await send('POST', `/papers/${id}/threads`, { kind: 'chat', question: 'q', clientRequestId: crypto.randomUUID() });
          expect(t.status, t.text).toBe(200);
          expect(await count(id)).toEqual({ highlights: 1, threads: 1 });
        }
      };
      await fill();
      await resetSeedState(baseURL, undefined, s.token);
      expect(await count(SEED_PAPER_ID)).toEqual({ highlights: 0, threads: 0 });
      expect(await count(SEED_M2_PAPER_ID)).toEqual({ highlights: 1, threads: 1 });
      expect(await count(SEED_LINKS_PAPER_ID)).toEqual({ highlights: 1, threads: 1 });
      await resetSeedState(baseURL, [SEED_M2_PAPER_ID, SEED_LINKS_PAPER_ID, '99999999-9999-4999-8999-999999999999'], s.token);
      for (const id of papers) expect(await count(id), id).toEqual({ highlights: 0, threads: 0 });
    } finally {
      await s.close();
    }
  }, 30_000);

  it('M2: resets the saved reading position of the given papers only (page width, top of page 1)', async () => {
    const s = await startTestServer({ env: 'prod', papers: ['m1', 'm2', 'links'] });
    try {
      const baseURL = `http://127.0.0.1:${s.port}`;
      const send = (method: string, path: string, body?: unknown) =>
        s.req(`/api${path}`, { method, headers: { 'X-SP-Token': s.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const lastPosition = async (paperId: string) => (JSON.parse((await send('GET', `/papers/${paperId}`)).text) as { lastPosition: unknown }).lastPosition;
      const scrolled = { page: 2, zoom: 1.5, mode: 'custom', top: 0.75 };
      for (const id of [SEED_PAPER_ID, SEED_M2_PAPER_ID]) {
        const r = await send('PUT', `/papers/${id}/position`, scrolled);
        expect(r.status, r.text).toBe(204);
        expect(await lastPosition(id)).toEqual(scrolled);
      }
      await resetSeedState(baseURL, undefined, s.token);
      expect(await lastPosition(SEED_PAPER_ID)).toEqual(RESET_POSITION);
      expect(await lastPosition(SEED_M2_PAPER_ID)).toEqual(scrolled);
      // a missing paper (404) is skipped, not an error
      await resetSeedState(baseURL, [SEED_M2_PAPER_ID, '99999999-9999-4999-8999-999999999999'], s.token);
      expect(await lastPosition(SEED_M2_PAPER_ID)).toEqual(RESET_POSITION);
    } finally {
      await s.close();
    }
  }, 30_000);
});

describe('M2 integration K1 helpers (BRIEF_INTEGRATION I3)', () => {
  it('OFFLINE_ARXIV_K1 is an id of its own; offlineAtomFeedOf gives the M1 feed for OFFLINE_ARXIV', () => {
    expect(offlineAtomFeedOf(OFFLINE_ARXIV)).toBe(offlineAtomFeed());
    const taken = [OFFLINE_ARXIV.id, ...Object.values(seed.SEED_ARXIV_IDS), ...seed.SEED_M2_STRUCTURE.references.map((r) => r.arxivId)];
    expect(taken).not.toContain(OFFLINE_ARXIV_K1.id);
    expect(offlineAtomFeedOf(OFFLINE_ARXIV_K1)).toContain(`<id>http://arxiv.org/abs/${OFFLINE_ARXIV_K1.id}v${OFFLINE_ARXIV_K1.version}</id>`);
    expect(offlineAtomFeedOf(OFFLINE_ARXIV_K1)).toContain(`<title>${OFFLINE_ARXIV_K1.title}</title>`);
  });

  it('deletePapersByArxivId deletes the listed papers with that arXiv id only and counts them', async () => {
    const s = await startTestServer({ env: 'prod', papers: ['m1', 'm2', 'links'] });
    try {
      const baseURL = `http://127.0.0.1:${s.port}`;
      const ids = async () => (JSON.parse((await s.req('/api/papers', { headers: { 'X-SP-Token': s.token } })).text) as { papers: { id: string }[] }).papers.map((p) => p.id).sort();
      expect(await ids()).toEqual([SEED_PAPER_ID, SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID].sort());
      expect(await deletePapersByArxivId(baseURL, seed.SEED_ARXIV_IDS.m2, s.token)).toBe(1);
      expect(await ids()).toEqual([SEED_PAPER_ID, SEED_LINKS_PAPER_ID].sort());
      expect(await deletePapersByArxivId(baseURL, seed.SEED_ARXIV_IDS.m2, s.token)).toBe(0);
      expect(await deletePapersByArxivId(baseURL, OFFLINE_ARXIV_K1.id, s.token)).toBe(0);
      expect(await ids()).toEqual([SEED_PAPER_ID, SEED_LINKS_PAPER_ID].sort());
    } finally {
      await s.close();
    }
  }, 30_000);
});

describe('token from the prod HTML: e2e/helpers.ts and scripts/lib/localApi.ts agree (BRIEF_INTEGRATION script rule)', () => {
  it('same value on the server-injected index.html and on hand-made variants; both throw without the meta', () => {
    const token = generateToken();
    const indexHtml = readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8');
    const served = injectToken(indexHtml, token);
    expect(tokenFromHtml(served)).toBe(token);
    expect(scriptTokenFromHtml(served)).toBe(token);
    for (const html of ['<meta name="sp-token" content="">', '<head><meta name="sp-token" content="0a1b"><meta name="sp-token" content="ff"></head>', '<meta name="sp-token" content="ABC">', '<meta content="ab" name="sp-token">']) {
      let a: string | Error;
      let b: string | Error;
      try {
        a = tokenFromHtml(html);
      } catch (e) {
        a = e as Error;
      }
      try {
        b = scriptTokenFromHtml(html);
      } catch (e) {
        b = e as Error;
      }
      expect(typeof a === 'string' ? a : 'throw', html).toBe(typeof b === 'string' ? b : 'throw');
    }
    expect(() => tokenFromHtml('<html></html>')).toThrow();
    expect(() => scriptTokenFromHtml('<html></html>')).toThrow();
  });
});
