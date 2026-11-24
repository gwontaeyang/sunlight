import { OVERVIEW_MAX_CHARS, type Citation } from './contracts/domain';
import { parseAnswer } from './markup/parseAnswer';
import { sectionCitations } from './markup/sectionCitations';

/** The prompt and UI agree on five short paragraphs in a fixed order, in either answer language. */
export function splitOverview(text: string): string[] | null {
  if (text.length > OVERVIEW_MAX_CHARS) return null;
  const sections: string[] = [];
  const lines = text.trim().replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim());
  if (lines.length !== 10) return null;
  for (let i = 0; i < 5; i++) {
    if (lines[2 * i]!.trimEnd() !== `## ${i + 1}`) return null;
    const body = lines[2 * i + 1]!.trim();
    if (body.length > 720 || !/\[\[(P|N)\]\]$/.test(body)) return null;
    // A label and quotation alone do not explain the paper.
    const prose = body.replace(/<q>[\s\S]*?<\/q>|<eq\b[^>]*\/>|\[\[[PN]\]\]/g, '');
    if (!/[\p{L}\p{N}]/u.test(prose)) return null;
    const parsed = parseAnswer(body, { final: true });
    if (parsed.issues.length || parsed.blocks.length !== 1 || parsed.glossary.length) return null;
    const block = parsed.blocks[0]!;
    if (block.label === 'P') {
      if (!parsed.citations.some((c) => c.kind === 'quote')) return null;
    } else if (block.label !== 'N' || parsed.citations.length) return null;
    sections.push(body);
  }
  return sections;
}

/** A citation from another section or result must never certify this summary. */
export function overviewCitations(text: string, citations: readonly Citation[]): Citation[][] | null {
  const sections = splitOverview(text);
  return sections && sectionCitations(text, sections, citations);
}
