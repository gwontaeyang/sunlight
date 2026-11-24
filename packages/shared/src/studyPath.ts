import { STUDY_PATH_MAX_CHARS, STUDY_PATH_MAX_CHECKS, type Citation } from './contracts/domain';
import { sectionCitations } from './markup/sectionCitations';
import { expandTabs, splitFences } from './markup/parseAnswer';

export { STUDY_PATH_MAX_CHARS, STUDY_PATH_MAX_CHECKS } from './contracts/domain';
export type StageNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface StudyPathStage { number: StageNumber; body: string }

export interface StudyPathParts {
  stages: StudyPathStage[];
  checklist: string[];
  referenceOrdinals: number[];
  complete: boolean;
}

/** The same code/math ranges as the citation parser keep literal sample code out of the control grammar. */
export function splitStudyPath(raw: string): StudyPathParts {
  const parts: StudyPathParts = { stages: [], checklist: [], referenceOrdinals: [], complete: false };
  if (raw.length > STUDY_PATH_MAX_CHARS) return parts;
  let valid = true;
  let number: StageNumber | undefined;
  let lines: string[] = [];
  const finishStage = () => {
    if (number === undefined) return;
    const body = lines.join('\n').trim();
    if (!body) valid = false;
    parts.stages.push({ number, body });
    lines = [];
  };
  const segments = splitFences(expandTabs(raw.replace(/\r\n?/g, '\n')));
  for (const [index, segment] of segments.entries()) {
    // splitFences includes the separator on every nonfinal segment. lines.join restores it exactly once.
    const content = index < segments.length - 1 ? segment.text.slice(0, -1) : segment.text;
    if (segment.code) {
      if (number === undefined) valid = false;
      lines.push(content);
      continue;
    }
    for (const line of content.split('\n')) {
      const heading = /^## ([1-7])\s*$/.exec(line);
      if (heading) {
        finishStage();
        const next = Number(heading[1]) as StageNumber;
        if (next !== parts.stages.length + 1) return parts;
        number = next;
        continue;
      }
      if (number === undefined) {
        if (line.trim()) valid = false;
        continue;
      }
      if (number === 6 && line.startsWith('- [ ] ')) {
        const label = line.slice(6).trim();
        if (!label || label.length > 240 || /[<>\u0000-\u001f]|\[\[/.test(label) || parts.checklist.length >= STUDY_PATH_MAX_CHECKS) valid = false;
        else parts.checklist.push(label);
        lines.push('');
        continue;
      }
      const reference = number === 7 && /^- \[ref:(\d{1,6})\]$/.exec(line);
      if (reference) {
        const ordinal = Number(reference[1]);
        if (!parts.referenceOrdinals.includes(ordinal) && parts.referenceOrdinals.length < 32) parts.referenceOrdinals.push(ordinal);
        lines.push('');
        continue;
      }
      lines.push(line);
    }
  }
  finishStage();
  parts.complete = valid && parts.stages.length === 7 && parts.checklist.length > 0;
  return parts;
}

/** Only closed, nonempty examples in the selected language satisfy the implementation stage. */
export function hasStudyExamples(body: string, language: string | undefined): boolean {
  const tag = language === 'python' ? 'python' : 'cpp';
  let count = 0;
  for (const segment of splitFences(expandTabs(body))) {
    if (!segment.code) continue;
    const lines = segment.text.trimEnd().split('\n');
    const fence = /^(`{3,}|~{3,})(cpp|python)\s*$/.exec(lines[0]!);
    const end = lines.at(-1)!.trim();
    if (fence && fence[2] === tag && end.length >= fence[1]!.length && [...end].every((c) => c === fence[1]![0]) && lines.slice(1, -1).some((line) => line.trim())) count++;
  }
  return count >= 2;
}

/** Validate the full stored answer first, then pair each stage in order with its local ordinals.
 * A boundary that changes citation parsing invalidates every stage together. */
export function studyPathCitations(text: string, citations: readonly Citation[]): Citation[][] | null {
  const parts = splitStudyPath(text);
  if (!parts.complete) return null;
  return sectionCitations(text, parts.stages.map((s) => s.body), citations);
}
