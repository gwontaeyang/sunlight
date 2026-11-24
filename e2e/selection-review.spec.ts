import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { ApiResponse } from '../packages/shared/src/contracts/api';
import { makeUploadPdf } from '../apps/server/test/fixtures/uploadPdf';
import { dragSelectText, waitForPdf } from './actions';
import { apiToken, hostPort, rawRequest, realJson } from './helpers';

test('preview selected questions, confirm one, reopen its highlighted source and grade it', async ({ page, baseURL }) => {
  const url = baseURL!;
  const opts = { pageNumber: 1, timeoutMs: 20_000 };
  await page.goto('/');
  const uploaded = page.waitForResponse(res => new URL(res.url()).pathname === '/api/papers/upload' && res.request().method() === 'POST');
  await page.getByTestId('rd-upload-file').setInputFiles({ name: 'review-practice.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from(await makeUploadPdf({ subject: randomUUID() })) });
  const response = await uploaded;
  expect(response.ok()).toBe(true);
  const { paperId, existing } = await response.json() as { paperId: string; existing: boolean };
  expect(existing).toBe(false);
  async function queue() {
    const result = await realJson<ApiResponse<'review.queue'>>(url, 'review.queue');
    return result.cards.filter(({ card }) => card.paperId === paperId);
  }
  const highlights = () => realJson<ApiResponse<'highlights.list'>>(url, 'highlights.list', { params: { id: paperId } });
  try {
    await page.locator('[data-paper-id="' + paperId + '"] a').click();
    await waitForPdf(page, opts);
    await dragSelectText(page, { ...opts, text: 'We pair each scan point', fraction: 0.92 });
    await page.getByTestId('rd-make-cards').click();
    const dialog = page.getByTestId('pn-review-q');
    const checks = dialog.getByRole('checkbox');
    await expect(checks).toHaveCount(2);
    expect(await queue()).toHaveLength(0);
    expect((await highlights()).highlights).toHaveLength(0);
    await checks.nth(1).uncheck();
    const selectedQ = (await checks.nth(0).locator('..').innerText()).trim();
    await page.getByTestId('rd-review-confirm').click();
    await expect(page.getByTestId('rd-review-saved')).toContainText('1개');
    const items = await queue();
    expect(items).toHaveLength(1);
    const persisted = (await highlights()).highlights;
    expect(persisted).toHaveLength(1);
    expect(items[0]!.card).toMatchObject({ frontMd: selectedQ, highlightId: persisted[0]!.id, origin: 'llm' });
    await dialog.getByRole('link', { name: '복습 열기' }).click();
    const entry = page.getByTestId('review-entry').filter({ has: page.getByRole('heading', { name: selectedQ, exact: true }) });
    await entry.getByRole('link', { name: '원문 보기' }).click();
    await expect(page.getByTestId('citation-flash')).toHaveAttribute('data-flash-text', persisted[0]!.quote!.exact);
    await page.goto('/');
    await page.getByTestId('lib-review').click();
    await entry.getByRole('button', { name: '답 보기' }).click();
    await expect(entry.getByTestId('review-answer')).toHaveText(items[0]!.card.backMd);
    await entry.getByRole('button', { name: '알맞음' }).click();
    await expect(entry).toHaveCount(0);
    expect(await queue()).toHaveLength(0);
  } finally {
    const cleanup = await rawRequest(hostPort(url).port, '/api/papers/' + encodeURIComponent(paperId), {
      method: 'DELETE', headers: { 'X-SP-Token': await apiToken(url) },
    });
    expect(cleanup.status).toBe(204);
  }
});
