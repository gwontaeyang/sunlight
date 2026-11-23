// A paper becomes visible only after its original PDF, immutable supplement, page index and outline are ready.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { LIMITS, type ApiResponse } from '@study-paper/shared/contracts/api';
import { serializeSupplementV2 } from '@study-paper/shared/contracts/supplement';
import { papers, sections } from '../db/schema';
import { HttpError, type AppDeps } from '../deps';
import { IngestError } from './errors';
import { fsyncDir, PDF_MAGIC, publishNoClobber, recordFile, sha256Hex, writeAtomic } from './files';
import { extractUploadedPdf, PDFJS_VERSION, TEXT_TIMEOUT_MS } from './pdfText';
import { PDF_FILE } from './pipeline';
import { SUPPLEMENT_V2_VERSION } from './structureStore';
import { contextModeFor } from './supplement';
import { buildUploadTextContext } from './uploadTextContext';

function pdfFilename(header: string | null): string {
  let name: string;
  try { name = decodeURIComponent(header ?? ''); } catch { name = ''; }
  // Display metadata only: never use this name to address a file, even after validation.
  if (!name.toLowerCase().endsWith('.pdf') || !name.slice(0, -4).trim() || /[/\\\u0000-\u001F\u007F]/u.test(name) || Buffer.byteLength(name) > 255) {
    throw new HttpError(400, 'validation', 'Choose a PDF file with a plain .pdf filename.');
  }
  return name;
}

async function* bodyChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let done = false;
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      yield chunk.value;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!done) cancel();
    reader.releaseLock();
  }
}

function existingUpload(deps: AppDeps, sha256: string): ApiResponse<'papers.upload'> | null {
  // Old synthetic seed rows can have source=upload and a LaTeXML source; preserve them as their own entries.
  const row = deps.db.select({ id: papers.id, deletingAt: papers.deletingAt }).from(papers)
    .where(and(eq(papers.source, 'upload'), eq(papers.pdfSha256, sha256), inArray(papers.structureSource, ['pdf-outline', 'pdf-inferred', 'none']))).get();
  if (row?.deletingAt != null) throw new HttpError(409, 'conflict', 'The previous upload is being deleted. Try again shortly.');
  return row ? { paperId: row.id, jobId: null, existing: true } : null;
}

function requireDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new HttpError(409, 'conflict', 'The upload storage directory is unavailable.');
}

async function ingestUpload(deps: AppDeps, request: Request): Promise<ApiResponse<'papers.upload'>> {
  const mime = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mime !== 'application/pdf') throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/pdf');
  const filename = pdfFilename(request.headers.get('x-sp-filename'));
  if (!request.body) throw new HttpError(400, 'validation', 'A PDF file is required.');
  const signal = AbortSignal.any([deps.shutdown, request.signal, AbortSignal.timeout(TEXT_TIMEOUT_MS)]);
  requireDirectory(deps.paths.root);
  requireDirectory(deps.paths.tmpDir);
  requireDirectory(deps.paths.papersDir);
  const stage = mkdtempSync(join(deps.paths.tmpDir, 'upload-'));
  const id = randomUUID();
  const dest = deps.paths.paperDir(id);
  let published = false;
  try {
    const pdfFile = join(stage, PDF_FILE);
    const pdf = await writeAtomic({ tmpDir: stage, dest: pdfFile, chunks: bodyChunks(request.body, signal), maxBytes: LIMITS.uploadBytes, magic: PDF_MAGIC, signal });
    const existing = existingUpload(deps, pdf.sha256);
    if (existing) return existing;
    const bytes = await readFile(pdfFile);
    const parsed = await extractUploadedPdf(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), filename, { signal });
    const contextMode = contextModeFor(parsed.pageCount, pdf.bytes);
    const outline = serializeSupplementV2({
      meta: { title: parsed.title, authors: [], arxivId: null, arxivVersion: null, year: null, primaryCategory: null },
      sections: parsed.sections.map(({ number, title }) => ({ htmlId: null, number, title })),
      equations: [], figures: [], references: [],
    });
    const supplement = Buffer.from(outline.text + (contextMode === 'text' ? buildUploadTextContext(parsed.pages) : ''));
    const supplementFile = basename(deps.paths.supplementFile(id, SUPPLEMENT_V2_VERSION));
    const warnings: string[] = [];
    if (outline.truncated) warnings.push('supplement_truncated');
    if (!parsed.pages.some((p) => p.text.trim())) warnings.push('upload_no_text');
    // Serialize the bounded text index per page, outside the atomic transaction. Allow
    // concurrent reads, socket closes and server shutdown to run between large pages.
    const index: { page: number; text: string; itemsJson: string }[] = [];
    for (const { page, text, items } of parsed.pages) {
      if (signal.aborted) throw new IngestError('cancelled', 'upload cancelled');
      index.push({ page, text, itemsJson: JSON.stringify(items) });
      await yieldToLoop();
    }
    publishNoClobber(stage, join(stage, supplementFile), supplement);
    if (signal.aborted) throw new IngestError('cancelled', 'upload cancelled');

    // The data-directory lock admits one server. Keep the second hash check, rename and SQLite commit
    // synchronous: other requests cannot observe or publish a partially indexed paper.
    const concurrent = existingUpload(deps, pdf.sha256);
    if (concurrent) return concurrent;
    requireDirectory(deps.paths.papersDir);
    if (lstatSync(dest, { throwIfNoEntry: false })) throw new HttpError(409, 'conflict', 'Could not allocate a paper directory.');
    renameSync(stage, dest);
    published = true;
    fsyncDir(deps.paths.papersDir);
    const now = Date.now();
    const supplementSha256 = sha256Hex(supplement);
    deps.sqlite.transaction(() => {
      deps.db.insert(papers).values({
        id, source: 'upload', title: parsed.title, ingestStatus: 'done', ingestWarningsJson: JSON.stringify(warnings),
        readableAt: now, contextReadyAt: now, structureReadyAt: now,
        structureSource: parsed.outlineKind === 'bookmarks' ? 'pdf-outline' : parsed.outlineKind === 'estimated' ? 'pdf-inferred' : 'none',
        contextMode, pageCount: parsed.pageCount, pdfSha256: pdf.sha256, supplementSha256, supplementVersion: SUPPLEMENT_V2_VERSION,
        createdAt: now, updatedAt: now,
      }).run();
      recordFile(deps.db, { paperId: id, kind: 'pdf', relPath: `papers/${id}/${PDF_FILE}`, ...pdf, mime: 'application/pdf' }, now);
      recordFile(deps.db, { paperId: id, kind: 'supplement', relPath: `papers/${id}/${supplementFile}`, sha256: supplementSha256, bytes: supplement.length, mime: 'text/plain' }, now);
      const insertPage = deps.sqlite.prepare('INSERT INTO page_texts (paperId,page,text,itemsJson,pdfjsVersion) VALUES (?,?,?,?,?)');
      for (const { page, text, itemsJson } of index) insertPage.run(id, page, text, itemsJson, PDFJS_VERSION);
      const sectionIds = parsed.sections.map(() => randomUUID());
      parsed.sections.forEach((s, i) => {
        deps.db.insert(sections).values({
          id: sectionIds[i]!, paperId: id, parentId: s.parentIndex === null ? null : sectionIds[s.parentIndex]!, number: s.number, title: s.title,
          level: s.level, ordinal: i + 1, pdfPage: s.pdfPage, pdfOffset: s.pdfOffset, pdfRectJson: JSON.stringify(s.pdfRect),
        }).run();
      });
    })();
    return { paperId: id, jobId: null, existing: false };
  } catch (e) {
    // A hard crash here leaves an orphan directory; startupRecovery handles both tmp/ and orphan paper IDs.
    if (published) rmSync(dest, { recursive: true, force: true });
    if (e instanceof IngestError) {
      if (e.code === 'too_large') throw new HttpError(413, 'payload_too_large', 'PDF exceeds the upload or extraction limits.');
      if (e.code === 'invalid_pdf') throw new HttpError(400, 'validation', 'The PDF could not be opened. Check the file and remove any password.');
      if (e.code === 'cancelled' || e.code === 'timeout') throw new HttpError(409, 'conflict', 'PDF processing was interrupted.');
    }
    throw e;
  } finally {
    if (!published) rmSync(stage, { recursive: true, force: true });
  }
}

export function createPdfUploader(deps: AppDeps) {
  const running = new Set<Promise<ApiResponse<'papers.upload'>>>();
  deps.lifecycle.register({ name: 'pdf-upload', active: () => running.size, drain: async () => { await Promise.allSettled([...running]); } });
  return async (request: Request) => {
    if (deps.shutdown.aborted || running.size >= 2) throw new HttpError(409, 'conflict', 'PDF processing is busy. Try again shortly.');
    const task = ingestUpload(deps, request);
    running.add(task);
    try { return await task; } finally { running.delete(task); }
  };
}
