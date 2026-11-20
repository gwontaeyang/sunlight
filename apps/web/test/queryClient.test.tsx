// The app's QueryClient ignores the browser's online state (S-FX2R3-03): the server is on 127.0.0.1, so after a window
// 'offline' event queries and mutations still run (TanStack Query's default networkMode 'online' paused them until an
// 'online' event). Owner: supervisor.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider, onlineManager, useMutation, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppQueryClient } from '../src/api/queryClient';
import appSource from '../src/App.tsx?raw';

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true); // the listeners are gone after cleanup, so no event would reach it
});

function Probe(p: { queryFn: () => Promise<string>; mutationFn: () => Promise<string> }) {
  const q = useQuery({ queryKey: ['offline-probe'], queryFn: p.queryFn });
  const m = useMutation({ mutationFn: p.mutationFn });
  return (
    <div>
      <span data-testid="q">{q.isPending ? `pending:${q.fetchStatus}` : q.data}</span>
      <button onClick={() => m.mutate()}>go</button>
      <span data-testid="m">{m.isPending ? (m.isPaused ? 'paused' : 'pending') : (m.data ?? 'idle')}</span>
    </div>
  );
}

describe('createAppQueryClient', () => {
  it("after a window 'offline' event a query still fetches and a mutation still runs", async () => {
    const client = createAppQueryClient();
    let queries = 0;
    let mutations = 0;
    const queryFn = async () => `q${++queries}`;
    const mutationFn = async () => `m${++mutations}`;
    const { rerender } = render(<QueryClientProvider client={client}><span /></QueryClientProvider>);
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(onlineManager.isOnline()).toBe(false); // the event reached TanStack Query
    rerender(
      <QueryClientProvider client={client}>
        <Probe queryFn={queryFn} mutationFn={mutationFn} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('q').textContent).toBe('q1'));
    expect(queries).toBe(1);
    act(() => screen.getByText('go').click());
    await waitFor(() => expect(screen.getByTestId('m').textContent).toBe('m1'));
    expect(mutations).toBe(1);
    // an invalidation while offline refetches (it used to resolve without a request)
    await act(() => client.invalidateQueries({ queryKey: ['offline-probe'] }));
    expect(queries).toBe(2);
    expect(onlineManager.isOnline()).toBe(false);
  });

  it('App.tsx uses this client', () => {
    expect(appSource).toMatch(/^const queryClient = createAppQueryClient\(\);$/m);
    expect(appSource).not.toMatch(/new QueryClient\(/);
  });
});
