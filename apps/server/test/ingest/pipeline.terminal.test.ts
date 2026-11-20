// M1.1 review B3: job.done only after the terminal transaction committed. Faults are injected in SQLite itself
// with TEMP triggers (RAISE(ABORT) = what a disk-full / I/O error does to the statement), so the real transaction
// rolls back. No network: in-memory arXiv source.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobSseEvent } from '@study-paper/shared/contracts/sse';
import { jobs } from '../../src/db/schema';
import { ingestService } from '../../src/ingest/pipeline';
import { startTestServer, type TestServer } from '../helpers/server';
import { collectJobEvents, FakeArxivSource, freshId, paperRow, useSource, waitJob } from './helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function server(): Promise<TestServer> {
  const s = await startTestServer({ env: 'test' });
  servers.push(s);
  return s;
}

const label = (e: JobSseEvent) =>
  e.event === 'job.step' ? `${e.data.step}:${e.data.status}` : e.event === 'job.state' ? `state:${e.data.state}` : e.event === 'job.error' ? `error:${e.data.code}` : 'done';

/** Fails every UPDATE that sets jobs.status to one of `statuses`. */
function failJobStatus(s: TestServer, name: string, statuses: string[]): void {
  s.deps.sqlite.exec(
    `CREATE TEMP TRIGGER ${name} BEFORE UPDATE OF status ON main.jobs WHEN NEW.status IN (${statuses.map((x) => `'${x}'`).join(',')})
     BEGIN SELECT RAISE(ABORT, 'disk I/O error (injected)'); END;`,
  );
}

describe('ingest terminal transaction (B3)', () => {
  it('commit of the success row fails → job.error (never job.done); row failed + retryable; retry then succeeds', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }));
    failJobStatus(s, 'fail_done', ['done']);
    const res = ingestService(s.deps).importArxiv(id);
    const events = await collectJobEvents(s.deps, res.jobId!);
    expect(events.filter((e) => e.event === 'job.done')).toEqual([]);
    expect(events.map(label).slice(-2)).toEqual(['state:context_ready', 'error:internal']);
    expect(events.at(-1)).toMatchObject({ event: 'job.error', data: { message: expect.stringContaining('could not save the job result') } });
    // The fallback write left a terminal, retryable row; structure_ready was rolled back with the success row.
    expect(s.deps.db.select().from(jobs).where(eq(jobs.id, res.jobId!)).get()).toMatchObject({ status: 'failed', error: expect.stringMatching(/^internal: /) });
    expect(paperRow(s.deps, res.paperId)).toMatchObject({ ingestStatus: 'failed', structureReadyAt: null });
    expect(paperRow(s.deps, res.paperId)!.contextReadyAt).not.toBeNull();
    // A late subscriber sees the same terminal.
    expect((await collectJobEvents(s.deps, res.jobId!)).at(-1)).toMatchObject({ event: 'job.error', data: { code: 'internal' } });

    s.deps.sqlite.exec('DROP TRIGGER temp.fail_done');
    const { jobId } = ingestService(s.deps).retry(res.paperId);
    const retryEvents = await collectJobEvents(s.deps, jobId);
    expect(retryEvents.at(-1)!.event).toBe('job.done');
    expect((await waitJob(s.deps, jobId)).status).toBe('done');
    expect(paperRow(s.deps, res.paperId)).toMatchObject({ ingestStatus: 'done', structureSource: 'none' });
    expect(paperRow(s.deps, res.paperId)!.structureReadyAt).not.toBeNull();
  });

  it('both the terminal write and the fallback fail → still exactly one job.error; the row replays as interrupted and can be retried', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }));
    failJobStatus(s, 'fail_all', ['done', 'failed', 'interrupted']);
    const res = ingestService(s.deps).importArxiv(id);
    const events = await collectJobEvents(s.deps, res.jobId!);
    expect(events.filter((e) => e.event === 'job.done' || e.event === 'job.error').map(label)).toEqual(['error:internal']);
    expect(ingestService(s.deps).activeJobs()).toBe(0);
    expect(s.deps.db.select().from(jobs).where(eq(jobs.id, res.jobId!)).get()!.status).toBe('running');
    expect(paperRow(s.deps, res.paperId)!.structureReadyAt).toBeNull();
    // No runner behind the 'running' row: the stream ends with interrupted instead of hanging.
    expect((await collectJobEvents(s.deps, res.jobId!)).at(-1)).toMatchObject({ event: 'job.error', data: { code: 'interrupted' } });

    s.deps.sqlite.exec('DROP TRIGGER temp.fail_all');
    const { jobId } = ingestService(s.deps).retry(res.paperId);
    expect((await waitJob(s.deps, jobId)).status).toBe('done');
  });

  it('a failing step whose terminal write fails still ends with that step error, not success', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), {
      beforeStep: (step) => {
        if (step === 'text') throw new Error('injected text failure');
      },
    });
    failJobStatus(s, 'fail_failed', ['failed']);
    const res = ingestService(s.deps).importArxiv(id);
    const events = await collectJobEvents(s.deps, res.jobId!);
    expect(events.map(label).slice(-2)).toEqual(['text:error', 'error:internal']);
    expect(events.at(-1)).toMatchObject({ data: { message: 'injected text failure' } });
  });

  it('the paper row vanished before the terminal write (job row gone) → job.error cancelled, not job.done', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }));
    const res = ingestService(s.deps).importArxiv(id);
    const events = collectJobEvents(s.deps, res.jobId!);
    // Remove the rows behind the runner's back right before the terminal write (e.g. a manual DB edit).
    s.deps.sqlite.exec(`CREATE TEMP TRIGGER drop_rows AFTER UPDATE OF contextReadyAt ON main.papers WHEN NEW.contextReadyAt IS NOT NULL BEGIN DELETE FROM main.jobs WHERE id = '${res.jobId}'; END;`);
    const out = await events;
    expect(out.filter((e) => e.event === 'job.done')).toEqual([]);
    expect(out.at(-1)).toMatchObject({ event: 'job.error', data: { code: 'cancelled' } });
  });
});
