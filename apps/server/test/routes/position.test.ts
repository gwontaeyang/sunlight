// Owner A. papers.position (M2, PLAN_M2 3.8): PUT → 204, papers.get.lastPosition returns it, lastOpenedAt is set; a page
// beyond pageCount → 400; a paper without pages → 409; an M1 value ({page, zoom}) still reads with the defaults.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaperDetailDto } from '@study-paper/shared/contracts/api';
import { papers } from '../../src/db/schema';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { startTestServer, type TestServer } from '../helpers/server';

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer({ env: 'test', papers: ['links', 'm2'] });
});
afterAll(async () => {
  await s.close();
});
const put = async (id: string, body: unknown) => (await s.req(`/api/papers/${id}/position`, { method: 'PUT', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status;
const detail = async (id: string) => JSON.parse((await s.req(`/api/papers/${id}`, { headers: { 'X-SP-Token': s.token } })).text) as PaperDetailDto;

describe('papers.position', () => {
  it('stores {page, zoom, mode, top} and lastOpenedAt; the last write wins', async () => {
    expect((await detail(SEED_M2_PAPER_ID)).lastOpenedAt).toBeNull();
    const t0 = Date.now();
    expect(await put(SEED_M2_PAPER_ID, { page: 1, zoom: 1, mode: 'page-width', top: 0.1 })).toBe(204);
    expect(await put(SEED_M2_PAPER_ID, { page: 2, zoom: 1.5, mode: 'custom', top: 0.75 })).toBe(204);
    const d = await detail(SEED_M2_PAPER_ID);
    expect(d.lastPosition).toEqual({ page: 2, zoom: 1.5, mode: 'custom', top: 0.75 });
    expect(d.lastOpenedAt!).toBeGreaterThanOrEqual(t0);
    expect(await put(SEED_M2_PAPER_ID, { page: 2, zoom: 1 })).toBe(204); // mode/top default
    expect((await detail(SEED_M2_PAPER_ID)).lastPosition).toEqual({ page: 2, zoom: 1, mode: 'custom', top: 0 });
  });
  it('page beyond pageCount → 400; a paper without pages → 409; unknown → 404', async () => {
    expect(await put(SEED_M2_PAPER_ID, { page: 3, zoom: 1 })).toBe(400);
    const id = crypto.randomUUID();
    s.deps.db.insert(papers).values({ id, source: 'arxiv', arxivId: '2301.77770', title: 't', ingestStatus: 'running', createdAt: 1, updatedAt: 1 }).run();
    expect(await put(id, { page: 1, zoom: 1 })).toBe(409);
    expect(await put('00000000-0000-4000-8000-00000000dead', { page: 1, zoom: 1 })).toBe(404);
  });
});
