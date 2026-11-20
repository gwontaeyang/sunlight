// Panels (builder D, M1 + M2): explain → "생성 중 · 인용 확인 전" → final chips/badges, follow-up question, cancel,
// restore after reload, highlights tab, panel width/hide. Runs in the prod and dev projects with SP_LLM=mock.
//
// Routes that are still 501 on this branch (threads.list/get, messages.create, llm.runs.cancel, highlights.*) are
// mocked with page.route; request bodies are checked with the contracts/api.ts schemas. Streams whose timing the
// test must control (to see the streaming state or to cancel while queued) go through a small in-page fetch shim
// that hands out a ReadableStream the test feeds with formatSseEvent() text. One test uses the real server
// (threads.create with the mock LLM) end to end.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { CreateThreadRequest, PostMessageRequest, type CardItemDto, type GlossaryTermDto, type HighlightDto, type ListThreadsResponse, type MessageDto, type PaperCardDto, type RunDto, type ThreadDetailResponse, type ThreadDto } from '../packages/shared/src/contracts/api';
import { NOTATION_TITLES_KO, type Citation, type MessageStats, type NotationKey } from '../packages/shared/src/contracts/domain';
import { formatSseEvent, type SseEvent } from '../packages/shared/src/contracts/sse';
import { parseAnswer } from '../packages/shared/src/markup/parseAnswer';
import { createMockStore, makeTestPng, makeTestPngBase64, mockRoute, mockViolations, realJson, resetSeedState, SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID, SEED_M2_TITLE, SEED_PAPER_ID, SEED_TITLE, type MockStore } from './helpers';

const QUOTE = 'We estimate the robot pose by minimizing the point-to-point residual between consecutive scans.';
const NOTICE = "'원문에서 찾음'은 그 문장이 논문에 있다는 뜻입니다. 주장을 뒷받침하는지는 직접 읽고 판단하세요.";
const STATS: MessageStats = {
  blocks: { p: 2, pEquationOnly: 0, pUnverified: 1, n: 0, g: 1, unlabeled: 0 },
  quotes: { verbatim: 1, fuzzy: 0, ambiguous: 0, notFound: 1 },
  eqRefs: { resolved: 0, noAnchor: 0, ambiguous: 0, notFound: 0, unindexed: 0 },
};
const ANSWER = `요지 <q>${QUOTE}</q> [[P]]\n\n없는 문장 <q>The method requires a GPU with 24 GB of memory.</q> [[P]]\n\n일반론 $e = p - q$ [[G]]`;
const CITATIONS: Citation[] = [
  { ordinal: 1, kind: 'quote', quote: QUOTE, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 40 } },
  { ordinal: 2, kind: 'quote', quote: 'The method requires a GPU with 24 GB of memory.', status: 'not_found', score: 0 },
];
const USAGE = { inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, outputTokens: null, thinkingTokens: null, costUsdApiEquivEst: null, durationMs: null, durationApiMs: null };

const sse = {
  accepted: (runId: string, threadId: string, messageId: string, task: 'explain_selection' | 'chat' = 'explain_selection'): SseEvent => ({ event: 'run.accepted', data: { runId, task, threadId, messageId } }),
  queued: (position: number): SseEvent => ({ event: 'run.queued', data: { position } }),
  started: (): SseEvent => ({ event: 'run.started', data: { model: 'opus', modelResolved: 'mock', effort: 'low', cliVersion: 'mock' } }),
  delta: (text: string): SseEvent => ({ event: 'run.delta', data: { text } }),
  done: (text: string, citations: Citation[], stats: MessageStats | null): SseEvent => ({ event: 'run.done', data: { text, parsed: parseAnswer(text), citations, stats, usage: USAGE } }),
  cancelled: (partialText: string): SseEvent => ({ event: 'run.error', data: { code: 'cancelled', message: 'cancelled', retryable: false, partialText } }),
};
const text = (...events: SseEvent[]) => events.map(formatSseEvent).join('');

// ------------------------------------------------------------------------------------------------
// In-page fetch shim: requests matching a registered (method, path regex) get a held-open SSE stream.
declare global {
  interface Window {
    __spE2E?: {
      calls: { method: string; path: string; body: unknown }[];
      holds: { method: string; re: string }[];
      streams: { path: string; body: unknown; push: (t: string) => void; close: () => void }[];
    };
  }
}

async function installShim(page: Page) {
  await page.addInitScript(() => {
    const state = { calls: [] as { method: string; path: string; body: unknown }[], holds: [] as { method: string; re: string }[], streams: [] as { path: string; body: unknown; push: (t: string) => void; close: () => void }[] };
    window.__spE2E = state;
    const orig = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init.method ?? 'GET').toUpperCase();
      const path = new URL(url, location.href).pathname;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
      state.calls.push({ method, path, body });
      if (!state.holds.some((h) => h.method === method && new RegExp(h.re).test(path))) return orig(input, init);
      const enc = new TextEncoder();
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
      init.signal?.addEventListener('abort', () => {
        try {
          ctrl.error(new DOMException('aborted', 'AbortError'));
        } catch {
          /* closed */
        }
      });
      state.streams.push({ path, body, push: (t) => ctrl.enqueue(enc.encode(t)), close: () => ctrl.close() });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
}

const hold = (page: Page, method: string, re: string) => page.evaluate(([m, r]) => window.__spE2E!.holds.push({ method: m!, re: r! }), [method, re]);
const streamCount = (page: Page) => page.evaluate(() => window.__spE2E!.streams.length);
const streamBody = (page: Page, i: number) => page.evaluate((k) => window.__spE2E!.streams[k]!.body, i);
const push = (page: Page, i: number, ...events: SseEvent[]) => page.evaluate(([k, t]) => window.__spE2E!.streams[k as number]!.push(t as string), [i, text(...events)] as const);
const close = (page: Page, i: number) => page.evaluate((k) => window.__spE2E!.streams[k]!.close(), i);

// ------------------------------------------------------------------------------------------------
// page.route mocks for the routes that are 501 on this branch.
const NOW = 1_700_000_000_000;
function threadDto(id: string, o: Partial<ThreadDto> = {}): ThreadDto {
  return { id, paperId: SEED_PAPER_ID, kind: 'explain', title: QUOTE.slice(0, 80), anchor: { kind: 'text', quote: { exact: QUOTE }, rects: [{ page: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.02 }] }, highlightId: null, equationId: null, sectionId: null, imageFileId: null, createdAt: NOW, updatedAt: NOW, ...o };
}
function messageDto(id: string, threadId: string, role: 'user' | 'assistant', contentMd: string, o: Partial<MessageDto> = {}): MessageDto {
  return { id, threadId, role, contentMd, status: 'complete', stats: null, issues: [], citations: [], llmCallId: null, effort: null, createdAt: NOW, ...o };
}
interface Store {
  threads: (ThreadDto & { lastStats: MessageStats | null; lastMessageStatus: MessageDto['status'] | null })[];
  messages: Record<string, MessageDto[]>;
  highlights: HighlightDto[];
}
const json = (route: Route, status: number, body?: unknown) => route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });

async function mockRoutes(page: Page, store: Store, opts: { cancel?: (runId: string) => void } = {}) {
  await page.route(`**/api/papers/${SEED_PAPER_ID}/threads`, (route) => (route.request().method() === 'GET' ? json(route, 200, { threads: store.threads }) : route.fallback()));
  await page.route('**/api/threads/*', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    const t = store.threads.find((x) => x.id === id);
    if (!t) return json(route, 200, { thread: threadDto(id), messages: [] }); // a thread created by the real server
    const { lastStats: _ignored, ...thread } = t;
    return json(route, 200, { thread, messages: store.messages[id] ?? [] });
  });
  await page.route('**/api/llm/runs/*/cancel', (route) => {
    opts.cancel?.(new URL(route.request().url()).pathname.split('/')[4]!);
    return route.fulfill({ status: 204, body: '' });
  });
  await page.route(`**/api/papers/${SEED_PAPER_ID}/highlights`, (route) => (route.request().method() === 'GET' ? json(route, 200, { highlights: store.highlights }) : route.fallback()));
  await page.route('**/api/highlights/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    const h = store.highlights.find((x) => x.id === id);
    if (!h) return json(route, 404, { error: { code: 'not_found', message: 'highlight' } });
    if (route.request().method() === 'PATCH') {
      Object.assign(h, route.request().postDataJSON() as Partial<HighlightDto>);
      return json(route, 200, h);
    }
    if (route.request().method() === 'DELETE') {
      store.highlights.splice(store.highlights.indexOf(h), 1);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fallback();
  });
}

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function openSeed(page: Page) {
  await page.goto(`/paper/${SEED_PAPER_ID}`);
  await expect(page.getByTestId('paper-title')).toHaveText(SEED_TITLE);
  await expect(page.getByTestId('side-panel')).toBeVisible();
}

/** Mouse-drag selection on page 1 (as the walking skeleton does) → the panel shows the selection. */
async function selectSentence(page: Page) {
  await page.waitForFunction(() => document.querySelectorAll('.page[data-page-number="1"] .textLayer span').length > 3, null, { timeout: 30_000 });
  const span = page.locator('.page[data-page-number="1"] .textLayer span', { hasText: 'We estimate the robot pose' }).first();
  const box = (await span.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('selection-text')).toContainText('We estimate');
}

const emptyStore = (): Store => ({ threads: [], messages: {}, highlights: [] });

test.describe('panels', () => {
  // Threads and highlights are real routes now: start every test from the seeded state.
  test.beforeEach(async ({ baseURL }) => {
    await resetSeedState(baseURL!);
  });

  test('explain with the real server (mock LLM): final chips and badges, the chip jumps in the viewer', async ({ page }) => {
    const errors = trackErrors(page);
    await mockRoutes(page, emptyStore());
    await openSeed(page);
    await selectSentence(page);
    await page.getByTestId('explain-button').click();
    const live = page.getByTestId('live-message');
    await expect(live).toHaveAttribute('data-phase', 'done', { timeout: 20_000 });
    await expect(page.getByTestId('run-events')).toContainText('run.accepted');
    await expect(page.getByTestId('run-events')).toContainText('run.done');
    await expect(live.getByTestId('sp-phase-note')).toHaveCount(0);
    await expect(live).toContainText('한 줄 요지');
    // Mock answer (explain_selection.md): 2 quotes found in the synthetic PDF; no chip stays "확인 전".
    await expect(live.locator('[data-testid="sp-chip"][data-status="verbatim"]')).toHaveCount(2);
    await expect(live.locator('[data-testid="sp-chip"][data-status="pending"]')).toHaveCount(0);
    await expect(live.locator('[data-testid="sp-badge"][data-status="p-grounded"]').first()).toHaveText('논문 근거 · 인용 원문에서 찾음');
    await expect(live.locator('[data-testid="sp-badge"][data-status="p-unverified"]')).toHaveText(['근거 미확인']); // the first [[P]] block has no quote
    // Integrated app: the viewer's navigator is registered, so the chip jumps and flashes the quoted text.
    await live.locator('[data-testid="sp-chip"][data-status="verbatim"]').first().click();
    await expect(page.getByTestId('citation-flash')).toHaveCount(1);
    await expect(live.getByTestId('sp-not-located')).toHaveCount(0);
    await expect(page.getByTestId('grounding-notice')).toHaveText(NOTICE);
    await expect(page.getByText('검증됨')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('streaming state → final, then a follow-up question (messages.create mocked as SSE)', async ({ page }) => {
    const errors = trackErrors(page);
    await installShim(page);
    const store = emptyStore();
    await mockRoutes(page, store);
    await openSeed(page);
    await hold(page, 'POST', `^/api/papers/${SEED_PAPER_ID}/threads$`);
    await hold(page, 'POST', '^/api/threads/[^/]+/messages$');
    await selectSentence(page);
    await page.getByTestId('explain-button').click();
    await expect.poll(() => streamCount(page)).toBe(1);
    const body = CreateThreadRequest.parse(await streamBody(page, 0));
    expect(body.kind).toBe('explain');
    expect(body.anchor?.quote?.exact).toContain('We estimate');

    // The server stores the thread; threads.get returns the user message and the assistant placeholder.
    store.threads.push({ ...threadDto('t-e2e', { anchor: body.anchor ?? null, title: body.text ?? 'x' }), lastStats: null, lastMessageStatus: 'streaming' });
    store.messages['t-e2e'] = [messageDto('u-1', 't-e2e', 'user', body.text ?? ''), messageDto('a-1', 't-e2e', 'assistant', '', { status: 'streaming' })];
    await push(page, 0, sse.accepted('run-1', 't-e2e', 'a-1'), sse.started(), sse.delta(ANSWER.slice(0, 150)));
    const live = page.getByTestId('live-message');
    await expect(live.getByTestId('sp-phase-note')).toHaveText('생성 중 · 인용 확인 전');
    await expect(live.locator('[data-testid="sp-chip"]').first()).toHaveAttribute('data-status', 'pending');
    await expect(live.locator('[data-testid="sp-badge"]').first()).toHaveAttribute('data-status', 'pending');
    await expect(page.getByTestId('run-cancel')).toBeVisible();

    store.messages['t-e2e'] = [messageDto('u-1', 't-e2e', 'user', body.text ?? ''), messageDto('a-1', 't-e2e', 'assistant', ANSWER, { citations: CITATIONS, stats: STATS })];
    store.threads[0]!.lastStats = STATS;
    store.threads[0]!.lastMessageStatus = 'complete';
    await push(page, 0, sse.delta(ANSWER.slice(150)), sse.done(ANSWER, CITATIONS, STATS));
    await close(page, 0);
    await expect(live.getByTestId('sp-phase-note')).toHaveCount(0);
    await expect(live.locator('[data-testid="sp-chip"]')).toHaveCount(2);
    await expect(live.locator('[data-testid="sp-chip"]').nth(0)).toHaveAttribute('data-status', 'verbatim');
    await expect(live.locator('[data-testid="sp-chip"]').nth(1)).toHaveAttribute('data-status', 'not_found');
    await expect(live.locator('[data-testid="sp-badge"]')).toHaveText(['논문 근거 · 인용 원문에서 찾음', '근거 미확인', '일반 지식']);
    await expect(live.locator('.katex')).toHaveCount(1);
    await expect(page.getByTestId('thread-stats')).toHaveText('P 2 · 근거 미확인 1 · 찾지 못함 1');

    // Follow-up question in the same thread.
    await page.getByTestId('followup-input').fill('왜 point-to-point residual을 쓰나요?');
    await page.getByTestId('followup-send').click();
    await expect.poll(() => streamCount(page)).toBe(2);
    const follow = PostMessageRequest.parse(await streamBody(page, 1));
    expect(follow.text).toBe('왜 point-to-point residual을 쓰나요?');
    expect(follow.clientRequestId).not.toBe(body.clientRequestId);
    expect(await page.evaluate(() => window.__spE2E!.streams[1]!.path)).toBe('/api/threads/t-e2e/messages');
    store.messages['t-e2e'].push(messageDto('u-2', 't-e2e', 'user', follow.text), messageDto('a-2', 't-e2e', 'assistant', '', { status: 'streaming' }));
    await push(page, 1, sse.accepted('run-2', 't-e2e', 'a-2', 'chat'), sse.started(), sse.delta('후속 답 <q>'));
    await expect(page.getByTestId('live-message').getByTestId('sp-phase-note')).toHaveText('생성 중 · 인용 확인 전');
    await expect(page.getByTestId('message-user').last()).toHaveText(/왜 point-to-point residual을 쓰나요\?/);
    await expect(page.getByTestId('message-assistant')).toHaveCount(1); // the first answer, now from threads.get
    const follow2 = `후속 답 <q>${QUOTE}</q> [[P]]`;
    await push(page, 1, sse.delta(follow2.slice('후속 답 <q>'.length)), sse.done(follow2, [CITATIONS[0]!], STATS));
    await close(page, 1);
    await expect(page.getByTestId('live-message').locator('[data-testid="sp-badge"]')).toHaveText(['논문 근거 · 인용 원문에서 찾음']);
    await expect(page.getByTestId('followup-input')).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('cancel while queued (llm.runs.cancel) keeps the partial text as "확인 안 됨"', async ({ page }) => {
    const errors = trackErrors(page);
    await installShim(page);
    const cancelled: string[] = [];
    await mockRoutes(page, emptyStore(), { cancel: (id) => cancelled.push(id) });
    await openSeed(page);
    await hold(page, 'POST', `^/api/papers/${SEED_PAPER_ID}/threads$`);
    await page.getByTestId('followup-input').fill('이 논문의 기여는 무엇인가요?');
    await page.getByTestId('followup-send').click();
    await expect.poll(() => streamCount(page)).toBe(1);
    expect(CreateThreadRequest.parse(await streamBody(page, 0))).toMatchObject({ kind: 'chat', question: '이 논문의 기여는 무엇인가요?' });
    await push(page, 0, sse.accepted('run-q', 't-q', 'a-q', 'chat'), sse.queued(2));
    await expect(page.getByTestId('run-status')).toHaveText('대기 중 · 순번 2');
    await expect(page.getByTestId('followup-input')).toBeDisabled();
    await page.getByTestId('run-cancel').click();
    await expect.poll(() => cancelled).toEqual(['run-q']);
    await push(page, 0, sse.cancelled('일부 <q>We estimate</q>'));
    await close(page, 0);
    const live = page.getByTestId('live-message');
    await expect(page.getByTestId('run-error')).toHaveAttribute('data-code', 'cancelled');
    await expect(page.getByTestId('run-error')).toContainText('취소했습니다');
    await expect(live).toContainText('일부');
    await expect(live.getByTestId('sp-chip')).toHaveAttribute('data-status', 'unchecked');
    await expect(page.getByTestId('run-cancel')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('slow response (page.route delay): cancel before run.accepted closes the connection', async ({ page }) => {
    const errors = trackErrors(page);
    await mockRoutes(page, emptyStore());
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    await page.route(`**/api/papers/${SEED_PAPER_ID}/threads`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      expect(CreateThreadRequest.safeParse(route.request().postDataJSON()).success).toBe(true);
      await released;
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: text(sse.accepted('late', 't-late', 'a-late', 'chat'), sse.done('늦은 답', [], null)) }).catch(() => {});
    });
    await openSeed(page);
    await page.getByTestId('followup-input').fill('느린 질문');
    await page.getByTestId('followup-send').click();
    await expect(page.getByTestId('run-status')).toHaveText('요청을 보내는 중…');
    await page.getByTestId('run-cancel').click();
    await expect(page.getByTestId('run-error')).toHaveAttribute('data-code', 'aborted');
    await expect(page.getByTestId('run-error')).toContainText('연결을 닫았습니다');
    release();
    await page.waitForTimeout(300);
    await expect(page.getByText('늦은 답')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('after reload: thread list, messages and citation states come back from threads.get', async ({ page }) => {
    const errors = trackErrors(page);
    const store = emptyStore();
    store.threads.push({ ...threadDto('t-r'), lastStats: STATS, lastMessageStatus: 'interrupted' });
    store.messages['t-r'] = [messageDto('u-r', 't-r', 'user', QUOTE), messageDto('a-r', 't-r', 'assistant', ANSWER, { citations: CITATIONS, stats: STATS }), messageDto('u-r2', 't-r', 'user', '중단된 질문'), messageDto('a-r2', 't-r', 'assistant', '중단 전 <q>x y z</q>', { status: 'interrupted' })];
    await mockRoutes(page, store);
    await openSeed(page);
    await page.reload();
    await expect(page.getByTestId('side-panel')).toBeVisible();
    await expect(page.getByTestId('thread-item')).toHaveCount(1);
    await expect(page.getByTestId('thread-stats')).toHaveText('P 2 · 근거 미확인 1 · 찾지 못함 1');
    await page.getByTestId('thread-item').click();
    const answers = page.getByTestId('message-assistant');
    await expect(answers).toHaveCount(2);
    await expect(answers.nth(0).locator('[data-testid="sp-chip"]')).toHaveCount(2);
    await expect(answers.nth(0).locator('[data-testid="sp-chip"]').nth(0)).toHaveAttribute('data-status', 'verbatim');
    await expect(answers.nth(0).locator('[data-testid="sp-chip"]').nth(1)).toHaveAttribute('data-status', 'not_found');
    await expect(answers.nth(0).getByTestId('sp-stats')).toContainText('찾지 못함 1');
    await expect(answers.nth(1)).toContainText('서버가 다시 시작되어 중단된 답변입니다');
    await expect(answers.nth(1).getByTestId('sp-chip')).toHaveAttribute('data-status', 'unchecked');
    await expect(page.getByTestId('regenerate')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('highlights tab: list, colour filter, comment, delete, jump click', async ({ page }) => {
    const errors = trackErrors(page);
    const store = emptyStore();
    const base = { paperId: SEED_PAPER_ID, kind: 'text' as const, position: null, sectionId: null, imageFileId: null, createdAt: NOW, updatedAt: NOW };
    store.highlights.push(
      { ...base, id: 'h-1', color: 1, page: 1, quote: { exact: 'We estimate the robot pose' }, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.02 }], comment: '핵심' },
      { ...base, id: 'h-2', color: 3, page: 1, quote: { exact: 'robust kernel' }, rects: [{ page: 1, x: 0.1, y: 0.5, w: 0.2, h: 0.02 }], comment: null },
    );
    await mockRoutes(page, store);
    await openSeed(page);
    await page.getByTestId('panel-tab-highlights').click();
    const items = page.getByTestId('highlight-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('We estimate the robot pose');
    await expect(items.nth(0).getByTestId('highlight-comment')).toHaveText('핵심');
    await page.getByTestId('highlight-filter-3').click();
    await expect(items).toHaveCount(1);
    await page.getByTestId('highlight-filter-all').click();
    await expect(items).toHaveCount(2);

    await items.nth(1).getByTestId('highlight-comment-edit').click();
    await items.nth(1).getByTestId('highlight-comment-input').fill('다시 읽기');
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/api/highlights/h-2'));
    await items.nth(1).getByTestId('highlight-comment-save').click();
    expect((await patch).postDataJSON()).toEqual({ comment: '다시 읽기' });
    await expect(items.nth(1).getByTestId('highlight-comment')).toHaveText('다시 읽기');

    // Jump: the viewer navigator (C) is not on this branch, so only check that the click is handled cleanly.
    await items.nth(0).getByTestId('highlight-jump').click();

    await items.nth(0).getByTestId('pn-highlight-delete').click();
    const del = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().endsWith('/api/highlights/h-1'));
    await page.getByTestId('highlight-delete-confirm').click();
    await del;
    await expect(items).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('panel width can be dragged and the panel hidden / shown', async ({ page }) => {
    const errors = trackErrors(page);
    await mockRoutes(page, emptyStore());
    await openSeed(page);
    const panel = page.getByTestId('side-panel');
    const before = (await panel.boundingBox())!.width;
    const handle = (await page.getByTestId('panel-resize').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 120, handle.y + 200, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width - before)).toBe(120);

    const mainBefore = (await page.locator('main').boundingBox())!.width;
    await page.getByTestId('panel-hide').click();
    await expect(page.getByTestId('panel-show')).toBeVisible();
    await expect(page.getByTestId('ai-tab')).toBeHidden();
    expect((await page.locator('main').boundingBox())!.width).toBeGreaterThan(mainBefore + 200);
    await page.getByTestId('panel-show').click();
    await expect(page.getByTestId('ai-tab')).toBeVisible();
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width - before)).toBe(120);
    expect(errors).toEqual([]);
  });
});

// =================================================================================================================
// M2 (BRIEF_D): every test starts from an action or focus injected through the panel's store hook
// (window.__spPanelStore — exposed only with <meta name="sp-e2e">) and ends at the panel DOM. Routes whose M2
// behaviour other builders own are mocked with mockRoute (contract-checked) and createMockStore (survives reloads);
// threads.list / threads.get mix the real server's threads (realJson) with the mock ones.

declare global {
  interface Window {
    __spPanelStore?: { getState: () => Record<string, (...a: unknown[]) => unknown>; setState: (s: Record<string, unknown>) => void };
    __eqJumps?: string[];
    __copied?: string[];
  }
}

const M2_USAGE = USAGE;
const run = {
  accepted: (runId: string, task: 'translate_selection' | 'figure_area' | 'chat' | 'notation_card' | 'assumptions_card' | 'glossary_define', o: { threadId?: string; messageId?: string; artifactId?: string } = {}): SseEvent => ({ event: 'run.accepted', data: { runId, task, ...o } }),
  started: (effort: 'low' | 'high'): SseEvent => ({ event: 'run.started', data: { model: 'opus', modelResolved: 'mock', effort, cliVersion: 'mock' } }),
  delta: (text: string): SseEvent => ({ event: 'run.delta', data: { text } }),
  done: (text: string, parsed: unknown, citations: Citation[] = [], stats: MessageStats | null = null): SseEvent => ({ event: 'run.done', data: { text, parsed: parsed as never, citations, stats, usage: M2_USAGE } }),
};
const runDto = (runId: string, status: RunDto['status'], task: RunDto['task'] = 'assumptions_card'): RunDto => ({ runId, task, status, errorCode: null, paperId: SEED_M2_PAPER_ID, threadId: null, model: 'opus', modelResolved: 'mock', effort: 'high', acceptedAt: NOW, startedAt: NOW, finishedAt: status === 'running' ? null : NOW + 1 });
type ListThread = ListThreadsResponse['threads'][number];
const m2Thread = (id: string, o: Partial<ThreadDto> = {}): ListThread => ({ ...threadDto(id, { paperId: SEED_M2_PAPER_ID, ...o }), lastStats: null, lastMessageStatus: 'complete' });

/**
 * Card items of the shared notation mock output (or `raw`), with the citations a server would match (quotes verbatim,
 * equations resolved). Item bodies are parsed the way the server stores them: paperCards.prepareCard uses
 * parseAnswer(bodyMd, { labels: 'strip' }), as CardsTab draws notation items (review D-RP1-02).
 */
function notationItems(raw = readFileSync(join(import.meta.dirname, '../packages/shared/fixtures/mock-outputs/notation_card.md'), 'utf8')): CardItemDto[] {
  return [...raw.matchAll(/^<item key="([a-z_]+)" label="([PNG])">([\s\S]*?)<\/item>$/gm)].map((m, i) => ({
    id: `item-${i + 1}`,
    ordinal: i + 1,
    key: m[1]!,
    category: null,
    label: m[2] as 'P' | 'N' | 'G',
    title: NOTATION_TITLES_KO[m[1] as NotationKey],
    bodyMd: m[3]!,
    attrs: {},
    confirmed: false,
    userNote: null,
    citations: parseAnswer(m[3]!, { labels: 'strip' }).citations.map((c): Citation => (c.kind === 'quote' ? { ordinal: c.ordinal, kind: 'quote', quote: c.quote!, status: 'verbatim', score: 1, position: { page: 1, start: 0, end: 10 } } : { ordinal: c.ordinal, kind: 'equation', eqNumber: c.eqNumber!, status: 'resolved', score: 1, equationId: `eq-${c.eqNumber}`, latex: 'x', katexOk: true })),
  }));
}
const cardDto = (kind: PaperCardDto['kind'], o: Partial<PaperCardDto> = {}): PaperCardDto => ({ id: `card-${kind}`, kind, status: 'complete', rawOutput: null, errorCode: null, runId: `run-${kind}`, items: [], createdAt: NOW, ...o });

/**
 * Mocks for the panel routes of other builders, backed by `store` (keys: cards, glossary, notes, threads, msgs:<id>).
 * threads.list = the real list + the mock threads; threads.get = the mock thread when the store has it, else the real one.
 */
async function mockPanels(page: Page, baseURL: string, store: MockStore) {
  await mockRoute(page, 'cards.list', () => ({ kind: 'json', body: { cards: store.get<PaperCardDto[]>('cards') ?? [] } }));
  await mockRoute(page, 'cardItems.patch', (req) => {
    const cards = store.get<PaperCardDto[]>('cards') ?? [];
    let out: CardItemDto | undefined;
    for (const c of cards) for (const it of c.items) if (it.id === req.params.id) out = Object.assign(it, req.body as Partial<CardItemDto>);
    store.set('cards', cards);
    return out ? { kind: 'json', body: out } : { kind: 'error', status: 404, code: 'not_found' };
  });
  await mockRoute(page, 'glossary.list', () => ({ kind: 'json', body: { terms: store.get<GlossaryTermDto[]>('glossary') ?? [] } }));
  await mockRoute(page, 'glossary.create', (req) => {
    const b = req.body as { term: string; definitionKo?: string; llmCallId?: string; sourceMessageId?: string };
    const terms = store.get<GlossaryTermDto[]>('glossary') ?? [];
    if (terms.some((t) => t.term.toLowerCase() === b.term.toLowerCase())) return { kind: 'error', status: 409, code: 'conflict' };
    const t: GlossaryTermDto = { id: `g-${terms.length + 1}`, paperId: SEED_M2_PAPER_ID, term: b.term, definitionKo: b.definitionKo ?? null, origin: b.llmCallId ? 'llm' : 'manual', createdAt: NOW, citations: [] };
    store.set('glossary', [...terms, t]);
    store.update<unknown[]>('glossaryCreates', (p) => [...(p ?? []), b]);
    return { kind: 'json', body: t };
  });
  await mockRoute(page, 'notes.list', () => ({ kind: 'json', body: { notes: store.get('notes') ?? [] } }));
  await mockRoute(page, 'threads.list', async (req) => {
    const real = await realJson<ListThreadsResponse>(baseURL, 'threads.list', { params: req.params });
    return { kind: 'json', body: { threads: [...real.threads, ...(req.params.id === SEED_M2_PAPER_ID ? (store.get<ListThread[]>('threads') ?? []) : [])] } };
  });
  await mockRoute(page, 'threads.get', async (req) => {
    const t = (store.get<ListThread[]>('threads') ?? []).find((x) => x.id === req.params.id);
    if (!t) return { kind: 'json', body: await realJson<ThreadDetailResponse>(baseURL, 'threads.get', { params: req.params }) };
    const { lastStats: _s, lastMessageStatus: _m, ...thread } = t;
    return { kind: 'json', body: { thread, messages: store.get<MessageDto[]>(`msgs:${t.id}`) ?? [] } };
  });
}

async function openM2(page: Page) {
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void window.__copied!.push(t) } });
  });
  await page.goto(`/paper/${SEED_M2_PAPER_ID}`);
  await expect(page.getByTestId('paper-title')).toHaveText(SEED_M2_TITLE);
  await expect(page.getByTestId('side-panel')).toBeVisible();
  await page.waitForFunction(() => window.__spPanelStore !== undefined);
}
const inject = (page: Page, method: 'requestAction' | 'focusPanel', arg: unknown) => page.evaluate(([m, a]) => void window.__spPanelStore!.getState()[m as string]!(a), [method, arg] as const);
const QUOTE_M2 = 'We estimate the robot pose by minimizing the point-to-point residual between consecutive scans.';
const textAnchor = { kind: 'text', quote: { exact: QUOTE_M2 }, rects: [{ page: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.02 }] };

// No page: the e2e card fixture must store what the server stores (review D-RP1-02). In 'strip' mode a <q> inside an
// HTML comment is not a citation; the default 'badge' mode would count it and the fixture would pair differently.
test('notation card fixture: item citations are parsed with labels strip, like the server', () => {
  const items = notationItems('<item key="frame_notation" label="P">A <!-- <q>the robot is now here</q> --> and <q>it stays</q> [[P]]</item>\n');
  expect(items).toHaveLength(1);
  expect(items[0]!.citations.map((c) => c.quote)).toEqual(['it stays']);
});

test.describe('panels M2', () => {
  test.beforeEach(async ({ baseURL }) => {
    await resetSeedState(baseURL!, [SEED_M2_PAPER_ID, SEED_LINKS_PAPER_ID]);
  });

  test('notation card: generate → 11 items with badges → "확인함" ×2 survives a reload; 409 card_generating → "생성 중" → polling', async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    const store = createMockStore({ cards: [] });
    await mockPanels(page, baseURL!, store);
    await mockRoute(page, 'cards.generate', (req) => {
      if (req.params.kind === 'assumptions') return { kind: 'error', status: 409, code: 'conflict', details: { reason: 'card_generating', runId: 'run-a', cardId: 'card-a' } };
      store.set('cards', [cardDto('notation', { items: notationItems() })]);
      return { kind: 'sse', events: [run.accepted('run-n', 'notation_card', { artifactId: 'card-notation' }), run.started('high'), run.delta('<item'), run.done('<item …>', { items: [], outsideText: '', issues: [] })] };
    });
    let polls = 0;
    await mockRoute(page, 'llm.runs.get', (req) => {
      polls++;
      if (polls >= 2) store.set('cards', [...(store.get<PaperCardDto[]>('cards') ?? []), cardDto('assumptions', { runId: 'run-a', items: [{ ...notationItems()[6]!, id: 'as-1', key: null, category: 'motion', title: '운동' }] })]);
      return { kind: 'json', body: runDto(req.params.runId!, polls >= 2 ? 'ok' : 'running') };
    });
    await openM2(page);
    await page.getByTestId('pn-tab-cards').click();
    const notation = page.locator('[data-testid="pn-card-section"][data-kind="notation"]');
    await notation.getByTestId('pn-card-generate').click();
    await expect(notation.getByTestId('pn-card-item')).toHaveCount(11);
    await expect(notation.locator('[data-testid="pn-item-badge"][data-badge="grounded_quote"]')).toHaveCount(4);
    await expect(notation.locator('[data-testid="pn-item-badge"][data-badge="equation_ref"]')).toHaveText(['식 참조 · 내용 대조 안 함']);
    await expect(notation.locator('[data-count="grounded_quote"]')).toHaveText('논문 근거 4');
    await notation.getByTestId('pn-card-confirm').nth(0).check();
    await notation.getByTestId('pn-card-confirm').nth(1).check();
    await expect(notation.locator('[data-count="confirmed"]')).toHaveText('확인함 2 / 11');
    await expect.poll(() => (store.get<PaperCardDto[]>('cards') ?? [])[0]!.items.filter((i) => i.confirmed).length).toBe(2);
    await page.reload();
    await page.getByTestId('pn-tab-cards').click();
    await expect(notation.locator('[data-count="confirmed"]')).toHaveText('확인함 2 / 11');
    await expect(notation.getByTestId('pn-card-confirm').nth(0)).toBeChecked();
    await expect(notation.getByTestId('pn-card-confirm').nth(1)).toBeChecked();

    const assumptions = page.locator('[data-testid="pn-card-section"][data-kind="assumptions"]');
    await assumptions.getByTestId('pn-card-generate').click();
    await expect(assumptions.getByTestId('pn-card-progress')).toContainText('생성 중');
    await expect(assumptions.getByTestId('pn-card-error')).toHaveCount(0);
    await expect(assumptions.getByTestId('pn-card-item')).toHaveCount(1, { timeout: 15_000 });
    await expect(assumptions.getByTestId('pn-card-progress')).toHaveCount(0);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(mockViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('glossary: an explain suggestion is stored only when pressed; "정의 요청" → suggestion → 저장', async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    const store = createMockStore({ glossary: [] });
    await mockPanels(page, baseURL!, store);
    await mockRoute(page, 'glossary.define', (req) => {
      const term = (req.body as { term: string }).term;
      const body = '이 논문에서 data association의 기준 거리다.';
      return { kind: 'sse', events: [run.accepted('run-g', 'glossary_define'), run.started('low'), run.done(`<term name="${term}">${body}</term>`, { items: [{ tag: 'term', attrs: { name: term }, body, children: [] }], outsideText: '', issues: [] })] };
    });
    await openM2(page);
    // explain through the real server (mock LLM): explain_selection.md has one <glossary> term
    await inject(page, 'requestAction', { kind: 'explain', anchor: textAnchor, text: QUOTE_M2 });
    await expect(page.getByTestId('live-message')).toHaveAttribute('data-phase', 'done', { timeout: 20_000 });
    await page.getByTestId('pn-tab-glossary').click();
    await expect(page.getByText('용어집이 비어 있습니다')).toBeVisible();
    await page.getByTestId('panel-tab-ai').click();
    await page.getByTestId('pn-glossary-suggest').click();
    await expect(page.getByTestId('pn-glossary-suggest-state')).toHaveText('용어집에 저장함');
    const created = store.get<{ term: string; sourceMessageId?: string; llmCallId?: string }[]>('glossaryCreates')!;
    expect(created[0]).toMatchObject({ term: 'robust kernel' });
    expect(created[0]!.sourceMessageId).toBeTruthy();
    expect(created[0]!.llmCallId).toBeTruthy();
    await page.getByTestId('pn-tab-glossary').click();
    await expect(page.getByTestId('pn-glossary-item')).toHaveCount(1);
    await expect(page.getByTestId('pn-glossary-origin')).toHaveText('AI 제안');

    await page.getByTestId('pn-glossary-define-term').fill('fixed threshold');
    await page.getByTestId('pn-glossary-define-start').click();
    await expect(page.getByTestId('pn-glossary-suggestion')).toContainText('data association의 기준 거리다');
    await expect(page.getByTestId('pn-glossary-item')).toHaveCount(1); // not stored yet
    await page.getByTestId('pn-glossary-suggestion-save').click();
    await expect(page.getByTestId('pn-glossary-item')).toHaveCount(2);
    expect(store.get<{ llmCallId?: string }[]>('glossaryCreates')![1]).toMatchObject({ term: 'fixed threshold', llmCallId: 'run-g' });
    expect(mockViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('equations tab: a click calls readerStore.jumpToEquation; "LaTeX 복사" copies the stored LaTeX', async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    await mockPanels(page, baseURL!, createMockStore());
    await openM2(page);
    await page.evaluate(() => {
      window.__eqJumps = [];
      window.__spPanelStore!.setState({ jumpToEquation: async (id: string) => (window.__eqJumps!.push(id), 'located') });
    });
    await page.getByTestId('pn-tab-equations').click();
    const items = page.getByTestId('pn-eq-list').getByTestId('pn-eq-item');
    await expect(items).toHaveCount(6);
    await expect(page.getByTestId('pn-eq-unnumbered').locator('summary')).toHaveText('번호 없는 식 1개');
    const first = items.nth(0);
    const id = await first.getAttribute('data-equation-id');
    await first.getByTestId('pn-eq-jump').click();
    await expect.poll(() => page.evaluate(() => window.__eqJumps)).toEqual([id]);
    await expect(first.locator('.katex')).toHaveCount(1);
    await first.getByTestId('pn-eq-copy').click();
    await expect.poll(() => page.evaluate(() => window.__copied)).toEqual(['r_{i}=R\\,p_{i}+t-q_{i}']);
    await expect(items.nth(3).getByTestId('pn-latex-code')).toHaveText('\\undefinedmacro{x}+\\undefinedmacrotwo{y}'); // katexOk=false
    expect(mockViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('references: focusPanel({tab:"references", referenceOrdinal:1}) switches the tab and highlights [1]', async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    await mockPanels(page, baseURL!, createMockStore());
    await openM2(page);
    await inject(page, 'focusPanel', { tab: 'references', referenceOrdinal: 1 });
    await expect(page.getByTestId('pn-tab-references')).toHaveAttribute('aria-selected', 'true');
    const ref1 = page.locator('[data-testid="pn-ref-item"][data-ordinal="1"]');
    await expect(ref1).toHaveAttribute('data-focused', '1');
    await expect(page.locator('[data-testid="pn-ref-item"][data-focused="1"]')).toHaveCount(1);
    expect(await page.evaluate(() => (window.__spPanelStore!.getState() as unknown as { panelFocus: unknown }).panelFocus)).toBeNull();
    await expect(ref1.getByTestId('pn-ref-import')).toHaveCount(0); // no id
    await expect(page.locator('[data-testid="pn-ref-item"][data-ordinal="2"]').getByTestId('pn-ref-in-library')).toBeVisible();
    await expect(page.locator('[data-testid="pn-ref-item"][data-ordinal="3"]').getByTestId('pn-ref-import')).toBeVisible();
    expect(mockViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('"깊게" question: body deep:true, the answer shows "깊게", the toggle is off for the next question', async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    const store = createMockStore({ threads: [] });
    await mockPanels(page, baseURL!, store);
    const bodies: unknown[] = [];
    await mockRoute(page, 'threads.create', (req) => {
      bodies.push(req.body);
      const answer = '깊게 생각한 답 [[G]]';
      store.set('threads', [m2Thread('t-deep', { kind: 'chat', title: '왜 point-to-point인가요?', anchor: null })]);
      store.set('msgs:t-deep', [messageDto('u-deep', 't-deep', 'user', '왜 point-to-point인가요?'), messageDto('a-deep', 't-deep', 'assistant', answer, { effort: 'high', llmCallId: 'run-deep' })]);
      return { kind: 'sse', events: [run.accepted('run-deep', 'chat', { threadId: 't-deep', messageId: 'a-deep' }), run.started('high'), run.delta(answer), run.done(answer, parseAnswer(answer))] };
    });
    await mockRoute(page, 'messages.create', (req) => {
      bodies.push(req.body);
      return { kind: 'sse', events: [run.accepted('run-next', 'chat', { threadId: 't-deep', messageId: 'a-next' }), run.started('low'), run.done('다음 답 [[G]]', parseAnswer('다음 답 [[G]]'))] };
    });
    await openM2(page);
    const toggle = page.getByTestId('pn-deep-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('followup-input').fill('왜 point-to-point인가요?');
    await page.getByTestId('followup-send').click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({ kind: 'chat', question: '왜 point-to-point인가요?', deep: true });
    await expect(page.getByTestId('live-message')).toHaveAttribute('data-phase', 'done');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // the stored answer (threads.get: effort 'high') shows "깊게" after a reload
    await page.reload();
    await page.locator('[data-testid="thread-item"][data-thread-id="t-deep"]').click();
    await expect(page.getByTestId('message-assistant').getByTestId('pn-deep-label')).toHaveText('깊게');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('followup-input').fill('다음 질문');
    await page.getByTestId('followup-send').click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toMatchObject({ text: '다음 질문' });
    expect((bodies[1] as Record<string, unknown>).deep).toBeUndefined();
    expect(mockViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('translate → plain (no chip); a figure capture → the thread shows the image', async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    const store = createMockStore({ threads: [] });
    await mockPanels(page, baseURL!, store);
    const png = makeTestPng({ width: 60, height: 40 });
    const pngB64 = makeTestPngBase64({ width: 60, height: 40 });
    const area = { kind: 'area', rects: [{ page: 1, x: 0.2, y: 0.3, w: 0.4, h: 0.2 }] };
    await mockRoute(page, 'threads.create', (req) => {
      const b = req.body as { kind: string; imagePng?: string };
      if (b.kind === 'translate') {
        const t = '번역: <q>원문 태그</q> [[P]] 연속한 scan 사이의 잔차를 최소화한다.';
        store.set('threads', [m2Thread('t-tr', { kind: 'translate', title: QUOTE_M2.slice(0, 80), anchor: textAnchor as ThreadDto['anchor'] })]);
        store.set('msgs:t-tr', [messageDto('u-tr', 't-tr', 'user', QUOTE_M2), messageDto('a-tr', 't-tr', 'assistant', t)]);
        return { kind: 'sse', events: [run.accepted('run-t', 'translate_selection', { threadId: 't-tr', messageId: 'a-tr' }), run.started('low'), run.delta(t), run.done(t, null)] };
      }
      expect(b).toMatchObject({ kind: 'figure', imagePng: pngB64, anchor: area });
      store.set('threads', [...(store.get<ListThread[]>('threads') ?? []), m2Thread('t-fig', { kind: 'figure', title: '그림', anchor: area as ThreadDto['anchor'], imageFileId: 'cap-1' })]);
      store.set('msgs:t-fig', [messageDto('u-fig', 't-fig', 'user', '그림 설명'), messageDto('a-fig', 't-fig', 'assistant', '그림 답 [[G]]')]);
      return { kind: 'sse', events: [run.accepted('run-f', 'figure_area', { threadId: 't-fig', messageId: 'a-fig' }), run.started('high'), run.done('그림 답 [[G]]', parseAnswer('그림 답 [[G]]'))] };
    });
    await mockRoute(page, 'papers.capture', (req) => (req.params.fileId === 'cap-1' ? { kind: 'png', body: png } : { kind: 'error', status: 404, code: 'not_found' }));
    await openM2(page);
    await inject(page, 'requestAction', { kind: 'translate', anchor: textAnchor, text: QUOTE_M2 });
    const live = page.getByTestId('live-message');
    await expect(live).toHaveAttribute('data-phase', 'done');
    await expect(live).toContainText('<q>원문 태그</q> [[P]]');
    await expect(live.getByTestId('sp-chip')).toHaveCount(0);
    await expect(live.getByTestId('sp-badge')).toHaveCount(0);
    await expect(page.getByTestId('followup-input')).toHaveCount(0); // a translation has no follow-up input
    await expect(page.getByTestId('regenerate')).toBeVisible();

    await inject(page, 'requestAction', { kind: 'figure', anchor: area, imagePng: pngB64, capture: { widthPx: 60, heightPx: 40 } });
    const img = page.getByTestId('pn-thread-image');
    await expect(img).toBeVisible();
    expect(await img.getAttribute('src')).toMatch(/^blob:/);
    expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(60);
    expect(mockViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('parse_failed card: the raw output as text + "다시 생성"', async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    const raw = '<item key="frame_notation" label="P"><img src=x onerror="alert(1)"> 닫히지 않은 항목';
    await mockPanels(page, baseURL!, createMockStore({ cards: [cardDto('notation', { status: 'parse_failed', rawOutput: raw, errorCode: 'parse_failed' })] }));
    await openM2(page);
    await page.getByTestId('pn-tab-cards').click();
    const notation = page.locator('[data-testid="pn-card-section"][data-kind="notation"]');
    await expect(notation.getByTestId('pn-card-raw')).toHaveText(raw);
    await expect(notation.locator('img')).toHaveCount(0);
    await expect(notation.getByTestId('pn-card-regenerate')).toBeVisible();
    expect(mockViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('highlights·notes: 40 short notes + 1 long note stay inside the panel (one scroll area; header, notice and highlights stay in view)', async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    // Two real highlights (highlights.* is implemented on every branch); the notes come from the notes.list mock.
    for (const [i, exact] of ['We estimate the robot pose', 'consecutive scans'].entries()) {
      await realJson<HighlightDto>(baseURL!, 'highlights.create', { params: { id: SEED_M2_PAPER_ID }, body: { kind: 'text', color: 1, quote: { exact }, page: 1, rects: [{ page: 1, x: 0.1, y: 0.1 + 0.1 * i, w: 0.3, h: 0.02 }] } });
    }
    const note = (id: string, bodyMd: string, at: number) => ({ id, paperId: SEED_M2_PAPER_ID, highlightId: null, sectionId: null, bodyMd, createdAt: NOW + at, updatedAt: NOW + at });
    const notes = [note('n-long', `긴 노트 ${'가나다라 마바사 아자차 '.repeat(600)}`.slice(0, 7_200), 0), ...Array.from({ length: 40 }, (_, i) => note(`n-${i}`, `짧은 노트 ${i + 1}`, i + 1))];
    await mockPanels(page, baseURL!, createMockStore({ notes }));
    await openM2(page);
    await page.getByTestId('panel-tab-highlights').click();
    await expect(page.getByTestId('pn-note-item')).toHaveCount(41);
    await expect(page.getByTestId('highlight-item')).toHaveCount(2);

    const docFits = () => page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, client: document.documentElement.clientHeight, y: window.scrollY }));
    const inViewport = async (testId: string) => {
      const box = (await page.getByTestId(testId).first().boundingBox())!;
      const vp = page.viewportSize()!;
      return box.y >= 0 && box.y + box.height <= vp.height;
    };
    expect(await docFits()).toMatchObject({ y: 0 });
    let d = await docFits();
    expect(d.scroll).toBe(d.client);
    expect(await inViewport('grounding-notice')).toBe(true);
    expect(await inViewport('panel-tab-highlights')).toBe(true);
    for (const h of await page.getByTestId('highlight-item').all()) {
      await expect(h).toBeVisible();
      expect((await h.boundingBox())!.height).toBeGreaterThan(10);
    }

    // The last note's buttons are reached by scrolling the panel's own area, not the page.
    // A note is drawn only once its row has been in view ('pn-note-pending' until then) and its row changes height when
    // drawn, which moves every row below it (review: a race when the check ran before the rows above had been drawn). So
    // first bring the first row still waiting into the area, again and again, until every row has been drawn — no
    // 'pn-note-pending' left. After that no row changes height any more, and the checks below are exact (no retry on a
    // moving target).
    const scrollArea = page.getByTestId('pn-highlights-scroll');
    await expect
      .poll(
        () =>
          scrollArea.evaluate((el) => {
            const waiting = el.querySelectorAll('[data-testid="pn-note-pending"]');
            waiting[0]?.scrollIntoView({ block: 'start' });
            return waiting.length;
          }),
        { timeout: 20_000 },
      )
      .toBe(0);
    await expect(page.getByTestId('pn-note-body')).toHaveCount(41);
    const insideArea = async (target: ReturnType<Page['getByTestId']>) => {
      const area = (await scrollArea.boundingBox())!;
      const box = (await target.boundingBox())!;
      return box.y >= area.y - 1 && box.y + box.height <= area.y + area.height + 1;
    };
    const lastEdit = page.getByTestId('pn-note-item').last().getByTestId('pn-note-edit');
    await lastEdit.scrollIntoViewIfNeeded();
    expect(await insideArea(lastEdit)).toBe(true);
    await expect(lastEdit).toBeInViewport();
    d = await docFits();
    expect(d.y).toBe(0);
    expect(d.scroll).toBe(d.client);
    expect(await scrollArea.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await inViewport('grounding-notice')).toBe(true);
    // The long note is folded with "더 보기" and that button is reachable the same way.
    const more = page.getByTestId('pn-note-more');
    await more.scrollIntoViewIfNeeded();
    expect(await insideArea(more)).toBe(true);
    await expect(more).toBeInViewport();
    d = await docFits();
    expect(d.y).toBe(0);
    expect(d.scroll).toBe(d.client);
    expect(mockViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
  test('highlights·notes: 30 highlights — the note action and "새 노트" open the editor in view with its input focused (D-R3-01)', async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    // 30 real highlights: far more than the panel height, so the notes list is below the scroll area's fold.
    for (let i = 0; i < 30; i++) {
      await realJson<HighlightDto>(baseURL!, 'highlights.create', { params: { id: SEED_M2_PAPER_ID }, body: { kind: 'text', color: 1 + (i % 5), quote: { exact: `consecutive scans ${i + 1}` }, page: 1, rects: [{ page: 1, x: 0.1, y: 0.02 + 0.03 * i, w: 0.3, h: 0.02 }] } });
    }
    const note = (id: string, bodyMd: string, at: number) => ({ id, paperId: SEED_M2_PAPER_ID, highlightId: null, sectionId: null, bodyMd, createdAt: NOW + at, updatedAt: NOW + at });
    await mockPanels(page, baseURL!, createMockStore({ notes: [note('n-a', '앞 노트 1', 1), note('n-b', '앞 노트 2', 2), note('n-c', '앞 노트 3', 3)] }));
    await openM2(page);
    const docFits = () => page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, client: document.documentElement.clientHeight, y: window.scrollY }));
    const focusedTestId = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null);
    const scrollArea = page.getByTestId('pn-highlights-scroll');
    const insidePanel = async (testId: string) => {
      const panel = (await page.getByTestId('side-panel').boundingBox())!;
      const box = (await page.getByTestId(testId).boundingBox())!;
      return box.y >= panel.y && box.y + box.height <= panel.y + panel.height;
    };

    // ① the reader "note" action (N) from the AI tab
    await inject(page, 'requestAction', { kind: 'note', anchor: textAnchor, text: QUOTE_M2 });
    await expect(page.getByTestId('panel-tab-highlights')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('highlight-item')).toHaveCount(30);
    await expect(page.getByTestId('pn-note-item')).toHaveCount(3);
    const editor = page.getByTestId('pn-note-editor');
    await expect(editor).toBeInViewport({ ratio: 1 });
    expect(await insidePanel('pn-note-editor')).toBe(true);
    await expect(page.getByTestId('pn-note-input')).toBeFocused();
    await expect(page.getByTestId('pn-note-input')).toHaveValue(`> ${QUOTE_M2}\n\n`);
    // the list really is longer than its area (the notes are below the fold), and the page itself does not scroll
    expect(await scrollArea.evaluate((el) => el.scrollHeight > el.clientHeight + 200)).toBe(true);
    let d = await docFits();
    expect(d).toMatchObject({ y: 0 });
    expect(d.scroll).toBe(d.client);
    await expect(page.getByTestId('grounding-notice')).toBeInViewport({ ratio: 1 });

    // ② cancel, then "새 노트" (visible without scrolling the list) opens a focused editor in view as well
    await editor.getByRole('button', { name: '취소' }).click();
    await expect(editor).toHaveCount(0);
    const newNote = page.getByTestId('pn-note-new');
    await expect(newNote).toBeInViewport({ ratio: 1 });
    await newNote.click();
    await expect(page.getByTestId('pn-note-editor')).toBeInViewport({ ratio: 1 });
    expect(await focusedTestId()).toBe('pn-note-input');
    d = await docFits();
    expect(d.y).toBe(0);
    expect(d.scroll).toBe(d.client);
    expect(mockViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('highlights·notes: a second note action keeps the written text; the saved note is shown under the "노트 n개" header (D-F1-01, D-F1-02)', async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    for (let i = 0; i < 30; i++) {
      await realJson<HighlightDto>(baseURL!, 'highlights.create', { params: { id: SEED_M2_PAPER_ID }, body: { kind: 'text', color: 1 + (i % 5), quote: { exact: `consecutive scans ${i + 1}` }, page: 1, rects: [{ page: 1, x: 0.1, y: 0.02 + 0.03 * i, w: 0.3, h: 0.02 }] } });
    }
    const note = (id: string, bodyMd: string, at: number, o: { highlightId?: string | null; sectionId?: string | null } = {}) => ({ id, paperId: SEED_M2_PAPER_ID, highlightId: o.highlightId ?? null, sectionId: o.sectionId ?? null, bodyMd, createdAt: NOW + at, updatedAt: NOW + at });
    const store = createMockStore({ notes: [note('n-a', '앞 노트 1', 1), note('n-b', '앞 노트 2', 2), note('n-c', '앞 노트 3', 3)] });
    await mockPanels(page, baseURL!, store);
    await mockRoute(page, 'notes.create', (req) => {
      const b = req.body as { bodyMd: string; highlightId?: string; sectionId?: string };
      const n = note('n-new', b.bodyMd, 10, { highlightId: b.highlightId ?? null, sectionId: b.sectionId ?? null });
      store.update<unknown[]>('notes', (p) => [...(p ?? []), n]);
      store.update<unknown[]>('noteCreates', (p) => [...(p ?? []), b]);
      return { kind: 'json', body: n };
    });
    await openM2(page);
    const docFits = () => page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, client: document.documentElement.clientHeight, y: window.scrollY }));
    const input = page.getByTestId('pn-note-input');

    // the fixed row above the scroll area has only '새 노트'; the notes list has its own header inside the scroll area
    await page.getByTestId('panel-tab-highlights').click();
    await expect(page.getByTestId('highlight-item')).toHaveCount(30);
    await expect(page.getByTestId('pn-notes-header')).toHaveText('노트 3개');
    const scrollArea = page.getByTestId('pn-highlights-scroll');
    expect(await scrollArea.evaluate((el) => el.contains(document.querySelector('[data-testid="pn-notes-header"]')))).toBe(true);
    const aboveText = () => page.getByTestId('highlights-tab').evaluate((tab) => Array.from(tab.children).filter((c) => c.getAttribute('data-testid') !== 'pn-highlights-scroll').map((c) => c.textContent ?? '').join(' '));
    expect((await aboveText()).replaceAll('새 노트', '')).not.toContain('노트');

    // ① N with a selection, ② write, ③ N on another sentence: the written text stays and the new quote is appended
    await inject(page, 'requestAction', { kind: 'note', anchor: textAnchor, text: QUOTE_M2 });
    await expect(input).toBeFocused();
    await input.press('End');
    await input.pressSequentially('내 메모');
    await expect(input).toHaveValue(`> ${QUOTE_M2}\n\n내 메모`);
    await inject(page, 'requestAction', { kind: 'note', text: 'consecutive\nscans 7' });
    await expect(input).toHaveValue(`> ${QUOTE_M2}\n\n내 메모\n\n> consecutive scans 7\n\n`);
    await expect(input).toBeFocused();
    expect(await input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart === (el as HTMLTextAreaElement).value.length)).toBe(true);

    // ④ save: the editor closes, the new note is in view inside the scroll area and marked, the header counts it
    await page.getByTestId('pn-note-save').click();
    await expect(page.getByTestId('pn-note-editor')).toHaveCount(0);
    expect(store.get<{ bodyMd: string }[]>('noteCreates')!.map((b) => b.bodyMd)).toEqual([`> ${QUOTE_M2}\n\n내 메모\n\n> consecutive scans 7\n\n`]);
    await expect(page.getByTestId('pn-notes-header')).toHaveText('노트 4개');
    const row = page.locator('[data-testid="pn-note-item"][data-note-id="n-new"]');
    await expect(row.getByTestId('pn-note-saved')).toHaveText('방금 저장함');
    await expect(row).toBeInViewport();
    // inside the scroll area's visible box (rows above it are drawn lazily when they come into view, so poll)
    const inArea = () =>
      row.evaluate((el) => {
        const a = el.closest('[data-testid="pn-highlights-scroll"]')!.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return a.top - 1 <= r.top && r.bottom <= a.bottom + 1;
      });
    await expect.poll(inArea).toBe(true);
    expect(await scrollArea.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const d = await docFits();
    expect(d.y).toBe(0);
    expect(d.scroll).toBe(d.client);
    await expect(page.getByTestId('grounding-notice')).toBeInViewport({ ratio: 1 });
    expect(mockViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
