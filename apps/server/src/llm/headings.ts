// Fixed-heading check of summary and equation_deep (PLAN_M2 3.4 / 3.5, BRIEF_B B7). Owner B.
//
// The prompts ask for fixed `## …` headings. A missing heading is NOT a format error: the output is stored as it is
// and one issue per missing heading is added to the parsed result (summary: run.done.parsed and the card's replay;
// equation_deep: messages.issuesJson). The issue text is fixed app text built from the table below — never model
// text. Presence only (order is not checked). Work is one pass over the lines; headings longer than
// MAX_HEADING_LINE_CHARS are never compared, and code fences / math fences / indented code are skipped.
import type { TaskId } from '@study-paper/shared/contracts/tasks';
import { expandTabs, splitFences } from '@study-paper/shared/markup/parseAnswer';

/** Summary headings the prompt asks for (prompts/summary.md). */
export const SUMMARY_HEADINGS = ['3줄 요약', '방법 요약', '읽기 지도'] as const;
/** equation_deep headings the prompt asks for (prompts/equation_deep.md). */
export const EQUATION_DEEP_HEADINGS = ['기호 표', '단계별 유도', '쓰인 가정', '확인 질문'] as const;

export const HEADINGS_OF_TASK: Partial<Record<TaskId, readonly string[]>> = { summary: SUMMARY_HEADINGS, equation_deep: EQUATION_DEEP_HEADINGS };

const MAX_HEADING_LINE_CHARS = 200;

/** The fixed issue text for one missing heading (app text: the heading comes from HEADINGS_OF_TASK). */
export const missingHeadingIssue = (heading: string) => `heading missing: ## ${heading}`;

/** The ATX heading text of a line (`## x ##` → `x`), or null when the line is not a heading. Linear, no regex loops. */
function headingText(line: string): string | null {
  if (line.length > MAX_HEADING_LINE_CHARS) return null;
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let hashes = 0;
  while (line[i + hashes] === '#') hashes++;
  if (hashes < 1 || hashes > 6) return null;
  const after = line[i + hashes];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  let rest = line.slice(i + hashes).trim();
  // optional closing sequence: spaces + #'s at the end
  let end = rest.length;
  while (end > 0 && rest[end - 1] === '#') end--;
  if (end === 0) rest = '';
  else if (end < rest.length && (rest[end - 1] === ' ' || rest[end - 1] === '\t')) rest = rest.slice(0, end).trim();
  return rest.normalize('NFC');
}

/** One fixed issue per heading of `task` that the text does not have (outside code). [] for other tasks. */
export function headingIssues(task: TaskId, text: string): string[] {
  const want = HEADINGS_OF_TASK[task];
  if (!want) return [];
  const found = new Set<string>();
  for (const seg of splitFences(expandTabs(text))) {
    if (seg.code) continue;
    for (const line of seg.text.split('\n')) {
      const h = headingText(line);
      if (h !== null) found.add(h);
    }
  }
  return want.filter((h) => !found.has(h)).map(missingHeadingIssue);
}
