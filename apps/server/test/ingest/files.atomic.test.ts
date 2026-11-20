import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IngestError } from '../../src/ingest/errors';
import { open } from 'node:fs/promises';
import { PDF_MAGIC, publishNoClobber, sha256Hex, writeAtomic, type AtomicFileHandle } from '../../src/ingest/files';
import { tempDir } from '../helpers/tmp';
import { SYNTHETIC_PDF } from './helpers';

function layout() {
  const root = tempDir('sp-files-');
  const tmpDir = join(root, 'tmp');
  const paperDir = join(root, 'papers', 'p1');
  mkdirSync(tmpDir, { recursive: true });
  return { root, tmpDir, paperDir, dest: join(paperDir, 'paper.pdf') };
}

async function* chunked(data: Buffer, size = 1000, failAfter?: number) {
  let n = 0;
  for (let i = 0; i < data.length; i += size) {
    if (failAfter !== undefined && n++ >= failAfter) throw new Error('connection reset');
    yield new Uint8Array(data.subarray(i, i + size));
  }
}

const codeOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof IngestError ? e.code : (e as Error).message));

describe('writeAtomic', () => {
  it('writes, fsyncs and renames into place with the sha256', async () => {
    const l = layout();
    const r = await writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(SYNTHETIC_PDF), maxBytes: 50 * 1024 * 1024, magic: PDF_MAGIC });
    expect(r).toEqual({ sha256: sha256Hex(SYNTHETIC_PDF), bytes: SYNTHETIC_PDF.length });
    expect(readFileSync(l.dest).equals(SYNTHETIC_PDF)).toBe(true);
    expect(statSync(l.dest).mode & 0o777).toBe(0o600);
    expect(readdirSync(l.tmpDir)).toEqual([]);
  });

  it('an interrupted download leaves no partial file under papers/ and no .part in tmp/', async () => {
    const l = layout();
    expect(await codeOf(writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(SYNTHETIC_PDF, 500, 3), maxBytes: 1e9, magic: PDF_MAGIC }))).toBe('connection reset');
    expect(existsSync(l.dest)).toBe(false);
    expect(existsSync(l.paperDir) ? readdirSync(l.paperDir) : []).toEqual([]);
    expect(readdirSync(l.tmpDir)).toEqual([]);
  });

  it('rejects bytes that are not a PDF (magic)', async () => {
    const l = layout();
    const html = Buffer.from('<!doctype html><title>Just a moment...</title>');
    expect(await codeOf(writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(html, 3), maxBytes: 1e9, magic: PDF_MAGIC }))).toBe('invalid_pdf');
    expect(existsSync(l.dest)).toBe(false);
    expect(readdirSync(l.tmpDir)).toEqual([]);
  });

  it('rejects an empty or too short body', async () => {
    const l = layout();
    expect(await codeOf(writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(Buffer.alloc(0)), maxBytes: 1e9, magic: PDF_MAGIC }))).toBe('invalid_pdf');
    expect(await codeOf(writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(Buffer.from('%PD')), maxBytes: 1e9, magic: PDF_MAGIC }))).toBe('invalid_pdf');
  });

  it('rejects a sha256 mismatch and keeps the existing file', async () => {
    const l = layout();
    mkdirSync(l.paperDir, { recursive: true });
    writeFileSync(l.dest, 'previous');
    const other = Buffer.concat([SYNTHETIC_PDF, Buffer.from('\n% changed')]);
    expect(await codeOf(writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(other), maxBytes: 1e9, magic: PDF_MAGIC, expectedSha256: sha256Hex(SYNTHETIC_PDF) }))).toBe('invalid_pdf');
    expect(readFileSync(l.dest, 'utf8')).toBe('previous');
    expect(readdirSync(l.tmpDir)).toEqual([]);
  });

  it('stops at the byte limit', async () => {
    const l = layout();
    expect(await codeOf(writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(SYNTHETIC_PDF), maxBytes: 1500, magic: PDF_MAGIC }))).toBe('too_large');
    expect(existsSync(l.dest)).toBe(false);
  });

  it('an aborted signal cancels the write', async () => {
    const l = layout();
    const ctrl = new AbortController();
    async function* slow() {
      yield new Uint8Array(SYNTHETIC_PDF.subarray(0, 100));
      ctrl.abort();
      yield new Uint8Array(SYNTHETIC_PDF.subarray(100));
    }
    expect(await codeOf(writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: slow(), maxBytes: 1e9, magic: PDF_MAGIC, signal: ctrl.signal }))).toBe('cancelled');
    expect(existsSync(l.dest)).toBe(false);
    expect(readdirSync(l.tmpDir)).toEqual([]);
  });
});

/** Wraps a real file handle: at most `maxPerWrite` bytes per write (or a scripted bytesWritten), optional gates on sync/close. */
function fakeHandle(o: { maxPerWrite?: number; script?: number[]; syncGate?: Promise<void>; closeGate?: Promise<void>; onSync?: () => void; calls?: number[] }) {
  return async (path: string): Promise<AtomicFileHandle> => {
    const fh = await open(path, 'wx', 0o600);
    let k = 0;
    return {
      async write(buf, off, len) {
        const scripted = o.script?.[k++];
        const want = scripted !== undefined ? scripted : Math.min(len, o.maxPerWrite ?? len);
        o.calls?.push(want);
        if (want <= 0) return { bytesWritten: want };
        const { bytesWritten } = await fh.write(buf, off, Math.min(want, len));
        return { bytesWritten };
      },
      async sync() {
        o.onSync?.();
        await o.syncGate;
        await fh.sync();
      },
      async close() {
        await o.closeGate;
        await fh.close();
      },
    };
  };
}

describe('writeAtomic: short writes (M1.1 M7)', () => {
  it('loops until each chunk is fully written; sha256/size match the bytes on disk', async () => {
    const l = layout();
    const calls: number[] = [];
    const r = await writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(SYNTHETIC_PDF), maxBytes: 1e9, magic: PDF_MAGIC, openFile: fakeHandle({ maxPerWrite: 7, calls }) });
    const disk = readFileSync(l.dest);
    expect(disk.equals(SYNTHETIC_PDF)).toBe(true);
    expect(r).toEqual({ sha256: sha256Hex(disk), bytes: disk.length });
    expect(calls.length).toBeGreaterThan(Math.ceil(SYNTHETIC_PDF.length / 1000)); // many short writes per chunk
    expect(readdirSync(l.tmpDir)).toEqual([]);
  });

  it('a write that makes no progress (0 bytes) is an error; nothing is published', async () => {
    const l = layout();
    expect(await codeOf(writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(SYNTHETIC_PDF), maxBytes: 1e9, magic: PDF_MAGIC, openFile: fakeHandle({ script: [1000, 300, 0] }) }))).toBe('internal');
    expect(existsSync(l.dest)).toBe(false);
    expect(readdirSync(l.tmpDir)).toEqual([]);
  });

  it('a bytesWritten larger than asked is an error too', async () => {
    const l = layout();
    const bogus = async (path: string): Promise<AtomicFileHandle> => {
      const fh = await open(path, 'wx', 0o600);
      return { write: async (_b, _o, len) => ({ bytesWritten: len + 1 }), sync: () => fh.sync(), close: () => fh.close() };
    };
    expect(await codeOf(writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(SYNTHETIC_PDF), maxBytes: 1e9, magic: PDF_MAGIC, openFile: bogus }))).toBe('internal');
    expect(existsSync(l.dest)).toBe(false);
  });
});

describe('writeAtomic: abort during a slow fsync/close (M1.1 M6)', () => {
  for (const where of ['sync', 'close'] as const) {
    it(`an abort while ${where} is slow → nothing is published, no directory is created`, async () => {
      const l = layout();
      const ctrl = new AbortController();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inGate = new Promise<void>((r) => (entered = r));
      const openFile = fakeHandle(where === 'sync' ? { syncGate: gate, onSync: entered } : { closeGate: gate, onSync: entered });
      const p = codeOf(writeAtomic({ tmpDir: l.tmpDir, dest: l.dest, chunks: chunked(SYNTHETIC_PDF), maxBytes: 1e9, magic: PDF_MAGIC, signal: ctrl.signal, openFile }));
      await inGate; // the last abort check before fsync has passed
      ctrl.abort('deleted');
      release();
      expect(await p).toBe('cancelled');
      expect(existsSync(l.paperDir)).toBe(false);
      expect(readdirSync(l.tmpDir)).toEqual([]);
    });
  }
});

describe('publishNoClobber', () => {
  it('publishes once, accepts identical bytes, refuses different bytes without touching the file', () => {
    const l = layout();
    const dest = join(l.paperDir, 'supplement.txt');
    expect(publishNoClobber(l.tmpDir, dest, Buffer.from('v1'))).toBe('published');
    expect(publishNoClobber(l.tmpDir, dest, Buffer.from('v1'))).toBe('identical');
    expect(() => publishNoClobber(l.tmpDir, dest, Buffer.from('v2'))).toThrow(expect.objectContaining({ code: 'supplement_exists' }));
    expect(readFileSync(dest, 'utf8')).toBe('v1');
    expect(readdirSync(l.tmpDir)).toEqual([]);
  });
});
