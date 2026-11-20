// Test helpers for ingest (owner A). No network: sources and fetch are in-memory fakes.
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import type { JobSseEvent } from '@study-paper/shared/contracts/sse';
import { jobs, papers } from '../../src/db/schema';
import type { AppDeps } from '../../src/deps';
import { parseArxivAtom, type ArxivCallHooks, type ArxivMetadata, type ArxivSource, type HtmlFetchOptions, type MetadataResult } from '../../src/ingest/arxivApi';
import { IngestError } from '../../src/ingest/errors';
import { FetchError } from '../../src/ingest/safeFetch';
import { configureIngest, ingestService, jobEvents, type IngestOptions } from '../../src/ingest/pipeline';

export const SYNTHETIC_PDF: Buffer = readFileSync(new URL('../fixtures/synthetic.pdf', import.meta.url));

export interface AtomEntry {
  id: string;
  version: number;
  title?: string;
  authors?: string[];
  published?: string;
  primaryCategory?: string;
  summary?: string;
}

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An arXiv API Atom feed in the shape export.arxiv.org returns (synthetic values). */
export function atomFeed(entries: AtomEntry[]): string {
  const body = entries
    .map(
      (e) => `  <entry>
    <id>http://arxiv.org/abs/${e.id}v${e.version}</id>
    <updated>2022-10-01T00:00:00Z</updated>
    <published>${e.published ?? '2022-09-30T12:00:00Z'}</published>
    <title>${x(e.title ?? `Synthetic paper ${e.id}`)}</title>
    <summary>${x(e.summary ?? 'A synthetic abstract.')}</summary>
${(e.authors ?? ['Test Author', 'Second Author']).map((a) => `    <author><name>${x(a)}</name></author>`).join('\n')}
    <link href="http://arxiv.org/abs/${e.id}v${e.version}" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/${e.id}v${e.version}" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="${e.primaryCategory ?? 'cs.RO'}" scheme="http://arxiv.org/schemas/atom"/>
    <category term="${e.primaryCategory ?? 'cs.RO'}" scheme="http://arxiv.org/schemas/atom"/>
  </entry>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?id_list=x" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query</title>
  <id>http://arxiv.org/api/synthetic</id>
  <updated>2022-10-01T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">${entries.length}</opensearch:totalResults>
${body}
</feed>
`;
}

/**
 * M2: the HTML of a paper — a string, or a function (version, signal, opts) that returns it or throws (e.g. a FetchError
 * 'timeout' / 'http_status', or one with a NetworkDisabledError cause). Missing → FetchError 'not_found' (arXiv has no
 * HTML), the M1 behaviour of every existing FakeArxivSource.
 */
export type FakeHtml = string | ((version: number, signal: AbortSignal | undefined, opts: HtmlFetchOptions) => string | Promise<string>);

/** In-memory arXiv: papers by id (latest version = `version`), PDF bytes per id. Counts calls. */
export class FakeArxivSource implements ArxivSource {
  readonly kind = 'network' as const;
  calls = { metadata: 0, pdf: 0 };
  /** M2: html() calls (kept out of `calls`, whose shape M1 tests assert). */
  htmlCalls = 0;
  constructor(
    readonly papers: Record<string, { version: number; title?: string; authors?: string[]; pdf?: Buffer; pdfDelayMs?: number; html?: FakeHtml }>,
  ) {}
  async html(id: string, version: number, signal: AbortSignal | undefined, _hooks: ArxivCallHooks | undefined, opts: HtmlFetchOptions): Promise<string> {
    this.htmlCalls++;
    const h = this.papers[id]?.html;
    if (h === undefined) throw new FetchError('not_found', `https://arxiv.org/html/${id}v${version} → HTTP 404`, 404);
    return typeof h === 'string' ? h : await h(version, signal, opts);
  }
  async metadata(id: string, version: number | undefined): Promise<MetadataResult> {
    this.calls.metadata++;
    const p = this.papers[id];
    if (!p) throw new IngestError('not_found', `arXiv has no paper ${id}`);
    const meta: ArxivMetadata = parseArxivAtom(atomFeed([{ id, version: version ?? p.version, title: p.title, ...(p.authors ? { authors: p.authors } : {}) }]), id, version);
    if (version !== undefined && version > p.version) throw new IngestError('not_found', `arXiv has no ${id}v${version}`);
    return { meta, requests: 1 };
  }
  async pdf<T>(id: string, _version: number, consume: (chunks: AsyncIterable<Uint8Array>, size: number | null) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.calls.pdf++;
    const p = this.papers[id];
    if (!p) throw new IngestError('not_found', `no pdf for ${id}`);
    const data = p.pdf ?? SYNTHETIC_PDF;
    const delay = p.pdfDelayMs ?? 0;
    async function* chunks() {
      const step = Math.max(1, Math.ceil(data.length / 4));
      for (let i = 0; i < data.length; i += step) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (signal?.aborted) throw new IngestError('cancelled', 'aborted');
        yield new Uint8Array(data.subarray(i, i + step));
      }
    }
    return consume(chunks(), data.length);
  }
}

export function useSource(deps: AppDeps, source: ArxivSource, extra: IngestOptions = {}): void {
  configureIngest(deps, { source, beforeStep: undefined, ...extra });
}

/** Collects every event of a job stream until its terminal event. */
export async function collectJobEvents(deps: AppDeps, jobId: string): Promise<JobSseEvent[]> {
  const it = jobEvents(deps, jobId);
  if (!it) throw new Error(`no job ${jobId}`);
  const out: JobSseEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

export async function waitJob(deps: AppDeps, jobId: string): Promise<typeof jobs.$inferSelect> {
  await ingestService(deps).whenDone(jobId);
  return deps.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
}

export function paperRow(deps: AppDeps, id: string) {
  return deps.db.select().from(papers).where(eq(papers.id, id)).get();
}

/** Imports through the service and waits for the job. */
export async function importAndWait(deps: AppDeps, input: string) {
  const res = ingestService(deps).importArxiv(input);
  expect(res.jobId).toBeTruthy();
  const job = await waitJob(deps, res.jobId!);
  return { res, job, paper: paperRow(deps, res.paperId)! };
}

/** A unique new-style arXiv id per call (2301.NNNNN). */
let counter = 10000;
export const freshId = () => `2301.${String(counter++).padStart(5, '0')}`;

/**
 * A valid N-page PDF (Helvetica text "Page k" on each page), optionally padded with a PDF comment so the file is
 * exactly `totalBytes` long (contextMode boundary tests: 40/41 pages, 15 MiB ± 1).
 */
export function makePdf(pages: number, totalBytes?: number): Buffer {
  const build = (padLen: number): Buffer => {
    const objs: string[] = [];
    const kids: string[] = [];
    // 1 catalog, 2 pages, 3 font, then per page: page + content
    for (let k = 0; k < pages; k++) kids.push(`${4 + 2 * k} 0 R`);
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    for (let k = 0; k < pages; k++) {
      const stream = `BT /F1 12 Tf 72 720 Td (Page ${k + 1} of a synthetic long paper.) Tj ET`;
      objs[4 + 2 * k] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * k} 0 R >>`;
      objs[5 + 2 * k] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }
    let out = '%PDF-1.7\n';
    if (padLen > 0) out += `%${'x'.repeat(padLen - 2)}\n`;
    const offsets: number[] = [];
    for (let i = 1; i < objs.length; i++) {
      offsets[i] = out.length;
      out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  };
  if (totalBytes === undefined) return build(0);
  const base = build(0).length;
  // Padding shifts every offset by padLen; the xref/startxref digits are fixed-width except startxref itself.
  let pad = totalBytes - base;
  for (let i = 0; i < 4; i++) {
    const b = build(pad);
    if (b.length === totalBytes) return b;
    pad += totalBytes - b.length;
  }
  throw new Error(`could not build a ${totalBytes}-byte PDF`);
}
