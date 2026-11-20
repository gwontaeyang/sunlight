// Seeds (BRIEF_S S7, PLAN_M2 D19). Owner: supervisor.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaperDetailDto, StructureResponse } from '@study-paper/shared/contracts/api';
import { ALL_SEED_PAPERS, SEED_LINKS_PAPER_ID, SEED_LINKS_TITLE, SEED_M2_PAPER_ID, SEED_M2_TITLE, SEED_PAPER_ID, SEED_TITLE, SEED_UPGRADE_INGEST_JOB_ID, SEED_UPGRADE_PAPER_ID, SEED_UPGRADE_TITLE } from '../../src/dev/seedFixture';
import { startTestServer, type TestServer } from '../helpers/server';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
// tag m1 values (computed from `git show m1:<file>`; constants on purpose)
const M1_PDF_SHA = 'bee70ae74d8864a4f3c78d6393f889d0f3466d4218327e5962006384c3bc3ba6';
const M1_HTML_SHA = 'a1fbac0125d813a79215cacac925d159f98ce0df8838a87f2db50ea9219c4378';
const M1_SUPPLEMENT_SHA = '22147d60d869dc93fff5ad1febd1d1f768cbcfdf59d32528fd430877cd2c3e62';

let s: TestServer;
let m1Only: TestServer;
beforeAll(async () => {
  s = await startTestServer({ env: 'prod', papers: [...ALL_SEED_PAPERS] });
  m1Only = await startTestServer({ env: 'prod', seed: true });
});
afterAll(async () => {
  await s.close();
  await m1Only.close();
});
const get = async <T>(srv: TestServer, path: string): Promise<T> => {
  const r = await srv.req(`/api${path}`, { headers: { 'X-SP-Token': srv.token } });
  expect(r.status, r.text.slice(0, 200)).toBe(200);
  return JSON.parse(r.text) as T;
};
const count = (srv: TestServer, sql: string, ...a: unknown[]) => (srv.deps.sqlite.prepare(sql).get(...a) as { n: number }).n;

describe('seedFixture', () => {
  it('each seed: readable, contextReady and structureReady; structureSource, supplementVersion and title', async () => {
    const want: [string, string, string, number][] = [
      [SEED_PAPER_ID, SEED_TITLE, 'latexml', 1],
      [SEED_UPGRADE_PAPER_ID, SEED_UPGRADE_TITLE, 'none', 1],
      [SEED_LINKS_PAPER_ID, SEED_LINKS_TITLE, 'latexml', 2],
      [SEED_M2_PAPER_ID, SEED_M2_TITLE, 'latexml', 2],
    ];
    for (const [id, title, structureSource, supplementVersion] of want) {
      const p = await get<PaperDetailDto>(s, `/papers/${id}`);
      expect(p, id).toMatchObject({ title, structureSource, supplementVersion, state: { readable: true, contextReady: true, structureReady: true }, ai: { available: true } });
    }
    // M2 titles never contain the M1 title (an e2e partial name match must stay unique)
    for (const t of [SEED_UPGRADE_TITLE, SEED_LINKS_TITLE, SEED_M2_TITLE]) expect(t.includes(SEED_TITLE)).toBe(false);
    const arxiv = s.deps.sqlite.prepare(`SELECT id, arxivId, arxivVersion, source FROM papers ORDER BY id`).all();
    expect(arxiv).toEqual([
      { id: SEED_PAPER_ID, arxivId: null, arxivVersion: null, source: 'upload' },
      { id: SEED_UPGRADE_PAPER_ID, arxivId: '2301.00002', arxivVersion: 1, source: 'arxiv' },
      { id: SEED_LINKS_PAPER_ID, arxivId: '2301.00003', arxivVersion: 1, source: 'arxiv' },
      { id: SEED_M2_PAPER_ID, arxivId: '2301.00004', arxivVersion: 1, source: 'arxiv' },
    ]);
  });

  it('files on disk match their files rows (sha, bytes) for every seed', () => {
    const rows = s.deps.sqlite.prepare(`SELECT relPath, sha256, bytes FROM files`).all() as { relPath: string; sha256: string; bytes: number }[];
    expect(rows.length).toBe(3 + 2 + 2 + 3);
    for (const r of rows) {
      const b = readFileSync(join(s.dataDir, r.relPath));
      expect({ p: r.relPath, sha: sha(b), bytes: b.length }).toEqual({ p: r.relPath, sha: r.sha256, bytes: r.bytes });
    }
    const pdfSha = (id: string) => (s.deps.sqlite.prepare(`SELECT pdfSha256 FROM papers WHERE id = ?`).get(id) as { pdfSha256: string }).pdfSha256;
    expect(pdfSha(SEED_UPGRADE_PAPER_ID)).toBe(M1_PDF_SHA); // the upgrade target has the M1 PDF
    expect(pdfSha(SEED_M2_PAPER_ID)).toBe(sha(readFileSync(new URL('../fixtures/synthetic-m2.pdf', import.meta.url))));
  });

  it('SEED_M2 anchors: I, II, II-A, eq 1, 2 and the figure located; II-B, the table, eq 3, 4, A.1 null; positions increase in document order', async () => {
    const st = await get<StructureResponse>(s, `/papers/${SEED_M2_PAPER_ID}/structure`);
    expect(st.sections.map((x) => [x.number, x.pdfPage !== null, x.pdfRect !== null])).toEqual([
      ['I', true, true],
      ['II', true, true],
      ['II-A', true, true],
      ['II-B', false, false],
    ]);
    expect(st.equations.map((x) => [x.number, x.pdfPage, x.katexOk])).toEqual([
      ['1', 1, true],
      ['2', 2, true],
      ['3', null, true],
      ['4', null, false],
      [null, null, true],
      ['A.1', null, true],
      ['A.1', null, true],
    ]);
    expect(st.figures.map((f) => [f.kind, f.number, f.pdfPage])).toEqual([
      ['figure', '1', 1],
      ['table', '1', null],
    ]);
    const key = (x: { pdfPage: number | null; pdfOffset: number | null }) => x.pdfPage! * 1e6 + x.pdfOffset!;
    for (const list of [st.sections, st.equations]) {
      const located = list.filter((x) => x.pdfPage !== null);
      for (let i = 1; i < located.length; i++) expect(key(located[i]!)).toBeGreaterThan(key(located[i - 1]!));
    }
    // positions computed from this seed's PDF (synthetic-m2.pdf): II-A at the "A. Robust Kernel" line, (2) at 270
    expect(st.sections.find((x) => x.number === 'II-A')).toMatchObject({ pdfPage: 2, pdfOffset: 174 });
    expect(st.equations.find((x) => x.number === '2')).toMatchObject({ pdfPage: 2, pdfOffset: 270 });
    expect(st.references.map((r) => [r.label, r.htmlId, r.arxivId, r.inLibraryPaperId])).toEqual([
      ['[1]', 'bib.bib1', null, null],
      ['[2]', 'bib.bib2', '2301.00003', SEED_LINKS_PAPER_ID],
      ['[3]', 'bib.bib3', '2301.00099', null],
    ]);
  });

  it('SEED_LINKS: section II on page 2, one reference; SEED_UPGRADE: no structure rows', async () => {
    const links = await get<StructureResponse>(s, `/papers/${SEED_LINKS_PAPER_ID}/structure`);
    expect(links.sections.map((x) => [x.number, x.title, x.pdfPage])).toEqual([['II', 'Method', 2]]);
    expect(links.references.map((r) => [r.ordinal, r.label])).toEqual([[1, '[1]']]);
    const up = await get<StructureResponse>(s, `/papers/${SEED_UPGRADE_PAPER_ID}/structure`);
    expect(up).toEqual({ structureSource: 'none', sections: [], equations: [], figures: [], references: [] });
  });

  it('SEED_UPGRADE has the finished ingest job M1 import leaves: papers.get lastJob = that job (import_arxiv, done, M1 steps ok); the other seeds have none', async () => {
    const up = await get<PaperDetailDto>(s, `/papers/${SEED_UPGRADE_PAPER_ID}`);
    expect(up.lastJob).toEqual({
      id: SEED_UPGRADE_INGEST_JOB_ID,
      kind: 'import_arxiv',
      paperId: SEED_UPGRADE_PAPER_ID,
      status: 'done',
      steps: [{ step: 'resolve', status: 'ok', detail: '2301.00002v1' }, ...['metadata', 'pdf', 'text', 'supplement'].map((step) => ({ step, status: 'ok' }))],
      error: null,
    });
    expect(s.deps.sqlite.prepare(`SELECT paperId, kind, status FROM jobs`).all()).toEqual([{ paperId: SEED_UPGRADE_PAPER_ID, kind: 'import_arxiv', status: 'done' }]);
    for (const id of [SEED_PAPER_ID, SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID]) expect((await get<PaperDetailDto>(s, `/papers/${id}`)).lastJob, id).toBeNull();
    expect(count(m1Only, `SELECT count(*) AS n FROM jobs`)).toBe(0);
  });

  it('SEED_PAPER_ID is unchanged: file bytes equal the tag-m1 values; default seeding makes exactly the M1 rows', () => {
    for (const srv of [s, m1Only]) {
      const dir = srv.deps.paths.paperDir(SEED_PAPER_ID);
      expect(sha(readFileSync(join(dir, 'paper.pdf')))).toBe(M1_PDF_SHA);
      expect(sha(readFileSync(join(dir, 'source.html')))).toBe(M1_HTML_SHA);
      expect(sha(readFileSync(join(dir, 'supplement.txt')))).toBe(M1_SUPPLEMENT_SHA);
      expect(count(srv, `SELECT count(*) AS n FROM files WHERE paperId = ?`, SEED_PAPER_ID)).toBe(3);
      expect(count(srv, `SELECT count(*) AS n FROM sections WHERE paperId = ?`, SEED_PAPER_ID)).toBe(2);
      expect(count(srv, `SELECT count(*) AS n FROM equations WHERE paperId = ?`, SEED_PAPER_ID)).toBe(2);
    }
    expect(count(m1Only, `SELECT count(*) AS n FROM papers`)).toBe(1);
  });
});
