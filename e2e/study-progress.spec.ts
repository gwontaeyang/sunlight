import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { makeUploadPdf } from '../apps/server/test/fixtures/uploadPdf';
import type { StudyPathDto } from '../packages/shared/src/contracts/api';
import { openPanelTab } from './actions';
import { apiToken, hostPort, mockRoute, rawRequest, realJson, routePath } from './helpers';

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

declare global {
  interface Window {
    waitForStudyFrame(frame: string): Promise<void>;
    studySignal?: AbortSignal | null;
  }
}

// Pace delivery of actual mock-server SSE frames. Neither the response content nor
// the client request changes, and routing away can still abort the original fetch.
async function controlStudyStream(page: Page, path: string) {
  const first = barrier(), fourth = barrier(), sixth = barrier(), terminal = barrier(), doneArrived = barrier();
  let text = '';
  await page.exposeFunction('waitForStudyFrame', async (frame: string) => {
    if (frame.startsWith('event: run.done\n')) {
      doneArrived.release();
      return terminal.wait;
    }
    if (!frame.startsWith('event: run.delta\n')) return;
    const data = JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as { text: string };
    text += data.text;
    if (text.includes('\n## 6')) return sixth.wait;
    if (text.includes('\n## 4')) return fourth.wait;
    return first.wait;
  });
  await page.evaluate(path => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (new URL(response.url).pathname !== path || init?.method !== 'POST' || !response.ok || !response.body) return response;
      window.studySignal = init.signal;
      let pending = '';
      const frames = new TransformStream<string, string>({
        async transform(chunk, output) {
          pending += chunk;
          for (let end = pending.indexOf('\n\n'); end !== -1; end = pending.indexOf('\n\n')) {
            const frame = pending.slice(0, end + 2);
            pending = pending.slice(end + 2);
            await window.waitForStudyFrame(frame);
            output.enqueue(frame);
          }
        },
        flush(output) { if (pending) output.enqueue(pending); },
      });
      const body = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(frames).pipeThrough(new TextEncoderStream());
      return new Response(body, { status: response.status, headers: response.headers });
    };
  }, path);
  return { first, fourth, sixth, terminal, doneArrived };
}

async function freshStudy(page: Page, baseURL: string) {
  await page.goto('/');
  const upload = page.waitForResponse(r => new URL(r.url()).pathname === routePath('papers.upload') && r.request().method() === 'POST');
  await page.getByTestId('rd-upload-file').setInputFiles({
    name: 'study-progress.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from(await makeUploadPdf({ subject: randomUUID() })),
  });
  const response = await upload;
  expect(response.ok()).toBe(true);
  const { paperId, existing } = await response.json() as { paperId: string; existing: boolean };
  expect(existing).toBe(false);
  const generate = routePath('studyPath.generate', { id: paperId });
  const gates = await controlStudyStream(page, generate);
  const ids: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === generate) {
      ids.push(request.postDataJSON().clientRequestId);
    }
  });
  const row = page.getByTestId('paper-row').and(page.locator(`[data-paper-id="${paperId}"]`));
  async function cleanup() {
    for (const gate of Object.values(gates)) gate.release();
    const removed = await rawRequest(hostPort(baseURL).port, routePath('papers.delete', { id: paperId }), {
      method: 'DELETE', headers: { 'X-SP-Token': await apiToken(baseURL) },
    });
    expect(removed.status).toBe(204);
  }
  return { gates, ids, row, paperId, generate, cleanup };
}

test('study progress follows the same stream through panels, the library and back', async ({ page, baseURL }) => {
  const { gates, ids, row, cleanup } = await freshStudy(page, baseURL!);
  try {
    const bar = page.getByRole('progressbar', { name: /단계별 공부/ });
    const readerProgress = page.getByTestId('rd-study-progress-text');
    const badge = row.getByTestId('lib-study-progress');
    const library = page.getByRole('link', { name: '← Library', exact: true });

    await row.getByRole('link').click();
    await page.getByTestId('rd-study-path-open').click();
    await page.getByTestId('rd-study-path-generate').click();
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    gates.first.release();
    await expect(readerProgress).toHaveText('단계별 공부 3/7 · 43%');
    await expect(bar).toHaveAttribute('aria-valuenow', '43');
    await page.getByTestId('rd-study-path-close').click();
    await openPanelTab(page, 'cards', { timeoutMs: 10_000 });
    await expect(bar).toBeVisible();
    await library.click();
    await expect(badge).toHaveText('공부 생성 중 43%');
    await expect(page.getByTestId('lib-study-progress')).toHaveCount(1);
    gates.fourth.release();
    await expect(badge).toHaveText('공부 생성 중 71%');
    expect(await page.evaluate(() => window.studySignal?.aborted)).toBe(false);

    await row.getByRole('link').click();
    await page.getByTestId('rd-study-path-open').click();
    await expect(readerProgress).toHaveText('단계별 공부 5/7 · 71%');
    gates.sixth.release();
    await expect(bar).toHaveAttribute('aria-valuenow', '100');
    gates.terminal.release();
    await expect(page.getByTestId('rd-study-saved')).toBeVisible();
    await expect(page.getByTestId('rd-study-stage-7')).toBeVisible();
    await expect(bar).toHaveCount(0);
    await library.click();
    await expect(row).toBeVisible();
    await expect(badge).toHaveCount(0);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/i);
  } finally {
    await cleanup();
  }
});

test('reconnecting after reload replays the original study request when the terminal was missed', async ({ page, baseURL }) => {
  const { gates, ids, row, paperId, generate, cleanup } = await freshStudy(page, baseURL!);
  try {
    gates.first.release();
    gates.fourth.release();
    gates.sixth.release();
    await row.getByRole('link').click();
    await page.getByTestId('rd-study-path-open').click();
    await page.getByTestId('rd-study-path-generate').click();
    await gates.doneArrived.wait;
    const stored = await realJson<StudyPathDto>(baseURL!, 'studyPath.get', { params: { id: paperId } });
    expect(stored.result).not.toBeNull();
    expect(ids).toHaveLength(1);
    const clientRequestId = ids[0]!;
    const { runId, codeLanguage } = stored.result!;

    // A stale pending read can precede completion. Clicking reconnect afterwards
    // must be an idempotent POST against the real server's already committed run.
    await mockRoute(page, 'studyPath.get', async req => ({
      kind: 'json',
      body: ids.length === 1
        ? { result: null, pending: { runId, clientRequestId, codeLanguage, regenerate: false } }
        : await realJson<StudyPathDto>(baseURL!, 'studyPath.get', { params: req.params }),
    }));
    await page.reload();
    gates.terminal.release();
    await page.getByTestId('rd-study-path-open').click();
    const reconnect = page.getByRole('button', { name: '진행 중인 요청 다시 연결' });
    await expect(reconnect).toBeVisible();
    const replay = page.waitForResponse(r => new URL(r.url()).pathname === generate && r.request().method() === 'POST');
    await reconnect.click();
    const response = await replay;
    expect(response.ok()).toBe(true);
    const message = (await response.text()).split('\n\n')[0]!;
    expect(message).toMatch(/^event: run\.accepted\n/);
    expect(JSON.parse(message.slice(message.indexOf('data: ') + 6)).runId).toBe(runId);
    await expect(page.getByTestId('rd-study-saved')).toBeVisible();
    await expect(page.getByTestId('rd-study-stage-7')).toBeVisible();
    expect(ids).toEqual([clientRequestId, clientRequestId]);
  } finally {
    await cleanup();
  }
});
