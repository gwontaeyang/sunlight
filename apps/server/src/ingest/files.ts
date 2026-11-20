// Atomic file writes for paper files (PLAN 4.1 "파일 쓰기"). Owner A.
// Every file is written to <dataDir>/tmp/<uuid>.part (same filesystem), checked (size, magic, sha256),
// fsynced and only then moved into papers/<paperId>/. A `files` row is inserted after the move.
// An interrupted write leaves at most a *.part in tmp/ (startup recovery empties tmp/), never a partial file
// under papers/.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FileKind } from '@study-paper/shared/contracts/domain';
import type { Db } from '../db/client';
import { files } from '../db/schema';
import { IngestError } from './errors';

export const PDF_MAGIC = '%PDF-';

export interface WriteAtomicOptions {
  tmpDir: string;
  /** Final path (its directory is created 0700). Replaced if it exists. */
  dest: string;
  chunks: AsyncIterable<Uint8Array>;
  maxBytes: number;
  /** Required leading bytes (latin1), e.g. PDF_MAGIC. */
  magic?: string;
  /** When set, the written bytes must have this sha256 (hex). */
  expectedSha256?: string | null;
  signal?: AbortSignal;
  /** Opens the temp file (tests inject short writes / slow fsync / slow close). Default: fs/promises open(path, 'wx', 0o600). */
  openFile?: (path: string) => Promise<AtomicFileHandle>;
}

/** The part of fs/promises FileHandle that writeAtomic uses. `write` may write fewer bytes than asked (bytesWritten). */
export interface AtomicFileHandle {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

const defaultOpen = (path: string): Promise<AtomicFileHandle> => open(path, 'wx', 0o600);

/** Writes the whole buffer: loops on short writes; a write that makes no progress is an error (M1.1 M7). */
async function writeFully(fh: AtomicFileHandle, buf: Uint8Array): Promise<void> {
  let off = 0;
  while (off < buf.byteLength) {
    const { bytesWritten } = await fh.write(buf, off, buf.byteLength - off);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buf.byteLength - off) {
      throw new IngestError('internal', `file write made no progress (bytesWritten=${String(bytesWritten)} at ${off}/${buf.byteLength})`);
    }
    off += bytesWritten;
  }
}

export interface WrittenFile {
  sha256: string;
  bytes: number;
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not supported on every filesystem; the rename itself is still atomic */
  }
}

export async function writeAtomic(o: WriteAtomicOptions): Promise<WrittenFile> {
  mkdirSync(o.tmpDir, { recursive: true, mode: 0o700 });
  const part = join(o.tmpDir, `${randomUUID()}.part`);
  const fh = await (o.openFile ?? defaultOpen)(part);
  const hash = createHash('sha256');
  let bytes = 0;
  let head = Buffer.alloc(0);
  let closed = false;
  try {
    for await (const chunk of o.chunks) {
      if (o.signal?.aborted) throw new IngestError('cancelled', 'write cancelled');
      bytes += chunk.byteLength;
      if (bytes > o.maxBytes) throw new IngestError('too_large', `file exceeds ${o.maxBytes} bytes`);
      if (o.magic && head.length < o.magic.length) {
        head = Buffer.concat([head, Buffer.from(chunk.subarray(0, o.magic.length - head.length))]);
        if (head.length >= o.magic.length && head.toString('latin1') !== o.magic) throw new IngestError('invalid_pdf', `file does not start with ${JSON.stringify(o.magic)}`);
      }
      await writeFully(fh, chunk);
      hash.update(chunk); // only bytes that reached the file are hashed
    }
    if (o.signal?.aborted) throw new IngestError('cancelled', 'write cancelled');
    if (o.magic && head.toString('latin1') !== o.magic) throw new IngestError('invalid_pdf', `file does not start with ${JSON.stringify(o.magic)}`);
    if (bytes === 0) throw new IngestError('invalid_pdf', 'empty file');
    await fh.sync();
    await fh.close();
    closed = true;
    const onDisk = statSync(part).size;
    if (onDisk !== bytes) throw new IngestError('internal', `temp file has ${onDisk} bytes, ${bytes} were written`);
    const sha256 = hash.digest('hex');
    if (o.expectedSha256 && o.expectedSha256 !== sha256) throw new IngestError('invalid_pdf', `sha256 mismatch (expected ${o.expectedSha256.slice(0, 12)}…, got ${sha256.slice(0, 12)}…)`);
    // Re-check after the (possibly slow) fsync/close (M1.1 M6): a paper deleted meanwhile must not get its directory
    // back. The check, mkdir and rename run in one synchronous stretch, so no deletion can slip in between.
    if (o.signal?.aborted) throw new IngestError('cancelled', 'write cancelled before publishing');
    mkdirSync(dirname(o.dest), { recursive: true, mode: 0o700 });
    renameSync(part, o.dest);
    fsyncDir(dirname(o.dest));
    return { sha256, bytes };
  } catch (e) {
    if (!closed) await fh.close().catch(() => {});
    rmSync(part, { force: true });
    throw e;
  }
}

export type PublishResult = 'published' | 'identical';

/**
 * Publishes `data` at `dest` without ever replacing an existing file (supplement.txt is immutable once
 * published, PLAN 4.1): temp file → fsync → link(2) (fails with EEXIST instead of overwriting) → unlink temp.
 * If `dest` already holds exactly these bytes (a retry after a crash between publish and the DB update) the
 * result is 'identical'; different bytes → IngestError('supplement_exists').
 */
export function publishNoClobber(tmpDir: string, dest: string, data: Buffer): PublishResult {
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const part = join(tmpDir, `${randomUUID()}.part`);
  const fd = openSync(part, 'wx', 0o600);
  try {
    let off = 0;
    while (off < data.length) {
      const n = writeSync(fd, data, off, data.length - off);
      if (n <= 0) throw new IngestError('internal', `file write made no progress at ${off}/${data.length}`);
      off += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(part, dest);
    fsyncDir(dirname(dest));
    return 'published';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const existing = readFileSync(dest);
    if (existing.equals(data)) return 'identical';
    throw new IngestError('supplement_exists', `${dest} is already published with different content; it is never overwritten`);
  } finally {
    rmSync(part, { force: true });
  }
}

export const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Replaces the paper's `files` row of this kind (pdf / supplement: one per paper). Call inside a transaction. */
export function recordFile(db: Db, row: { paperId: string; kind: FileKind; relPath: string; sha256: string; bytes: number; mime: string }, now: number): string {
  db.delete(files).where(and(eq(files.paperId, row.paperId), eq(files.kind, row.kind))).run();
  const id = randomUUID();
  db.insert(files).values({ id, ...row, createdAt: now }).run();
  return id;
}

