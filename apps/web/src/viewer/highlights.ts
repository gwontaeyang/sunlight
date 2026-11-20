// User highlights (PLAN 5.3, 8.2): create from the selection, draw the stored rects, change color, delete.
// The list is shared with the panels (D) through qk.highlights(paperId).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateHighlightRequest, HighlightDto } from '@study-paper/shared/contracts/api';
import type { NormRect } from '@study-paper/shared/contracts/domain';
import { api } from '../api/client';
import { qk } from '../api/queryKeys';
import type { Highlight } from '../vendor/pdf-highlighter';
import { boundingScaled, normRectToScaled } from './coords';
import { HIGHLIGHT_PALETTE } from '@study-paper/shared/contracts/domain';
import type { HighlightColorValue } from './shortcuts';

/** = contracts HIGHLIGHT_PALETTE (shared with the highlights tab). */
export const HIGHLIGHT_COLORS: Record<HighlightColorValue, { name: string; fill: string; swatch: string }> = HIGHLIGHT_PALETTE;
export const COLOR_VALUES = [1, 2, 3, 4, 5] as const satisfies readonly HighlightColorValue[];

const LAST_COLOR_KEY = 'sp.reader.lastHighlightColor';
/** Last used highlight color (per-browser convenience; default 1). */
export function readLastColor(): HighlightColorValue {
  try {
    const v = Number(window.localStorage.getItem(LAST_COLOR_KEY));
    return (COLOR_VALUES as readonly number[]).includes(v) ? (v as HighlightColorValue) : 1;
  } catch {
    return 1;
  }
}
export function writeLastColor(c: HighlightColorValue): void {
  try {
    window.localStorage.setItem(LAST_COLOR_KEY, String(c));
  } catch {
    /* storage unavailable */
  }
}

/** Highlighter object for a stored highlight; `dto` carries the NormRects the container draws. */
export type ViewerHighlight = Highlight & { dto: HighlightDto };
export function toViewerHighlight(h: HighlightDto): ViewerHighlight {
  const rects: NormRect[] = h.rects.length ? h.rects : [];
  return {
    id: h.id,
    type: h.kind,
    position: { boundingRect: boundingScaled(rects.length ? rects : [{ page: h.page, x: 0, y: 0, w: 0, h: 0 }]), rects: rects.map(normRectToScaled) },
    dto: h,
  };
}

export function useHighlights(paperId: string) {
  return useQuery({ queryKey: qk.highlights(paperId), queryFn: () => api.call('highlights.list', { params: { id: paperId } }) });
}

export function useHighlightMutations(paperId: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.highlights(paperId) });
  const create = useMutation({
    mutationFn: (body: CreateHighlightRequest) => api.call('highlights.create', { params: { id: paperId }, body }),
    onSuccess: invalidate,
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; color: HighlightColorValue }) => api.call('highlights.patch', { params: { id: v.id }, body: { color: v.color } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.call('highlights.delete', { params: { id } }),
    onSuccess: invalidate,
  });
  return { create, patch, remove };
}
