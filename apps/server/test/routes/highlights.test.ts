// highlights.* (PLAN 5.3): the server computes `position` (verbatim on that page only), rects stay on `page`,
// and highlights survive a server restart. No network.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeN1 } from '@study-paper/shared/anchor/normalize';
import type { HighlightDto } from '@study-paper/shared/contracts/api';
import { ErrorDtoSchema } from '@study-paper/shared/contracts/errors';
import { pageTexts, papers } from '../../src/db/schema';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { seedDataDir, serverEnv, startWithPortRetry, stopProcess, waitFor } from '../helpers/proc';
import { freePort, startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';

const rect = (page: number, y = 0.2) => ({ page, x: 0.1, y, w: 0.5, h: 0.02 });

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer({ env: 'prod', seed: true });
});
afterAll(async () => {
  await s.close();
});

async function call(method: string, path: string, body?: unknown) {
  const r = await s.req(`/api${path}`, { method, headers: { 'X-SP-Token': s.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: r.text ? (JSON.parse(r.text) as unknown) : null };
}
const create = (body: Record<string, unknown>) => call('POST', `/papers/${SEED_PAPER_ID}/highlights`, { kind: 'text', color: 1, ...body });
const pageText = (page: number) => s.deps.db.select({ text: pageTexts.text }).from(pageTexts).where(eq(pageTexts.paperId, SEED_PAPER_ID)).all()[page - 1]!.text;

describe('highlights.create position', () => {
  it('verbatim on the page → position whose text is the quote', async () => {
    const r = await create({ quote: { exact: 'fixed threshold of 0.5 m' }, page: 1, rects: [rect(1)] });
    expect(r.status).toBe(200);
    const h = r.json as HighlightDto;
    expect(h.position).toMatchObject({ page: 1 });
    expect(normalizeN1(pageText(1).slice(h.position!.start, h.position!.end)).text).toBe(normalizeN1('fixed threshold of 0.5 m').text);
    expect(h).toMatchObject({ kind: 'text', color: 1, page: 1, sectionId: null, comment: null, imageFileId: null, quote: { exact: 'fixed threshold of 0.5 m' } });
  });

  it('a line-end hyphen in the PDF still matches (data asso-\\nciation)', async () => {
    const h = (await create({ quote: { exact: 'data association uses' }, page: 1, rects: [rect(1)] })).json as HighlightDto;
    expect(h.position?.page).toBe(1);
  });

  it('quote that exists only on another page → position null (no cross-page search)', async () => {
    const h = (await create({ quote: { exact: 'fixed threshold of 0.5 m' }, page: 2, rects: [rect(2)] })).json as HighlightDto;
    expect(h.position).toBeNull();
    expect(h.quote).toEqual({ exact: 'fixed threshold of 0.5 m' });
  });

  it('ambiguous on the page → null; prefix/suffix that single it out → verbatim', async () => {
    expect(((await create({ quote: { exact: 'robust kernel' }, page: 2, rects: [rect(2)] })).json as HighlightDto).position).toBeNull();
    const first = (await create({ quote: { exact: 'robust kernel', prefix: 'The ' }, page: 2, rects: [rect(2)] })).json as HighlightDto;
    const second = (await create({ quote: { exact: 'robust kernel', prefix: 'without the ' }, page: 2, rects: [rect(2)] })).json as HighlightDto;
    expect(first.position && second.position).toBeTruthy();
    expect(first.position!.start).toBeLessThan(second.position!.start);
    expect(first.quote).toEqual({ exact: 'robust kernel', prefix: 'The ' });
  });

  it('a changed number is not verbatim → null', async () => {
    expect(((await create({ quote: { exact: 'fixed threshold of 0.6 m' }, page: 1, rects: [rect(1)] })).json as HighlightDto).position).toBeNull();
  });
});

describe('highlights.create validation', () => {
  it.each([
    ['rect on another page', { quote: { exact: 'robust kernel' }, page: 1, rects: [rect(1), rect(2)] }],
    // M2 (BRIEF_A A8): an area highlight is allowed with exactly one rect — two rects stay a 400.
    ['area kind with two rects (M2: exactly one rect)', { kind: 'area', page: 1, rects: [rect(1), rect(1)] }],
    ['page beyond the paper', { quote: { exact: 'x' }, page: 3, rects: [rect(3)] }],
    ['text without quote', { page: 1, rects: [rect(1)] }],
    ['no rects', { quote: { exact: 'x' }, page: 1, rects: [] }],
    ['rect outside the page', { quote: { exact: 'x' }, page: 1, rects: [{ page: 1, x: 0.9, y: 0.1, w: 0.5, h: 0.1 }] }],
    ['client-sent offsets are ignored, not trusted', { quote: { exact: 'x' }, page: 1, rects: [rect(1)], position: { page: 1, start: 0, end: 1 } }],
  ])('%s', async (name, body) => {
    const r = await create(body);
    if (name.startsWith('client-sent')) {
      expect(r.status).toBe(200);
      expect((r.json as HighlightDto).position).toBeNull(); // 'x' alone is ambiguous on page 1
      return;
    }
    expect(r.status).toBe(400);
    expect(ErrorDtoSchema.parse(r.json).error.code).toBe('validation');
  });

  it('paper not readable yet → 409', async () => {
    const id = crypto.randomUUID();
    s.deps.db.insert(papers).values({ id, source: 'arxiv', arxivId: '2301.77777', title: 't', ingestStatus: 'running', createdAt: 1, updatedAt: 1 }).run();
    const r = await call('POST', `/papers/${id}/highlights`, { kind: 'text', color: 1, quote: { exact: 'x' }, page: 1, rects: [rect(1)] });
    expect(r.status).toBe(409);
  });
});

describe('highlights list / patch / delete', () => {
  it('lists by page, patches color + comment (null clears), deletes', async () => {
    const h = (await create({ quote: { exact: 'first-order Jacobian' }, page: 2, rects: [rect(2, 0.5)], comment: '메모' })).json as HighlightDto;
    expect(h.comment).toBe('메모');
    const patched = (await call('PATCH', `/highlights/${h.id}`, { color: 4, comment: null })).json as HighlightDto;
    expect(patched).toMatchObject({ id: h.id, color: 4, comment: null, position: h.position, rects: h.rects });
    expect(patched.updatedAt).toBeGreaterThanOrEqual(h.updatedAt);
    const list = (await call('GET', `/papers/${SEED_PAPER_ID}/highlights`)).json as { highlights: HighlightDto[] };
    const pages = list.highlights.map((x) => x.page);
    expect([...pages].sort((a, b) => a - b)).toEqual(pages);
    expect(list.highlights.find((x) => x.id === h.id)).toEqual(patched);
    expect((await call('DELETE', `/highlights/${h.id}`)).status).toBe(204);
    expect((await call('DELETE', `/highlights/${h.id}`)).status).toBe(404);
    expect((await call('PATCH', `/highlights/${h.id}`, { color: 1 })).status).toBe(404);
  });
});

describe('restart', () => {
  it('highlights read after a real server restart (new process, new DB connection) are identical', async () => {
    const root = tempDir('sp-hl-restart-');
    let port = await freePort();
    const env = serverEnv(root, 'data', port);
    seedDataDir(env);
    const tokenOf = async () => /name="sp-token" content="([0-9a-f]+)"/.exec(await (await fetch(`http://127.0.0.1:${port}/`)).text())![1]!;
    const api = async (token: string, method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'X-SP-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return (await r.json()) as unknown;
    };

    const first = await startWithPortRetry({ ...env, SP_PORT: String(port) }, freePort);
    port = first.port;
    await waitFor(() => first.output().includes('listening on'), 'first start');
    const t1 = await tokenOf();
    await api(t1, 'POST', `/papers/${SEED_PAPER_ID}/highlights`, { kind: 'text', color: 2, quote: { exact: 'constant velocity model' }, page: 1, rects: [rect(1, 0.4)] });
    await api(t1, 'POST', `/papers/${SEED_PAPER_ID}/highlights`, { kind: 'text', color: 3, quote: { exact: 'robust kernel' }, page: 2, rects: [rect(2, 0.3)] });
    const before = await api(t1, 'GET', `/papers/${SEED_PAPER_ID}/highlights`);
    await stopProcess(first.child, 'SIGINT');
    expect(await first.exit).toBe(0);

    const second = await startWithPortRetry({ ...env, SP_PORT: String(port) }, freePort);
    port = second.port;
    await waitFor(() => second.output().includes('listening on'), 'second start');
    const t2 = await tokenOf();
    expect(t2).not.toBe(t1);
    const after = await api(t2, 'GET', `/papers/${SEED_PAPER_ID}/highlights`);
    await stopProcess(second.child, 'SIGINT');
    expect(after).toEqual(before);
    expect((after as { highlights: HighlightDto[] }).highlights.map((h) => h.position === null)).toEqual([false, true]);
  }, 40_000);
});
