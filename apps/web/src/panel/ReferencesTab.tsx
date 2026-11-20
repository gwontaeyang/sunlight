// References tab (BRIEF_D D6): the [n] list as plain text, "Library에 있음" (opens that paper) when inLibraryPaperId is
// set, otherwise "가져오기" for an arXiv id (papers.import — the confirmation shows the id), DOI / arXiv pages only
// through the "열기" host confirmation (no link from reference text). panelFocus.referenceOrdinal highlights an item.
// S2 metadata (title, year, citation count) is M3. A failed structure load offers "다시 시도" (review D-I10-02). Owner D.
import { useQueryClient } from '@tanstack/react-query';
import { memo, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import type { ReferenceDto } from '@study-paper/shared/contracts/api';
import { useStructure } from '../api/structure';
import { qk } from '../api/queryKeys';
import { ApiError } from '../api/client';
import { ExternalLink } from '../markdown/chips';
import { useReaderStore } from '../state/readerStore';
import { LoadError } from './loadError';
import { usePanelApi } from './panelApi';
import { NoStructureNotice, scrollIntoViewSafe } from './structureNotice';

const ARXIV_ID_RE = /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/i;

const arxivUrl = (id: string) => (ARXIV_ID_RE.test(id) ? `https://arxiv.org/abs/${id}` : null);
const doiUrl = (doi: string) => (/^10\.\d{4,9}\/\S+$/.test(doi) ? `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}` : null);

type ImportState = { phase: 'idle' } | { phase: 'confirm' } | { phase: 'sending' } | { phase: 'done'; text: string } | { phase: 'error'; text: string };

function ImportButton({ paperId, arxivId }: { paperId: string; arxivId: string }) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const [st, setSt] = useState<ImportState>({ phase: 'idle' });
  const send = async () => {
    setSt({ phase: 'sending' });
    try {
      const r = await client.call('papers.import', { body: { input: arxivId, clientRequestId: crypto.randomUUID() } });
      setSt({ phase: 'done', text: r.existing ? '이미 Library에 있습니다' : '가져오기를 시작했습니다 (Library에서 진행 확인)' });
      void qc.invalidateQueries({ queryKey: qk.papers });
      void qc.invalidateQueries({ queryKey: qk.structure(paperId) });
    } catch (e) {
      setSt({ phase: 'error', text: e instanceof ApiError && e.status === 409 ? '가져오기가 이미 진행 중이거나 다른 version이 있습니다' : '가져오지 못했습니다' });
    }
  };
  if (st.phase === 'done' || st.phase === 'error')
    return (
      <span data-testid="pn-ref-import-result" className={st.phase === 'error' ? 'text-red-700' : 'text-emerald-700'}>
        {st.text}
      </span>
    );
  if (st.phase === 'confirm' || st.phase === 'sending')
    return (
      <span role="dialog" aria-label="가져오기 확인" data-testid="pn-ref-import-confirm" className="inline-flex flex-wrap items-center gap-1 rounded border border-amber-400 bg-amber-50 px-1.5">
        <span>arXiv {arxivId}을(를) Library로 가져올까요?</span>
        <button type="button" data-testid="pn-ref-import-go" className="rounded bg-sl-accent px-1.5 text-sl-on-accent disabled:opacity-50" disabled={st.phase === 'sending'} onClick={() => void send()}>
          가져오기
        </button>
        <button type="button" className="rounded border px-1.5" onClick={() => setSt({ phase: 'idle' })}>
          취소
        </button>
      </span>
    );
  return (
    <button type="button" data-testid="pn-ref-import" className="rounded border border-blue-600 px-1.5 text-blue-700" onClick={() => setSt({ phase: 'confirm' })}>
      가져오기
    </button>
  );
}

const ReferenceRow = memo(function ReferenceRow({ r, paperId, focusTick }: { r: ReferenceDto; paperId: string; focusTick: number }) {
  const [, setLocation] = useLocation();
  const ref = useRef<HTMLLIElement>(null);
  const focused = focusTick > 0;
  useEffect(() => {
    if (focusTick > 0) scrollIntoViewSafe(ref.current);
  }, [focusTick]);
  const arxiv = r.arxivId ? arxivUrl(r.arxivId) : null;
  const doi = r.doi ? doiUrl(r.doi) : null;
  return (
    <li ref={ref} data-testid="pn-ref-item" data-ordinal={r.ordinal} data-focused={focused ? '1' : undefined} className={`border-b border-gray-100 px-2 py-1.5 text-xs ${focused ? 'bg-yellow-50 ring-1 ring-yellow-400' : ''}`}>
      <div className="whitespace-pre-wrap break-words">
        <span className="mr-1 font-medium">[{r.label ?? r.ordinal}]</span>
        {r.rawText}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-sl-label">
        {r.inLibraryPaperId ? (
          <button type="button" data-testid="pn-ref-in-library" className="rounded border border-emerald-600 bg-emerald-50 px-1.5 text-emerald-800" title="Library에 있는 이 논문을 엽니다" onClick={() => setLocation(`/paper/${encodeURIComponent(r.inLibraryPaperId!)}`)}>
            Library에 있음
          </button>
        ) : (
          r.arxivId && <ImportButton paperId={paperId} arxivId={r.arxivId} />
        )}
        {arxiv && <ExternalLink href={arxiv}>{`arXiv ${r.arxivId}`}</ExternalLink>}
        {doi && <ExternalLink href={doi}>{`DOI ${r.doi}`}</ExternalLink>}
      </div>
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
          <ReferenceRow key={r.id} r={r} paperId={paperId} focusTick={r.ordinal === focusOrdinal ? focusNonce : 0} />
        ))}
      </ul>
    </div>
  );
}
