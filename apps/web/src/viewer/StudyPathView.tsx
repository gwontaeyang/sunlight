import { useCallback, useDeferredValue, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaperDetailDto, StructureResponse } from '@study-paper/shared/contracts/api';
import type { Citation } from '@study-paper/shared/contracts/domain';
import { splitStudyPath, studyPathCitations } from '@study-paper/shared/study-path';
import { usePanelApi } from '../panel/panelApi';
import { equationById, referenceByOrdinal, useStructure } from '../api/structure';
import { ExternalLink, StructureContext, StudyPathLinkContext } from '../markdown/chips';
import { StoredMarkup, useStoredPair } from '../markdown/renderStored';
import { isActive, useRunStream } from '../panel/useRunStream';
import { useReaderStore } from '../state/readerStore';

const stageNames = ['문제와 배경', '기존 방법과 한계', '논문이 바꾼 것', '핵심 수식', '구현 가이드', '스스로 확인', '다음에 읽을 것'];
const noCitations: Citation[] = [];
const control = 'rounded-sl-control border border-sl-edge bg-sl-surface px-3 py-1.5 text-sl-ui font-semibold text-sl-body hover:bg-sl-subtle disabled:opacity-50';
const primary = 'rounded-sl-control bg-sl-accent px-3.5 py-2 text-sl-ui font-semibold text-sl-on-accent disabled:opacity-50';
const jumpLink = 'rounded-sl-control border border-sl-edge px-2.5 py-1 text-left text-sl-ui text-sl-accent hover:bg-sl-accent-soft';

type Stage = ReturnType<typeof splitStudyPath>['stages'][number];

function StudyStage({ stage, citations, streaming, structure, children, onClose }: {
  stage: Stage;
  citations: readonly Citation[] | null;
  streaming: boolean;
  structure?: StructureResponse;
  children?: ReactNode;
  onClose(): void;
}) {
  const pair = useStoredPair(stage.body, citations ?? noCitations, { final: !streaming });
  const jump = useReaderStore((s) => s.jumpToCitation);
  const focusPanel = useReaderStore((s) => s.focusPanel);
  // Only paired, stored ids belonging to this paper may open the equation panel.
  const equationIds = new Set<string>();
  if (stage.number === 4 && citations && !streaming && pair.paired) {
    for (const c of pair.paired.values()) {
      if (c.kind === 'equation' && (c.status === 'resolved' || c.status === 'no_anchor') && c.equationId)
        equationIds.add(c.equationId);
    }
  }
  return (
    <section data-testid={`rd-study-stage-${stage.number}`} className="space-y-3 break-words border-t border-sl-line py-6">
      <h3 className="flex items-baseline gap-3 text-sl-heading font-semibold">
        <span className="text-sl-ui text-sl-accent">{String(stage.number).padStart(2, '0')}</span>
        {stageNames[stage.number - 1]}
      </h3>
      {stage.number === 5 && (
        <p className="text-sl-label text-sl-muted">직접 만든 학습용 예시 — 논문 공식 구현 아님</p>
      )}
      <StoredMarkup parsed={pair.parsed} paired={citations === null ? null : pair.paired}
        phase={streaming ? 'streaming' : 'final'}
        onCitationClick={(c) => { onClose(); return jump(c); }}
      />
      {[...equationIds].map((id) => {
        const eq = equationById(structure, id);
        return eq && (
          <button key={id} type="button" data-testid={`rd-study-equation-${id}`} className={jumpLink}
            onClick={() => focusPanel({ tab: 'equations', equationId: id })}>
            식 ({eq.number}) · 수식 탭에서 보기
          </button>
        );
      })}
      {children}
    </section>
  );
}

export function StudyPathView({ paper, open, onClose, canGenerate, unavailable }: {
  paper: Pick<PaperDetailDto, 'id' | 'title' | 'codeUrl'>;
  open: boolean;
  onClose(): void;
  canGenerate: boolean;
  unavailable: string;
}) {
  const id = paper.id;
  const api = usePanelApi();
  const client = useQueryClient();
  const key = ['study-path', id];
  const saved = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.call('studyPath.get', { params: { id }, signal }),
    enabled: open, staleTime: 0,
  });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const run = useRunStream({ client: api, onSettled: () => { void refresh(); } });
  const active = isActive(run.state);
  const result = saved.data?.result;
  const pending = saved.data?.pending;
  const clickLock = useRef(false);
  const check = useMutation({
    mutationFn: (body: { runId: string; index: number; checked: boolean }) =>
      api.call('studyPath.check', { params: { id }, body }),
    onSuccess: (data) => { client.setQueryData(key, data); },
    onError: () => { void refresh(); },
  });
  const structure = useStructure(id, { client: api });
  const focusPanel = useReaderStore((s) => s.focusPanel);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open) heading.current?.focus({ preventScroll: true });
  }, [open]);
  const openEquation = useCallback((equationId: string) => {
    if (equationById(structure.data, equationId)) focusPanel({ tab: 'equations', equationId });
  }, [focusPanel, structure.data]);
  const preview = useDeferredValue(run.state.text);
  const displayingPreview = active && !!preview;
  const text = displayingPreview ? preview : result?.text ?? '';
  const parsed = useMemo(() => splitStudyPath(text), [text]);
  const citations = useMemo(
    () => result && !displayingPreview ? studyPathCitations(result.text, result.citations) : null,
    [result?.text, result?.citations, displayingPreview],
  );
  const interrupted = run.state.error && (run.state.error.source === 'stream' || run.state.error.source === 'aborted' || run.state.error.code === 'network');
  const reconnect = !!pending || !!interrupted;
  async function generate() {
    if (clickLock.current || active || !saved.data) return;
    clickLock.current = true;
    try {
      const req = { route: 'studyPath.generate', params: { id }, body: { regenerate: pending?.regenerate ?? Boolean(result) } } as const;
      if (pending) await run.attach(req, pending.clientRequestId);
      else if (interrupted) await run.retry();
      else if (canGenerate) await run.start(req);
    } finally {
      clickLock.current = false;
    }
  }
  return (
    <section hidden={!open} aria-label="논문 학습 흐름" data-testid="rd-study-path"
      className="absolute inset-0 z-20 overflow-auto overscroll-contain bg-sl-canvas text-sl-body">
      <div className="mx-auto max-w-3xl px-3 py-4 sm:px-6">
        <div className="rounded-sl-card border border-sl-line bg-sl-surface px-4 py-5 sm:px-7 sm:py-6">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 tabIndex={-1} ref={heading} className="text-sl-title font-semibold text-sl-ink outline-none">논문 학습 흐름</h2>
              <p className="mt-1 break-words text-sl-ui text-sl-muted">{paper.title}</p>
            </div>
            <button type="button" data-testid="rd-study-path-close" className={control} onClick={onClose}>PDF로</button>
          </header>

          {saved.isPending && <p role="status">저장한 학습 흐름을 불러오는 중입니다.</p>}
          {saved.isError && <p role="alert">학습 흐름을 불러오지 못했습니다. <button className={control} onClick={() => void saved.refetch()}>다시 불러오기</button></p>}
          {saved.data && (
            <div className="mb-4 space-y-3">
              {!result && !active && <p className="text-sl-reading">기존 방법에서 출발해 논문의 수식과 구현 예시까지 차례로 읽어 보세요.</p>}
              {result && !displayingPreview && (
                <p data-testid="rd-study-saved" className="text-sl-ui text-sl-muted">
                  저장된 학습 흐름 · {result.codeLanguage === 'python' ? 'Python' : 'C++17 · Eigen'}
                </p>
              )}
              {active ? (
                <div className="flex flex-wrap items-center gap-2 text-sl-ui text-sl-muted">
                  <span role="status">{run.state.phase === 'queued' ? '생성 순서를 기다리는 중입니다.' : '학습 흐름을 작성하고 있습니다.'}</span>
                  {run.state.runId && <button className={control} type="button" onClick={() => void run.cancel()} disabled={run.state.cancelling}>중단</button>}
                </div>
              ) : (
                <button type="button" data-testid={result ? 'rd-study-path-regenerate' : 'rd-study-path-generate'}
                  className={result ? control : primary} disabled={(!canGenerate && !reconnect) || saved.isFetching || check.isPending}
                  onClick={() => void generate()}>
                  {reconnect ? '진행 중인 요청 다시 연결' : result ? '다시 만들기' : '학습 흐름 만들기'}
                </button>
              )}
              {!canGenerate && <p className="text-sl-ui text-sl-muted">{unavailable}</p>}
              {run.state.error && <p role="alert" className="text-sl-ui">{run.state.error.message}</p>}
            </div>
          )}

          {saved.data && !text && !active && <ol className="list-decimal space-y-1 border-t border-sl-line py-4 pl-6 text-sl-reading">
            {stageNames.map((name) => <li key={name}>{name}</li>)}
          </ol>}
          <StructureContext.Provider value={structure.data}>
            <StudyPathLinkContext.Provider value={openEquation}>
              {parsed.stages.map((stage, pos) => (
                <StudyStage key={stage.number} stage={stage} streaming={displayingPreview}
                  citations={citations?.[pos] ?? null} structure={structure.data} onClose={onClose}>
                  {stage.number === 5 && paper.codeUrl && (
                    <p className="text-sl-ui"><ExternalLink href={paper.codeUrl}>논문에 실린 코드 주소</ExternalLink></p>
                  )}
                  {stage.number === 6 && parsed.checklist.length > 0 && (
                    <fieldset disabled={displayingPreview || active || !!pending || check.isPending || !result} className="space-y-2">
                      <legend className="mb-2 text-sl-ui font-semibold">구현 체크리스트</legend>
                      {parsed.checklist.map((label, index) => (
                        <label key={index} className="flex items-start gap-2 text-sl-reading">
                          <input type="checkbox" data-testid={`rd-study-check-${index}`} className="mt-1.5 accent-sl-accent"
                            checked={!displayingPreview && !!result?.checked[index]}
                            onChange={(e) => result && check.mutate({ runId: result.runId, index, checked: e.currentTarget.checked })} />
                          {label}
                        </label>
                      ))}
                      {check.isError && <p role="alert" className="text-sl-ui">체크 상태를 저장하지 못했습니다. 표시된 상태를 확인하고 다시 시도하세요.</p>}
                    </fieldset>
                  )}
                  {stage.number === 7 && !displayingPreview && parsed.referenceOrdinals.map((ordinal) => {
                    const ref = referenceByOrdinal(structure.data, ordinal);
                    return ref ? (
                      <button key={ordinal} type="button" data-testid={`rd-study-reference-${ordinal}`} className={`block ${jumpLink}`}
                        onClick={() => focusPanel({ tab: 'references', referenceOrdinal: ordinal })}>
                        [{ordinal}] {ref.title ?? ref.rawText}
                      </button>
                    ) : <p key={ordinal} className="text-sl-ui text-sl-muted">[{ordinal}] 참고문헌 색인에서 확인되지 않음</p>;
                  })}
                </StudyStage>
              ))}
            </StudyPathLinkContext.Provider>
          </StructureContext.Provider>
        </div>
      </div>
    </section>
  );
}
