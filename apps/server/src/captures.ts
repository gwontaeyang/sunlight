// Capture PNG storage (PLAN_M2 3.5). Owner: supervisor — frozen; B (threads) and A (highlights) call it.
//
// Call-order contract (Codex M9):
//   1. The route checks the request id first (runs.findExisting) — a repeated or conflicting request ends there and
//      never writes a capture.
//   2. inspectPng / kind checks.
//   3. ONLY for a new run / new highlight: storeCapture(deps, paperId, base64) — checks the PNG again, writes the file
//      (temp → rename into papers/<id>/captures/<fileId>.png).
//   4. The caller's transaction calls insertRow(tx): re-checks the paper (exists, not tombstoned) and the per-paper
//      limits (LIMITS.capturesPerPaper files, LIMITS.captureBytesPerPaper bytes → 409) and inserts the files row
//      (kind 'capture', id = fileId).
//   5. On EVERY path where insertRow did not commit (a throw before it, insertRow throwing, the transaction rolling
//      back, runTask returning attached: true) the caller calls discard(). discard() is idempotent and never removes
//      a file whose row is committed.
// Deletion race (the request is not one papers.delete waits for): right before the rename it re-checks
// papers.deletingAt IS NULL and that the paper directory exists (else 404), never creates the paper directory, creates
// only captures/ (non-recursive), and the check → mkdir → rename stretch is synchronous (no await).
// Orphans left by a crash (a PNG without a row, a capture row nothing references) are removed by startup recovery.
// Writing (Codex M-S-1): a write may store fewer bytes than asked (short write); the loop advances by the returned count
// until every byte is written, a 0 return is a failure, and the file size is checked before fsync. A failure at write,
// fsync, close or rename removes the .capture.part file and throws: no final file, so the caller never inserts a row.
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, fstatSync, fsyncSync, mkdirSync, openSync, closeSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LIMITS } from '@study-paper/shared/contracts/api';
import { inspectPng } from '@study-paper/shared/image/png';
import type { Sqlite } from './db/client';
import { and, eq, sql } from 'drizzle-orm';
import { files, papers } from './db/schema';
import { HttpError, notFound } from './deps';
import type { RunTx } from './llm/runContract';
import type { DataPaths } from './paths';

export interface StoredCapture {
  fileId: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  /** Inside the caller's transaction: limits + paper re-check + files row. Throws HttpError 404 / 409. */
  insertRow(tx: RunTx): void;
  /** Removes the file unless its row is committed. Idempotent. */
  discard(): void;
}

export interface CaptureDeps {
  paths: DataPaths;
  sqlite: Sqlite;
}

/** fs.writeSync's (fd, buffer, offset, length) form: returns the number of bytes written. */
export type CaptureWriteFn = (fd: number, buffer: Buffer, offset: number, length: number) => number;

export interface StoreCaptureOptions {
  /** Tests only: replaces fs.writeSync (e.g. to make short writes or failures). */
  writeFn?: CaptureWriteFn;
}

const CAPTURE_MIME = 'image/png';

/** Writes all of `data` to `fd`, advancing by each returned count; 0 (no progress) or an impossible count throws. */
function writeAll(fd: number, data: Buffer, write: CaptureWriteFn): void {
  let off = 0;
  while (off < data.length) {
    const n = write(fd, data, off, data.length - off);
    if (!Number.isInteger(n) || n <= 0 || n > data.length - off) throw new Error(`capture write made no progress at ${off}/${data.length} bytes (returned ${String(n)})`);
    off += n;
  }
  const size = fstatSync(fd).size;
  if (size !== data.length) throw new Error(`capture file has ${size} bytes, expected ${data.length}`);
}

/** Validates and writes a capture PNG (see the header for the call order). Synchronous. */
export function storeCapture(deps: CaptureDeps, paperId: string, base64: string, opts: StoreCaptureOptions = {}): StoredCapture {
  const check = inspectPng(base64);
  if (!check.ok) throw new HttpError(400, 'validation', `invalid capture PNG (${check.reason})`);
  const data = Buffer.from(base64, 'base64');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const fileId = randomUUID();
  const dest = deps.paths.captureFile(paperId, fileId);
  const paperDir = deps.paths.paperDir(paperId);

  // Temp file outside the paper directory, fully written, fsynced and closed — or removed.
  mkdirSync(deps.paths.tmpDir, { recursive: true, mode: 0o700 });
  const part = join(deps.paths.tmpDir, `${fileId}.capture.part`);
  let fd: number | null = openSync(part, 'wx', 0o600); // 'wx': a failure here created nothing of ours to remove
  try {
    writeAll(fd, data, opts.writeFn ?? writeSync);
    fsyncSync(fd);
    const open = fd;
    fd = null;
    closeSync(open);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // the write/fsync error is the one to report
      }
    }
    rmSync(part, { force: true });
    throw e;
  }

  // Synchronous stretch: re-check → mkdir captures/ → rename. No await, so no deletion can slip in between.
  try {
    const paper = deps.sqlite.prepare(`SELECT deletingAt FROM papers WHERE id = ?`).get(paperId) as { deletingAt: number | null } | undefined;
    if (!paper || paper.deletingAt !== null || !existsSync(paperDir)) throw notFound('paper');
    try {
      mkdirSync(deps.paths.capturesDir(paperId), { mode: 0o700 }); // non-recursive: never re-creates the paper dir
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    renameSync(part, dest);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }

  const relPath = relative(deps.paths.root, dest);
  return {
    fileId,
    sha256,
    bytes: data.length,
    width: check.width,
    height: check.height,
    insertRow(tx) {
      const paper = tx.select({ deletingAt: papers.deletingAt }).from(papers).where(eq(papers.id, paperId)).get();
      if (!paper || paper.deletingAt !== null) throw notFound('paper');
      const used = tx
        .select({ n: sql<number>`count(*)`, b: sql<number>`coalesce(sum(${files.bytes}), 0)` })
        .from(files)
        .where(and(eq(files.paperId, paperId), eq(files.kind, 'capture')))
        .get() ?? { n: 0, b: 0 };
      if (used.n + 1 > LIMITS.capturesPerPaper) throw new HttpError(409, 'conflict', `this paper already has ${LIMITS.capturesPerPaper} captures`);
      if (used.b + data.length > LIMITS.captureBytesPerPaper) throw new HttpError(409, 'conflict', `captures of this paper would exceed ${LIMITS.captureBytesPerPaper} bytes`);
      tx.insert(files).values({ id: fileId, paperId, kind: 'capture', relPath, sha256, bytes: data.length, mime: CAPTURE_MIME, createdAt: Date.now() }).run();
    },
    discard() {
      const committed = deps.sqlite.prepare(`SELECT 1 FROM files WHERE id = ?`).get(fileId);
      if (committed) return;
      rmSync(dest, { force: true });
    },
  };
}
