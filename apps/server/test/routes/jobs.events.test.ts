// jobs.events over HTTP: replay → live → exactly one terminal; re-subscribing to a finished job; several
// subscribers; a disconnecting subscriber does not stop the job. No network.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_TERMINAL_EVENTS, parseSseEvent, type JobSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { jobs } from '../../src/db/schema';
import { ingestService } from '../../src/ingest/pipeline';
import { waitFor } from '../helpers/proc';
import { startTestServer, type TestServer } from '../helpers/server';
import { FakeArxivSource, freshId, useSource, waitJob } from '../ingest/helpers';

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer({ env: 'prod' });
});
afterAll(async () => {
  await s.close();
});

/** Reads the SSE stream; `stopAfter` aborts the connection after that many events. */
async function subscribe(jobId: string, stopAfter?: number): Promise<{ status: number; type: string; events: SseEvent[] }> {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${s.port}/api/jobs/${jobId}/events`, { headers: { 'X-SP-Token': s.token }, signal: ctrl.signal });
  const events: SseEvent[] = [];
  if (res.status !== 200) return { status: res.status, type: res.headers.get('content-type') ?? '', events };
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (ev && data) events.push(parseSseEvent(ev, JSON.parse(data)));
        if (stopAfter !== undefined && events.length >= stopAfter) {
          // Stop here: frames that arrived in the same chunk after the limit are not this subscriber's.
          ctrl.abort();
          return { status: res.status, type: res.headers.get('content-type') ?? '', events };
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  }
  return { status: res.status, type: res.headers.get('content-type') ?? '', events };
}

const terminals = (evs: SseEvent[]) => evs.filter((e) => (JOB_TERMINAL_EVENTS as readonly string[]).includes(e.event));
const label = (e: SseEvent) => (e.event === 'job.step' ? `${e.data.step}:${e.data.status}` : e.event === 'job.state' ? `state:${e.data.state}` : e.event);

describe('jobs.events', () => {
  it('live job: replay of stored steps, then live events, then one job.done; several subscribers', async () => {
    const id = freshId();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), { beforeStep: (step) => (step === 'pdf' ? gate : undefined) });
    const { jobId, paperId } = ingestService(s.deps).importArxiv(id);
    const stepsOf = () => s.deps.db.select({ steps: jobs.stepsJson }).from(jobs).where(eq(jobs.id, jobId!)).get()?.steps ?? '';
    await waitFor(() => stepsOf().includes('"step":"metadata","status":"ok"'), 'metadata ok'); // pdf waits at the gate
    // The quitter reads the replay (2 stored steps) and disconnects BEFORE the gate opens: a slow reader that
    // was still connected at release() would get live frames in the same chunk (flaky under load).
    const rq = await subscribe(jobId!, 2);
    const listeners = () => ingestService(s.deps).liveRun(jobId!)?.listeners.size ?? 0;
    const before = listeners(); // the quitter's listener may still be attached (detached at the next event)
    const a = subscribe(jobId!);
    const b = subscribe(jobId!);
    await waitFor(() => listeners() >= before + 2, 'both subscribers attached');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.type).toContain('text/event-stream');
    expect(ra.events.map(label)).toEqual([
      'resolve:ok',
      'metadata:ok',
      'pdf:running',
      'pdf:ok',
      'text:running',
      'text:ok',
      'state:readable',
      'html:running',
      'html:skipped',
      'structure:running',
      'structure:skipped',
      'anchor:running',
      'anchor:skipped',
      'supplement:running',
      'supplement:ok',
      'state:context_ready',
      'state:structure_ready',
      'job.done',
    ]);
    expect(rb.events).toEqual(ra.events);
    expect(terminals(ra.events)).toEqual([{ event: 'job.done', data: { paperId } }]);
    expect(rq.events.map(label)).toEqual(['resolve:ok', 'metadata:ok']);
    expect((await waitJob(s.deps, jobId!)).status).toBe('done'); // the disconnect did not stop the job
  });

  it('finished job: re-subscribing replays and ends immediately, every time', async () => {
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }));
    const { jobId } = ingestService(s.deps).importArxiv(id);
    await waitJob(s.deps, jobId!);
    const first = await subscribe(jobId!);
    const second = await subscribe(jobId!);
    expect(first.events).toEqual(second.events);
    expect(first.events.map(label)).toEqual(['resolve:ok', 'metadata:ok', 'pdf:ok', 'text:ok', 'html:skipped', 'structure:skipped', 'anchor:skipped', 'supplement:ok', 'state:readable', 'state:context_ready', 'state:structure_ready', 'job.done']);
  });

  it('failed job: replay includes the failed step; one job.error is last', async () => {
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), {
      beforeStep: (step) => {
        if (step === 'supplement') throw new Error('disk full (injected)');
      },
    });
    const { jobId } = ingestService(s.deps).importArxiv(id);
    const live = subscribe(jobId!);
    await waitJob(s.deps, jobId!);
    const r = await live;
    expect(terminals(r.events)).toHaveLength(1);
    expect(r.events.at(-1)).toEqual({ event: 'job.error', data: { code: 'internal', message: 'disk full (injected)' } } satisfies JobSseEvent);
    expect(r.events.map(label)).toContain('state:readable');
    expect(r.events.map(label)).toContain('supplement:error');
    const again = await subscribe(jobId!);
    expect(again.events.at(-1)).toEqual(r.events.at(-1));
  });

  it('unknown job → 404 error DTO', async () => {
    expect((await subscribe('00000000-0000-4000-8000-00000000beef')).status).toBe(404);
  });
});
