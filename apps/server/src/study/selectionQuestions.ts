import { z } from 'zod';
import { SelectionQuestions } from '@study-paper/shared/contracts/api';
import { TextQuoteSelectorSchema, PageNumberSchema } from '@study-paper/shared/contracts/domain';

// The SDK supports a subset of JSON Schema. Length and count bounds are enforced
// identically for CLI, SDK and fake transport after generation.
export const SELECTION_QUESTIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cards'], properties: {
    cards: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['type', 'frontMd', 'backMd', 'evidence'],
      properties: {
        type: { type: 'string', enum: ['definition', 'why', 'derivation', 'compare'] },
        frontMd: { type: 'string' }, backMd: { type: 'string' }, evidence: { type: 'string' },
      },
    } },
  },
};

export function parseSelectionQuestions(text: string, selection: string): SelectionQuestions | null {
  if (text.length > 64_000) return null;
  try {
    const result = SelectionQuestions.safeParse(JSON.parse(text));
    if (!result.success) return null;
    const cards = result.data.cards;
    if (new Set(cards.map((card) => card.frontMd)).size !== cards.length) return null;
    return cards.every((card) => card.evidence.trim() && selection.includes(card.evidence)) ? result.data : null;
  } catch {
    return null;
  }
}

const StoredPreview = z.object({ page: PageNumberSchema, start: z.number().int().nonnegative(), quote: TextQuoteSelectorSchema, text: z.string().max(64_000) });
export function storedQuestions(raw: string) {
  try {
    const stored = StoredPreview.safeParse(JSON.parse(raw));
    if (!stored.success) return null;
    const questions = parseSelectionQuestions(stored.data.text, stored.data.quote.exact);
    return questions && { ...stored.data, questions };
  } catch {
    return null;
  }
}
