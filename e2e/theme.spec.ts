import { expect, test, type Locator, type Page } from '@playwright/test';
import { ctrlDragArea, dragSelectText, waitForPdf } from './actions';
import { SEED_M2_PAPER_ID } from './helpers';
import { contrastSample, type ContrastPart } from './themeContrast';

async function scheme(page: Page, theme: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.getByTestId(`rd-theme-${theme}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
}

async function contrast(el: Locator, part: ContrastPart = 'text', threshold = 4.5) {
  await expect(el).toBeVisible();
  const result = await contrastSample(el, part);
  expect(result.ratio, `${el} · ${part} · ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(threshold);
}

test('Library follows OS changes until a choice is saved; that choice survives reloads, navigation and another tab', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await scheme(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await scheme(page, 'light');
  await page.getByTestId('rd-theme-dark').click();
  await page.reload();
  await scheme(page, 'dark');
  const other = await context.newPage();
  await other.goto('/');
  await scheme(other, 'dark');
  await page.locator(`[data-paper-id="${SEED_M2_PAPER_ID}"] a`).click();
  await scheme(page, 'dark');
  await page.getByTestId('rd-theme-light').click();
  await scheme(other, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await scheme(page, 'light');
  await page.getByRole('link', { name: '← Library' }).click();
  await scheme(page, 'light');
});

test('blocked device storage still allows both themes across routes in the same tab', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage unavailable', 'SecurityError'); } });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await scheme(page, 'light');
  await page.getByTestId('rd-theme-dark').click();
  await page.locator(`[data-paper-id="${SEED_M2_PAPER_ID}"] a`).click();
  await scheme(page, 'dark');
  await page.getByRole('link', { name: '← Library' }).click();
  await scheme(page, 'dark');
  await page.reload();
  await scheme(page, 'light');
});

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: rendered controls, text, dialogs, empty states and all six panel tabs meet contrast thresholds`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/');
    await scheme(page, theme);
    const id = (key: string) => page.getByTestId(key);
    await contrast(page.getByRole('heading', { name: 'Library' }), 'text', 3);
    await contrast(id('rd-library-count'));
    await contrast(id('import-input'), 'placeholder');
    await contrast(id('import-input').locator('..'), 'edge', 3);
    await contrast(id(`rd-theme-${theme}`));
    await contrast(id(`rd-theme-${theme}`), 'edge', 3);
    await id('import-input').fill('2209.15397');
    await contrast(id('import-button'));
    await contrast(id('import-button'), 'fill', 3);
    await page.locator(`[data-paper-id="${SEED_M2_PAPER_ID}"] a`).click();
    await scheme(page, theme);
    await contrast(id('rd-progress-summary'));
    await contrast(id('rd-page'), 'edge', 3);
    await id('rd-paper-info').click();
    await contrast(id('rd-paper-info-limit'));
    await page.keyboard.press('Escape');
    for (const tab of ['ai', 'cards', 'glossary', 'equations', 'references', 'highlights']) {
      // The M1 tabs retain their original ids; the four M2 tabs use the pn prefix.
      const active = tab === 'ai' || tab === 'highlights' ? id(`panel-tab-${tab}`) : id(`pn-tab-${tab}`);
      await active.click();
      await expect(active).toHaveAttribute('aria-selected', 'true');
      await contrast(active);
      await contrast(id('pn-head').getByRole('heading'));
      if (tab === 'glossary') {
        await contrast(id('pn-glossary-add'), 'edge', 3);
        await id('pn-glossary-add').click();
        await contrast(id('pn-glossary-add-def'), 'placeholder');
        await contrast(id('pn-glossary-add-def'), 'edge', 3);
        const term = `Contrast specimen ${theme}`;
        await id('pn-glossary-add-term').fill(term);
        await id('pn-glossary-add-def').fill(['> Quote', '', '| Surface | Value |', '| --- | --- |', '| PDF | 1 |', '', 'Inline `code`.', '', '~~~', 'pose()', '~~~'].join('\n'));
        await id('pn-glossary-add-save').click();
        const entry = id('pn-glossary-item').filter({ has: page.getByText(term, { exact: true }) });
        for (const selector of ['blockquote p', 'th', 'td', 'p code', 'pre code']) {
          await contrast(entry.locator(selector).first());
        }
        await entry.getByTestId('pn-glossary-delete').click();
        await entry.getByTestId('pn-glossary-delete-confirm').click();
        await expect(entry).toHaveCount(0);
      }
    }
    await page.route('**/api/papers', (route) => route.fulfill({ json: { papers: [] } }));
    await page.goto('/');
    await contrast(id('rd-library-empty').locator('p').last());
    await page.route('**/api/papers', (route) => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: '거부됨' } } }));
    await page.reload();
    await contrast(page.getByText('목록을 불러오지 못했습니다', { exact: false }));
  });

  test(`${theme}: PDF selection, capture menu and highlight colours use readable controls outside the PDF filter`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/paper/${SEED_M2_PAPER_ID}?sl-card=fixed`);
    const opts = { pageNumber: 1, timeoutMs: 20_000 };
    const id = (key: string) => page.getByTestId(key);
    await waitForPdf(page, opts);
    await dragSelectText(page, { ...opts, text: 'We estimate the robot pose' });
    await contrast(id('toolbar-explain'));
    await contrast(id('toolbar-color-3'));
    await expect(id('toolbar-color-3')).toHaveText('3');
    await page.keyboard.press('e');
    await contrast(id('rd-float-lead'));
    await contrast(id('rd-float-input'), 'placeholder');
    await contrast(id('rd-float-input').locator('..'), 'edge', 3);
    await id('rd-float-close').click();
    await dragSelectText(page, { ...opts, text: 'We estimate the robot pose' });
    const created = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith(`/papers/${SEED_M2_PAPER_ID}/highlights`));
    await id('toolbar-color-3').click();
    const highlight = await (await created).json() as { id: string };
    await page.locator(`[data-highlight-id="${highlight.id}"] [data-testid="highlight-part"]`).first().click();
    const selected = id('highlight-popover').getByRole('button', { pressed: true });
    await expect(selected).toHaveText('3');
    await contrast(selected);
    await contrast(id('rd-highlight-delete'));
    await id('rd-highlight-delete').click();
    await ctrlDragArea(page, { ...opts, from: [0.3, 0.3], to: [0.55, 0.4] });
    await contrast(id('rd-capture-figure'));
    await contrast(id('rd-capture-highlight'));
  });
}
