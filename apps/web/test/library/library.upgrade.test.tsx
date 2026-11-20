// Library structure badge + upgrade (BRIEF_C C8): three badges from papers.list alone, confirm → papers.upgradeStructure
// → jobs.events steps → done (paper / list / structure invalidated and re-read), a final failure read from
// ingestWarnings (no button), a transient failure read from the job error (code + message, button again, an arXiv
// wait time shown as given), and a reload during an upgrade re-subscribing with structureUpgrade.job.
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../../src/api/queryClient';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListPapersResponse, PaperDetailDto, type JobDto } from '@study-paper/shared/contracts/api';
import { formatSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { LibraryPage } from '../../src/library/LibraryPage';
import { structureBadge } from '../../src/library/StructureUpgrade';
import { classifyUpgradeFailure, finalWarnings, mentionsArxivWait, outcomeOfSettledJob, parseJobError, resetUpgrades, resumeUpgrade, UPGRADE_CONFIRM_TEXT, useUpgradeStore, watchUpgrade } from '../../src/library/upgrade';

const UP = '00000000-0000-4000-8000-000000000002';
const V2 = '00000000-0000-4000-8000-000000000004';
const NONE = '00000000-0000-4000-8000-000000000001';
const JOB = '00000000-0000-4000-8000-00000000000f';

const summary = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  source: 'arxiv',
  arxivId: null,
  arxivVersion: null,
  title,
  authors: ['Test Author'],
  year: 2023,
  status: 'inbox',
  ingestStatus: 'done',
  state: { readable: true, contextReady: true, structureReady: true },
  ai: { available: true, reason: null },
  pageCount: 2,
  collectionId: null,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: null,
  structureSource: 'none',
  supplementVersion: 1,
  structureUpgradeAvailable: false,
  ...over,
});
const detailOf = (s: ReturnType<typeof summary>, over: Record<string, unknown> = {}) =>
  PaperDetailDto.parse({
    ...s,
    abstract: null,
    doi: null,
    venue: null,
    primaryCategory: null,
    publishedAt: null,
    codeUrl: null,
    projectUrl: null,
    citationCount: null,
    contextMode: 'pdf',
    ingestWarnings: [],
    readableAt: 1,
    contextReadyAt: 1,
    structureReadyAt: 1,
    lastPosition: null,
    lastJob: null,
    structureUpgrade: { available: s.structureUpgradeAvailable, reason: s.structureUpgradeAvailable ? 'm1_paper' : null, job: null },
    ...over,
  });
const job = (status: JobDto['status'], error: string | null = null): JobDto => ({ id: JOB, kind: 'upgrade_structure', paperId: UP, status, steps: [{ step: 'html', status: 'running' }], error });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events: SseEvent[]) => new Response(events.map((e) => formatSseEvent(e)).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

let routes: Record<string, () => Response | Promise<Response>>;
const calls: { method: string; url: string }[] = [];
beforeEach(() => {
  calls.length = 0;
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url });
      const h = routes[`${method} ${url}`];
      return h ? h() : json({ error: { code: 'not_found', message: `no mock for ${method} ${url}` } }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetUpgrades();
});

function renderLibrary() {
  const qc = createAppQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <LibraryPage />
    </QueryClientProvider>,
  );
}
const rowOf = (id: string) => screen.getAllByTestId('paper-row').find((r) => r.getAttribute('data-paper-id') === id)!;

/** papers.list / papers.get of the upgrade target, switched to the upgraded state by `upgraded.value`. */
function serveTarget(after: { warnings?: string[]; available?: boolean; jobError?: string | null; v2?: boolean } = {}) {
  const state = { upgraded: false };
  const target = () =>
    state.upgraded
      ? summary(UP, 'Upgrade target', { structureUpgradeAvailable: after.available ?? false, ...(after.v2 ? { supplementVersion: 2, structureSource: 'latexml' } : {}) })
      : summary(UP, 'Upgrade target', { structureUpgradeAvailable: true });
  routes['GET /api/papers'] = () => json(ListPapersResponse.parse({ papers: [target(), summary(V2, 'Structured', { supplementVersion: 2, structureSource: 'latexml' }), summary(NONE, 'Upload', { source: 'upload', supplementVersion: 1 })] }));
  routes[`GET /api/papers/${UP}`] = () =>
    json(
      state.upgraded
        ? detailOf(target(), {
            ingestWarnings: after.warnings ?? [],
            structureUpgrade: { available: after.available ?? false, reason: after.available ? 'm1_paper' : null, job: job(after.jobError ? 'failed' : 'done', after.jobError ?? null) },
          })
        : detailOf(target()),
    );
  return state;
}

describe('badges (from papers.list only)', () => {
  it('색인 v2 / 구조 색인 만들 수 있음 / 구조 없음 — no papers.get for rows without an upgrade', async () => {
    serveTarget();
    renderLibrary();
    await waitFor(() => expect(screen.getAllByTestId('rd-structure-badge')).toHaveLength(3));
    expect(within(rowOf(V2)).getByTestId('rd-structure-badge').textContent).toBe('색인 v2');
    expect(within(rowOf(UP)).getByTestId('rd-structure-badge').textContent).toBe('구조 색인 만들 수 있음');
    expect(within(rowOf(NONE)).getByTestId('rd-structure-badge').textContent).toBe('구조 없음');
    expect(within(rowOf(V2)).queryByTestId('rd-upgrade-button')).toBeNull();
    expect(within(rowOf(NONE)).queryByTestId('rd-upgrade-button')).toBeNull();
    expect(calls.filter((c) => c.url === `/api/papers/${V2}` || c.url === `/api/papers/${NONE}`)).toHaveLength(0);
  });
  it('no badge while the ingest is still running', () => {
    expect(structureBadge({ structureSource: null, supplementVersion: null, structureUpgradeAvailable: false, ingestStatus: 'running' })).toBeNull();
    expect(structureBadge({ structureSource: 'latexml', supplementVersion: 2, structureUpgradeAvailable: false, ingestStatus: 'running' })).toBe('v2');
  });
});

describe('upgrade flow', () => {
  it('button → confirmation text → papers.upgradeStructure → steps → done; list, paper and structure are read again', async () => {
    const state = serveTarget({ v2: true });
    routes[`POST /api/papers/${UP}/upgrade-structure`] = () => json({ jobId: JOB });
    routes[`GET /api/jobs/${JOB}/events`] = () => {
      state.upgraded = true;
      return sse([
        { event: 'job.step', data: { step: 'html', status: 'ok' } },
        { event: 'job.step', data: { step: 'structure', status: 'ok' } },
        { event: 'job.step', data: { step: 'anchor', status: 'ok' } },
        { event: 'job.step', data: { step: 'supplement', status: 'ok' } },
        { event: 'job.done', data: { paperId: UP } },
      ]);
    };
    renderLibrary();
    fireEvent.click(await within(await waitFor(() => rowOf(UP))).findByTestId('rd-upgrade-button'));
    expect(screen.getByTestId('rd-upgrade-confirm').textContent).toContain(UPGRADE_CONFIRM_TEXT);
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // nothing before the confirmation
    fireEvent.click(screen.getByTestId('rd-upgrade-confirm-yes'));
    await screen.findByTestId('rd-upgrade-done');
    const steps = within(rowOf(UP)).getByTestId('rd-upgrade-steps');
    expect([...steps.querySelectorAll('li')].map((li) => `${li.getAttribute('data-step')}:${li.getAttribute('data-status')}`)).toEqual(['html:ok', 'structure:ok', 'anchor:ok', 'supplement:ok']);
    expect(calls.filter((c) => c.method === 'POST' && c.url === `/api/papers/${UP}/upgrade-structure`)).toHaveLength(1);
    await waitFor(() => expect(within(rowOf(UP)).getByTestId('rd-structure-badge').textContent).toBe('색인 v2'));
    const postAt = calls.findIndex((c) => c.method === 'POST');
    expect(calls.slice(postAt).some((c) => c.url === `/api/papers/${UP}`)).toBe(true);
    expect(calls.slice(postAt).some((c) => c.url === '/api/papers')).toBe(true);
  });

  it('final failure: the reason from ingestWarnings (html_not_found) and no button afterwards', async () => {
    const state = serveTarget({ warnings: ['html_not_found: HTTP 404'], available: false, jobError: 'not_found: arXiv HTML이 없습니다' });
    routes[`POST /api/papers/${UP}/upgrade-structure`] = () => json({ jobId: JOB });
    routes[`GET /api/jobs/${JOB}/events`] = () => {
      state.upgraded = true;
      return sse([{ event: 'job.step', data: { step: 'html', status: 'error', detail: 'HTTP 404' } }, { event: 'job.error', data: { code: 'not_found', message: 'arXiv HTML이 없습니다' } }]);
    };
    renderLibrary();
    fireEvent.click(await within(await waitFor(() => rowOf(UP))).findByTestId('rd-upgrade-button'));
    fireEvent.click(screen.getByTestId('rd-upgrade-confirm-yes'));
    const err = await screen.findByTestId('rd-upgrade-error');
    expect(err.getAttribute('data-kind')).toBe('final');
    expect(err.getAttribute('data-code')).toBe('html_not_found');
    expect(err.textContent).toContain('arXiv에 이 논문의 HTML 버전이 없습니다');
    await waitFor(() => expect(within(rowOf(UP)).getByTestId('rd-structure-badge').textContent).toBe('구조 없음'));
    expect(screen.queryByTestId('rd-upgrade-button')).toBeNull();
  });

  it('transient failure: job error code + message (arXiv resume time as given) and the button again', async () => {
    const message = 'arXiv가 기다리라고 응답했습니다 — 재개 2026-11-17 09:30';
    const state = serveTarget({ available: true, jobError: `network: ${message}` });
    routes[`POST /api/papers/${UP}/upgrade-structure`] = () => json({ jobId: JOB });
    routes[`GET /api/jobs/${JOB}/events`] = () => {
      state.upgraded = true;
      return sse([{ event: 'job.step', data: { step: 'html', status: 'error' } }, { event: 'job.error', data: { code: 'network', message } }]);
    };
    renderLibrary();
    fireEvent.click(await within(await waitFor(() => rowOf(UP))).findByTestId('rd-upgrade-button'));
    fireEvent.click(screen.getByTestId('rd-upgrade-confirm-yes'));
    const err = await screen.findByTestId('rd-upgrade-error');
    expect(err.getAttribute('data-kind')).toBe('transient');
    expect(err.getAttribute('data-code')).toBe('network');
    expect(err.textContent).toContain('2026-11-17 09:30');
    expect(err.textContent).toContain('표시된 시각이 지난 뒤 다시 시도하세요');
    expect(within(rowOf(UP)).getByTestId('rd-upgrade-button')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1); // no automatic retry
  });

  it('a reload during an upgrade re-subscribes with structureUpgrade.job (no new POST)', async () => {
    routes['GET /api/papers'] = () => json({ papers: [summary(UP, 'Upgrade target', { structureUpgradeAvailable: true })] });
    let finished = false;
    routes[`GET /api/papers/${UP}`] = () =>
      json(detailOf(summary(UP, 'Upgrade target', { structureUpgradeAvailable: !finished, ...(finished ? { supplementVersion: 2, structureSource: 'latexml' } : {}) }), { structureUpgrade: { available: !finished, reason: finished ? null : 'm1_paper', job: job(finished ? 'done' : 'running') } }));
    routes[`GET /api/jobs/${JOB}/events`] = () => {
      finished = true;
      return sse([{ event: 'job.step', data: { step: 'html', status: 'ok' } }, { event: 'job.step', data: { step: 'structure', status: 'running' } }, { event: 'job.done', data: { paperId: UP } }]);
    };
    renderLibrary();
    await screen.findByTestId('rd-upgrade-done');
    expect(calls.filter((c) => c.url === `/api/jobs/${JOB}/events`)).toHaveLength(1);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a lost progress stream (no terminal event, job still running) → the button subscribes to the same job again', async () => {
    let finished = false;
    const target = () => summary(UP, 'Upgrade target', { structureUpgradeAvailable: !finished, ...(finished ? { supplementVersion: 2, structureSource: 'latexml' } : {}) });
    routes['GET /api/papers'] = () => json({ papers: [target()] });
    routes[`GET /api/papers/${UP}`] = () => json(detailOf(target(), { structureUpgrade: { available: !finished, reason: finished ? null : 'm1_paper', job: null } }));
    let posts = 0;
    routes[`POST /api/papers/${UP}/upgrade-structure`] = () => {
      posts++;
      return json({ jobId: JOB }); // the server answers the running job's id
    };
    let streams = 0;
    routes[`GET /api/jobs/${JOB}/events`] = () => {
      streams++;
      if (streams === 1) return sse([{ event: 'job.step', data: { step: 'html', status: 'ok' } }]); // cut: no terminal event
      finished = true;
      return sse([{ event: 'job.step', data: { step: 'structure', status: 'ok' } }, { event: 'job.done', data: { paperId: UP } }]);
    };
    renderLibrary();
    fireEvent.click(await within(await waitFor(() => rowOf(UP))).findByTestId('rd-upgrade-button'));
    fireEvent.click(screen.getByTestId('rd-upgrade-confirm-yes'));
    const err = await screen.findByTestId('rd-upgrade-error');
    expect(err.getAttribute('data-code')).toBe('disconnected');
    fireEvent.click(within(rowOf(UP)).getByTestId('rd-upgrade-button'));
    fireEvent.click(screen.getByTestId('rd-upgrade-confirm-yes'));
    await screen.findByTestId('rd-upgrade-done');
    expect(posts).toBe(2);
    expect(streams).toBe(2);
    expect(screen.queryByTestId('rd-upgrade-error')).toBeNull();
  });

  it('a lost stream whose job finished on the server (papers.get: job done, v2) shows done, not a lost-stream error (C-R2-01)', async () => {
    let finished = false;
    const target = () => summary(UP, 'Upgrade target', { structureUpgradeAvailable: !finished, ...(finished ? { supplementVersion: 2, structureSource: 'latexml' } : {}) });
    routes['GET /api/papers'] = () => json({ papers: [target()] });
    routes[`GET /api/papers/${UP}`] = () => json(detailOf(target(), { structureUpgrade: { available: !finished, reason: finished ? null : 'm1_paper', job: finished ? job('done') : null } }));
    routes[`POST /api/papers/${UP}/upgrade-structure`] = () => json({ jobId: JOB });
    let streams = 0;
    routes[`GET /api/jobs/${JOB}/events`] = () => {
      streams++;
      finished = true; // the server commits the upgrade, the stream drops before job.done
      return sse([{ event: 'job.step', data: { step: 'html', status: 'ok' } }]);
    };
    renderLibrary();
    fireEvent.click(await within(await waitFor(() => rowOf(UP))).findByTestId('rd-upgrade-button'));
    fireEvent.click(screen.getByTestId('rd-upgrade-confirm-yes'));
    await screen.findByTestId('rd-upgrade-done');
    expect(screen.queryByTestId('rd-upgrade-error')).toBeNull();
    await waitFor(() => expect(within(rowOf(UP)).getByTestId('rd-structure-badge').textContent).toBe('색인 v2'));
    expect(screen.queryByTestId('rd-upgrade-button')).toBeNull();
    expect(streams).toBe(1);
  });

  it('a lost stream whose job failed or was interrupted on the server takes that job error', async () => {
    const state = serveTarget({ available: true, jobError: 'timeout: 60 s' });
    routes[`POST /api/papers/${UP}/upgrade-structure`] = () => json({ jobId: JOB });
    routes[`GET /api/jobs/${JOB}/events`] = () => {
      state.upgraded = true;
      return sse([{ event: 'job.step', data: { step: 'html', status: 'running' } }]); // no terminal event
    };
    renderLibrary();
    fireEvent.click(await within(await waitFor(() => rowOf(UP))).findByTestId('rd-upgrade-button'));
    fireEvent.click(screen.getByTestId('rd-upgrade-confirm-yes'));
    const err = await screen.findByTestId('rd-upgrade-error');
    expect(err.getAttribute('data-kind')).toBe('transient');
    expect(err.getAttribute('data-code')).toBe('timeout');
    expect(outcomeOfSettledJob({ ingestWarnings: [] }, { status: 'interrupted', error: null })).toMatchObject({ kind: 'transient', code: 'interrupted' });
    expect(outcomeOfSettledJob({ ingestWarnings: ['html_not_found'] }, { status: 'failed', error: 'not_found: x' })).toMatchObject({ kind: 'final', codes: ['html_not_found'] });
    expect(outcomeOfSettledJob(null, { status: 'running', error: null })).toBeNull();
  });

  it('a stored lost-stream outcome is replaced when the control later receives the same job settled', async () => {
    routes[`GET /api/papers/${UP}`] = () => json(detailOf(summary(UP, 'Upgrade target', { structureUpgradeAvailable: true })));
    routes[`GET /api/jobs/${JOB}/events`] = () => sse([{ event: 'job.step', data: { step: 'html', status: 'ok' } }]);
    const qc = createAppQueryClient();
    watchUpgrade(qc, UP, JOB);
    await waitFor(() => expect(useUpgradeStore.getState().byPaper[UP]?.outcome).toMatchObject({ kind: 'transient', code: 'disconnected' }));
    resumeUpgrade(qc, UP, { ...job('done'), id: '00000000-0000-4000-8000-0000000000ee' }); // another job: untouched
    expect(useUpgradeStore.getState().byPaper[UP]?.outcome).toMatchObject({ code: 'disconnected' });
    resumeUpgrade(qc, UP, job('failed', 'network: HTTP 503'));
    expect(useUpgradeStore.getState().byPaper[UP]?.outcome).toMatchObject({ kind: 'transient', code: 'network', message: 'HTTP 503' });
    resumeUpgrade(qc, UP, job('done')); // already settled: a later report does not overwrite it
    expect(useUpgradeStore.getState().byPaper[UP]?.outcome).toMatchObject({ code: 'network' });
  });

  it('a stored lost-stream outcome becomes done when the same job is reported done', async () => {
    routes[`GET /api/papers/${UP}`] = () => json(detailOf(summary(UP, 'Upgrade target', { structureUpgradeAvailable: true })));
    routes[`GET /api/jobs/${JOB}/events`] = () => sse([]);
    const qc = createAppQueryClient();
    watchUpgrade(qc, UP, JOB);
    await waitFor(() => expect(useUpgradeStore.getState().byPaper[UP]?.outcome).toMatchObject({ code: 'disconnected' }));
    resumeUpgrade(qc, UP, job('done'));
    expect(useUpgradeStore.getState().byPaper[UP]?.outcome).toEqual({ kind: 'done' });
  });

  it('a settled job (here: a job error) is not watched again for the same job id', async () => {
    const state = serveTarget({ available: true, jobError: 'timeout: 60 s' });
    routes[`POST /api/papers/${UP}/upgrade-structure`] = () => json({ jobId: JOB });
    let streams = 0;
    routes[`GET /api/jobs/${JOB}/events`] = () => {
      streams++;
      state.upgraded = true;
      return sse([{ event: 'job.error', data: { code: 'timeout', message: '60 s' } }]);
    };
    renderLibrary();
    fireEvent.click(await within(await waitFor(() => rowOf(UP))).findByTestId('rd-upgrade-button'));
    fireEvent.click(screen.getByTestId('rd-upgrade-confirm-yes'));
    expect((await screen.findByTestId('rd-upgrade-error')).getAttribute('data-code')).toBe('timeout');
    watchUpgrade(createAppQueryClient(), UP, JOB);
    await new Promise((r) => setTimeout(r, 20));
    expect(streams).toBe(1);
    expect(screen.getByTestId('rd-upgrade-error').getAttribute('data-code')).toBe('timeout');
  });

  it('a refused start (409) shows the reason and sends nothing else', async () => {
    serveTarget();
    routes[`POST /api/papers/${UP}/upgrade-structure`] = () => json({ error: { code: 'conflict', message: '수집 중인 논문입니다' } }, 409);
    renderLibrary();
    fireEvent.click(await within(await waitFor(() => rowOf(UP))).findByTestId('rd-upgrade-button'));
    fireEvent.click(screen.getByTestId('rd-upgrade-confirm-yes'));
    expect((await screen.findByTestId('rd-upgrade-start-error')).textContent).toContain('수집 중인 논문입니다');
    expect(calls.some((c) => c.url.startsWith('/api/jobs/'))).toBe(false);
  });
});

describe('failure classification', () => {
  it('final codes come only from ingestWarnings; the job code alone never makes a failure final', () => {
    expect(finalWarnings(['html_deferred', 'structure_too_large: 5 MB', 'equation_number_gap'])).toEqual(['structure_too_large']);
    expect(classifyUpgradeFailure({ ingestWarnings: [] }, { code: 'not_found', message: 'x' }).kind).toBe('transient');
    expect(classifyUpgradeFailure({ ingestWarnings: ['html_version_mismatch'] }, { code: 'version_mismatch', message: 'x' })).toMatchObject({ kind: 'final', codes: ['html_version_mismatch'] });
    for (const code of ['timeout', 'network', 'blocked_url', 'interrupted'] as const) expect(classifyUpgradeFailure({ ingestWarnings: [] }, { code, message: 'm' })).toMatchObject({ kind: 'transient', code });
  });
  it('stored job errors parse as `<code>: <message>`; an unknown code is shown as internal with the whole text', () => {
    expect(parseJobError('timeout: 60 s')).toEqual({ code: 'timeout', message: '60 s' });
    expect(parseJobError('weird text')).toEqual({ code: 'internal', message: 'weird text' });
    expect(parseJobError(null)).toBeNull();
  });
  it('recognises the arXiv wait forms of the job message', () => {
    expect(mentionsArxivWait('arXiv가 약 12분 뒤 다시 요청하라고 했습니다')).toBe(true);
    expect(mentionsArxivWait('재개 2026-11-17 09:30')).toBe(true);
    expect(mentionsArxivWait('arXiv가 기한 없는 대기를 요청함')).toBe(true);
    expect(mentionsArxivWait('HTTP 503')).toBe(false);
  });
});
