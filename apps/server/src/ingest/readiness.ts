// "Files/text ready" vs "AI available with the current LLM" (M1.1 review M5).
// contextReadyAt says that the PDF, page texts and supplement.txt are published. Whether the LLM can use them
// depends on contextMode: M1 sends the whole PDF ('pdf' mode); 'text' mode (>= 41 pages or > 15 MiB, see
// supplement.ts) arrives in M3, and until then llm/paperContext.ts ends such a request with `too_large`.
// The paper DTOs carry the result so the web can disable the AI buttons with the reason before any click.
import type { AiAvailabilityDto } from '@study-paper/shared/contracts/api';
import type { ContextMode } from '@study-paper/shared/contracts/domain';
import { CONTEXT_TEXT_MIN_PAGES } from './supplement';

/** Context modes the current LLM path accepts (= llm/paperContext.ts loadPaperContext). */
export const LLM_CONTEXT_MODES: ReadonlySet<ContextMode> = new Set<ContextMode>(['pdf']);

export function aiAvailability(p: { contextReadyAt: number | null; contextMode: ContextMode | null; pageCount: number | null }): AiAvailabilityDto {
  if (p.contextReadyAt === null || p.contextMode === null) return { available: false, reason: 'context_not_ready' };
  if (LLM_CONTEXT_MODES.has(p.contextMode)) return { available: true, reason: null };
  // contextMode 'text': name the rule that put it there (pages first; otherwise the PDF size).
  return { available: false, reason: p.pageCount !== null && p.pageCount >= CONTEXT_TEXT_MIN_PAGES ? 'text_mode_pages' : 'text_mode_bytes' };
}
