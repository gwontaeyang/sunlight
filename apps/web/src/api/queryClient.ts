// The app's QueryClient (owner: supervisor). networkMode 'always' (S-FX2R3-03): the server is on 127.0.0.1, so the
// browser's online state says nothing about whether it can be reached. With TanStack Query's default ('online') a
// window 'offline' event (Wi-Fi dropped) paused every query and mutation — new lists were never fetched and an
// invalidateQueries resolved without a request — until an 'online' event came.
import { QueryClient } from '@tanstack/react-query';

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, networkMode: 'always' },
      mutations: { networkMode: 'always' },
    },
  });
}
