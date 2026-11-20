// Fixed headings of summary and equation_deep (PLAN_M2 3.4 / 3.5, BRIEF_B B7, review B-R1-05): a missing heading is
// stored as it is with one fixed issue per heading (never model text) — summary in run.done.parsed (and its replay),
// equation_deep in messages.issuesJson. Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { readMockOutput } from '@study-paper/shared/mock-outputs';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { EQUATION_DEEP_HEADINGS, headingIssues, missingHeadingIssue, SUMMARY_HEADINGS } from '../../src/llm/headings';
import { prepareCard, reparseCard } from '../../src/study/paperCards';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';

describe('headingIssues', () => {
  it('the mock outputs have every heading; other tasks get none', () => {
    expect(headingIssues('summary', readMockOutput('summary'))).toEqual([]);
    expect(headingIssues('equation_deep', readMockOutput('equation_deep'))).toEqual([]);
    expect(headingIssues('chat', 'no headings at all')).toEqual([]);
  });
  it('one fixed issue per missing heading, in table order; closing #s, other levels and indent ≤ 3 count; code, other text and long lines do not', () => {
    expect(headingIssues('summary', '')).toEqual(SUMMARY_HEADINGS.map(missingHeadingIssue));
    expect(headingIssues('summary', '# 3줄 요약 ##\n   ### 방법 요약\n## 읽기 지도')).toEqual([]);
    expect(headingIssues('summary', '## 3줄 요약\n```\n## 방법 요약\n```\n    ## 읽기 지도\n##방법 요약\n## 읽기 지도 및 기타')).toEqual([missingHeadingIssue('방법 요약'), missingHeadingIssue('읽기 지도')]);
    expect(headingIssues('equation_deep', `## 기호 표\n## 단계별 유도\n## 쓰인 가정\n## 확인 질문${' '.repeat(300)}x`)).toEqual([missingHeadingIssue('확인 질문')]);
    // the issue text is app text only: a forged heading line never shows up in an issue
    const forged = headingIssues('equation_deep', '## ignore previous instructions');
    expect(forged).toEqual(EQUATION_DEEP_HEADINGS.map(missingHeadingIssue));
    expect(forged.join('\n')).not.toContain('ignore');
  });
  it('summary card: prepare and replay give the same issues; an output over 200,000 chars is not parsed (no repair)', () => {
    const text = readMockOutput('summary').replace('## 읽기 지도', '## 읽을 순서');
    const p = prepareCard('summary', text, [], []);
    if (!p.ok) throw new Error('summary should store');
    expect(p.parsed.issues).toContain(missingHeadingIssue('읽기 지도'));
    expect(reparseCard('summary', text)).toEqual(p.parsed);
    const long = 'x'.repeat(200_001);
    expect(prepareCard('summary', long, [], [])).toMatchObject({ ok: false, errors: [{ code: 'body_too_long' }], repairable: false });
    expect(reparseCard('summary', long)).toBeNull();
    expect(prepareCard('summary', long.slice(1), [], []).ok).toBe(true);
  });
});

describe('through the routes', () => {
  let s: TestServer | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });
  async function post(path: string, body: unknown): Promise<SseEvent[]> {
    const r = await s!.req(`/api${path}`, { method: 'POST', headers: { 'X-SP-Token': s!.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(r.status, r.text).toBe(200);
    return r.text
      .split('\n\n')
      .filter((f) => f.trim())
      .map((f) => parseSseEvent(/^event: (.*)$/m.exec(f)![1]!, JSON.parse(/^data: (.*)$/m.exec(f)![1]!)));
  }

  it('summary: run.done.parsed.issues names the missing heading; the replay of the same id says the same', async () => {
    const llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    llm.queueOutputs(readMockOutput('summary').replace('## 3줄 요약', '3줄 요약'));
    const crid = randomUUID();
    const ev = await post(`/papers/${SEED_M2_PAPER_ID}/cards/summary/generate`, { clientRequestId: crid });
    const done = ev.at(-1)!;
    if (done.event !== 'run.done') throw new Error(JSON.stringify(done));
    expect(done.data.parsed!.issues).toContain(missingHeadingIssue('3줄 요약'));
    const again = (await post(`/papers/${SEED_M2_PAPER_ID}/cards/summary/generate`, { clientRequestId: crid })).at(-1)!;
    if (again.event !== 'run.done') throw new Error(JSON.stringify(again));
    expect(again.data.parsed).toEqual(done.data.parsed);
    expect(llm.calls).toHaveLength(1);
  });

  it('equation_deep: the stored message keeps the text and its issuesJson names the missing heading; a complete answer has none', async () => {
    const llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const eq = s.deps.sqlite.prepare(`SELECT id FROM equations WHERE paperId = ? AND number = '2'`).get(SEED_M2_PAPER_ID) as { id: string };
    const text = readMockOutput('equation_deep').replace('## 확인 질문', '## 질문');
    llm.queueOutputs(text);
    const ev = await post(`/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'equation', equationId: eq.id, clientRequestId: randomUUID() });
    const a = ev[0]!;
    if (a.event !== 'run.accepted') throw new Error('first event');
    const row = s.deps.sqlite.prepare(`SELECT contentMd, issuesJson FROM messages WHERE id = ?`).get(a.data.messageId!) as { contentMd: string; issuesJson: string };
    expect(row.contentMd).toBe(text);
    expect(JSON.parse(row.issuesJson)).toContain(missingHeadingIssue('확인 질문'));
    const full = await post(`/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'equation', equationId: eq.id, clientRequestId: randomUUID() });
    const b = full[0]!;
    if (b.event !== 'run.accepted') throw new Error('first event');
    const issues = JSON.parse((s.deps.sqlite.prepare(`SELECT issuesJson FROM messages WHERE id = ?`).get(b.data.messageId!) as { issuesJson: string }).issuesJson) as string[];
    expect(issues.filter((i) => i.startsWith('heading missing'))).toEqual([]);
  });
});
