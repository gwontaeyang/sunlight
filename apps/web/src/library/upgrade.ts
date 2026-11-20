// Structure upgrade of an M1 paper (PLAN_M2 3.1, BRIEF_C C8, BRIEF_A A6). Owner C.
// papers.upgradeStructure → jobs.events (steps) → on the terminal event the paper, the list and the structure are
// invalidated and papers.get is read again to classify a failure:
//   - final (the same HTML gives the same result): a STRUCTURE_FINAL_WARNINGS code in PaperDetailDto.ingestWarnings
//     → the reason in Korean, no button (structureUpgrade.available is false from then on)
//   - transient: the job error's JobErrorCode (timeout · network · blocked_url · interrupted …) and its message →
//     the button stays. An arXiv wait ("재개" time in the message) is shown as it is — never shortened, no retry.
// One watch per paper (Library row, reader header and outline share it); progress lives in a small store.
import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import type { JobDto, PaperDetailDto } from '@study-paper/shared/contracts/api';
import { JobErrorCode, STRUCTURE_FINAL_WARNINGS, type IngestWarningCode } from '@study-paper/shared/contracts/domain';
import { api, ApiError, type ApiClient } from '../api/client';
import { qk } from '../api/queryKeys';
import { streamRoute } from '../api/sse';
import { applyJobEvent, type JobProgress } from './jobs';

export const UPGRADE_CONFIRM_TEXT =
  'arXiv에서 HTML을 한 번 받아 목차·수식·참고문헌 색인을 만듭니다. 기존 대화·하이라이트는 그대로 둡니다. 다음 AI 호출 1회는 논문을 다시 읽습니다(cache).';

export const FINAL_WARNING_KO: Partial<Record<IngestWarningCode, string>> = {
  html_not_found: 'arXiv에 이 논문의 HTML 버전이 없습니다',
  html_version_mismatch: 'arXiv HTML의 버전이 가져온 PDF와 다릅니다',
  structure_parse_failed: 'HTML에서 구조를 읽지 못했습니다',
  structure_too_large: 'HTML이 너무 커서 구조 색인을 만들 수 없습니다',
};

export const JOB_ERROR_KO: Record<JobErrorCode, string> = {
  not_found: 'arXiv에서 찾지 못함',
  too_large: '너무 큼',
  invalid_pdf: 'PDF 오류',
  invalid_metadata: '메타데이터 오류',
  version_mismatch: '버전 불일치',
  timeout: '시간 초과',
  network: '네트워크 오류 또는 arXiv 대기',
  blocked_url: '외부 요청이 차단됨',
  supplement_exists: '색인이 이미 있음',
  cancelled: '취소됨',
  interrupted: '서버가 중단됨',
  internal: '내부 오류',
};

/** The final-failure warning codes in a paper's ingestWarnings (`<code>` or `<code>: <description>`). */
export function finalWarnings(warnings: readonly string[]): IngestWarningCode[] {
  const out: IngestWarningCode[] = [];
  for (const w of warnings) {
    const code = w.split(':')[0]!.trim() as IngestWarningCode;
    if (STRUCTURE_FINAL_WARNINGS.includes(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

/** A job error as `{code, message}`: from the live job.error event, or JobDto.error (`<code>: <message>`). */
export function parseJobError(error: string | null | undefined): { code: JobErrorCode; message: string } | null {
  if (!error) return null;
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(error);
  const parsed = m ? JobErrorCode.safeParse(m[1]) : null;
  return parsed?.success ? { code: parsed.data, message: m![2]! } : { code: 'internal', message: error };
}

/** The message names a time arXiv asked to wait until (A6: "약 N분 뒤", "YYYY-MM-DD HH:mm", or an open-ended wait). */
export function mentionsArxivWait(message: string): boolean {
  return /\d{4}-\d{2}-\d{2} \d{2}:\d{2}|약 \d+\s*분 뒤|기한 없는/.test(message);
}

export type UpgradeOutcome =
  | { kind: 'done' }
  | { kind: 'final'; codes: IngestWarningCode[]; text: string }
  | { kind: 'transient'; code: JobErrorCode | 'disconnected'; message: string; text: string };

/** Korean text of a failure: final from the warnings, else transient from the job error. */
export function classifyUpgradeFailure(detail: Pick<PaperDetailDto, 'ingestWarnings'> | null, jobError: { code: JobErrorCode; message: string } | null): UpgradeOutcome {
  const codes = detail ? finalWarnings(detail.ingestWarnings) : [];
  if (codes.length) return { kind: 'final', codes, text: `구조 색인을 만들 수 없습니다: ${codes.map((c) => FINAL_WARNING_KO[c] ?? c).join(', ')}` };
  const code = jobError?.code ?? 'internal';
  const message = jobError?.message ?? '';
  const wait = mentionsArxivWait(message) ? ' — 표시된 시각이 지난 뒤 다시 시도하세요' : ' — 다시 시도할 수 있습니다';
  return { kind: 'transient', code, message, text: `구조 색인을 만들지 못했습니다(${JOB_ERROR_KO[code]}): ${message || code}${wait}` };
}

export interface UpgradeState {
  jobId: string;
  progress: JobProgress;
  phase: 'running' | 'finishing' | 'finished';
  outcome: UpgradeOutcome | null;
}

interface UpgradeStore {
  byPaper: Record<string, UpgradeState>;
  set(paperId: string, fn: (prev: UpgradeState | undefined) => UpgradeState | undefined): void;
  reset(): void;
}
export const useUpgradeStore = create<UpgradeStore>((set) => ({
  byPaper: {},
  set: (paperId, fn) =>
    set((s) => {
      const next = fn(s.byPaper[paperId]);
      const byPaper = { ...s.byPaper };
      if (next) byPaper[paperId] = next;
      else delete byPaper[paperId];
      return { byPaper };
    }),
  reset: () => set({ byPaper: {} }),
}));

/** The outcome of a job the server has settled (JobDto status done / failed / interrupted); null while it runs. */
export function outcomeOfSettledJob(detail: Pick<PaperDetailDto, 'ingestWarnings'> | null, job: Pick<JobDto, 'status' | 'error'>): UpgradeOutcome | null {
  if (job.status === 'running') return null;
  if (job.status === 'done') return { kind: 'done' };
  const error = parseJobError(job.error) ?? { code: job.status === 'interrupted' ? 'interrupted' : 'internal', message: '' };
  return classifyUpgradeFailure(detail, error);
}

function disconnectedOutcome(message: string): UpgradeOutcome {
  return { kind: 'transient', code: 'disconnected', message, text: `진행 상황 연결이 끊겼습니다: ${message} — 잠시 뒤 다시 확인하세요` };
}

const isLostStream = (s: UpgradeState | undefined): boolean => s?.phase === 'finished' && s.outcome?.kind === 'transient' && s.outcome.code === 'disconnected';

const watching = new Map<string, AbortController>();

/** Aborts every watch and clears the store (tests). */
export function resetUpgrades(): void {
  for (const c of watching.values()) c.abort();
  watching.clear();
  useUpgradeStore.getState().reset();
}

/** Subscribes to jobs.events of an upgrade job once (by job id); ends with the outcome in the store. */
export function watchUpgrade(qc: QueryClient, paperId: string, jobId: string, client: ApiClient = api): void {
  if (watching.has(jobId)) return;
  const prev = useUpgradeStore.getState().byPaper[paperId];
  // Already settled in this page — except a watch that lost its stream: the job may still run on the server, so the
  // same job id (the server answers the running job's id) subscribes again (C-R1-05).
  if (prev?.jobId === jobId && prev.phase !== 'running' && !isLostStream(prev)) return;
  const ac = new AbortController();
  watching.set(jobId, ac);
  const store = useUpgradeStore.getState();
  store.set(paperId, () => ({ jobId, progress: { jobId, paperId, steps: [], states: [], phase: 'running' }, phase: 'running', outcome: null }));
  let jobError: { code: JobErrorCode; message: string } | null = null;
  let disconnected: string | null = null;
  void streamRoute('jobs.events', {
    params: { id: jobId },
    signal: ac.signal,
    client,
    onEvent: (e) => {
      if (e.event === 'job.error') jobError = { code: e.data.code, message: e.data.message };
      useUpgradeStore.getState().set(paperId, (s) => (s && s.jobId === jobId ? { ...s, progress: applyJobEvent(s.progress, e) } : s));
    },
  })
    .catch((err: unknown) => {
      if (!ac.signal.aborted) disconnected = err instanceof ApiError ? err.message : String(err);
    })
    .finally(async () => {
      watching.delete(jobId);
      if (ac.signal.aborted) return;
      useUpgradeStore.getState().set(paperId, (s) => (s && s.jobId === jobId ? { ...s, phase: 'finishing' } : s));
      void qc.invalidateQueries({ queryKey: qk.papers });
      void qc.invalidateQueries({ queryKey: qk.structure(paperId) });
      let detail: PaperDetailDto | null = null;
      try {
        // staleTime 0: always a fresh papers.get (it also updates every observer of the paper query).
        detail = await qc.fetchQuery({ queryKey: qk.paper(paperId), queryFn: () => client.call('papers.get', { params: { id: paperId } }), staleTime: 0 });
      } catch {
        detail = null;
      }
      const done = useUpgradeStore.getState().byPaper[paperId]?.progress.phase === 'done';
      let outcome: UpgradeOutcome;
      if (done && !disconnected) outcome = { kind: 'done' };
      else if (disconnected && !jobError) {
        // The stream was lost: the job may have settled on the server meanwhile (C-R2-01) — its status in the papers.get
        // read decides; only a job that still runs (or is unknown) stays 'disconnected' and can be subscribed again.
        const serverJob = detail?.structureUpgrade.job?.id === jobId ? detail.structureUpgrade.job : null;
        outcome = (serverJob && outcomeOfSettledJob(detail, serverJob)) ?? disconnectedOutcome(disconnected);
      } else outcome = classifyUpgradeFailure(detail, jobError);
      useUpgradeStore.getState().set(paperId, (s) => (s && s.jobId === jobId ? { ...s, phase: 'finished', outcome } : s));
    });
}

/** Starts the upgrade (the server answers the running job's id when one is in progress) and watches it. */
export async function startUpgrade(qc: QueryClient, paperId: string, client: ApiClient = api): Promise<string> {
  const { jobId } = await client.call('papers.upgradeStructure', { params: { id: paperId } });
  watchUpgrade(qc, paperId, jobId, client);
  return jobId;
}

/**
 * Re-subscribes after a reload: the latest upgrade job (structureUpgrade.job) is still running. A watch that lost its
 * stream for this job takes the job's settled status instead when the server reports it finished (C-R2-01).
 */
export function resumeUpgrade(qc: QueryClient, paperId: string, job: JobDto | null | undefined, client: ApiClient = api): void {
  if (!job || job.kind !== 'upgrade_structure') return;
  if (job.status === 'running') {
    watchUpgrade(qc, paperId, job.id, client);
    return;
  }
  const prev = useUpgradeStore.getState().byPaper[paperId];
  if (prev?.jobId !== job.id || !isLostStream(prev) || watching.has(job.id)) return;
  const detail = qc.getQueryData<PaperDetailDto>(qk.paper(paperId)) ?? null;
  const outcome = outcomeOfSettledJob(detail, job);
  if (outcome) useUpgradeStore.getState().set(paperId, (s) => (s && s.jobId === job.id && isLostStream(s) ? { ...s, outcome } : s));
}
