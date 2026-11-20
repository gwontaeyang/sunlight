// Owner A. Area highlights (M2, PLAN_M2 3.5): PNG check failures are 400 with no file; the stored PNG comes back
// byte-identical through papers.capture; a failing transaction leaves no file; sectionId = the last anchored section
// before the highlight; a request after the deletion tombstone is 404 and never re-creates papers/<id>/.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HighlightDto } from '@study-paper/shared/contracts/api';
import { SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { makeTestPng } from '../helpers/png';
import { startTestServer, type TestServer } from '../helpers/server';

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer({ env: 'test', papers: ['links', 'm2'] });
});
afterAll(async () => {
  await s.close();
});
async function create(paperId: string, body: Record<string, unknown>) {
  const r = await s.req(`/api/papers/${paperId}/highlights`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ color: 1, ...body }) });
  return { status: r.status, json: JSON.parse(r.text) as unknown };
}
const area = (page: number, y: number, extra: Record<string, unknown> = {}) => ({ kind: 'area', page, rects: [{ page, x: 0.1, y, w: 0.3, h: 0.05 }], ...extra });
const captures = (id: string) => (existsSync(s.deps.paths.capturesDir(id)) ? readdirSync(s.deps.paths.capturesDir(id)) : []);
const captureRows = (id: string) => (s.deps.sqlite.prepare(`SELECT count(*) AS n FROM files WHERE paperId = ? AND kind = 'capture'`).get(id) as { n: number }).n;
const sectionByNumber = (n: string) => (s.deps.sqlite.prepare(`SELECT id, pdfRectJson FROM sections WHERE paperId = ? AND number = ?`).get(SEED_M2_PAPER_ID, n) as { id: string; pdfRectJson: string });

describe('area highlights', () => {
  it('a broken PNG (bad CRC, not canonical base64, too small) → 400 and no file or row', async () => {
    const png = Buffer.from(makeTestPng({ width: 16, height: 16 }));
    png[png.length - 1] ^= 0xff;
    const tiny = makeTestPng({ width: 4, height: 4 }).toString('base64');
    for (const imagePng of [png.toString('base64'), 'AB==', tiny]) {
      const r = await create(SEED_M2_PAPER_ID, area(1, 0.5, { imagePng }));
      expect(r.status, imagePng.slice(0, 8)).toBe(400);
    }
    expect(captures(SEED_M2_PAPER_ID)).toEqual([]);
    expect(captureRows(SEED_M2_PAPER_ID)).toBe(0);
  });

  it('stored → papers.capture serves the same bytes; quote null, position null, one rect', async () => {
    const png = makeTestPng({ width: 40, height: 30 });
    const r = await create(SEED_M2_PAPER_ID, area(1, 0.5, { imagePng: png.toString('base64'), comment: '그림' }));
    expect(r.status).toBe(200);
    const h = r.json as HighlightDto;
    expect(h).toMatchObject({ kind: 'area', quote: null, position: null, comment: '그림', rects: [{ page: 1, x: 0.1, y: 0.5, w: 0.3, h: 0.05 }] });
    const got = await s.req(`/api/papers/${SEED_M2_PAPER_ID}/captures/${h.imageFileId}`, { headers: { 'X-SP-Token': s.token } });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toContain('image/png');
    expect(got.body.equals(png)).toBe(true);
    expect(captures(SEED_M2_PAPER_ID)).toEqual([`${h.imageFileId}.png`]);
  });

  it('a transaction failure after the file was written → no file and no files row', async () => {
    const before = captures(SEED_M2_PAPER_ID);
    const rows = captureRows(SEED_M2_PAPER_ID);
    s.deps.sqlite.exec(`CREATE TEMP TRIGGER fail_highlight BEFORE INSERT ON highlights BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    try {
      const r = await create(SEED_M2_PAPER_ID, area(1, 0.5, { imagePng: makeTestPng({ width: 20, height: 20 }).toString('base64') }));
      expect(r.status).toBe(500);
    } finally {
      s.deps.sqlite.exec(`DROP TRIGGER fail_highlight`);
    }
    expect(captures(SEED_M2_PAPER_ID)).toEqual(before);
    expect(captureRows(SEED_M2_PAPER_ID)).toBe(rows);
    expect(readdirSync(s.deps.paths.tmpDir).filter((f) => f.endsWith('.capture.part'))).toEqual([]);
  });

  it('sectionId: the last anchored section before (page, start) / (page, rect top); unknown on a page with a heading → null', async () => {
    const ii = sectionByNumber('II');
    const iiA = sectionByNumber('II-A');
    const iiARect = JSON.parse(iiA.pdfRectJson) as { y: number };
    const I = sectionByNumber('I');
    // text: "down-weights outliers" is between II and II-A; "first-order Jacobian" after II-A
    const t1 = (await create(SEED_M2_PAPER_ID, { kind: 'text', quote: { exact: 'down-weights outliers' }, page: 2, rects: [{ page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }] })).json as HighlightDto;
    expect([t1.position !== null, t1.sectionId]).toEqual([true, ii.id]);
    const t2 = (await create(SEED_M2_PAPER_ID, { kind: 'text', quote: { exact: 'first-order Jacobian' }, page: 2, rects: [{ page: 2, x: 0.1, y: 0.5, w: 0.3, h: 0.02 }] })).json as HighlightDto;
    expect(t2.sectionId).toBe(iiA.id);
    // text without a position (ambiguous on the page) on a page with headings → null
    const t3 = (await create(SEED_M2_PAPER_ID, { kind: 'text', quote: { exact: 'robust kernel' }, page: 2, rects: [{ page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }] })).json as HighlightDto;
    expect([t3.position, t3.sectionId]).toEqual([null, null]);
    // area: above / below the II-A heading's rect
    expect(((await create(SEED_M2_PAPER_ID, area(2, Math.max(0, iiARect.y - 0.02)))).json as HighlightDto).sectionId).toBe(ii.id);
    expect(((await create(SEED_M2_PAPER_ID, area(2, Math.min(0.9, iiARect.y + 0.05)))).json as HighlightDto).sectionId).toBe(iiA.id);
    expect(((await create(SEED_M2_PAPER_ID, area(1, 0.9))).json as HighlightDto).sectionId).toBe(I.id);
    // a paper whose page has no anchored heading before the area: the links seed (II on page 1?) — a page-1 area at the top
    const links = (await create(SEED_LINKS_PAPER_ID, area(1, 0))).json as HighlightDto;
    expect(links.sectionId).toBeNull();
  });

  it('after the deletion tombstone: 404, and papers/<id>/ is never re-created (also when the directory is already gone)', async () => {
    s.deps.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(Date.now(), SEED_LINKS_PAPER_ID);
    rmSync(s.deps.paths.paperDir(SEED_LINKS_PAPER_ID), { recursive: true, force: true });
    const r = await create(SEED_LINKS_PAPER_ID, area(1, 0.5, { imagePng: makeTestPng({ width: 20, height: 20 }).toString('base64') }));
    expect(r.status).toBe(404);
    expect(existsSync(s.deps.paths.paperDir(SEED_LINKS_PAPER_ID))).toBe(false);
    expect(readdirSync(s.deps.paths.tmpDir).filter((f) => f.endsWith('.capture.part'))).toEqual([]);
  });
});
