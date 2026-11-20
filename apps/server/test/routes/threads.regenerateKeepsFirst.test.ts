// A first-turn regenerate of a thread made WITHOUT a question (explain · figure · equation) runs without <question>
// (B-I10-02). The new first user message it stores must stay the replaced one — the selection or the kind's fixed
// label — not the client's body.text. Otherwise a text that differs (the web's fallback: the thread title = first
// 80 chars of the selection, or '다시 생성'; or a direct API call) turns the thread into one "with a question": the
// next follow-up sends it as <turn role="user" trust="user"> and the next first-turn regenerate as
// <question trust="user"> — paper text raised to user trust (review B-F3R2-01). Owner B.
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
const LONG = 'The covariance is propagated with a first-order Jacobian and the method runs at 10 Hz on a single CPU core without a GPU.';
const userTurns = (text: string) => {
  const h = /<history>\n([\s\S]*?)\n<\/history>/.exec(text)?.[1] ?? '';
  return [...h.matchAll(/<turn role="user" trust="user">([\s\S]*?)<\/turn>/g)].map((m) => m[1]!);
};
const hasQuestion = (text: string) => /<question trust="user">/.test(text);

async function detail(tid: string) {
  return JSON.parse((await s.req(`/api/threads/${tid}`, { headers: { 'X-SP-Token': s.token } })).text) as ThreadDetailResponse;
}
async function create(body: Record<string, unknown>) {
  const r = await post(`/papers/${SEED_M2_PAPER_ID}/threads`, { ...body, clientRequestId: randomUUID() });
  expect(r.status).toBe(200);
  expect(r.text).toContain('event: run.done');
  const tid = /"threadId":"([^"]+)"/.exec(r.text)![1]!;
  const d = await detail(tid);
  return { tid, title: d.thread.title, firstUser: d.messages[0]!.contentMd };
}
async function ask(tid: string, text: string, regenerate = false) {
  const r = await post(`/threads/${tid}/messages`, { text, ...(regenerate ? { regenerate: true } : {}), clientRequestId: randomUUID() });
  expect(r.status).toBe(200);
  expect(r.text).toContain('event: run.done');
  return lastTask();
}

describe('first-turn regenerate of a question-less thread keeps the replaced first user message', () => {
  it('explain: regenerate with text = the thread title (web fallback) → first message stays the selection', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const { tid, title, firstUser } = await create({ kind: 'explain', text: LONG });
    expect(firstUser).toBe(LONG);
    expect(title).not.toBe(LONG); // 80-char title, not the selection
    const g1 = await ask(tid, title, true);
    expect(g1.task).toBe('explain_selection');
    expect(hasQuestion(g1.text)).toBe(false);
    const d1 = await detail(tid);
    expect(d1.messages.map((m) => [m.role, m.contentMd === '' ? '' : m.role === 'user' ? m.contentMd : 'answer'])).toEqual([
      ['user', LONG],
      ['assistant', 'answer'],
    ]);
    // a second first-turn regenerate, echoing the stored first message like the web: still no question
    const g2 = await ask(tid, d1.messages[0]!.contentMd, true);
    expect(g2.task).toBe('explain_selection');
    expect(hasQuestion(g2.text)).toBe(false);
    // a follow-up: the selection is not a user turn
    const t = await ask(tid, 'why?');
    expect(t.task).toBe('chat');
    expect(userTurns(t.text)).toEqual([]);
    expect(t.text).toContain('<question trust="user">why?</question>');
  });

  it('explain: regenerate with any other text (direct API call) → same', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const { tid } = await create({ kind: 'explain', text: LONG });
    expect(hasQuestion((await ask(tid, '다시 생성', true)).text)).toBe(false);
    expect((await detail(tid)).messages[0]!.contentMd).toBe(LONG);
    expect(hasQuestion((await ask(tid, '다시 생성', true)).text)).toBe(false);
    expect(userTurns((await ask(tid, 'why?')).text)).toEqual([]);
  });

  it('figure and equation: regenerate with "다시 생성" → the fixed label stays, no question later', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const fig = await create({ kind: 'figure', anchor: AREA, imagePng: makeTestPngBase64({ width: 40, height: 30 }) });
    expect(fig.firstUser).toBe('그림·표 설명');
    const f1 = await ask(fig.tid, '다시 생성', true);
    expect(f1.task).toBe('figure_area');
    expect(hasQuestion(f1.text)).toBe(false);
    const fd = await detail(fig.tid);
    expect(fd.messages[0]!.contentMd).toBe('그림·표 설명');
    expect(hasQuestion((await ask(fig.tid, fd.messages[0]!.contentMd, true)).text)).toBe(false);
    expect(userTurns((await ask(fig.tid, 'axis?')).text)).toEqual([]);

    const eq = s.deps.sqlite.prepare(`SELECT id FROM equations WHERE paperId = ? AND number = '2'`).get(SEED_M2_PAPER_ID) as { id: string };
    const eqT = await create({ kind: 'equation', equationId: eq.id });
    expect(eqT.firstUser).toBe('식 (2)');
    expect(hasQuestion((await ask(eqT.tid, '다시 생성', true)).text)).toBe(false);
    expect((await detail(eqT.tid)).messages[0]!.contentMd).toBe('식 (2)');
    expect(hasQuestion((await ask(eqT.tid, '다시 생성', true)).text)).toBe(false);
    expect(userTurns((await ask(eqT.tid, 'why squared?')).text)).toEqual([]);
  });

  it('a thread made with a question: a first-turn regenerate still stores and sends body.text (unchanged)', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const { tid } = await create({ kind: 'explain', text: LONG, question: '왜 1차?' });
    const g = await ask(tid, '왜 1차?', true);
    expect(g.task).toBe('explain_selection');
    expect(g.text).toContain('<question trust="user">왜 1차?</question>');
    expect((await detail(tid)).messages[0]!.contentMd).toBe('왜 1차?');
    expect(userTurns((await ask(tid, 'and?')).text)).toEqual(['왜 1차?']);
  });
});
