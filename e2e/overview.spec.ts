import { expect, test } from '@playwright/test';
import { realJson, SEED_M2_PAPER_ID } from './helpers';

test('opens, stores and replaces a five-part grounded overview only when requested', async ({ page, baseURL }) => {
  const params = { id: SEED_M2_PAPER_ID };
  const requests: boolean[] = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().endsWith('/overview/generate')) requests.push(req.postDataJSON().regenerate);
  });
  const open = async () => {
    await page.goto('/paper/' + params.id);
    await page.getByTestId('pn-overview-toggle').click();
  };
  await open();
  const create = page.getByTestId('pn-overview-generate');
  await expect(create).toHaveText('요약 만들기');
  expect(requests).toHaveLength(0);
  await create.click();
  const result = page.getByTestId('pn-overview-result');
  await expect(result.getByRole('heading')).toHaveText(['문제·동기', '핵심 방법', '주요 결과', '한계', '기여']);
  await expect(result.locator('[data-testid="sp-chip"][data-status="verbatim"]').first()).toBeVisible();
  const first = await realJson<{ result: { runId: string } }>(baseURL!, 'overview.get', { params });
  await page.goto('/');
  await open();
  await expect(result).toBeVisible();
  expect(requests).toEqual([false]);
  await expect(create).toHaveText('다시 만들기');
  const terminal = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith('/overview/generate'));
  await create.click();
  await (await terminal).finished();
  await expect.poll(async () => (await realJson<{ result: { runId: string }; pending: unknown }>(baseURL!, 'overview.get', { params })).result.runId).not.toBe(first.result.runId);
  await expect(result.getByRole('heading')).toHaveCount(5);
  expect(requests).toEqual([false, true]);
});
