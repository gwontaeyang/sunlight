// PDF → PageText[] with pdfjs-dist (legacy build for Node). Owner A (v0 by S0).
// Limits (PLAN 3 "PDF 처리량"): more than 300 pages → IngestError('too_large') before any page is read;
// the whole extraction (load + every page) must finish within 120 s → IngestError('timeout'). A caller
// signal (shutdown, paper deleted) → IngestError('cancelled'). The pdf.js task is destroyed in every case.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { buildPageText, TEXT_CONTENT_OPTIONS } from '@study-paper/shared/anchor/pageText';
import { LIMITS } from '@study-paper/shared/contracts/api';
import type { PageText } from '@study-paper/shared/contracts/domain';
import { IngestError } from './errors';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
/** Version recorded in page_texts.pdfjsVersion (server and web must use the same pdfjs-dist). */
export const PDFJS_VERSION: string = (require('pdfjs-dist/package.json') as { version: string }).version;

export const MAX_PDF_PAGES: number = LIMITS.maxPdfPages;
export const TEXT_TIMEOUT_MS = 120_000;

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfjsModule> | null = null;
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

export interface ExtractedPdf {
  pageCount: number;
  pages: PageText[];
}

export interface ExtractOptions {
  maxPages?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Clock for the between-page deadline check (tests). */
  now?: () => number;
}

export async function extractPageTexts(data: Uint8Array, opts: ExtractOptions = {}): Promise<ExtractedPdf> {
  const maxPages = opts.maxPages ?? MAX_PDF_PAGES;
  const timeoutMs = opts.timeoutMs ?? TEXT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  if (opts.signal?.aborted) throw new IngestError('cancelled', 'text extraction cancelled');

  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: data.slice(),
    useSystemFonts: false,
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/',
    cMapUrl: join(pdfjsRoot, 'cmaps') + '/',
    cMapPacked: true,
  });

  // Rejects when the wall-clock limit passes or the caller aborts; raced against every pdf.js await.
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IngestError('timeout', `text extraction exceeded ${timeoutMs} ms`)), timeoutMs);
    onAbort = () => reject(new IngestError('cancelled', 'text extraction cancelled'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  stop.catch(() => {}); // observed through the races below
  const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, stop]);
  const checkClock = () => {
    if (now() > deadline) throw new IngestError('timeout', `text extraction exceeded ${timeoutMs} ms`);
  };

  try {
    let doc: Awaited<typeof task.promise>;
    try {
      doc = await guard(task.promise);
    } catch (e) {
      if (e instanceof IngestError) throw e;
      throw new IngestError('invalid_pdf', `pdf.js cannot open the file: ${(e as Error).message}`);
    }
    if (doc.numPages > maxPages) throw new IngestError('too_large', `PDF has ${doc.numPages} pages (limit ${maxPages})`);
    const pages: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      checkClock();
      const page = await guard(doc.getPage(n));
      const viewport = page.getViewport({ scale: 1 });
      const content = await guard(page.getTextContent(TEXT_CONTENT_OPTIONS));
      pages.push(buildPageText(n, content.items, viewport));
      page.cleanup();
    }
    checkClock();
    return { pageCount: doc.numPages, pages };
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    await task.destroy().catch(() => {});
  }
}
