import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { isEditable, isReaderPath, resolveReaderShortcut, useReaderShortcuts, type ShortcutContext } from '../../src/viewer/shortcuts';

const reader: ShortcutContext = { path: '/paper/abc', hasSelection: true, activeElement: null };
const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, target: document.body, ...extra });

afterEach(() => {
  document.body.innerHTML = '';
});

describe('resolveReaderShortcut', () => {
  it('maps E, H, 1–5 and Esc on /paper/:id with a selection', () => {
    expect(resolveReaderShortcut(key('e'), reader)).toEqual({ kind: 'explain' });
    expect(resolveReaderShortcut(key('E'), reader)).toEqual({ kind: 'explain' });
    expect(resolveReaderShortcut(key('h'), reader)).toEqual({ kind: 'highlight', color: 'last' });
    for (const n of [1, 2, 3, 4, 5]) expect(resolveReaderShortcut(key(String(n)), reader)).toEqual({ kind: 'highlight', color: n });
    expect(resolveReaderShortcut(key('Escape'), reader)).toEqual({ kind: 'escape' });
  });
  it('is inactive on other routes', () => {
    for (const path of ['/', '/review', '/settings', '/paper', '/paper/abc/extra']) expect(resolveReaderShortcut(key('h'), { ...reader, path })).toBeNull();
    expect(isReaderPath('/paper/abc/')).toBe(true);
  });
  it('H, 1–5 and E need a selection; Esc does not', () => {
    const none = { ...reader, hasSelection: false };
    for (const k of ['h', '1', '5', 'e']) expect(resolveReaderShortcut(key(k), none)).toBeNull();
    expect(resolveReaderShortcut(key('Escape'), none)).toEqual({ kind: 'escape' });
  });
  it('is inactive while an input, textarea, select or contenteditable has focus', () => {
    document.body.innerHTML = '<input id="i"><textarea id="t"></textarea><select id="s"></select><div contenteditable="true"><p id="p">x</p></div><div contenteditable="false"><span id="n">x</span></div>';
    for (const id of ['i', 't', 's', 'p']) {
      const el = document.getElementById(id)!;
      expect(resolveReaderShortcut(key('h', { target: el }), reader), id).toBeNull();
      expect(resolveReaderShortcut(key('h'), { ...reader, activeElement: el }), id).toBeNull();
    }
    expect(resolveReaderShortcut(key('h', { target: document.getElementById('n') }), reader)).toEqual({ kind: 'highlight', color: 'last' });
    expect(isEditable(document.getElementById('n'))).toBe(false);
  });
  it('is inactive during IME composition', () => {
    expect(resolveReaderShortcut(key('e', { isComposing: true }), reader)).toBeNull();
    expect(resolveReaderShortcut(key('Process', { keyCode: 229 }), reader)).toBeNull();
    expect(resolveReaderShortcut(key('1', { keyCode: 229 }), reader)).toBeNull();
  });
  // M2 table (BRIEF_C C5 — the M1 assertion "T, C, N, G are ignored" is replaced by the M2 shortcut table).
  it('ignores modified keys and keys outside the M2 table', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) expect(resolveReaderShortcut(key('h', { [mod]: true }), reader)).toBeNull();
    for (const k of ['6', '0', 'x', 'ArrowLeft']) expect(resolveReaderShortcut(key(k), reader)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// M2: T, C, N, G, Alt+← (BRIEF_C C5)

const M2_KEYS = [
  { key: 't', action: { kind: 'translate' }, needsSelection: true },
  { key: 'T', action: { kind: 'translate' }, needsSelection: true },
  { key: 'c', action: { kind: 'ask' }, needsSelection: false },
  { key: 'n', action: { kind: 'note' }, needsSelection: false },
  { key: 'g', action: { kind: 'glossary' }, needsSelection: true },
  { key: 'e', action: { kind: 'explain' }, needsSelection: true },
  { key: 'h', action: { kind: 'highlight', color: 'last' }, needsSelection: true },
  { key: '3', action: { kind: 'highlight', color: 3 }, needsSelection: true },
] as const;
const altLeft = (extra: Record<string, unknown> = {}) => key('ArrowLeft', { altKey: true, ...extra });

describe('resolveReaderShortcut — M2 keys', () => {
  it('every key with a selection maps to its action', () => {
    for (const k of M2_KEYS) expect(resolveReaderShortcut(key(k.key), reader), k.key).toEqual(k.action);
    expect(resolveReaderShortcut(altLeft(), reader)).toEqual({ kind: 'back' });
  });
  it('without a selection: T, G (and E, H, 1–5) are inert; C, N and Alt+← still work', () => {
    const none = { ...reader, hasSelection: false };
    for (const k of M2_KEYS) expect(resolveReaderShortcut(key(k.key), none), k.key).toEqual(k.needsSelection ? null : k.action);
    expect(resolveReaderShortcut(altLeft(), none)).toEqual({ kind: 'back' });
    expect(resolveReaderShortcut(key('Escape'), none)).toEqual({ kind: 'escape' });
  });
  it('no key fires while an input / textarea / contenteditable has focus (target or activeElement)', () => {
    document.body.innerHTML = '<input id="i"><textarea id="t"></textarea><div contenteditable="true"><p id="p">x</p></div>';
    for (const id of ['i', 't', 'p']) {
      const el = document.getElementById(id)!;
      for (const k of M2_KEYS) {
        expect(resolveReaderShortcut(key(k.key, { target: el }), reader), `${id} ${k.key}`).toBeNull();
        expect(resolveReaderShortcut(key(k.key), { ...reader, activeElement: el }), `${id} ${k.key}`).toBeNull();
      }
      expect(resolveReaderShortcut(altLeft({ target: el }), reader), `${id} Alt+←`).toBeNull();
      expect(resolveReaderShortcut(altLeft(), { ...reader, activeElement: el }), `${id} Alt+←`).toBeNull();
    }
  });
  it('no key fires during IME composition', () => {
    for (const k of M2_KEYS) {
      expect(resolveReaderShortcut(key(k.key, { isComposing: true }), reader), k.key).toBeNull();
      expect(resolveReaderShortcut(key(k.key, { keyCode: 229 }), reader), k.key).toBeNull();
    }
    expect(resolveReaderShortcut(altLeft({ isComposing: true }), reader)).toBeNull();
  });
  it('no key fires on other routes', () => {
    for (const path of ['/', '/review', '/settings', '/paper/abc/extra']) {
      for (const k of M2_KEYS) expect(resolveReaderShortcut(key(k.key), { ...reader, path }), `${path} ${k.key}`).toBeNull();
      expect(resolveReaderShortcut(altLeft(), { ...reader, path }), `${path} Alt+←`).toBeNull();
    }
  });
  it('Alt+← only: no Ctrl / Meta / Shift with it, no other Alt key, no plain ←', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'shiftKey']) expect(resolveReaderShortcut(altLeft({ [mod]: true }), reader), mod).toBeNull();
    for (const k of ['ArrowRight', 't', 'c', 'h']) expect(resolveReaderShortcut(key(k, { altKey: true }), reader), k).toBeNull();
    expect(resolveReaderShortcut(key('ArrowLeft'), reader)).toBeNull();
    for (const mod of ['ctrlKey', 'metaKey']) for (const k of M2_KEYS) expect(resolveReaderShortcut(key(k.key, { [mod]: true }), reader)).toBeNull();
  });
  it('the hook prevents the browser default for Alt+← (history back) on the reader', () => {
    const onAction = vi.fn();
    const { unmount } = renderHook(() => useReaderShortcuts(() => ({ path: '/paper/x', hasSelection: false, activeElement: document.activeElement }), onAction));
    const ev = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'back' });
    expect(ev.defaultPrevented).toBe(true);
    unmount();
  });
});

describe('useReaderShortcuts', () => {
  it('calls the handler for document key events, not for keys typed in an input', () => {
    const onAction = vi.fn();
    const { unmount } = renderHook(() => useReaderShortcuts(() => ({ path: '/paper/x', hasSelection: true, activeElement: document.activeElement }), onAction));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'highlight', color: 3 });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    expect(onAction).toHaveBeenCalledTimes(1);
    unmount();
    input.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
