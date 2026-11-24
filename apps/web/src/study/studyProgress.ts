import { splitStudyPath } from '@study-paper/shared/study-path';

const totalStages = 7;

export function studyProgress(text: string): { completed: number; percent: number } {
  const parts = splitStudyPath(text);
  // The parser includes a trailing heading before its body arrives. Count the
  // consecutive stages with material to read. Reserve 100% for a complete guide.
  const empty = parts.stages.findIndex(stage => stage.body.length === 0);
  const written = empty < 0 ? parts.stages.length : empty;
  const completed = parts.complete ? totalStages : Math.min(written, totalStages - 1);
  return { completed, percent: Math.round(completed * 100 / totalStages) };
}
