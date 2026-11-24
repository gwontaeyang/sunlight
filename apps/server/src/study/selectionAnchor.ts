import { and, eq } from 'drizzle-orm';
import { matchQuote, MAX_TEXT_CHARS } from '@study-paper/shared/anchor/matchQuote';
import type { TextPositionSelector, TextQuoteSelector } from '@study-paper/shared/contracts/domain';
import type { Db } from '../db/client';
import { pageTexts } from '../db/schema';

/** Prefer literal matches, including selections above matchQuote's 4K normalisation budget. */
export function reviewSelectionPosition(db: Db, paperId: string, page: number, quote: TextQuoteSelector): TextPositionSelector | null {
  const row = db.select({ page: pageTexts.page, text: pageTexts.text }).from(pageTexts)
    .where(and(eq(pageTexts.paperId, paperId), eq(pageTexts.page, page))).get();
  if (!row || row.text.length > MAX_TEXT_CHARS || !quote.exact.trim()) return null;
  const start = row.text.indexOf(quote.exact);
  if (start >= 0 && row.text.indexOf(quote.exact, start + 1) < 0) return { page, start, end: start + quote.exact.length };
  if (start >= 0 && (quote.prefix || quote.suffix)) {
    const contextual = (quote.prefix ?? '') + quote.exact + (quote.suffix ?? '');
    const i = row.text.indexOf(contextual);
    if (i >= 0 && row.text.indexOf(contextual, i + 1) < 0) {
      const offset = i + (quote.prefix?.length ?? 0);
      return { page, start: offset, end: offset + quote.exact.length };
    }
  }
  // pdf.js selections may use different line breaks, ligatures or whitespace. Require a unique
  // verbatim match under the same conservative normalisation used for text highlights.
  const match = matchQuote([row], quote, { pageHint: page, pageOnly: true });
  return match.status === 'verbatim' && match.position ? match.position : null;
}
