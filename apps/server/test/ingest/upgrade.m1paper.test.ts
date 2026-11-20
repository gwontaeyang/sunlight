// Owner A. Upgrade of an M1 paper (PLAN_M2 3.1, D3/D4): user data and the M1 files stay byte-identical, papers changes
// only in the six allowed columns, lastJob stays the ingest job; fault / shutdown / parse failure / timeout behave as the
// BRIEF_A A6 table says.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaperDetailDto } from '@study-paper/shared/contracts/api';
import { SEED_UPGRADE_INGEST_JOB_ID, SEED_UPGRADE_PAPER_ID } from '../../src/dev/seedFixture';
import { IngestError } from '../../src/ingest/errors';
import { configureIngest, ingestService } from '../../src/ingest/pipeline';
import { FetchError } from '../../src/ingest/safeFetch';
import { startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';
import { FakeArxivSource, useSource } from './helpers';
import { latexmlFootnote, paper, structureCounts, SYN_M2_HTML, upgradeAndWait, warnings } from './m2helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});
const ID = SEED_UPGRADE_PAPER_ID;
const ALLOWED = new Set(['supplementSha256', 'supplementVersion', 'structureSource', 'updatedAt', 'codeUrl', 'ingestWarningsJson']);

async function upgradeServer(html: string | null = SYN_M2_HTML): Promise<TestServer> {
  const offline = tempDir('sp-offline-');
  if (html !== null) writeFileSync(join(offline, '2301.00002v1.html'), html);
  const s = await startTestServer({ env: 'test', papers: ['upgrade'], offlineDir: offline });
  servers.push(s);
  return s;
}
async function call(s: TestServer, method: string, path: string, body?: unknown) {
  const r = await s.req(`/api${path}`, { method, headers: { 'X-SP-Token': s.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: r.text, json: r.headers['content-type']?.includes('json') ? (JSON.parse(r.text) as unknown) : undefined };
}
const dump = (s: TestServer) => {
  const all = (sql: string) => s.deps.sqlite.prepare(sql).all(ID);
  return {
    threads: all(`SELECT * FROM threads WHERE paperId = ? ORDER BY rowid`),
    messages: all(`SELECT m.* FROM messages m JOIN threads t ON t.id = m.threadId WHERE t.paperId = ? ORDER BY m.rowid`),
    citations: all(`SELECT c.* FROM citations c JOIN messages m ON m.id = c.ownerId JOIN threads t ON t.id = m.threadId WHERE t.paperId = ? ORDER BY c.rowid`),
    highlights: all(`SELECT * FROM highlights WHERE paperId = ? ORDER BY rowid`),
    llmCalls: all(`SELECT * FROM llm_calls WHERE paperId = ? ORDER BY rowid`),
    pageTexts: all(`SELECT * FROM page_texts WHERE paperId = ? ORDER BY page`),
  };
};
const papersRow = (s: TestServer) => s.deps.sqlite.prepare(`SELECT * FROM papers WHERE id = ?`).get(ID) as Record<string, unknown>;
const jobOf = (d: PaperDetailDto) => (d.lastJob === null ? null : { id: d.lastJob.id, kind: d.lastJob.kind, status: d.lastJob.status });

describe('upgrade of SEED_UPGRADE (M1 paper) with offline HTML', () => {
  it('user data dumps, supplement.txt and every papers column but the six allowed are unchanged; lastJob stays the ingest job', async () => {
    const s = await upgradeServer();
    const explain = await call(s, 'POST', `/papers/${ID}/threads`, { kind: 'explain', anchor: { kind: 'text', quote: { exact: 'robust kernel' }, rects: [{ page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }] }, text: 'robust kernel', clientRequestId: crypto.randomUUID() });
    expect(explain.status).toBe(200);
    expect((await call(s, 'POST', `/papers/${ID}/highlights`, { kind: 'text', color: 2, quote: { exact: 'first-order Jacobian' }, page: 2, rects: [{ page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }] })).status).toBe(200);
    const before = dump(s);
    expect(before.threads.length * before.messages.length * before.llmCalls.length * before.highlights.length * before.pageTexts.length).toBeGreaterThan(0);
    const v1 = readFileSync(s.deps.paths.supplementFile(ID, 1));
    const rowBefore = papersRow(s);
    const lastJobBefore = jobOf((await call(s, 'GET', `/papers/${ID}`)).json as PaperDetailDto);
    expect(lastJobBefore).toEqual({ id: SEED_UPGRADE_INGEST_JOB_ID, kind: 'import_arxiv', status: 'done' });
    expect(((await call(s, 'GET', `/papers/${ID}`)).json as PaperDetailDto).structureUpgrade).toEqual({ available: true, reason: 'm1_paper', job: null });

    const up = await call(s, 'POST', `/papers/${ID}/upgrade-structure`, {});
    expect(up.status).toBe(200);
    const jobId = (up.json as { jobId: string }).jobId;
    await ingestService(s.deps).whenDone(jobId);
    expect(s.deps.sqlite.prepare(`SELECT kind, status FROM jobs WHERE id = ?`).get(jobId)).toEqual({ kind: 'upgrade_structure', status: 'done' });

    expect(dump(s)).toEqual(before);
    expect(readFileSync(s.deps.paths.supplementFile(ID, 1)).equals(v1)).toBe(true);
    const rowAfter = papersRow(s);
    for (const k of Object.keys(rowBefore)) if (!ALLOWED.has(k)) expect(rowAfter[k], k).toEqual(rowBefore[k]);
    expect(rowAfter).toMatchObject({ supplementVersion: 2, structureSource: 'latexml', codeUrl: 'https://github.com/example/synthetic-registration', ingestStatus: 'done' });
    expect(rowAfter.structureReadyAt).toBe(rowBefore.structureReadyAt);
    const d = (await call(s, 'GET', `/papers/${ID}`)).json as PaperDetailDto;
    expect(jobOf(d)).toEqual(lastJobBefore);
    expect(d.lastJob?.id).not.toBe(jobId);
    expect(d.structureUpgrade).toMatchObject({ available: false, reason: null, job: { id: jobId, kind: 'upgrade_structure', status: 'done' } });
    expect(structureCounts(s.deps, ID)).toEqual([4, 7, 2, 3]);
    // M1 PDF: only I, II, (1), (2) anchored
    const anchored = s.deps.sqlite.prepare(`SELECT number FROM sections WHERE paperId = ? AND pdfPage IS NOT NULL UNION ALL SELECT number FROM equations WHERE paperId = ? AND pdfPage IS NOT NULL`).all(ID, ID);
    expect(anchored).toEqual([{ number: 'I' }, { number: 'II' }, { number: '1' }, { number: '2' }]);
    expect((await call(s, 'POST', `/papers/${ID}/upgrade-structure`, {})).status).toBe(409);
  });

  it('a fault between the file publication and the commit → job failed, paper unchanged; running it again succeeds', async () => {
    const s = await upgradeServer();
    let fail = true;
    configureIngest(s.deps, {
      inject: (pt) => {
        if (pt === 'publish.after' && fail) throw new Error('injected fault before T_struct');
      },
    });
    const first = await upgradeAndWait(s.deps, ID);
    expect(first.job.status).toBe('failed');
    expect(paper(s.deps, ID)).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(structureCounts(s.deps, ID)).toEqual([0, 0, 0, 0]);
    expect(warnings(s.deps, ID)).toEqual([]);
    fail = false;
    const second = await upgradeAndWait(s.deps, ID);
    expect(second.job.status).toBe('done');
    expect(second.events.at(-1)!.event).toBe('job.done');
    expect(paper(s.deps, ID)).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
  });

  it('a server shutdown while it runs → job interrupted, paper in its M1 state, the upgrade can run again after the restart', async () => {
    const s = await upgradeServer();
    let entered!: () => void;
    const at = new Promise<void>((r) => (entered = r));
    configureIngest(s.deps, {
      beforeStep: (step, _job, signal) => {
        if (step !== 'anchor') return;
        entered();
        return new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new IngestError('cancelled', 'aborted')), { once: true }));
      },
    });
    const { jobId } = ingestService(s.deps).upgradeStructure(ID);
    await at;
    const s2 = await s.restart();
    servers.splice(servers.indexOf(s), 1, s2);
    expect(s2.deps.sqlite.prepare(`SELECT status FROM jobs WHERE id = ?`).get(jobId)).toEqual({ status: 'interrupted' });
    expect(paper(s2.deps, ID)).toMatchObject({ supplementVersion: 1, structureSource: 'none', ingestStatus: 'done' });
    configureIngest(s2.deps, { beforeStep: undefined });
    expect(((await call(s2, 'GET', `/papers/${ID}`)).json as PaperDetailDto).structureUpgrade).toMatchObject({ available: true, job: { id: jobId, status: 'interrupted' } });
    expect((await upgradeAndWait(s2.deps, ID)).job.status).toBe('done');
  });

  it('a parse failure is final: structure_parse_failed stored, job failed (code internal), available false, a second call → 409', async () => {
    const s = await upgradeServer('<!DOCTYPE html><html><body>no LaTeXML</body></html>');
    const { job, events } = await upgradeAndWait(s.deps, ID);
    expect(job.status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ event: 'job.error', data: { code: 'internal' } });
    expect(warnings(s.deps, ID)).toEqual(['structure_parse_failed']);
    expect(((await call(s, 'GET', `/papers/${ID}`)).json as PaperDetailDto).structureUpgrade).toMatchObject({ available: false, reason: null });
    expect((await call(s, 'POST', `/papers/${ID}/upgrade-structure`, {})).status).toBe(409);
    expect(paper(s.deps, ID)).toMatchObject({ supplementVersion: 1, structureSource: 'none', ingestStatus: 'done' });
    expect(existsSync(s.deps.paths.sourceHtmlFile(ID))).toBe(false); // settled: no source.html without a files row
  });

  it('an unexpected exception in the anchor step of an upgrade stays retryable: job.error internal, no warning, available, then succeeds', async () => {
    const s = await upgradeServer();
    let fail = true;
    configureIngest(s.deps, {
      inject: (point) => {
        if (point === 'anchor.run' && fail) throw new Error('injected anchor exception');
      },
    });
    const { job, events } = await upgradeAndWait(s.deps, ID);
    expect(job.status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ event: 'job.error', data: { code: 'internal' } });
    expect(warnings(s.deps, ID)).toEqual([]);
    expect(structureCounts(s.deps, ID)).toEqual([0, 0, 0, 0]);
    expect(paper(s.deps, ID)).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(((await call(s, 'GET', `/papers/${ID}`)).json as PaperDetailDto).structureUpgrade).toMatchObject({ available: true, reason: 'm1_paper' });
    fail = false;
    expect((await upgradeAndWait(s.deps, ID)).job.status).toBe('done');
    expect(paper(s.deps, ID)).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
  });

  it.each([
    ['HTML 404', null, 'not_found', 'html_not_found'],
    ['version mismatch', SYN_M2_HTML.replace('arXiv:0000.00001v1</p>', 'arXiv:2301.00002v3</p>'), 'version_mismatch', 'html_version_mismatch'],
    // the decision is not bound to the 1,000-entry mention list (M-M2-R2-5)
    ['v1 ×1,000 then v2 in the text', SYN_M2_HTML.replace('arXiv:0000.00001v1</p>', `${'arXiv:2301.00002v1 '.repeat(1_000)}arXiv:2301.00002v2</p>`), 'version_mismatch', 'html_version_mismatch'],
    // the parsed text names v2 where the raw scan cannot see it: an entity, an inline element (M-M2-R2-5)
    ['v2 written with an entity', SYN_M2_HTML.replace('arXiv:0000.00001v1</p>', 'arXiv:0000.00001v1</p><p>arXiv:2301&#46;00002v2</p>'), 'version_mismatch', 'html_version_mismatch'],
    ['v2 split by an inline element', SYN_M2_HTML.replace('arXiv:0000.00001v1</p>', 'arXiv:0000.00001v1</p><p>arXiv:2301.<b>00002</b>v2</p>'), 'version_mismatch', 'html_version_mismatch'],
    // text before <html> is at document level in linkedom; the walk reads every child of the document (A-F4R1-01)
    ['v2 with an entity between the doctype and <html>', SYN_M2_HTML.replace('<!DOCTYPE html>', '<!DOCTYPE html>arXiv:2301&#46;00002v2'), 'version_mismatch', 'html_version_mismatch'],
  ])('%s is final → job.error %s + warning %s', async (_n, html, code, warning) => {
    const s = await upgradeServer(html);
    const { events } = await upgradeAndWait(s.deps, ID);
    expect(events.at(-1)).toMatchObject({ event: 'job.error', data: { code } });
    expect(warnings(s.deps, ID)).toEqual([warning]);
    expect(((await call(s, 'GET', `/papers/${ID}`)).json as PaperDetailDto).structureUpgradeAvailable).toBe(false);
    // the paper stays as the M1 import left it: no structure rows, supplement v1, structureSource none
    expect(structureCounts(s.deps, ID)).toEqual([0, 0, 0, 0]);
    expect(paper(s.deps, ID)).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
  });

  // A-FX-01: the paper's own version (2301.00002v1) followed by LaTeXML's footnote mark is the own version — before,
  // the parsed text read "v111" and the upgrade failed for good (available false)
  it("the own version followed by LaTeXML's footnote mark → the upgrade succeeds: v2, latexml, structure rows, no warning (A-FX-01)", async () => {
    const s = await upgradeServer(SYN_M2_HTML.replace('arXiv:0000.00001v1</p>', `arXiv:0000.00001v1</p><p>A preprint is available as arXiv:2301.00002v1${latexmlFootnote(1)}.</p>`));
    const { job, events } = await upgradeAndWait(s.deps, ID);
    expect(job.status).toBe('done');
    expect(events.at(-1)?.event).toBe('job.done');
    expect(warnings(s.deps, ID)).toEqual([]);
    expect(paper(s.deps, ID)).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
    expect(structureCounts(s.deps, ID)).toEqual([4, 7, 2, 3]);
    expect(((await call(s, 'GET', `/papers/${ID}`)).json as PaperDetailDto).structureUpgradeAvailable).toBe(false);
  });

  it('a timeout is transient: no warning, job.error timeout, the upgrade stays available and succeeds later', async () => {
    const s = await upgradeServer();
    let fail = true;
    useSource(s.deps, new FakeArxivSource({ '2301.00002': { version: 1, html: () => (fail ? Promise.reject(new FetchError('timeout', 'no response headers within 20000 ms', undefined, undefined, 'headers')) : SYN_M2_HTML) } }));
    const { events } = await upgradeAndWait(s.deps, ID);
    expect(events.at(-1)).toMatchObject({ event: 'job.error', data: { code: 'timeout' } });
    expect(warnings(s.deps, ID)).toEqual([]);
    expect(((await call(s, 'GET', `/papers/${ID}`)).json as PaperDetailDto).structureUpgrade).toMatchObject({ available: true, reason: 'm1_paper', job: { status: 'failed' } });
    fail = false;
    expect((await upgradeAndWait(s.deps, ID)).job.status).toBe('done');
  });

  it('a running upgrade: a second call returns the same job id', async () => {
    const s = await upgradeServer();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    configureIngest(s.deps, { beforeStep: (step) => (step === 'html' ? gate : undefined) });
    const a = ingestService(s.deps).upgradeStructure(ID);
    expect(ingestService(s.deps).upgradeStructure(ID)).toEqual(a);
    expect((await call(s, 'POST', `/papers/${ID}/upgrade-structure`, {})).json).toEqual(a);
    release();
    await ingestService(s.deps).whenDone(a.jobId);
    copyFileSync(s.deps.paths.supplementFile(ID, 2), join(tempDir('sp-keep-'), 'v2.txt')); // the file exists
  });
});
