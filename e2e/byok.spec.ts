import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';

test('configure and remove a local API key, across themes and reloads, with the mock server', async ({ page }) => {
  const key = 'sk-ant-api03-' + randomBytes(32).toString('hex');
  const errors: string[] = [];
  page.on('console', (msg) => errors.push(msg.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('link', { name: '설정', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI 설정' })).toBeVisible();
  await page.getByRole('radio', { name: '내 Anthropic API key' }).check();
  await page.getByLabel('Anthropic API key', { exact: true }).fill(key);
  await page.getByRole('button', { name: '키 저장' }).click();
  await expect(page.getByText('등록됨 · ••••••••')).toBeVisible();
  await expect(page.locator('#anthropic-key')).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('radio', { name: '내 Anthropic API key' })).toBeChecked();
  await expect(page.getByLabel('Anthropic API key', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '키 확인' }).click();
  await expect(page.getByRole('status')).toContainText('연결할 수 없습니다');
  expect(
    await page.evaluate(() => JSON.stringify([location.href, localStorage, sessionStorage, document.body.innerText])),
  ).not.toContain(key);
  expect(errors.join('\n')).not.toContain(key);
  await page.getByRole('button', { name: '키 삭제' }).click();
  await expect(page.getByText('이 기기에 등록된 키가 없습니다.')).toBeVisible();
  await page.getByRole('radio', { name: /Claude Code 구독/ }).check();
  await expect(page.getByRole('radio', { name: /Claude Code 구독/ })).toBeChecked();
});
