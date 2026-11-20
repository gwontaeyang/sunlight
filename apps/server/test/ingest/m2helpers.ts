// Owner A. Helpers for the M2 ingest tests: synthetic M2 fixtures, offline arXiv directories with HTML, upgrade runs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { JobSseEvent } from '@study-paper/shared/contracts/sse';
import { jobs, papers } from '../../src/db/schema';
import type { AppDeps } from '../../src/deps';
import { ingestService } from '../../src/ingest/pipeline';
import { fileTempDir } from '../helpers/tmp';
import { atomFeed, collectJobEvents } from './helpers';

const FIXTURES = new URL('../fixtures/', import.meta.url);
export const SYN_M2_HTML: string = readFileSync(new URL('synthetic-m2.html', FIXTURES), 'utf8');
export const SYN_M2_PDF: Buffer = readFileSync(new URL('synthetic-m2.pdf', FIXTURES));
export const SYN_M1_PDF: Buffer = readFileSync(new URL('synthetic.pdf', FIXTURES));
export const GOLDEN_V2: string = readFileSync(new URL('synthetic.supplement.v2.txt', FIXTURES), 'utf8');

export interface OfflinePaper {
  id: string;
  version: number;
  pdf: Buffer;
  html?: string;
  title?: string;
  authors?: string[];
}

/** An SP_ARXIV_OFFLINE_DIR with `<id>.atom.xml`, `<id>v<N>.pdf` and optionally `<id>v<N>.html`. */
export function offlineDir(entries: OfflinePaper[], dir = fileTempDir('sp-offline-')): string {
  mkdirSync(dir, { recursive: true });
  for (const e of entries) {
    writeFileSync(join(dir, `${e.id}.atom.xml`), atomFeed([{ id: e.id, version: e.version, ...(e.title ? { title: e.title } : {}), ...(e.authors ? { authors: e.authors } : {}) }]));
    writeFileSync(join(dir, `${e.id}v${e.version}.pdf`), e.pdf);
    if (e.html !== undefined) writeFileSync(join(dir, `${e.id}v${e.version}.html`), e.html);
  }
  return dir;
}

/** Starts an upgrade and collects its event stream. */
export async function upgradeAndWait(deps: AppDeps, paperId: string): Promise<{ jobId: string; events: JobSseEvent[]; job: typeof jobs.$inferSelect }> {
  const { jobId } = ingestService(deps).upgradeStructure(paperId);
  const events = await collectJobEvents(deps, jobId);
  await ingestService(deps).whenDone(jobId);
  return { jobId, events, job: deps.db.select().from(jobs).where(eq(jobs.id, jobId)).get()! };
}

export const paper = (deps: AppDeps, id: string) => deps.db.select().from(papers).where(eq(papers.id, id)).get();
export const count = (deps: AppDeps, table: string, paperId: string) => (deps.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE paperId = ?`).get(paperId) as { n: number }).n;
/** structure rows of a paper: [sections, equations, figures, paper_references]. */
export const structureCounts = (deps: AppDeps, paperId: string) => ['sections', 'equations', 'figures', 'paper_references'].map((t) => count(deps, t, paperId));
export const warnings = (deps: AppDeps, id: string): string[] => JSON.parse(paper(deps, id)!.ingestWarningsJson) as string[];
/** The part of a supplement v2 text from `<sections>` to the end (pipeline papers differ from the golden only in metadata). */
export const fromSections = (text: string) => text.slice(text.indexOf('<sections>'));
/**
 * LaTeXML's footnote markup as the real fixture 2107.06829v1.html writes it ("…Github<span id="footnotex1"
 * class="ltx_note ltx_role_footnote"><sup class="ltx_note_mark">2</sup>…"): the mark, then the note with its own mark and
 * tag. Placed right after a mention, its digits are drawn raised (A-FX-01).
 */
export const latexmlFootnote = (n: number) =>
  `<span id="footnotex${n}" class="ltx_note ltx_role_footnote"><sup class="ltx_note_mark">${n}</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">${n}</sup>\n <span class="ltx_tag ltx_tag_note">${n}</span>\n the note text</span></span></span>`;
