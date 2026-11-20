// Shared render helpers for panel tests: QueryClient + fake API client + reader store reset.
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../../src/api/queryClient';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MessageDto, ThreadDto } from '@study-paper/shared/contracts/api';
import type { Anchor, Citation, MessageStats } from '@study-paper/shared/contracts/domain';
import { PanelApiContext } from '../../src/panel/panelApi';
import { useReaderStore } from '../../src/state/readerStore';
import { createFakeServer, type JsonHandler } from './sseFake';

export const PAPER = '00000000-0000-4000-8000-000000000001';

export function resetReader(contextReady = true) {
  useReaderStore.setState({
    paperId: PAPER,
    paperState: { readable: true, contextReady, structureReady: false },
    selection: null,
    pendingAction: null,
    navigator: null,
  });
}

export function renderWithApi(ui: ReactNode, json: JsonHandler = () => undefined) {
  const server = createFakeServer(json);
  const qc = createAppQueryClient();
  const r = render(
    <QueryClientProvider client={qc}>
      <PanelApiContext.Provider value={server.client}>{ui}</PanelApiContext.Provider>
    </QueryClientProvider>,
  );
  return { ...r, server, qc };
}

export const anchorOf = (exact: string): Anchor => ({ kind: 'text', quote: { exact }, rects: [{ page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.02 }] });

export function threadDto(id: string, o: Partial<ThreadDto> & { lastStats?: MessageStats | null; lastMessageStatus?: MessageDto['status'] | null } = {}): ThreadDto & { lastStats: MessageStats | null; lastMessageStatus: MessageDto['status'] | null } {
  return {
    id,
    paperId: PAPER,
    kind: 'explain',
    title: `thread ${id}`,
    anchor: null,
    highlightId: null,
    equationId: null,
    sectionId: null,
    imageFileId: null,
    createdAt: 1,
    updatedAt: 1,
    lastStats: null,
    lastMessageStatus: 'complete',
    ...o,
  };
}

export function messageDto(id: string, threadId: string, role: 'user' | 'assistant', contentMd: string, o: Partial<MessageDto> = {}): MessageDto {
  return { id, threadId, role, contentMd, status: 'complete', stats: null, issues: [], citations: [] as Citation[], llmCallId: null, effort: null, createdAt: 1, ...o };
}

export const STATS: MessageStats = {
  blocks: { p: 2, pEquationOnly: 0, pUnverified: 1, n: 0, g: 0, unlabeled: 0 },
  quotes: { verbatim: 1, fuzzy: 0, ambiguous: 0, notFound: 1 },
  eqRefs: { resolved: 0, noAnchor: 0, ambiguous: 0, notFound: 0, unindexed: 0 },
};

/** JSON handler for GET threads.list / threads.get from in-memory data. */
export function threadsApi(data: { threads: ReturnType<typeof threadDto>[]; messages: Record<string, MessageDto[]> }): JsonHandler {
  return (c) => {
    if (c.method === 'GET' && c.url === `/api/papers/${PAPER}/threads`) return { status: 200, json: { threads: data.threads } };
    const m = /^\/api\/threads\/([^/]+)$/.exec(c.url);
    if (c.method === 'GET' && m) {
      const t = data.threads.find((x) => x.id === m[1]);
      if (!t) return { status: 404, json: { error: { code: 'not_found', message: 'thread' } } };
      const { lastStats: _ls, ...thread } = t;
      return { status: 200, json: { thread, messages: data.messages[t.id] ?? [] } };
    }
    return undefined;
  };
}
