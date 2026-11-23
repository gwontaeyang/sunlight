import { SettingsLink, AiSetupHint } from '../settings/SettingsPage';
// Library (PLAN 8.5, M1): arXiv import with job progress, paper list with ingest state, open, delete (with
// confirmation), retry of a failed ingest. Owner C. The local PDF importer completes before its row is shown.
// After a reload, papers whose ingest is still running are re-subscribed with lastJob.id (papers.get); without
// a job id the list is polled.
// M2 (BRIEF_C C8): structure badge per row from papers.list alone; rows that can be upgraded get the upgrade control
// (their papers.get is read only to find a running upgrade job after a reload — structureUpgrade.job).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import type { ImportPaperResponse, PaperSummaryDto } from '@study-paper/shared/contracts/api';
import { api } from '../api/client';
import { qk } from '../api/queryKeys';
import { formatStoredJobError, STEP_LABELS, useJobProgress, type JobProgress } from './jobs';
import { Icon, Wordmark } from '../ui/icons';
import { ThemeSwitch } from '../ui/theme';
import { PdfUpload } from './PdfUpload';
import { UploadPaperTitle } from './UploadPaperTitle';
import { aiStatus } from './readiness';
import { StructureBadge, StructureUpgradeControl } from './StructureUpgrade';

export const LIST_POLL_MS = 1500;

/**
 * User-facing ingest state of a paper (PLAN 4.1 states + failure). A ready paper the current LLM cannot use
 * (contextMode 'text', M3) is "읽기 가능 · AI 미지원", not "AI 사용 가능" (M1.1 M5).
 */
export function paperStatusLabel(p: Pick<PaperSummaryDto, 'ingestStatus' | 'state'> & Partial<Pick<PaperSummaryDto, 'ai' | 'pageCount'>>): { label: string; tone: 'busy' | 'ok' | 'warn' | 'error' } {
  if (p.ingestStatus === 'failed' || p.ingestStatus === 'interrupted') return { label: p.ingestStatus === 'failed' ? '실패' : '중단됨', tone: 'error' };
  if (p.state.contextReady) return aiStatus({ pageCount: null, ...p }).available ? { label: 'AI 사용 가능', tone: 'ok' } : { label: '읽기 가능 · AI 미지원', tone: 'warn' };
  if (p.state.readable) return { label: '색인 준비 중', tone: p.ingestStatus === 'running' ? 'busy' : 'warn' };
  return { label: '가져오는 중', tone: 'busy' };
}

/** Notice for an import answered with an existing paper of another arXiv version (PLAN 4.1: one version per paper). */
export function existingVersionNotice(r: ImportPaperResponse): string | null {
  if (!r.existing) return null;
  if (r.requestedVersion !== undefined && r.existingVersion !== undefined && r.requestedVersion !== r.existingVersion)
    return `이미 v${r.existingVersion}이(가) Library에 있습니다. 요청한 v${r.requestedVersion}은(는) 가져오지 않았습니다 (논문당 한 버전만 보관).`;
  return '이미 Library에 있는 논문입니다.';
}

/** Status chip per tone (M3a, concept_CD): the colour is never the only cue — the chip always carries its words. */
const TONE: Record<string, string> = {
  busy: 'border-transparent bg-sl-accent-soft text-sl-accent',
  ok: 'border-transparent bg-sl-proof-bg text-sl-proof-ink',
  warn: 'border-amber-300 bg-amber-50 text-amber-900',
  error: 'border-red-300 bg-red-50 text-red-800',
};
/** A small label chip (12 px / 18 px, concept_CD `.chip`). */
export const CHIP = 'inline-flex shrink-0 items-center rounded-sl-chip border px-1.5 text-sl-label whitespace-nowrap';

export function LibraryPage() {
  const qc = useQueryClient();
  const { jobs, watch } = useJobProgress();
  const [input, setInput] = useState('');
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const papers = useQuery({
    queryKey: qk.papers,
    queryFn: () => api.call('papers.list'),
    refetchInterval: (q) => (q.state.data?.papers.some((p) => p.ingestStatus === 'running') ? LIST_POLL_MS : false),
  });
  const importPaper = useMutation({
    mutationFn: (value: string) => api.call('papers.import', { body: { input: value, clientRequestId: crypto.randomUUID() } }),
    onSuccess: (r) => {
      setMessage(existingVersionNotice(r) ? { text: existingVersionNotice(r)! } : r.jobId ? { text: '가져오기를 시작했습니다.' } : null);
      if (r.jobId) watch(r.jobId, r.paperId);
      setInput('');
      void qc.invalidateQueries({ queryKey: qk.papers });
    },
    onError: (e) => setMessage({ text: `가져오지 못했습니다: ${e.message}`, error: true }),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const v = input.trim();
    if (!v || importPaper.isPending) return;
    setMessage(null);
    importPaper.mutate(v);
  };

  const byPaper = new Map<string, JobProgress>();
  for (const j of Object.values(jobs)) byPaper.set(j.paperId, j);

  const count = papers.data?.papers.length;
  return (
    <div className="min-h-full bg-sl-surface text-sl-ink">
      <header className="flex min-h-14 items-center justify-between border-b border-sl-line px-[clamp(18px,5vw,72px)]">
        <Wordmark />
        <div className="flex items-center gap-2"><AiSetupHint /><SettingsLink /><ThemeSwitch /></div>
      </header>
      <main className="mx-auto max-w-[928px] px-6 pt-12 pb-16">
        <div className="mb-5 flex items-baseline gap-3">
          <h1 className="text-[32px] leading-[42px] font-semibold tracking-[-1.3px]">Library</h1>
          {count !== undefined && (
            <span className="text-sl-label text-sl-meta" data-testid="rd-library-count">
              논문 {count}편
            </span>
          )}
        </div>
        <div className="mb-2 grid items-start gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
          <form className="flex min-w-0 gap-2" onSubmit={onSubmit}>
            <label className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-sl-control border border-sl-edge bg-sl-surface px-3 text-sl-muted focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-sl-accent">
              <Icon name="import" size={16} />
              <span className="text-sl-ui font-semibold text-sl-body">arXiv</span>
              <input
                className="min-w-0 flex-1 bg-transparent text-sl-reading text-sl-ink outline-none focus-visible:outline-none"
                placeholder="arXiv ID 또는 URL (예: 2209.15397, https://arxiv.org/abs/2209.15397v2)"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={500}
                data-testid="import-input"
                aria-label="arXiv ID 또는 URL"
              />
            </label>
            <button
              type="submit"
              className="inline-flex h-11 items-center gap-2 rounded-sl-control bg-sl-accent px-4 text-sl-ui font-semibold text-sl-on-accent disabled:bg-sl-subtle disabled:text-sl-meta"
              disabled={!input.trim() || importPaper.isPending}
              data-testid="import-button"
            >
              {importPaper.isPending ? '요청 중…' : '가져오기'}
              <Icon name="arrow" size={15} />
            </button>
          </form>
          <PdfUpload />
        </div>
        {message && (
          <p role={message.error ? 'alert' : 'status'} className={`mb-2 text-sl-ui ${message.error ? 'text-red-700' : 'text-sl-muted'}`} data-testid="import-message">
            {message.text}
          </p>
        )}
        <div className="mt-6">
          {papers.isLoading && <p className="text-sl-ui text-sl-meta">불러오는 중…</p>}
          {papers.isError && <p className="text-sl-ui text-red-700">목록을 불러오지 못했습니다: {(papers.error as Error).message}</p>}
          {papers.data && papers.data.papers.length === 0 && (
            <div className="rounded-sl-control border border-dashed border-sl-line-strong px-4 py-8 text-center text-sl-ui text-sl-muted" data-testid="rd-library-empty">
              <p>아직 논문이 없습니다.</p>
              <p className="mt-1 text-sl-label text-sl-meta">arXiv 주소를 입력하거나 가지고 있는 PDF를 올려 보세요.</p>
            </div>
          )}
          <ul className={papers.data?.papers.length ? 'border-t border-sl-edge' : ''} data-testid="paper-list">
            {papers.data?.papers.map((p) => <PaperRow key={p.id} paper={p} progress={byPaper.get(p.id)} watch={watch} />)}
          </ul>
        </div>
      </main>
    </div>
  );
}

function PaperRow({ paper: p, progress, watch }: { paper: PaperSummaryDto; progress?: JobProgress; watch(jobId: string, paperId: string): void }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const needsDetail = p.ingestStatus !== 'done';
  // Detail only for running / failed papers (lastJob: the job id to re-subscribe and the failure reason) and for
  // upgradable ones (structureUpgrade.job: a running upgrade to re-subscribe).
  const detail = useQuery({ queryKey: qk.paper(p.id), queryFn: () => api.call('papers.get', { params: { id: p.id } }), enabled: needsDetail || p.structureUpgradeAvailable });
  const lastJob = detail.data?.lastJob ?? null;
  useEffect(() => {
    if (p.ingestStatus === 'running' && lastJob?.id && lastJob.status === 'running') watch(lastJob.id, p.id);
  }, [p.ingestStatus, p.id, lastJob?.id, lastJob?.status, watch]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.papers });
    void qc.invalidateQueries({ queryKey: qk.paper(p.id) });
  };
  const del = useMutation({
    mutationFn: () => api.call('papers.delete', { params: { id: p.id } }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: qk.paper(p.id) });
      void qc.invalidateQueries({ queryKey: qk.papers });
    },
    onError: (e) => setRowError(`삭제하지 못했습니다: ${e.message}`),
  });
  const retry = useMutation({
    mutationFn: () => api.call('papers.retryIngest', { params: { id: p.id } }),
    onSuccess: (r) => {
      watch(r.jobId, p.id);
      refresh();
    },
    onError: (e) => setRowError(`다시 시도하지 못했습니다: ${e.message}`),
  });

  const status = paperStatusLabel(p);
  const ai = aiStatus(p);
  const aiBlocked = p.state.contextReady && !ai.available ? ai.text : null;
  const failed = p.ingestStatus === 'failed' || p.ingestStatus === 'interrupted';
  const failure = progress?.phase === 'error' ? progress.error : formatStoredJobError(lastJob?.error);
  const steps = progress?.steps.length ? progress.steps : p.ingestStatus === 'running' ? (lastJob?.steps ?? []) : [];
  const meta = [p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' 외' : ''), p.year ?? ''].filter(Boolean).join(' · ');

  return (
    <li className="border-b border-sl-line px-4 py-5" data-testid="paper-row" data-paper-id={p.id}>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <Link href={`/paper/${p.id}`} className="text-[16px] leading-6 font-semibold tracking-[-0.2px] text-sl-ink hover:underline">
            {p.title}
          </Link>
          {p.source === 'upload' && <UploadPaperTitle id={p.id} title={p.title} />}
          {meta && <div className="text-sl-label text-sl-meta">{meta}</div>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className={`${CHIP} ${TONE[status.tone]}`} data-testid="paper-status" title={aiBlocked ?? undefined}>
              {status.label}
            </span>
            {p.source === 'upload' && (
              <span data-testid="rd-upload-source" className={`${CHIP} border-sl-edge text-sl-muted`}>업로드 PDF</span>
            )}
            <StructureBadge paper={p} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-0.5 text-sl-label">
          {failed && (
            <button type="button" className="rounded-sl-chip border border-sl-edge px-2 py-0.5 text-sl-body hover:bg-sl-subtle disabled:opacity-40" disabled={retry.isPending} onClick={() => retry.mutate()} data-testid="paper-retry">
              다시 시도
            </button>
          )}
          {confirming ? (
            <span className="flex gap-1">
              <button type="button" className="rounded-sl-chip bg-red-700 px-2 py-0.5 text-white" onClick={() => del.mutate()} disabled={del.isPending} data-testid="paper-delete-confirm">
                삭제 확인
              </button>
              <button type="button" className="rounded-sl-chip border border-sl-edge px-2 py-0.5 text-sl-body" onClick={() => setConfirming(false)}>
                취소
              </button>
            </span>
          ) : (
            <button type="button" className="inline-flex items-center gap-1 rounded-sl-chip px-1.5 py-0.5 text-sl-meta hover:bg-sl-subtle hover:text-red-700" onClick={() => setConfirming(true)} data-testid="paper-delete" title="논문 삭제">
              <Icon name="trash" size={14} />
              삭제
            </button>
          )}
        </div>
      </div>
      {steps.length > 0 && (
        <ol className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-sl-label text-sl-muted" data-testid="job-steps">
          {steps.map((s) => (
            <li key={s.step} data-step={s.step} data-status={s.status}>
              {STEP_LABELS[s.step] ?? s.step}: {s.status === 'running' ? '진행 중' : s.status === 'ok' ? '완료' : s.status === 'skipped' ? '건너뜀' : s.status === 'warn' ? '경고' : '오류'}
              {s.detail ? ` (${s.detail})` : ''}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-1.5">
        <StructureUpgradeControl paperId={p.id} available={p.structureUpgradeAvailable} job={detail.data?.structureUpgrade.job ?? null} />
      </div>
      {aiBlocked && (
        <div className="mt-1 text-sl-label text-amber-900" data-testid="paper-ai-reason" data-reason={ai.reason ?? undefined}>
          {aiBlocked}
        </div>
      )}
      {progress?.phase === 'disconnected' && <div className="mt-1 text-sl-label text-sl-meta">진행 상황 연결이 끊겼습니다. 목록을 주기적으로 다시 읽습니다.</div>}
      {failed && failure && (
        <div className="mt-1 text-sl-label text-red-700" data-testid="paper-error">
          {failure}
        </div>
      )}
      {rowError && <div className="mt-1 text-sl-label text-red-700">{rowError}</div>}
    </li>
  );
}
