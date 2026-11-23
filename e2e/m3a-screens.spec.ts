// M3a screens (PLAN_M3 §4, CP-A): the floating card host with its fixed answer (?sl-card=fixed) — 8 px under the
// selection at 1400×900 and 1024×800, close / follow-up / send reachable, focus, Esc, scroll / zoom / paper change; the
// default E still goes to the panel; night theme + "원본 색 보기" round trip without moving the text layer; the outline
// column ↔ drawer; the page-number box. Real server + SP_LLM=mock, no mocked routes.
import { expect, test, type Page } from '@playwright/test';
import { dragSelectText, pdfPage, waitForPdf } from './actions';
import { resetSeedState, SEED_M2_PAPER_ID, SEED_M2_TITLE, SEED_PAPER_ID } from './helpers';

const T = { timeoutMs: 20_000 };
const QUOTE = 'We estimate the robot pose';

test.beforeEach(async ({ baseURL }) => {
  await resetSeedState(baseURL!, [SEED_M2_PAPER_ID, SEED_PAPER_ID]);
});

async function open(page: Page, query = '') {
  await page.goto(`/paper/${SEED_M2_PAPER_ID}${query}`);
  await expect(page.getByTestId('paper-title')).toHaveText(SEED_M2_TITLE);
  await waitForPdf(page, { pageNumber: 1, ...T });
}

/** The DOM selection's box (viewport px). */
const selectionBox = (page: Page) =>
  page.evaluate(() => {
    const rects = Array.from(window.getSelection()!.getRangeAt(0).getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    return { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)), right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
  });

/** In the viewport and the topmost element at its centre. */
async function reachable(page: Page, testId: string): Promise<boolean> {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const vp = page.viewportSize()!;
  if (box.x < 0 || box.y < 0 || box.x + box.width > vp.width || box.y + box.height > vp.height) return false;
  return page.evaluate(({ x, y, id }) => !!document.elementFromPoint(x, y)?.closest(`[data-testid="${id}"]`), { x: box.x + box.width / 2, y: box.y + box.height / 2, id: testId });
}

for (const [w, h] of [
  [1400, 900],
  [1024, 800],
] as const) {
  test(`floating card (fixed answer) at ${w}×${h}: 8 px under the selection, inside the viewer, controls reachable, no request`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    const runRequests: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET' && !/\/position$/.test(new URL(r.url()).pathname)) runRequests.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await open(page, '?sl-card=fixed');
    await dragSelectText(page, { pageNumber: 1, text: QUOTE, ...T });
    const sel = await selectionBox(page);
    await page.keyboard.press('e');
    const card = page.getByTestId('rd-float-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-placement', 'below');
    const cb = (await card.boundingBox())!;
    expect(Math.abs(cb.y - sel.bottom - 8), `gap ${cb.y - sel.bottom}`).toBeLessThanOrEqual(1);
    const main = (await page.locator('main').boundingBox())!;
    expect(cb.x).toBeGreaterThanOrEqual(main.x);
    expect(cb.x + cb.width).toBeLessThanOrEqual(main.x + main.width + 0.5);
    expect(cb.y + cb.height).toBeLessThanOrEqual(main.y + main.height + 0.5);
    // the card takes the focus; Tab stays in its controls first
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="rd-float-card"]'))).toBe(true);
    for (const id of ['rd-float-close', 'rd-float-input', 'rd-float-send']) expect(await reachable(page, id), id).toBe(true);
    await expect(page.getByTestId('rd-float-send')).toBeDisabled();
    await page.getByTestId('rd-float-input').fill('왜 이 오차를 쓰나요?');
    await expect(page.getByTestId('rd-float-send')).toBeEnabled();
    await page.getByTestId('rd-float-send').click();
    await expect(page.getByTestId('rd-float-sent-note')).toContainText('보내지 않습니다');
    await expect(page.getByTestId('rd-float-input')).toHaveValue('');
    // no grounding marks on a fixed answer
    await expect(card.locator('[data-testid="sp-badge"], [data-testid="sp-chip"]')).toHaveCount(0);
    await page.getByTestId('rd-float-close').click();
    await expect(card).toHaveCount(0);
    // Esc closes a reopened card
    await dragSelectText(page, { pageNumber: 1, text: QUOTE, ...T });
    await page.keyboard.press('e');
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    expect(runRequests).toEqual([]);
  });
}

test('floating card follows scroll and zoom, docks off screen, and goes with the paper', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, '?sl-card=fixed');
  await dragSelectText(page, { pageNumber: 1, text: QUOTE, ...T });
  await page.keyboard.press('e');
  const card = page.getByTestId('rd-float-card');
  await expect(card).toBeVisible();
  const y0 = (await card.boundingBox())!.y;
  await page.locator('.PdfHighlighter').evaluate((el) => el.scrollBy(0, 40));
  await expect.poll(async () => Math.round(y0 - (await card.boundingBox())!.y)).toBe(40);
  // zoom: still 8 px under the same text (the highlight-free selection is re-measured from its NormRects)
  await page.getByTestId('zoom-in').click();
  const quoteBottom = async () =>
    page.evaluate((q) => {
      const span = Array.from(document.querySelectorAll('.page[data-page-number="1"] .textLayer span')).find((s) => s.children.length === 0 && s.textContent!.includes(q))!;
      return span.getBoundingClientRect().bottom;
    }, QUOTE);
  await expect.poll(async () => Math.abs((await card.boundingBox())!.y - (await quoteBottom()) - 8) <= 2, { timeout: 10_000 }).toBe(true);
  // the selection scrolled far away: the card docks inside the viewer
  await page.locator('.PdfHighlighter').evaluate((el) => el.scrollBy(0, 4000));
  await expect(card).toHaveAttribute('data-placement', 'dock');
  const main = (await page.locator('main').boundingBox())!;
  const docked = (await card.boundingBox())!;
  expect(docked.y + docked.height).toBeLessThanOrEqual(main.y + main.height);
  // another paper: the viewer (and its card) is replaced
  await page.goto(`/paper/${SEED_PAPER_ID}?sl-card=fixed`);
  await waitForPdf(page, { pageNumber: 1, ...T });
  await expect(page.getByTestId('rd-float-card')).toHaveCount(0);
});

test('without ?sl-card=fixed, E keeps the M2 path (the panel action), no floating card', async ({ page }) => {
  await open(page);
  await dragSelectText(page, { pageNumber: 1, text: QUOTE, ...T });
  await page.keyboard.press('e');
  await expect(page.getByTestId('panel-tab-ai')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('selection-text')).toContainText('We estimate');
  await expect(page.getByTestId('rd-float-card')).toHaveCount(0);
});

test('night theme and the original colours: the page filter goes and comes back, the text layer does not move', async ({ page }) => {
  await open(page);
  const span = pdfPage(page, 1).locator('.textLayer span', { hasText: QUOTE }).first();
  const before = (await span.boundingBox())!;
  const filter = () => pdfPage(page, 1).locator('.canvasWrapper').evaluate((el) => getComputedStyle(el).filter);
  const panelBg = () => page.getByTestId('side-panel').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await filter()).toBe('none');
  await expect(page.getByTestId('rd-paper-tone')).toHaveCount(0);
  await page.getByTestId('rd-theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('rd-theme-dark')).toHaveAttribute('aria-pressed', 'true');
  expect(await filter()).toContain('invert');
  const darkBg = await panelBg();
  const tone = page.getByTestId('rd-paper-tone');
  await expect(tone).toHaveText('원본 색 보기');
  await tone.click();
  await expect(tone).toHaveAttribute('aria-pressed', 'true');
  await expect(tone).toHaveText('Dark로 보기');
  expect(await filter()).toBe('none');
  expect(await panelBg()).toBe(darkBg); // only the page changes, the reader stays dark
  await tone.click();
  expect(await filter()).toContain('invert');
  expect(await span.boundingBox()).toEqual(before);
  await page.getByTestId('rd-theme-light').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  // The explicit theme follows the reader back to the Library.
  await page.getByTestId('rd-theme-dark').click();
  await page.getByRole('link', { name: '← Library' }).click();
  await expect(page.getByTestId('paper-list')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => localStorage.removeItem('sl.reader.theme'));
});

test('outline: a column on wide screens (toggle hides it), a drawer at 1024×800 (Esc closes, focus back)', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('rd-outline-column')).toBeVisible();
  const mainW = (await page.locator('main').boundingBox())!.width;
  const colW = (await page.getByTestId('rd-outline-column').boundingBox())!.width;
  expect(colW).toBeGreaterThanOrEqual(240);
  await page.getByTestId('rd-outline-toggle').click();
  await expect(page.getByTestId('rd-outline-column')).toHaveCount(0);
  await expect.poll(async () => Math.round((await page.locator('main').boundingBox())!.width - mainW)).toBe(Math.round(colW));
  await page.getByTestId('rd-outline-toggle').click();
  await expect(page.getByTestId('rd-outline-column')).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(page.getByTestId('rd-outline-column')).toHaveCount(0);
  await expect(page.getByTestId('rd-outline-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('rd-outline-toggle').click();
  const drawer = page.getByTestId('rd-outline-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('rd-outline-item')).toHaveCount(4);
  await expect(drawer).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId('rd-outline-toggle')).toBeFocused();
});

test('page-number box: jumps like any jump (뒤로 comes back), shows the page count', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('rd-page-count')).toHaveText('2');
  await expect(page.getByTestId('rd-page-input')).toHaveValue('1');
  await expect(page.getByTestId('rd-back')).toBeDisabled();
  await page.getByTestId('rd-page-input').fill('2');
  await page.getByTestId('rd-page-input').press('Enter');
  await waitForPdf(page, { pageNumber: 2, ...T });
  await expect(page.getByTestId('rd-page-input')).toHaveValue('2');
  await expect(page.getByTestId('rd-back')).toBeEnabled();
  await page.getByTestId('rd-back').click();
  await expect(page.getByTestId('rd-page-input')).toHaveValue('1');
  // out of range: nothing moves
  await page.getByTestId('rd-page-input').fill('9');
  await page.getByTestId('rd-page-input').press('Enter');
  await expect(page.getByTestId('rd-page-input')).toHaveValue('1');
});

test('right rail: the six tabs keep their names; counts come from the open paper (structure) and 0 is hidden', async ({ page }) => {
  await open(page);
  const rail = page.getByTestId('pn-rail');
  await expect(rail.getByRole('tab')).toHaveText(['AI', '하이라이트·노트', '카드', '수식', '참고문헌', '용어집']);
  await expect(rail.locator('[data-testid="pn-rail-count"][data-tab="equations"]')).toHaveText('7');
  await expect(rail.locator('[data-testid="pn-rail-count"][data-tab="references"]')).toHaveText('3');
  await expect(rail.locator('[data-testid="pn-rail-count"][data-tab="ai"]')).toHaveCount(0); // no thread after the reset
  await page.getByTestId('panel-hide').click();
  await page.getByTestId('pn-tab-equations').click();
  await expect(page.getByTestId('side-panel')).toHaveAttribute('data-hidden', 'false');
  await expect(page.getByTestId('pn-tab-equations')).toHaveAttribute('aria-selected', 'true');
});

test('paper info: version · pages, structure source · index, usage limit 미확인; Esc closes', async ({ page }) => {
  await open(page);
  await page.getByTestId('rd-paper-info').click();
  const pop = page.getByTestId('rd-paper-info-pop');
  await expect(pop).toBeVisible();
  await expect(page.getByTestId('rd-paper-info-version')).toHaveText(/^arXiv 2301\.00004(v\d+)? · 2쪽$/);
  await expect(page.getByTestId('rd-paper-info-structure')).toHaveText('arXiv HTML(LaTeXML) · 색인 v2');
  await expect(page.getByTestId('rd-paper-info-limit')).toHaveText('미확인');
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(page.getByTestId('rd-paper-info')).toBeFocused();
});
