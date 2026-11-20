// Paper context = the cached prefix of every paper task (PLAN 2.4 "메시지 구성"). Owner B.
//   [ {type:'document', source:{type:'base64', media_type:'application/pdf', data}},
//     {type:'text', text:<supplement.txt>, cache_control:{type:'ephemeral', ttl:'1h'}} ]
// Built with a fixed key order so the JSON bytes are identical for every task on the same paper. The run reads
// paper.pdf and supplement.txt at start and compares their sha256 with the `papers` row (A writes both once,
// then never overwrites them); any mismatch or missing piece → context_not_ready. contextMode 'text' arrives in
// M3 — until then such a paper ends with too_large.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { papers } from '../db/schema';
import type { DataPaths } from '../paths';
import type { ContentBlock } from './adapter';

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export class ContextError extends Error {
  constructor(
    readonly code: 'context_not_ready' | 'too_large',
    message: string,
  ) {
    super(message);
  }
}

/** The two prefix blocks, fixed key order. */
export function buildPaperPrefix(pdf: Buffer, supplement: string): ContentBlock[] {
  return [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
    { type: 'text', text: supplement, cache_control: { type: 'ephemeral', ttl: '1h' } },
  ];
}

export interface FingerprintParts {
  systemSha256: string;
  pdfSha256: string | null;
  supplementSha256: string | null;
  contextMode: 'pdf' | 'text' | null;
  hasSchema: boolean;
}

/** prefixFingerprint (PLAN 2.4 "캐시 관측"): what the app controls of the cached prefix. */
export function prefixFingerprint(p: FingerprintParts): string {
  return sha256(JSON.stringify([p.systemSha256, p.pdfSha256, p.supplementSha256, p.contextMode, p.hasSchema]));
}

/** Refuses the combination the plan forbids: a JSON schema changes the cached prefix (M4 observation). */
export function assertSchemaWithoutPrefix(prefix: readonly ContentBlock[], jsonSchema: object | undefined): void {
  if (jsonSchema !== undefined && prefix.length > 0) throw new Error('a JSON schema is only allowed for tasks without paper context (PLAN 2.4)');
}

export interface PaperContext {
  prefix: ContentBlock[];
  contextMode: 'pdf' | 'text';
  pdfSha256: string;
  supplementSha256: string;
}

/** Loads and verifies the context of one paper (throws ContextError). */
export function loadPaperContext(db: Db, paths: DataPaths, paperId: string): PaperContext {
  const paper = db
    .select({ contextReadyAt: papers.contextReadyAt, contextMode: papers.contextMode, pdfSha256: papers.pdfSha256, supplementSha256: papers.supplementSha256, supplementVersion: papers.supplementVersion, deletingAt: papers.deletingAt })
    .from(papers)
    .where(eq(papers.id, paperId))
    .get();
  if (!paper || paper.deletingAt !== null) throw new ContextError('context_not_ready', 'paper not found');
  if (paper.contextReadyAt === null || !paper.contextMode || !paper.pdfSha256 || !paper.supplementSha256) throw new ContextError('context_not_ready', 'paper context is not ready yet');
  if (paper.contextMode === 'text') throw new ContextError('too_large', 'this paper needs text context mode (not available before M3)');
  const dir = paths.paperDir(paperId);
  const pdfFile = join(dir, 'paper.pdf');
  // S (PLAN_M2 D1): the version on the row picks the file (v1 supplement.txt, v2 supplement.v2.txt).
  const supFile = paths.supplementFile(paperId, paper.supplementVersion ?? 1);
  if (!existsSync(pdfFile) || !existsSync(supFile)) throw new ContextError('context_not_ready', 'paper files are missing');
  const pdf = readFileSync(pdfFile);
  const supBytes = readFileSync(supFile);
  if (sha256(pdf) !== paper.pdfSha256) throw new ContextError('context_not_ready', 'paper.pdf does not match its recorded sha256');
  if (sha256(supBytes) !== paper.supplementSha256) throw new ContextError('context_not_ready', 'supplement.txt does not match its recorded sha256');
  return { prefix: buildPaperPrefix(pdf, supBytes.toString('utf8')), contextMode: 'pdf', pdfSha256: paper.pdfSha256, supplementSha256: paper.supplementSha256 };
}
