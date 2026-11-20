// Screen actions shared by the M2 integration flows (e2e/skeleton.spec.ts) and the live E2E script
// (scripts/live-e2e.ts, BRIEF_INTEGRATION I9). Owner: supervisor.
// Rules (BRIEF_INTEGRATION I3) — this file is also compiled by `tsc -p scripts`, which has no DOM lib, and it runs
// against a live server that has no test hooks:
// - imports: types of @playwright/test and pure modules of packages/shared only — never the e2e network helpers,
//   Node network or process modules, or fetch;
// - no test hooks of the app (they exist only when the server runs with SP_E2E=1);
// - the DOM is reached through locator / mouse / keyboard APIs only (no DOM code sent to run inside the page);
// - every wait takes its timeout as an argument (short in e2e, runStreamTimeoutMs(task) for a live answer), and the
//   timeout bounds the whole function: every Playwright call in it gets the time that is left (none falls back to a
//   Playwright default — outside the test runner the action default is no timeout at all).
// Failures throw an Error with the reason (no `expect` here: the callers decide what they assert).
import type { Locator, Page, Request } from '@playwright/test';
import { API_PREFIX, ROUTE_BY_ID } from '../packages/shared/src/contracts/routes';

export interface Timeout {
  timeoutMs: number;
}

function checkTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`actions: timeoutMs must be a positive finite number, not ${timeoutMs}`);
  return timeoutMs;
}

/** The time left until `deadline` (at least 1 ms, so a Playwright call never gets 0 = "no timeout"). */
function left(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/** `.page[data-page-number=n]` of the PDF viewer. */
export function pdfPage(page: Page, pageNumber: number): Locator {
  return page.locator(`.page[data-page-number="${pageNumber}"]`);
}

/** Waits until pdf.js finished the text layer of a page (its endOfContent element is attached). */
export async function waitForPdf(page: Page, o: Timeout & { pageNumber?: number }): Promise<void> {
  await pdfPage(page, o.pageNumber ?? 1)
    .locator('.textLayer .endOfContent')
    .waitFor({ state: 'attached', timeout: checkTimeout(o.timeoutMs) });
}

/** Scrolls page `pageNumber` of the viewer into view and waits for its text layer (pdf.js renders pages lazily). */
export async function showPage(page: Page, o: Timeout & { pageNumber: number }): Promise<void> {
  const deadline = Date.now() + checkTimeout(o.timeoutMs);
  const el = pdfPage(page, o.pageNumber);
  await el.waitFor({ state: 'attached', timeout: left(deadline) });
  await el.scrollIntoViewIfNeeded({ timeout: left(deadline) });
  await waitForPdf(page, { pageNumber: o.pageNumber, timeoutMs: left(deadline) });
}

/** Opens /paper/<id> and waits for the title and the first page's text layer. */
export async function openPaper(page: Page, o: Timeout & { paperId: string; title: string }): Promise<void> {
  const timeout = checkTimeout(o.timeoutMs);
  const deadline = Date.now() + timeout;
  await page.goto(`/paper/${encodeURIComponent(o.paperId)}`, { timeout: left(deadline) });
  const title = page.getByTestId('paper-title').first();
  // the header shows a placeholder until papers.get answers: poll for the exact title
  for (let got = ''; ; await page.waitForTimeout(50)) {
    try {
      got = (await title.textContent({ timeout: Math.min(500, left(deadline)) })) ?? '';
    } catch {
      got = ''; // not attached yet (or replaced while being read): read again until the deadline
    }
    if (got === o.title) break;
    if (Date.now() >= deadline) throw new Error(`openPaper: the reader shows "${got}", not "${o.title}" after ${timeout} ms`);
  }
  await waitForPdf(page, { pageNumber: 1, timeoutMs: left(deadline) });
}

/**
 * Mouse selection inside one text-layer span (the first one on that page containing `text`): from 2 px after its left
 * edge to `fraction` of its width, like a user drag. Waits for the selection toolbar.
 */
export async function dragSelectText(page: Page, o: Timeout & { pageNumber: number; text: string; fraction?: number }): Promise<void> {
  const deadline = Date.now() + checkTimeout(o.timeoutMs);
  const span = pdfPage(page, o.pageNumber).locator('.textLayer span', { hasText: o.text }).first();
  await span.waitFor({ state: 'visible', timeout: left(deadline) });
  await span.scrollIntoViewIfNeeded({ timeout: left(deadline) });
  const box = await span.boundingBox({ timeout: left(deadline) });
  if (!box) throw new Error(`dragSelectText: span "${o.text}" on page ${o.pageNumber} has no box`);
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * (o.fraction ?? 0.6), box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.getByTestId('selection-toolbar').waitFor({ state: 'visible', timeout: left(deadline) });
}

/** Page box (viewport px) once it stayed the same over three reads 100 ms apart; gives up at `deadline`. */
async function settledBox(page: Page, pageNumber: number, deadline: number): Promise<{ x: number; y: number; width: number; height: number }> {
  const el = pdfPage(page, pageNumber);
  await el.waitFor({ state: 'visible', timeout: left(deadline) });
  let prev = await el.boundingBox({ timeout: left(deadline) });
  let same = 0;
  while (same < 2) {
    if (Date.now() >= deadline) throw new Error(`ctrlDragArea: page ${pageNumber} did not stop moving before its timeout`);
    await page.waitForTimeout(100);
    const cur = await el.boundingBox({ timeout: left(deadline) });
    same = cur && prev && JSON.stringify(cur) === JSON.stringify(prev) ? same + 1 : 0;
    prev = cur;
  }
  return prev!;
}

/**
 * Ctrl+drag over a page area given as fractions of the page box ([x, y] from → to) — the area capture gesture. Waits
 * for the capture menu. The page must be on screen (scroll it there first).
 */
export async function ctrlDragArea(page: Page, o: Timeout & { pageNumber: number; from: readonly [number, number]; to: readonly [number, number] }): Promise<void> {
  const deadline = Date.now() + checkTimeout(o.timeoutMs);
  const b = await settledBox(page, o.pageNumber, deadline);
  await page.keyboard.down('Control');
  try {
    await page.mouse.move(b.x + b.width * o.from[0], b.y + b.height * o.from[1]);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * o.to[0], b.y + b.height * o.to[1], { steps: 8 });
    await page.mouse.up();
  } finally {
    await page.keyboard.up('Control');
  }
  await page.getByTestId('rd-capture-menu').waitFor({ state: 'visible', timeout: left(deadline) });
}

export type CaptureChoice = 'figure' | 'equation' | 'highlight';
const CAPTURE_TESTID: Record<CaptureChoice, string> = { figure: 'rd-capture-figure', equation: 'rd-capture-equation', highlight: 'rd-capture-highlight' };

/** Picks an item of the open capture menu ("그림·표 설명" / "수식 설명" / "영역 하이라이트"); waits for the menu to close. */
export async function chooseCapture(page: Page, choice: CaptureChoice, o: Timeout): Promise<void> {
  const deadline = Date.now() + checkTimeout(o.timeoutMs);
  const item = page.getByTestId('rd-capture-menu').getByTestId(CAPTURE_TESTID[choice]);
  await item.click({ timeout: left(deadline) });
  await page.getByTestId('rd-capture-menu').waitFor({ state: 'detached', timeout: left(deadline) });
}

export type PanelTab = 'ai' | 'highlights' | 'cards' | 'equations' | 'references' | 'glossary';
const TAB_TESTID: Record<PanelTab, string> = {
  ai: 'panel-tab-ai',
  highlights: 'panel-tab-highlights',
  cards: 'pn-tab-cards',
  equations: 'pn-tab-equations',
  references: 'pn-tab-references',
  glossary: 'pn-tab-glossary',
};

/** The side panel's tab button. */
export function panelTab(page: Page, tab: PanelTab): Locator {
  return page.getByTestId(TAB_TESTID[tab]);
}

/** Clicks a side panel tab and waits until it is the selected one. */
export async function openPanelTab(page: Page, tab: PanelTab, o: Timeout): Promise<void> {
  const deadline = Date.now() + checkTimeout(o.timeoutMs);
  const button = panelTab(page, tab);
  await button.click({ timeout: left(deadline) });
  await page.locator(`[data-testid="${TAB_TESTID[tab]}"][aria-selected="true"]`).waitFor({ state: 'attached', timeout: left(deadline) });
}

export type AnswerTerminal = 'done' | 'error';

/** The POST routes whose response is the stream of one panel answer (the live message): threads.create, messages.create. */
const ANSWER_START_PATHS = (['threads.create', 'messages.create'] as const).map((id) => new RegExp(`^${API_PREFIX}${ROUTE_BY_ID[id].path.replace(/:[A-Za-z]+/g, '[^/]+')}$`));

function isAnswerStart(r: Request): boolean {
  return r.method() === 'POST' && ANSWER_START_PATHS.some((re) => re.test(new URL(r.url()).pathname));
}

/**
 * Runs `start` — the gesture that begins ONE panel answer (selectAndPress, chooseCapture, askInPanel, a click on
 * "다시 생성" …) — and waits for THAT answer to reach a terminal phase: run.done → 'done'; run.error, an HTTP error or
 * a cut stream → 'error'. An earlier answer still shown as done in the panel is never taken for this one:
 * 1. this answer must start: a threads.create / messages.create POST sent after `start` was called (none before the
 *    deadline → throw, e.g. when the action reopened an existing thread instead of asking);
 * 2. that request must end — requestfinished (the server wrote the terminal event and closed the stream) or
 *    requestfailed (a cut stream) — so the caller never closes the page before the terminal event;
 * 3. then the live message must show a terminal phase. The client switches the live message to "starting" before it
 *    sends the request, so after 1–2 the panel no longer shows the earlier answer's phase.
 * `timeoutMs` covers the whole answer: in a live run pass runStreamTimeoutMs(task).
 */
export async function waitForAnswerTerminal(page: Page, o: Timeout & { start: () => Promise<unknown> }): Promise<AnswerTerminal> {
  const timeout = checkTimeout(o.timeoutMs);
  const deadline = Date.now() + timeout;
  const sent = new Set<Request>();
  let settle: (outcome: 'finished' | 'failed' | 'closed') => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = new Promise<'finished' | 'failed' | 'closed' | 'timeout'>((resolve) => {
    settle = resolve;
    timer = setTimeout(() => resolve('timeout'), timeout);
  });
  const onRequest = (r: Request) => {
    if (isAnswerStart(r)) sent.add(r);
  };
  const onFinished = (r: Request) => {
    if (sent.has(r)) settle('finished');
  };
  const onFailed = (r: Request) => {
    if (sent.has(r)) settle('failed');
  };
  const onClose = () => settle('closed');
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  page.on('close', onClose);
  let outcome: 'finished' | 'failed' | 'closed' | 'timeout';
  try {
    await o.start();
    outcome = await ended;
  } finally {
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
    page.off('close', onClose);
    clearTimeout(timer); // a live script must not keep a runStreamTimeoutMs timer alive after the answer
    settle('closed'); // settles the promise when start threw (no later listener can)
  }
  if (outcome === 'timeout') {
    throw new Error(
      sent.size === 0
        ? `waitForAnswerTerminal: no threads.create / messages.create request within ${timeout} ms — the action did not start an answer`
        : `waitForAnswerTerminal: the answer stream did not end within ${timeout} ms`,
    );
  }
  if (outcome === 'closed') throw new Error('waitForAnswerTerminal: the page closed before the answer ended');
  const terminal = page.locator('[data-testid="live-message"][data-phase="done"], [data-testid="live-message"][data-phase="error"]').first();
  await terminal.waitFor({ state: 'attached', timeout: left(deadline) });
  const phase = await terminal.getAttribute('data-phase', { timeout: left(deadline) });
  if (phase !== 'done' && phase !== 'error') throw new Error(`waitForAnswerTerminal: unexpected phase ${phase}`);
  return phase;
}

/** Selects text and starts an action with its one-letter shortcut (e explain · t translate · a ask · n note · h highlight). */
export async function selectAndPress(page: Page, o: Timeout & { pageNumber: number; text: string; fraction?: number; key: 'e' | 't' | 'a' | 'n' | 'h' }): Promise<void> {
  await dragSelectText(page, o);
  await page.keyboard.press(o.key);
}

/** Types a question into the panel input and sends it (optionally with "깊게" switched on first). */
export async function askInPanel(page: Page, o: Timeout & { question: string; deep?: boolean }): Promise<void> {
  const deadline = Date.now() + checkTimeout(o.timeoutMs);
  if (o.deep) {
    const toggle = page.getByTestId('pn-deep-toggle');
    if ((await toggle.getAttribute('aria-pressed', { timeout: left(deadline) })) !== 'true') await toggle.click({ timeout: left(deadline) });
    if ((await toggle.getAttribute('aria-pressed', { timeout: left(deadline) })) !== 'true') throw new Error('askInPanel: the "깊게" toggle did not switch on');
  }
  await page.getByTestId('followup-input').fill(o.question, { timeout: left(deadline) });
  await page.getByTestId('followup-send').click({ timeout: left(deadline) });
}
