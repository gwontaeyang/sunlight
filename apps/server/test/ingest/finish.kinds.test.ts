// Owner A. finish per job kind (BRIEF_A A5): an import never overwrites structureSource; import / retry / lastJob see
// ingest kinds only; an upgrade never becomes lastJob or the import's jobId; retry during an upgrade → 409.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaperDetailDto } from '@study-paper/shared/contracts/api';
import { SEED_UPGRADE_INGEST_JOB_ID, SEED_UPGRADE_PAPER_ID } from '../../src/dev/seedFixture';
import { configureIngest, ingestService, latestJob, UPGRADE_KINDS } from '../../src/ingest/pipeline';
import { startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';
import { freshId, importAndWait } from './helpers';
import { offlineDir, SYN_M2_HTML, SYN_M2_PDF, upgradeAndWait } from './m2helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});
const ID = SEED_UPGRADE_PAPER_ID;
const detail = async (s: TestServer, id: string) => JSON.parse((await s.req(`/api/papers/${id}`, { headers: { 'X-SP-Token': s.token } })).text) as PaperDetailDto;
const jobOf = (d: PaperDetailDto) => (d.lastJob === null ? null : { id: d.lastJob.id, kind: d.lastJob.kind, status: d.lastJob.status });

describe('finish per kind', () => {
  it('a new import with HTML keeps structureSource latexml after its terminal (M1 finish wrote none)', async () => {
    const id = freshId();
    const s = await startTestServer({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    servers.push(s);
    const { paper } = await importAndWait(s.deps, id);
    expect(paper).toMatchObject({ structureSource: 'latexml', ingestStatus: 'done' });
    expect(paper.structureReadyAt).not.toBeNull();
  });

  it('during an upgrade: papers.import of the same id answers existing without the upgrade job; retryIngest → 409; lastJob stays the ingest job; a failed upgrade too', async () => {
    const offline = tempDir('sp-offline-');
    writeFileSync(join(offline, '2301.00002v1.html'), '<!DOCTYPE html><html><body>broken</body></html>');
    const s = await startTestServer({ env: 'test', papers: ['upgrade'], offlineDir: offline });
    servers.push(s);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    configureIngest(s.deps, { beforeStep: (step) => (step === 'structure' ? gate : undefined) });
    const { jobId } = ingestService(s.deps).upgradeStructure(ID);
    const imp = ingestService(s.deps).importArxiv('2301.00002');
    expect(imp.jobId).not.toBe(jobId);
    expect(imp).toEqual({ paperId: ID, jobId: null, existing: true, existingVersion: 1 });
    expect(() => ingestService(s.deps).retry(ID)).toThrow(expect.objectContaining({ status: 409, message: expect.stringContaining('upgrade') }));
    const during = await detail(s, ID);
    expect(jobOf(during)).toEqual({ id: SEED_UPGRADE_INGEST_JOB_ID, kind: 'import_arxiv', status: 'done' });
    expect(during.structureUpgrade.job).toMatchObject({ id: jobId, status: 'running' });
    release();
    await ingestService(s.deps).whenDone(jobId);
    const after = await detail(s, ID);
    expect(after.structureUpgrade.job).toMatchObject({ id: jobId, status: 'failed' });
    expect(jobOf(after)).toEqual({ id: SEED_UPGRADE_INGEST_JOB_ID, kind: 'import_arxiv', status: 'done' });
    expect(latestJob(s.deps, ID, UPGRADE_KINDS)?.id).toBe(jobId);
    // the upgrade failure never touched the ingest status
    expect(after.ingestStatus).toBe('done');
  });

  it('an upgrade during a running import of the paper → 409; an upgrade of a paper that is not a target → 409; unknown → 404', async () => {
    const id = freshId();
    const s = await startTestServer({ env: 'test', papers: ['upgrade'], offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF }]) });
    servers.push(s);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    configureIngest(s.deps, { beforeStep: (step) => (step === 'text' ? gate : undefined) });
    const res = ingestService(s.deps).importArxiv(id);
    expect(() => ingestService(s.deps).upgradeStructure(res.paperId)).toThrow(expect.objectContaining({ status: 409 }));
    release();
    await ingestService(s.deps).whenDone(res.jobId!);
    // html_not_found (no HTML offline) is final → not a target
    expect(() => ingestService(s.deps).upgradeStructure(res.paperId)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => ingestService(s.deps).upgradeStructure('00000000-0000-4000-8000-00000000dead')).toThrow(expect.objectContaining({ status: 404 }));
    // the seed upgrade target still works
    configureIngest(s.deps, { beforeStep: undefined });
    expect((await upgradeAndWait(s.deps, ID)).job.status).toBe('failed'); // no HTML for 2301.00002 offline → html_not_found
  });
});
