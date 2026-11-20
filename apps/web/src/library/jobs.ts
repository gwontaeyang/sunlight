// Ingest job progress for the Library (PLAN 4.1, 8.5): subscribe to jobs.events (the server replays stored
// steps/states first), keep steps + reached states per job, refresh the paper list on state changes.
// One subscription per job id; all are aborted on unmount (StrictMode-safe).
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobStepDto } from '@study-paper/shared/contracts/api';
import type { PaperReadiness } from '@study-paper/shared/contracts/domain';
import type { SseEvent } from '@study-paper/shared/contracts/sse';
import { ApiError } from '../api/client';
import { qk } from '../api/queryKeys';
import { streamRoute } from '../api/sse';

/** contracts/api.ts JobStepDto (re-exported for this module's importers; M1 kept a local copy of its shape). */
export type { JobStepDto };

export interface JobProgress {
  jobId: string;
  paperId: string;
  /** Latest status per step, in first-seen order. */
  steps: JobStepDto[];
  states: PaperReadiness[];
  phase: 'running' | 'done' | 'error' | 'disconnected';
  error?: string;
}

/** Applies one job event to a progress record (pure; exported for tests). */
export function applyJobEvent(p: JobProgress, e: SseEvent): JobProgress {
  switch (e.event) {
    case 'job.step': {
      const i = p.steps.findIndex((s) => s.step === e.data.step);
      const step: JobStepDto = { step: e.data.step, status: e.data.status, ...(e.data.detail ? { detail: e.data.detail } : {}) };
      const steps = i < 0 ? [...p.steps, step] : p.steps.map((s, k) => (k === i ? step : s));
      return { ...p, steps };
    }
    case 'job.state':
      return p.states.includes(e.data.state) ? p : { ...p, states: [...p.states, e.data.state] };
    case 'job.done':
      return { ...p, phase: 'done' };
    case 'job.error':
      return { ...p, phase: 'error', error: `${e.data.message} (${e.data.code})` };
    default:
      return p;
  }
}

export const STEP_LABELS: Record<string, string> = {
  resolve: 'ID 확인',
  metadata: '메타데이터',
  pdf: 'PDF',
  text: '본문 텍스트',
  html: 'HTML',
  structure: '구조',
  anchor: '위치 색인',
  supplement: 'AI 색인',
  enrich: '추가 정보',
};

export function useJobProgress() {
  const qc = useQueryClient();
  const [jobs, setJobs] = useState<Record<string, JobProgress>>({});
  const controllers = useRef(new Map<string, AbortController>());
  /** Jobs whose stream ended (terminal event or broken stream): not re-subscribed; the list polls instead. */
  const ended = useRef(new Set<string>());

  useEffect(() => {
    const map = controllers.current;
    return () => {
      for (const c of map.values()) c.abort();
      map.clear();
    };
  }, []);

  const watch = useCallback(
    (jobId: string, paperId: string) => {
      if (controllers.current.has(jobId) || ended.current.has(jobId)) return;
      const ac = new AbortController();
      controllers.current.set(jobId, ac);
      setJobs((m) => ({ ...m, [jobId]: m[jobId] ?? { jobId, paperId, steps: [], states: [], phase: 'running' } }));
      const refresh = () => {
        void qc.invalidateQueries({ queryKey: qk.papers });
        void qc.invalidateQueries({ queryKey: qk.paper(paperId) });
      };
      streamRoute('jobs.events', {
        params: { id: jobId },
        signal: ac.signal,
        onEvent: (e) => {
          setJobs((m) => ({ ...m, [jobId]: applyJobEvent(m[jobId]!, e) }));
          if (e.event === 'job.state' || e.event === 'job.done' || e.event === 'job.error') refresh();
        },
      })
        .catch((err: unknown) => {
          if (ac.signal.aborted) return;
          const msg = err instanceof ApiError ? `${err.message}` : String(err);
          setJobs((m) => ({ ...m, [jobId]: { ...m[jobId]!, phase: 'disconnected', error: msg } }));
          refresh();
        })
        .finally(() => {
          if (!ac.signal.aborted) ended.current.add(jobId);
          if (controllers.current.get(jobId) === ac) controllers.current.delete(jobId);
        });
    },
    [qc],
  );

  return { jobs, watch };
}

/** lastJob.error is stored as `<code>: <message>` (contracts JobDto): show it like a live job.error. */
export function formatStoredJobError(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(error);
  return m ? `${m[2]} (${m[1]})` : error;
}
