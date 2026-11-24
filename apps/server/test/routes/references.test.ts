import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImportPaperResponse, PaperDetailDto, ReferenceSearchResponse } from '@study-paper/shared/contracts/api';
import { SEED_ARXIV_IDS, SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID, SEED_UPGRADE_PAPER_ID } from '../../src/dev/seedFixture';
import { configureIngest } from '../../src/ingest/pipeline';
import { startTestServer, type TestServer } from '../helpers/server';
import { atomFeed, FakeArxivSource, SYNTHETIC_PDF, waitJob } from '../ingest/helpers';

const title = 'Synthetic reconstruction';
let server: TestServer;
beforeEach(async () => { server = await startTestServer({ env: 'test', papers: ['links', 'upgrade', 'm2'] }); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await server.close();
});

function search() {
  return server.req('/api/references/find', {
    method: 'POST', headers: { 'X-SP-Token': server.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  });
}

it('marks only live Library papers with the same canonical arXiv ID or case-insensitive DOI', async () => {
  const db = server.deps.sqlite;
  db.prepare('UPDATE papers SET doi = ? WHERE id = ?').run('10.1234/Mock.Index', SEED_M2_PAPER_ID);
  db.prepare('UPDATE papers SET deletingAt = ? WHERE id = ?').run(1, SEED_UPGRADE_PAPER_ID);
  configureIngest(server.deps, {
    fetchImpl: async url => new URL(url).hostname === 'export.arxiv.org'
      ? new Response(atomFeed([SEED_ARXIV_IDS.links, SEED_ARXIV_IDS.upgrade, '2402.98765'].map(id => ({ id, version: 2, title }))))
      : Response.json({ status: 'ok', message: { items: [{ DOI: '10.1234/mock.index', title: [title] }] } }),
  });
  const res = await search();
  expect(res.status).toBe(200);
  const { candidates, unavailable } = ReferenceSearchResponse.parse(JSON.parse(res.text));
  expect(unavailable).toEqual([]);
  expect(Object.fromEntries(candidates.map(c => [c.arxivId ?? c.doi, c.inLibraryPaperId]))).toEqual({
    [SEED_ARXIV_IDS.links + 'v2']: SEED_LINKS_PAPER_ID,
    [SEED_ARXIV_IDS.upgrade + 'v2']: null,
    '2402.98765v2': null,
    '10.1234/mock.index': SEED_M2_PAPER_ID,
  });
});

it.each([
  ['SP_NETWORK', 'off', 'network_off'],
  ['SP_NETWORK_MAX_REQUESTS', '0', 'budget'],
])('reports the %s guard before invoking either transport', async (key, value, reason) => {
  vi.stubEnv(key, value);
  const fetchImpl = vi.fn(async () => Response.json({}));
  configureIngest(server.deps, { fetchImpl });
  const res = await search();
  expect(res.status).toBe(503);
  expect(JSON.parse(res.text).error).toMatchObject({ code: 'reference_search_unavailable', details: { reason } });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('sends a fixed failure message when both providers return errors', async () => {
  const fetchImpl = vi.fn(async () => new Response('untrusted upstream diagnostic', { status: 503 }));
  configureIngest(server.deps, { fetchImpl });
  const res = await search();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(res.status).toBe(503);
  expect(JSON.parse(res.text).error).toMatchObject({ code: 'reference_search_unavailable', details: { reason: 'providers' } });
  expect(res.text).not.toContain('untrusted upstream diagnostic');
});

it('imports the chosen search candidate into the Library and serves its original PDF without fetching it twice', async () => {
  const record = { id: '2403.99991', version: 2, title };
  const source = new FakeArxivSource({ [record.id]: record });
  configureIngest(server.deps, {
    source, fetchImpl: async url => new URL(url).hostname === 'export.arxiv.org'
      ? new Response(atomFeed([record])) : Response.json({ status: 'ok', message: { items: [] } }),
  });
  const lookup = await search();
  expect(lookup.status).toBe(200);
  const { candidates } = ReferenceSearchResponse.parse(JSON.parse(lookup.text));
  expect(candidates).toHaveLength(1);
  const { arxivId, inLibraryPaperId } = candidates[0]!;
  expect(arxivId).toBe(record.id + 'v2');
  expect(inLibraryPaperId).toBeNull();
  expect(source.calls.pdf).toBe(0);

  const headers = { 'X-SP-Token': server.token };
  async function importCandidate() {
    const res = await server.req('/api/papers/import', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: arxivId, clientRequestId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(200);
    return ImportPaperResponse.parse(JSON.parse(res.text));
  }
  const { existing, jobId, paperId } = await importCandidate();
  expect(existing).toBe(false);
  expect(jobId).toBeTruthy();
  expect((await waitJob(server.deps, jobId!)).status).toBe('done');
  const paper = await server.req('/api/papers/' + paperId, { headers });
  expect(PaperDetailDto.parse(JSON.parse(paper.text))).toMatchObject({
    arxivId: record.id, arxivVersion: 2, title, state: { readable: true },
  });
  const pdf = await server.req('/api/papers/' + paperId + '/pdf', { headers });
  expect(pdf.status).toBe(200);
  expect(pdf.body.equals(SYNTHETIC_PDF)).toBe(true);
  expect(await importCandidate()).toMatchObject({ existing: true, paperId });
  expect(source.calls.pdf).toBe(1);
});
