// "Files/text ready" vs "AI available with the current LLM" for the web (M1.1 review M5).
// The server sends PaperSummaryDto.ai (reason code); this maps it to the Korean text shown in the Library, the
// reader header, the selection toolbar and on disabled AI buttons. Without `ai` (older server) contextReady decides.
import type { AiUnavailableReason, PaperSummaryDto } from '@study-paper/shared/contracts/api';

export interface AiStatus {
  available: boolean;
  reason: AiUnavailableReason | null;
  /** Korean reason for a disabled AI button / badge (null when available). */
  text: string | null;
  /** Short badge text (null when available). */
  short: string | null;
}

export const AI_TEXT_MODE_MIN_PAGES = 41;
/** Every 'text mode' reason starts with this (the toolbar shows it as the short label). */
export const AI_UNSUPPORTED = 'AI 미지원';

export function aiStatus(p: Pick<PaperSummaryDto, 'state' | 'ingestStatus' | 'pageCount'> & { ai?: PaperSummaryDto['ai'] }): AiStatus {
  // Both must agree: a paper whose context is not ready is never "available", whatever `ai` says.
  const ai = !p.state.contextReady ? { available: false, reason: 'context_not_ready' as const } : (p.ai ?? { available: true, reason: null });
  if (ai.available) return { available: true, reason: null, text: null, short: null };
  switch (ai.reason) {
    case 'upload_no_text':
      return { available: false, reason: ai.reason, short: AI_UNSUPPORTED, text: '이 PDF에서 텍스트를 추출하지 못해 AI 설명을 사용할 수 없습니다. PDF 읽기와 영역 노트는 사용할 수 있습니다.' };
    case 'text_mode_pages':
      return {
        available: false,
        reason: ai.reason,
        short: AI_UNSUPPORTED,
        text: `${AI_UNSUPPORTED}: ${AI_TEXT_MODE_MIN_PAGES}쪽 이상${p.pageCount ? `(${p.pageCount}쪽)` : ''} 논문 — M3 예정. 읽기·하이라이트는 사용할 수 있습니다.`,
      };
    case 'text_mode_bytes':
      return { available: false, reason: ai.reason, short: AI_UNSUPPORTED, text: `${AI_UNSUPPORTED}: PDF 15 MiB 초과 — M3 예정. 읽기·하이라이트는 사용할 수 있습니다.` };
    default:
      return {
        available: false,
        reason: 'context_not_ready',
        short: p.ingestStatus === 'running' ? 'AI 색인 준비 중' : 'AI 색인 없음',
        text: p.ingestStatus === 'running' ? '색인 준비 중 — 준비가 끝나면 AI 기능이 켜집니다' : 'AI 색인이 없습니다 — Library에서 다시 시도하세요',
      };
  }
}
