import type { AiAvailabilityDto } from '@study-paper/shared/contracts/api';
import { isPdfOnlyUpload, type ContextMode } from '@study-paper/shared/contracts/domain';
import { CONTEXT_TEXT_MIN_PAGES } from './supplement';

/** Common context modes. Uploads can also carry bounded page excerpts in their supplement. */
export const LLM_CONTEXT_MODES: ReadonlySet<ContextMode> = new Set<ContextMode>(['pdf']);

export function aiAvailability(p: { contextReadyAt: number | null; contextMode: ContextMode | null; pageCount: number | null; source?: string; structureSource?: string | null; ingestWarningsJson?: string }): AiAvailabilityDto {
  if (p.contextReadyAt === null || p.contextMode === null) return { available: false, reason: 'context_not_ready' };
  if (LLM_CONTEXT_MODES.has(p.contextMode)) return { available: true, reason: null };
  if (isPdfOnlyUpload(p.source, p.structureSource)) {
    if (p.ingestWarningsJson?.includes('"upload_no_text"')) {
      return { available: false, reason: 'upload_no_text' };
    }
    return { available: true, reason: null };
  }
  // contextMode 'text': name the rule that put it there (pages first; otherwise the PDF size).
  return { available: false, reason: p.pageCount !== null && p.pageCount >= CONTEXT_TEXT_MIN_PAGES ? 'text_mode_pages' : 'text_mode_bytes' };
}
