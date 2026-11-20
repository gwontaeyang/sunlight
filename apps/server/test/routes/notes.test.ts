// Owner A. notes (M2): highlightId / sectionId must belong to the same paper; 2,000 notes per paper; a deleted paper
// (tombstone) answers 404 for its notes; list order = creation order.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NoteDto } from '@study-paper/shared/contracts/api';
import { ErrorDtoSchema } from '@study-paper/shared/contracts/errors';
import { SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { NOTES_PER_PAPER } from '../../src/routes/notes';
import { startTestServer, type TestServer } from '../helpers/server';

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer({ env: 'test', papers: ['links', 'm2'] });
});
afterAll(async () => {
  await s.close();
});
async function call(method: string, path: string, body?: unknown) {
  const r = await s.req(`/api${path}`, { method, headers: { 'X-SP-Token': s.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: r.text ? (JSON.parse(r.text) as unknown) : null };
}
const sectionOf = (paperId: string) => (s.deps.sqlite.prepare(`SELECT id FROM sections WHERE paperId = ? ORDER BY ordinal LIMIT 1`).get(paperId) as { id: string }).id;
const code = (r: { json: unknown }) => ErrorDtoSchema.parse(r.json).error.code;

describe('notes', () => {
  it('a note on a highlight and a section of the same paper; other papers\' ids → 400', async () => {
    const h = (await call('POST', `/papers/${SEED_M2_PAPER_ID}/highlights`, { kind: 'text', color: 1, quote: { exact: 'first-order Jacobian' }, page: 2, rects: [{ page: 2, x: 0.1, y: 0.5, w: 0.3, h: 0.02 }] })).json as { id: string };
    const ok = await call('POST', `/papers/${SEED_M2_PAPER_ID}/notes`, { bodyMd: 'n1', highlightId: h.id, sectionId: sectionOf(SEED_M2_PAPER_ID) });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ highlightId: h.id, sectionId: sectionOf(SEED_M2_PAPER_ID) });
    const otherSec = await call('POST', `/papers/${SEED_M2_PAPER_ID}/notes`, { bodyMd: 'x', sectionId: sectionOf(SEED_LINKS_PAPER_ID) });
    expect([otherSec.status, code(otherSec)]).toEqual([400, 'validation']);
    const otherH = await call('POST', `/papers/${SEED_LINKS_PAPER_ID}/notes`, { bodyMd: 'x', highlightId: h.id });
    expect([otherH.status, code(otherH)]).toEqual([400, 'validation']);
  });

  it('list in creation order; patch; delete; 404 for unknown ids', async () => {
    const a = (await call('POST', `/papers/${SEED_LINKS_PAPER_ID}/notes`, { bodyMd: 'first' })).json as NoteDto;
    const b = (await call('POST', `/papers/${SEED_LINKS_PAPER_ID}/notes`, { bodyMd: 'second' })).json as NoteDto;
    expect(((await call('GET', `/papers/${SEED_LINKS_PAPER_ID}/notes`)).json as { notes: NoteDto[] }).notes.map((n) => n.id)).toEqual([a.id, b.id]);
    const p = await call('PATCH', `/notes/${a.id}`, { bodyMd: 'first, edited' });
    expect(p.json).toMatchObject({ id: a.id, bodyMd: 'first, edited' });
    expect((p.json as NoteDto).updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
    expect((await call('DELETE', `/notes/${b.id}`)).status).toBe(204);
    expect((await call('DELETE', `/notes/${b.id}`)).status).toBe(404);
    expect((await call('PATCH', `/notes/${b.id}`, { bodyMd: 'x' })).status).toBe(404);
  });

  it(`at most ${NOTES_PER_PAPER} notes per paper → 409`, async () => {
    const now = Date.now();
    const ins = s.deps.sqlite.prepare(`INSERT INTO notes (id, paperId, bodyMd, createdAt, updatedAt) VALUES (?, ?, 'x', ?, ?)`);
    const have = (s.deps.sqlite.prepare(`SELECT count(*) AS n FROM notes WHERE paperId = ?`).get(SEED_M2_PAPER_ID) as { n: number }).n;
    s.deps.sqlite.transaction(() => {
      for (let i = have; i < NOTES_PER_PAPER - 1; i++) ins.run(crypto.randomUUID(), SEED_M2_PAPER_ID, now, now);
    })();
    expect((await call('POST', `/papers/${SEED_M2_PAPER_ID}/notes`, { bodyMd: 'the last one' })).status).toBe(200);
    const over = await call('POST', `/papers/${SEED_M2_PAPER_ID}/notes`, { bodyMd: 'one too many' });
    expect([over.status, code(over)]).toEqual([409, 'conflict']);
  });

  it('a paper being deleted (tombstone): its notes answer 404', async () => {
    const n = (await call('POST', `/papers/${SEED_LINKS_PAPER_ID}/notes`, { bodyMd: 'x' })).json as NoteDto;
    s.deps.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(Date.now(), SEED_LINKS_PAPER_ID);
    expect((await call('GET', `/papers/${SEED_LINKS_PAPER_ID}/notes`)).status).toBe(404);
    expect((await call('PATCH', `/notes/${n.id}`, { bodyMd: 'y' })).status).toBe(404);
    expect((await call('POST', `/papers/${SEED_LINKS_PAPER_ID}/notes`, { bodyMd: 'y' })).status).toBe(404);
  });
});
