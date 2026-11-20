// Owner A. Offline arXiv (SP_ARXIV_OFFLINE_DIR, never prod): an import with HTML and an upgrade make no request at all
// — the injected fetch is never called.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_UPGRADE_PAPER_ID } from '../../src/dev/seedFixture';
import { ingestService } from '../../src/ingest/pipeline';
import { startTestServer, type TestServer } from '../helpers/server';
import { freshId, importAndWait } from './helpers';
import { offlineDir, paper, SYN_M2_HTML, SYN_M2_PDF, upgradeAndWait } from './m2helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('offline ingest makes no network request', () => {
  it('import with HTML + upgrade of the M1 seed: fetch spy 0 calls', async () => {
    const id = freshId();
    const dir = offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]);
    writeFileSync(join(dir, '2301.00002v1.html'), SYN_M2_HTML);
    const fetchSpy = vi.fn(async () => new Response('', { status: 599 }));
    const s = await startTestServer({ env: 'test', papers: ['upgrade'], offlineDir: dir, fetchImpl: fetchSpy });
    servers.push(s);
    expect(ingestService(s.deps).sourceKind).toBe('offline');
    const { paper: p } = await importAndWait(s.deps, id);
    expect(p).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
    expect((await upgradeAndWait(s.deps, SEED_UPGRADE_PAPER_ID)).job.status).toBe('done');
    expect(paper(s.deps, SEED_UPGRADE_PAPER_ID)).toMatchObject({ supplementVersion: 2 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
