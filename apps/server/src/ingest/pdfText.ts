// PDF → PageText[] with pdfjs-dist (legacy build for Node). Owner A (v0 by S0).
// Limits (PLAN 3 "PDF 처리량"): more than 300 pages → IngestError('too_large') before any page is read;
// the whole extraction (load + every page) must finish within 120 s → IngestError('timeout'). A caller
// signal (shutdown, paper deleted) → IngestError('cancelled'). The pdf.js task is destroyed in every case.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { buildPageText, TEXT_CONTENT_OPTIONS } from '@study-paper/shared/anchor/pageText';
import { LIMITS } from '@study-paper/shared/contracts/api';
import type { PageText } from '@study-paper/shared/contracts/domain';
import type { PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api';
import { IngestError } from './errors';
import { cleanPdfTitle, UploadLayout, uploadBookmarks, type OutlineKind, type UploadSection } from './uploadOutline';

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

export interface ExtractedUpload extends ExtractedPdf {
  title: string;
  outlineKind: OutlineKind;
  sections: UploadSection[];
}

type Guard = <T>(p: Promise<T>) => Promise<T>;
const UPLOAD_LIMITS = { pageItems: 50_000, items: 250_000, chars: 4_000_000 } as const;

/** Enforce decoded text limits *while* reading PDF.js chunks rather than after collecting a compressed page. */
async function uploadText(page: PDFPageProxy, guard: Guard, budget: { items: number; chars: number },
    viewport: ReturnType<PDFPageProxy['getViewport']>): Promise<{ content: TextContent; text: PageText }> {
  const reader = page.streamTextContent(TEXT_CONTENT_OPTIONS).getReader();
  const content: TextContent = { items: [], styles: Object.create(null), lang: null };
  const text: PageText = { page: page.pageNumber, text: '', items: [] };
  try {
    for (;;) {
      const { value, done } = await guard(reader.read());
      if (done) return { content, text };
      const chunk = value as TextContent;
      budget.items += chunk.items.length;
      if (budget.items > UPLOAD_LIMITS.items || content.items.length + chunk.items.length > UPLOAD_LIMITS.pageItems)
        throw new IngestError('too_large', 'PDF text item limit exceeded');
      for (const item of chunk.items) {
        if ('str' in item) budget.chars += item.str.length + (item.hasEOL ? 1 : 0);
        if (budget.chars > UPLOAD_LIMITS.chars) throw new IngestError('too_large', 'PDF text length limit exceeded');
        content.items.push(item);
      }
      // PDF.js emits bounded chunks while streaming. Keep the browser's exact raw text/offsets when joining them.
      const part = buildPageText(page.pageNumber, chunk.items, viewport);
      for (const item of part.items) {
        item.start += text.text.length;
        text.items.push(item);
      }
      text.text += part.text;
      Object.assign(content.styles, chunk.styles);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function extractUploadedPdf(data: Uint8Array, filename: string, opts: ExtractOptions = {}): Promise<ExtractedUpload> {
  return extractPdf(data, opts, filename);
}
export async function extractPageTexts(data: Uint8Array, opts: ExtractOptions = {}): Promise<ExtractedPdf> {
  return extractPdf(data, opts);
}
function extractPdf(data: Uint8Array, opts: ExtractOptions, filename: string): Promise<ExtractedUpload>;
function extractPdf(data: Uint8Array, opts: ExtractOptions): Promise<ExtractedPdf>;
async function extractPdf(data: Uint8Array, opts: ExtractOptions, filename?: string): Promise<ExtractedPdf | ExtractedUpload> {
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
    if (opts.signal?.aborted) throw new IngestError('cancelled', 'text extraction cancelled');
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
    const layout = filename !== undefined ? new UploadLayout() : null;
    const budget = { items: 0, chars: 0 };
    for (let n = 1; n <= doc.numPages; n++) {
      checkClock();
      const page = await guard(doc.getPage(n));
      const viewport = page.getViewport({ scale: 1 });
      try {
        if (layout) {
          const { text, content } = await uploadText(page, guard, budget, viewport);
          pages.push(text);
          await layout.add(text, content, viewport, checkClock);
        } else {
          const content = await guard(page.getTextContent(TEXT_CONTENT_OPTIONS));
          pages.push(buildPageText(n, content.items, viewport));
        }
      } finally { page.cleanup(); }
    }
    checkClock();
    const extracted = { pageCount: doc.numPages, pages };
    if (!layout || filename === undefined) return extracted;
    // Missing or malformed optional metadata/bookmarks do not prevent reading an otherwise valid PDF.
    const meta = await guard(doc.getMetadata().catch(() => null));
    const info = meta?.info as { Title?: unknown } | undefined;
    const title = cleanPdfTitle(info?.Title) || cleanPdfTitle(meta?.metadata?.get('dc:title'))
      || cleanPdfTitle(filename.replace(/\.pdf$/i, '')) || 'PDF';
    let sections = await guard(uploadBookmarks(doc, layout, checkClock).catch((error: unknown) => {
      if (error instanceof IngestError) throw error;
      return [];
    }));
    const bookmarked = sections.length > 0;
    if (!bookmarked) sections = await layout.estimate(title, checkClock);
    checkClock();
    return { ...extracted, title, sections, outlineKind: bookmarked ? 'bookmarks' : sections.length ? 'estimated' : 'none' };
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    await task.destroy().catch(() => {});
  }
}
