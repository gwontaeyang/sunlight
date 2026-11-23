// Keep long uploads within the document budget while including material from throughout the paper.
// The selected passage, when supplied by the reader, is sent separately in the task tail.
import { escapeText, stripControl } from '../llm/taskSerialize';

const MAX_PAGES = 64;
const MAX_CHARS = 80_000;

export function buildUploadTextContext(pages: readonly { page: number; text: string }[]): string {
  const readable = pages.filter(p => p.text.trim().length > 0);
  const count = Math.min(MAX_PAGES, readable.length);
  if (!count) return '';
  const maxPerPage = Math.min(4000, Math.floor(MAX_CHARS / count));
  const parts = ['<paper_text trust="paper" coverage="excerpts">'];
  for (let i = 0; i < count; i++) {
    const index = count === 1 ? 0 : Math.round(i * (readable.length - 1) / (count - 1));
    const { text, page } = readable[index]!;
    const excerpt = stripControl(text.slice(0, maxPerPage)).replace(/[\uD800-\uDBFF]$/, '');
    parts.push(`<page n="${page}">${escapeText(excerpt)}</page>`);
  }
  parts.push('</paper_text>', '');
  return parts.join('\n');
}
