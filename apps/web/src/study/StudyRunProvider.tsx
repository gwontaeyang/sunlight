import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { usePanelApi } from '../panel/panelApi';
import { IDLE_RUN, isActive, useRunStream, type RunStreamState } from '../panel/useRunStream';
import { studyProgress } from './studyProgress';

export const studyPathKey = (paperId: string) => ['study-path', paperId] as const;

interface StudyRun {
  state: RunStreamState;
  connect(paperId: string, regenerate: boolean, clientRequestId?: string): Promise<void>;
  cancel(): Promise<void>;
}
const RunContext = createContext<StudyRun | null>(null);

interface StudyProgress { paperId: string; completed: number; percent: number }
const ProgressContext = createContext<StudyProgress | null>(null);

/** A route change only removes the reader. The app keeps the single background subscription. */
export function StudyRunProvider({ children }: { children: ReactNode }) {
  const api = usePanelApi();
  const client = useQueryClient();
  const inFlight = useRef(false);
  const finish = (settled: RunStreamState) => {
    if (!inFlight.current || settled.request?.route !== 'studyPath.generate') return;
    inFlight.current = false;
    void client.invalidateQueries({ queryKey: studyPathKey(settled.request.params.id) });
  };
  const { state, start, attach, cancel } = useRunStream({
    client: api,
    // The server has committed the result at the terminal event; the transport can close later.
    onEvent: (e, current) => {
      if (e.event === 'run.done' || e.event === 'run.error') finish(current);
    },
    onSettled: finish, // Network / HTTP errors may have no terminal event.
  });
  const connect = useCallback(async (id: string, regenerate: boolean, clientRequestId?: string) => {
    // start()/attach() replace the hook's current transport. Lock synchronously, even across different readers.
    if (inFlight.current) return;
    inFlight.current = true;
    const request = { route: 'studyPath.generate', params: { id }, body: { regenerate } } as const;
    if (clientRequestId) await attach(request, clientRequestId);
    else await start(request);
  }, [attach, start]);

  const activePaper = isActive(state) && state.request?.route === 'studyPath.generate' ? state.request.params.id : null;
  const { completed, percent } = useMemo(() => activePaper ? studyProgress(state.text) : { completed: 0, percent: 0 }, [activePaper, state.text]);
  // Header and library rows need notifications only when the owner or displayed count changes.
  const progress = useMemo(() => activePaper ? { paperId: activePaper, completed, percent } : null, [activePaper, completed, percent]);
  return (
    <RunContext.Provider value={{ state, connect, cancel }}>
      <ProgressContext.Provider value={progress}>{children}</ProgressContext.Provider>
    </RunContext.Provider>
  );
}

export function useStudyProgress() {
  return useContext(ProgressContext);
}

export function usePaperStudyRun(paperId: string) {
  const run = useContext(RunContext);
  if (!run) throw new Error('StudyRunProvider is required');
  const request = run.state.request;
  const owns = request?.route === 'studyPath.generate' && request.params.id === paperId;
  return {
    state: owns ? run.state : IDLE_RUN,
    request: owns ? request : null,
    busyElsewhere: !owns && isActive(run.state),
    connect: run.connect,
    cancel: run.cancel,
  };
}
