// supplement.txt v1 (PLAN 4.1 `supplement`, M1: metadata only). Owner A.
// Deterministic: the same paper row always yields the same bytes (B fingerprints the PDF + supplement prefix).
// Published once with publishNoClobber and never overwritten (B reads it as immutable context).
import { join } from 'node:path';
import type { ContextMode } from '@study-paper/shared/contracts/domain';
import { publishNoClobber, sha256Hex, type PublishResult } from './files';

export const SUPPLEMENT_VERSION = 1;
export const SUPPLEMENT_FILE = 'supplement.txt';
/** contextMode rule (PLAN 2.4/4.1): text mode when the PDF is long or large. */
export const CONTEXT_TEXT_MIN_PAGES = 41;
export const CONTEXT_TEXT_MIN_BYTES = 15 * 1024 * 1024 + 1;

export interface SupplementInput {
  title: string;
  authors: readonly string[];
  arxivId: string;
  arxivVersion: number;
  year: number | null;
  primaryCategory: string | null;
}

/** Escapes text that ends up inside the <paper_index> block (paper metadata is untrusted). */
const esc = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildSupplementV1(p: SupplementInput): string {
  const lines = [
    '<paper_index>',
    '<metadata>',
    `title: ${esc(p.title)}`,
    `authors: ${p.authors.map(esc).join('; ')}`,
    `arxiv: ${esc(p.arxivId)}v${p.arxivVersion}`,
    `year: ${p.year ?? 'unknown'}`,
    `category: ${p.primaryCategory ? esc(p.primaryCategory) : 'unknown'}`,
    '</metadata>',
    '</paper_index>',
  ];
  return lines.join('\n') + '\n';
}

export function contextModeFor(pageCount: number, pdfBytes: number): ContextMode {
  return pageCount >= CONTEXT_TEXT_MIN_PAGES || pdfBytes >= CONTEXT_TEXT_MIN_BYTES ? 'text' : 'pdf';
}

export interface PublishedSupplement {
  sha256: string;
  bytes: number;
  result: PublishResult;
}

/** Writes papers/<id>/supplement.txt once (temp → fsync → no-clobber link). Different existing bytes → throws. */
export function publishSupplement(tmpDir: string, paperDir: string, text: string): PublishedSupplement {
  const data = Buffer.from(text, 'utf8');
  const result = publishNoClobber(tmpDir, join(paperDir, SUPPLEMENT_FILE), data);
  return { sha256: sha256Hex(data), bytes: data.length, result };
}
