// Contract: effort/model resolution lives in contracts/tasks.ts (PLAN_M2 D12, 3.7). Owner: supervisor (S1).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEEP_MODEL,
  DEFAULT_PAPER_MODEL,
  LlmErrorCode,
  REPAIR_MIN_REMAINING_MS,
  TASK_SPECS,
  TaskId,
  resolveEffort,
  resolveModel,
  supportsDeep,
} from '@study-paper/shared/contracts/tasks';
import * as runManager from '../../src/llm/runManager';

// Expected effort per task: [default, deep:true]. deep only changes tasks with a deepEffort (chat).
const EXPECTED: Record<TaskId, [string, string]> = {
  explain_selection: ['low', 'low'],
  chat: ['low', 'high'],
  translate_selection: ['low', 'low'],
  figure_area: ['medium', 'medium'],
  summary: ['medium', 'medium'],
  equation_deep: ['high', 'high'],
  notation_card: ['high', 'high'],
  assumptions_card: ['high', 'high'],
  glossary_define: ['low', 'low'],
  cards_from_highlights: ['high', 'high'],
  explain_back_grade: ['high', 'high'],
  pdf_metadata: ['low', 'low'],
};

describe('contracts/tasks: resolveEffort / resolveModel / supportsDeep', () => {
  it('resolveEffort table: every task × deep absent / false / true', () => {
    for (const task of TaskId.options) {
      const [def, deep] = EXPECTED[task];
      expect(resolveEffort(task), task).toBe(def);
      expect(resolveEffort(task, {}), task).toBe(def);
      expect(resolveEffort(task, { deep: false }), task).toBe(def);
      expect(resolveEffort(task, { deep: true }), task).toBe(deep);
    }
  });

  it('chat defaults to low and deep is high; explain and translate do not support deep', () => {
    expect(TASK_SPECS.chat.effort).toBe('low');
    expect(TASK_SPECS.chat.deepEffort).toBe('high');
    expect(supportsDeep('chat')).toBe(true);
    for (const task of TaskId.options.filter((t) => t !== 'chat')) expect(supportsDeep(task), task).toBe(false);
  });

  it('resolveModel maps the roles to the default aliases', () => {
    expect(resolveModel('chat')).toBe(DEFAULT_PAPER_MODEL);
    expect(DEFAULT_DEEP_MODEL).toBe('opus');
    for (const task of ['equation_deep', 'notation_card', 'assumptions_card', 'explain_back_grade'] as const) {
      expect(resolveModel(task), task).toBe(DEFAULT_DEEP_MODEL);
    }
    expect(TaskId.options.filter((task) => resolveModel(task) === 'fable')).toEqual([]);
    expect(resolveModel('translate_selection')).toBe('sonnet');
    expect(resolveModel('pdf_metadata')).toBe('haiku');
  });

  it('runManager re-exports the contract functions (no second implementation)', () => {
    expect(runManager.resolveEffort).toBe(resolveEffort);
    expect(runManager.resolveModel).toBe(resolveModel);
  });

  it('M2 error codes and repair window', () => {
    for (const c of ['result_deleted', 'budget_exhausted', 'ledger_locked'] as const) expect(LlmErrorCode.options).toContain(c);
    expect(REPAIR_MIN_REMAINING_MS).toBe(120_000);
  });
});
