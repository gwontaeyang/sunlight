// Owner A. T_struct atomicity (PLAN_M2 3.1 "게시와 전환"): a failure inside the transaction leaves no structure row and an
// unchanged paper (the published v2 file is a leftover the next run replaces); a paper already switched is never
// switched again; a v2 file the DB points at is never replaced; a deletion between the file and T_struct rolls back in
// both branches (and the directory is gone once the deletion finished); a job row that is not running rolls back.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_M2_PAPER_ID, SEED_UPGRADE_PAPER_ID } from '../../src/dev/seedFixture';
import { configureIngest, ingestService } from '../../src/ingest/pipeline';
import { parse } from '../../src/ingest/latexml';
import { publishSupplementV2 } from '../../src/ingest/structureStore';
import { startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';
import { freshId, importAndWait, waitJob } from './helpers';
import { offlineDir, paper, structureCounts, SYN_M2_HTML, SYN_M2_PDF, upgradeAndWait } from './m2helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});
async function server(o: Parameters<typeof startTestServer>[0]): Promise<TestServer> {
  const s = await startTestServer(o);
  servers.push(s);
  return s;
}
async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('T_struct (new import)', () => {
  it('a failure inside T_struct → 0 structure rows, paper without supplement; the v2 file stays as a leftover; the retry (with other leftover bytes) replaces it and succeeds', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    let fail = true;
    configureIngest(s.deps, {
      inject: (pt) => {
        if (pt === 'tstruct.job' && fail) throw new Error('injected failure inside T_struct');
      },
    });
    const { res, job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('failed');
    expect(p).toMatchObject({ supplementVersion: null, contextReadyAt: null, structureSource: null });
    expect(structureCounts(s.deps, p.id)).toEqual([0, 0, 0, 0]);
    expect(s.deps.sqlite.prepare(`SELECT kind FROM files WHERE paperId = ? ORDER BY kind`).all(p.id)).toEqual([{ kind: 'pdf' }]);
    const v2 = s.deps.paths.supplementFile(p.id, 2);
    expect(existsSync(v2)).toBe(true); // leftover, never pointed at
    writeFileSync(v2, 'other bytes from an older attempt\n'); // a leftover with different bytes
    fail = false;
    const { jobId } = ingestService(s.deps).retry(res.paperId);
    expect((await waitJob(s.deps, jobId)).status).toBe('done');
    expect(paper(s.deps, p.id)).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
    expect(readFileSync(v2, 'utf8')).toContain('<paper_index v="2">');
    expect(structureCounts(s.deps, p.id)).toEqual([4, 7, 2, 3]);
  });

  it('a job row that is no longer running → rollback', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    configureIngest(s.deps, {
      inject: (pt, jobId) => {
        if (pt === 'tstruct.job') s.deps.sqlite.prepare(`UPDATE jobs SET status = 'interrupted' WHERE id = ?`).run(jobId);
      },
    });
    const { paper: p } = await importAndWait(s.deps, id);
    expect(p).toMatchObject({ supplementVersion: null });
    expect(structureCounts(s.deps, p.id)).toEqual([0, 0, 0, 0]);
  });
});

describe('T_struct guards', () => {
  const fileRows = (s: TestServer, id: string) => s.deps.sqlite.prepare(`SELECT kind, relPath, sha256 FROM files WHERE paperId = ? ORDER BY kind, relPath`).all(id);

  it('import branch: the paper switched to v2 between the file and T_struct → the expected-version guard (supplementVersion IS NULL) rolls back', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    let paperId = '';
    configureIngest(s.deps, {
      inject: (pt) => {
        if (pt === 'publish.after') s.deps.sqlite.prepare(`UPDATE papers SET supplementVersion = 2, structureSource = 'latexml', supplementSha256 = 'x' WHERE id = ?`).run(paperId);
      },
    });
    const res = ingestService(s.deps).importArxiv(id);
    paperId = res.paperId;
    const job = await waitJob(s.deps, res.jobId!);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/supplement_exists/);
    expect(structureCounts(s.deps, paperId)).toEqual([0, 0, 0, 0]);
    expect(paper(s.deps, paperId)).toMatchObject({ supplementVersion: 2, structureSource: 'latexml', supplementSha256: 'x', contextReadyAt: null, codeUrl: null });
    expect(fileRows(s, paperId).map((r) => (r as { kind: string }).kind)).toEqual(['pdf']); // no html / supplement row
  });

  it('import branch: a structure row already there → structure_exists rolls back (only that row stays)', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    let paperId = '';
    configureIngest(s.deps, {
      inject: (pt) => {
        if (pt === 'publish.after') s.deps.sqlite.prepare(`INSERT INTO sections (id, paperId, title, level, ordinal) VALUES ('pre-existing', ?, 'Old', 1, 1)`).run(paperId);
      },
    });
    const res = ingestService(s.deps).importArxiv(id);
    paperId = res.paperId;
    const job = await waitJob(s.deps, res.jobId!);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/already has structure rows/); // StructureCommitError structure_exists → job error internal
    expect(structureCounts(s.deps, paperId)).toEqual([1, 0, 0, 0]);
    expect(paper(s.deps, paperId)).toMatchObject({ supplementVersion: null, structureSource: null, contextReadyAt: null });
    expect(fileRows(s, paperId).map((r) => (r as { kind: string }).kind)).toEqual(['pdf']);
  });

  it('upgrade branch: the paper switched to v2 between the file and T_struct → the expected-version guard (supplementVersion=1 AND structureSource none) rolls back', async () => {
    const offline = tempDir('sp-offline-');
    writeFileSync(join(offline, '2301.00002v1.html'), SYN_M2_HTML);
    const s = await server({ env: 'test', papers: ['upgrade'], offlineDir: offline });
    const filesBefore = fileRows(s, SEED_UPGRADE_PAPER_ID);
    configureIngest(s.deps, {
      inject: (pt) => {
        if (pt === 'publish.after') s.deps.sqlite.prepare(`UPDATE papers SET supplementVersion = 2, structureSource = 'latexml' WHERE id = ?`).run(SEED_UPGRADE_PAPER_ID);
      },
    });
    const { job, events } = await upgradeAndWait(s.deps, SEED_UPGRADE_PAPER_ID);
    expect(job.status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ event: 'job.error', data: { code: 'internal', message: expect.stringContaining('no longer an upgrade target') } });
    expect(structureCounts(s.deps, SEED_UPGRADE_PAPER_ID)).toEqual([0, 0, 0, 0]);
    expect(paper(s.deps, SEED_UPGRADE_PAPER_ID)).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
    expect(fileRows(s, SEED_UPGRADE_PAPER_ID)).toEqual(filesBefore);
  });

  it('upgrade branch: a structure row already there → structure_exists rolls back', async () => {
    const offline = tempDir('sp-offline-');
    writeFileSync(join(offline, '2301.00002v1.html'), SYN_M2_HTML);
    const s = await server({ env: 'test', papers: ['upgrade'], offlineDir: offline });
    const filesBefore = fileRows(s, SEED_UPGRADE_PAPER_ID);
    configureIngest(s.deps, {
      inject: (pt) => {
        if (pt === 'publish.after') s.deps.sqlite.prepare(`INSERT INTO paper_references (id, paperId, ordinal, rawText) VALUES ('pre-existing', ?, 1, 'Old')`).run(SEED_UPGRADE_PAPER_ID);
      },
    });
    const { job } = await upgradeAndWait(s.deps, SEED_UPGRADE_PAPER_ID);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/structure rows/);
    expect(structureCounts(s.deps, SEED_UPGRADE_PAPER_ID)).toEqual([0, 0, 0, 1]);
    expect(paper(s.deps, SEED_UPGRADE_PAPER_ID)).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(fileRows(s, SEED_UPGRADE_PAPER_ID)).toEqual(filesBefore);
  });

  it('upgrade branch: the job success terminal inside T_struct updates 0 rows → the whole T_struct rolls back (rows, files, papers), job failed', async () => {
    const offline = tempDir('sp-offline-');
    writeFileSync(join(offline, '2301.00002v1.html'), SYN_M2_HTML);
    const s = await server({ env: 'test', papers: ['upgrade'], offlineDir: offline });
    const filesBefore = fileRows(s, SEED_UPGRADE_PAPER_ID);
    const before = s.deps.sqlite.prepare(`SELECT * FROM papers WHERE id = ?`).get(SEED_UPGRADE_PAPER_ID);
    configureIngest(s.deps, {
      inject: (pt, jobId) => {
        // inside the transaction, after the papers UPDATE: the job row stops being 'running' (rolled back with the rest)
        if (pt === 'tstruct.finish') s.deps.sqlite.prepare(`UPDATE jobs SET status = 'interrupted' WHERE id = ?`).run(jobId);
      },
    });
    const { job, events } = await upgradeAndWait(s.deps, SEED_UPGRADE_PAPER_ID);
    expect(job.status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ event: 'job.error', data: { message: expect.stringContaining('could not be finished') } });
    expect(structureCounts(s.deps, SEED_UPGRADE_PAPER_ID)).toEqual([0, 0, 0, 0]);
    expect(s.deps.sqlite.prepare(`SELECT * FROM papers WHERE id = ?`).get(SEED_UPGRADE_PAPER_ID)).toEqual(before);
    expect(fileRows(s, SEED_UPGRADE_PAPER_ID)).toEqual(filesBefore);
  });

  it('a paper already switched (SEED_M2, v2): papers.upgradeStructure → 409; a v2 file with other bytes + supplementVersion 2 → supplement_exists, the file is untouched', async () => {
    const s = await server({ env: 'test', papers: ['links', 'm2'] });
    expect(() => ingestService(s.deps).upgradeStructure(SEED_M2_PAPER_ID)).toThrow(expect.objectContaining({ status: 409 }));
    const file = s.deps.paths.supplementFile(SEED_M2_PAPER_ID, 2);
    const before = readFileSync(file);
    const parsed = parse(SYN_M2_HTML);
    const input = { meta: { title: 'Other', authors: [], arxivId: '2301.00004', arxivVersion: 1, year: null, primaryCategory: null }, sections: parsed.sections.map((x) => ({ htmlId: x.htmlId, number: x.number, title: x.title })), equations: [], figures: [], references: [] };
    expect(() => publishSupplementV2(s.deps, SEED_M2_PAPER_ID, input, new AbortController().signal)).toThrow(expect.objectContaining({ code: 'supplement_exists' }));
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('a deletion between the file publication and T_struct: the new-import branch rolls back; the rows and the directory are gone after the deletion', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]), deleteWaitMs: 100 });
    let paperId = '';
    configureIngest(s.deps, {
      inject: async (pt) => {
        if (pt !== 'publish.after') return;
        // the user deletes the paper now (the request answers 204 after its short wait — this job is still running)
        const r = await s.req(`/api/papers/${paperId}`, { method: 'DELETE', headers: { 'X-SP-Token': s.token } });
        expect(r.status).toBe(204);
      },
    });
    const res = ingestService(s.deps).importArxiv(id);
    paperId = res.paperId;
    const job = await waitJob(s.deps, res.jobId!);
    expect(job === undefined || job.status !== 'done').toBe(true);
    await waitFor(() => paper(s.deps, paperId) === undefined, 'paper row deleted');
    expect(structureCounts(s.deps, paperId)).toEqual([0, 0, 0, 0]);
    await waitFor(() => !existsSync(s.deps.paths.paperDir(paperId)), 'directory removed');
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(s.deps.paths.paperDir(paperId))).toBe(false);
  });

  it('a tombstone set between the file and T_struct (without an abort): the upgrade branch rolls back on deletingAt; startup recovery then removes the paper and its directory', async () => {
    const offline = tempDir('sp-offline-');
    writeFileSync(join(offline, '2301.00002v1.html'), SYN_M2_HTML);
    const s = await server({ env: 'test', papers: ['upgrade'], offlineDir: offline });
    configureIngest(s.deps, {
      inject: (pt) => {
        if (pt === 'publish.after') s.deps.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(Date.now(), SEED_UPGRADE_PAPER_ID);
      },
    });
    const { job, events } = await upgradeAndWait(s.deps, SEED_UPGRADE_PAPER_ID);
    expect(job.status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ event: 'job.error', data: { code: 'cancelled' } });
    expect(structureCounts(s.deps, SEED_UPGRADE_PAPER_ID)).toEqual([0, 0, 0, 0]);
    expect(paper(s.deps, SEED_UPGRADE_PAPER_ID)).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    const s2 = await s.restart();
    servers.splice(servers.indexOf(s), 1, s2);
    expect(paper(s2.deps, SEED_UPGRADE_PAPER_ID)).toBeUndefined();
    expect(existsSync(s2.deps.paths.paperDir(SEED_UPGRADE_PAPER_ID))).toBe(false);
  });

  it('the same for the new-import branch: tombstone without abort → rollback (no rows), deletingAt kept', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    let paperId = '';
    configureIngest(s.deps, {
      inject: (pt) => {
        if (pt === 'publish.after') s.deps.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(Date.now(), paperId);
      },
    });
    const res = ingestService(s.deps).importArxiv(id);
    paperId = res.paperId;
    const job = await waitJob(s.deps, res.jobId!);
    expect(job.status).toBe('failed');
    expect(structureCounts(s.deps, paperId)).toEqual([0, 0, 0, 0]);
    expect(paper(s.deps, paperId)).toMatchObject({ supplementVersion: null, contextReadyAt: null });
  });
});
