// api/structure.ts: one hook for C and D, requested only for a structure_ready paper; pure selectors. Owner: supervisor.
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../src/api/queryClient';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StructureResponse } from '@study-paper/shared/contracts/api';
import { createApiClient } from '../src/api/client';
import { qk } from '../src/api/queryKeys';
import { equationById, equationByNumber, equationsByNumber, normalizeEqNumber, referenceByOrdinal, sectionById, useStructure } from '../src/api/structure';
import { useReaderStore } from '../src/state/readerStore';

const ID = '00000000-0000-4000-8000-000000000004';
const eq = (id: string, number: string | null) => ({ id, sectionId: null, htmlId: null, number, ordinal: 1, latexRaw: 'x', latex: 'x', katexOk: true, pdfPage: null, pdfOffset: null, pdfRect: null });
const STRUCTURE: StructureResponse = {
  structureSource: 'latexml',
  sections: [{ id: 's1', parentId: null, htmlId: 'S1', number: 'I', title: 'Introduction', level: 1, ordinal: 1, pdfPage: 1, pdfOffset: 98, pdfRect: { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.02 } }],
  equations: [eq('e1', '1'), eq('e2', '2'), eq('e5', 'A.1'), eq('e6', 'A.1'), eq('ex', null)],
  figures: [],
  references: [{ id: 'r2', ordinal: 2, label: '[2]', rawText: 'B', title: null, authors: [], year: null, venue: null, doi: null, arxivId: '2301.00003', citationCount: null, inLibraryPaperId: 'p3', htmlId: 'bib.bib2' }],
};

function wrapper() {
  const qc = createAppQueryClient();
  return { qc, Wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children) };
}

describe('useStructure', () => {
  it('requests only for the open, structure_ready paper; parses with the contract; uses qk.structure', async () => {
    const fetchFn = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(JSON.stringify(STRUCTURE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = createApiClient({ fetch: fetchFn as unknown as typeof fetch, getToken: () => 't' });
    useReaderStore.getState().openPaper(ID, { readable: true, contextReady: true, structureReady: false });
    const { qc, Wrapper } = wrapper();
    const { result, rerender } = renderHook(() => useStructure(ID, { client }), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchFn).not.toHaveBeenCalled();
    useReaderStore.getState().setPaperState({ readable: true, contextReady: true, structureReady: true });
    rerender();
    await waitFor(() => expect(result.current.data).toEqual(STRUCTURE));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]![0])).toBe(`/api/papers/${ID}/structure`);
    expect(qc.getQueryData(qk.structure(ID))).toEqual(STRUCTURE);
  });

  it('a paper that is not the open one is not requested unless enabled explicitly', async () => {
    const fetchFn = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(JSON.stringify(STRUCTURE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = createApiClient({ fetch: fetchFn as unknown as typeof fetch, getToken: () => 't' });
    useReaderStore.getState().openPaper('other', { readable: true, contextReady: true, structureReady: true });
    const { Wrapper } = wrapper();
    renderHook(() => useStructure(ID, { client }), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchFn).not.toHaveBeenCalled();
    const { result } = renderHook(() => useStructure(ID, { client, enabled: true }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe('structure selectors', () => {
  it('equation numbers are normalised and compared case-insensitively; ambiguous numbers give null for the single lookup', () => {
    expect(['(4)', ' 4 ', 'Eq. 4', 'eq 4', 'Equation 4'].map(normalizeEqNumber)).toEqual(['4', '4', '4', '4', '4']);
    expect(equationByNumber(STRUCTURE, '(1)')?.id).toBe('e1');
    expect(equationByNumber(STRUCTURE, 'Eq. 2')?.id).toBe('e2');
    expect(equationsByNumber(STRUCTURE, 'a.1').map((e) => e.id)).toEqual(['e5', 'e6']);
    expect(equationByNumber(STRUCTURE, 'A.1')).toBeNull();
    expect(equationByNumber(STRUCTURE, '9')).toBeNull();
    expect(equationByNumber(undefined, '1')).toBeNull();
    expect(equationById(STRUCTURE, 'e2')?.number).toBe('2');
    expect(sectionById(STRUCTURE, 's1')?.title).toBe('Introduction');
    expect(referenceByOrdinal(STRUCTURE, 2)?.inLibraryPaperId).toBe('p3');
    expect(referenceByOrdinal(STRUCTURE, 1)).toBeNull();
  });
});
