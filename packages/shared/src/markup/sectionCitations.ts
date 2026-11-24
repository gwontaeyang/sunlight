import type { Citation } from '../contracts/domain';
import { pairCitations } from '../contracts/grounding';
import { parseAnswer } from './parseAnswer';

/** Pair globally, then rebase ordinals within each separately rendered section. */
export function sectionCitations(text: string, sections: readonly string[], citations: readonly Citation[]): Citation[][] | null {
  const whole = parseAnswer(text, { final: true });
  const pairs = pairCitations(whole.citations, citations);
  if (!pairs) return null;
  let cursor = 0;
  const result: Citation[][] = [];
  for (const section of sections) {
    const parsed = parseAnswer(section, { final: true });
    const local: Citation[] = [];
    for (const item of parsed.citations) {
      const source = whole.citations[cursor++];
      const original = source && pairs.get(source.ordinal);
      if (!original) return null;
      local.push({ ...original, ordinal: item.ordinal });
    }
    if (!pairCitations(parsed.citations, local)) return null;
    result.push(local);
  }
  return cursor === whole.citations.length ? result : null;
}
