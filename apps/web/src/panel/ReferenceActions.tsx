import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'wouter';
import type { ReferenceDto } from '@study-paper/shared/contracts/api';
import { ApiError } from '../api/client';
import { qk } from '../api/queryKeys';
import { ExternalLink } from '../markdown/chips';
import { usePanelApi } from './panelApi';

const ARXIV_ID_RE = /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/i;

const arxivUrl = (id: string) => (ARXIV_ID_RE.test(id) ? `https://arxiv.org/abs/${id}` : null);
const doiUrl = (doi: string) => (/^10\.\d{4,9}\/\S+$/.test(doi) ? `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}` : null);

const buttonStyle = 'rounded-sl-control border border-sl-edge px-1.5 text-sl-accent hover:bg-sl-subtle';

type ImportState = { phase: 'idle' } | { phase: 'confirm' } | { phase: 'sending' } | { phase: 'done'; text: string; paperId: string } | { phase: 'error'; text: string };

function ImportButton({ paperId, arxivId }: { paperId: string; arxivId: string }) {
  const client = usePanelApi();
  const qc = useQueryClient();
  const [st, setSt] = useState<ImportState>({ phase: 'idle' });
  const send = async () => {
    setSt({ phase: 'sending' });
    try {
      const r = await client.call('papers.import', { body: { input: arxivId, clientRequestId: crypto.randomUUID() } });
      setSt({ phase: 'done', paperId: r.paperId, text: r.existing ? '이미 Library에 있습니다' : '가져오기를 시작했습니다 (Library에서 진행 확인)' });
      void qc.invalidateQueries({ queryKey: qk.papers });
      void qc.invalidateQueries({ queryKey: qk.structure(paperId) });
    } catch (e) {
      setSt({ phase: 'error', text: e instanceof ApiError && e.status === 409 ? '가져오기가 이미 진행 중이거나 다른 version이 있습니다' : '가져오지 못했습니다' });
    }
  };
  if (st.phase === 'done' || st.phase === 'error')
    return (
      <span data-testid="pn-ref-import-result" className="text-sl-muted">
        {st.text} {st.phase === 'done' && <LibraryLink paperId={st.paperId} />}
      </span>
    );
  if (st.phase === 'confirm' || st.phase === 'sending')
    return (
      <span role="dialog" aria-label="가져오기 확인" data-testid="pn-ref-import-confirm" className="inline-flex flex-wrap items-center gap-1 rounded border border-sl-edge bg-sl-subtle px-1.5">
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
    <button type="button" data-testid="pn-ref-import" className={buttonStyle} onClick={() => setSt({ phase: 'confirm' })}>
      가져오기
    </button>
  );
}

function LibraryLink({ paperId }: { paperId: string }) {
  const [, setLocation] = useLocation();
  return (
    <button type="button" data-testid="pn-ref-in-library" className={buttonStyle} title="Library에 있는 이 논문을 엽니다" onClick={() => setLocation(`/paper/${encodeURIComponent(paperId)}`)}>
      Library에 있음
    </button>
  );
}

type ReferenceIds = Pick<ReferenceDto, 'arxivId' | 'doi' | 'inLibraryPaperId'>;
export function ReferenceActions({ paperId, citation }: { paperId: string; citation: ReferenceIds }) {
  const arxiv = citation.arxivId && arxivUrl(citation.arxivId);
  const doi = citation.doi && doiUrl(citation.doi);
  return (
    <>
      {citation.inLibraryPaperId
        ? <LibraryLink paperId={citation.inLibraryPaperId} />
        : arxiv && citation.arxivId && <ImportButton paperId={paperId} arxivId={citation.arxivId} />}
      {arxiv && <ExternalLink href={arxiv}>{`arXiv ${citation.arxivId}`}</ExternalLink>}
      {doi && <ExternalLink href={doi}>{`DOI ${citation.doi}`}</ExternalLink>}
    </>
  );
}
