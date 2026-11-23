// Outline + reading progress (BRIEF_C C7, PLAN_M2 D13). Owner C.
// Sections from useStructure as a tree; a click jumps through the reader store (jumpToSection → position stack). A
// section without a PDF position is shown disabled ("PDF 위치를 찾지 못함") and never moves the viewer. The current
// section (readerStore.currentSectionId, set by the viewer) is highlighted. Each section has a 4-step reading state
// (progress.put); the header counts "이해 이상 n / 전체 m". Collapsed state per browser (localStorage).
// The state buttons work only once progress.list has answered (C-I10-03): while it loads or after it failed every
// section would look "안 읽음", and a click would write the next state over a stored one the user never saw. A failed
// list shows "읽기 상태를 불러오지 못했습니다" with 다시 시도; the buttons stay disabled until a read succeeds. That notice
// and the one of a failed PUT sit above the outline list, outside its scroll box, so a long outline (48 sections) does
// not hide them below the last item; until the states are read the count shows no value ("이해 이상 – / 전체 m"),
// not a 0 that looks stored (C-FX-03). The load notice sits in the flow (the buttons are disabled while it shows); the
// PUT notice is drawn over the top of the list (with 닫기) instead of pushing it down: the state buttons are clicked
// again and again on the same spot, and a list that moved under the pointer would send the next click to another
// section (C-FX4-R1-01). Its 닫기 is at the left end, away from the state buttons at the right end of the rows it
// covers: a click repeated there lands on the notice's text and does nothing, so the notice is not closed before it is
// read (C-FX4-R2-01). A later click that reaches a button clears it too.
// Without structure: "목차 없음" and, when the paper can be upgraded, the same upgrade control as the Library.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { JobDto, ProgressDto, SectionDto } from '@study-paper/shared/contracts/api';
import type { ReadingState } from '@study-paper/shared/contracts/domain';
import { api } from '../api/client';
import { qk } from '../api/queryKeys';
import { useStructure } from '../api/structure';
import { StructureUpgradeControl } from '../library/StructureUpgrade';
import { useUpgradeStore } from '../library/upgrade';
import { useReaderStore } from '../state/readerStore';
import { buildOutlineTree, nextReadingState, progressSummary, READING_STATE_KO, type OutlineNode } from './sections';

export const OUTLINE_COLLAPSED_KEY = 'sp.reader.outlineCollapsed';
export const NO_ANCHOR_TITLE = 'PDF 위치를 찾지 못함';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(OUTLINE_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(OUTLINE_COLLAPSED_KEY, v ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

/** concept_CD reading-state labels: dashed → plain → accent → filled, so the four differ in shape as well as colour. */
const STATE_TONE: Record<ReadingState, string> = {
  unread: 'border-dashed border-sl-edge text-sl-meta',
  skimmed: 'border-sl-edge bg-sl-subtle text-sl-muted',
  understood: 'border-sl-accent-line bg-sl-accent-soft text-sl-accent',
  reimplementable: 'border-transparent bg-sl-muted text-sl-surface',
};
const STATE_ORDER: readonly ReadingState[] = ['unread', 'skimmed', 'understood', 'reimplementable'];

export interface OutlineProps {
  paperId: string;
  uploaded?: boolean;
  /** structureUpgrade.available of papers.get (the upgrade control when there is no structure). */
  upgradeAvailable: boolean;
  upgradeJob?: JobDto | null;
}

export function Outline({ paperId, uploaded, upgradeAvailable, upgradeJob }: OutlineProps) {
  // keeps the control (and a final failure's reason) after papers.get turns available off (C-R1-04)
  const upgradeSeen = useUpgradeStore((s) => s.byPaper[paperId] !== undefined);
  const qc = useQueryClient();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const structure = useStructure(paperId);
  const currentSectionId = useReaderStore((s) => s.currentSectionId);
  const hasStructure = (structure.data?.sections.length ?? 0) > 0;
  const progress = useQuery({ queryKey: qk.progress(paperId), queryFn: () => api.call('progress.list', { params: { id: paperId } }), enabled: hasStructure });
  const states = useMemo(() => new Map((progress.data?.progress ?? []).map((p) => [p.sectionId, p.state] as const)), [progress.data]);
  // 'error' stays until a refetch succeeds (a failed reload after a failed PUT keeps the optimistic value: not trusted)
  const progressReady = progress.isSuccess;
  const [progressError, setProgressError] = useState<string | null>(null);

  const put = useMutation({
    mutationFn: (v: { sectionId: string; state: ReadingState }) => api.call('progress.put', { params: { id: paperId, sectionId: v.sectionId }, body: { state: v.state } }),
    onMutate: (v) => {
      setProgressError(null);
      // optimistic: the next click cycles from the state just shown
      qc.setQueryData<{ progress: ProgressDto[] }>(qk.progress(paperId), (old) => {
        const rest = (old?.progress ?? []).filter((p) => p.sectionId !== v.sectionId);
        return { progress: [...rest, { sectionId: v.sectionId, state: v.state, updatedAt: Date.now() }] };
      });
    },
    onError: (e) => {
      setProgressError(`읽기 상태를 저장하지 못했습니다: ${e.message}`);
      void qc.invalidateQueries({ queryKey: qk.progress(paperId) });
    },
  });

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  const sections = useMemo(() => structure.data?.sections ?? [], [structure.data]);
  const tree = useMemo(() => buildOutlineTree(sections), [sections]);
  const summary = progressSummary(sections, states);

  return (
    <nav className="flex h-full min-h-0 flex-col text-sl-ui" data-testid="rd-outline" aria-label="목차" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="shrink-0 px-4 pt-4 pb-3">
        <div className="flex items-baseline gap-1">
          <button type="button" className="self-center rounded px-0.5 text-sl-meta hover:bg-sl-subtle hover:text-sl-ink" data-testid="rd-outline-collapse" aria-expanded={!collapsed} title={collapsed ? '목차 펴기' : '목차 접기'} onClick={toggleCollapsed}>
            {collapsed ? '▸' : '▾'}
          </button>
          <strong className="text-sl-reading font-semibold text-sl-ink">목차</strong>
          {hasStructure && (
            <span className="ml-auto text-sl-label text-sl-meta tabular-nums" data-testid="rd-progress-summary">
              이해 이상 {progressReady ? summary.understood : '–'} / 전체 {summary.total}
            </span>
          )}
        </div>
        {uploaded && structure.data && (
          <p className="mt-1 text-sl-label text-sl-muted" data-testid="rd-upload-outline-source">
            {structure.data.structureSource === 'pdf-outline' ? 'PDF 책갈피에서 가져온 목차'
              : structure.data.structureSource === 'pdf-inferred' ? '추정된 구조 · 글자 크기와 배치 기준'
                : '이 PDF에서 절 제목을 구분하지 못했습니다.'}
          </p>
        )}
        {hasStructure && (
          <div className="mt-2 h-[3px] overflow-hidden rounded-sm bg-sl-line" role="progressbar" aria-label="이해 이상" aria-valuemin={0} aria-valuemax={summary.total} aria-valuenow={progressReady ? summary.understood : undefined}>
            <i className="block h-full rounded-sm bg-sl-sun" style={{ width: `${progressReady && summary.total ? (summary.understood * 100) / summary.total : 0}%` }} />
          </div>
        )}
      </div>
      {!collapsed && hasStructure && progress.isError && (
        <div className="shrink-0 border-b border-sl-line px-3">
          <p className="py-1.5 text-sl-label text-red-700" role="alert" data-testid="rd-progress-load-error">
            읽기 상태를 불러오지 못했습니다{' '}
            <button type="button" className="rounded border border-red-300 px-1 hover:bg-red-50 disabled:opacity-50" data-testid="rd-progress-retry" disabled={progress.isFetching} onClick={() => void progress.refetch()}>
              다시 시도
            </button>
          </p>
        </div>
      )}
      {!collapsed && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {progressError && (
            // drawn over the top of the list, not in its flow: the list keeps its place when the notice comes and goes,
            // so the next click on the same spot reaches the same section (C-FX4-R1-01). 닫기 is at the left end: the state
            // buttons are at the right end of each row, and a click repeated on a covered row's button lands on the text
            // (nothing happens, the notice stays to be read), not on 닫기 (C-FX4-R2-01)
            <div className="absolute inset-x-0 top-0 z-10 border-b border-red-200 bg-red-50 px-1 shadow-sm" data-testid="rd-progress-error-overlay">
              <p className="flex items-start gap-1 p-1 text-red-700" role="alert" data-testid="rd-progress-error">
                <button type="button" className="shrink-0 rounded border border-red-300 bg-white px-1 hover:bg-red-100" data-testid="rd-progress-error-close" aria-label="안내 닫기" title="안내 닫기" onClick={() => setProgressError(null)}>
                  닫기
                </button>
                <span className="min-w-0 flex-1">{progressError}</span>
              </p>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto px-2 pt-0.5 pb-3">
            {structure.isLoading && <p className="p-2 text-sl-meta">목차를 불러오는 중…</p>}
            {structure.isError && <p className="p-2 text-red-700">목차를 불러오지 못했습니다</p>}
            {!structure.isLoading && !hasStructure && (
              <div className="p-2 text-sl-meta" data-testid="rd-outline-empty">
                <p>목차 없음</p>
                {(upgradeAvailable || upgradeSeen) && (
                  <div className="mt-1">
                    <StructureUpgradeControl paperId={paperId} available={upgradeAvailable} job={upgradeJob ?? null} />
                  </div>
                )}
              </div>
            )}
            {hasStructure && (
              <ul data-testid="rd-outline-tree">
                {tree.map((n) => (
                  <OutlineItem
                    key={n.section.id}
                    node={n}
                    currentId={currentSectionId}
                    states={states}
                    stateReady={progressReady}
                    onCycle={(s) => {
                      if (progressReady) put.mutate({ sectionId: s.id, state: nextReadingState(states.get(s.id) ?? 'unread') });
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {hasStructure && (
        <div className="shrink-0 border-t border-sl-line px-3.5 pt-3 pb-4" data-testid="rd-progress-legend">
          <span className="text-sl-label text-sl-meta">절별 읽기 상태</span>
          <div className="mt-1.5 flex flex-wrap gap-1" aria-hidden="true">
            {STATE_ORDER.map((st) => (
              <span key={st} className={`inline-flex items-center rounded-[6px] border px-1.5 text-sl-label whitespace-nowrap ${STATE_TONE[st]}`}>
                {READING_STATE_KO[st]}
              </span>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}

function OutlineItem({ node, currentId, states, stateReady, onCycle }: { node: OutlineNode; currentId: string | null; states: ReadonlyMap<string, ReadingState>; stateReady: boolean; onCycle(s: SectionDto): void }) {
  const s = node.section;
  const anchored = s.pdfPage !== null;
  const current = s.id === currentId;
  const state = states.get(s.id) ?? 'unread';
  const label = `${s.number ? `${s.number} ` : ''}${s.title}`;
  return (
    <li data-testid="rd-outline-item" data-section-id={s.id} data-section-number={s.number ?? ''} data-current={current ? 'true' : 'false'}>
      <div
        className={`relative grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-[7px] py-2 pr-1.5 ${current ? 'bg-sl-accent-soft before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-0.5 before:rounded before:bg-sl-accent' : ''}`}
        style={{ paddingLeft: `${Math.min(6, Math.max(0, s.level - 1)) * 11 + 7}px` }}
      >
        <button
          type="button"
          className={`min-w-0 text-left leading-[19px] [overflow-wrap:anywhere] ${anchored ? (current ? 'font-semibold text-sl-ink' : 'text-sl-muted hover:text-sl-ink') : 'cursor-not-allowed text-gray-400'}`}
          data-testid="rd-outline-link"
          aria-disabled={anchored ? undefined : 'true'}
          aria-current={current ? 'location' : undefined}
          title={anchored ? label : NO_ANCHOR_TITLE}
          onClick={() => {
            if (anchored) void useReaderStore.getState().jumpToSection(s.id);
          }}
        >
          {label}
        </button>
        <button
          type="button"
          className={`mt-px shrink-0 rounded-[6px] border px-1.5 text-sl-label whitespace-nowrap ${STATE_TONE[state]} disabled:cursor-not-allowed disabled:opacity-50`}
          data-testid="rd-progress-toggle"
          data-state={state}
          disabled={!stateReady}
          aria-label={`${label} 읽기 상태 · ${READING_STATE_KO[state]}`}
          title={stateReady ? '읽기 상태 바꾸기' : '읽기 상태를 불러오는 중이거나 불러오지 못함'}
          onClick={() => onCycle(s)}
        >
          {READING_STATE_KO[state]}
        </button>
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <OutlineItem key={c.section.id} node={c} currentId={currentId} states={states} stateReady={stateReady} onCycle={onCycle} />
          ))}
        </ul>
      )}
    </li>
  );
}
