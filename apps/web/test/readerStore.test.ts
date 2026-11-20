import { describe, expect, it } from 'vitest';
import { useReaderStore } from '../src/state/readerStore';

describe('readerStore (C ↔ D contract)', () => {
  it('actions are published and consumed; jumps go to the registered navigator', async () => {
    const s = useReaderStore.getState();
    s.openPaper('p1', { readable: true, contextReady: false, structureReady: false });
    s.requestAction({ kind: 'explain', text: 'x' });
    expect(useReaderStore.getState().pendingAction?.kind).toBe('explain');
    useReaderStore.getState().consumeAction();
    expect(useReaderStore.getState().pendingAction).toBeNull();
    expect(await useReaderStore.getState().jumpToCitation({ ordinal: 1, kind: 'quote', status: 'verbatim', score: 1 })).toBe('page_only');
    useReaderStore.getState().registerNavigator({ jumpToCitation: async () => 'located', jumpToAnchor: () => {}, jumpToEquation: async () => 'located', jumpToSection: async () => 'located', jumpToPage: () => {}, back: () => false });
    expect(await useReaderStore.getState().jumpToCitation({ ordinal: 1, kind: 'quote', status: 'verbatim', score: 1 })).toBe('located');
  });

  it('M2: without a navigator jumps resolve page_only and back() is false; with one they are delegated', async () => {
    const s = useReaderStore.getState();
    s.registerNavigator(null);
    s.openPaper('p2', { readable: true, contextReady: true, structureReady: true });
    expect(await useReaderStore.getState().jumpToEquation('e1')).toBe('page_only');
    expect(await useReaderStore.getState().jumpToSection('s1')).toBe('page_only');
    expect(useReaderStore.getState().back()).toBe(false);
    expect(() => useReaderStore.getState().jumpToPage(3)).not.toThrow();
    const calls: string[] = [];
    useReaderStore.getState().registerNavigator({
      jumpToCitation: async () => 'located',
      jumpToAnchor: () => {},
      jumpToEquation: async (id) => (calls.push(`eq:${id}`), 'no_anchor'),
      jumpToSection: async (id) => (calls.push(`sec:${id}`), 'located'),
      jumpToPage: (p) => void calls.push(`page:${p}`),
      back: () => (calls.push('back'), true),
    });
    expect(await useReaderStore.getState().jumpToEquation('e1')).toBe('no_anchor');
    expect(await useReaderStore.getState().jumpToSection('s1')).toBe('located');
    useReaderStore.getState().jumpToPage(2);
    expect(useReaderStore.getState().back()).toBe(true);
    expect(calls).toEqual(['eq:e1', 'sec:s1', 'page:2', 'back']);
    useReaderStore.getState().registerNavigator(null);
  });

  it('M2: panelFocus is consumed once; canGoBack changes only through setCanGoBack; openPaper resets both', () => {
    const s = useReaderStore.getState();
    s.focusPanel({ tab: 'references', referenceOrdinal: 2 });
    expect(useReaderStore.getState().panelFocus).toEqual({ tab: 'references', referenceOrdinal: 2 });
    expect(useReaderStore.getState().consumePanelFocus()).toEqual({ tab: 'references', referenceOrdinal: 2 });
    expect(useReaderStore.getState().consumePanelFocus()).toBeNull();
    useReaderStore.getState().setCanGoBack(true);
    expect(useReaderStore.getState().canGoBack).toBe(true);
    useReaderStore.getState().focusPanel({ tab: 'equations', equationId: 'e1' });
    useReaderStore.getState().openPaper('p3', { readable: true, contextReady: false, structureReady: false });
    expect(useReaderStore.getState()).toMatchObject({ canGoBack: false, panelFocus: null });
  });

  it('M2: an action can carry the capture size and a highlight id', () => {
    useReaderStore.getState().requestAction({ kind: 'figure', anchor: { kind: 'area', rects: [{ page: 1, x: 0, y: 0, w: 0.5, h: 0.5 }] }, imagePng: 'iVBORw0KGgo=', capture: { widthPx: 400, heightPx: 300 }, highlightId: 'h1' });
    expect(useReaderStore.getState().pendingAction).toMatchObject({ kind: 'figure', capture: { widthPx: 400, heightPx: 300 }, highlightId: 'h1' });
    useReaderStore.getState().consumeAction();
  });
});
