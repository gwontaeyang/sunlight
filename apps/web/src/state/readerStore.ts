// C ↔ D contract (PLAN 8.2, PLAN_M2 3.8). Owner: supervisor. C (viewer) publishes selection/actions and registers the
// navigator; D (panels) consumes actions and asks the viewer to jump.
// M2: panelFocus (C asks D to show a tab/item, e.g. a citation number → the references tab), the position stack's
// "back" (C keeps the stack and reports canGoBack through setCanGoBack — never setState directly), structure jumps that
// report a JumpResult, jumpToPage. Structure data itself is read by both sides with api/structure.ts useStructure.
import { create } from 'zustand';
import type { Anchor, Citation, JumpResult, PanelTab, ReaderActionKind } from '@study-paper/shared/contracts/domain';

export type { JumpResult, PanelTab };

/** What D should show (C → D). D consumes it once. */
export interface PanelFocus {
  tab: PanelTab;
  referenceOrdinal?: number;
  equationId?: string;
  highlightId?: string;
  noteId?: string;
}

export interface PaperState {
  readable: boolean;
  /** The AI context is ready AND usable by the current LLM (ReaderPage folds PaperSummaryDto.ai in). */
  contextReady: boolean;
  structureReady: boolean;
  /** Additive (M1.1): Korean reason shown on disabled AI buttons when the AI is unavailable (null/absent = 색인 준비 중). */
  aiBlockedReason?: string | null;
}

export interface ReaderSelection {
  anchor: Anchor;
  /** Selected text as shown to the user (not used for offsets: the server computes positions). */
  text: string;
}

export interface ReaderAction {
  kind: ReaderActionKind;
  /** Selection or area at the time of the action. */
  anchor?: Anchor;
  text?: string;
  /** Area capture as base64 PNG (no data: prefix), M2. */
  imagePng?: string;
  /** M2: output size of the capture (px), for the "small area" notice. */
  capture?: { widthPx: number; heightPx: number };
  equationId?: string;
  sectionId?: string;
  /** M2: the highlight the action starts from (e.g. a note on a highlight). */
  highlightId?: string;
}

export interface ReaderNavigator {
  /** Scroll to the citation, re-anchor in the text layer and flash it; 'page_only' when the DOM check fails. */
  jumpToCitation(c: Citation): Promise<'located' | 'page_only'>;
  jumpToAnchor(a: Anchor): void;
  /** M2: scroll to the equation's pdfPage/pdfRect and flash it. */
  jumpToEquation(id: string): Promise<JumpResult>;
  /** M2: scroll to the section heading. */
  jumpToSection(id: string): Promise<JumpResult>;
  /** M2: scroll to a page (pushes the position stack like any jump). */
  jumpToPage(page: number): void;
  /** M2: pop the position stack; false when it is empty. */
  back(): boolean;
}

export interface ReaderStore {
  paperId: string | null;
  paperState: PaperState;
  selection: ReaderSelection | null;
  pendingAction: ReaderAction | null;
  currentSectionId: string | null;
  navigator: ReaderNavigator | null;
  /** M2: pending focus request for the panels (C sets, D consumes). */
  panelFocus: PanelFocus | null;
  /** M2: whether the viewer's position stack has an entry ("뒤로" button, Alt+←). */
  canGoBack: boolean;

  openPaper(paperId: string, state: PaperState): void;
  setPaperState(state: PaperState): void;
  setSelection(s: ReaderSelection | null): void;
  setCurrentSectionId(id: string | null): void;
  /** C calls; D subscribes to pendingAction. */
  requestAction(a: ReaderAction): void;
  consumeAction(): void;
  /** C registers its navigator (null on unmount). */
  registerNavigator(n: ReaderNavigator | null): void;
  /** D calls; resolves 'page_only' when no viewer is registered. */
  jumpToCitation(c: Citation): Promise<'located' | 'page_only'>;
  jumpToAnchor(a: Anchor): void;
  /** Resolves 'page_only' when no viewer is registered. */
  jumpToEquation(id: string): Promise<JumpResult>;
  /** Resolves 'page_only' when no viewer is registered. */
  jumpToSection(id: string): Promise<JumpResult>;
  jumpToPage(page: number): void;
  /** C calls (e.g. a citation number click); D subscribes to panelFocus. */
  focusPanel(f: PanelFocus): void;
  /** D calls: returns the pending focus and clears it. */
  consumePanelFocus(): PanelFocus | null;
  /** C calls whenever its position stack changes. */
  setCanGoBack(b: boolean): void;
  /** The navigator's back(); false without a navigator. */
  back(): boolean;
}

const EMPTY_STATE: PaperState = { readable: false, contextReady: false, structureReady: false };

export const useReaderStore = create<ReaderStore>((set, get) => ({
  paperId: null,
  paperState: EMPTY_STATE,
  selection: null,
  pendingAction: null,
  currentSectionId: null,
  navigator: null,
  panelFocus: null,
  canGoBack: false,

  openPaper: (paperId, state) => set({ paperId, paperState: state, selection: null, pendingAction: null, currentSectionId: null, panelFocus: null, canGoBack: false }),
  setPaperState: (paperState) => set({ paperState }),
  setSelection: (selection) => set({ selection }),
  setCurrentSectionId: (currentSectionId) => set({ currentSectionId }),
  requestAction: (a) => set({ pendingAction: a }),
  consumeAction: () => set({ pendingAction: null }),
  registerNavigator: (navigator) => set({ navigator }),
  jumpToCitation: async (c) => (get().navigator ? get().navigator!.jumpToCitation(c) : 'page_only'),
  jumpToAnchor: (a) => get().navigator?.jumpToAnchor(a),
  jumpToEquation: async (id) => (get().navigator ? get().navigator!.jumpToEquation(id) : 'page_only'),
  jumpToSection: async (id) => (get().navigator ? get().navigator!.jumpToSection(id) : 'page_only'),
  jumpToPage: (page) => get().navigator?.jumpToPage(page),
  focusPanel: (panelFocus) => set({ panelFocus }),
  consumePanelFocus: () => {
    const f = get().panelFocus;
    if (f) set({ panelFocus: null });
    return f;
  },
  setCanGoBack: (canGoBack) => set({ canGoBack }),
  back: () => get().navigator?.back() ?? false,
}));
