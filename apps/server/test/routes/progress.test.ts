// Owner A. reading progress (M2): an upsert per (paper, section), only sections of that paper (404 otherwise), listed
// in section order; the rows go with the section (cascade).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProgressDto } from '@study-paper/shared/contracts/api';
import { SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { startTestServer, type TestServer } from '../helpers/server';

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer({ env: 'test', papers: ['links', 'm2'] });
});
afterAll(async () => {
  await s.close();
});
const put = async (paperId: string, sectionId: string, state: string) => {
  const r = await s.req(`/api/papers/${paperId}/progress/${sectionId}`, { method: 'PUT', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) });
  return { status: r.status, json: JSON.parse(r.text) as unknown };
};
const list = async (paperId: string) => (JSON.parse((await s.req(`/api/papers/${paperId}/progress`, { headers: { 'X-SP-Token': s.token } })).text) as { progress: ProgressDto[] }).progress;
const sections = (paperId: string) => (s.deps.sqlite.prepare(`SELECT id FROM sections WHERE paperId = ? ORDER BY ordinal`).all(paperId) as { id: string }[]).map((r) => r.id);

describe('progress', () => {
  it('upsert: the second put replaces the state (one row); list in section order', async () => {
    const [s1, s2, s3] = sections(SEED_M2_PAPER_ID);
    expect((await put(SEED_M2_PAPER_ID, s3!, 'skimmed')).status).toBe(200);
    expect((await put(SEED_M2_PAPER_ID, s1!, 'skimmed')).status).toBe(200);
    const again = await put(SEED_M2_PAPER_ID, s1!, 'understood');
    expect(again.json).toMatchObject({ sectionId: s1, state: 'understood' });
    expect((await list(SEED_M2_PAPER_ID)).map((p) => [p.sectionId, p.state])).toEqual([
      [s1, 'understood'],
      [s3, 'skimmed'],
    ]);
    expect(s.deps.sqlite.prepare(`SELECT count(*) AS n FROM reading_progress WHERE paperId = ?`).get(SEED_M2_PAPER_ID)).toEqual({ n: 2 });
    void s2;
  });
  it('a section of another paper or an unknown section → 404; nothing written', async () => {
    const other = sections(SEED_LINKS_PAPER_ID)[0]!;
    expect((await put(SEED_M2_PAPER_ID, other, 'skimmed')).status).toBe(404);
    expect((await put(SEED_M2_PAPER_ID, '00000000-0000-4000-8000-00000000dead', 'skimmed')).status).toBe(404);
    expect(await list(SEED_LINKS_PAPER_ID)).toEqual([]);
  });
});
