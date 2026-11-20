// Effort per run (PLAN_M2 3.7, D12, D31): resolveEffort(task, {deep}) once → llm_calls.effort, the adapter request and
// run.started carry the same value; deep is part of the identity only when true. Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import { resolveEffort, supportsDeep, TASK_SPECS, type TaskId } from '@study-paper/shared/contracts/tasks';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { HttpError } from '../../src/deps';
import { createIdentity, messageIdentity } from '../../src/routes/threads';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';
import { events, makeRunEnv, request } from './runEnv';

const started = (ev: RunSseEvent[]) => (ev.find((e) => e.event === 'run.started') as Extract<RunSseEvent, { event: 'run.started' }>).data.effort;

describe('three places, one value', () => {
  const cases: [TaskId, boolean | undefined][] = [
    ['chat', undefined],
    ['chat', false],
    ['chat', true],
    ['explain_selection', undefined],
    ['explain_selection', true], // the route refuses this; the run owner still never raises an unsupported task
    ['figure_area', undefined],
    ['translate_selection', undefined],
    ['summary', undefined],
  ];
  it.each(cases)('%s with deep=%s', async (task, deep) => {
    const llm = new ControlledAdapter();
    const env = await makeRunEnv({ adapter: llm });
    const h = env.manager.runTask(request({ inputs: task === 'chat' ? { question: 'q' } : { selection: 'We estimate the robot pose' }, ...(deep !== undefined ? { deep } : {}) }, task));
    const ev = await events(h);
    const want = resolveEffort(task, { deep: deep === true });
    expect(want).toBe(deep === true && supportsDeep(task) ? TASK_SPECS[task].deepEffort : TASK_SPECS[task].effort);
    expect(started(ev)).toBe(want);
    expect(llm.calls[0]!.effort).toBe(want);
    expect(env.sqlite.prepare(`SELECT effort FROM llm_calls WHERE runId = ?`).get(h.runId)).toEqual({ effort: want });
    env.close();
  });
  it('chat: low by default, high with deep', () => {
    expect([resolveEffort('chat'), resolveEffort('chat', { deep: true })]).toEqual(['low', 'high']);
  });
});

describe('identity: deep is a key only when true (D31)', () => {
  it('createIdentity / messageIdentity: absent = false, true differs', () => {
    const body = { kind: 'chat' as const, question: 'q' };
    expect(createIdentity(SEED_PAPER_ID, { ...body, deep: false }, 'q')).toEqual(createIdentity(SEED_PAPER_ID, body, 'q'));
    expect(createIdentity(SEED_PAPER_ID, { ...body, deep: true }, 'q')).not.toEqual(createIdentity(SEED_PAPER_ID, body, 'q'));
    expect('deep' in createIdentity(SEED_PAPER_ID, { ...body, deep: false }, 'q')).toBe(false);
    expect(messageIdentity('t', { text: 'x', deep: false })).toEqual(messageIdentity('t', { text: 'x' }));
    expect(messageIdentity('t', { text: 'x', deep: true })).toEqual({ ...messageIdentity('t', { text: 'x' }), deep: true });
  });
  it('run owner: the same id with deep:false ↔ absent → the same run; deep:true ↔ absent → 409', async () => {
    const llm = new ControlledAdapter();
    const env = await makeRunEnv({ adapter: llm });
    const crid = randomUUID();
    const body = { kind: 'chat' as const, question: 'q' };
    const first = env.manager.runTask(request({ clientRequestId: crid, inputs: { question: 'q' }, identity: createIdentity(SEED_PAPER_ID, body, 'q') }, 'chat'));
    await events(first);
    const same = env.manager.runTask(request({ clientRequestId: crid, inputs: { question: 'q' }, deep: false, identity: createIdentity(SEED_PAPER_ID, { ...body, deep: false }, 'q') }, 'chat'));
    expect(same.runId).toBe(first.runId);
    expect(() => env.manager.runTask(request({ clientRequestId: crid, inputs: { question: 'q' }, deep: true, identity: createIdentity(SEED_PAPER_ID, { ...body, deep: true }, 'q') }, 'chat'))).toThrow(HttpError);
    expect(llm.calls).toHaveLength(1);
    env.close();
  });
});

describe('routes: deep where the task is chat, 400 elsewhere, regenerate inherits', () => {
  let s: TestServer;
  afterEach(async () => {
    await s?.close();
  });
  const post = async (path: string, body: unknown) => {
    const r = await s.req(`/api${path}`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, text: r.text };
  };
  const effortOf = (text: string) => /"effort":"(low|medium|high)"/.exec(text)?.[1];
  const threadOf = (text: string) => /"threadId":"([^"]+)"/.exec(text)![1]!;
  it('explain / equation thread follow-ups with deep → high; explain create, translate with deep → 400; regenerate + deep → 400; regenerate of a deep turn → high', async () => {
    s = await startTestServer({ env: 'prod', papers: ['m1'], llm: new ControlledAdapter() });
    const P = `/papers/${SEED_PAPER_ID}/threads`;
    expect((await post(P, { kind: 'explain', text: 'robust kernel', deep: true, clientRequestId: randomUUID() })).status).toBe(400);
    expect((await post(P, { kind: 'translate', text: 'robust kernel', deep: true, clientRequestId: randomUUID() })).status).toBe(400);
    const explain = await post(P, { kind: 'explain', text: 'robust kernel', clientRequestId: randomUUID() });
    expect(effortOf(explain.text)).toBe('low');
    const tid = threadOf(explain.text);
    const follow = await post(`/threads/${tid}/messages`, { text: 'why?', deep: true, clientRequestId: randomUUID() });
    expect(effortOf(follow.text)).toBe('high');
    expect((await post(`/threads/${tid}/messages`, { text: 'why?', regenerate: true, deep: true, clientRequestId: randomUUID() })).status).toBe(400);
    expect(effortOf((await post(`/threads/${tid}/messages`, { text: 'why?', regenerate: true, clientRequestId: randomUUID() })).text)).toBe('high');
    const plain = await post(`/threads/${tid}/messages`, { text: 'and?', clientRequestId: randomUUID() });
    expect(effortOf(plain.text)).toBe('low');
    expect(effortOf((await post(`/threads/${tid}/messages`, { text: 'and?', regenerate: true, clientRequestId: randomUUID() })).text)).toBe('low');
    // an equation thread's follow-up
    const eqId = (s.deps.sqlite.prepare(`SELECT id FROM equations WHERE paperId = ? AND number = '1'`).get(SEED_PAPER_ID) as { id: string }).id;
    const eqThread = await post(P, { kind: 'equation', equationId: eqId, clientRequestId: randomUUID() });
    expect(effortOf(eqThread.text)).toBe(TASK_SPECS.equation_deep.effort);
    expect(effortOf((await post(`/threads/${threadOf(eqThread.text)}/messages`, { text: 'deeper', deep: true, clientRequestId: randomUUID() })).text)).toBe('high');
    // regenerate of the explain thread's FIRST turn re-runs explain_selection (no deep)
    const explain2 = await post(P, { kind: 'explain', text: 'robust kernel', clientRequestId: randomUUID() });
    const regenFirst = await post(`/threads/${threadOf(explain2.text)}/messages`, { text: 'robust kernel', regenerate: true, clientRequestId: randomUUID() });
    expect(regenFirst.text).toContain('"task":"explain_selection"');
    expect(effortOf(regenFirst.text)).toBe('low');
  });
});
