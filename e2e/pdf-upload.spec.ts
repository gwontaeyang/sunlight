import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeUploadPdf } from '../apps/server/test/fixtures/uploadPdf';
import { openPanelTab, pdfPage, selectAndPress, waitForAnswerTerminal, waitForPdf } from './actions';
import { apiToken, hostPort, rawRequest } from './helpers';

const timeoutMs = 20_000;

async function selectFile(page: Page, bytes: Uint8Array, method: 'picker' | 'drop') {
  const name = 'registration-notes.pdf';
  if (method === 'picker') {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'PDF 올리기' }).click()]);
    await chooser.setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
    return;
  }
  const dataTransfer = await page.evaluateHandle(({ values, name }) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(values)], name, { type: 'application/pdf' }));
    return data;
  }, { values: Array.from(bytes), name });
  try {
    const target = page.getByTestId('rd-upload-drop');
    await target.dispatchEvent('dragover', { dataTransfer });
    await target.dispatchEvent('drop', { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

async function uploadNew(page: Page, bytes: Uint8Array, method: 'picker' | 'drop'): Promise<string> {
  const done = page.waitForResponse(r => new URL(r.url()).pathname === '/api/papers/upload' && r.request().method() === 'POST');
  await selectFile(page, bytes, method);
  const res = await done;
  expect(res.ok()).toBe(true);
  const created = await res.json() as { paperId: string; existing: boolean };
  expect(created.existing).toBe(false);
  return created.paperId;
}

async function removeNew(baseURL: string, paperId: string) {
  const { port } = hostPort(baseURL);
  const cleanup = await rawRequest(port, '/api/papers/' + encodeURIComponent(paperId), {
    method: 'DELETE', headers: { 'X-SP-Token': await apiToken(baseURL) },
  });
  expect(cleanup.status, 'remove only the newly uploaded PDF').toBe(204);
}

test('rejects a renamed non-PDF through the real upload route; an unsupported extension stays in the picker', async ({ page }) => {
  await page.goto('/');
  const upload = page.getByTestId('rd-upload-file');
  const seen: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/papers/upload') seen.push(request.method());
  });
  await upload.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('plain text') });
  await expect(page.getByRole('alert')).toContainText('.pdf');
  expect(seen).toHaveLength(0);
  const bad = page.waitForResponse(r => new URL(r.url()).pathname === '/api/papers/upload');
  await upload.setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('plain text') });
  expect((await bad).status()).toBe(400);
  await expect(page.getByRole('alert')).toContainText('PDF');
  expect(seen).toEqual(['POST']);
});

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: import a synthetic local PDF, read its estimated outline and retain reading progress without confirmed claims`, async ({ page, baseURL }, info) => {
    const id = (key: string) => page.getByTestId(key);
    const target = info.project.name === 'prod' ? process.env.SP_UPLOAD_SCREENS : undefined;
    async function capture(view: string) {
      if (!target) return;
      await mkdir(target, { recursive: true });
      await page.evaluate(() => document.fonts.ready.then(() => {}));
      await page.screenshot({ path: join(target, `${view}-${theme}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/');
    await expect(page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(id('rd-upload-button')).toBeVisible();
    await expect(id('paper-row').first()).toBeVisible();
    await capture('library');

    // A fresh invisible document subject isolates this scenario from byte-based import deduplication.
    const bytes = await makeUploadPdf({ subject: randomUUID() });
    const paperId = await uploadNew(page, bytes, theme === 'light' ? 'picker' : 'drop');
    const row = page.locator(`[data-paper-id="${paperId}"]`);
    const editedTitle = 'Learning Point Registration · Reading Notes';
    try {
      await expect(row.getByRole('link')).toHaveText('Learning Point Registration');
      await expect(row.getByTestId('rd-upload-source')).toHaveText('업로드 PDF');
      await expect(row.getByTestId('rd-structure-badge')).toContainText('추정');
      await expect(id('rd-upload-status')).toContainText('저장했습니다');
      await capture('uploaded');
      await row.getByTestId('rd-upload-title-edit').click();
      await row.getByTestId('rd-upload-title-input').fill(editedTitle);
      await row.getByTestId('rd-upload-title-save').click();
      await expect(row.getByRole('link')).toHaveText(editedTitle);
      await row.getByRole('link').click();
      await expect(id('paper-title')).toHaveText(editedTitle);
      await waitForPdf(page, { timeoutMs });
      await expect(id('rd-upload-outline-source')).toContainText('추정된 구조');
      await expect(id('rd-outline-link')).toHaveText(['Matching Points', 'Checking the Estimate']);
      const first = id('rd-outline-item').filter({ hasText: 'Matching Points' }).getByTestId('rd-progress-toggle');
      const stored = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/progress/'));
      await first.click();
      expect((await stored).ok()).toBe(true);
      await page.reload();
      await expect(first).toHaveAttribute('data-state', 'skimmed');
      await expect(id('paper-title')).toHaveText(editedTitle);
      await waitForPdf(page, { timeoutMs });
      await expect(id('rd-upload-evidence-note')).toBeVisible();
      await capture('outline');
      await id('rd-outline-link').filter({ hasText: 'Checking the Estimate' }).click();
      await expect(pdfPage(page, 2).getByTestId('rd-section-flash')).toBeVisible();

      await openPanelTab(page, 'equations', { timeoutMs });
      await expect(id('rd-upload-equation-limit')).toContainText('업로드 PDF');
      await expect(id('pn-eq-item')).toHaveCount(0);
      await openPanelTab(page, 'ai', { timeoutMs });
      const start = () => selectAndPress(page, { timeoutMs, pageNumber: 1, text: 'We pair each scan point', key: 'e' });
      expect(await waitForAnswerTerminal(page, { start, timeoutMs })).toBe('done');
      const answer = id('live-message');
      await expect(answer.locator('[data-testid="sp-chip"][data-reason="uploaded_pdf"]').first()).toBeVisible();
      await expect(answer.locator('[data-status="verbatim"], [data-status="p-grounded"], [data-status="resolved"]')).toHaveCount(0);
      await id('rd-study-path-open').click();
      await expect(id('rd-upload-study-limit')).toBeVisible();
      await id('rd-study-path-generate').click();
      await expect(id('rd-study-saved')).toContainText('저장된 공부 자료');
      await expect(id('rd-study-stage-7')).toHaveCount(1);
      await expect(id('rd-study-path').locator('[data-status="verbatim"], [data-status="p-grounded"], [data-status="resolved"]')).toHaveCount(0);
    } finally {
      await removeNew(baseURL!, paperId);
    }
  });
}

test('a bookmarked upload supports selection translation, highlights, notes, cards and glossary entries after reopening', async ({ page, baseURL }) => {
  const id = (key: string) => page.getByTestId(key);
  await page.goto('/');
  const bytes = await makeUploadPdf({ bookmarks: true, subject: randomUUID() });
  const paperId = await uploadNew(page, bytes, 'picker');
  const opts = { pageNumber: 1, timeoutMs };
  const note = 'Check the two known target points.';
  try {
    await page.locator(`[data-paper-id="${paperId}"] a`).click();
    await waitForPdf(page, opts);
    await expect(id('rd-upload-outline-source')).toContainText('책갈피');
    await expect(id('rd-outline-link')).toHaveText(['Registration procedure', 'Verify the shift']);
    const translate = () => selectAndPress(page, { ...opts, text: 'We pair each scan point', key: 't' });
    expect(await waitForAnswerTerminal(page, { start: translate, timeoutMs })).toBe('done');
    await expect(id('live-message')).toContainText('잔차');
    await expect(id('live-message').getByTestId('sp-chip')).toHaveCount(0);

    await selectAndPress(page, { ...opts, text: 'Faraway pairs', key: 'h' });
    await expect(pdfPage(page, 1).getByTestId('highlight-part').first()).toBeVisible();
    await selectAndPress(page, { ...opts, text: 'Two nearby targets', key: 'n' });
    await expect(id('pn-note-input')).toHaveValue(/^> Two nearby/);
    await id('pn-note-input').fill(note);
    await id('pn-note-save').click();
    await expect(id('pn-note-item')).toContainText(note);

    await openPanelTab(page, 'cards', { timeoutMs });
    const notation = page.locator('[data-testid="pn-card-section"][data-kind="notation"]');
    await notation.getByTestId('pn-card-generate').click();
    await expect(notation.getByTestId('pn-card-item')).toHaveCount(11);
    await expect(notation.locator('[data-badge="grounded_quote"], [data-badge="equation_ref"]')).toHaveCount(0);

    await openPanelTab(page, 'glossary', { timeoutMs });
    await id('pn-glossary-define-term').fill('point pair');
    await id('pn-glossary-define-start').click();
    await expect(id('pn-glossary-suggestion')).toBeVisible();
    await id('pn-glossary-suggestion-save').click();
    const term = id('pn-glossary-item').filter({ hasText: 'point pair' });
    await expect(term).toBeVisible();

    await page.reload();
    await waitForPdf(page, opts);
    await openPanelTab(page, 'highlights', { timeoutMs });
    await expect(id('highlight-item')).toContainText('Faraway');
    await expect(id('pn-note-item')).toContainText(note);
    await openPanelTab(page, 'glossary', { timeoutMs });
    await expect(term.getByTestId('pn-glossary-origin')).toHaveAttribute('data-origin', 'llm');
  } finally {
    await removeNew(baseURL!, paperId);
  }
});
