// M1.1 review M5 on the web: "files/text ready" vs "AI available with the current LLM". The reader store gets
// contextReady = AI usable, plus the Korean reason; the panel's AI buttons are disabled with that reason.
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaperDetailDto } from '@study-paper/shared/contracts/api';
import { aiStatus } from '../../src/library/readiness';
import { AiTab } from '../../src/panel/AiTab';
import { useReaderStore } from '../../src/state/readerStore';
import { readerPaperState } from '../../src/viewer/ReaderPage';
import { anchorOf, PAPER, renderWithApi, resetReader, threadsApi } from '../panel/panelHarness';

afterEach(cleanup);

const ready = { readable: true, contextReady: true, structureReady: true };
const detail = (over: Partial<PaperDetailDto>): PaperDetailDto =>
  ({
    id: PAPER,
    source: 'arxiv',
    arxivId: '2107.06829',
    arxivVersion: 1,
    title: 'T',
    authors: [],
    year: 2021,
    status: 'inbox',
    ingestStatus: 'done',
    state: ready,
    pageCount: 8,
    collectionId: null,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: null,
    abstract: null,
    doi: null,
    venue: null,
    primaryCategory: null,
    publishedAt: null,
    codeUrl: null,
    projectUrl: null,
    citationCount: null,
    structureSource: 'none',
    contextMode: 'pdf',
    ingestWarnings: [],
    readableAt: 1,
    contextReadyAt: 1,
    structureReadyAt: 1,
    lastPosition: null,
    lastJob: null,
    ...over,
  }) as PaperDetailDto;

describe('aiStatus', () => {
  it('maps the server reason to Korean text; without `ai` falls back to contextReady', () => {
    expect(aiStatus({ state: ready, ingestStatus: 'done', pageCount: 40, ai: { available: true, reason: null } })).toMatchObject({ available: true, text: null });
    expect(aiStatus({ state: ready, ingestStatus: 'done', pageCount: 41, ai: { available: false, reason: 'text_mode_pages' } }).text).toBe('AI 미지원: 41쪽 이상(41쪽) 논문 — M3 예정. 읽기·하이라이트는 사용할 수 있습니다.');
    expect(aiStatus({ state: ready, ingestStatus: 'done', pageCount: 9, ai: { available: false, reason: 'text_mode_bytes' } }).text).toContain('PDF 15 MiB 초과');
    expect(aiStatus({ state: { ...ready, contextReady: false }, ingestStatus: 'running', pageCount: null, ai: { available: false, reason: 'context_not_ready' } }).text).toContain('색인 준비 중');
    expect(aiStatus({ state: ready, ingestStatus: 'done', pageCount: 8 }).available).toBe(true);
    expect(aiStatus({ state: { ...ready, contextReady: false }, ingestStatus: 'running', pageCount: 8, ai: { available: true, reason: null } }).available).toBe(false);
    expect(aiStatus({ state: { ...ready, contextReady: false }, ingestStatus: 'failed', pageCount: 8 })).toMatchObject({ available: false, reason: 'context_not_ready' });
  });
});

describe('reader store state', () => {
  it('a ready text-mode paper: contextReady false in the store with the reason; a pdf-mode paper stays ready', () => {
    expect(readerPaperState(detail({ pageCount: 41, contextMode: 'text', ai: { available: false, reason: 'text_mode_pages' } }))).toEqual({
      ...ready,
      contextReady: false,
      aiBlockedReason: 'AI 미지원: 41쪽 이상(41쪽) 논문 — M3 예정. 읽기·하이라이트는 사용할 수 있습니다.',
    });
    expect(readerPaperState(detail({ pageCount: 40, ai: { available: true, reason: null } }))).toEqual({ ...ready, contextReady: true, aiBlockedReason: null });
  });

  it('the AI tab disables explain / ask with that reason instead of "색인 준비 중"', () => {
    resetReader(false);
    const reason = 'AI 미지원: 41쪽 이상(41쪽) 논문 — M3 예정. 읽기·하이라이트는 사용할 수 있습니다.';
    useReaderStore.setState({ paperState: { ...ready, contextReady: false, aiBlockedReason: reason }, selection: { anchor: anchorOf('abc'), text: 'abc' } });
    renderWithApi(<AiTab paperId={PAPER} />, threadsApi({ threads: [], messages: {} }));
    expect(screen.getByTestId('context-not-ready').textContent).toBe(reason);
    const explain = screen.getByTestId('explain-button') as HTMLButtonElement;
    expect(explain.disabled).toBe(true);
    expect(explain.title).toBe(reason);
    expect((screen.getByTestId('followup-send') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('followup-input') as HTMLTextAreaElement).disabled).toBe(true);
  });
});
