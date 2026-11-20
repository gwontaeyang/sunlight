// storeCapture (PLAN_M2 3.5; BRIEF_S S5). Owner: supervisor.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@study-paper/shared/contracts/api';
import { inspectPngBytes } from '@study-paper/shared/image/png';
import { storeCapture, type CaptureWriteFn } from '../../src/captures';
import { files, papers } from '../../src/db/schema';
import { HttpError } from '../../src/deps';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { dataPaths } from '../../src/paths';
import { makeTestPng, makeTestPngBase64 } from '../helpers/png';
import { FILE_SIZE_LIMIT_PROBE_SUPPORTED, runProbeWithFileSizeLimit } from '../helpers/proc';
import { startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function server() {
  const s = await startTestServer({ env: 'prod', seed: true });
  servers.push(s);
  return s;
}
const capFiles = (s: TestServer) => (existsSync(s.deps.paths.capturesDir(SEED_PAPER_ID)) ? readdirSync(s.deps.paths.capturesDir(SEED_PAPER_ID)) : []);
const capRows = (s: TestServer) => s.deps.db.select().from(files).where(eq(files.kind, 'capture')).all();
const PNG = makeTestPngBase64({ width: 20, height: 10 });

describe('storeCapture', () => {
  it('stores the file and, in the caller transaction, the files row (id = fileId)', async () => {
    const s = await server();
    const c = storeCapture(s.deps, SEED_PAPER_ID, PNG);
    expect(c).toMatchObject({ width: 20, height: 10, bytes: Buffer.from(PNG, 'base64').length });
    const file = s.deps.paths.captureFile(SEED_PAPER_ID, c.fileId);
    expect(readFileSync(file).equals(Buffer.from(PNG, 'base64'))).toBe(true);
    s.deps.db.transaction((tx) => c.insertRow(tx));
    expect(capRows(s)).toEqual([expect.objectContaining({ id: c.fileId, paperId: SEED_PAPER_ID, kind: 'capture', sha256: c.sha256, bytes: c.bytes, mime: 'image/png', relPath: `papers/${SEED_PAPER_ID}/captures/${c.fileId}.png` })]);
    c.discard(); // a committed row keeps its file
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
  });

  it('a PNG that fails inspectPng → HttpError 400 validation, nothing written', async () => {
    const s = await server();
    const broken = makeTestPng({ width: 20, height: 10 });
    broken[broken.length - 1]! ^= 1;
    let err: unknown;
    try {
      storeCapture(s.deps, SEED_PAPER_ID, broken.toString('base64'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, code: 'validation' });
    expect(capFiles(s)).toEqual([]);
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
  });

  it('a failing transaction → discard() leaves no file; calling discard() twice is harmless', async () => {
    const s = await server();
    const c = storeCapture(s.deps, SEED_PAPER_ID, PNG);
    expect(() =>
      s.deps.db.transaction((tx) => {
        c.insertRow(tx);
        throw new Error('later step failed');
      }),
    ).toThrow('later step failed');
    expect(capRows(s)).toEqual([]);
    c.discard();
    c.discard();
    expect(capFiles(s)).toEqual([]);
  });

  it('after the tombstone (deletingAt): 404 and no file, no directory', async () => {
    const s = await server();
    s.deps.db.update(papers).set({ deletingAt: Date.now() }).where(eq(papers.id, SEED_PAPER_ID)).run();
    expect(() => storeCapture(s.deps, SEED_PAPER_ID, PNG)).toThrow(expect.objectContaining({ status: 404 }));
    expect(existsSync(s.deps.paths.capturesDir(SEED_PAPER_ID))).toBe(false);
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
  });

  it('when the paper directory is already gone it is not re-created', async () => {
    const s = await server();
    rmSync(s.deps.paths.paperDir(SEED_PAPER_ID), { recursive: true, force: true });
    expect(() => storeCapture(s.deps, SEED_PAPER_ID, PNG)).toThrow(expect.objectContaining({ status: 404 }));
    expect(existsSync(s.deps.paths.paperDir(SEED_PAPER_ID))).toBe(false);
  });

  it('insertRow re-checks the paper inside the transaction (deleted after the file was written → 404)', async () => {
    const s = await server();
    const c = storeCapture(s.deps, SEED_PAPER_ID, PNG);
    s.deps.db.update(papers).set({ deletingAt: Date.now() }).where(eq(papers.id, SEED_PAPER_ID)).run();
    expect(() => s.deps.db.transaction((tx) => c.insertRow(tx))).toThrow(expect.objectContaining({ status: 404 }));
    c.discard();
    expect(capFiles(s)).toEqual([]);
  });

  it(`count limit: the ${LIMITS.capturesPerPaper}th capture passes, the ${LIMITS.capturesPerPaper + 1}th → 409; byte limit: exactly at the limit passes, +1 B → 409`, async () => {
    const s = await server();
    const bytesOf = Buffer.from(PNG, 'base64').length;
    const ins = s.deps.sqlite.prepare(`INSERT INTO files (id, paperId, kind, relPath, sha256, bytes, mime, createdAt) VALUES (?, ?, 'capture', ?, 'x', ?, 'image/png', 1)`);
    const commit = (c: ReturnType<typeof storeCapture>) => s.deps.db.transaction((tx) => c.insertRow(tx));
    const reset = () => {
      for (const f of capFiles(s)) rmSync(join(s.deps.paths.capturesDir(SEED_PAPER_ID), f));
      s.deps.sqlite.prepare(`DELETE FROM files WHERE kind = 'capture'`).run();
    };
    // count: 499 rows → the 500th passes → the 501st is refused
    for (let i = 0; i < LIMITS.capturesPerPaper - 1; i++) ins.run(`f${i}`, SEED_PAPER_ID, `papers/${SEED_PAPER_ID}/captures/f${i}.png`, 10);
    const last = storeCapture(s.deps, SEED_PAPER_ID, PNG);
    expect(() => commit(last)).not.toThrow();
    expect(s.deps.sqlite.prepare(`SELECT count(*) AS n FROM files WHERE kind = 'capture'`).get()).toEqual({ n: LIMITS.capturesPerPaper });
    const over = storeCapture(s.deps, SEED_PAPER_ID, PNG);
    expect(() => commit(over)).toThrow(expect.objectContaining({ status: 409, code: 'conflict' }));
    over.discard();
    expect(capFiles(s)).toEqual([`${last.fileId}.png`]);
    reset();
    // bytes: existing + this PNG = exactly the limit → passes
    ins.run('big', SEED_PAPER_ID, 'x', LIMITS.captureBytesPerPaper - bytesOf);
    const exact = storeCapture(s.deps, SEED_PAPER_ID, PNG);
    expect(() => commit(exact)).not.toThrow();
    reset();
    // existing + this PNG = the limit + 1 B → 409
    ins.run('big', SEED_PAPER_ID, 'x', LIMITS.captureBytesPerPaper - bytesOf + 1);
    const plusOne = storeCapture(s.deps, SEED_PAPER_ID, PNG);
    expect(() => commit(plusOne)).toThrow(expect.objectContaining({ status: 409, code: 'conflict' }));
    plusOne.discard();
    expect(capFiles(s)).toEqual([]);
  });
});

// Codex M-S-1 (coordinator note 4(a)): a short write must never be published as the capture.
describe('storeCapture writes every byte or nothing', () => {
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const BIG = makeTestPng({ width: 16, height: 16, padToBytes: 4096 });
  /** A write function that stores at most 1–100 bytes per call (deterministic sequence), then `after(call)` decides. */
  function shortWriter(after?: (call: number) => number | Error | undefined): { fn: CaptureWriteFn; calls: () => number } {
    let calls = 0;
    let seed = 7;
    const fn: CaptureWriteFn = (fd, buffer, offset, length) => {
      calls++;
      const forced = after?.(calls);
      if (forced instanceof Error) throw forced;
      if (forced !== undefined) return forced;
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return writeSync(fd, buffer, offset, Math.min(length, 1 + (seed % 100)));
    };
    return { fn, calls: () => calls };
  }
  const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

  it('short writes of 1–100 bytes are repeated until the whole PNG is on disk; file, return value and row agree', async () => {
    const s = await server();
    const w = shortWriter();
    const c = storeCapture(s.deps, SEED_PAPER_ID, BIG.toString('base64'), { writeFn: w.fn });
    expect(w.calls()).toBeGreaterThan(BIG.length / 100);
    const file = readFileSync(s.deps.paths.captureFile(SEED_PAPER_ID, c.fileId));
    expect(file.equals(BIG)).toBe(true);
    expect(inspectPngBytes(file)).toMatchObject({ ok: true, width: 16, height: 16 });
    expect({ bytes: c.bytes, sha256: c.sha256 }).toEqual({ bytes: file.length, sha256: sha(file) });
    s.deps.db.transaction((tx) => c.insertRow(tx));
    expect(capRows(s).map((r) => ({ id: r.id, bytes: r.bytes, sha256: r.sha256 }))).toEqual([{ id: c.fileId, bytes: file.length, sha256: sha(file) }]);
    expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
  });

  for (const [name, after] of [
    ['a 0 return in the middle', (call: number) => (call === 5 ? 0 : undefined)],
    ['EIO in the middle', (call: number) => (call === 5 ? errno('EIO') : undefined)],
    ['EFBIG in the middle', (call: number) => (call === 5 ? errno('EFBIG') : undefined)],
  ] as const) {
    it(`${name} → throws; no .capture.part, no capture file, no row`, async () => {
      const s = await server();
      const w = shortWriter(after);
      expect(() => storeCapture(s.deps, SEED_PAPER_ID, BIG.toString('base64'), { writeFn: w.fn })).toThrow();
      expect(w.calls()).toBe(5);
      expect(readdirSync(s.deps.paths.tmpDir)).toEqual([]);
      expect(capFiles(s)).toEqual([]);
      expect(capRows(s)).toEqual([]);
    });
  }

  // Linux only (bash `ulimit -f`); elsewhere the case is skipped with this reason.
  const itLinux = FILE_SIZE_LIMIT_PROBE_SUPPORTED ? it : it.skip;
  itLinux('a real file size limit (child process, ulimit -f 1 = 1,024 B) on a 4,096 B PNG → fails; no file, no row (Linux only; skipped elsewhere: needs bash ulimit)', async () => {
    const root = tempDir('sp-capture-limit-');
    const paperId = '00000000-0000-4000-8000-000000000111';
    const paths = dataPaths(root);
    mkdirSync(paths.paperDir(paperId), { recursive: true, mode: 0o700 });
    const r = await runProbeWithFileSizeLimit(join(__dirname, '..', 'fixtures', 'capture-probe.ts'), 1, {}, [JSON.stringify({ root, paperId, bytes: 4096 })], 120_000);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as { limitCheck: number | string; stored: boolean; error: { code: string | null } | null; rows: number };
    expect(out.limitCheck, 'the limit is in force: one 4,096 B write is cut short').toBe(1024);
    expect(out.stored).toBe(false);
    expect(out.error?.code).toBe('EFBIG');
    expect(out.rows).toBe(0);
    expect(readdirSync(paths.tmpDir)).toEqual([]);
    expect(existsSync(paths.capturesDir(paperId)) ? readdirSync(paths.capturesDir(paperId)) : []).toEqual([]);
  });
});
