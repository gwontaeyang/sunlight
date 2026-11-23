// Upload the bytes through the same raw HTTP contract the Library uses; all PDFs are locally generated.
import { mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@study-paper/shared/contracts/api';
import { createApp } from '../../src/app';
import { SEED_PAPER_ID, seedFixture } from '../../src/dev/seedFixture';
import { sha256Hex } from '../../src/ingest/files';
import { makeUploadPdf } from '../fixtures/uploadPdf';
import { startTestServer, type TestServer } from '../helpers/server';

describe('local PDF upload', () => {
  let s: TestServer;
  beforeEach(async () => { s = await startTestServer({ env: 'test' }); });
  afterEach(async () => { await s.close(); });

  const upload = (bytes: Uint8Array, filename = 'study.pdf', mime = 'application/pdf') =>
    s.req('/api/papers/upload', { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': mime, 'X-SP-Filename': encodeURIComponent(filename) }, body: Buffer.from(bytes) });
  const get = (path: string) => s.req('/api/papers/' + path, { headers: { 'X-SP-Token': s.token } });

  it('publishes identical bytes once across concurrent uploads; metadata, edited title and bookmarks survive restart', async () => {
    const bytes = await makeUploadPdf({ bookmarks: true });
    const results = await Promise.all([upload(bytes), upload(bytes, '다른 이름.PDF')]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    const replies = results.map(r => JSON.parse(r.text));
    expect(replies.map(r => r.existing).sort()).toEqual([false, true]);
    const id = replies[0].paperId;
    expect(replies[1].paperId).toBe(id);
    expect(JSON.parse((await get(id)).text)).toMatchObject({ title: 'Learning Point Registration', source: 'upload', pageCount: 2, structureSource: 'pdf-outline', ai: { available: true } });
    const dto = JSON.parse((await get(id + '/structure')).text);
    expect(dto.sections.map((section: { title: string }) => section.title)).toEqual(['Registration procedure', 'Verify the shift']);
    expect(dto.sections[1].parentId).toBe(dto.sections[0].id);
    expect(dto).toMatchObject({ equations: [], figures: [], references: [] });
    expect((await get(id + '/pdf')).body).toEqual(Buffer.from(bytes));
    const row = s.deps.sqlite.prepare("SELECT sha256, bytes FROM files WHERE paperId=? AND kind='pdf'").get(id);
    expect(row).toEqual({ sha256: sha256Hex(Buffer.from(bytes)), bytes: bytes.length });
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
    expect(readdirSync(s.deps.paths.papersDir)).toEqual([id]);
    const patch = await s.req('/api/papers/' + id, { method: 'PATCH', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '직접 고친 제목' }) });
    expect(patch.status).toBe(200);
    s = await s.restart();
    expect(JSON.parse((await get(id)).text).title).toBe('직접 고친 제목');
    expect(JSON.parse((await get(id + '/structure')).text)).toEqual(dto);
    expect((await get(id + '/pdf')).body).toEqual(Buffer.from(bytes));
    s.deps.sqlite.prepare('UPDATE papers SET deletingAt=123 WHERE id=?').run(id);
    expect((await upload(bytes)).status).toBe(409);
  });

  it('preserves a historical HTML-indexed paper when the user uploads an identical PDF', async () => {
    const { db, sqlite, paths } = s.deps;
    await seedFixture(db, sqlite, paths);
    const bytes = readFileSync(join(paths.paperDir(SEED_PAPER_ID), 'paper.pdf'));
    const response = await upload(bytes);
    expect(response.status).toBe(200);
    const uploaded = JSON.parse(response.text);
    expect(uploaded.existing).toBe(false);
    expect(uploaded.paperId).not.toBe(SEED_PAPER_ID);
    expect(JSON.parse((await get(SEED_PAPER_ID + '/structure')).text)).toMatchObject({ structureSource: 'latexml', equations: [{ number: '1' }, { number: '2' }] });
    expect(JSON.parse((await get(uploaded.paperId + '/structure')).text).equations).toEqual([]);
    expect(JSON.parse((await upload(bytes)).text)).toEqual({ paperId: uploaded.paperId, existing: true, jobId: null });
  });

  it('preserves text and its real page numbers in the immutable supplement for a long upload', async () => {
    const doc = await PDFDocument.load(await makeUploadPdf());
    while (doc.getPageCount() < 41) doc.addPage();
    const result = await upload(await doc.save());
    expect(result.status).toBe(200);
    const { paperId } = JSON.parse(result.text);
    expect(JSON.parse((await get(paperId)).text)).toMatchObject({ contextMode: 'text', structureSource: 'pdf-inferred', ai: { available: true } });
    const supp = readFileSync(s.deps.paths.supplementFile(paperId, 2));
    expect(supp.toString()).toContain('source: upload');
    expect(supp.toString()).toContain('<page n="2">');
    expect(supp.toString()).toContain('Check the estimated shift');
    expect(s.deps.sqlite.prepare('SELECT supplementSha256 FROM papers WHERE id=?').get(paperId)).toEqual({ supplementSha256: sha256Hex(supp) });
  });

  it('keeps a long image-only document readable and marks missing extractable text', async () => {
    const doc = await PDFDocument.load(await makeUploadPdf({ title: '', scan: true }));
    while (doc.getPageCount() < 41) doc.addPage();
    const response = await upload(await doc.save(), '내 노트.pdf');
    expect(response.status).toBe(200);
    const { paperId } = JSON.parse(response.text);
    const detail = JSON.parse((await get(paperId)).text);
    expect(detail).toMatchObject({ title: '내 노트', state: { readable: true }, structureSource: 'none', ai: { available: false, reason: 'upload_no_text' } });
    expect((await get(paperId + '/pdf')).status).toBe(200);
  });

  it('rejects wrong file extension, directory components, MIME type, missing magic and unreadable PDF contents', async () => {
    const bytes = await makeUploadPdf();
    for (const invalid of ['.pdf', 'image.txt', '../file.pdf', 'folder\\file.pdf', '/document.pdf', 'bad\u0000name.pdf']) {
      expect((await upload(bytes, invalid)).status, invalid).toBe(400);
    }
    expect((await upload(bytes, 'file.pdf', 'text/plain')).status).toBe(415);
    for (const bad of ['plain text', '%PDF-1.7\nnot a PDF']) expect((await upload(Buffer.from(bad))).status).toBe(400);
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
    expect(readdirSync(s.deps.paths.papersDir)).toEqual([]);
  });

  it('checks both declared size and actual streamed bytes without retaining a partial PDF', async () => {
    const app = createApp(s.deps);
    const target = `http://127.0.0.1:${s.port}/api/papers/upload`;
    const headers = { Host: `127.0.0.1:${s.port}`, 'X-SP-Token': s.token, 'Content-Type': 'application/pdf', 'X-SP-Filename': 'size.pdf' };
    const declared = await app.request(target, { method: 'POST', headers: { ...headers, 'Content-Length': String(LIMITS.uploadBytes + 1) } });
    expect(declared.status).toBe(413);
    const body = new ReadableStream<Uint8Array>({ start(ctrl) {
      ctrl.enqueue(Buffer.from('%PDF-'));
      ctrl.enqueue(new Uint8Array(LIMITS.uploadBytes));
      ctrl.close();
    } });
    const req = new Request(target, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
    const streamed = await app.fetch(req);
    expect(streamed.status).toBe(413);
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
    expect(readdirSync(s.deps.paths.papersDir)).toEqual([]);
  });

  it('refuses a replacement link in the papers directory before storing bytes', async () => {
    const { paths } = s.deps;
    const original = join(paths.root, 'original-papers');
    const other = mkdtempSync(join(paths.root, 'other-'));
    renameSync(paths.papersDir, original);
    symlinkSync(other, paths.papersDir, 'dir');
    try {
      expect((await upload(await makeUploadPdf())).status).toBe(409);
      expect(readdirSync(other)).toEqual([]);
      expect(readdirSync(paths.tmpDir)).toEqual([]);
    } finally {
      unlinkSync(paths.papersDir);
      renameSync(original, paths.papersDir);
    }
  });

  it('removes the published directory and rolls back the paper when a final index insert fails', async () => {
    s.deps.sqlite.exec("CREATE TRIGGER reject_upload BEFORE INSERT ON page_texts BEGIN SELECT RAISE(ABORT, 'index failure'); END");
    expect((await upload(await makeUploadPdf())).status).toBe(500);
    for (const table of ['papers', 'files', 'page_texts', 'sections']) {
      expect(s.deps.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
    expect(readdirSync(s.deps.paths.papersDir)).toEqual([]);
  });
});
