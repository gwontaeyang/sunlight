// Indexed references and user-initiated provider searches share the import and external-link confirmations.
import { memo, useEffect, useRef } from 'react';
import type { ReferenceDto } from '@study-paper/shared/contracts/api';
import { useStructure } from '../api/structure';
import { useReaderStore } from '../state/readerStore';
import { LoadError } from './loadError';
import { usePanelApi } from './panelApi';
import { ReferenceActions } from './ReferenceActions';
import { ReferenceFinder } from './ReferenceFinder';
import { NoStructureNotice, scrollIntoViewSafe } from './structureNotice';

const ReferenceRow = memo(function ReferenceRow({ r, paperId, focusTick }: { r: ReferenceDto; paperId: string; focusTick: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const focused = focusTick > 0;
  useEffect(() => {
    if (focusTick > 0) scrollIntoViewSafe(ref.current);
  }, [focusTick]);
  return (
    <li ref={ref} data-testid="pn-ref-item" data-ordinal={r.ordinal} data-focused={focused ? '1' : undefined} className={`border-b border-gray-100 px-2 py-1.5 text-xs ${focused ? 'bg-yellow-50 ring-1 ring-yellow-400' : ''}`}>
      <div className="whitespace-pre-wrap break-words">
        <span className="mr-1 font-medium">[{r.label ?? r.ordinal}]</span>
        {r.rawText}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-sl-label">
        <ReferenceActions paperId={paperId} citation={r} />
      </div>
      {!r.arxivId && !r.doi && <ReferenceFinder paperId={paperId} reference={r} />}
    </li>
  );
});

/** focusNonce: increases with every focus request (SidePanel), so asking for the same reference again scrolls again. */
export function ReferencesTab({ paperId, focusOrdinal = null, focusNonce = 1 }: { paperId: string; focusOrdinal?: number | null; focusNonce?: number }) {
  const client = usePanelApi();
  const structureReady = useReaderStore((s) => s.paperId === paperId && s.paperState.structureReady);
  const q = useStructure(paperId, { client });
  if (!structureReady) return <NoStructureNotice what="참고문헌 목록" />;
  // Review D-I10-02: a failed load offers "다시 시도"; a failed refetch keeps the list drawn from the last data.
  const loadError = q.isError && (
    <LoadError testId="pn-ref-load-error" text={q.data ? '참고문헌을 새로 불러오지 못했습니다 — 아래는 마지막으로 받은 목록입니다' : '참고문헌을 불러오지 못했습니다'} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  );
  if (q.data === undefined) return loadError || <div className="text-xs text-gray-500">불러오는 중…</div>;
  const refs = [...q.data.references].sort((a, b) => a.ordinal - b.ordinal);
  return (
    <div data-testid="pn-references-tab" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {loadError}
      {refs.length === 0 && <div className="text-xs text-gray-500">색인된 참고문헌이 없습니다</div>}
      <ul data-testid="pn-ref-list">
        {refs.map((r) => (
          <ReferenceRow key={`${paperId}/${r.id}`} r={r} paperId={paperId} focusTick={r.ordinal === focusOrdinal ? focusNonce : 0} />
        ))}
      </ul>
    </div>
  );
}
