// Area capture (PLAN_M2 3.5, BRIEF_C C1). Owner C.
// Ctrl+drag (vendored MouseSelection, enableAreaSelection = e.ctrlKey) → one NormRect on the page where the drag
// started (cut to that page) → only that rectangle is rendered again into an offscreen canvas → PNG.
// - Size: ONLY S's captureCanvasSize (shared/image/capture.ts — same constants as the server's inspectPng). w1 / h1 are
//   the selection's size at pdf.js viewport scale 1. null (an output side < 8 px) → the selection is ignored.
// - canvas.toBlob('image/png') over 4 MiB → shrink × 0.75 and render again, at most 3 times; still too big → error
//   (nothing is sent). The canvas is released (size 0) after every attempt; one capture at a time.
import { CAPTURE, captureCanvasSize, type CaptureSize } from '@study-paper/shared/image/capture';
import type { NormRect } from '@study-paper/shared/contracts/domain';

/** Retries after the first render when the PNG is too big (BRIEF_C C1: × 0.75 at most 3 times). */
export const CAPTURE_SHRINK_STEP = 0.75;
export const CAPTURE_MAX_RETRIES = 3;
/** Longest output side under which the menu warns that the area may be hard to read (PLAN §8.2). */
export const CAPTURE_SMALL_PX = 400;

/** pdf.js PDFPageProxy surface used here (V = its PageViewport). */
export interface CapturePage<V extends { width: number; height: number } = { width: number; height: number }> {
  getViewport(o: { scale: number }): V;
  render(o: { canvas: HTMLCanvasElement; viewport: V; transform?: number[] }): { promise: Promise<unknown> };
}

/** Canvas surface used here (a real HTMLCanvasElement in the browser; a fake in tests). */
export interface CaptureCanvas {
  width: number;
  height: number;
  toBlob(cb: (b: Blob | null) => void, type?: string): void;
}

export interface CaptureOk {
  pngBase64: string;
  widthPx: number;
  heightPx: number;
  /** Render scale relative to pdf.js viewport scale 1 (captureCanvasSize().scale). */
  scale: number;
}

export type CaptureErrorCode = 'too_large' | 'render_failed';
export class CaptureError extends Error {
  constructor(readonly code: CaptureErrorCode, message: string) {
    super(message);
  }
}
export const CAPTURE_ERROR_TEXT: Record<CaptureErrorCode, string> = {
  too_large: '캡처한 이미지가 4 MiB를 넘어 보낼 수 없습니다. 영역을 더 작게 선택하세요.',
  render_failed: '영역을 그리지 못했습니다.',
};

export interface CaptureOptions {
  createCanvas?: () => CaptureCanvas;
  maxBytes?: number;
}

/** The selection's size in px at viewport scale 1. */
export function selectionSizeAtScale1(page: Pick<CapturePage, 'getViewport'>, rect: NormRect): { w1: number; h1: number } {
  const vp = page.getViewport({ scale: 1 });
  return { w1: rect.w * vp.width, h1: rect.h * vp.height };
}

/** Output size of the first render (null → ignore the selection). Uses only captureCanvasSize. */
export function captureSizeFor(page: Pick<CapturePage, 'getViewport'>, rect: NormRect, shrink = 1): CaptureSize | null {
  const { w1, h1 } = selectionSizeAtScale1(page, rect);
  return captureCanvasSize(w1, h1, shrink);
}

/**
 * Canvas transform that puts the selection's top-left corner at (0, 0) when the page is rendered at `scale`
 * (NormRect → canvas pixels; the inverse of canvasToNormRect).
 */
export function captureTransform(page: Pick<CapturePage, 'getViewport'>, rect: NormRect, scale: number): number[] {
  const vp = page.getViewport({ scale });
  return [1, 0, 0, 1, -rect.x * vp.width, -rect.y * vp.height];
}

/** A canvas pixel point of a capture back to page fractions (for the NormRect ↔ canvas round trip). */
export function canvasToNormPoint(page: Pick<CapturePage, 'getViewport'>, rect: NormRect, scale: number, px: { x: number; y: number }): { x: number; y: number } {
  const vp = page.getViewport({ scale });
  return { x: rect.x + px.x / vp.width, y: rect.y + px.y / vp.height };
}

const defaultCanvas = (): CaptureCanvas => document.createElement('canvas');

function toBlob(canvas: CaptureCanvas): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

/** Standard padded base64 of bytes (btoa — canonical: zero pad bits, D32). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/**
 * Renders `rect` of `page` into a PNG. null when the selection is too small to send (captureCanvasSize → null).
 * Throws CaptureError('too_large') when the PNG stays over maxBytes after CAPTURE_MAX_RETRIES shrinks.
 */
export async function captureArea<V extends { width: number; height: number }>(page: CapturePage<V>, rect: NormRect, o: CaptureOptions = {}): Promise<CaptureOk | null> {
  const createCanvas = o.createCanvas ?? defaultCanvas;
  const maxBytes = o.maxBytes ?? CAPTURE.maxBytes;
  let shrink = 1;
  for (let attempt = 0; attempt <= CAPTURE_MAX_RETRIES; attempt++, shrink *= CAPTURE_SHRINK_STEP) {
    const size = captureSizeFor(page, rect, shrink);
    if (!size) {
      if (attempt === 0) return null;
      break; // shrinking made it too small: it cannot be sent
    }
    const canvas = createCanvas();
    let blob: Blob | null;
    try {
      canvas.width = size.width;
      canvas.height = size.height;
      const viewport = page.getViewport({ scale: size.scale });
      await page.render({ canvas: canvas as HTMLCanvasElement, viewport, transform: captureTransform(page, rect, size.scale) }).promise;
      blob = await toBlob(canvas);
    } catch (e) {
      throw new CaptureError('render_failed', (e as Error)?.message ?? 'render failed');
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
    if (!blob) throw new CaptureError('render_failed', 'canvas.toBlob returned null');
    if (blob.size <= maxBytes) {
      const pngBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
      return { pngBase64, widthPx: size.width, heightPx: size.height, scale: size.scale };
    }
  }
  throw new CaptureError('too_large', 'capture over the PNG size limit');
}
