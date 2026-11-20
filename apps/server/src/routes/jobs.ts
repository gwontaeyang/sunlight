// Owner A. Routes: 'jobs.events'.
// SSE contract (contracts/api.ts, jobs): replay stored steps (job.step) + reached states (job.state) → live
// events → exactly one job.done | job.error. A finished job replays and ends. Any number of subscribers; a
// subscriber that disconnects only detaches (the job keeps running).
import { streamSSE } from 'hono/streaming';
import { notFound, routeParams, type RouteModule } from '../deps';
import { jobEvents } from '../ingest/pipeline';

export const jobsRoutes: RouteModule = (deps) => ({
  'jobs.events': (c) => {
    const { id } = routeParams(c, 'jobs.events');
    // Snapshot + listener are taken here, synchronously, before the response starts.
    const events = jobEvents(deps, id);
    if (!events) throw notFound('job');
    return streamSSE(c, async (stream) => {
      for await (const ev of events) {
        if (stream.aborted) break; // detaches the listener (EventQueue.onDetach)
        await stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) });
      }
    });
  },
});
