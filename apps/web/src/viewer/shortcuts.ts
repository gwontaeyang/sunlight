// Reader keyboard shortcuts (PLAN 8.2, PLAN_M2 3.8, contracts READER_SHORTCUTS / M2_READER_SHORTCUTS):
// E explain, T translate, H / 1–5 highlight, C ask, N note, G glossary, Alt+← back, Esc.
// Active only on /paper/:id, never while an input / textarea / select / contenteditable has focus or an IME
// composition is in progress. E, T, H, 1–5 and G act on the selection (inert without one); C (a question about the
// paper), N (a note), Esc and Alt+← need no selection. Modifier keys disable every shortcut except Alt+←.
import { useEffect, useRef } from 'react';
import { M2_READER_SHORTCUTS, READER_SHORTCUTS } from '@study-paper/shared/contracts/domain';

export type HighlightColorValue = 1 | 2 | 3 | 4 | 5;
export type ReaderShortcutAction =
  | { kind: 'explain' }
  | { kind: 'translate' }
  | { kind: 'reviewQuestions' }
  | { kind: 'ask' }
  | { kind: 'note' }
  | { kind: 'glossary' }
  | { kind: 'highlight'; color: HighlightColorValue | 'last' }
  | { kind: 'back' }
  | { kind: 'escape' };

export interface ShortcutKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target?: EventTarget | null;
}
export interface ShortcutContext {
  /** Current location pathname. */
  path: string;
  hasSelection: boolean;
  /** document.activeElement (checked in addition to the event target). */
  activeElement?: Element | null;
}

const READER_PATH = /^\/paper\/[^/]+\/?$/;
export const isReaderPath = (path: string) => READER_PATH.test(path);

/** input, textarea, select or an element inside a contenteditable (other than contenteditable="false"). */
export function isEditable(el: EventTarget | Element | null | undefined): boolean {
  if (!el || typeof (el as Element).closest !== 'function') return false;
  const e = el as HTMLElement;
  const tag = e.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (e.isContentEditable) return true;
  const ce = e.closest('[contenteditable]');
  return !!ce && ce.getAttribute('contenteditable') !== 'false';
}

type ShortcutName = (typeof M2_READER_SHORTCUTS)[number];
interface Entry {
  action: ReaderShortcutAction;
  needsSelection: boolean;
}
/** Shortcut → action and whether it acts on the selection (BRIEF_C C5). */
const ACTION_OF: Record<ShortcutName, Entry> = {
  explain: { action: { kind: 'explain' }, needsSelection: true },
  translate: { action: { kind: 'translate' }, needsSelection: true },
  highlightLastColor: { action: { kind: 'highlight', color: 'last' }, needsSelection: true },
  highlightColor1: { action: { kind: 'highlight', color: 1 }, needsSelection: true },
  highlightColor2: { action: { kind: 'highlight', color: 2 }, needsSelection: true },
  highlightColor3: { action: { kind: 'highlight', color: 3 }, needsSelection: true },
  highlightColor4: { action: { kind: 'highlight', color: 4 }, needsSelection: true },
  highlightColor5: { action: { kind: 'highlight', color: 5 }, needsSelection: true },
  ask: { action: { kind: 'ask' }, needsSelection: false },
  note: { action: { kind: 'note' }, needsSelection: false },
  glossary: { action: { kind: 'glossary' }, needsSelection: true },
  back: { action: { kind: 'back' }, needsSelection: false },
};

/** Plain keys (lower case) of the M2 table; Alt+← is matched separately. */
const PLAIN_KEYS: Record<string, Entry> = (() => {
  const out: Record<string, Entry> = {};
  for (const name of M2_READER_SHORTCUTS) if (name !== 'back') out[READER_SHORTCUTS[name]] = ACTION_OF[name];
  out.q = { action: { kind: 'reviewQuestions' }, needsSelection: true };
  out[READER_SHORTCUTS.escape] = { action: { kind: 'escape' }, needsSelection: false };
  return out;
})();
const BACK_KEY = READER_SHORTCUTS.back.split('+')[1]!; // 'ArrowLeft'

/** The reader action for a key event, or null when the shortcut must not fire. */
export function resolveReaderShortcut(e: ShortcutKeyEvent, ctx: ShortcutContext): ReaderShortcutAction | null {
  if (!isReaderPath(ctx.path)) return null;
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return null;
  if (isEditable(e.target) || isEditable(ctx.activeElement)) return null;
  if (e.altKey) {
    // Alt+← only (no Ctrl / Meta / Shift with it); every other Alt combination stays the browser's.
    return e.key === BACK_KEY && !e.ctrlKey && !e.metaKey && !e.shiftKey ? ACTION_OF.back.action : null;
  }
  if (e.ctrlKey || e.metaKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const entry = PLAIN_KEYS[key];
  if (!entry) return null;
  if (entry.needsSelection && !ctx.hasSelection) return null;
  return entry.action;
}

/** Registers the reader shortcuts on the document while mounted. */
export function useReaderShortcuts(getContext: () => ShortcutContext, onAction: (a: ReaderShortcutAction) => void): void {
  const ref = useRef({ getContext, onAction });
  ref.current = { getContext, onAction };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveReaderShortcut(e, ref.current.getContext());
      if (!action) return;
      e.preventDefault();
      ref.current.onAction(action);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
