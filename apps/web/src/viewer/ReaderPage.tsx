import { SettingsLink, AiSetupHint, useAiSettings } from '../settings/SettingsPage';
// /paper/:id layout (PLAN 8.2): Outline · PdfReader · SidePanel (D). Owner C.
// M3a (PLAN_M3 §4, concept_CD): a grid of the left rail (logo · Library · day / night), the centred top bar (Library ·
// title | outline · zoom · page · 뒤로 | original colours at night · AI state · upgrade), the outline column (a drawer
// below OUTLINE_DOCK_MIN_PX), the one <main> with the warm canvas, and D's panel + right tab rail.
// M2: the top bar has "뒤로" (readerStore.canGoBack / back, also Alt+←) and the structure upgrade of an M1 paper; the
// left aside is the outline + reading progress (Outline.tsx); the reader restores PaperDetailDto.lastPosition.
// papers.get → readerStore.openPaper; while ingest runs and the context is not ready, the paper is re-read every
// 1.5 s and the state pushed with setPaperState (the AI buttons wait for contextReady).
// M1.1 M5: the store's contextReady is "AI usable with the current LLM" (PaperSummaryDto.ai), so a ready paper in
// contextMode 'text' keeps every AI button disabled with aiBlockedReason instead of failing with too_large.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { PaperDetailDto } from '@study-paper/shared/contracts/api';
import { api } from '../api/client';
import { qk } from '../api/queryKeys';
import { SidePanel } from '../panel/SidePanel';
import { aiStatus } from '../library/readiness';
import { StructureUpgradeControl } from '../library/StructureUpgrade';
import { useUpgradeStore } from '../library/upgrade';
import { useReaderStore, type PaperState } from '../state/readerStore';
import { Icon } from '../ui/icons';
import { useThemeStore } from '../ui/theme';
import { Outline } from './Outline';
import { StudyPathView } from './StudyPathView';
import { PdfReader } from './PdfReader';
import { LeftRail, OUTLINE_DOCK_MIN_PX, PaperInfoButton, PaperToneToggle, ReaderBarSlot, useMediaQuery, useReaderUiStore } from './ReaderChrome';

export const PAPER_POLL_MS = 1500;

/** Poll interval for papers.get: only while ingest is running and the AI context is not ready yet. */
export function paperPollInterval(p: PaperDetailDto | undefined): number | false {
  return p && p.ingestStatus === 'running' && !p.state.contextReady ? PAPER_POLL_MS : false;
}

/** Reader store state for a paper: contextReady = the AI is usable now, with the reason when it is not. */
export function readerPaperState(p: PaperDetailDto): PaperState {
  const ai = aiStatus(p);
  return { ...p.state, contextReady: ai.available, aiBlockedReason: ai.text };
}

export function ReaderPage({ paperId }: { paperId: string }) {
  const openPaper = useReaderStore((s) => s.openPaper);
  const setPaperState = useReaderStore((s) => s.setPaperState);
  const paper = useQuery({
    queryKey: qk.paper(paperId),
    queryFn: () => api.call('papers.get', { params: { id: paperId } }),
    refetchInterval: (q) => paperPollInterval(q.state.data),
  });
  const canGoBack = useReaderStore((s) => s.canGoBack);
  // An upgrade started or watched in this page keeps its control (steps, outcome) after papers.get says
  // available:false — e.g. a final failure must still show its reason (C-R1-04).
  const upgradeSeen = useUpgradeStore((s) => s.byPaper[paperId] !== undefined);
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!paper.data) return;
    const state = readerPaperState(paper.data);
    if (openedFor.current !== paperId) {
      openedFor.current = paperId;
      openPaper(paperId, state);
    } else setPaperState(state);
  }, [paper.data, paperId, openPaper, setPaperState]);

  const theme = useThemeStore((s) => s.theme);
  const tone = useThemeStore((s) => s.tone);
  const outlinePref = useReaderUiStore((s) => s.outlineOpen);
  const setOutlineOpen = useReaderUiStore((s) => s.setOutlineOpen);
  const wide = useMediaQuery(`(min-width: ${OUTLINE_DOCK_MIN_PX}px)`);
  // wide: a column, open unless the user closed it; narrow: a drawer over the PDF, closed until asked for
  const [drawerOpen, setDrawerOpen] = useState(false);
  const outlineDocked = wide && outlinePref !== false;
  const outlineShown = wide ? outlineDocked : drawerOpen;
  const outlineToggleRef = useRef<HTMLButtonElement>(null);
  const toggleOutline = () => (wide ? setOutlineOpen(!outlineDocked) : setDrawerOpen((o) => !o));
  const drawerRef = useRef<HTMLElement>(null);
  const closeDrawer = () => {
    setDrawerOpen(false);
    outlineToggleRef.current?.focus({ preventScroll: true });
  };
  // The drawer takes the focus when it opens; Esc closes it from anywhere in the reader (before the reader's own Esc).
  useEffect(() => {
    if (wide || !drawerOpen) return;
    drawerRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setDrawerOpen(false);
      outlineToggleRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [wide, drawerOpen]);
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);

  const [studyPaper, setStudyPaper] = useState<{ id: string; open: boolean } | null>(null);
  const studyOpen = studyPaper?.id === paperId && studyPaper.open;
  const studyToggle = useRef<HTMLButtonElement>(null);
  const closeStudy = () => {
    setStudyPaper({ id: paperId, open: false });
    studyToggle.current?.focus({ preventScroll: true });
  };
  const hasProvider = useAiSettings().data?.aiAvailable !== false;
  if (paper.isError) return <div className="p-4 text-red-700">논문을 불러오지 못했습니다: {String((paper.error as Error).message)}</div>;
  const p = paper.data;
  const outline = p && <Outline paperId={paperId} upgradeAvailable={p.structureUpgrade.available} upgradeJob={p.structureUpgrade.job} />;
  const ai = p ? aiStatus(p) : null;
  return (
    <div
      className="sl-reader grid h-full bg-sl-surface text-sl-ink"
      style={{ gridTemplateColumns: 'var(--spacing-sl-rail) auto minmax(0, 1fr) auto var(--spacing-sl-rail)', gridTemplateRows: 'var(--spacing-sl-bar) minmax(0, 1fr)' }}
      data-testid="rd-reader"
      data-theme-choice={theme}
      data-paper-tone={theme === 'dark' ? tone : 'original'}
    >
      <LeftRail />
      <header className="col-span-3 col-start-2 row-start-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-sl-line bg-sl-surface px-4 text-sl-ui whitespace-nowrap">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/" className="shrink-0 text-sl-muted hover:text-sl-ink">
            ← Library
          </Link>
          <h1 className="min-w-0 truncate border-l border-sl-line pl-2.5 font-semibold" data-testid="paper-title" title={p?.title}>
            {p?.title ?? '…'}
          </h1>
          {p && (
            <button
              ref={studyToggle} type="button" data-testid="rd-study-path-open" aria-pressed={studyOpen}
              className={`shrink-0 rounded-sl-control border px-2 py-1 font-semibold ${studyOpen ? 'border-sl-accent bg-sl-accent-soft text-sl-accent' : 'border-sl-edge text-sl-body hover:bg-sl-subtle'}`}
              onClick={() => setStudyPaper({ id: paperId, open: !studyOpen })}
            >
              학습 흐름
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5" data-testid="rd-bar-center">
          <button
            ref={outlineToggleRef}
            type="button"
            data-testid="rd-outline-toggle"
            aria-expanded={outlineShown}
            aria-controls="rd-outline-region"
            aria-label={outlineShown ? '목차 닫기' : '목차 열기'}
            title={outlineShown ? '목차 닫기' : '목차 열기'}
            className={`inline-grid size-8 place-items-center rounded-sl-control ${outlineShown ? 'bg-sl-subtle text-sl-ink' : 'text-sl-muted hover:bg-sl-subtle hover:text-sl-ink'}`}
            onClick={toggleOutline}
          >
            <Icon name="outline" size={18} />
          </button>
          <PaperInfoButton paper={p} />
          <span className="mx-1 h-[17px] w-px bg-sl-line" aria-hidden="true" />
          <div ref={setBarSlot} className="flex items-center gap-0.5" data-testid="rd-bar-viewer" />
          <button
            type="button"
            className="inline-grid size-8 place-items-center rounded-sl-control text-sl-muted hover:bg-sl-subtle hover:text-sl-ink disabled:opacity-40 disabled:hover:bg-transparent"
            data-testid="rd-back"
            disabled={!canGoBack}
            aria-label="뒤로"
            title="이전 위치로 (Alt+←)"
            onClick={() => useReaderStore.getState().back()}
          >
            <Icon name="back" size={18} />
          </button>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-2">
          <AiSetupHint /><SettingsLink />
          <PaperToneToggle />
          {p && hasProvider && ai?.available && (
            <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-sl-line px-2.5 text-sl-label text-sl-muted" data-testid="rd-ai-status" title="AI 사용 가능 · 사용 한도 미확인">
              <i className="size-1.5 rounded-full bg-sl-proof-ink" aria-hidden="true" />
              AI 사용 가능
            </span>
          )}
          {p && !p.state.contextReady && (
            <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-amber-100 px-2.5 text-sl-label text-amber-900" data-testid="context-pending">
              {p.ingestStatus === 'running' ? 'AI 색인 준비 중' : 'AI 색인 없음'}
            </span>
          )}
          {p && p.state.contextReady && !ai?.available && (
            <span className="inline-flex h-7 min-w-0 items-center truncate rounded-full bg-amber-100 px-2.5 text-sl-label text-amber-900" data-testid="ai-unavailable" data-reason={ai?.reason ?? undefined} title={ai?.text ?? undefined}>
              <span className="truncate">{ai?.text}</span>
            </span>
          )}
          {p && (p.structureUpgrade.available || upgradeSeen) && (
            <div className="relative max-w-md min-w-0 shrink" data-testid="rd-header-upgrade">
              <StructureUpgradeControl paperId={paperId} available={p.structureUpgrade.available} job={p.structureUpgrade.job} />
            </div>
          )}
        </div>
      </header>
      {outlineDocked && (
        <aside id="rd-outline-region" className="col-start-2 row-start-2 flex min-h-0 w-sl-outline flex-col border-r border-sl-line bg-sl-surface" data-testid="rd-outline-column">
          {outline}
        </aside>
      )}
      <main className="relative col-start-3 row-start-2 min-w-0 bg-sl-canvas">
        <div className="h-full" inert={studyOpen}>
          <ReaderBarSlot.Provider value={barSlot}>
            {p && p.state.readable && <PdfReader paperId={paperId} initialPosition={p.lastPosition} />}
          </ReaderBarSlot.Provider>
          {p && !p.state.readable && (
            <div className="p-4 text-sl-ui text-sl-muted" data-testid="reader-not-readable">
              {p.ingestStatus === 'running' ? 'PDF를 가져오는 중입니다…' : `PDF가 없습니다${p.lastJob?.error ? `: ${p.lastJob.error}` : ''}`}
            </div>
          )}
        </div>
        {p && studyPaper?.id === paperId && (
          <StudyPathView key={paperId} paper={p} open={studyOpen} onClose={closeStudy}
            canGenerate={hasProvider && ai?.available === true}
            unavailable={hasProvider ? ai?.text ?? '논문 색인을 확인하고 있습니다.' : '설정에서 AI 사용 방식을 선택하세요.'}
          />
        )}
        {!wide && drawerOpen && (
          <>
            <div className="absolute inset-0 z-30 bg-black/20" aria-hidden="true" data-testid="rd-outline-backdrop" onClick={closeDrawer} />
            <aside
              ref={drawerRef}
              id="rd-outline-region"
              role="dialog"
              aria-label="목차"
              tabIndex={-1}
              data-testid="rd-outline-drawer"
              className="absolute inset-y-0 left-0 z-40 flex w-sl-outline max-w-[85%] flex-col border-r border-sl-line bg-sl-surface shadow-sl-card outline-none"
            >
              {outline}
            </aside>
          </>
        )}
      </main>
      <SidePanel paperId={paperId} />
    </div>
  );
}
