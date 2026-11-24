import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { OverviewDto } from '@study-paper/shared/contracts/api';
import type { Citation } from '@study-paper/shared/contracts/domain';
import { overviewCitations, splitOverview } from '@study-paper/shared/overview';
import { StoredMarkup, useStoredPair } from '../markdown/renderStored';
import { useReaderStore } from '../state/readerStore';
import { usePanelApi } from './panelApi';
import { isActive, useRunStream } from './useRunStream';

const labels = ['문제·동기', '핵심 방법', '주요 결과', '한계', '기여'];
const empty: Citation[] = [];
const button = 'rounded-sl-control border border-sl-edge px-2.5 py-1 text-sl-ui font-semibold text-sl-ink hover:bg-sl-subtle disabled:opacity-50';

function Section({ body, citations }: { body: string; citations: Citation[] | null }) {
  const pair = useStoredPair(body, citations ?? empty);
  const jump = useReaderStore(s => s.jumpToCitation);
  return <StoredMarkup parsed={pair.parsed} paired={citations ? pair.paired : null} onCitationClick={jump} />;
}

function OverviewResult({ result }: { result: NonNullable<OverviewDto['result']> }) {
  const sections = useMemo(() => splitOverview(result.text), [result.text]);
  const evidence = useMemo(() => overviewCitations(result.text, result.citations), [result]);
  if (!sections) return <p role="alert">저장된 요약의 형식을 읽을 수 없습니다. 요약을 다시 만들어 주세요.</p>;
  return (
    <div data-testid="pn-overview-result" className="divide-y divide-sl-line">
      {sections.map((body, i) => (
        <section className="py-2" key={labels[i]}>
          <h3 className="mb-1 font-semibold text-sl-ink">{labels[i]}</h3>
          <Section body={body} citations={evidence?.[i] ?? null} />
        </section>
      ))}
    </div>
  );
}

export function OverviewPanel({ paperId, uploaded, unavailable }: { paperId: string; uploaded: boolean; unavailable?: string }) {
  const api = usePanelApi();
  const cache = useQueryClient();
  const saved = useQuery({
    queryKey: ['overview', paperId], staleTime: 0,
    queryFn: ({ signal }) => api.call('overview.get', { params: { id: paperId }, signal }),
  });
  const run = useRunStream({
    client: api,
    onSettled: () => { void cache.invalidateQueries({ queryKey: ['overview', paperId] }); },
  });
  const active = isActive(run.state);
  const sending = useRef(false);
  const lastAttach = useRef<string | null>(null);
  const { start, attach } = run;
  const connect = useCallback(async (regenerate: boolean, requestId?: string) => {
    if (sending.current) return;
    sending.current = true;
    const request = { route: 'overview.generate', params: { id: paperId }, body: { regenerate } } as const;
    try {
      if (requestId) {
        lastAttach.current = requestId;
        await attach(request, requestId);
      } else await start(request);
    } finally {
      sending.current = false;
    }
  }, [paperId, attach, start]);
  const pending = saved.data?.pending;
  useEffect(() => {
    if (!saved.isFetching && pending && !active && pending.clientRequestId !== lastAttach.current)
      void connect(pending.regenerate, pending.clientRequestId);
  }, [active, saved.isFetching, pending, connect]);
  const result = saved.data?.result;
  return (
    <section data-testid="pn-overview" aria-label="논문 한눈에 요약" className="min-h-0 overflow-y-auto pb-3 text-sl-ui text-sl-body">
      <p className="mb-2 text-sl-muted">읽기 전에 문제와 결과를 짚어 보는 AI 요약입니다.</p>
      {uploaded && <p data-testid="pn-overview-upload" className="mb-2 rounded-sl-control bg-sl-subtle p-2 text-sl-muted">
        업로드 PDF의 공부 자료는 원문 인용과 식 번호를 검증하지 않습니다. 설명과 수식은 PDF를 함께 보며 확인하세요.
      </p>}
      {saved.isError && <p role="alert">요약을 불러오지 못했습니다. <button type="button" className={button} onClick={() => void saved.refetch()}>다시 불러오기</button></p>}
      {saved.isPending && <p role="status">저장된 요약을 확인하고 있습니다.</p>}
      {active ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span role="status">{run.state.phase === 'queued' ? '요약 생성 순서를 기다리는 중입니다.' : '요약을 만들고 있습니다.'}</span>
          <button type="button" className={button} disabled={run.state.cancelling} onClick={() => void run.cancel()}>취소</button>
        </div>
      ) : saved.data && (
        <div className="mb-2">
          <button type="button" data-testid="pn-overview-generate" className={button}
            disabled={saved.isFetching || (!pending && !!unavailable)}
            onClick={() => void connect(pending?.regenerate ?? Boolean(result), pending?.clientRequestId)}>
            {pending ? '진행 중인 요약 다시 연결' : result ? '다시 만들기' : '요약 만들기'}
          </button>
          {unavailable && !pending && <p className="mt-1 text-sl-muted">{unavailable}</p>}
        </div>
      )}
      {run.state.error && !active && (!result || result.runId !== run.state.runId) && <p role="alert">{run.state.error.message}</p>}
      {result && <OverviewResult result={result} />}
    </section>
  );
}
