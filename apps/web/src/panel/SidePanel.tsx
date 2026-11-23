// Right-hand side panel (PLAN 8.3, PLAN_M2 3.8, BRIEF_D D1): tabs AI · 하이라이트·노트 · 카드 · 수식 · 참고문헌 · 용어집,
// resizable and hideable. Owner D. Name and props are fixed: the reader page (C) renders <SidePanel paperId>.
// - Inactive (and hidden) tabs stay mounted, so a running answer or card generation keeps streaming.
// - Reader actions open their tab (glossary → 용어집, note → 하이라이트·노트, the rest → AI); each tab consumes its own.
// - readerStore.panelFocus (C: e.g. a citation number → the references tab) opens the tab, highlights the target
//   (reference ordinal / equation / highlight / note) and is consumed once (consumePanelFocus).
// - The open paper's structure (useStructure, the query key C shares) is provided to the chips ("색인에서 찾기") and
//   to the equation thread head.
// - M3a (PLAN_M3 §4, concept_CD D panel): the six tabs are icon buttons on the right rail (their accessible names and
//   test ids unchanged), each with the count of what the open paper already has in the query cache (0 hidden, no
//   request of its own); the rail's top button hides / shows the panel. The panel has a head with the tab's title.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { HighlightDto, ListCardsResponse, ListGlossaryResponse, ListThreadsResponse, NoteDto, StructureResponse } from '@study-paper/shared/contracts/api';
import { qk } from '../api/queryKeys';
import { useStructure } from '../api/structure';
import { isE2e } from '../api/token';
import { StructureContext } from '../markdown/chips';
import { useReaderStore, type PanelFocus, type PanelTab } from '../state/readerStore';
import { AiTab } from './AiTab';
import { CardsTab } from './CardsTab';
import { EquationsTab } from './EquationsTab';
import { GlossaryTab } from './GlossaryTab';
import { HighlightsTab } from './HighlightsTab';
import { usePanelApi } from './panelApi';
import { ReferencesTab } from './ReferencesTab';
import { Icon, type IconName } from '../ui/icons';

type Tab = PanelTab;

/** Tabs in display order; the M1 tab test ids stay, new ones carry the pn- prefix. */
export const PANEL_TABS: readonly { id: Tab; label: string; testId: string }[] = [
  { id: 'ai', label: 'AI', testId: 'panel-tab-ai' },
  { id: 'highlights', label: '하이라이트·노트', testId: 'panel-tab-highlights' },
  { id: 'cards', label: '카드', testId: 'pn-tab-cards' },
  { id: 'equations', label: '수식', testId: 'pn-tab-equations' },
  { id: 'references', label: '참고문헌', testId: 'pn-tab-references' },
  { id: 'glossary', label: '용어집', testId: 'pn-tab-glossary' },
];

/** Rail icon and panel-head title per tab (M3a). */
const TAB_LOOK: Record<Tab, { icon: IconName; title: string }> = {
  ai: { icon: 'ai', title: '대화 · 설명' },
  highlights: { icon: 'highlighter', title: '하이라이트·노트' },
  cards: { icon: 'cards', title: '카드' },
  equations: { icon: 'sigma', title: '수식' },
  references: { icon: 'refs', title: '참고문헌' },
  glossary: { icon: 'glossary', title: '용어집' },
};

/** A number from data already in the query cache (null when that query has no data). Never fetches. */
function useCachedCount<T>(key: readonly unknown[], count: (d: T) => number): number | null {
  const qc = useQueryClient();
  const subscribe = useCallback((cb: () => void) => qc.getQueryCache().subscribe(cb), [qc]);
  return useSyncExternalStore(subscribe, () => {
    const d = qc.getQueryData<T>(key);
    return d === undefined ? null : count(d);
  });
}

/** The rail counts: threads · highlights + notes · complete cards · equations · references · glossary terms. */
export function useRailCounts(paperId: string, structure: StructureResponse | undefined): Record<Tab, number | null> {
  const threads = useCachedCount<ListThreadsResponse>(qk.threads(paperId), (d) => d.threads.length);
  const highlights = useCachedCount<{ highlights: HighlightDto[] }>(qk.highlights(paperId), (d) => d.highlights.length);
  const notes = useCachedCount<{ notes: NoteDto[] }>(qk.notes(paperId), (d) => d.notes.length);
  const cards = useCachedCount<ListCardsResponse>(qk.cards(paperId), (d) => d.cards.filter((c) => c.status === 'complete').length);
  const glossary = useCachedCount<ListGlossaryResponse>(qk.glossary(paperId), (d) => d.terms.length);
  return {
    ai: threads,
    highlights: highlights === null && notes === null ? null : (highlights ?? 0) + (notes ?? 0),
    cards,
    equations: structure ? structure.equations.length : null,
    references: structure ? structure.references.length : null,
    glossary,
  };
}

/** The tab a reader action belongs to. */
const ACTION_TAB: Partial<Record<string, Tab>> = { glossary: 'glossary', note: 'highlights' };

export const PANEL_MIN_WIDTH = 280;
export const PANEL_MAX_WIDTH = 900;
export const PANEL_DEFAULT_WIDTH = 384;
const STORAGE_KEY = 'sp.sidePanel';

export const GROUNDING_NOTICE = "'원문에서 찾음'은 그 문장이 논문에 있다는 뜻입니다. 주장을 뒷받침하는지는 직접 읽고 판단하세요.";

const clamp = (w: number) => Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(w)));

function loadLayout(): { width: number; hidden: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { width?: unknown; hidden?: unknown } | null;
    return { width: typeof raw?.width === 'number' ? clamp(raw.width) : PANEL_DEFAULT_WIDTH, hidden: raw?.hidden === true };
  } catch {
    return { width: PANEL_DEFAULT_WIDTH, hidden: false };
  }
}

export function SidePanel({ paperId, uploaded = false, textExcerpts = false }: { paperId: string; uploaded?: boolean; textExcerpts?: boolean }) {
  const [tab, setTab] = useState<Tab>('ai');
  const [layout, setLayout] = useState(loadLayout);
  // nonce: one per focus request, so the same target asked for again is scrolled to again.
  const [focus, setFocus] = useState<(PanelFocus & { nonce: number }) | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingAction = useReaderStore((s) => s.pendingAction);
  const panelFocus = useReaderStore((s) => s.panelFocus);
  const consumePanelFocus = useReaderStore((s) => s.consumePanelFocus);
  const client = usePanelApi();
  const structure = useStructure(paperId, { client });

  // A reader action brings its tab into view (the tab itself consumes the action).
  useEffect(() => {
    if (pendingAction) {
      setTab(ACTION_TAB[pendingAction.kind] ?? 'ai');
      setLayout((l) => (l.hidden ? { ...l, hidden: false } : l));
    }
  }, [pendingAction]);

  // A focus request (C → D): open the tab, keep the target for highlighting, consume the request once.
  useEffect(() => {
    if (!panelFocus) return;
    const f = consumePanelFocus();
    if (!f) return;
    setTab(f.tab);
    setFocus((prev) => ({ ...f, nonce: (prev?.nonce ?? 0) + 1 }));
    setLayout((l) => (l.hidden ? { ...l, hidden: false } : l));
  }, [panelFocus, consumePanelFocus]);

  // Playwright only (<meta name="sp-e2e">): the store the panels read, for injecting actions and focus requests.
  useEffect(() => {
    if (isE2e()) (window as unknown as Record<string, unknown>).__spPanelStore = useReaderStore;
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      /* storage unavailable: layout is per session only */
    }
  }, [layout]);

  const width = layout.hidden ? 0 : layout.width;
  const counts = useRailCounts(paperId, structure.data);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const openTab = (id: Tab) => {
    setTab(id);
    setLayout((l) => (l.hidden ? { ...l, hidden: false } : l));
  };
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = PANEL_TABS.findIndex((t) => t.id === tab);
    const next = { ArrowDown: (i + 1) % PANEL_TABS.length, ArrowUp: (i - 1 + PANEL_TABS.length) % PANEL_TABS.length, Home: 0, End: PANEL_TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const t = PANEL_TABS[next]!;
    openTab(t.id);
    tabRefs.current[t.id]?.focus();
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = layout.width;
    const move = (ev: PointerEvent) => setLayout((l) => ({ ...l, width: clamp(startW + (startX - ev.clientX)) }));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const look = TAB_LOOK[tab];
  return (
    <>
      <div
        ref={rootRef}
        data-testid="side-panel"
        data-hidden={layout.hidden}
        className={`relative col-start-4 row-start-2 flex h-full min-h-0 flex-col bg-sl-surface ${layout.hidden ? 'overflow-hidden' : 'border-l border-sl-line'}`}
        style={{ width }}
      >
        {!layout.hidden && (
          <div
            data-testid="panel-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="패널 폭 조절"
            aria-valuenow={layout.width}
            aria-valuemin={PANEL_MIN_WIDTH}
            aria-valuemax={PANEL_MAX_WIDTH}
            tabIndex={0}
            className="absolute top-0 left-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-blue-300"
            onPointerDown={startResize}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') setLayout((l) => ({ ...l, width: clamp(l.width + 24) }));
              if (e.key === 'ArrowRight') setLayout((l) => ({ ...l, width: clamp(l.width - 24) }));
            }}
            title="드래그해서 폭 조절"
          />
        )}
        {/* Tabs stay mounted while hidden or inactive so a running answer keeps streaming. */}
        <div className={`flex min-h-0 flex-1 flex-col ${layout.hidden ? 'hidden' : ''}`}>
          <div className="flex min-h-[55px] shrink-0 items-center gap-2 border-b border-sl-line px-5" data-testid="pn-head">
            <span className="text-sl-accent">
              <Icon name={look.icon} size={18} />
            </span>
            <h2 className="text-sl-heading font-semibold tracking-[-0.5px] text-sl-ink" id="pn-head-title">
              {look.title}
            </h2>
          </div>
          <StructureContext.Provider value={structure.data}>
            <div className={`flex min-h-0 flex-1 flex-col px-4 py-3 ${tab === 'ai' ? '' : 'hidden'}`}>
              <AiTab paperId={paperId} />
            </div>
            <div className={`flex min-h-0 flex-1 flex-col px-4 py-3 ${tab === 'highlights' ? '' : 'hidden'}`}>
              <HighlightsTab paperId={paperId} focusHighlightId={focus?.tab === 'highlights' ? (focus.highlightId ?? null) : null} focusNoteId={focus?.tab === 'highlights' ? (focus.noteId ?? null) : null} focusNonce={focus?.nonce ?? 1} />
            </div>
            <div className={`flex min-h-0 flex-1 flex-col px-4 py-3 ${tab === 'cards' ? '' : 'hidden'}`}>
              <CardsTab paperId={paperId} uploaded={uploaded} />
            </div>
            <div className={`flex min-h-0 flex-1 flex-col px-4 py-3 ${tab === 'equations' ? '' : 'hidden'}`}>
              {uploaded ? (
                <p data-testid="rd-upload-equation-limit" className="text-sl-reading text-sl-body">
                  업로드 PDF에는 원본 LaTeX 색인이 없어 수식 깊이 읽기가 제한됩니다. 수식 주변의 글을 선택해 설명을 요청할 수 있습니다.
                </p>
              ) : <EquationsTab paperId={paperId} focusEquationId={focus?.tab === 'equations' ? (focus.equationId ?? null) : null} focusNonce={focus?.nonce ?? 1} />}
            </div>
            <div className={`flex min-h-0 flex-1 flex-col px-4 py-3 ${tab === 'references' ? '' : 'hidden'}`}>
              {uploaded ? (
                <p className="text-sl-reading text-sl-body">이 PDF의 참고문헌은 자동으로 색인되지 않습니다. 논문 끝의 참고문헌 목록에서 확인하세요.</p>
              ) : <ReferencesTab paperId={paperId} focusOrdinal={focus?.tab === 'references' ? (focus.referenceOrdinal ?? null) : null} focusNonce={focus?.nonce ?? 1} />}
            </div>
            <div className={`flex min-h-0 flex-1 flex-col px-4 py-3 ${tab === 'glossary' ? '' : 'hidden'}`}>
              <GlossaryTab paperId={paperId} />
            </div>
          </StructureContext.Provider>
          <div data-testid="grounding-notice" className="shrink-0 border-t border-sl-line px-4 py-2.5 text-sl-label text-sl-muted">
            {uploaded ? <span data-testid="rd-upload-evidence-note">{textExcerpts && '이 크기의 PDF는 추출한 글의 일부만 AI에 전달합니다. '}업로드 PDF에서는 인용 원문을 정확히 대조하지 않습니다. 인용문과 식 번호는 PDF에서 직접 확인하세요.</span> : GROUNDING_NOTICE}
          </div>
        </div>
      </div>
      <nav aria-label="공부 패널" data-testid="pn-rail" className="col-start-5 row-span-2 row-start-1 flex min-h-0 flex-col items-center border-l border-sl-line bg-sl-surface">
        <div className="grid h-sl-bar w-full shrink-0 place-items-center border-b border-sl-line">
          {layout.hidden ? (
            <button type="button" data-testid="panel-show" aria-label="패널 열기" title="패널 열기" className="inline-grid size-8 place-items-center rounded-sl-control text-sl-muted hover:bg-sl-subtle hover:text-sl-ink" onClick={() => setLayout((l) => ({ ...l, hidden: false }))}>
              <Icon name="panelOpen" size={18} />
            </button>
          ) : (
            <button type="button" data-testid="panel-hide" aria-label="패널 숨기기" title="패널 숨기기" className="inline-grid size-8 place-items-center rounded-sl-control bg-sl-subtle text-sl-ink hover:text-sl-ink" onClick={() => setLayout((l) => ({ ...l, hidden: true }))}>
              <Icon name="panelClose" size={18} />
            </button>
          )}
        </div>
        <div role="tablist" aria-orientation="vertical" aria-label="패널 탭" className="flex min-h-0 w-full flex-col items-center gap-1.5 overflow-y-auto py-2.5" onKeyDown={onTabKey}>
          {PANEL_TABS.map((t) => {
            const active = tab === t.id;
            const n = counts[t.id];
            return (
              <div key={t.id} className="relative">
                <button
                  ref={(el) => {
                    tabRefs.current[t.id] = el;
                  }}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  data-testid={t.testId}
                  title={n ? `${t.label} ${n}` : t.label}
                  className={`relative flex min-h-[55px] w-[38px] flex-col items-center justify-start rounded-[8px] pt-2 ${active && !layout.hidden ? 'bg-sl-accent-soft text-sl-accent before:absolute before:top-3 before:bottom-3 before:-left-1 before:w-0.5 before:rounded before:bg-sl-accent' : 'text-sl-muted hover:bg-sl-subtle'}`}
                  onClick={() => openTab(t.id)}
                >
                  <Icon name={TAB_LOOK[t.id].icon} size={20} />
                  <span className="sr-only">{t.label}</span>
                </button>
                {n !== null && n > 0 && (
                  <span aria-hidden="true" data-testid="pn-rail-count" data-tab={t.id} className={`pointer-events-none absolute inset-x-0 bottom-1.5 text-center text-sl-label font-semibold tabular-nums ${active && !layout.hidden ? 'text-sl-accent' : 'text-sl-meta'}`}>
                    {n}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </nav>
    </>
  );
}
