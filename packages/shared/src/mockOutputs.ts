// Node-only helper to read shared/fixtures/mock-outputs (server MockLlm adapter and tests). Not for the web.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TaskId } from './contracts/tasks';

export const MOCK_OUTPUTS_DIR = fileURLToPath(new URL('../fixtures/mock-outputs/', import.meta.url));

export interface MockExpect {
  quotes: { verbatim: number; ambiguous: number; notFound: number };
  eqRefs: number;
  labels?: ('P' | 'N' | 'G' | null)[];
  glossary?: number;
  issues: number;
}
export interface MockManifest {
  version: number;
  tasks: Record<TaskId, { file: string; format: 'sp-markup' | 'sp-blocks' | 'markdown' | 'json-schema'; expect: MockExpect | null }>;
  adversarial: Record<string, { file: string; expect: { quotes: number; labels?: ('P' | 'N' | 'G' | null)[]; minIssues: number } }>;
  /** M2 entries (BRIEF_S S7): read by B's parser tests and the m2 gate, never by the M1 loops. */
  m2: MockManifestM2;
}

export interface MockBlockErrorExpect {
  code: string;
  item?: number;
  key?: string;
}
export interface MockManifestM2 {
  about: string;
  adversarial: Record<string, { file: string; task: TaskId; options: { mode?: 'markup' | 'plain'; labels?: 'badge' | 'strip' }; expect: Record<string, unknown> }>;
  /** Each listed error must be among those validateBlocks reports. */
  blocksInvalid: Record<string, { file: string; task: TaskId; requestedTerm?: string; expect: { errors: MockBlockErrorExpect[] } }>;
  blocksAdversarial: Record<string, { file: string; task: TaskId; expect: { items: number | null; /** false: the whole output is a validation error (repair once → parse_failed). */ valid?: boolean; forgedCitations?: number; maxItems?: number; note: string } }>;
}

export function readMockManifest(): MockManifest {
  return JSON.parse(readFileSync(`${MOCK_OUTPUTS_DIR}manifest.json`, 'utf8')) as MockManifest;
}

export function readMockOutput(task: TaskId): string {
  return readFileSync(`${MOCK_OUTPUTS_DIR}${readMockManifest().tasks[task].file}`, 'utf8');
}

export type MockVariantDir = 'adversarial' | 'blocks_invalid' | 'blocks_adversarial';
const VARIANT_DIRS: readonly MockVariantDir[] = ['adversarial', 'blocks_invalid', 'blocks_adversarial'];

/** One variant output: `<dir>/<name>.md` (e.g. readMockVariant('blocks_invalid', 'notation_missing_key')). */
export function readMockVariant(dir: MockVariantDir, name: string): string {
  if (!VARIANT_DIRS.includes(dir) || !/^[a-z0-9_]+$/.test(name)) throw new Error('invalid mock variant');
  return readFileSync(`${MOCK_OUTPUTS_DIR}${dir}/${name}.md`, 'utf8');
}

export function readMockFile(relPath: string): string {
  if (relPath.includes('..')) throw new Error('invalid mock output path');
  return readFileSync(`${MOCK_OUTPUTS_DIR}${relPath}`, 'utf8');
}
