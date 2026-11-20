// Owner A. papers.delete during each upgrade step (PLAN_M2 3.1, R5): the upgrade job is in IngestService.live, so the
// deletion aborts and waits for it; afterwards the rows and papers/<id>/ are gone and nothing re-creates the directory.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_UPGRADE_PAPER_ID } from '../../src/dev/seedFixture';
import { IngestError } from '../../src/ingest/errors';
import { configureIngest, ingestService, UPGRADE_STEPS } from '../../src/ingest/pipeline';
import { startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';
import { paper } from './m2helpers';
import { SYN_M2_HTML } from './m2helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});
const ID = SEED_UPGRADE_PAPER_ID;

describe('papers.delete during an upgrade', () => {
  it.each(UPGRADE_STEPS.map((x) => [x]))('at step %s → 204, no rows, no directory, never re-created', async (step) => {
    const offline = tempDir('sp-offline-');
    writeFileSync(join(offline, '2301.00002v1.html'), SYN_M2_HTML);
    const s = await startTestServer({ env: 'test', papers: ['upgrade'], offlineDir: offline });
    servers.push(s);
    let entered!: () => void;
    const at = new Promise<void>((r) => (entered = r));
    configureIngest(s.deps, {
      beforeStep: (st, _job, signal) => {
        if (st !== step) return;
        entered();
        // the step is in progress until the deletion aborts it
        return new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new IngestError('cancelled', 'aborted')), { once: true }));
      },
    });
    const { jobId } = ingestService(s.deps).upgradeStructure(ID);
    await at;
    const r = await s.req(`/api/papers/${ID}`, { method: 'DELETE', headers: { 'X-SP-Token': s.token } });
    expect(r.status).toBe(204);
    expect(paper(s.deps, ID)).toBeUndefined();
    expect(s.deps.sqlite.prepare(`SELECT count(*) AS n FROM jobs WHERE id = ?`).get(jobId)).toEqual({ n: 0 });
    for (const t of ['sections', 'equations', 'figures', 'paper_references', 'files', 'page_texts']) expect(s.deps.sqlite.prepare(`SELECT count(*) AS n FROM ${t} WHERE paperId = ?`).get(ID), t).toEqual({ n: 0 });
    expect(existsSync(s.deps.paths.paperDir(ID))).toBe(false);
    expect(ingestService(s.deps).activeJobs()).toBe(0);
    await new Promise((res) => setTimeout(res, 100));
    expect(existsSync(s.deps.paths.paperDir(ID))).toBe(false);
  });

  it('while the step itself runs (no hook): a deletion right after the start still leaves nothing behind', async () => {
    const offline = tempDir('sp-offline-');
    writeFileSync(join(offline, '2301.00002v1.html'), SYN_M2_HTML);
    const s = await startTestServer({ env: 'test', papers: ['upgrade'], offlineDir: offline });
    servers.push(s);
    ingestService(s.deps).upgradeStructure(ID);
    const r = await s.req(`/api/papers/${ID}`, { method: 'DELETE', headers: { 'X-SP-Token': s.token } });
    expect(r.status).toBe(204);
    await new Promise((res) => setTimeout(res, 200));
    expect(paper(s.deps, ID)).toBeUndefined();
    expect(existsSync(s.deps.paths.paperDir(ID))).toBe(false);
  });
});
