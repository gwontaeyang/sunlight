import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import type { LlmRunRequest } from '../../src/llm/adapter';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { parseSelectionQuestions } from '../../src/study/selectionQuestions';
import { events, makeRunEnv } from './runEnv';

const selection = 'fixed threshold of 0.5 m';
const card = { type: 'definition', frontMd: 'What is the threshold?', backMd: '0.5 m', evidence: '0.5 m' };

function input() {
  return { clientRequestId: randomUUID(), paperId: SEED_PAPER_ID, task: 'selection_questions' as const,
    inputs: { selection, page: '1', answerLanguage: 'en' }, reviewSelection: { page: 1, start: 10, quote: { exact: selection } } };
}

it('requires 1–3 distinct questions with evidence copied from the submitted selection', () => {
  const parse = (cards: unknown[]) => parseSelectionQuestions(JSON.stringify({ cards }), selection);
  expect(parse([card])).toEqual({ cards: [card] });
  for (const bad of [[], [card, card], [card, card, card, card], [{ ...card, evidence: '0.6 m' }], [{ ...card, evidence: ' ' }], [{ ...card, backMd: '' }]]) expect(parse(bad)).toBeNull();
  expect(parseSelectionQuestions('not JSON', selection)).toBeNull();
});

it('passes only the selection to Sonnet, validates the native structured result, and replays after restart', async () => {
  let seen: LlmRunRequest | undefined;
  const fixture = JSON.stringify({ cards: [card] });
  const mock = new MockLlmAdapter({ chunkDelayMs: 0, outputs: { selection_questions: fixture } });
  const env = await makeRunEnv({ adapter: { mode: 'mock', health: () => mock.health(), async *run(req) {
    seen = req;
    for await (const e of mock.run(req)) yield e.type === 'result' ? { ...e, text: 'CLI status text' } : e;
  } } });
  try {
    const request = input();
    const first = env.manager.runTask(request);
    const initial = (await events(first)).at(-1);
    expect(seen).toMatchObject({ model: 'sonnet', effort: 'low', prefix: [], jsonSchema: { type: 'object' } });
    expect(seen?.tail).toHaveLength(1);
    expect(seen?.tail[0]).toMatchObject({ type: 'text', text: expect.stringContaining(selection) });
    expect(initial).toMatchObject({ event: 'run.done', data: { text: fixture, citations: [], parsed: null } });
    const replay = (await events(env.restart().runTask(request))).at(-1);
    expect(replay).toEqual(initial);
    env.sqlite.prepare('UPDATE papers SET deletingAt=? WHERE id=?').run(Date.now(), SEED_PAPER_ID);
    expect((await events(env.manager.runTask(request))).at(-1)).toMatchObject({ event: 'run.error', data: { code: 'result_deleted' } });
    expect(mock.requests).toHaveLength(1);
  } finally { env.close(); }
});

it('finishes with parse_failed for unsupported evidence and stores neither preview nor cards', async () => {
  const mock = new MockLlmAdapter({ chunkDelayMs: 0, outputs: { selection_questions: JSON.stringify({ cards: [{ ...card, evidence: '0.8 m' }] }) } });
  const env = await makeRunEnv({ adapter: mock });
  try {
    const run = env.manager.runTask(input());
    expect((await events(run)).at(-1)).toMatchObject({ event: 'run.error', data: { code: 'parse_failed' } });
    expect(env.sqlite.prepare('SELECT resultRaw FROM llm_calls WHERE runId=?').get(run.runId)).toEqual({ resultRaw: null });
    expect(env.sqlite.prepare('SELECT count(*) AS n FROM review_cards WHERE llmCallId=?').get(run.runId)).toEqual({ n: 0 });
  } finally { env.close(); }
});

it('accepts a schema response over the production CLI adapter with an offline stand-in executable', async () => {
  const fixture = JSON.stringify({ cards: [card] });
  const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_STRUCTURED: fixture } });
  try {
    const log = await events(env.manager.runTask(input()));
    expect(env.pids).toHaveLength(1);
    expect(log.at(-1)).toMatchObject({ event: 'run.done', data: { text: fixture, citations: [] } });
  } finally { env.close(); }
});
