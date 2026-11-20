// The first user message of a thread made WITHOUT a question (explain · figure · equation) is the selection (paper
// text) or the kind's fixed label, not the user's own words. Later turns must not send it in <history> as
// <turn role="user" trust="user"> (review B-F3R1-02, same kind as B-I10-02): the selection already goes as
// <selection trust="paper">, and the fixed label carries nothing. Every other turn — also a later user message that
// repeats the selection, and the first message of a thread made with a question — stays in the history. Owner B.
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
/** The <turn> lines of the task block's <history>, in order. */
const historyTurns = (text: string) => {
  const h = /<history>\n([\s\S]*?)\n<\/history>/.exec(text)?.[1] ?? '';
  return [...h.matchAll(/<turn role="(user|assistant)" trust="(user|model)">([\s\S]*?)<\/turn>/g)].map((m) => ({ role: m[1]!, trust: m[2]!, text: m[3]! }));
};
const userTurns = (text: string) => historyTurns(text).filter((t) => t.role === 'user').map((t) => t.text);

async function create(body: Record<string, unknown>) {
  const r = await post(`/papers/${SEED_M2_PAPER_ID}/threads`, { ...body, clientRequestId: randomUUID() });
  expect(r.status).toBe(200);
  expect(r.text).toContain('event: run.done');
  const tid = /"threadId":"([^"]+)"/.exec(r.text)![1]!;
  const detail = JSON.parse((await s.req(`/api/threads/${tid}`, { headers: { 'X-SP-Token': s.token } })).text) as ThreadDetailResponse;
  return { tid, firstUser: detail.messages[0]!.contentMd };
}
async function ask(tid: string, text: string, regenerate = false) {
  const r = await post(`/threads/${tid}/messages`, { text, ...(regenerate ? { regenerate: true } : {}), clientRequestId: randomUUID() });
  expect(r.status).toBe(200);
  expect(r.text).toContain('event: run.done');
  return lastTask();
}

describe('follow-up history: the first user message of a question-less thread is not a user turn', () => {
  it('explain: the selection goes only as <selection trust="paper">; later user turns stay', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const { tid, firstUser } = await create({ kind: 'explain', text: SELECTION });
    expect(firstUser).toBe(SELECTION);
    const t1 = await ask(tid, 'why?');
    expect(t1.task).toBe('chat');
    expect(userTurns(t1.text)).toEqual([]);
    expect(historyTurns(t1.text).map((t) => [t.role, t.trust])).toEqual([['assistant', 'model']]);
    expect(t1.text).toContain(`<selection trust="paper">${SELECTION}</selection>`);
    expect(t1.text).toContain('<question trust="user">why?</question>');
    // a later user message that repeats the selection is the user's own words: kept
    const t2 = await ask(tid, SELECTION);
    expect(userTurns(t2.text)).toEqual(['why?']);
    const t3 = await ask(tid, 'more?');
    expect(userTurns(t3.text)).toEqual(['why?', SELECTION]);
    expect(historyTurns(t3.text).filter((t) => t.role === 'user').every((t) => t.trust === 'user')).toBe(true);
    // regenerating a later turn: same history rule
    const t4 = await ask(tid, 'more?', true);
    expect(t4.task).toBe('chat');
    expect(userTurns(t4.text)).toEqual(['why?', SELECTION]);
  });

  it('explain: after a first-turn regenerate, follow-ups still leave the selection out', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const { tid, firstUser } = await create({ kind: 'explain', text: SELECTION });
    expect((await ask(tid, firstUser, true)).task).toBe('explain_selection');
    const t = await ask(tid, 'why?');
    expect(userTurns(t.text)).toEqual([]);
    expect(historyTurns(t.text)).toHaveLength(1);
  });

  it('figure and equation: the fixed label is not a user turn', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const fig = await create({ kind: 'figure', anchor: AREA, imagePng: makeTestPngBase64({ width: 40, height: 30 }) });
    expect(fig.firstUser).toBe('그림·표 설명');
    expect(userTurns((await ask(fig.tid, 'axis?')).text)).toEqual([]);
    const eq = s.deps.sqlite.prepare(`SELECT id FROM equations WHERE paperId = ? AND number = '2'`).get(SEED_M2_PAPER_ID) as { id: string };
    const byId = await create({ kind: 'equation', equationId: eq.id });
    expect(byId.firstUser).toBe('식 (2)');
    expect(userTurns((await ask(byId.tid, 'why squared?')).text)).toEqual([]);
    const byCapture = await create({ kind: 'equation', anchor: AREA, imagePng: makeTestPngBase64({ width: 30, height: 20 }) });
    expect(byCapture.firstUser).toBe('수식 깊이 읽기');
    const t = await ask(byCapture.tid, 'why?');
    expect(userTurns(t.text)).toEqual([]);
    expect(historyTurns(t.text).map((x) => x.role)).toEqual(['assistant']);
  });

  it('a thread made with a question keeps its first user message in the history (unchanged)', async () => {
    llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    const explain = await create({ kind: 'explain', text: SELECTION, question: '왜 1차 Jacobian인가?' });
    expect(userTurns((await ask(explain.tid, 'and?')).text)).toEqual(['왜 1차 Jacobian인가?']);
    // a short question is also the thread's title: still the user's words
    const fig = await create({ kind: 'figure', anchor: AREA, imagePng: makeTestPngBase64({ width: 40, height: 30 }), question: '무엇?' });
    expect(userTurns((await ask(fig.tid, 'and?')).text)).toEqual(['무엇?']);
    const eq = s.deps.sqlite.prepare(`SELECT id FROM equations WHERE paperId = ? AND number = '2'`).get(SEED_M2_PAPER_ID) as { id: string };
    const eqT = await create({ kind: 'equation', equationId: eq.id, question: '왜 제곱?' });
    expect(userTurns((await ask(eqT.tid, 'and?')).text)).toEqual(['왜 제곱?']);
    // a chat thread: its first message is always a question
    const chat = await create({ kind: 'chat', question: 'chat' });
    expect(chat.firstUser).toBe('chat');
    expect(userTurns((await ask(chat.tid, 'and?')).text)).toEqual(['chat']);
  });
});
