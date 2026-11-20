// Structure badge (Library rows) and the upgrade control (Library row, reader header, outline). Owner C (C8).
// The badge is drawn from PaperSummaryDto alone (structureSource · supplementVersion · structureUpgradeAvailable).
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { JobDto, PaperSummaryDto } from '@study-paper/shared/contracts/api';
import { STEP_LABELS } from './jobs';
import { resumeUpgrade, startUpgrade, UPGRADE_CONFIRM_TEXT, useUpgradeStore } from './upgrade';

export type StructureBadgeKind = 'v2' | 'upgradable' | 'none';

/** Badge of a paper row; null while the paper is still being ingested (nothing settled yet). */
export function structureBadge(p: Pick<PaperSummaryDto, 'structureSource' | 'supplementVersion' | 'structureUpgradeAvailable' | 'ingestStatus'>): StructureBadgeKind | null {
  if (p.structureUpgradeAvailable) return 'upgradable';
  if (p.supplementVersion === 2) return 'v2';
  if (p.ingestStatus === 'running') return null;
  return 'none';
}

export const STRUCTURE_BADGE_KO: Record<StructureBadgeKind, string> = { v2: '색인 v2', upgradable: '구조 색인 만들 수 있음', none: '구조 없음' };
/** concept_CD chips: v2 = plain outline, upgradable = the accent, none = dashed (the shape differs, not only the colour). */
const BADGE_TONE: Record<StructureBadgeKind, string> = {
  v2: 'border-sl-line-strong text-sl-muted',
  upgradable: 'border-transparent bg-sl-accent-soft text-sl-accent',
  none: 'border-dashed border-sl-edge text-sl-meta',
};

export function StructureBadge({ paper }: { paper: Pick<PaperSummaryDto, 'structureSource' | 'supplementVersion' | 'structureUpgradeAvailable' | 'ingestStatus'> }) {
  const kind = structureBadge(paper);
  if (!kind) return null;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-sl-chip border px-1.5 text-sl-label whitespace-nowrap ${BADGE_TONE[kind]}`} data-testid="rd-structure-badge" data-kind={kind}>
      {STRUCTURE_BADGE_KO[kind]}
    </span>
  );
}

const STATUS_KO = { running: '진행 중', ok: '완료', skipped: '건너뜀', warn: '경고', error: '오류' } as const;

/**
 * "구조 색인 만들기" → confirmation → papers.upgradeStructure → steps → outcome. `available` = structureUpgrade.available
 * (reader) / structureUpgradeAvailable (Library); `job` = structureUpgrade.job when known (re-subscribe after a reload).
 */
export function StructureUpgradeControl({ paperId, available, job }: { paperId: string; available: boolean; job?: JobDto | null }) {
  const qc = useQueryClient();
  const state = useUpgradeStore((s) => s.byPaper[paperId]);
  const [confirming, setConfirming] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    resumeUpgrade(qc, paperId, job);
  }, [qc, paperId, job]);

  const running = state ? state.phase !== 'finished' : false;
  const outcome = state?.phase === 'finished' ? state.outcome : null;
  const canStart = available && !running && !starting && outcome?.kind !== 'final' && outcome?.kind !== 'done';

  const start = async () => {
    setConfirming(false);
    setStartError(null);
    setStarting(true);
    try {
      await startUpgrade(qc, paperId);
    } catch (e) {
      setStartError(`구조 색인을 시작하지 못했습니다: ${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  if (!available && !state && !startError) return null;
  return (
    <div className="text-xs" data-testid="rd-upgrade" data-paper-id={paperId}>
      {canStart && !confirming && (
        <button type="button" className="rounded-sl-chip border border-sl-accent-line px-2 py-0.5 text-sl-accent hover:bg-sl-accent-soft" data-testid="rd-upgrade-button" onClick={() => setConfirming(true)}>
          구조 색인 만들기
        </button>
      )}
      {confirming && (
        <div className="mt-1 rounded-sl-control border border-sl-line bg-sl-raised p-2 shadow-sl-card" data-testid="rd-upgrade-confirm" role="dialog" aria-label="구조 색인 만들기">
          <p className="mb-1 text-sl-body">{UPGRADE_CONFIRM_TEXT}</p>
          <div className="flex gap-1">
            <button type="button" className="rounded-sl-chip bg-sl-accent px-2 py-0.5 text-sl-on-accent" data-testid="rd-upgrade-confirm-yes" onClick={() => void start()}>
              만들기
            </button>
            <button type="button" className="rounded-sl-chip border border-sl-edge px-2 py-0.5" data-testid="rd-upgrade-confirm-no" onClick={() => setConfirming(false)}>
              취소
            </button>
          </div>
        </div>
      )}
      {state && state.progress.steps.length > 0 && (
        <ol className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-gray-600" data-testid="rd-upgrade-steps">
          {state.progress.steps.map((s) => (
            <li key={s.step} data-step={s.step} data-status={s.status}>
              {STEP_LABELS[s.step] ?? s.step}: {STATUS_KO[s.status]}
              {s.detail ? ` (${s.detail})` : ''}
            </li>
          ))}
        </ol>
      )}
      {running && (
        <div className="mt-1 text-gray-600" data-testid="rd-upgrade-running">
          구조 색인을 만드는 중…
        </div>
      )}
      {outcome?.kind === 'done' && (
        <div className="mt-1 text-green-800" data-testid="rd-upgrade-done">
          구조 색인을 만들었습니다.
        </div>
      )}
      {outcome && outcome.kind !== 'done' && (
        <div className="mt-1 text-red-700" role="alert" data-testid="rd-upgrade-error" data-kind={outcome.kind} data-code={outcome.kind === 'final' ? outcome.codes.join(',') : outcome.code}>
          {outcome.text}
        </div>
      )}
      {startError && (
        <div className="mt-1 text-red-700" role="alert" data-testid="rd-upgrade-start-error">
          {startError}
        </div>
      )}
    </div>
  );
}
