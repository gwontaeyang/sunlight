import { useEffect, useRef, useState } from 'react';
import type { ApiResponse, ReferenceCandidate, ReferenceDto } from '@study-paper/shared/contracts/api';
import { ApiError } from '../api/client';
import { ExternalLink } from '../markdown/chips';
import { usePanelApi } from './panelApi';
import { ReferenceActions } from './ReferenceActions';

const providerName = { arxiv: 'arXiv', crossref: 'Crossref' };
const button = 'rounded-sl-control border border-sl-edge px-2 py-0.5 text-sl-accent hover:bg-sl-subtle disabled:opacity-50';

function searchError(error: unknown) {
  if (error instanceof ApiError && error.code === 'reference_search_unavailable') {
    const reason = (error.details as { reason?: string } | undefined)?.reason;
    switch (reason) {
      case 'network_off': return '외부 네트워크가 꺼져 있어 참고문헌을 검색할 수 없습니다.';
      case 'budget': return '이번 실행의 외부 요청 한도에 도달했습니다.';
      case 'busy': return '다른 검색을 처리하고 있습니다. 잠시 뒤 다시 검색해 주세요.';
      case 'timeout': return '검색 응답 시간이 초과됐습니다. 잠시 뒤 다시 검색해 주세요.';
    }
  }
  return '참고문헌을 검색하지 못했습니다. 잠시 뒤 다시 검색해 주세요.';
}

function Candidate({ paperId, candidate }: { paperId: string; candidate: ReferenceCandidate }) {
  return (
    <li data-testid="pn-ref-candidate" className="space-y-1 border-t border-sl-line py-2">
      <span data-testid="pn-ref-candidate-source" className="rounded-sl-chip bg-sl-subtle px-1.5 py-0.5 text-sl-label text-sl-muted">{providerName[candidate.source]}</span>
      <p className="break-words font-medium text-sl-ink">{candidate.title}</p>
      {(candidate.authors.length > 0 || candidate.year !== null) &&
        <p className="break-words text-sl-muted">{[candidate.authors.join(', '), candidate.year].filter(Boolean).join(' · ')}</p>}
      <div className="flex flex-wrap items-center gap-1 text-sl-label">
        <ReferenceActions paperId={paperId} citation={candidate} />
        {candidate.pdfUrl && <ExternalLink href={candidate.pdfUrl}>PDF 받기</ExternalLink>}
      </div>
      {candidate.source === 'crossref' && !candidate.pdfUrl &&
        <p className="text-sl-label text-sl-muted">공개 PDF 링크를 확인하지 못했습니다. DOI에서 접근 가능 여부를 확인하세요.</p>}
    </li>
  );
}

function initialQuery(reference: ReferenceDto): string {
  const title = reference.title?.trim();
  if (title) return title.replace(/\s+/g, ' ').slice(0, 512);
  // Raw bibliographies can contain initials and abbreviated venues. Split only on explicit title quotes.
  const raw = reference.rawText.replace(/\s+/g, ' ').trim();
  const quoted = /“([^”]+)”|"([^"]+)"/u.exec(raw);
  return ((quoted?.[1] ?? quoted?.[2])?.trim().replace(/[,;]$/, '') || raw).slice(0, 512);
}

export function ReferenceFinder({ paperId, reference }: { paperId: string; reference: ReferenceDto }) {
  const api = usePanelApi();
  const [query, setQuery] = useState(() => initialQuery(reference));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResponse<'references.find'> | null>(null);
  const [error, setError] = useState('');
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);

  async function search() {
    const title = query.trim();
    if (!title || current.current) return;
    const request = new AbortController();
    current.current = request;
    setBusy(true);
    setResult(null);
    setError('');
    const authors = reference.authors.map(s => s.trim().slice(0, 256)).filter(Boolean).slice(0, 12);
    const year = reference.year;
    try {
      const data = await api.call('references.find', {
        signal: request.signal,
        body: { title, ...(authors.length && { authors }), ...(year !== null && year >= 1000 && year <= 9999 && { year }) },
      });
      if (!request.signal.aborted) setResult(data);
    } catch (cause) {
      if (!request.signal.aborted) setError(searchError(cause));
    } finally {
      if (current.current === request && !request.signal.aborted) {
        current.current = null;
        setBusy(false);
      }
    }
  }

  function close() {
    current.current?.abort();
    current.current = null;
    setBusy(false);
    setOpen(false);
    setResult(null);
    setError('');
  }

  if (!open) return (
    <button type="button" data-testid="pn-ref-find" className={button} title="arXiv와 Crossref에서 이 참고문헌을 찾습니다"
      onClick={() => { setOpen(true); void search(); }}>
      찾아보기
    </button>
  );
  return (
    <div className="mt-2 space-y-2 rounded-sl-control border border-sl-line bg-sl-surface p-2 text-sl-ui">
      <form className="space-y-1" onSubmit={e => { e.preventDefault(); void search(); }}>
        <label className="block">
          검색할 논문 제목
          <input type="search" data-testid="pn-ref-query" value={query} maxLength={512} disabled={busy}
            onChange={e => { setQuery(e.target.value); setResult(null); setError(''); }}
            className="mt-1 block w-full rounded-sl-control border border-sl-edge bg-sl-canvas px-2 py-1 text-sl-ink" />
        </label>
        <p className="text-sl-label text-sl-muted">검색어와 색인된 저자·연도를 arXiv와 Crossref로 보냅니다.</p>
        <div className="flex items-center gap-2">
          <button type="submit" data-testid="pn-ref-search" disabled={busy || !query.trim()} className={button}>검색</button>
          <button type="button" data-testid="pn-ref-find-close" onClick={close} className={button}>닫기</button>
          {busy && <span role="status" className="text-sl-muted">검색 중…</span>}
        </div>
      </form>
      {error && <p role="alert" data-testid="pn-ref-find-error">{error}</p>}
      {result && (
        <>
          {result.unavailable.length > 0 && <p role="status" data-testid="pn-ref-find-partial" className="text-sl-muted">
            {result.unavailable.map(s => providerName[s]).join(', ')} 검색 결과를 받지 못했습니다.
          </p>}
          {result.candidates.length === 0
            ? <p role="status" data-testid="pn-ref-find-empty">일치하는 후보가 없습니다. 제목을 바꿔 보세요.</p>
            : <>
              <p className="text-sl-muted">제목이 비슷한 논문입니다. 가져오기 전에 저자와 연도를 확인하세요.</p>
              <ul aria-label="검색 후보" className="space-y-1">
                {result.candidates.map(candidate => <Candidate key={`${candidate.source}:${candidate.arxivId ?? candidate.doi}`} candidate={candidate} paperId={paperId} />)}
              </ul>
            </>}
        </>
      )}
    </div>
  );
}
