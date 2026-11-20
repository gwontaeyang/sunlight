// M1 run contract (review M6, M17) — written at S0, active from the M1 gate. Owner: supervisor.
// B makes these pass in M1 (runManager, idempotent clientRequestId, message ↔ run link). It runs with no variable
// (GATED_MILESTONE is past M1): npx vitest run apps/server/test/contract/m1.gate.test.ts — SP_GATE_MILESTONE can only
// raise the gate (helpers/gate.ts), so a value of 1 no longer changes anything here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_SCHEMAS } from '@study-paper/shared/contracts/api';
import { gateMilestone } from '../helpers/gate';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { startTestServer, type TestServer } from '../helpers/server';

const gate = gateMilestone();

describe.skipIf(gate < 1)('M1 run contract', () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer({ env: 'prod', seed: true, llm: new MockLlmAdapter({ chunkDelayMs: 5 }) });
  });
  afterAll(async () => {
    await s.close();
  });
  const json = { 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) => s.req(`/api${path}`, { method: 'POST', headers: { 'X-SP-Token': s.token, ...json }, body: JSON.stringify(body) });
  const get = (path: string) => s.req(`/api${path}`, { headers: { 'X-SP-Token': s.token } });
  const events = (text: string): SseEvent[] =>
    text
      .split('\n\n')
      .filter((f) => f.trim())
      .map((f) => parseSseEvent(/^event: (.*)$/m.exec(f)![1]!, JSON.parse(/^data: (.*)$/m.exec(f)![1]!)));
  const accepted = (ev: SseEvent[]) => {
    const e = ev[0]!;
    if (e.event !== 'run.accepted') throw new Error(`first event is ${e.event}`);
    return e.data;
  };
  const count = (table: string, where = '1=1', ...args: unknown[]) => (s.deps.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;
  const explain = (clientRequestId: string, text = 'robust kernel') => post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text, clientRequestId });

  it('the assistant message is linked to its run (llmCallId = run.accepted.runId)', async () => {
    const a = accepted(events((await explain(crypto.randomUUID())).text));
    const detail = API_SCHEMAS['threads.get'].response.parse(JSON.parse((await get(`/threads/${a.threadId}`)).text));
    const assistant = detail.messages.find((m) => m.id === a.messageId)!;
    expect(assistant).toMatchObject({ role: 'assistant', status: 'complete', llmCallId: a.runId });
    const run = API_SCHEMAS['llm.runs.get'].response.parse(JSON.parse((await get(`/llm/runs/${a.runId}`)).text));
    expect(run).toMatchObject({ runId: a.runId, status: 'ok', threadId: a.threadId });
  });

  it('a repeated clientRequestId attaches to the finished run instead of starting a second one', async () => {
    const id = crypto.randomUUID();
    const first = events((await explain(id)).text);
    const again = await explain(id);
    expect(again.status).toBe(200);
    const second = events(again.text);
    expect(accepted(second)).toEqual(accepted(first));
    expect(second.at(-1)!.event).toBe('run.done');
    expect(count('llm_calls', 'clientRequestId = ?', id)).toBe(1);
    expect(count('threads', 'id = ?', accepted(first).threadId)).toBe(1);
    expect(count('messages', 'threadId = ?', accepted(first).threadId)).toBe(2);
  });

  it('two concurrent requests with one clientRequestId share one run; each stream gets one terminal event', async () => {
    const id = crypto.randomUUID();
    const [a, b] = (await Promise.all([explain(id), explain(id)])).map((r) => events(r.text));
    expect(accepted(a!).runId).toBe(accepted(b!).runId);
    for (const ev of [a!, b!]) expect(ev.filter((e) => e.event === 'run.done' || e.event === 'run.error').length).toBe(1);
    expect(count('llm_calls', 'clientRequestId = ?', id)).toBe(1);
  });

  it('the same clientRequestId with a different payload is a conflict', async () => {
    const id = crypto.randomUUID();
    await explain(id, 'first selection');
    const r = await explain(id, 'another selection');
    expect(r.status).toBe(409);
    expect(JSON.parse(r.text)).toMatchObject({ error: { code: 'conflict' } });
  });

  it('cancel: unknown run → 404, finished run → 204 and nothing changes', async () => {
    expect((await post('/llm/runs/00000000-0000-4000-8000-00000000dead/cancel', {})).status).toBe(404);
    const a = accepted(events((await explain(crypto.randomUUID())).text));
    expect((await post(`/llm/runs/${a.runId}/cancel`, {})).status).toBe(204);
    expect(count('llm_calls', `runId = ? AND status = 'ok'`, a.runId)).toBe(1);
  });
});
