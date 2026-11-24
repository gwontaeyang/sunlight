// Contract: per-task repair window (PLAN_M2 3.4 "시간", 9절 40 — supervisor decision S-1). Owner: supervisor.
import { describe, expect, it } from 'vitest';
import {
  REPAIR_MIN_REMAINING_MS,
  TASK_SPECS,
  TaskId,
  repairMinRemainingMs,
} from '@study-paper/shared/contracts/tasks';

// Expected minimum remaining time per task = min(120 s, floor(totalMs / 2)), written out so a change of totalMs
// or of the rule shows up here.
const EXPECTED: Record<TaskId, number> = {
  explain_selection: 60_000,
  chat: 120_000,
  translate_selection: 30_000,
  figure_area: 90_000,
  summary: 120_000,
  equation_deep: 120_000,
  notation_card: 120_000,
  assumptions_card: 120_000,
  glossary_define: 60_000,
  selection_questions: 45_000,
  cards_from_highlights: 120_000,
  explain_back_grade: 120_000,
  paper_overview: 60_000,
  study_path: 120_000,
  pdf_metadata: 30_000,
};

describe('contracts/tasks: repairMinRemainingMs (S-1)', () => {
  it('value table per task', () => {
    for (const task of TaskId.options) expect(repairMinRemainingMs(task), task).toBe(EXPECTED[task]);
  });

  it('glossary_define is 60 s; the cards keep 120 s; the constant stays the 120 s upper bound', () => {
    expect(repairMinRemainingMs('glossary_define')).toBe(60_000);
    expect(repairMinRemainingMs('notation_card')).toBe(120_000);
    expect(repairMinRemainingMs('assumptions_card')).toBe(120_000);
    expect(REPAIR_MIN_REMAINING_MS).toBe(120_000);
    for (const task of TaskId.options) expect(repairMinRemainingMs(task), task).toBeLessThanOrEqual(REPAIR_MIN_REMAINING_MS);
  });

  it('equals min(REPAIR_MIN_REMAINING_MS, floor(totalMs / 2)) for every task', () => {
    for (const task of TaskId.options) {
      expect(repairMinRemainingMs(task), task).toBe(Math.min(REPAIR_MIN_REMAINING_MS, Math.floor(TASK_SPECS[task].totalMs / 2)));
    }
  });

  it('every SP-Blocks task of milestone <= 2 can reach a repair: repairMinRemainingMs < totalMs', () => {
    const blocks = TaskId.options.filter((t) => TASK_SPECS[t].milestone <= 2 && TASK_SPECS[t].output === 'sp-blocks');
    // notation_card, assumptions_card, glossary_define — an empty filter would make the check vacuous.
    expect(blocks.sort()).toEqual(['assumptions_card', 'glossary_define', 'notation_card']);
    for (const task of blocks) expect(repairMinRemainingMs(task), task).toBeLessThan(TASK_SPECS[task].totalMs);
  });
});
