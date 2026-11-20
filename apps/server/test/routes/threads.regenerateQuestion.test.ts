// Regenerating the first turn of a thread made WITHOUT a question (explain · figure · equation) re-runs the first
// request as it was: no <question trust="user"> block — the stored user message of such a turn is the selection
// (paper text) or the kind's fixed label, which must not reach the model as a user question (review B-I10-02,
// coordinator notes 추가 지시 8 B 3). A thread made WITH a question keeps it, also when the question is short enough
// to be the thread's title too. The web sends the stored user message text as the regenerate `text`. Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThreadDetailResponse } from '@study-paper/shared/contracts/api';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { makeTestPngBase64 } from '../helpers/png';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';

let s: TestServer;
let llm: ControlledAdapter;
afterEach(async () => {
  await s?.close();
});
async function post(path: string, body: unknown) {
  return s.req(`/api${path}`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const lastTask = () => {
  const t = llm.calls.at(-1)!.tail.at(-1)!;
  if (t.type !== 'text') throw new Error('not text');
  return { task: llm.calls.at(-1)!.task, text: t.text };
};
const AREA = { kind: 'area' as const, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.3 }] };
const SELECTION = 'propagated with a first-order Jacobian';
const QUESTION_RE = /<question trust="user">([\s\S]*?)<\/question>/;

/** Creates the thread, then regenerates its first turn like the web (text = the stored user message). */
async function createThenRegenerate(body: Record<string, unknown>) {
  const r = await post(`/papers/${SEED_M2_PAPER_ID}/threads`, { ...body, clientRequestId: randomUUID() });
  expect(r.status).toBe(200);
  expect(r.text).toContain('event: run.done');
  const first = lastTask();
  const tid = /"threadId":"([^"]+)"/.exec(r.text)![1]!;
  const detail = JSON.parse((await s.req(`/api/threads/${tid}`, { headers: { 'X-SP-Token': s.token } })).text) as ThreadDetailResponse;
  const userText = detail.messages[0]!.contentMd;
  const g = await post(`/threads/${tid}/messages`, { text: userText, regenerate: true, clientRequestId: randomUUID() });
  expect(g.status).toBe(200);
  expect(g.text).toContain('event: run.done');
  return { first, regen: lastTask(), userText, title: detail.thread.title };
}

describe('first-turn regenerate: a question-less thread gets no <question>; a thread with a question keeps it', () => {
  it('explain', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const none = await createThenRegenerate({ kind: 'explain', text: SELECTION });
    expect(none.userText).toBe(SELECTION);
    expect(none.regen.task).toBe('explain_selection');
    expect(none.first.text).not.toMatch(QUESTION_RE);
    expect(none.regen.text).not.toMatch(QUESTION_RE);
    expect(none.regen.text).toContain(`<selection trust="paper">${SELECTION}</selection>`);
    for (const question of ['왜 1차 Jacobian인가?', `이 부분을 길게 설명해 주세요 ${'x'.repeat(90)}`]) {
      const asked = await createThenRegenerate({ kind: 'explain', text: SELECTION, question });
      expect(asked.regen.task).toBe('explain_selection');
      expect(QUESTION_RE.exec(asked.first.text)?.[1]).toBe(question);
      expect(QUESTION_RE.exec(asked.regen.text)?.[1]).toBe(question);
    }
  });

  it('figure', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const png = makeTestPngBase64({ width: 40, height: 30 });
    const none = await createThenRegenerate({ kind: 'figure', anchor: AREA, imagePng: png });
    expect(none.userText).toBe('그림·표 설명');
    expect(none.regen.task).toBe('figure_area');
    expect(none.first.text).not.toMatch(QUESTION_RE);
    expect(none.regen.text).not.toMatch(QUESTION_RE);
    // a short question is also the thread's title: still a question
    const asked = await createThenRegenerate({ kind: 'figure', anchor: AREA, imagePng: png, question: '무엇?' });
    expect([asked.userText, asked.title]).toEqual(['무엇?', '무엇?']);
    expect(QUESTION_RE.exec(asked.regen.text)?.[1]).toBe('무엇?');
  });

  it('equation (by equationId and by capture)', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const eq = s.deps.sqlite.prepare(`SELECT id FROM equations WHERE paperId = ? AND number = '2'`).get(SEED_M2_PAPER_ID) as { id: string };
    const byId = await createThenRegenerate({ kind: 'equation', equationId: eq.id });
    expect(byId.userText).toBe('식 (2)');
    expect(byId.regen.task).toBe('equation_deep');
    expect(byId.first.text).not.toMatch(QUESTION_RE);
    expect(byId.regen.text).not.toMatch(QUESTION_RE);
    const byCapture = await createThenRegenerate({ kind: 'equation', anchor: AREA, imagePng: makeTestPngBase64({ width: 30, height: 20 }) });
    expect(byCapture.userText).toBe('수식 깊이 읽기');
    expect(byCapture.regen.text).not.toMatch(QUESTION_RE);
    const asked = await createThenRegenerate({ kind: 'equation', equationId: eq.id, question: '왜 제곱?' });
    expect([asked.userText, asked.title]).toEqual(['왜 제곱?', '왜 제곱?']);
    expect(QUESTION_RE.exec(asked.regen.text)?.[1]).toBe('왜 제곱?');
  });

  it('a later turn of a question-less thread is a chat turn with its question (unchanged)', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const r = await post(`/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'explain', text: SELECTION, clientRequestId: randomUUID() });
    const tid = /"threadId":"([^"]+)"/.exec(r.text)![1]!;
    await post(`/threads/${tid}/messages`, { text: SELECTION, clientRequestId: randomUUID() }); // a follow-up that repeats the selection
    expect(lastTask().task).toBe('chat');
    expect(QUESTION_RE.exec(lastTask().text)?.[1]).toBe(SELECTION);
    await post(`/threads/${tid}/messages`, { text: SELECTION, regenerate: true, clientRequestId: randomUUID() });
    expect(lastTask().task).toBe('chat');
    expect(QUESTION_RE.exec(lastTask().text)?.[1]).toBe(SELECTION);
  });
});
