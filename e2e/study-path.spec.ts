import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { SEED_M2_PAPER_ID } from './helpers';

const paper = '/paper/' + SEED_M2_PAPER_ID;
async function openStudy(page: Page) {
  await page.goto(paper);
  await page.getByTestId('rd-study-path-open').click();
}
async function selectPreference(page: Page, testId: string, value: string) {
  const saved = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT');
  await page.getByTestId(testId).selectOption(value);
  expect((await saved).ok()).toBe(true);
}

test('manually generate a grounded study path, revisit it, check progress and switch example language', async ({ page }, info) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const calls: string[] = [];
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().endsWith('/study-path/generate')) calls.push(r.postData()!);
  });
  await openStudy(page);
  const study = page.getByTestId('rd-study-path');
  const saved = page.getByTestId('rd-study-saved');
  await expect(page.getByTestId('rd-study-path-generate')).toBeEnabled();
  expect(calls).toHaveLength(0);
  await page.getByTestId('rd-study-path-generate').click();
  await expect(saved).toContainText('C++17');
  for (let i = 1; i <= 7; i++) await expect(page.getByTestId('rd-study-stage-' + i)).toHaveCount(1);
  const implementation = page.getByTestId('rd-study-stage-5');
  await expect(implementation).toContainText('논문 공식 구현 아님');
  await expect(implementation.locator('pre code').first()).toContainText('Eigen');
  const quote = study.locator('[data-testid="sp-chip"][data-status="verbatim"]').first();
  await expect(quote).toBeVisible();
  await expect(study.locator('[data-testid="sp-badge"][data-status="G"]').first()).toBeVisible();

  for (const theme of ['light', 'dark'] as const) {
    await page.getByTestId('rd-theme-' + theme).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const target = process.env.SP_STUDY_PATH_SCREENS;
    if (target && info.project.name === 'prod') {
      await page.evaluate(() => document.fonts.ready.then(() => {}));
      await study.evaluate(el => el.scrollTo(0, 0));
      await page.screenshot({ path: join(target, 'study-' + theme + '.png') });
      await implementation.evaluate(el => el.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: join(target, 'implementation-' + theme + '.png') });
    }
  }

  await study.locator('[data-testid^="rd-study-equation-"]').first().click();
  await expect(page.locator('[data-testid="pn-eq-item"][data-focused="1"]')).toBeVisible();
  await study.getByTestId('rd-study-reference-1').click();
  await expect(page.locator('[data-testid="pn-ref-item"][data-focused="1"]')).toHaveAttribute('data-ordinal', '1');
  await quote.click();
  await expect(study).toBeHidden();
  await page.getByTestId('rd-study-path-open').click();
  const checkbox = page.getByTestId('rd-study-check-0');
  const checkWritten = page.waitForResponse(r => r.url().endsWith('/study-path/check') && r.request().method() === 'PATCH');
  await checkbox.click();
  expect((await checkWritten).ok()).toBe(true);
  await expect(checkbox).toBeChecked();
  await openStudy(page);
  await expect(checkbox).toBeChecked();
  expect(calls).toHaveLength(1);

  await page.goto('/settings');
  try {
    await selectPreference(page, 'rd-study-code-language', 'python');
    await selectPreference(page, 'rd-answer-language', 'en');
    await openStudy(page);
    await expect(saved).toContainText('C++17');
    await expect(checkbox).toBeChecked();
    await page.getByTestId('rd-study-path-regenerate').click();
    await expect(saved).toContainText('Python');
    await expect(page.getByTestId('rd-study-stage-1')).toContainText('Point-to-point ICP pairs');
    await expect(implementation.locator('pre code').first()).toContainText(/def |import /);
    await expect(checkbox).not.toBeChecked();
    await openStudy(page);
    await expect(saved).toContainText('Python');
    expect(calls.map(c => JSON.parse(c).regenerate)).toEqual([false, true]);
  } finally {
    await page.goto('/settings');
    await selectPreference(page, 'rd-study-code-language', 'cpp17');
    await selectPreference(page, 'rd-answer-language', 'ko');
  }
});
