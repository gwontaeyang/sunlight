import { describe, expect, it } from 'vitest';
import { studyProgress } from '../../src/study/studyProgress';

describe('study progress from streamed guide text', () => {
  it('stays at zero while waiting or when only a heading has arrived', () => {
    for (const text of ['', '##', '## 1\n']) {
      expect(studyProgress(text)).toEqual({ completed: 0, percent: 0 });
    }
  });

  it('counts the parsed stages with a body and rounds sevenths to integer percentages', () => {
    let text = '';
    for (const [i, percent] of [14, 29, 43, 57, 71, 86].entries()) {
      text += `## ${i + 1}\nParagraph ${i + 1}.\n`;
      expect(studyProgress(text)).toEqual({ completed: i + 1, percent });
      expect(studyProgress(text + `## ${i + 2}\n`)).toEqual({ completed: i + 1, percent });
    }
  });

  it('ignores headings quoted inside a code example', () => {
    const text = ['## 1', 'A literal example:', '```python', '## 2', 'print(2)', '```'].join('\n');
    expect(studyProgress(text)).toEqual({ completed: 1, percent: 14 });
  });

  it('requires the sixth-stage checklist and seventh-stage content to show 100%', () => {
    const prefix = Array.from({ length: 6 }, (_, i) => `## ${i + 1}\nparagraph\n`).join('');
    expect(studyProgress(prefix + '## 7\nreading')).toEqual({ completed: 6, percent: 86 });
    expect(studyProgress(prefix + '- [ ] compare\n## 7\n')).toEqual({ completed: 6, percent: 86 });
    expect(studyProgress(prefix + '- [ ] compare\n## 7\nreading')).toEqual({ completed: 7, percent: 100 });
  });
});
