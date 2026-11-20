// M1 integration (PLAN 9.4 "vertical slice"), all four builders' parts together, no route mocks. Owner: supervisor.
//   Library → open → select → explain (mock LLM over the real run manager) → citation chip jumps in the PDF →
//   follow-up question → highlight → reload: thread, citations and highlight are restored from the server.
//   dev only: import through the offline arXiv source (prod never uses it), then explain on the imported paper.
// Runs against prod (built app, CSP) and dev (Vite) projects.
import { expect, test, type Page } from '@playwright/test';
import { quoteEqualsN1 } from '../packages/shared/src/anchor/matchQuote';
import { ImportPaperResponse, ListProgressResponse, type ListThreadsResponse, type StructureResponse, type ThreadDetailResponse } from '../packages/shared/src/contracts/api';
import { inspectPngBytes } from '../packages/shared/src/image/png';
import { askInPanel, chooseCapture, ctrlDragArea, openPanelTab, openPaper, panelTab, pdfPage, selectAndPress, waitForAnswerTerminal, waitForPdf as waitForPdfAction } from './actions';
import { deletePapersByArxivId, OFFLINE_ARXIV, OFFLINE_ARXIV_K1, realJson, resetSeedState, SEED_LINKS_PAPER_ID, SEED_LINKS_TITLE, SEED_M2_PAPER_ID, SEED_M2_TITLE, SEED_TITLE, SEED_UPGRADE_PAPER_ID, SEED_UPGRADE_TITLE } from './helpers';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) errors.push(`csp: ${m.text()}`);
  });
  return errors;
}

async function waitForPdf(page: Page) {
  await page.waitForSelector('.page[data-page-number="1"] .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
}

async function dragSelect(page: Page, text: string, fraction = 0.6) {
  const span = page.locator('.page[data-page-number="1"] .textLayer span', { hasText: text }).first();
  const box = (await span.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('selection-toolbar')).toBeVisible();
}

test.beforeEach(async ({ baseURL }) => {
  await resetSeedState(baseURL!);
});

test('library → reader → explain → citation jump → follow-up → highlight → reload restores everything', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.getByRole('link', { name: SEED_TITLE }).click();
  await expect(page.getByTestId('paper-title')).toHaveText(SEED_TITLE);
  await waitForPdf(page);
  // The PDF canvas has ink.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const c = document.querySelector('.page[data-page-number="1"] canvas') as HTMLCanvasElement | null;
        if (!c || !c.width) return 0;
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! < 128) dark++;
        return dark;
      }),
    )
    .toBeGreaterThan(500);

  // Select → explain with the keyboard shortcut (viewer → store → panel → server → mock LLM).
  await dragSelect(page, 'We estimate the robot pose');
  await expect(page.getByTestId('selection-text')).toContainText('We estimate');
  await page.keyboard.press('e');
  const live = page.getByTestId('live-message');
  await expect(live).toHaveAttribute('data-phase', 'done', { timeout: 20_000 });
  const events = (await page.getByTestId('run-events').getAttribute('title')) ?? (await page.getByTestId('run-events').innerText());
  expect(events).toContain('run.accepted');
  expect(events).toContain('run.done');
  await expect(live.locator('[data-testid="sp-chip"][data-status="pending"]')).toHaveCount(0);
  await expect(live.locator('[data-testid="sp-chip"][data-status="verbatim"]')).toHaveCount(2);
  await expect(live.locator('[data-testid="sp-badge"][data-status="p-grounded"]').first()).toHaveText('논문 근거 · 인용 원문에서 찾음');
  await expect(live.locator('[data-testid="sp-badge"][data-status="p-unverified"]')).toHaveCount(1);
  await expect(page.getByText('검증됨')).toHaveCount(0);

  // Citation chip → the viewer scrolls and flashes exactly the quoted text.
  const chip = live.locator('[data-testid="sp-chip"][data-status="verbatim"]').first();
  const quote = ((await chip.getAttribute('title')) ?? '').split(' — ')[1] ?? ''; // title = "원문에서 찾음 — <quote>"
  await chip.click();
  const flash = page.getByTestId('citation-flash');
  await expect(flash).toHaveCount(1);
  const flashed = (await flash.getAttribute('data-flash-text')) ?? '';
  expect(flashed.length).toBeGreaterThan(10);
  expect(quote.length).toBeGreaterThan(10);
  expect(quoteEqualsN1(flashed, quote)).toBe(true);
  await expect(live.getByTestId('sp-not-located')).toHaveCount(0);

  // Follow-up question in the same thread (messages.create, history from the server).
  await page.getByPlaceholder('후속 질문을 입력하세요').fill('robust kernel은 왜 쓰나?');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('message-user').last()).toContainText('robust kernel은 왜 쓰나?', { timeout: 20_000 });
  // The first answer is now a stored message; the new answer streams in the live message until it is done.
  await expect(page.getByTestId('message-assistant')).toHaveCount(1, { timeout: 20_000 });
  await expect(live).toHaveAttribute('data-phase', 'done', { timeout: 20_000 });
  expect(await live.innerText()).not.toContain('[[P]]'); // raw labels never leak into the rendered answer

  // Highlight with H, then reload: highlight, thread and citation states come back from the server.
  await dragSelect(page, 'Each scan is deskewed', 0.9);
  await page.keyboard.press('h');
  await expect(page.locator('[data-testid="highlight"]')).toHaveCount(1);
  const before = await page.locator('[data-testid="highlight-part"]').first().boundingBox();
  await page.reload();
  await waitForPdf(page);
  await expect(page.locator('[data-testid="highlight"]')).toHaveCount(1);
  const after = await page.locator('[data-testid="highlight-part"]').first().boundingBox();
  expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
  await page.getByTestId('thread-item').first().click();
  await expect(page.getByTestId('message-assistant')).toHaveCount(2);
  await expect(page.getByTestId('message-assistant').first().locator('[data-testid="sp-chip"][data-status="verbatim"]')).toHaveCount(2);
  await page.getByTestId('panel-tab-highlights').click();
  await expect(page.getByTestId('side-panel')).toContainText('Each scan is deskewed');

  expect(errors).toEqual([]);
});

test('dev only: import through the offline arXiv source → states → open → explain', async ({ page }) => {
  test.skip(test.info().project.name !== 'dev', 'the offline arXiv source is never used in prod');
  const errors = watchErrors(page);
  await page.goto('/');
  await page.getByTestId('import-input').fill(`${OFFLINE_ARXIV.id}v${OFFLINE_ARXIV.version}`);
  await page.getByTestId('import-button').click();
  const row = page.locator('[data-testid="paper-row"]', { hasText: OFFLINE_ARXIV.title });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row.getByTestId('paper-status')).toHaveText('AI 사용 가능', { timeout: 30_000 });
  // Importing the same id again opens nothing new.
  await page.getByTestId('import-input').fill(OFFLINE_ARXIV.id);
  await page.getByTestId('import-button').click();
  await expect(page.getByTestId('import-message')).toBeVisible();
  await expect(page.locator('[data-testid="paper-row"]', { hasText: OFFLINE_ARXIV.title })).toHaveCount(1);

  await row.getByRole('link', { name: OFFLINE_ARXIV.title }).click();
  await expect(page.getByTestId('paper-title')).toHaveText(OFFLINE_ARXIV.title);
  await waitForPdf(page);
  await dragSelect(page, 'We estimate the robot pose');
  await page.getByTestId('toolbar-explain').click();
  const live = page.getByTestId('live-message');
  await expect(live).toHaveAttribute('data-phase', 'done', { timeout: 20_000 });
  await expect(live.locator('[data-testid="sp-chip"][data-status="verbatim"]')).toHaveCount(2);
  expect(errors).toEqual([]);
});

// =================================================================================================================
// M2 integration (PLAN_M2 7절 2, BRIEF_INTEGRATION I3): the M2 flows across C (viewer), D (panel), A and B (server)
// with the real servers and the mock LLM — no route mocks (C's and D's specs saw these connections only through
// mocks). K1–K8 are the required flows, X1–X7 the extra round trips. Screen actions come from e2e/actions.ts (shared
// with the live E2E script); seed state is reset per test, and state the reset does not remove (cards, glossary,
// notes, progress) is asserted on what the test itself made.
// testids: viewer rd-… (C), panel pn-… (D), M1 names unchanged.

const T = 15_000; // e2e waits (mock LLM answers within a second)
const M2_PAPERS = [SEED_M2_PAPER_ID, SEED_LINKS_PAPER_ID] as const;

test.describe('M2 flows', () => {
  test.beforeEach(async ({ baseURL }) => {
    await resetSeedState(baseURL!, M2_PAPERS);
  });

  const structureOf = (baseURL: string, id: string) => realJson<StructureResponse>(baseURL, 'papers.structure', { params: { id } });
  const outlineItem = (page: Page, number: string) => page.locator(`[data-testid="rd-outline-item"][data-section-number="${number}"]`);
  /** The outline link of that section itself (an item contains its sub-sections' items). */
  const outlineLink = (page: Page, number: string) => outlineItem(page, number).getByTestId('rd-outline-link').first();
  /** The y of page 1's box: the reader's scroll position, read through the layout (±2 px comparisons). */
  const page1Y = async (page: Page) => (await pdfPage(page, 1).boundingBox())!.y;

  test('K1 dev only: offline import with HTML → "AI 사용 가능" + "색인 v2" → outline 4 · numbered equations 6, II-A / II-B disabled', async ({ page, baseURL }) => {
    test.skip(test.info().project.name !== 'dev', 'the offline arXiv source is never used in prod');
    const errors = watchErrors(page);
    await deletePapersByArxivId(baseURL!, OFFLINE_ARXIV_K1.id); // a retried K1 starts without its earlier import
    await page.goto('/');
    await page.getByTestId('import-input').fill(`${OFFLINE_ARXIV_K1.id}v${OFFLINE_ARXIV_K1.version}`);
    const imported = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/papers/import', { timeout: T });
    await page.getByTestId('import-button').click();
    const res = await imported;
    expect(res.status()).toBe(200);
    const body = ImportPaperResponse.parse(await res.json());
    expect(body.existing).toBe(false);
    const row = page.locator(`[data-testid="paper-row"][data-paper-id="${body.paperId}"]`);
    await expect(row.getByTestId('paper-status')).toHaveText('AI 사용 가능', { timeout: 30_000 });
    await expect(row.getByTestId('rd-structure-badge')).toHaveText('색인 v2', { timeout: 30_000 });

    await row.getByRole('link', { name: OFFLINE_ARXIV_K1.title }).click();
    await expect(page.getByTestId('paper-title')).toHaveText(OFFLINE_ARXIV_K1.title);
    await waitForPdfAction(page, { timeoutMs: 30_000 });
    await expect(page.getByTestId('rd-outline-item')).toHaveCount(4);
    // this paper's PDF is the M1 synthetic.pdf: no "A. Robust Kernel" heading, no II-B → both have no PDF position
    for (const n of ['II-A', 'II-B']) await expect(outlineLink(page, n)).toHaveAttribute('aria-disabled', 'true');
    for (const n of ['I', 'II']) await expect(outlineLink(page, n)).not.toHaveAttribute('aria-disabled', 'true');
    await openPanelTab(page, 'equations', { timeoutMs: T });
    await expect(page.getByTestId('pn-eq-list').getByTestId('pn-eq-item')).toHaveCount(6);
    const st = await structureOf(baseURL!, body.paperId);
    expect(st.structureSource).toBe('latexml');
    expect(st.sections.map((s) => s.number)).toEqual(['I', 'II', 'II-A', 'II-B']);
    expect(st.equations.filter((e) => e.number !== null)).toHaveLength(6);
    expect(errors).toEqual([]);
  });

  test('K2: outline "II-A Robust Kernel" → section flash on page 2; equations tab, equation 1 → equation flash', async ({ page, baseURL }) => {
    const errors = watchErrors(page);
    const st = await structureOf(baseURL!, SEED_M2_PAPER_ID);
    const iia = st.sections.find((s) => s.number === 'II-A')!;
    expect(iia.pdfPage).toBe(2);
    const eq1 = st.equations.find((e) => e.number === '1')!;
    expect(eq1.pdfPage).not.toBeNull();
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    const link = outlineLink(page, 'II-A');
    await expect(link).toContainText('Robust Kernel');
    await link.click();
    await expect(pdfPage(page, 2).getByTestId('rd-section-flash')).toHaveCount(1);
    await expect(pdfPage(page, 2).getByTestId('rd-section-flash').locator('.sp-flash-part')).toBeInViewport();

    await openPanelTab(page, 'equations', { timeoutMs: T });
    const item = page.locator(`[data-testid="pn-eq-item"][data-equation-id="${eq1.id}"]`);
    await item.getByTestId('pn-eq-jump').click();
    await expect(pdfPage(page, eq1.pdfPage!).getByTestId('rd-eq-flash')).toHaveCount(1);
    await expect(pdfPage(page, eq1.pdfPage!).getByTestId('rd-eq-flash').locator('.sp-flash-part')).toBeInViewport();
    expect(errors).toEqual([]);
  });

  test('K3: the <eq n="1"/> chip of an explain answer (resolved) → equation flash on its page; "뒤로" returns (±2 px)', async ({ page, baseURL }) => {
    const errors = watchErrors(page);
    const eq1 = (await structureOf(baseURL!, SEED_M2_PAPER_ID)).equations.find((e) => e.number === '1')!;
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    const start = () => selectAndPress(page, { pageNumber: 1, text: 'We estimate the robot pose', key: 'e', timeoutMs: T });
    expect(await waitForAnswerTerminal(page, { start, timeoutMs: T })).toBe('done');
    const chip = page.getByTestId('live-message').locator('[data-testid="sp-chip"][data-status="resolved"]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText('식 (1)');
    // start from a place the jump must leave: page 2 at the top of the viewer
    await pdfPage(page, 2).scrollIntoViewIfNeeded();
    await page.mouse.move(10, 10);
    const before = await page1Y(page);
    await expect(page.getByTestId('rd-back')).toBeDisabled();
    await chip.click();
    await expect(pdfPage(page, eq1.pdfPage!).getByTestId('rd-eq-flash')).toHaveCount(1);
    await expect(pdfPage(page, eq1.pdfPage!).getByTestId('rd-eq-flash').locator('.sp-flash-part')).toBeInViewport();
    // the jump really moved the viewer (otherwise the "뒤로" check below would pass with a back button that does nothing)
    await expect.poll(async () => Math.abs((await page1Y(page)) - before)).toBeGreaterThan(50);
    await expect(page.getByTestId('rd-back')).toBeEnabled();
    await page.getByTestId('rd-back').click();
    await expect.poll(async () => Math.abs((await page1Y(page)) - before)).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });

  test('K4: notation card generate (real cards.generate) → 11 items with badges; "확인함" ×2 survives a reload (real cardItems.patch)', async ({ page }) => {
    const errors = watchErrors(page);
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    await openPanelTab(page, 'cards', { timeoutMs: T });
    const notation = page.locator('[data-testid="pn-card-section"][data-kind="notation"]');
    const regenerate = notation.getByTestId('pn-card-regenerate');
    // the sections appear only after cards.list answered: wait for the one button before choosing the branch
    await expect(notation.locator('[data-testid="pn-card-generate"], [data-testid="pn-card-regenerate"]')).toHaveCount(1, { timeout: T });
    if (await regenerate.count()) {
      // an earlier test of this server already made one (a retry): the confirmation dialog, then a new card
      await regenerate.click();
      await notation.getByTestId('pn-card-regen-confirm').click();
    } else await notation.getByTestId('pn-card-generate').click();
    await expect(notation.getByTestId('pn-card-item')).toHaveCount(11, { timeout: T });
    await expect(notation.locator('[data-testid="pn-item-badge"][data-badge="grounded_quote"]')).toHaveCount(4);
    await expect(notation.locator('[data-testid="pn-item-badge"][data-badge="equation_ref"]')).toHaveCount(1);
    await expect(notation.locator('[data-count="grounded_quote"]')).toHaveText('논문 근거 4');
    await expect(notation.locator('[data-count="confirmed"]')).toHaveText('확인함 0 / 11');
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/card-items\//.test(new URL(r.url()).pathname) && r.status() === 200, { timeout: T });
    await notation.getByTestId('pn-card-confirm').nth(0).check();
    await saved;
    const saved2 = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/card-items\//.test(new URL(r.url()).pathname) && r.status() === 200, { timeout: T });
    await notation.getByTestId('pn-card-confirm').nth(1).check();
    await saved2;
    await expect(notation.locator('[data-count="confirmed"]')).toHaveText('확인함 2 / 11');
    await page.reload();
    await waitForPdfAction(page, { timeoutMs: 30_000 });
    await openPanelTab(page, 'cards', { timeoutMs: T });
    await expect(notation.locator('[data-count="confirmed"]')).toHaveText('확인함 2 / 11');
    await expect(notation.getByTestId('pn-card-confirm').nth(0)).toBeChecked();
    await expect(notation.getByTestId('pn-card-confirm').nth(1)).toBeChecked();
    expect(errors).toEqual([]);
  });

  test('K5: Ctrl+drag → "그림·표 설명" → a figure thread with the stored capture (papers.capture 200, inspectPng) and a done answer', async ({ page }) => {
    const errors = watchErrors(page);
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    await ctrlDragArea(page, { pageNumber: 1, from: [0.1, 0.15], to: [0.6, 0.4], timeoutMs: T });
    const capture = page.waitForResponse((r) => r.request().method() === 'GET' && new RegExp(`^/api/papers/${SEED_M2_PAPER_ID}/captures/[^/]+$`).test(new URL(r.url()).pathname), { timeout: T });
    expect(await waitForAnswerTerminal(page, { start: () => chooseCapture(page, 'figure', { timeoutMs: T }), timeoutMs: T })).toBe('done');
    const img = page.getByTestId('pn-thread-image');
    await expect(img).toBeVisible();
    const res = await capture;
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
    const png = inspectPngBytes(new Uint8Array(await res.body()));
    expect(png.ok).toBe(true);
    expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const threads = (await realJson<ListThreadsResponse>(test.info().project.use.baseURL!, 'threads.list', { params: { id: SEED_M2_PAPER_ID } })).threads;
    expect(threads.map((t) => t.kind)).toEqual(['figure']);
    expect(threads[0]!.imageFileId).toBe(new URL(res.url()).pathname.split('/').at(-1));
    expect(errors).toEqual([]);
  });

  test('K6: selection → T → a translate thread: no chip, no follow-up input', async ({ page, baseURL }) => {
    const errors = watchErrors(page);
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    const start = () => selectAndPress(page, { pageNumber: 1, text: 'We estimate the robot pose', key: 't', timeoutMs: T });
    expect(await waitForAnswerTerminal(page, { start, timeoutMs: T })).toBe('done');
    const live = page.getByTestId('live-message');
    await expect(live).toContainText('잔차');
    await expect(live.getByTestId('sp-chip')).toHaveCount(0);
    await expect(live.getByTestId('sp-badge')).toHaveCount(0);
    await expect(page.getByTestId('followup-input')).toHaveCount(0);
    const threads = (await realJson<ListThreadsResponse>(baseURL!, 'threads.list', { params: { id: SEED_M2_PAPER_ID } })).threads;
    expect(threads.map((t) => t.kind)).toEqual(['translate']);
    expect(errors).toEqual([]);
  });

  test('K7: the [1] link on page 1 (SEED_LINKS) → references tab, item 1 highlighted; the viewer does not move', async ({ page }) => {
    const errors = watchErrors(page);
    await openPaper(page, { paperId: SEED_LINKS_PAPER_ID, title: SEED_LINKS_TITLE, timeoutMs: 30_000 });
    const links = pdfPage(page, 1).locator('.annotationLayer a');
    await expect(links).toHaveCount(2, { timeout: T });
    const boxes = [(await links.nth(0).boundingBox())!, (await links.nth(1).boundingBox())!];
    const cite = links.nth(boxes[0]!.y < boxes[1]!.y ? 1 : 0); // "Section II" is on the upper line, "[1]" below
    await expect(panelTab(page, 'references')).toHaveAttribute('aria-selected', 'false');
    const before = await page1Y(page);
    await cite.click();
    await expect(panelTab(page, 'references')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-testid="pn-ref-item"][data-ordinal="1"]')).toHaveAttribute('data-focused', '1');
    await expect(page.locator('[data-testid="pn-ref-item"][data-focused="1"]')).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(Math.abs((await page1Y(page)) - before)).toBeLessThanOrEqual(0.5);
    await expect(page.getByTestId('rd-back')).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test('K8: chat with "깊게" → the real answer shows "깊게" (effort high), the toggle is off for the next question', async ({ page, baseURL }) => {
    const errors = watchErrors(page);
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    const toggle = page.getByTestId('pn-deep-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const created = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/papers/${SEED_M2_PAPER_ID}/threads`, { timeout: T });
    const start = () => askInPanel(page, { question: '왜 point-to-point residual을 쓰나요?', deep: true, timeoutMs: T });
    expect(await waitForAnswerTerminal(page, { start, timeoutMs: T })).toBe('done');
    expect((await created).postDataJSON()).toMatchObject({ kind: 'chat', deep: true });
    await expect(page.getByTestId('live-message').getByTestId('pn-deep-label')).toHaveText('깊게');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const threads = (await realJson<ListThreadsResponse>(baseURL!, 'threads.list', { params: { id: SEED_M2_PAPER_ID } })).threads;
    expect(threads.map((t) => t.kind)).toEqual(['chat']);
    const detail = await realJson<ThreadDetailResponse>(baseURL!, 'threads.get', { params: { id: threads[0]!.id } });
    expect(detail.messages.filter((m) => m.role === 'assistant').map((m) => m.effort)).toEqual(['high']);
    // after a reload the stored answer keeps the label and the toggle stays off
    await page.reload();
    await waitForPdfAction(page, { timeoutMs: 30_000 });
    await page.locator(`[data-testid="thread-item"][data-thread-id="${threads[0]!.id}"]`).click();
    await expect(page.getByTestId('message-assistant').getByTestId('pn-deep-label')).toHaveText('깊게');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  });

  // ---- extra round trips (C / D specs saw them through mock stores only) ----

  test('X1: page 2 + zoom → papers.position (real) → reload reopens the same page and zoom', async ({ page }) => {
    const errors = watchErrors(page);
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    await page.getByTestId('zoom-in').click();
    const zoomText = (await page.getByTestId('zoom-level').textContent())!;
    expect(zoomText).toMatch(/^\d+%$/);
    const put = page.waitForRequest((r) => r.method() === 'PUT' && new URL(r.url()).pathname === `/api/papers/${SEED_M2_PAPER_ID}/position` && (r.postDataJSON() as { page: number }).page === 2, { timeout: T });
    await page.evaluate(() => (window as unknown as SpViewerWindow).__spViewer.getViewer().scrollPageIntoView({ pageNumber: 2 }));
    const body = (await put).postDataJSON() as { page: number; zoom: number; mode: string };
    expect(body.mode).toBe('custom');
    expect(Math.round(body.zoom * 100)).toBe(Number(zoomText.replace('%', '')));
    await page.waitForTimeout(500); // the PUT above is answered before the reload
    await page.reload();
    await waitForPdfAction(page, { pageNumber: 2, timeoutMs: 30_000 });
    await expect(page.getByTestId('zoom-level')).toHaveText(zoomText);
    await expect.poll(() => topPage(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('X2: reading progress — two clicks on II-A (real progress.put) → "이해" after a reload', async ({ page, baseURL }) => {
    const errors = watchErrors(page);
    const iiaId = (await structureOf(baseURL!, SEED_M2_PAPER_ID)).sections.find((s) => s.number === 'II-A')!.id;
    const listed = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/papers/${SEED_M2_PAPER_ID}/progress` && r.ok(), { timeout: 30_000 });
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    const toggle = outlineItem(page, 'II-A').getByTestId('rd-progress-toggle');
    // the toggle shows "안 읽음" until progress.list answered: read its state only once it shows the stored one
    const stored = ListProgressResponse.parse(await (await listed).json()).progress.find((p) => p.sectionId === iiaId)?.state ?? 'unread';
    await expect(toggle).toHaveAttribute('data-state', stored);
    // progress is not reset between tests: cycle to "안 읽음" first (at most three states away)
    for (let i = 0; i < 3 && (await toggle.getAttribute('data-state')) !== 'unread'; i++) {
      const prev = await toggle.getAttribute('data-state');
      await toggle.click();
      await expect(toggle).not.toHaveAttribute('data-state', prev!);
    }
    await expect(toggle).toHaveText('안 읽음');
    const puts: unknown[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && /\/progress\//.test(new URL(r.url()).pathname)) puts.push(r.postDataJSON());
    });
    await toggle.click();
    await expect(toggle).toHaveText('훑음');
    await toggle.click();
    await expect(toggle).toHaveText('이해');
    await expect.poll(() => puts).toEqual([{ state: 'skimmed' }, { state: 'understood' }]);
    await page.waitForTimeout(500);
    await page.reload();
    await expect(outlineItem(page, 'II-A').getByTestId('rd-progress-toggle')).toHaveText('이해', { timeout: T });
    expect(errors).toEqual([]);
  });

  test('X3: area highlight (real highlights.create) → same place after a reload (±2 px) + its thumbnail in the panel', async ({ page }) => {
    const errors = watchErrors(page);
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    await ctrlDragArea(page, { pageNumber: 1, from: [0.15, 0.5], to: [0.5, 0.62], timeoutMs: T });
    await chooseCapture(page, 'highlight', { timeoutMs: T });
    const part = pdfPage(page, 1).locator('[data-testid="highlight"][data-kind="area"] [data-testid="highlight-part"]');
    await expect(part).toHaveCount(1, { timeout: T });
    const before = (await part.boundingBox())!;
    const relBefore = { x: before.x, y: before.y - (await page1Y(page)), w: before.width, h: before.height };
    await page.reload();
    await waitForPdfAction(page, { timeoutMs: 30_000 });
    await expect(part).toHaveCount(1, { timeout: T });
    const after = (await part.boundingBox())!;
    const relAfter = { x: after.x, y: after.y - (await page1Y(page)), w: after.width, h: after.height };
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(relAfter[k] - relBefore[k]), k).toBeLessThanOrEqual(2);
    const thumb = page.waitForResponse((r) => r.request().method() === 'GET' && new RegExp(`^/api/papers/${SEED_M2_PAPER_ID}/captures/[^/]+$`).test(new URL(r.url()).pathname), { timeout: T });
    await openPanelTab(page, 'highlights', { timeoutMs: T });
    const img = page.getByTestId('pn-highlight-thumb');
    await expect(img).toBeVisible({ timeout: T });
    const res = await thumb;
    expect(res.status()).toBe(200);
    expect(inspectPngBytes(new Uint8Array(await res.body())).ok).toBe(true);
    expect(errors).toEqual([]);
  });

  test('X5: glossary "정의 요청" (real glossary.define) → suggestion → 저장 → in the list as "AI 제안"', async ({ page }) => {
    const errors = watchErrors(page);
    const term = `fixed threshold ${Date.now().toString(36)}`; // terms are not reset between tests
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    await openPanelTab(page, 'glossary', { timeoutMs: T });
    await page.getByTestId('pn-glossary-define-term').fill(term);
    await page.getByTestId('pn-glossary-define-start').click();
    await expect(page.getByTestId('pn-glossary-suggestion')).toContainText('robust kernel은', { timeout: T });
    const mine = page.locator('[data-testid="pn-glossary-item"]', { hasText: term });
    await expect(mine).toHaveCount(0); // not stored before 저장
    await page.getByTestId('pn-glossary-suggestion-save').click();
    await expect(mine).toHaveCount(1, { timeout: T });
    await expect(mine.getByTestId('pn-glossary-origin')).toHaveText('AI 제안');
    await page.reload();
    await waitForPdfAction(page, { timeoutMs: 30_000 });
    await openPanelTab(page, 'glossary', { timeoutMs: T });
    await expect(mine).toHaveCount(1, { timeout: T });
    await expect(mine.getByTestId('pn-glossary-origin')).toHaveText('AI 제안');
    expect(errors).toEqual([]);
  });

  test('X6: a note (real notes.create) stays after a reload', async ({ page }) => {
    const errors = watchErrors(page);
    const text = `통합 노트 ${Date.now().toString(36)}`; // notes are not reset between tests
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    await openPanelTab(page, 'highlights', { timeoutMs: T });
    await page.getByTestId('pn-note-new').click();
    await page.getByTestId('pn-note-input').fill(text);
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/papers/${SEED_M2_PAPER_ID}/notes` && r.status() === 200, { timeout: T });
    await page.getByTestId('pn-note-save').click();
    await created;
    const mine = page.locator('[data-testid="pn-note-item"]', { hasText: text });
    await expect(mine).toHaveCount(1, { timeout: T });
    await page.reload();
    await waitForPdfAction(page, { timeoutMs: 30_000 });
    await openPanelTab(page, 'highlights', { timeoutMs: T });
    await expect(mine).toHaveCount(1, { timeout: T });
    expect(errors).toEqual([]);
  });

  test('X7: reference [2] (arXiv 2301.00003 = SEED_LINKS) shows "Library에 있음"; [3] (not in the Library) offers the import', async ({ page }) => {
    const errors = watchErrors(page);
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    await openPanelTab(page, 'references', { timeoutMs: T });
    await expect(page.getByTestId('pn-ref-item')).toHaveCount(3);
    await expect(page.locator('[data-testid="pn-ref-item"][data-ordinal="2"]').getByTestId('pn-ref-in-library')).toBeVisible();
    await expect(page.locator('[data-testid="pn-ref-item"][data-ordinal="3"]').getByTestId('pn-ref-in-library')).toHaveCount(0);
    await expect(page.locator('[data-testid="pn-ref-item"][data-ordinal="3"]').getByTestId('pn-ref-import')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('X8: two answers on one page — waitForAnswerTerminal returns the answer its gesture started, never the earlier done one', async ({ page, baseURL }) => {
    const errors = watchErrors(page);
    await openPaper(page, { paperId: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, timeoutMs: 30_000 });
    const explain = () => selectAndPress(page, { pageNumber: 1, text: 'We estimate the robot pose', key: 'e', timeoutMs: T });
    expect(await waitForAnswerTerminal(page, { start: explain, timeoutMs: T })).toBe('done');
    // the same selection again reopens the stored thread (no request): the wait throws although the earlier answer
    // still shows as done in the panel
    await expect(waitForAnswerTerminal(page, { start: explain, timeoutMs: 3_000 })).rejects.toThrow(/did not start an answer/);
    await expect(page.locator('[data-testid="live-message"][data-phase="done"]')).toHaveCount(1);
    // a follow-up in that thread (messages.create): 'done' only once the second answer is stored
    const followUp = () => askInPanel(page, { question: '이 잔차는 어디에서 쓰이나요?', timeoutMs: T });
    expect(await waitForAnswerTerminal(page, { start: followUp, timeoutMs: T })).toBe('done');
    const threads = (await realJson<ListThreadsResponse>(baseURL!, 'threads.list', { params: { id: SEED_M2_PAPER_ID } })).threads;
    expect(threads.map((t) => t.kind)).toEqual(['explain']);
    const detail = await realJson<ThreadDetailResponse>(baseURL!, 'threads.get', { params: { id: threads[0]!.id } });
    expect(detail.messages.filter((m) => m.role === 'assistant').map((m) => m.status)).toEqual(['complete', 'complete']);
    expect(errors).toEqual([]);
  });

  // Last in the file: the upgrade changes SEED_UPGRADE for the rest of this dev server's life.
  test('X4 dev only: structure upgrade of SEED_UPGRADE (real job, offline HTML) → steps → "색인 v2" → the reader shows the outline', async ({ page }) => {
    test.skip(test.info().project.name !== 'dev', 'the offline arXiv source (the HTML the upgrade fetches) is never used in prod');
    const errors = watchErrors(page);
    await page.goto('/');
    const row = page.locator(`[data-testid="paper-row"][data-paper-id="${SEED_UPGRADE_PAPER_ID}"]`);
    await expect(row.getByTestId('rd-structure-badge')).toHaveText('구조 색인 만들 수 있음', { timeout: T });
    await row.getByTestId('rd-upgrade-button').click();
    await row.getByTestId('rd-upgrade-confirm-yes').click();
    await expect(row.getByTestId('rd-upgrade-done')).toBeVisible({ timeout: 30_000 });
    await expect(row.getByTestId('rd-upgrade-steps')).toContainText('구조: 완료');
    await expect(row.getByTestId('rd-structure-badge')).toHaveText('색인 v2');
    await row.getByRole('link', { name: SEED_UPGRADE_TITLE }).click();
    await expect(page.getByTestId('paper-title')).toHaveText(SEED_UPGRADE_TITLE);
    await expect(page.getByTestId('rd-outline-tree')).toBeVisible({ timeout: T });
    await expect(page.getByTestId('rd-outline-item')).toHaveCount(4);
    await expect(page.getByTestId('rd-outline-empty')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

type SpViewerWindow = Window & { __spViewer: { getViewer(): { container: HTMLElement; scrollPageIntoView(o: object): void } } };
/** The page at the top edge of the viewer's scroll container (same rule as viewer/position.ts). */
const topPage = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as SpViewerWindow).__spViewer.getViewer().container.getBoundingClientRect().top;
    const p = Array.from(document.querySelectorAll<HTMLElement>('.page[data-page-number]')).find((e) => e.getBoundingClientRect().bottom > c + 0.5);
    return p ? Number(p.dataset.pageNumber) : null;
  });
