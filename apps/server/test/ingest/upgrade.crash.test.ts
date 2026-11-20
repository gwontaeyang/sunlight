// Owner A. Upgrade terminal ordering (PLAN_M2 3.1, Codex M6): the success terminal is written inside T_struct, so a crash
// right after the commit leaves "v2 + job done", never "v2 + job interrupted"; a failed job update inside T_struct rolls
// everything back; a failure terminal that cannot be written leaves the row running → interrupted after the restart.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaperDetailDto } from '@study-paper/shared/contracts/api';
import { SEED_UPGRADE_PAPER_ID } from '../../src/dev/seedFixture';
import { configureIngest, ingestService } from '../../src/ingest/pipeline';
import { FetchError } from '../../src/ingest/safeFetch';
import { startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';
import { collectJobEvents, FakeArxivSource, useSource } from './helpers';
import { paper, structureCounts, SYN_M2_HTML, upgradeAndWait } from './m2helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});
const ID = SEED_UPGRADE_PAPER_ID;
async function upgradeServer(): Promise<TestServer> {
  const offline = tempDir('sp-offline-');
  writeFileSync(join(offline, '2301.00002v1.html'), SYN_M2_HTML);
  const s = await startTestServer({ env: 'test', papers: ['upgrade'], offlineDir: offline });
  servers.push(s);
  return s;
}
async function restart(s: TestServer): Promise<TestServer> {
  const next = await s.restart();
  servers.splice(servers.indexOf(s), 1, next);
  return next;
}
const detail = async (s: TestServer) => JSON.parse((await s.req(`/api/papers/${ID}`, { headers: { 'X-SP-Token': s.token } })).text) as PaperDetailDto;
const jobRow = (s: TestServer, id: string) => s.deps.sqlite.prepare(`SELECT status FROM jobs WHERE id = ?`).get(id) as { status: string };

describe('upgrade crash points', () => {
  it('a crash right after the T_struct commit → after startup recovery: job done, paper v2, no upgrade button, the replay ends with job.done', async () => {
    const s = await upgradeServer();
    configureIngest(s.deps, {
      inject: (pt) => {
        if (pt === 'tstruct.committed') throw new Error('simulated crash right after the commit');
      },
    });
    const { jobId } = ingestService(s.deps).upgradeStructure(ID);
    await ingestService(s.deps).whenDone(jobId);
    const s2 = await restart(s);
    expect(jobRow(s2, jobId)).toEqual({ status: 'done' });
    expect(paper(s2.deps, ID)).toMatchObject({ supplementVersion: 2, structureSource: 'latexml', ingestStatus: 'done' });
    expect((await detail(s2)).structureUpgrade).toMatchObject({ available: false, job: { id: jobId, status: 'done' } });
    const replay = await collectJobEvents(s2.deps, jobId);
    expect(replay.at(-1)!.event).toBe('job.done');
    expect(replay.filter((e) => e.event === 'job.done' || e.event === 'job.error')).toHaveLength(1);
    expect(replay.every((e) => e.event.startsWith('job.') && e.event !== 'job.state')).toBe(true);
  });

  it('the job update inside T_struct finds no running row (changes = 0) → everything rolls back, paper M1, a new run succeeds', async () => {
    const s = await upgradeServer();
    let once = true;
    configureIngest(s.deps, {
      inject: (pt, jobId) => {
        // inside the T_struct transaction: another writer already ended the job row
        if (pt === 'tstruct.job' && once) {
          once = false;
          s.deps.sqlite.prepare(`UPDATE jobs SET status = 'failed' WHERE id = ?`).run(jobId);
        }
      },
    });
    const first = await upgradeAndWait(s.deps, ID);
    expect(first.events.at(-1)!.event).toBe('job.error');
    expect(first.job.status).toBe('failed');
    expect(paper(s.deps, ID)).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(structureCounts(s.deps, ID)).toEqual([0, 0, 0, 0]);
    expect(s.deps.sqlite.prepare(`SELECT count(*) AS n FROM files WHERE paperId = ? AND kind IN ('html', 'supplement')`).get(ID)).toEqual({ n: 1 }); // only the v1 supplement row
    expect((await upgradeAndWait(s.deps, ID)).job.status).toBe('done');
    expect(structureCounts(s.deps, ID)).toEqual([4, 7, 2, 3]);
  });

  it('the failure terminal cannot be written (both writes fail) → the row stays running, interrupted after the restart; paper M1; it can run again', async () => {
    const s = await upgradeServer();
    useSource(s.deps, new FakeArxivSource({ '2301.00002': { version: 1, html: () => Promise.reject(new FetchError('http_status', 'HTTP 503', 503)) } }), {
      inject: (pt) => {
        if (pt === 'terminal') throw new Error('disk full (injected)');
      },
    });
    const { jobId, events } = await upgradeAndWait(s.deps, ID);
    expect(events.at(-1)).toMatchObject({ event: 'job.error', data: { code: 'network' } });
    expect(jobRow(s, jobId)).toEqual({ status: 'running' });
    const s2 = await restart(s);
    expect(jobRow(s2, jobId)).toEqual({ status: 'interrupted' });
    expect(paper(s2.deps, ID)).toMatchObject({ supplementVersion: 1, structureSource: 'none', ingestStatus: 'done' });
    expect((await detail(s2)).structureUpgrade).toMatchObject({ available: true, reason: 'm1_paper' });
    configureIngest(s2.deps, { offlineDir: s2.deps.paths.root + '/none', inject: undefined, source: undefined });
    const offline = tempDir('sp-offline-');
    writeFileSync(join(offline, '2301.00002v1.html'), SYN_M2_HTML);
    configureIngest(s2.deps, { offlineDir: offline });
    expect((await upgradeAndWait(s2.deps, ID)).job.status).toBe('done');
  });
});
