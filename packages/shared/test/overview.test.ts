import { describe, expect, it } from 'vitest';
import { readMockFile, readMockOutput } from '../src/mockOutputs';
import { overviewCitations, splitOverview } from '../src/overview';
import { parseAnswer } from '../src/markup/parseAnswer';
import type { Citation } from '../src/contracts/domain';

const text = readMockOutput('paper_overview');
const citations: Citation[] = parseAnswer(text, { final: true }).citations.map(raw => ({ ...raw, status: 'unchecked', score: 0 }));

describe('five-section overview', () => {
  it('accepts both languages and restricts each paper claim to a cited paragraph', () => {
    expect(splitOverview(text)).toHaveLength(5);
    expect(splitOverview(readMockFile('paper_overview.en.md'))).toHaveLength(5);
    for (const bad of [text.replace('## 4', '## 3'), text.replace('## 5', 'Appendix'), text + 'more', text.replace(/<q>.*?<\/q>/, ''),
      text.replace(/^.*?\[\[N\]\]$/m, '[[N]]'), text.replace('[[P]]', '[[N]]'), text.replace('## 1', '## 1\n' + 'x'.repeat(721))]) expect(splitOverview(bad)).toBeNull();
  });
  it('pairs each section to its own citation and rejects a mismatched DB citation', () => {
    expect(overviewCitations(text, citations)?.map(section => section.map(c => c.ordinal))).toEqual([[1], [1], [1], [], []]);
    expect(overviewCitations(text, citations.slice(1))).toBeNull();
    expect(overviewCitations(text, citations.map(c => ({ ...c, quote: 'some other result' })))).toBeNull();
  });
});
