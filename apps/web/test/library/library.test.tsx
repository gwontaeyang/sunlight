// Library (BRIEF_C M1-5): import → job progress → list refresh, existing-version notice, failure + retry,
// re-subscribe after reload with lastJob.id. fetch is stubbed; responses follow contracts/api.ts and sse.ts.
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../../src/api/queryClient';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { applyJobEvent, type JobProgress } from '../../src/library/jobs';
import { existingVersionNotice, LibraryPage, paperStatusLabel } from '../../src/library/LibraryPage';

const base = {
  source: 'arxiv',
  arxivId: '2209.15397',
  arxivVersion: 2,
  authors: ['Ignacio Vizzo', 'Tiziano Guadagnino', 'Benedikt Mersch', 'Louis Wiesmann'],
  year: 2023,
  status: 'inbox',
  pageCount: 8,
  collectionId: null,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: null,
  structureSource: null,
  supplementVersion: null,
  structureUpgradeAvailable: false,
};
const paper = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  ...base,
  id,
  title,
  ingestStatus: 'done',
  state: { readable: true, contextReady: true, structureReady: false },
  ai: { available: true, reason: null },
  ...over,
});
const detail = (p: ReturnType<typeof paper>, lastJob: unknown = null) => ({
  ...p,
  abstract: null,
  doi: null,
  venue: null,
  primaryCategory: null,
  publishedAt: null,
  codeUrl: null,
  projectUrl: null,
  citationCount: null,
  structureSource: null,
  contextMode: null,
  ingestWarnings: [],
  readableAt: null,
  contextReadyAt: null,
  structureReadyAt: null,
  lastPosition: null,
  lastJob,
  structureUpgrade: { available: false, reason: null, job: null },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events: SseEvent[]) => new Response(events.map((e) => formatSseEvent(e)).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;
const calls: { method: string; url: string; body?: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const h = routes[`${method} ${url}`];
      if (!h) return json({ error: { code: 'not_found', message: `no mock for ${method} ${url}` } }, 404);
      return h(url, init);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderLibrary() {
  const qc = createAppQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <LibraryPage />
    </QueryClientProvider>,
  );
}

describe('helpers', () => {
  it('paperStatusLabel covers the 4 user states', () => {
    expect(paperStatusLabel({ ingestStatus: 'running', state: { readable: false, contextReady: false, structureReady: false } }).label).toBe('가져오는 중');
    expect(paperStatusLabel({ ingestStatus: 'running', state: { readable: true, contextReady: false, structureReady: false } }).label).toBe('색인 준비 중');
    expect(paperStatusLabel({ ingestStatus: 'done', state: { readable: true, contextReady: true, structureReady: false } }).label).toBe('AI 사용 가능');
    expect(paperStatusLabel({ ingestStatus: 'failed', state: { readable: true, contextReady: false, structureReady: false } }).label).toBe('실패');
    // M1.1 M5: ready files but no AI with the current LLM.
    expect(paperStatusLabel({ ingestStatus: 'done', state: { readable: true, contextReady: true, structureReady: true }, ai: { available: false, reason: 'text_mode_pages' } })).toEqual({ label: '읽기 가능 · AI 미지원', tone: 'warn' });
    expect(paperStatusLabel({ ingestStatus: 'done', state: { readable: true, contextReady: true, structureReady: true }, ai: { available: true, reason: null } }).label).toBe('AI 사용 가능');
  });
  it('existingVersionNotice explains a version mismatch', () => {
    expect(existingVersionNotice({ paperId: 'p', jobId: null, existing: true, existingVersion: 1, requestedVersion: 2 })).toContain('v1');
    expect(existingVersionNotice({ paperId: 'p', jobId: null, existing: true })).toBe('이미 Library에 있는 논문입니다.');
    expect(existingVersionNotice({ paperId: 'p', jobId: 'j', existing: false })).toBeNull();
  });
  it('applyJobEvent keeps the latest status per step and the reached states', () => {
    let p: JobProgress = { jobId: 'j', paperId: 'p', steps: [], states: [], phase: 'running' };
    p = applyJobEvent(p, { event: 'job.step', data: { step: 'pdf', status: 'running' } });
    p = applyJobEvent(p, { event: 'job.step', data: { step: 'pdf', status: 'ok' } });
    p = applyJobEvent(p, { event: 'job.state', data: { state: 'readable' } });
    p = applyJobEvent(p, { event: 'job.state', data: { state: 'readable' } });
    p = applyJobEvent(p, { event: 'job.error', data: { code: 'too_large', message: '너무 큼' } });
    expect(p).toMatchObject({ steps: [{ step: 'pdf', status: 'ok' }], states: ['readable'], phase: 'error', error: '너무 큼 (too_large)' });
  });
});

describe('LibraryPage', () => {
  it('import → job steps and states → list refreshed with the new paper', async () => {
    const newId = '11111111-1111-4111-8111-111111111111';
    let listCalls = 0;
    routes['GET /api/papers'] = () => json({ papers: listCalls++ === 0 ? [] : [paper(newId, 'KISS-ICP')] });
    routes['POST /api/papers/import'] = () => json({ paperId: newId, jobId: 'job-1', existing: false });
    routes['GET /api/jobs/job-1/events'] = () =>
      sse([
        { event: 'job.step', data: { step: 'resolve', status: 'ok' } },
        { event: 'job.step', data: { step: 'pdf', status: 'ok' } },
        { event: 'job.state', data: { state: 'readable' } },
        { event: 'job.step', data: { step: 'supplement', status: 'ok' } },
        { event: 'job.state', data: { state: 'context_ready' } },
        { event: 'job.done', data: { paperId: newId } },
      ]);
    renderLibrary();
    await screen.findByText('아직 논문이 없습니다.');
    fireEvent.change(screen.getByTestId('import-input'), { target: { value: ' 2209.15397v2 ' } });
    fireEvent.click(screen.getByTestId('import-button'));
    const row = await screen.findByText('KISS-ICP');
    const li = row.closest('li')!;
    expect(within(li).getByTestId('paper-status').textContent).toBe('AI 사용 가능');
    await waitFor(() => expect(within(li).getByTestId('job-steps').textContent).toContain('AI 색인: 완료'));
    const imp = calls.find((c) => c.url === '/api/papers/import')!;
    expect(imp.body).toMatchObject({ input: '2209.15397v2' });
    expect((imp.body as { clientRequestId: string }).clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows the version notice when the paper exists in another version', async () => {
    routes['GET /api/papers'] = () => json({ papers: [] });
    routes['POST /api/papers/import'] = () => json({ paperId: 'p1', jobId: null, existing: true, existingVersion: 1, requestedVersion: 2 });
    renderLibrary();
    fireEvent.change(await screen.findByTestId('import-input'), { target: { value: '2209.15397v2' } });
    fireEvent.click(screen.getByTestId('import-button'));
    expect((await screen.findByTestId('import-message')).textContent).toContain('v1');
    expect(calls.some((c) => c.url.startsWith('/api/jobs/'))).toBe(false);
  });

  it('failed paper: shows lastJob.error and retries (re-subscribes to the new job)', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const failed = paper(id, 'FAST-LIO2', { ingestStatus: 'failed', state: { readable: false, contextReady: false, structureReady: false }, ai: { available: false, reason: 'context_not_ready' } });
    routes['GET /api/papers'] = () => json({ papers: [failed] });
    routes[`GET /api/papers/${id}`] = () => json(detail(failed, { id: 'job-0', kind: 'import_arxiv', paperId: id, status: 'failed', steps: [{ step: 'pdf', status: 'error' }], error: 'network: PDF 다운로드 실패 (HTTP 503)' }));
    routes[`POST /api/papers/${id}/retry-ingest`] = () => json({ jobId: 'job-2' });
    routes['GET /api/jobs/job-2/events'] = () => sse([{ event: 'job.step', data: { step: 'pdf', status: 'running' } }, { event: 'job.error', data: { code: 'network', message: '다시 실패' } }]);
    renderLibrary();
    expect((await screen.findByTestId('paper-error')).textContent).toBe('PDF 다운로드 실패 (HTTP 503) (network)');
    expect(screen.getByTestId('paper-status').textContent).toBe('실패');
    fireEvent.click(screen.getByTestId('paper-retry'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/jobs/job-2/events')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('paper-error').textContent).toBe('다시 실패 (network)'));
  });

  it('after a reload, a running paper is re-subscribed with lastJob.id', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const running = paper(id, 'Running', { ingestStatus: 'running', state: { readable: true, contextReady: false, structureReady: false }, ai: { available: false, reason: 'context_not_ready' } });
    routes['GET /api/papers'] = () => json({ papers: [running] });
    routes[`GET /api/papers/${id}`] = () => json(detail(running, { id: 'job-r', kind: 'import_arxiv', paperId: id, status: 'running', steps: [{ step: 'pdf', status: 'ok' }], error: null }));
    routes['GET /api/jobs/job-r/events'] = () => sse([{ event: 'job.step', data: { step: 'supplement', status: 'running' } }, { event: 'job.done', data: { paperId: id } }]);
    renderLibrary();
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/jobs/job-r/events')).toHaveLength(1));
    expect(screen.getByTestId('paper-status').textContent).toBe('색인 준비 중');
  });

  it('delete asks for confirmation first', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    let deleted = false;
    routes['GET /api/papers'] = () => json({ papers: deleted ? [] : [paper(id, 'To delete')] });
    routes[`DELETE /api/papers/${id}`] = () => ((deleted = true), new Response(null, { status: 204 }));
    renderLibrary();
    fireEvent.click(await screen.findByTestId('paper-delete'));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByTestId('paper-delete-confirm'));
    await screen.findByText('아직 논문이 없습니다.');
  });
  // M1.1 M5: a ready paper the current LLM cannot use says so before any click (boundary values come from the server).
  it('a 41-page paper (contextMode text) is "읽기 가능 · AI 미지원" with the reason, not "AI 사용 가능"', async () => {
    const big = paper('55555555-5555-4555-8555-555555555555', 'Long paper', { pageCount: 41, ai: { available: false, reason: 'text_mode_pages' } });
    const huge = paper('66666666-6666-4666-8666-666666666666', 'Huge PDF', { pageCount: 12, ai: { available: false, reason: 'text_mode_bytes' } });
    const ok = paper('77777777-7777-4777-8777-777777777777', 'Forty pages', { pageCount: 40, ai: { available: true, reason: null } });
    routes['GET /api/papers'] = () => json({ papers: [big, huge, ok] });
    renderLibrary();
    const rowOf = async (t: string) => (await screen.findByText(t)).closest('li')!;
    const bigRow = await rowOf('Long paper');
    expect(within(bigRow).getByTestId('paper-status').textContent).toBe('읽기 가능 · AI 미지원');
    expect(within(bigRow).getByTestId('paper-ai-reason').textContent).toBe('AI 미지원: 41쪽 이상(41쪽) 논문 — M3 예정. 읽기·하이라이트는 사용할 수 있습니다.');
    const hugeRow = await rowOf('Huge PDF');
    expect(within(hugeRow).getByTestId('paper-ai-reason').textContent).toContain('PDF 15 MiB 초과 — M3 예정');
    const okRow = await rowOf('Forty pages');
    expect(within(okRow).getByTestId('paper-status').textContent).toBe('AI 사용 가능');
    expect(within(okRow).queryByTestId('paper-ai-reason')).toBeNull();
  });
});
