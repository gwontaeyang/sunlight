// Owner A. papers.structure (PLAN_M2 3.2): ordinal order with unnumbered equations, inLibraryPaperId decided on read
// from the reference's arxivId (never stored): SEED_M2 [2] → SEED_LINKS, [3] → not in the Library, [1] → no id; a
// Library paper that is being deleted does not count. A paper without structure → empty arrays + its structureSource.
import { afterEach, describe, expect, it } from 'vitest';
import type { StructureResponse } from '@study-paper/shared/contracts/api';
import { SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID, SEED_UPGRADE_PAPER_ID } from '../../src/dev/seedFixture';
import { startTestServer, type TestServer } from '../helpers/server';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const read = async (s: TestServer, id: string) => {
  const r = await s.req(`/api/papers/${id}/structure`, { headers: { 'X-SP-Token': s.token } });
  return { status: r.status, body: JSON.parse(r.text) as StructureResponse };
};

describe('papers.structure', () => {
  it('SEED_M2: rows in ordinal order (the unnumbered equation included), references with inLibraryPaperId on read', async () => {
    const s = await startTestServer({ env: 'test', papers: ['links', 'upgrade', 'm2'] });
    servers.push(s);
    const { status, body } = await read(s, SEED_M2_PAPER_ID);
    expect(status).toBe(200);
    expect(body.structureSource).toBe('latexml');
    expect(body.sections.map((x) => x.number)).toEqual(['I', 'II', 'II-A', 'II-B']);
    expect(body.equations.map((x) => x.number)).toEqual(['1', '2', '3', '4', null, 'A.1', 'A.1']);
    expect(body.references.map((r) => [r.label, r.arxivId, r.inLibraryPaperId])).toEqual([
      ['[1]', null, null],
      ['[2]', '2301.00003', SEED_LINKS_PAPER_ID],
      ['[3]', '2301.00099', null],
    ]);
    expect(s.deps.sqlite.prepare(`SELECT count(*) AS n FROM paper_references WHERE inLibraryPaperId IS NOT NULL`).get()).toEqual({ n: 0 }); // never stored

    s.deps.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(Date.now(), SEED_LINKS_PAPER_ID);
    expect((await read(s, SEED_M2_PAPER_ID)).body.references[1]!.inLibraryPaperId).toBeNull();

    const none = await read(s, SEED_UPGRADE_PAPER_ID);
    expect(none.body).toEqual({ structureSource: 'none', sections: [], equations: [], figures: [], references: [] });
    expect((await read(s, SEED_LINKS_PAPER_ID)).status).toBe(404); // a paper being deleted is gone for the API
  });
});
