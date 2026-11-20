// Reader M1 (BRIEF_C acceptance): selection → toolbar, H → highlight (reload and server restart keep it at the
// same place ±2 px), zoom alignment, multi-line rects, E → readerStore.pendingAction, citation jump (verbatim
// flash text == quote; ambiguous / fuzzy never highlighted), shortcuts inert while an input has focus, explain
// disabled before context_ready, multi-page selection notice, Library import/progress/failure (route mocks).
//
// Highlights: while A's highlights.* routes answer 501 on this branch, the routes are served from an in-test
// store (every POST body is validated with contracts/api.ts CreateHighlightRequest). Once the server implements
// them, the real responses pass through unchanged and the reload/restart checks exercise real persistence.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { CreateHighlightRequest, ImportPaperRequest, type HighlightDto } from '../packages/shared/src/contracts/api';
import { formatSseEvent, type SseEvent } from '../packages/shared/src/contracts/sse';
import type { Citation } from '../packages/shared/src/contracts/domain';
import { matchQuote, quoteEqualsN1 } from '../packages/shared/src/anchor/matchQuote';
import { E2E_PORTS } from '../playwright.config';
import { rawRequest, resetSeedState, SEED_PAPER_ID, SEED_TITLE } from './helpers';
// M2 (BRIEF_C): contract-checked mocks for routes whose M2 behaviour other builders own.
import { LastPositionDto, PutProgressRequest, type ListPapersResponse, type PaperDetailDto, type ProgressDto, type StructureResponse } from '../packages/shared/src/contracts/api';
import { inspectPng } from '../packages/shared/src/image/png';
import { createMockStore, makeTestPng, mockRoute, mockViolations, pngSize, realJson, SEED_LINKS_PAPER_ID, SEED_LINKS_TITLE, SEED_M2_PAPER_ID, SEED_M2_TITLE, SEED_UPGRADE_PAPER_ID, SEED_UPGRADE_TITLE } from './helpers';

const projectName = () => test.info().project.name as 'prod' | 'dev';

// The highlights routes are real now: tests of one project share the server, so each starts from the seeded state.
test.beforeEach(async ({ baseURL }) => {
  await resetSeedState(baseURL!);
});

// ---------------------------------------------------------------------------------------------
// Helpers

interface HighlightStore {
  items: HighlightDto[];
  bodies: unknown[];
  invalid: string[];
  mocked: boolean;
}
const newStore = (): HighlightStore => ({ items: [], bodies: [], invalid: [], mocked: false });

/** highlights.* through the real server unless it answers 501, then from `store`. */
async function routeHighlights(page: Page, store: HighlightStore) {
  await page.route(/\/api\/papers\/[^/]+\/highlights$/, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      store.bodies.push(body);
      const parsed = CreateHighlightRequest.safeParse(body);
      if (!parsed.success) store.invalid.push(JSON.stringify(parsed.error.issues));
    }
    const real = await route.fetch();
    if (real.status() !== 501) return route.fulfill({ response: real });
    store.mocked = true;
    if (req.method() === 'GET') return route.fulfill({ json: { highlights: store.items } });
    const parsed = CreateHighlightRequest.safeParse(req.postDataJSON());
    if (!parsed.success) return route.fulfill({ status: 400, json: { error: { code: 'validation', message: 'invalid highlight' } } });
    const paperId = decodeURIComponent(new URL(req.url()).pathname.split('/')[3]!);
    const now = Date.now();
    const b = parsed.data;
    const dto: HighlightDto = { id: crypto.randomUUID(), paperId, kind: b.kind, color: b.color, quote: b.quote ?? null, position: null, page: b.page, rects: b.rects, sectionId: null, comment: b.comment ?? null, imageFileId: null, createdAt: now, updatedAt: now };
    store.items.push(dto);
    return route.fulfill({ json: dto });
  });
  await page.route(/\/api\/highlights\/[^/]+$/, async (route) => {
    const req = route.request();
    const real = await route.fetch();
    if (real.status() !== 501) return route.fulfill({ response: real });
    store.mocked = true;
    const id = decodeURIComponent(new URL(req.url()).pathname.split('/').pop()!);
    const i = store.items.findIndex((h) => h.id === id);
    if (i < 0) return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'no highlight' } } });
    if (req.method() === 'DELETE') {
      store.items.splice(i, 1);
      return route.fulfill({ status: 204, body: '' });
    }
    store.items[i] = { ...store.items[i]!, ...(req.postDataJSON() as object), updatedAt: Date.now() };
    return route.fulfill({ json: store.items[i] });
  });
}

const pageEl = (page: Page, n: number) => page.locator(`.page[data-page-number="${n}"]`);
const span = (page: Page, n: number, text: string) => pageEl(page, n).locator('.textLayer span', { hasText: text }).first();

async function openSeed(page: Page, base = '') {
  await page.goto(`${base}/paper/${SEED_PAPER_ID}`);
  await expect(page.getByTestId('paper-title')).toHaveText(SEED_TITLE);
  await page.waitForSelector('.page[data-page-number="1"] .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
}

/** Mouse drag from a fraction of one element's width to a fraction of another's (vertical middle). */
async function drag(page: Page, from: Locator, fromFrac: number, to: Locator, toFrac: number) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width * fromFrac, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * toFrac, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

/**
 * Selects whole spans programmatically (first span start → last span end) the way a mouse selection reaches the
 * viewer: a bubbling pointerdown on the first span (inside .pdfViewer — this is what releases a panel input's focus,
 * BRIEF_C focus carry-over), then the Range, then the pointerup on the last span.
 */
async function selectSpans(page: Page, firstSel: string, lastSel: string) {
  await page.evaluate((a) => {
    const first = document.querySelector(a)!;
    if (!first.closest('.pdfViewer')) throw new Error(`${a} is not inside .pdfViewer`);
    const b = first.getBoundingClientRect();
    first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: b.left + 1, clientY: b.top + b.height / 2 }));
  }, firstSel);
  await page.evaluate(
    ([a, b]) => {
      const first = document.querySelector(a)!;
      const last = document.querySelector(b)!;
      const r = document.createRange();
      r.setStart(first.firstChild!, 0);
      r.setEnd(last.firstChild!, (last.firstChild as Text).data.length);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
      last.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    },
    [firstSel, lastSel] as const,
  );
}
/**
 * What a user does before a bare shortcut key when a panel input holds the focus: one press on an empty spot of
 * PDF page n (pointerdown + pointerup inside .pdfViewer, no text under it), which releases the panel focus and
 * makes no selection. Throws if the spot is not an empty part of the page.
 */
async function pressEmptyPdfSpot(page: Page, n = 1, at: [number, number] = [0.5, 0.9]) {
  await page.evaluate(
    ([n, fx, fy]) => {
      const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
      const x = p.left + p.width * fx;
      const y = p.top + p.height * fy;
      const el = document.elementFromPoint(x, y);
      if (!el || !el.closest(`.pdfViewer .page[data-page-number="${n}"]`)) throw new Error(`(${fx}, ${fy}) of page ${n} is not on the page: ${el?.outerHTML.slice(0, 80)}`);
      if (el.closest('.textLayer span, .annotationLayer a, .PdfHighlighter__tip-container')) throw new Error(`(${fx}, ${fy}) of page ${n} is not empty: ${el.outerHTML.slice(0, 80)}`);
      const init = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: x, clientY: y };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    },
    [n, at[0], at[1]] as const,
  );
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed ?? true), 'the press made a selection').toBe(true);
}
/** CSS selector of the span whose text starts with `prefix` on page n (marks it with a data attribute). */
async function spanSel(page: Page, n: number, prefix: string): Promise<string> {
  const id = `s${n}-${prefix.replace(/[^a-z0-9]/gi, '').slice(0, 20)}`;
  await page.evaluate(
    ([n, prefix, id]) => {
      const el = Array.from(document.querySelectorAll(`.page[data-page-number="${n}"] .textLayer span`)).find((s) => s.children.length === 0 && s.textContent!.startsWith(prefix));
      if (!el) throw new Error(`no span "${prefix}" on page ${n}`);
      el.setAttribute('data-e2e', id);
    },
    [n, prefix, id] as const,
  );
  return `[data-e2e="${id}"]`;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Boxes of highlight parts relative to their page box (CSS px). */
async function partBoxes(page: Page, n = 1): Promise<Box[]> {
  return page.evaluate((n) => {
    const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
    return Array.from(document.querySelectorAll(`.page[data-page-number="${n}"] [data-testid="highlight-part"]`)).map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left - p.left, y: r.top - p.top, w: r.width, h: r.height };
    });
  }, n);
}
/** Same, for elements matching a selector, divided by the page size (zoom-independent fractions). */
async function relBoxes(page: Page, sel: string, n = 1): Promise<Box[]> {
  return page.evaluate(
    ([sel, n]) => {
      const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
      return Array.from(document.querySelectorAll(sel)).map((e) => {
        const r = e.getBoundingClientRect();
        return { x: (r.left - p.left) / p.width, y: (r.top - p.top) / p.height, w: r.width / p.width, h: r.height / p.height };
      });
    },
    [sel, n] as const,
  );
}
/** Glyph box of the text node inside each matching element, as page fractions (what a text selection covers). */
async function textBoxes(page: Page, sel: string, n = 1): Promise<Box[]> {
  return page.evaluate(
    ([sel, n]) => {
      const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
      return Array.from(document.querySelectorAll(sel)).map((e) => {
        const r = document.createRange();
        r.selectNodeContents(e.firstChild!);
        const b = r.getBoundingClientRect();
        return { x: (b.left - p.left) / p.width, y: (b.top - p.top) / p.height, w: b.width / p.width, h: b.height / p.height };
      });
    },
    [sel, n] as const,
  );
}
async function pageSize(page: Page, n = 1) {
  return page.evaluate((n) => {
    const r = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, n);
}
function expectBoxesClose(a: Box[], b: Box[], px = 2) {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => {
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(x[k] - b[i]![k]), `box ${i}.${k}: ${x[k]} vs ${b[i]![k]}`).toBeLessThanOrEqual(px);
  });
}

/** Seed page_texts of the project's e2e DB (server truth for citations). */
function seedPageTexts(project: 'prod' | 'dev'): { page: number; text: string }[] {
  const db = new Database(join(process.env.SP_E2E_ROOT!, project, 'db', 'study_paper.sqlite'), { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT page, text FROM page_texts WHERE paperId = ? ORDER BY page').all(SEED_PAPER_ID) as { page: number; text: string }[];
  } finally {
    db.close();
  }
}
/** Citation as the server would store it (matchQuote on page_texts). */
function citationFor(project: 'prod' | 'dev', quote: string): Citation {
  const m = matchQuote(seedPageTexts(project), { exact: quote });
  return { ordinal: 1, kind: 'quote', quote, status: m.status, score: m.score, ...(m.position ? { position: m.position } : {}), ...(m.candidates !== undefined ? { candidates: m.candidates } : {}) };
}
type SpWindow = Window & {
  __spReader: { getState(): { jumpToCitation(c: Citation): Promise<string>; pendingAction: unknown; selection: unknown }; subscribe(f: (s: { pendingAction: unknown }) => void): () => void };
  __spActions?: unknown[];
};

// ---------------------------------------------------------------------------------------------
// Selection, toolbar, highlights

test('selection → toolbar; H → highlight at the selection; reload keeps it in place (±2 px)', async ({ page }) => {
  const store = newStore();
  await routeHighlights(page, store);
  await openSeed(page);
  const line = span(page, 1, 'We estimate the robot pose');
  // Chrome does not start a drag selection from a few ~1 px bands of a scaled text-layer span (near some glyph
  // midpoints, with any font); 0.05 sat in one once the span got its true glyph width
  // (PdfReader.matchTextLayerLang). Start inside "We" and retry a nearby point if the first lands in such a band.
  for (const from of [0.03, 0.02, 0.04]) {
    await drag(page, line, from, line, 0.6);
    if ((await page.evaluate(() => window.getSelection()?.toString() ?? '')).includes('estimate')) break;
  }
  await expect(page.getByTestId('selection-toolbar')).toBeVisible();
  await expect(page.getByTestId('selection-text')).toContainText('estimate'); // S0 panel shows the store selection
  const selBoxes = await page.evaluate(() => {
    const p = document.querySelector('.page[data-page-number="1"]')!.getBoundingClientRect();
    const rects = Array.from(window.getSelection()!.getRangeAt(0).getClientRects()).filter((r) => r.width > 0 && r.width < p.width);
    const l = Math.min(...rects.map((r) => r.left));
    const t = Math.min(...rects.map((r) => r.top));
    return [{ x: l - p.left, y: t - p.top, w: Math.max(...rects.map((r) => r.right)) - l, h: Math.max(...rects.map((r) => r.bottom)) - t }];
  });

  await page.keyboard.press('h');
  await expect(page.locator('.page[data-page-number="1"] [data-testid="highlight-part"]')).toHaveCount(1);
  await expect(page.getByTestId('selection-toolbar')).toHaveCount(0);
  expect(store.invalid).toEqual([]);
  expect(store.bodies).toHaveLength(1);
  const body = store.bodies[0] as { kind: string; page: number; color: number; quote: { exact: string; prefix?: string; suffix?: string } };
  expect(body).toMatchObject({ kind: 'text', page: 1 });
  expect(body.quote.exact).toContain('estimate the robot');
  expect(body.quote.prefix!.length).toBeLessThanOrEqual(32);
  expect(body.quote.suffix!.length).toBeLessThanOrEqual(32);
  expect(body).not.toHaveProperty('position'); // the web never sends offsets
  const before = await partBoxes(page);
  expectBoxesClose(before, selBoxes);

  await page.reload();
  await page.waitForSelector('.page[data-page-number="1"] .textLayer .endOfContent', { state: 'attached' });
  await expect(page.locator('.page[data-page-number="1"] [data-testid="highlight-part"]')).toHaveCount(1);
  expectBoxesClose(await partBoxes(page), before);
});

test('highlight click → color change and delete', async ({ page }) => {
  const store = newStore();
  await routeHighlights(page, store);
  await openSeed(page);
  await selectSpans(page, await spanSel(page, 1, 'Each scan is deskewed'), await spanSel(page, 1, 'Each scan is deskewed'));
  await page.getByTestId('toolbar-color-3').click();
  const part = page.locator('[data-testid="highlight-part"]').first();
  await expect(part).toBeVisible();
  await expect(page.locator('[data-testid="highlight"]').first()).toHaveAttribute('data-color', '3');
  await part.click();
  await expect(page.getByTestId('highlight-popover')).toBeVisible();
  await page.getByTestId('highlight-color-5').click();
  await expect(page.locator('[data-testid="highlight"]').first()).toHaveAttribute('data-color', '5');
  await page.getByTestId('highlight-popover').getByTestId('rd-highlight-delete').click(); // M2: renamed from highlight-delete (the highlights tab has its own delete button)
  await expect(page.locator('[data-testid="highlight-part"]')).toHaveCount(0);
});

test('multi-line selection: one rect per line, each aligned with its text line (±2 px)', async ({ page }) => {
  const store = newStore();
  await routeHighlights(page, store);
  await openSeed(page);
  const a = await spanSel(page, 1, 'We estimate the robot pose');
  const b = await spanSel(page, 1, 'point residual between');
  const c = await spanSel(page, 1, 'ciation uses a fixed');
  await selectSpans(page, a, c);
  await page.keyboard.press('2');
  await expect(page.locator('[data-testid="highlight-part"]')).toHaveCount(3);
  expect((store.bodies[0] as { rects: unknown[] }).rects).toHaveLength(3);
  const lines = (await Promise.all([a, b, c].map((s) => textBoxes(page, s)))).flat();
  const parts = await relBoxes(page, '.page[data-page-number="1"] [data-testid="highlight-part"]');
  const size = await pageSize(page);
  const px = (bx: Box[]) => bx.map((x) => ({ x: x.x * size.width, y: x.y * size.height, w: x.w * size.width, h: x.h * size.height }));
  expectBoxesClose(px(parts), px(lines));
});

test('zoom: a highlight stays on its text at other zoom levels', async ({ page }) => {
  const store = newStore();
  await routeHighlights(page, store);
  await openSeed(page);
  const s = await spanSel(page, 1, 'The state vector is');
  await selectSpans(page, s, s);
  await page.keyboard.press('h');
  await expect(page.locator('[data-testid="highlight-part"]')).toHaveCount(1);
  for (const step of ['zoom-in', 'zoom-in', 'zoom-out', 'zoom-fit', 'zoom-out'] as const) {
    const before = await pageSize(page);
    await page.getByTestId(step).click();
    await expect.poll(async () => (await pageSize(page)).width).not.toBe(before.width);
    await page.waitForSelector('.page[data-page-number="1"] .textLayer .endOfContent', { state: 'attached' });
    const size = await pageSize(page);
    const toPx = (b: Box[]) => b.map((x) => ({ x: x.x * size.width, y: x.y * size.height, w: x.w * size.width, h: x.h * size.height }));
    let detail = '';
    await expect
      .poll(async () => {
        const part = toPx(await relBoxes(page, '.page[data-page-number="1"] [data-testid="highlight-part"]'));
        const text = toPx(await textBoxes(page, s));
        detail = JSON.stringify({ zoom: await page.getByTestId('zoom-level').textContent(), size, part, text });
        return Math.max(...(['x', 'y', 'w', 'h'] as const).map((k) => Math.abs(part[0]![k] - text[0]![k])));
      }, { message: `after ${step}: ${detail}` })
      .toBeLessThanOrEqual(2);
  }
});

test('E → readerStore.pendingAction = explain with the selection anchor', async ({ page }) => {
  await openSeed(page);
  await page.evaluate(() => {
    const w = window as unknown as SpWindow;
    w.__spActions = [];
    w.__spReader.subscribe((s) => {
      if (s.pendingAction) w.__spActions!.push(s.pendingAction);
    });
  });
  const s = await spanSel(page, 1, 'Each scan is deskewed');
  await selectSpans(page, s, s);
  await page.keyboard.press('e');
  await expect.poll(() => page.evaluate(() => (window as unknown as SpWindow).__spActions!.length)).toBe(1);
  const action = (await page.evaluate(() => (window as unknown as SpWindow).__spActions![0])) as { kind: string; text: string; anchor: { kind: string; quote: { exact: string }; rects: { page: number }[] } };
  expect(action.kind).toBe('explain');
  expect(action.anchor.kind).toBe('text');
  expect(action.anchor.quote.exact).toContain('Each scan is deskewed with a constant velocity model');
  expect(action.anchor.rects.every((r) => r.page === 1)).toBe(true);
});

test('shortcuts are inert while an input has focus', async ({ page }) => {
  const store = newStore();
  await routeHighlights(page, store);
  await openSeed(page);
  const s = await spanSel(page, 1, 'Each scan is deskewed');
  await selectSpans(page, s, s);
  await expect(page.getByTestId('selection-toolbar')).toBeVisible();
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.id = 'e2e-input';
    document.body.appendChild(i);
  });
  await page.locator('#e2e-input').focus();
  for (const k of ['h', '1', 'e']) await page.keyboard.press(k);
  await expect(page.locator('#e2e-input')).toHaveValue('h1e');
  await page.waitForTimeout(300);
  expect(store.bodies).toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as SpWindow).__spReader.getState().pendingAction)).toBeNull();
  // positive control: the same key works once the input loses focus
  await page.locator('#e2e-input').evaluate((e) => (e as HTMLInputElement).blur());
  await page.keyboard.press('h');
  await expect(page.locator('[data-testid="highlight-part"]')).toHaveCount(1);
});

test('multi-page selection: notice, no toolbar, no highlight', async ({ page }) => {
  const store = newStore();
  await routeHighlights(page, store);
  await openSeed(page);
  await page.evaluate(() => (window as unknown as { __spViewer: { getViewer(): { scrollPageIntoView(o: object): void } } }).__spViewer.getViewer().scrollPageIntoView({ pageNumber: 2 }));
  await page.waitForSelector('.page[data-page-number="2"] .textLayer .endOfContent', { state: 'attached' });
  await selectSpans(page, await spanSel(page, 1, 'Each scan is deskewed'), await spanSel(page, 2, 'II. METHOD'));
  await expect(page.getByTestId('selection-notice')).toContainText('한 페이지 안에서 선택하세요');
  await expect(page.getByTestId('selection-toolbar')).toHaveCount(0);
  await page.keyboard.press('h');
  await page.waitForTimeout(300);
  expect(store.bodies).toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as SpWindow).__spReader.getState().selection)).toBeNull();
});

test('explain is disabled before context_ready (and enabled once polling sees it)', async ({ page }) => {
  let ready = false;
  await page.route(new RegExp(`/api/papers/${SEED_PAPER_ID}$`), async (route) => {
    const real = await route.fetch();
    const body = await real.json();
    if (!ready) Object.assign(body, { ingestStatus: 'running', state: { readable: true, contextReady: false, structureReady: false }, ai: { available: false, reason: 'context_not_ready' } });
    return route.fulfill({ response: real, json: body });
  });
  await openSeed(page);
  await expect(page.getByTestId('context-pending')).toBeVisible();
  const s = await spanSel(page, 1, 'Each scan is deskewed');
  await selectSpans(page, s, s);
  const explain = page.getByTestId('toolbar-explain');
  await expect(explain).toBeDisabled();
  await expect(explain).toHaveAttribute('title', '색인 준비 중');
  await page.keyboard.press('e');
  await expect(page.getByTestId('selection-notice')).toContainText('색인 준비 중');
  expect(await page.evaluate(() => (window as unknown as SpWindow).__spReader.getState().pendingAction)).toBeNull();
  ready = true; // the reader re-reads papers.get every 1.5 s while ingest runs
  await expect(page.getByTestId('context-pending')).toHaveCount(0, { timeout: 5_000 });
  await selectSpans(page, s, s);
  await expect(page.getByTestId('toolbar-explain')).toBeEnabled();
});

// ---------------------------------------------------------------------------------------------
// Citation jumps

test('jumpToCitation: verbatim → scroll + 2 s flash whose text equals the quote; ambiguous / fuzzy → page only, nothing highlighted', async ({ page }) => {
  const project = projectName();
  await openSeed(page);
  const jump = (c: Citation) => page.evaluate((c) => (window as unknown as SpWindow).__spReader.getState().jumpToCitation(c), c);

  for (const quote of ['The covariance is propagated with a first-order Jacobian.', 'The data association uses a fixed threshold of 0.5 m and a robust kernel.']) {
    const c = citationFor(project, quote);
    expect(c.status).toBe('verbatim');
    expect(await jump(c)).toBe('located');
    const flash = pageEl(page, c.position!.page).getByTestId('citation-flash');
    await expect(flash).toHaveCount(1);
    expect(quoteEqualsN1(quote, (await flash.getAttribute('data-flash-text'))!)).toBe(true);
    const part = flash.locator('.sp-flash-part').first();
    await expect(part).toBeInViewport();
    // the flash covers the quoted text: its box overlaps the span that holds the quote start
    const first = await relBoxes(page, `.page[data-page-number="${c.position!.page}"] .sp-flash-part`, c.position!.page);
    expect(first.length).toBeGreaterThan(0);
    await expect(flash).toHaveCount(0, { timeout: 4_000 });
  }

  const ambiguous = citationFor(project, 'robust kernel');
  expect(ambiguous).toMatchObject({ status: 'ambiguous', candidates: 3 });
  expect(await jump(ambiguous)).toBe('page_only');
  const fuzzy = citationFor(project, 'The robust kernel down-weights the outliers in the residual.');
  expect(fuzzy.status).toBe('fuzzy');
  expect(await jump(fuzzy)).toBe('page_only');
  await page.waitForTimeout(200);
  await expect(page.locator('.sp-flash')).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------
// Server restart (own server process on SP_E2E_RESTART_PORT; only this test's child is stopped)

test('a highlight survives a server restart (same place ±2 px)', async ({ page }) => {
  test.skip(projectName() !== 'prod', 'one restart run is enough');
  const dir = mkdtempSync(join(tmpdir(), 'sp-e2e-rd-'));
  const port = E2E_PORTS.restart;
  const env = { ...process.env, SP_ENV: 'prod', SP_LLM: 'mock', SP_PORT: String(port), SP_DATA_DIR: join(dir, 'data'), SP_CONFIG_PATH: join(dir, 'config','none.json'), SP_SECRETS_DIR: join(dir,'secrets'), XDG_RUNTIME_DIR: join(dir, 'run') };
  const seed = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-fixture.ts'], { env, encoding: 'utf8' });
  expect(seed.status, seed.stderr).toBe(0);
  const start = async (): Promise<ChildProcess> => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], { env, stdio: 'ignore' });
    for (let i = 0; i < 150; i++) {
      try {
        if ((await rawRequest(port, '/')).status === 200) return child;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    child.kill('SIGKILL');
    throw new Error('restart server did not start');
  };
  const stop = (child: ChildProcess) =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGINT');
    });
  const base = `http://127.0.0.1:${port}`;
  let child = await start();
  try {
    const store = newStore();
    await routeHighlights(page, store);
    await openSeed(page, base);
    const s = await spanSel(page, 1, 'We estimate the robot pose');
    await selectSpans(page, s, s);
    await page.keyboard.press('4');
    await expect(page.locator('[data-testid="highlight-part"]')).toHaveCount(1);
    const before = await partBoxes(page);
    await stop(child);
    child = await start();
    await page.reload(); // new token in the HTML
    await page.waitForSelector('.page[data-page-number="1"] .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
    await expect(page.locator('[data-testid="highlight-part"]')).toHaveCount(1);
    expectBoxesClose(await partBoxes(page), before);
    await expect(page.locator('[data-testid="highlight"]').first()).toHaveAttribute('data-color', '4');
    test.info().annotations.push({ type: 'highlights', description: store.mocked ? 'served by the in-test store (server answered 501)' : 'served by the real server' });
  } finally {
    await stop(child);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Library (papers.import / jobs.events / list are mocked: no offline ingest source on this branch)

test('Library: import → step progress → list refreshed; failed import → error + retry button', async ({ page }) => {
  const okId = '55555555-5555-4555-8555-555555555555';
  const failId = '66666666-6666-4666-8666-666666666666';
  const extra: Record<string, unknown>[] = [];
  const imports: unknown[] = [];
  const summary = (id: string, title: string, over: Record<string, unknown>) => ({
    id, source: 'arxiv', arxivId: '2209.15397', arxivVersion: 2, title, authors: ['A. Author'], year: 2023, status: 'inbox', pageCount: 8, collectionId: null, tags: [], createdAt: 1, updatedAt: 1, lastOpenedAt: null,
    structureSource: null, supplementVersion: null, structureUpgradeAvailable: false,
    ingestStatus: 'done', state: { readable: true, contextReady: true, structureReady: false }, ai: { available: true, reason: null }, ...over,
  });
  const sse = (events: SseEvent[]) => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: events.map((e) => formatSseEvent(e)).join('') });
  await page.route(/\/api\/papers$/, async (route) => {
    const real = await route.fetch();
    const body = (await real.json()) as { papers: unknown[] };
    return route.fulfill({ response: real, json: { papers: [...extra, ...body.papers] } });
  });
  await page.route(/\/api\/papers\/import$/, async (route) => {
    const body = route.request().postDataJSON() as { input: string };
    imports.push(body);
    expect(ImportPaperRequest.safeParse(body).success).toBe(true);
    if (body.input.includes('fail')) {
      extra.unshift(summary(failId, 'Broken Paper', { ingestStatus: 'failed', state: { readable: false, contextReady: false, structureReady: false }, ai: { available: false, reason: 'context_not_ready' } }));
      return route.fulfill({ json: { paperId: failId, jobId: 'job-fail', existing: false } });
    }
    extra.unshift(summary(okId, 'KISS-ICP (mock)', {}));
    return route.fulfill({ json: { paperId: okId, jobId: 'job-ok', existing: false } });
  });
  await page.route(/\/api\/jobs\/job-ok\/events$/, (route) =>
    route.fulfill(sse([
      { event: 'job.step', data: { step: 'resolve', status: 'ok' } },
      { event: 'job.step', data: { step: 'pdf', status: 'ok' } },
      { event: 'job.state', data: { state: 'readable' } },
      { event: 'job.step', data: { step: 'supplement', status: 'ok' } },
      { event: 'job.state', data: { state: 'context_ready' } },
      { event: 'job.done', data: { paperId: okId } },
    ])),
  );
  await page.route(/\/api\/jobs\/job-fail\/events$/, (route) => route.fulfill(sse([{ event: 'job.step', data: { step: 'pdf', status: 'error', detail: 'HTTP 503' } }, { event: 'job.error', data: { code: 'network', message: 'PDF를 받지 못했습니다' } }])));
  await page.route(new RegExp(`/api/papers/${failId}$`), (route) =>
    route.fulfill({
      json: {
        ...extra.find((p) => p.id === failId), abstract: null, doi: null, venue: null, primaryCategory: null, publishedAt: null, codeUrl: null, projectUrl: null, citationCount: null, structureSource: null, contextMode: null,
        ingestWarnings: [], readableAt: null, contextReadyAt: null, structureReadyAt: null, lastPosition: null,
        lastJob: { id: 'job-fail', kind: 'import_arxiv', paperId: failId, status: 'failed', steps: [{ step: 'pdf', status: 'error' }], error: 'PDF를 받지 못했습니다' },
        structureUpgrade: { available: false, reason: null, job: null },
      },
    }),
  );

  await page.goto('/');
  await expect(page.getByRole('link', { name: SEED_TITLE })).toBeVisible();
  await page.getByTestId('import-input').fill('https://arxiv.org/abs/2209.15397v2');
  await page.getByTestId('import-button').click();
  const okRow = page.locator(`[data-testid="paper-row"][data-paper-id="${okId}"]`);
  await expect(okRow.getByTestId('job-steps')).toContainText('AI 색인: 완료');
  await expect(okRow.getByTestId('paper-status')).toHaveText('AI 사용 가능');
  await expect(page.getByTestId('paper-row')).toHaveCount(5); // 4 seed papers (M1 + 3 M2 seeds) + the imported one

  await page.getByTestId('import-input').fill('fail-1234.5678');
  await page.getByTestId('import-button').click();
  const failRow = page.locator(`[data-testid="paper-row"][data-paper-id="${failId}"]`);
  await expect(failRow.getByTestId('paper-status')).toHaveText('실패');
  await expect(failRow.getByTestId('paper-error')).toContainText('PDF를 받지 못했습니다');
  await expect(failRow.getByTestId('paper-retry')).toBeVisible();
  expect(imports).toHaveLength(2);
});

// =================================================================================================================
// M2 (BRIEF_C acceptance). The spec ends at C's boundary: readerStore (pendingAction / panelFocus, recorded with
// subscribe because the panel consumes them at once) and the viewer DOM. Routes whose M2 behaviour other builders own
// are mocked only with mockRoute (contract-checked); "real response + a few fields" mocks use realJson.

type M2State = { pendingAction: unknown; panelFocus: unknown };
type M2Window = Window & {
  __spReader: {
    getState(): { jumpToEquation(id: string): Promise<string>; jumpToSection(id: string): Promise<string>; canGoBack: boolean };
    subscribe(f: (s: M2State, prev: M2State) => void): () => void;
  };
  __spViewer: { getViewer(): { container: HTMLElement; currentScale: number; scrollPageIntoView(o: object): void } };
  __spRecorded?: { actions: unknown[]; focus: unknown[] };
};
interface AreaAction {
  kind: string;
  anchor: { kind: string; rects: { page: number; x: number; y: number; w: number; h: number }[]; quote?: unknown };
  imagePng: string;
  capture: { widthPx: number; heightPx: number };
}

async function openPaper(page: Page, id: string, title: string) {
  await page.goto(`/paper/${id}`);
  await expect(page.getByTestId('paper-title')).toHaveText(title);
  await page.waitForSelector('.page[data-page-number="1"] .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
}
/** Records every new pendingAction / panelFocus (the panel consumes them right away). */
async function recordStore(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as M2Window;
    w.__spRecorded = { actions: [], focus: [] };
    w.__spReader.subscribe((s, prev) => {
      if (s.pendingAction && s.pendingAction !== prev.pendingAction) w.__spRecorded!.actions.push(s.pendingAction);
      if (s.panelFocus && s.panelFocus !== prev.panelFocus) w.__spRecorded!.focus.push(s.panelFocus);
    });
  });
}
const recorded = (page: Page) => page.evaluate(() => (window as unknown as M2Window).__spRecorded!);
/** The reader store's text selection (kept until Escape, a press on the PDF or a new selection clears it). */
const storeSelection = (page: Page) => page.evaluate(() => (window as unknown as SpWindow).__spReader.getState().selection);
const viewerScrollTop = (page: Page) => page.evaluate(() => (window as unknown as M2Window).__spViewer.getViewer().container.scrollTop);
/** The page at the top edge of the scroll container (same rule as viewer/position.ts). */
const topPageNumber = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as M2Window).__spViewer.getViewer().container.getBoundingClientRect().top;
    const p = Array.from(document.querySelectorAll<HTMLElement>('.page[data-page-number]')).find((e) => e.getBoundingClientRect().bottom > c + 0.5);
    return p ? Number(p.dataset.pageNumber) : null;
  });
/** Page n's box once it stayed the same (position, size, viewer scroll) over three reads 100 ms apart. */
async function settledPageBox(page: Page, n: number) {
  const read = () =>
    page.evaluate((n) => {
      const r = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
      const top = (window as unknown as M2Window).__spViewer.getViewer().container.scrollTop;
      return { x: r.x, y: r.y, width: r.width, height: r.height, top };
    }, n);
  let prev = await read();
  let same = 0;
  for (let i = 0; i < 50 && same < 2; i++) {
    await page.waitForTimeout(100);
    const cur = await read();
    same = JSON.stringify(cur) === JSON.stringify(prev) ? same + 1 : 0;
    prev = cur;
  }
  expect(same, `page ${n} layout did not settle`).toBe(2);
  return prev;
}
/** Ctrl+drag between two fractions of page n's box (mouse events carry ctrlKey); the page must not move meanwhile. */
async function ctrlDrag(page: Page, n: number, from: [number, number], to: [number, number]) {
  const b = await settledPageBox(page, n);
  await page.keyboard.down('Control');
  await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  // a layout shift during the drag makes the expected rect meaningless: report it as that, not as a rect error
  const a = await settledPageBox(page, n);
  expect(a, 'page moved during the Ctrl+drag').toEqual(b);
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rectBox = (r: { x: number; y: number; w: number; h: number }): Box => ({ x: r.x, y: r.y, w: r.w, h: r.h });
const outlineItem = (page: Page, number: string) => page.locator(`[data-testid="rd-outline-item"][data-section-number="${number}"]`);

test.describe('M2', () => {
  test.beforeEach(async ({ baseURL }) => {
    await resetSeedState(baseURL!, [SEED_M2_PAPER_ID, SEED_LINKS_PAPER_ID]);
  });

  test('Ctrl+drag → capture menu: figure / equation actions carry a PNG that passes inspectPng; area highlight → contract body, same place after reload (±2 px)', async ({ page }) => {
    const store = createMockStore({ highlights: [] });
    const bodies: unknown[] = [];
    await mockRoute(page, 'highlights.list', (req) => ({ kind: 'json', body: { highlights: (store.get<HighlightDto[]>('highlights') ?? []).filter((h) => h.paperId === req.params.id) } }));
    await mockRoute(page, 'highlights.create', (req) => {
      bodies.push(req.body);
      const b = CreateHighlightRequest.parse(req.body);
      const now = Date.now();
      const dto: HighlightDto = { id: crypto.randomUUID(), paperId: req.params.id!, kind: b.kind, color: b.color, quote: null, position: null, page: b.page, rects: b.rects, sectionId: null, comment: null, imageFileId: crypto.randomUUID(), createdAt: now, updatedAt: now };
      store.update<HighlightDto[]>('highlights', (prev = []) => [...prev, dto]);
      return { kind: 'json', body: dto };
    });
    await mockRoute(page, 'papers.capture', () => ({ kind: 'png', body: makeTestPng({ width: 16, height: 16 }) }));
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await recordStore(page);
    const size = await pageSize(page, 1);

    const checkAction = (a: AreaAction, kind: string, from: [number, number], to: [number, number]) => {
      expect(a.kind).toBe(kind);
      expect(a.anchor.kind).toBe('area');
      expect(a.anchor.quote).toBeUndefined();
      expect(a.anchor.rects).toHaveLength(1);
      const r = a.anchor.rects[0]!;
      expect(r.page).toBe(1);
      for (const [got, want, len] of [
        [r.x, from[0], size.width],
        [r.y, from[1], size.height],
        [r.x + r.w, to[0], size.width],
        [r.y + r.h, to[1], size.height],
      ] as const)
        expect(Math.abs(got - want) * len).toBeLessThanOrEqual(2);
      // the real canvas.toBlob output passes the server's PNG check
      const insp = inspectPng(a.imagePng);
      expect(insp).toMatchObject({ ok: true });
      const px = pngSize(a.imagePng);
      expect(px).toEqual({ width: a.capture.widthPx, height: a.capture.heightPx });
      expect(Math.max(px.width, px.height)).toBeLessThanOrEqual(1568);
      expect(Math.min(px.width, px.height)).toBeGreaterThanOrEqual(8);
      expect(insp.ok && insp.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    };

    const fig: [[number, number], [number, number]] = [
      [0.1, 0.15],
      [0.6, 0.4],
    ];
    await ctrlDrag(page, 1, ...fig);
    await expect(page.getByTestId('rd-capture-menu')).toBeVisible();
    await expect(page.getByTestId('rd-capture-small')).toHaveCount(0); // a large area: no "small" notice
    await page.getByTestId('rd-capture-figure').click();
    await expect.poll(async () => (await recorded(page)).actions.length, { timeout: 15_000 }).toBe(1);
    checkAction((await recorded(page)).actions[0] as AreaAction, 'figure', ...fig);
    await expect(page.getByTestId('rd-capture-menu')).toHaveCount(0);

    const eq: [[number, number], [number, number]] = [
      [0.12, 0.27],
      [0.55, 0.3],
    ];
    await ctrlDrag(page, 1, ...eq);
    await expect(page.getByTestId('rd-capture-menu')).toBeVisible();
    await page.getByTestId('rd-capture-equation').click();
    await expect.poll(async () => (await recorded(page)).actions.length, { timeout: 15_000 }).toBe(2);
    checkAction((await recorded(page)).actions[1] as AreaAction, 'equation', ...eq);

    const hl: [[number, number], [number, number]] = [
      [0.15, 0.5],
      [0.5, 0.62],
    ];
    await ctrlDrag(page, 1, ...hl);
    await page.getByTestId('rd-capture-highlight').click();
    const parts = '.page[data-page-number="1"] [data-testid="highlight"][data-kind="area"] [data-testid="highlight-part"]';
    await expect(page.locator(parts)).toHaveCount(1, { timeout: 15_000 });
    expect(bodies).toHaveLength(1);
    const body = CreateHighlightRequest.parse(bodies[0]);
    expect(body).toMatchObject({ kind: 'area', page: 1 });
    expect(body.rects).toHaveLength(1);
    expect(body.quote).toBeUndefined();
    expect(inspectPng(body.imagePng!)).toMatchObject({ ok: true });
    const want = [{ x: hl[0][0] * size.width, y: hl[0][1] * size.height, w: (hl[1][0] - hl[0][0]) * size.width, h: (hl[1][1] - hl[0][1]) * size.height }];
    const before = await partBoxes(page);
    expectBoxesClose(before.filter((_, i) => i === before.length - 1), want);
    await page.reload();
    await page.waitForSelector('.page[data-page-number="1"] .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
    await expect(page.locator(parts)).toHaveCount(1);
    expectBoxesClose(await partBoxes(page), before);
    // the same popover as text highlights (color / delete)
    await page.locator(parts).click();
    await expect(page.getByTestId('highlight-popover').getByTestId('rd-highlight-delete')).toBeVisible();
    expect(mockViolations(page)).toEqual([]);
  });

  test('Ctrl+drag inside a stored area highlight keeps the capture menu (no highlight popover, both drag directions); a plain click still opens the popover (C-I10-02)', async ({ page }) => {
    const now = Date.now();
    const stored: HighlightDto = {
      id: crypto.randomUUID(), paperId: SEED_M2_PAPER_ID, kind: 'area', color: 1, quote: null, position: null, page: 1,
      rects: [{ page: 1, x: 0.15, y: 0.5, w: 0.35, h: 0.12 }], sectionId: null, comment: null, imageFileId: crypto.randomUUID(), createdAt: now, updatedAt: now,
    };
    await mockRoute(page, 'highlights.list', (req) => ({ kind: 'json', body: { highlights: req.params.id === SEED_M2_PAPER_ID ? [stored] : [] } }));
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await recordStore(page);
    const part = page.locator('.page[data-page-number="1"] [data-testid="highlight"][data-kind="area"] [data-testid="highlight-part"]');
    await expect(part).toHaveCount(1, { timeout: 15_000 });
    for (const [from, to] of [
      [[0.2, 0.52], [0.4, 0.6]],
      [[0.4, 0.6], [0.2, 0.52]],
    ] as [[number, number], [number, number]][]) {
      await ctrlDrag(page, 1, from, to);
      await expect(page.getByTestId('rd-capture-menu')).toBeVisible();
      await page.waitForTimeout(300); // a popover would replace the menu right after the mouseup
      await expect(page.getByTestId('rd-capture-menu')).toBeVisible();
      await expect(page.getByTestId('highlight-popover')).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    // the capture still works from there
    await ctrlDrag(page, 1, [0.2, 0.52], [0.4, 0.6]);
    await page.getByTestId('rd-capture-figure').click();
    await expect.poll(async () => (await recorded(page)).actions.length, { timeout: 15_000 }).toBe(1);
    expect(((await recorded(page)).actions[0] as AreaAction).kind).toBe('figure');
    // a click without a drag is still a click on the highlight
    await part.click();
    await expect(page.getByTestId('highlight-popover').getByTestId('rd-highlight-delete')).toBeVisible();
    expect(mockViolations(page)).toEqual([]);
  });

  test('a Ctrl+drag over almost the whole visible height: the capture menu stays inside the visible viewer (C-I10-04)', async ({ page }) => {
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await recordStore(page);
    const b = await settledPageBox(page, 1);
    const c = await page.evaluate(() => {
      const r = (window as unknown as M2Window).__spViewer.getViewer().container.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
    // from just under the visible top to just above the visible bottom (or the page's bottom when it ends earlier)
    const y1 = Math.max(c.top, b.y) + 12;
    const y2 = Math.min(c.bottom, b.y + b.height) - 12;
    expect(y2 - y1, 'visible part of page 1').toBeGreaterThan(400);
    await ctrlDrag(page, 1, [0.1, (y1 - b.y) / b.height], [0.6, (y2 - b.y) / b.height]);
    const menu = page.getByTestId('rd-capture-menu');
    await expect(menu).toBeVisible();
    const m = (await menu.boundingBox())!;
    expect(m.y, 'menu top inside the viewer').toBeGreaterThanOrEqual(c.top);
    expect(m.y + m.height, 'menu bottom inside the viewer').toBeLessThanOrEqual(c.bottom);
    await expect(menu).toBeInViewport({ ratio: 1 });
    // still usable where it is
    await page.getByTestId('rd-capture-figure').click();
    await expect.poll(async () => (await recorded(page)).actions.length, { timeout: 15_000 }).toBe(1);
    expect(((await recorded(page)).actions[0] as AreaAction).kind).toBe('figure');
  });

  test('an open highlight popover follows its highlight after a wheel scroll up and the position save re-render: not pinned to the visible bottom (C-FX-01)', async ({ page }) => {
    const now = Date.now();
    const stored: HighlightDto = {
      id: crypto.randomUUID(), paperId: SEED_M2_PAPER_ID, kind: 'area', color: 2, quote: null, position: null, page: 2,
      rects: [{ page: 2, x: 0.2, y: 0.3, w: 0.3, h: 0.06 }], sectionId: null, comment: null, imageFileId: crypto.randomUUID(), createdAt: now, updatedAt: now,
    };
    await mockRoute(page, 'highlights.list', (req) => ({ kind: 'json', body: { highlights: req.params.id === SEED_M2_PAPER_ID ? [stored] : [] } }));
    let puts = 0;
    await mockRoute(page, 'papers.position', () => {
      puts += 1;
      return { kind: 'empty' };
    });
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await page.evaluate(() => (window as unknown as M2Window).__spViewer.getViewer().scrollPageIntoView({ pageNumber: 2 }));
    const part = page.locator('.page[data-page-number="2"] [data-testid="highlight"][data-kind="area"] [data-testid="highlight-part"]');
    await expect(part).toHaveCount(1, { timeout: 15_000 });
    await settledPageBox(page, 2);
    await part.click();
    const popover = page.getByTestId('highlight-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toBeInViewport();
    /** Gap between the popover and its highlight (popover above: highlight top − popover bottom; below: popover top − highlight bottom). */
    const gap = async () => {
      const p = (await popover.boundingBox())!;
      const h = (await part.boundingBox())!;
      return p.y + p.height <= h.y ? h.y - (p.y + p.height) : p.y - (h.y + h.height);
    };
    const gap0 = await gap();
    expect(gap0, 'popover next to its highlight').toBeGreaterThanOrEqual(0);
    expect(gap0).toBeLessThanOrEqual(12);

    // wheel up to page 1 (a wheel does not close the tip); the position PUT that follows re-renders the viewer
    const putsBefore = puts;
    const c = await page.evaluate(() => {
      const r = (window as unknown as M2Window).__spViewer.getViewer().container.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, bottom: r.bottom };
    });
    await page.mouse.move(c.x, c.y);
    for (let i = 0; i < 8 && (await viewerScrollTop(page)) > 0; i++) await page.mouse.wheel(0, -1500);
    await expect.poll(() => topPageNumber(page)).toBe(1);
    await expect.poll(() => puts, { timeout: 8_000 }).toBeGreaterThan(putsBefore);
    await page.waitForTimeout(300); // the re-render after the confirmed save
    await expect(popover).toHaveCount(1);
    const p = (await popover.boundingBox())!;
    expect(p.y, 'popover not pinned to the visible bottom').toBeGreaterThan(c.bottom);
    await expect(popover).not.toBeInViewport();
    expect(Math.abs((await gap()) - gap0), 'popover still next to its highlight').toBeLessThanOrEqual(2);
    expect(mockViolations(page)).toEqual([]);
  });

  test('a tiny Ctrl+drag (output under 8 px) is ignored: no menu, no action', async ({ page }) => {
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await recordStore(page);
    await ctrlDrag(page, 1, [0.3, 0.3], [0.3015, 0.302]);
    await page.waitForTimeout(400);
    await expect(page.getByTestId('rd-capture-menu')).toHaveCount(0);
    expect((await recorded(page)).actions).toEqual([]);
  });

  test('capture content: the PNG shows the selected area (text vs blank, same rect → same PNG); small notice; AI items off without context; too_large notice', async ({ page }) => {
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await recordStore(page);
    /** Fraction of non-white pixels of a PNG (decoded by the browser). */
    const inkOf = (b64: string) =>
      page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! < 200 || d[i + 1]! < 200 || d[i + 2]! < 200) ink++;
        return ink / (d.length / 4);
      }, b64);
    const figureOf = async (from: [number, number], to: [number, number]) => {
      const n = (await recorded(page)).actions.length;
      await ctrlDrag(page, 1, from, to);
      await page.getByTestId('rd-capture-figure').click();
      await expect.poll(async () => (await recorded(page)).actions.length, { timeout: 15_000 }).toBe(n + 1);
      return ((await recorded(page)).actions.at(-1) as AreaAction).imagePng;
    };
    // synthetic-m2.pdf page 1: text lines between y 0.15 and 0.32 from x 0.118; nothing below y 0.35
    const text = await figureOf([0.12, 0.165], [0.4, 0.3]);
    const blank = await figureOf([0.12, 0.55], [0.4, 0.685]);
    const again = await figureOf([0.12, 0.165], [0.4, 0.3]);
    expect(pngSize(blank)).toEqual(pngSize(text));
    expect(await inkOf(text)).toBeGreaterThan(0.01);
    expect(await inkOf(blank)).toBe(0);
    expect(again).toBe(text);

    // a small area (output long side < 400 px) → the notice
    await ctrlDrag(page, 1, [0.12, 0.2], [0.22, 0.22]);
    await expect(page.getByTestId('rd-capture-small')).toHaveText('영역이 작아 읽기 어려울 수 있음');
    expect(Number(await page.getByTestId('rd-capture-menu').getAttribute('data-width'))).toBeLessThan(400);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rd-capture-menu')).toHaveCount(0);

    // without the AI context: figure / equation disabled with the reason, the area highlight stays
    const reason = 'e2e: AI를 쓸 수 없는 이유';
    await page.evaluate((reason) => {
      const s = (window as unknown as { __spReader: { getState(): { setPaperState(p: object): void } } }).__spReader.getState();
      s.setPaperState({ readable: true, contextReady: false, structureReady: true, aiBlockedReason: reason });
    }, reason);
    await ctrlDrag(page, 1, [0.12, 0.165], [0.4, 0.3]);
    await expect(page.getByTestId('rd-capture-figure')).toBeDisabled();
    await expect(page.getByTestId('rd-capture-equation')).toBeDisabled();
    await expect(page.getByTestId('rd-capture-highlight')).toBeEnabled();
    await expect(page.getByTestId('rd-capture-ai-blocked')).toHaveText(reason);
    await expect(page.getByTestId('rd-capture-figure')).toHaveAttribute('title', reason);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const s = (window as unknown as { __spReader: { getState(): { setPaperState(p: object): void } } }).__spReader.getState();
      s.setPaperState({ readable: true, contextReady: true, structureReady: true, aiBlockedReason: null });
    });

    // a PNG that stays over 4 MiB after three shrinks → the notice, no action
    await page.evaluate(() => {
      HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
        cb(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: 'image/png' }));
      };
    });
    const n = (await recorded(page)).actions.length;
    await ctrlDrag(page, 1, [0.12, 0.165], [0.4, 0.3]);
    await page.getByTestId('rd-capture-figure').click();
    await expect(page.getByTestId('selection-notice')).toHaveText('캡처한 이미지가 4 MiB를 넘어 보낼 수 없습니다. 영역을 더 작게 선택하세요.');
    await expect(page.getByTestId('rd-capture-menu')).toHaveCount(0);
    expect((await recorded(page)).actions).toHaveLength(n);
  });

  test('toolbar and shortcuts publish ask / note / glossary (with the selection; C and N also without); AI buttons off without context', async ({ page, baseURL }) => {
    // ask / note with a selection carry the selection's section (C-I10-01): the line is on page 1 under "I. INTRODUCTION"
    const st = await realJson<StructureResponse>(baseURL!, 'papers.structure', { params: { id: SEED_M2_PAPER_ID } });
    const intro = st.sections.find((x) => x.number === 'I' && x.pdfPage === 1);
    expect(intro, 'seed structure: section I anchored on page 1').toBeTruthy();
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await recordStore(page);
    const last = async () => (await recorded(page)).actions.at(-1) as { kind: string; text?: string; sectionId?: string; anchor?: { kind: string; quote: { exact: string } } };
    const count = async () => (await recorded(page)).actions.length;
    const s = await spanSel(page, 1, 'Each scan is deskewed');
    const select = () => selectSpans(page, s, s);
    for (const [how, kind] of [
      ['rd-toolbar-ask', 'ask'],
      ['rd-toolbar-note', 'note'],
      ['rd-toolbar-glossary', 'glossary'],
      ['c', 'ask'],
      ['n', 'note'],
      ['g', 'glossary'],
    ] as const) {
      await select();
      await expect(page.getByTestId('selection-toolbar')).toBeVisible();
      const n = await count();
      if (how.startsWith('rd-')) await page.getByTestId(how).click();
      else await page.keyboard.press(how);
      await expect.poll(count).toBe(n + 1);
      const a = await last();
      expect(a.kind, how).toBe(kind);
      expect(a.anchor?.kind).toBe('text');
      expect(a.anchor?.quote.exact).toContain('Each scan is deskewed');
      expect(a.text).toContain('Each scan is deskewed');
      // the section comes from the selection, not the viewport; other kinds carry none
      expect(a.sectionId, how).toBe(kind === 'glossary' ? undefined : intro!.id);
    }
    // no selection: C and N still publish (without anchor / text); G needs a selection. Before each bare key the
    // user presses an empty spot of the PDF once (a panel may have taken the focus after the previous action).
    // Escape alone clears the store selection the last G left behind (the empty-spot press below would also clear it)
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    expect(await storeSelection(page)).not.toBeNull();
    await page.keyboard.press('Escape');
    expect(await storeSelection(page)).toBeNull();
    for (const [key, kind] of [
      ['c', 'ask'],
      ['n', 'note'],
    ] as const) {
      const n = await count();
      await pressEmptyPdfSpot(page);
      await page.keyboard.press(key);
      await expect.poll(count).toBe(n + 1);
      expect(await last()).toEqual({ kind });
    }
    const n = await count();
    await pressEmptyPdfSpot(page);
    await page.keyboard.press('g');
    await page.waitForTimeout(300);
    expect(await count()).toBe(n);

    // without the AI context: explain / ask / glossary disabled, translate and note stay
    await page.evaluate(() => {
      const st = (window as unknown as { __spReader: { getState(): { setPaperState(p: object): void } } }).__spReader.getState();
      st.setPaperState({ readable: true, contextReady: false, structureReady: true, aiBlockedReason: null });
    });
    await select();
    await expect(page.getByTestId('selection-toolbar')).toBeVisible();
    for (const id of ['toolbar-explain', 'rd-toolbar-ask', 'rd-toolbar-glossary']) await expect(page.getByTestId(id), id).toBeDisabled();
    for (const id of ['rd-toolbar-translate', 'rd-toolbar-note']) await expect(page.getByTestId(id), id).toBeEnabled();
    const m = await count();
    await page.keyboard.press('g');
    await expect(page.getByTestId('selection-notice')).toBeVisible();
    expect(await count()).toBe(m);
  });

  test('focus guard: an input outside the viewer holds the focus before every selection and bare key (what the side panel does after ask / note) — the toolbar and shortcuts still publish ask / note / glossary, and C / N without a selection', async ({ page }) => {
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await recordStore(page);
    const last = async () => (await recorded(page)).actions.at(-1) as { kind: string; text?: string; anchor?: { kind: string; quote: { exact: string } } };
    const count = async () => (await recorded(page)).actions.length;
    // an input outside the viewer, in the side panel like the panel's follow-up and note inputs
    await page.evaluate(() => {
      const t = document.createElement('textarea');
      t.id = 'e2e-panel-input';
      (document.querySelector('[data-testid="side-panel"]') ?? document.body).appendChild(t);
    });
    const input = page.locator('#e2e-panel-input');
    const focusOutside = async () => {
      await input.focus();
      await expect(input).toBeFocused();
    };
    const s = await spanSel(page, 1, 'Each scan is deskewed');
    for (const [how, kind] of [
      ['rd-toolbar-ask', 'ask'],
      ['rd-toolbar-note', 'note'],
      ['rd-toolbar-glossary', 'glossary'],
      ['c', 'ask'],
      ['n', 'note'],
      ['g', 'glossary'],
    ] as const) {
      await focusOutside();
      await selectSpans(page, s, s);
      await expect(input, how).not.toBeFocused();
      await expect(page.getByTestId('selection-toolbar')).toBeVisible();
      const n = await count();
      if (how.startsWith('rd-')) await page.getByTestId(how).click();
      else await page.keyboard.press(how);
      await expect.poll(count, how).toBe(n + 1);
      const a = await last();
      expect(a.kind, how).toBe(kind);
      expect(a.anchor?.kind).toBe('text');
      expect(a.anchor?.quote.exact).toContain('Each scan is deskewed');
      expect(a.text).toContain('Each scan is deskewed');
    }
    // no selection: Escape clears the store selection, the press on an empty spot of the PDF releases the input,
    // then C and N publish
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    expect(await storeSelection(page)).not.toBeNull();
    await page.keyboard.press('Escape');
    expect(await storeSelection(page)).toBeNull();
    for (const [key, kind] of [
      ['c', 'ask'],
      ['n', 'note'],
    ] as const) {
      await focusOutside();
      const n = await count();
      await pressEmptyPdfSpot(page);
      await expect(input, key).not.toBeFocused();
      await page.keyboard.press(key);
      await expect.poll(count, key).toBe(n + 1);
      expect(await last()).toEqual({ kind });
    }
    // no shortcut key reached the input
    await expect(input).toHaveValue('');
  });

  test('external link: confirmation shows the host; cancel opens nothing; open → new tab with noopener; a middle click also asks first', async ({ page }) => {
    await openPaper(page, SEED_LINKS_PAPER_ID, SEED_LINKS_TITLE);
    await expect(page.locator('.page[data-page-number="1"] .annotationLayer a')).toHaveCount(2, { timeout: 15_000 });
    // synthetic-links.pdf has no URL link: add one the way pdf.js renders it (a section with a plain <a href>)
    await page.evaluate(() => {
      const layer = document.querySelector('.page[data-page-number="1"] .annotationLayer')!;
      const sec = document.createElement('section');
      sec.className = 'linkAnnotation';
      sec.style.cssText = 'position:absolute;left:60%;top:80%;width:20%;height:3%;z-index:5';
      const a = document.createElement('a');
      a.href = 'https://example.org/code?x=1';
      a.target = '_blank';
      a.setAttribute('data-testid', 'e2e-ext-link');
      a.style.cssText = 'display:block;width:100%;height:100%';
      sec.appendChild(a);
      layer.appendChild(sec);
      (window as unknown as { __opened: string[][] }).__opened = [];
      window.open = ((...args: string[]) => {
        (window as unknown as { __opened: string[][] }).__opened.push(args);
        return null;
      }) as typeof window.open;
    });
    const opened = () => page.evaluate(() => (window as unknown as { __opened: string[][] }).__opened);
    const popups: unknown[] = [];
    page.context().on('page', (p) => popups.push(p));
    const link = page.getByTestId('e2e-ext-link');

    await link.click();
    await expect(page.getByTestId('rd-link-confirm')).toBeVisible();
    await expect(page.getByTestId('rd-link-host')).toHaveText('example.org');
    await page.getByTestId('rd-link-cancel').click();
    await expect(page.getByTestId('rd-link-confirm')).toHaveCount(0);
    expect(await opened()).toEqual([]);

    await link.click({ button: 'middle' });
    await expect(page.getByTestId('rd-link-confirm')).toBeVisible();
    await page.getByTestId('rd-link-open').click();
    await expect(page.getByTestId('rd-link-confirm')).toHaveCount(0);
    expect(await opened()).toEqual([['https://example.org/code?x=1', '_blank', 'noopener,noreferrer']]);
    await page.waitForTimeout(300);
    expect(popups).toHaveLength(0); // neither click let the browser open the href itself
    expect(new URL(page.url()).pathname).toBe(`/paper/${SEED_LINKS_PAPER_ID}`);
  });

  test('equation / section jumps flash on the server rect (located); A.1 → no_anchor without moving; II-B is disabled and never moves', async ({ page, baseURL }) => {
    const st = await realJson<StructureResponse>(baseURL!, 'papers.structure', { params: { id: SEED_M2_PAPER_ID } });
    const eqs = (n: string) => st.equations.filter((e) => e.number === n);
    const iia = st.sections.find((s) => s.number === 'II-A')!;
    expect(iia.pdfRect).not.toBeNull();
    expect(st.sections.find((s) => s.number === 'II-B')!.pdfPage).toBeNull();
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await expect(page.getByTestId('rd-outline-tree')).toBeVisible();
    const jumpEq = (id: string) => page.evaluate((id) => (window as unknown as M2Window).__spReader.getState().jumpToEquation(id), id);

    // II-B (not in the PDF): disabled with the reason; a click neither moves nor pushes the stack
    const iib = outlineItem(page, 'II-B').getByTestId('rd-outline-link');
    await expect(iib).toHaveAttribute('aria-disabled', 'true');
    await expect(iib).toHaveAttribute('title', 'PDF 위치를 찾지 못함');
    const top0 = await viewerScrollTop(page);
    await iib.click({ force: true }); // aria-disabled: Playwright would wait for it to become enabled
    await page.waitForTimeout(300);
    expect(await viewerScrollTop(page)).toBe(top0);
    await expect(page.getByTestId('rd-back')).toBeDisabled();
    await expect(page.locator('.sp-flash')).toHaveCount(0);

    for (const n of ['1', '2']) {
      const e = eqs(n)[0]!;
      expect(e.pdfPage && e.pdfRect, `seed equation ${n}`).toBeTruthy();
      expect(await jumpEq(e.id)).toBe('located');
      const flash = pageEl(page, e.pdfPage!).getByTestId('rd-eq-flash');
      await expect(flash).toHaveCount(1);
      await expect(flash.locator('.sp-flash-part')).toBeInViewport();
      const [part] = await relBoxes(page, `.page[data-page-number="${e.pdfPage}"] [data-testid="rd-eq-flash"] .sp-flash-part`, e.pdfPage!);
      expect(overlaps(part!, rectBox(e.pdfRect!))).toBe(true);
      expect(part!.x).toBeGreaterThanOrEqual(-1e-3);
      expect(part!.x + part!.w).toBeLessThanOrEqual(1 + 1e-3);
    }
    await expect(page.getByTestId('rd-back')).toBeEnabled();

    // A.1: two equations share the number and neither has a PDF position
    const a1 = eqs('A.1');
    expect(a1).toHaveLength(2);
    const before = await viewerScrollTop(page);
    for (const e of a1) expect(await jumpEq(e.id)).toBe('no_anchor');
    expect(await viewerScrollTop(page)).toBe(before);

    // outline click on II-A (a real heading line on page 2)
    await page.evaluate(() => (window as unknown as M2Window).__spViewer.getViewer().scrollPageIntoView({ pageNumber: 1 }));
    await outlineItem(page, 'II-A').getByTestId('rd-outline-link').click();
    const sflash = pageEl(page, iia.pdfPage!).getByTestId('rd-section-flash');
    await expect(sflash).toHaveCount(1);
    await expect(sflash.locator('.sp-flash-part')).toBeInViewport();
    const [spart] = await relBoxes(page, `.page[data-page-number="${iia.pdfPage}"] [data-testid="rd-section-flash"] .sp-flash-part`, iia.pdfPage!);
    expect(overlaps(spart!, rectBox(iia.pdfRect!))).toBe(true);
    expect(await page.evaluate((id) => (window as unknown as M2Window).__spReader.getState().jumpToSection(id), iia.id)).toBe('located');
    // the outline marks the section at the top of the viewport: between the II and II-A headings → II (zoomed in so
    // that this point of the last page can reach the top of the viewport)
    for (let i = 0; i < 2; i++) await page.getByTestId('zoom-in').click();
    await page.waitForSelector(`.page[data-page-number="${iia.pdfPage}"] .textLayer .endOfContent`, { state: 'attached' });
    const ii = st.sections.find((s) => s.number === 'II')!;
    expect(ii.pdfPage).toBe(iia.pdfPage);
    const mid = (ii.pdfRect!.y + iia.pdfRect!.y) / 2;
    await page.evaluate(
      ([n, frac]) => {
        const c = (window as unknown as M2Window).__spViewer.getViewer().container;
        const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
        c.scrollTop += p.top + frac * p.height - c.getBoundingClientRect().top;
      },
      [iia.pdfPage!, mid] as const,
    );
    await expect(outlineItem(page, 'II')).toHaveAttribute('data-current', 'true');
    await expect(outlineItem(page, 'II-A')).toHaveAttribute('data-current', 'false');
    await expect(outlineItem(page, 'I')).toHaveAttribute('data-current', 'false');
  });

  test('links: internal link → page 2, then "뒤로" and Alt+← return to the same place (±2 px); [1] → panelFocus references without moving', async ({ page }) => {
    await openPaper(page, SEED_LINKS_PAPER_ID, SEED_LINKS_TITLE);
    await recordStore(page);
    const links = page.locator('.page[data-page-number="1"] .annotationLayer a');
    await expect(links).toHaveCount(2, { timeout: 15_000 });
    // pdf.js marks internal links on the section (data-internal-link), never with a class internalLink (C-R2-02)
    expect(await links.evaluateAll((els) => els.map((e) => [e.closest('section')?.hasAttribute('data-internal-link'), e.classList.contains('internalLink')]))).toEqual([
      [true, false],
      [true, false],
    ]);
    const tops = await links.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    const sectionLink = links.nth(tops[0]! < tops[1]! ? 0 : 1); // "Section II" is on the upper line
    const citeLink = links.nth(tops[0]! < tops[1]! ? 1 : 0); // "[1]"
    await page.evaluate(() => {
      (window as unknown as M2Window).__spViewer.getViewer().container.scrollTop = 40;
    });
    await expect.poll(() => viewerScrollTop(page)).toBe(40);
    const start = await viewerScrollTop(page);
    await expect(page.getByTestId('rd-back')).toBeDisabled();
    for (const how of ['button', 'Alt+ArrowLeft'] as const) {
      await sectionLink.click();
      await expect.poll(() => topPageNumber(page)).toBe(2);
      await expect(page.getByTestId('rd-back')).toBeEnabled();
      if (how === 'button') await page.getByTestId('rd-back').click();
      else await page.keyboard.press(how);
      await expect.poll(async () => Math.abs((await viewerScrollTop(page)) - start)).toBeLessThanOrEqual(2);
      await expect(page.getByTestId('rd-back')).toBeDisabled();
    }
    expect(new URL(page.url()).pathname).toBe(`/paper/${SEED_LINKS_PAPER_ID}`); // Alt+← did not go back in history

    const before = await viewerScrollTop(page);
    await citeLink.click();
    await expect.poll(async () => (await recorded(page)).focus).toEqual([{ tab: 'references', referenceOrdinal: 1 }]);
    await page.waitForTimeout(300);
    expect(await viewerScrollTop(page)).toBe(before);
    await expect(page.getByTestId('rd-back')).toBeDisabled();
  });

  test('T → pendingAction translate with the selection; after typing in an input outside the viewer, selecting in the PDF + E starts an explanation', async ({ page }) => {
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await recordStore(page);
    const s = await spanSel(page, 1, 'Each scan is deskewed');
    await selectSpans(page, s, s);
    await expect(page.getByTestId('rd-toolbar-translate')).toBeEnabled();
    await page.keyboard.press('t');
    await expect.poll(async () => (await recorded(page)).actions.length).toBe(1);
    const tr = (await recorded(page)).actions[0] as { kind: string; text: string; anchor: { kind: string; quote: { exact: string }; rects: { page: number }[] } };
    expect(tr.kind).toBe('translate');
    expect(tr.anchor.kind).toBe('text');
    expect(tr.anchor.quote.exact).toContain('Each scan is deskewed with a constant velocity model');
    expect(tr.text).toContain('Each scan is deskewed');
    expect(tr.anchor.rects.every((r) => r.page === 1)).toBe(true);

    // focus carry-over: an input outside the viewer (in the side panel) keeps the focus after typing
    await page.evaluate(() => {
      const t = document.createElement('textarea');
      t.id = 'e2e-panel-input';
      (document.querySelector('[data-testid="side-panel"]') ?? document.body).appendChild(t);
    });
    await page.locator('#e2e-panel-input').fill('abc');
    await expect(page.locator('#e2e-panel-input')).toBeFocused();
    const explain = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/papers/${SEED_M2_PAPER_ID}/threads`, { timeout: 15_000 });
    const line = span(page, 1, 'We estimate the robot pose');
    for (const from of [0.03, 0.02, 0.04]) {
      await drag(page, line, from, line, 0.6);
      if ((await page.evaluate(() => window.getSelection()?.toString() ?? '')).includes('estimate')) break;
    }
    await expect(page.locator('#e2e-panel-input')).not.toBeFocused();
    await page.keyboard.press('e');
    const req = await explain;
    expect((req.postDataJSON() as { kind: string }).kind).toBe('explain');
    await expect(page.locator('#e2e-panel-input')).toHaveValue('abc');
    await expect.poll(async () => ((await recorded(page)).actions.at(-1) as { kind: string }).kind).toBe('explain');
  });

  test('position: page 2 + zoom → papers.position PUT (contract body) → reload reopens the same page and zoom', async ({ page, baseURL }) => {
    const store = createMockStore();
    const puts: unknown[] = [];
    await mockRoute(page, 'papers.position', (req) => {
      puts.push(req.body);
      store.set('pos', LastPositionDto.parse(req.body));
      return { kind: 'empty' };
    });
    await mockRoute(page, 'papers.get', async (req) => {
      const real = await realJson<PaperDetailDto>(baseURL!, 'papers.get', { params: req.params });
      return { kind: 'json', body: req.params.id === SEED_M2_PAPER_ID ? { ...real, lastPosition: store.get<LastPositionDto>('pos') ?? null } : real };
    });
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await page.evaluate(() => (window as unknown as M2Window).__spViewer.getViewer().scrollPageIntoView({ pageNumber: 2 }));
    await expect.poll(() => topPageNumber(page)).toBe(2);
    await page.getByTestId('zoom-in').click();
    const zoomText = (await page.getByTestId('zoom-level').textContent())!;
    expect(zoomText).toMatch(/^\d+%$/);
    await expect.poll(() => store.get<LastPositionDto>('pos')?.mode, { timeout: 8_000 }).toBe('custom');
    const saved = store.get<LastPositionDto>('pos')!;
    expect(saved.page).toBe(2);
    expect(Object.keys(puts.at(-1) as object).sort()).toEqual(['mode', 'page', 'top', 'zoom']);
    expect(Math.round(saved.zoom * 100)).toBe(Number(zoomText.replace('%', '')));

    await page.reload();
    await page.waitForSelector('.page .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
    await expect(page.getByTestId('zoom-level')).toHaveText(zoomText);
    await expect.poll(() => topPageNumber(page)).toBe(2);
    expect(await page.evaluate(() => (window as unknown as M2Window).__spViewer.getViewer().currentScale)).toBeCloseTo(saved.zoom, 3);
    expect(mockViolations(page)).toEqual([]);
  });

  test('position in one tab: Library → the same paper again (no reload) restores the saved place; leaving right after a scroll saves the viewed page, not the last one', async ({ page, baseURL }) => {
    const store = createMockStore();
    const puts: LastPositionDto[] = [];
    await mockRoute(page, 'papers.position', (req) => {
      const p = LastPositionDto.parse(req.body);
      puts.push(p);
      store.set('pos', p);
      return { kind: 'empty' };
    });
    await mockRoute(page, 'papers.get', async (req) => {
      const real = await realJson<PaperDetailDto>(baseURL!, 'papers.get', { params: req.params });
      return { kind: 'json', body: req.params.id === SEED_M2_PAPER_ID ? { ...real, lastPosition: store.get<LastPositionDto>('pos') ?? null } : real };
    });
    /** Scrolls so that `top` of page n is at the container top. */
    const scrollTo = (n: number, top: number) =>
      page.evaluate(
        ([n, top]) => {
          const c = (window as unknown as M2Window).__spViewer.getViewer().container;
          const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
          c.scrollTop += p.top + top * p.height - c.getBoundingClientRect().top;
        },
        [n, top] as const,
      );
    /** Pixels between the container top and `top` of page n (0 = exactly there). */
    const offsetFrom = (n: number, top: number) =>
      page.evaluate(
        ([n, top]) => {
          const c = (window as unknown as M2Window).__spViewer.getViewer().container.getBoundingClientRect().top;
          const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
          return Math.abs(p.top + top * p.height - c);
        },
        [n, top] as const,
      );
    const reopen = async () => {
      await page.getByRole('link', { name: '← Library' }).click();
      await page.locator(`[data-testid="paper-row"][data-paper-id="${SEED_M2_PAPER_ID}"]`).getByRole('link', { name: SEED_M2_TITLE }).click();
      await expect(page.getByTestId('paper-title')).toHaveText(SEED_M2_TITLE);
      await page.waitForSelector('.page .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
    };

    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await page.getByTestId('zoom-in').click();
    const zoomText = (await page.getByTestId('zoom-level').textContent())!;
    await page.waitForTimeout(300);
    await scrollTo(2, 0.2);
    await expect.poll(() => store.get<LastPositionDto>('pos')?.page, { timeout: 8_000 }).toBe(2); // the debounced PUT
    const saved = store.get<LastPositionDto>('pos')!;
    expect(saved.top).toBeCloseTo(0.2, 2);

    // same tab, no reload: the cached papers.get carries the saved position
    await reopen();
    await expect(page.getByTestId('zoom-level')).toHaveText(zoomText);
    await expect.poll(() => offsetFrom(2, saved.top)).toBeLessThanOrEqual(2);

    // scroll and leave at once (inside the 1.5 s debounce): the unmount flush sends the page being viewed
    await page.waitForTimeout(300); // the saver starts after the restore
    const n = puts.length;
    await scrollTo(1, 0.3);
    await expect.poll(() => offsetFrom(1, 0.3)).toBeLessThanOrEqual(1);
    await page.getByRole('link', { name: '← Library' }).click();
    await expect.poll(() => puts.length, { timeout: 8_000 }).toBe(n + 1);
    expect(puts.at(-1)!.page).toBe(1);
    expect(puts.at(-1)!.top).toBeCloseTo(0.3, 2);
    await page.locator(`[data-testid="paper-row"][data-paper-id="${SEED_M2_PAPER_ID}"]`).getByRole('link', { name: SEED_M2_TITLE }).click();
    await page.waitForSelector('.page .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
    await expect.poll(() => offsetFrom(1, puts.at(-1)!.top)).toBeLessThanOrEqual(2);
    expect(mockViolations(page)).toEqual([]);
  });

  // Codex m-M2-1 (AD 추가 지시 4 "C 수정 2"): one PUT at a time, saved only after success, a failed newest position
  // sent again on the next flush (here the unmount flush), never on its own.
  test('position save: a newer place waits for the PUT in flight; a failed PUT is not saved and goes again when the reader is left', async ({ page, baseURL }) => {
    const store = createMockStore();
    const puts: LastPositionDto[] = [];
    let held: Promise<void> | null = null;
    let release = () => {};
    let failNext = false;
    await mockRoute(page, 'papers.position', async (req) => {
      const p = LastPositionDto.parse(req.body);
      puts.push(p);
      if (held) await held;
      if (failNext) {
        failNext = false;
        return { kind: 'error', status: 500, code: 'internal' };
      }
      store.set('pos', p);
      return { kind: 'empty' };
    });
    await mockRoute(page, 'papers.get', async (req) => {
      const real = await realJson<PaperDetailDto>(baseURL!, 'papers.get', { params: req.params });
      return { kind: 'json', body: req.params.id === SEED_M2_PAPER_ID ? { ...real, lastPosition: store.get<LastPositionDto>('pos') ?? null } : real };
    });
    const scrollTo = (n: number, top: number) =>
      page.evaluate(
        ([n, top]) => {
          const c = (window as unknown as M2Window).__spViewer.getViewer().container;
          const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
          c.scrollTop += p.top + top * p.height - c.getBoundingClientRect().top;
        },
        [n, top] as const,
      );

    held = new Promise<void>((r) => (release = r));
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await page.waitForTimeout(300); // the saver starts after the restore
    await scrollTo(2, 0.2);
    await expect.poll(() => puts.length, { timeout: 8_000 }).toBe(1); // page 2: answered only when released
    expect(puts[0]!.page).toBe(2);
    await scrollTo(1, 0.3);
    await expect.poll(() => topPageNumber(page)).toBe(1);
    await page.waitForTimeout(2_500); // longer than the 1.5 s debounce: before m-M2-1 the page 1 PUT went out here
    expect(puts).toHaveLength(1);
    held = null;
    release();
    await expect.poll(() => puts.length, { timeout: 8_000 }).toBe(2); // the newest place, once the first PUT settled
    expect(puts[1]!.page).toBe(1);
    expect(puts[1]!.top).toBeCloseTo(0.3, 2);
    expect(store.get<LastPositionDto>('pos')!.page).toBe(1); // the server ends on the newer place

    failNext = true;
    await scrollTo(2, 0.5);
    await expect.poll(() => puts.length, { timeout: 8_000 }).toBe(3); // this PUT fails (500)
    expect(puts[2]!.page).toBe(2);
    await page.waitForTimeout(2_500); // no retry on its own
    expect(puts).toHaveLength(3);
    expect(store.get<LastPositionDto>('pos')!.page).toBe(1);
    await page.getByRole('link', { name: '← Library' }).click(); // the unmount flush sends the unsaved place again
    await expect.poll(() => puts.length, { timeout: 8_000 }).toBe(4);
    expect(puts[3]).toEqual(puts[2]);
    expect(store.get<LastPositionDto>('pos')!.page).toBe(2);
    await page.reload();
    await page.locator(`[data-testid="paper-row"][data-paper-id="${SEED_M2_PAPER_ID}"]`).getByRole('link', { name: SEED_M2_TITLE }).click();
    await page.waitForSelector('.page .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
    await expect.poll(() => topPageNumber(page)).toBe(2);
    expect(mockViolations(page)).toEqual([]);
  });

  // Review C2-R1-02: PdfReader's wiring — the cached papers.get gets only a place the server confirmed (an in-tab
  // reopen after failed PUTs restores the confirmed one), and the PUT sent when the reader is left goes with keepalive.
  test('position save: after failed PUTs an in-tab reopen restores the confirmed place; the PUT on leaving is keepalive', async ({ page, baseURL }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __spPositionKeepalive: boolean[] };
      w.__spPositionKeepalive = [];
      const orig = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/papers\/[^/?]+\/position$/.test(url) && init?.method === 'PUT') w.__spPositionKeepalive.push(init.keepalive === true);
        return orig(input, init);
      };
    });
    const store = createMockStore();
    const puts: LastPositionDto[] = [];
    let fail = false;
    await mockRoute(page, 'papers.position', (req) => {
      const p = LastPositionDto.parse(req.body);
      puts.push(p);
      if (fail) return { kind: 'error', status: 500, code: 'internal' };
      store.set('pos', p);
      return { kind: 'empty' };
    });
    await mockRoute(page, 'papers.get', async (req) => {
      const real = await realJson<PaperDetailDto>(baseURL!, 'papers.get', { params: req.params });
      return { kind: 'json', body: req.params.id === SEED_M2_PAPER_ID ? { ...real, lastPosition: store.get<LastPositionDto>('pos') ?? null } : real };
    });
    const scrollTo = (n: number, top: number) =>
      page.evaluate(
        ([n, top]) => {
          const c = (window as unknown as M2Window).__spViewer.getViewer().container;
          const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
          c.scrollTop += p.top + top * p.height - c.getBoundingClientRect().top;
        },
        [n, top] as const,
      );
    const offsetFrom = (n: number, top: number) =>
      page.evaluate(
        ([n, top]) => {
          const c = (window as unknown as M2Window).__spViewer.getViewer().container.getBoundingClientRect().top;
          const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
          return Math.abs(p.top + top * p.height - c);
        },
        [n, top] as const,
      );
    const positionPut = () => page.waitForResponse((r) => /\/papers\/[^/?]+\/position$/.test(new URL(r.url()).pathname) && r.request().method() === 'PUT', { timeout: 8_000 });

    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await page.waitForTimeout(300); // the saver starts after the restore
    await scrollTo(1, 0.3);
    await expect.poll(() => store.get<LastPositionDto>('pos')?.page, { timeout: 8_000 }).toBe(1); // confirmed: page 1, top 0.3
    const confirmed = store.get<LastPositionDto>('pos')!;
    expect(confirmed.top).toBeCloseTo(0.3, 2);

    fail = true;
    let answered = positionPut();
    await scrollTo(2, 0.5);
    expect((await answered).status()).toBe(500); // page 2: not saved
    expect(puts.at(-1)!.page).toBe(2);
    answered = positionPut();
    await page.getByRole('link', { name: '← Library' }).click(); // the unmount flush sends page 2 again — and fails again
    expect((await answered).status()).toBe(500);
    expect(puts.at(-1)!.page).toBe(2);
    expect(puts).toHaveLength(3);

    // same tab, no reload: the cached papers.get must still carry the confirmed place, not the failed page 2
    await page.locator(`[data-testid="paper-row"][data-paper-id="${SEED_M2_PAPER_ID}"]`).getByRole('link', { name: SEED_M2_TITLE }).click();
    await expect(page.getByTestId('paper-title')).toHaveText(SEED_M2_TITLE);
    await page.waitForSelector('.page .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
    await expect.poll(() => topPageNumber(page)).toBe(1);
    await expect.poll(() => offsetFrom(1, confirmed.top)).toBeLessThanOrEqual(2);
    // the debounced PUTs went without keepalive, the one sent when the reader was left with it
    expect(await page.evaluate(() => (window as unknown as { __spPositionKeepalive: boolean[] }).__spPositionKeepalive)).toEqual([false, false, true]);
    expect(mockViolations(page)).toEqual([]);
  });

  // Review C2-R1-01: the save state is per paper, shared by the reader that was left and the one opened again while
  // the old PUT is still open — the reopened reader starts from the newest place and its place replaces the old
  // waiting one (before: requests [2, 1, 3], the server ending on the older page 3).
  test('position save: reopened while the old PUT is open → starts from the newest place; the server ends on the reopened reader’s place', async ({ page, baseURL }) => {
    const store = createMockStore();
    const puts: LastPositionDto[] = [];
    let release = () => {};
    let held: Promise<void> | null = new Promise<void>((r) => (release = r));
    await mockRoute(page, 'papers.position', async (req) => {
      const p = LastPositionDto.parse(req.body);
      puts.push(p);
      if (held) await held;
      store.set('pos', p);
      return { kind: 'empty' };
    });
    await mockRoute(page, 'papers.get', async (req) => {
      const real = await realJson<PaperDetailDto>(baseURL!, 'papers.get', { params: req.params });
      return { kind: 'json', body: req.params.id === SEED_M2_PAPER_ID ? { ...real, lastPosition: store.get<LastPositionDto>('pos') ?? null } : real };
    });
    const scrollTo = (n: number, top: number) =>
      page.evaluate(
        ([n, top]) => {
          const c = (window as unknown as M2Window).__spViewer.getViewer().container;
          const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
          c.scrollTop += p.top + top * p.height - c.getBoundingClientRect().top;
        },
        [n, top] as const,
      );
    const offsetFrom = (n: number, top: number) =>
      page.evaluate(
        ([n, top]) => {
          const c = (window as unknown as M2Window).__spViewer.getViewer().container.getBoundingClientRect().top;
          const p = document.querySelector(`.page[data-page-number="${n}"]`)!.getBoundingClientRect();
          return Math.abs(p.top + top * p.height - c);
        },
        [n, top] as const,
      );

    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    await page.waitForTimeout(300); // the saver starts after the restore
    await scrollTo(2, 0.2);
    await expect.poll(() => puts.length, { timeout: 8_000 }).toBe(1); // A = page 2, held open
    await scrollTo(1, 0.5);
    await expect.poll(() => offsetFrom(1, 0.5)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(2_000); // B = page 1 top 0.5 waits behind A (debounce over)
    await page.getByRole('link', { name: '← Library' }).click(); // leave: B still waits
    await page.locator(`[data-testid="paper-row"][data-paper-id="${SEED_M2_PAPER_ID}"]`).getByRole('link', { name: SEED_M2_TITLE }).click();
    await expect(page.getByTestId('paper-title')).toHaveText(SEED_M2_TITLE);
    await page.waitForSelector('.page .textLayer .endOfContent', { state: 'attached', timeout: 30_000 });
    // the cached papers.get has no position yet (A is open), but the reader starts from B, the newest place
    await expect.poll(() => offsetFrom(1, 0.5)).toBeLessThanOrEqual(2);
    expect(puts).toHaveLength(1);

    await page.waitForTimeout(300);
    await scrollTo(1, 0.2); // C = page 1 top 0.2 replaces B
    await expect.poll(() => offsetFrom(1, 0.2)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(2_000);
    expect(puts).toHaveLength(1);
    held = null;
    release();
    await expect.poll(() => puts.length, { timeout: 8_000 }).toBe(2);
    await page.waitForTimeout(2_000); // B is never sent after C
    expect(puts.map((p) => p.page)).toEqual([2, 1]); // A, then C — B (page 1 top 0.5) never goes
    expect(puts[1]!.top).toBeCloseTo(0.2, 2);
    expect(store.get<LastPositionDto>('pos')!.page).toBe(1);
    expect(store.get<LastPositionDto>('pos')!.top).toBeCloseTo(0.2, 2);
    expect(mockViolations(page)).toEqual([]);
  });

  test('outline progress: two clicks → progress.put bodies → "이해" after reload', async ({ page }) => {
    const store = createMockStore({ progress: [] });
    const bodies: unknown[] = [];
    await mockRoute(page, 'progress.list', () => ({ kind: 'json', body: { progress: store.get<ProgressDto[]>('progress') ?? [] } }));
    await mockRoute(page, 'progress.put', (req) => {
      bodies.push(req.body);
      const dto: ProgressDto = { sectionId: req.params.sectionId!, state: PutProgressRequest.parse(req.body).state, updatedAt: Date.now() };
      store.update<ProgressDto[]>('progress', (prev = []) => [...prev.filter((p) => p.sectionId !== dto.sectionId), dto]);
      return { kind: 'json', body: dto };
    });
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    const toggle = outlineItem(page, 'II-A').getByTestId('rd-progress-toggle');
    await expect(toggle).toHaveText('안 읽음');
    await toggle.click();
    await expect(toggle).toHaveText('훑음');
    await toggle.click();
    await expect(toggle).toHaveText('이해');
    await expect.poll(() => bodies).toEqual([{ state: 'skimmed' }, { state: 'understood' }]);
    await expect(page.getByTestId('rd-progress-summary')).toHaveText('이해 이상 1 / 전체 4');
    await page.reload();
    await expect(outlineItem(page, 'II-A').getByTestId('rd-progress-toggle')).toHaveText('이해');
    expect(mockViolations(page)).toEqual([]);
  });

  test('outline progress: a failed PUT notice does not move the list — the next click on the same spot reaches the same section (C-FX4-R1-01)', async ({ page }) => {
    const store = createMockStore({ progress: [], failNext: true });
    const putSections: string[] = [];
    await mockRoute(page, 'progress.list', () => ({ kind: 'json', body: { progress: store.get<ProgressDto[]>('progress') ?? [] } }));
    await mockRoute(page, 'progress.put', (req) => {
      putSections.push(req.params.sectionId!);
      if (store.get<boolean>('failNext')) {
        store.set('failNext', false);
        return { kind: 'error', status: 500, code: 'internal', message: '서버 오류' };
      }
      const dto: ProgressDto = { sectionId: req.params.sectionId!, state: PutProgressRequest.parse(req.body).state, updatedAt: Date.now() };
      store.update<ProgressDto[]>('progress', (prev = []) => [...prev.filter((p) => p.sectionId !== dto.sectionId), dto]);
      return { kind: 'json', body: dto };
    });
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    const toggles = page.getByTestId('rd-progress-toggle');
    await expect(toggles.first()).toBeEnabled();
    const count = await toggles.count();
    const target = toggles.nth(count - 1); // the last row: below the notice either way
    const targetId = await target.locator('xpath=ancestor::li[1]').getAttribute('data-section-id');
    const rowsY = async () => Promise.all(Array.from({ length: count }, (_, i) => toggles.nth(i).boundingBox().then((b) => b!.y)));
    const listY = async () => (await page.getByTestId('rd-outline-tree').boundingBox())!.y;
    const y0 = await listY();
    const rows0 = await rowsY();
    const b = (await target.boundingBox())!;
    const spot = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByTestId('rd-progress-error')).toBeVisible();
    await expect(page.getByTestId('rd-progress-error')).toContainText('서버 오류');
    await expect(target).toHaveText('안 읽음'); // the reload after the failure
    await expect(target).toBeEnabled();
    expect(Math.abs((await listY()) - y0), 'the list did not move when the notice came').toBeLessThanOrEqual(0.5);
    expect((await rowsY()).map((y, i) => Math.round(Math.abs(y - rows0[i]!)))).toEqual(rows0.map(() => 0));
    // the same spot again: the same section, not the row that would have moved under the pointer
    await page.mouse.click(spot.x, spot.y);
    await expect.poll(() => putSections).toEqual([targetId, targetId]);
    await expect(target).toHaveText('훑음');
    await expect(page.getByTestId('rd-progress-error')).toHaveCount(0);
    expect(Math.abs((await listY()) - y0), 'the list did not move when the notice went').toBeLessThanOrEqual(0.5);
    expect(mockViolations(page)).toEqual([]);
  });

  test('outline progress: a failed PUT on the first row — the same spot again lands on the notice, not on 닫기; the notice stays to be read (C-FX4-R2-01)', async ({ page }) => {
    const store = createMockStore({ progress: [], failNext: true });
    const putSections: string[] = [];
    await mockRoute(page, 'progress.list', () => ({ kind: 'json', body: { progress: store.get<ProgressDto[]>('progress') ?? [] } }));
    await mockRoute(page, 'progress.put', (req) => {
      putSections.push(req.params.sectionId!);
      if (store.get<boolean>('failNext')) {
        store.set('failNext', false);
        return { kind: 'error', status: 500, code: 'internal', message: '서버 오류' };
      }
      const dto: ProgressDto = { sectionId: req.params.sectionId!, state: PutProgressRequest.parse(req.body).state, updatedAt: Date.now() };
      store.update<ProgressDto[]>('progress', (prev = []) => [...prev.filter((p) => p.sectionId !== dto.sectionId), dto]);
      return { kind: 'json', body: dto };
    });
    await openPaper(page, SEED_M2_PAPER_ID, SEED_M2_TITLE);
    const toggles = page.getByTestId('rd-progress-toggle');
    await expect(toggles.first()).toBeEnabled();
    const target = toggles.first(); // the first row: under the notice
    const targetId = await target.locator('xpath=ancestor::li[1]').getAttribute('data-section-id');
    const b = (await target.boundingBox())!;
    const spot = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await page.mouse.click(spot.x, spot.y);
    const notice = page.getByTestId('rd-progress-error');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('서버 오류');
    await expect(target).toHaveText('안 읽음'); // the reload after the failure
    await expect(target).toBeEnabled();
    // the notice covers this row's button; 닫기 is not at that spot
    const c = (await page.getByTestId('rd-progress-error-close').boundingBox())!;
    const o = (await page.getByTestId('rd-progress-error-overlay').boundingBox())!;
    expect(spot.y >= o.y && spot.y <= o.y + o.height, 'the spot is under the notice').toBe(true);
    expect(spot.x >= c.x && spot.x <= c.x + c.width && spot.y >= c.y && spot.y <= c.y + c.height, 'the spot is not on 닫기').toBe(false);
    // the same spot again: lands on the notice — no PUT, and the notice stays to be read
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(500);
    expect(putSections).toEqual([targetId]);
    await expect(notice).toBeVisible();
    await expect(target).toHaveText('안 읽음');
    // 닫기 (on purpose), then the same spot reaches the same section
    await page.getByTestId('rd-progress-error-close').click();
    await expect(notice).toHaveCount(0);
    await page.mouse.click(spot.x, spot.y);
    await expect.poll(() => putSections).toEqual([targetId, targetId]);
    await expect(target).toHaveText('훑음');
    await expect(notice).toHaveCount(0);
    expect(mockViolations(page)).toEqual([]);
  });

  /** Mocks of SEED_UPGRADE before / after the upgrade (real responses with the upgrade fields replaced). */
  async function mockUpgrade(page: Page, baseURL: string, outcome: 'done' | 'html_not_found') {
    const store = createMockStore({ upgraded: false, starts: 0 });
    const upgraded = () => store.get<boolean>('upgraded') === true;
    const jobId = '00000000-0000-4000-8000-0000000000c1';
    const ok = outcome === 'done';
    const job = { id: jobId, kind: 'upgrade_structure' as const, paperId: SEED_UPGRADE_PAPER_ID, status: ok ? ('done' as const) : ('failed' as const), steps: [{ step: 'html' as const, status: ok ? ('ok' as const) : ('error' as const) }], error: ok ? null : 'not_found: arXiv에 HTML이 없습니다 (HTTP 404)' };
    const after = ok ? { structureUpgradeAvailable: false, supplementVersion: 2, structureSource: 'latexml' as const } : { structureUpgradeAvailable: false };
    await mockRoute(page, 'papers.list', async () => {
      const real = await realJson<ListPapersResponse>(baseURL, 'papers.list');
      return { kind: 'json', body: { papers: real.papers.map((p) => (p.id !== SEED_UPGRADE_PAPER_ID ? p : upgraded() ? { ...p, ...after } : { ...p, structureUpgradeAvailable: true })) } };
    });
    await mockRoute(page, 'papers.get', async (req) => {
      const real = await realJson<PaperDetailDto>(baseURL, 'papers.get', { params: req.params });
      if (req.params.id !== SEED_UPGRADE_PAPER_ID) return { kind: 'json', body: real };
      if (!upgraded()) return { kind: 'json', body: { ...real, structureUpgradeAvailable: true, structureUpgrade: { available: true, reason: 'm1_paper', job: null } } };
      return { kind: 'json', body: { ...real, ...after, ingestWarnings: ok ? real.ingestWarnings : [...real.ingestWarnings, 'html_not_found: HTTP 404'], structureUpgrade: { available: false, reason: null, job } } };
    });
    await mockRoute(page, 'papers.upgradeStructure', () => {
      store.update<number>('starts', (n = 0) => n + 1);
      return { kind: 'json', body: { jobId } };
    });
    await mockRoute(page, 'jobs.events', () => {
      store.set('upgraded', true);
      return {
        kind: 'sse',
        events: ok
          ? [
              { event: 'job.step', data: { step: 'html', status: 'ok' } },
              { event: 'job.step', data: { step: 'structure', status: 'ok' } },
              { event: 'job.step', data: { step: 'anchor', status: 'ok' } },
              { event: 'job.step', data: { step: 'supplement', status: 'ok' } },
              { event: 'job.done', data: { paperId: SEED_UPGRADE_PAPER_ID } },
            ]
          : [
              { event: 'job.step', data: { step: 'html', status: 'error', detail: 'HTTP 404' } },
              { event: 'job.error', data: { code: 'not_found', message: 'arXiv에 HTML이 없습니다 (HTTP 404)' } },
            ],
      };
    });
    // After a successful upgrade the paper has the index the same synthetic-m2.html gives (the M2 seed's rows).
    await mockRoute(page, 'papers.structure', async (req) => {
      const id = req.params.id === SEED_UPGRADE_PAPER_ID && upgraded() && ok ? SEED_M2_PAPER_ID : req.params.id!;
      return { kind: 'json', body: await realJson<StructureResponse>(baseURL, 'papers.structure', { params: { id } }) };
    });
    return store;
  }

  test('structure upgrade (SEED_UPGRADE): reader "목차 없음" → Library button → confirmation → steps → done → the reader reads the structure again and shows the outline', async ({ page, baseURL }) => {
    const store = await mockUpgrade(page, baseURL!, 'done');
    await openPaper(page, SEED_UPGRADE_PAPER_ID, SEED_UPGRADE_TITLE);
    await expect(page.getByTestId('rd-outline-empty')).toContainText('목차 없음');
    await expect(page.getByTestId('rd-header-upgrade').getByTestId('rd-upgrade-button')).toBeVisible();
    await page.getByRole('link', { name: '← Library' }).click();

    const row = page.locator(`[data-testid="paper-row"][data-paper-id="${SEED_UPGRADE_PAPER_ID}"]`);
    await expect(row.getByTestId('rd-structure-badge')).toHaveText('구조 색인 만들 수 있음');
    await expect(page.locator(`[data-testid="paper-row"][data-paper-id="${SEED_M2_PAPER_ID}"]`).getByTestId('rd-structure-badge')).toHaveText('색인 v2');
    await expect(page.locator(`[data-testid="paper-row"][data-paper-id="${SEED_PAPER_ID}"]`).getByTestId('rd-structure-badge')).toHaveText('구조 없음');
    await row.getByTestId('rd-upgrade-button').click();
    await expect(row.getByTestId('rd-upgrade-confirm')).toContainText('arXiv에서 HTML을 한 번 받아 목차·수식·참고문헌 색인을 만듭니다.');
    expect(store.get('starts')).toBe(0);
    await row.getByTestId('rd-upgrade-confirm-yes').click();
    await expect(row.getByTestId('rd-upgrade-done')).toBeVisible();
    await expect(row.getByTestId('rd-upgrade-steps')).toContainText('구조: 완료');
    await expect(row.getByTestId('rd-structure-badge')).toHaveText('색인 v2');
    expect(store.get('starts')).toBe(1);

    await row.getByRole('link', { name: SEED_UPGRADE_TITLE }).click();
    await expect(page.getByTestId('rd-outline-tree')).toBeVisible();
    await expect(outlineItem(page, 'II-A')).toHaveCount(1);
    await expect(page.getByTestId('rd-outline-empty')).toHaveCount(0);
    expect(mockViolations(page)).toEqual([]);
  });

  test('structure upgrade failure (final, html_not_found): the reason is shown and the button is gone', async ({ page, baseURL }) => {
    await mockUpgrade(page, baseURL!, 'html_not_found');
    await page.goto('/');
    const row = page.locator(`[data-testid="paper-row"][data-paper-id="${SEED_UPGRADE_PAPER_ID}"]`);
    await row.getByTestId('rd-upgrade-button').click();
    await row.getByTestId('rd-upgrade-confirm-yes').click();
    const err = row.getByTestId('rd-upgrade-error');
    await expect(err).toHaveAttribute('data-kind', 'final');
    await expect(err).toContainText('arXiv에 이 논문의 HTML 버전이 없습니다');
    await expect(row.getByTestId('rd-structure-badge')).toHaveText('구조 없음');
    await expect(row.getByTestId('rd-upgrade-button')).toHaveCount(0);
    expect(mockViolations(page)).toEqual([]);
  });

  test('structure upgrade failure from the reader header: the reason stays after papers.get turns available off, no button', async ({ page, baseURL }) => {
    await mockUpgrade(page, baseURL!, 'html_not_found');
    await openPaper(page, SEED_UPGRADE_PAPER_ID, SEED_UPGRADE_TITLE);
    const header = page.getByTestId('rd-header-upgrade');
    await header.getByTestId('rd-upgrade-button').click();
    await header.getByTestId('rd-upgrade-confirm-yes').click();
    const err = header.getByTestId('rd-upgrade-error');
    await expect(err).toHaveAttribute('data-kind', 'final');
    await expect(err).toContainText('arXiv에 이 논문의 HTML 버전이 없습니다');
    await expect(page.getByTestId('rd-outline-empty').getByTestId('rd-upgrade-error')).toContainText('arXiv에 이 논문의 HTML 버전이 없습니다');
    await expect(page.getByTestId('rd-upgrade-button')).toHaveCount(0);
    expect(mockViolations(page)).toEqual([]);
  });
});
