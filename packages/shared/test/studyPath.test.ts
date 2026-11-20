import { describe, expect, it } from 'vitest';
import { hasStudyExamples, splitStudyPath, studyPathCitations } from '../src/studyPath';
import { readMockOutput } from '../src/mockOutputs';
import { parseAnswer } from '../src/markup/parseAnswer';
import type { Citation } from '../src/contracts/domain';

const example = readMockOutput('study_path');
const stored: Citation[] = parseAnswer(example, { final: true }).citations.map((raw) => ({
  ...raw, score: 1, status: raw.kind === 'quote' ? 'verbatim' : 'resolved',
}));

describe('study path stage boundaries', () => {
  it('reads complete steps, selected-language examples, ordered checks and source references', () => {
    const result = splitStudyPath(example);
    expect(result.complete).toBe(true);
    expect(result.stages.map(s => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.checklist).toHaveLength(2);
    expect(result.referenceOrdinals).toEqual([1]);
    expect(result.stages[5]!.body).not.toContain('- [ ]');
    expect(hasStudyExamples(result.stages[4]!.body, 'cpp17')).toBe(true);
    expect(hasStudyExamples(result.stages[4]!.body, 'python')).toBe(false);
    expect(hasStudyExamples('```cpp\nint main() {}', 'cpp17')).toBe(false);
  });
  it('shows streaming sections; rejects skipped, repeated, missing or oversized data', () => {
    const partial = splitStudyPath(example.split('## 3')[0]!);
    expect(partial.complete).toBe(false);
    expect(partial.stages.map(s => s.number)).toEqual([1, 2]);
    for (const bad of [example.replace('## 2','## 3'), example.replace('## 2','## 1'), example.replaceAll('- [ ]','-'), example + 'x'.repeat(64_001)]) {
      expect(splitStudyPath(bad).complete).toBe(false);
    }
  });
  it('treats heading and action-shaped strings in fenced code as literal text', () => {
    const withCode = example.replace('## 6\n', '## 6\n\n```text\n## 7\n- [ ] bogus\n- [ref:999]\n```\n');
    const result = splitStudyPath(withCode);
    expect(result.complete).toBe(true);
    expect(result.checklist).toHaveLength(2);
    expect(result.referenceOrdinals).toEqual([1]);
  });
  it('reindexes only after global pairing and drops every chip on count/content mismatch', () => {
    const grouped = studyPathCitations(example, stored)!;
    expect(grouped).toHaveLength(7);
    expect(grouped[2]).toEqual([{ ...stored[0], ordinal: 1 }]);
    expect(grouped[3]).toEqual([{ ...stored[1], ordinal: 1 }]);
    expect(studyPathCitations(example, stored.slice(1))).toBeNull();
    expect(studyPathCitations(example, [{ ...stored[0]!, quote: 'another source' }, stored[1]!])).toBeNull();
    expect(studyPathCitations(example.replace('- [ ] 반경', '- [ ] <q>borrowed</q> 반경'), stored)).toBeNull();
  });
});
