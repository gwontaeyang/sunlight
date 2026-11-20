// B-F2-02: a run that has written its terminal (result committed, or parse_failed) but whose adapter iterator has not
// ended yet is still in the active set. A resend of the same request id in that window is an attach to a FINISHED run:
// it answers exactly what the same resend answers once the adapter has ended (run.done / parse_failed), never the
// "result gone" answer of B-CX-1 (whose card check needs status 'generating', which a committed card no longer has).
// Both through runTask and through the routes' findExisting probe (the one decision, existingHandle). Owner B.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import { readMockFile, readMockManifest } from '@study-paper/shared/mock-outputs';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { PROMPT_VERSION } from '../../src/llm/runManager';
import type { RunTaskInput } from '../../src/llm/runContract';
import { startCardRows } from '../../src/study/paperCards';
import { GateAdapter } from './gateAdapter';
import { events, makeRunEnv, request, terminalOf, threadRows, type RunEnv } from './runEnv';

const INVALID = readMockFile(readMockManifest().m2.blocksInvalid.notation_missing_key!.file);

const cardInput = (): RunTaskInput => ({
  task: 'notation_card',
  clientRequestId: randomUUID(),
  paperId: SEED_PAPER_ID,
  inputs: {},
  identity: { route: 'cards.generate', paperId: SEED_PAPER_ID, kind: 'notation' },
  startRows: startCardRows(SEED_PAPER_ID, 'notation', PROMPT_VERSION),
});
const messageInput = (): RunTaskInput => request({ clientRequestId: randomUUID(), identity: { route: 'test.explain' }, startRows: threadRows() });

const callRow = (env: RunEnv, runId: string) => env.sqlite.prepare(`SELECT status, errorCode FROM llm_calls WHERE runId = ?`).get(runId) as { status: string; errorCode: string | null };
const cardRows = (env: RunEnv) => env.sqlite.prepare(`SELECT status, errorCode FROM paper_cards WHERE llmCallId IS NOT NULL`).all() as { status: string; errorCode: string | null }[];

/** Runs `input` with its call `holdCall` held after its result; resends the id in the window, then after the end. */
async function windowAndAfter(input: RunTaskInput, o: { outputs?: string[]; holdCall: number }) {
  const llm = new GateAdapter();
  if (o.outputs) llm.queueOutputs(...o.outputs);
  const hold = llm.holdAfterResult(o.holdCall);
  const env = await makeRunEnv({ adapter: llm });
  const h = env.manager.runTask(input);
  const first = events(h);
  await hold.resulted; // the result was handled: the terminal is written, the adapter has not ended
  const inWindow = { row: callRow(env, h.runId), cards: cardRows(env) };
  const viaRunTask = events(env.manager.runTask(input));
  const viaProbe = events(env.manager.runs.findExisting({ clientRequestId: input.clientRequestId, paperId: SEED_PAPER_ID, identity: input.identity! })!);
  hold.release();
  const initial = await first;
  const windowRunTask = await viaRunTask;
  const windowProbe = await viaProbe;
  await h.done;
  const afterRunTask = await events(env.manager.runTask(input));
  const afterProbe = await events(env.manager.runs.findExisting({ clientRequestId: input.clientRequestId, paperId: SEED_PAPER_ID, identity: input.identity! })!);
  return { env, llm, runId: h.runId, inWindow, initial, windowRunTask, windowProbe, afterRunTask, afterProbe };
}

const sameAnswer = (r: { initial: RunSseEvent[]; windowRunTask: RunSseEvent[]; windowProbe: RunSseEvent[]; afterRunTask: RunSseEvent[]; afterProbe: RunSseEvent[] }) => {
  // a resend in the window answers exactly what the same resend answers once the adapter has ended
  expect(r.windowRunTask).toEqual(r.afterRunTask);
  expect(r.windowProbe).toEqual(r.afterProbe);
  expect(terminalOf(r.windowRunTask)).toEqual(terminalOf(r.initial));
  expect(terminalOf(r.windowProbe)).toEqual(terminalOf(r.initial));
  for (const ev of [r.windowRunTask, r.windowProbe]) expect(ev.filter((e) => e.event === 'run.error' && e.data.code === 'result_deleted')).toEqual([]);
};

describe('a resend while a run that already wrote its terminal is still active = the answer after it ended (B-F2-02)', () => {
  it('card stored (complete): run.done in the window, not result_deleted', async () => {
    const r = await windowAndAfter(cardInput(), { holdCall: 1 });
    expect(r.inWindow).toEqual({ row: { status: 'ok', errorCode: null }, cards: [{ status: 'complete', errorCode: null }] });
    expect(terminalOf(r.initial).map((e) => e.event)).toEqual(['run.done']);
    sameAnswer(r);
    expect(r.llm.calls).toHaveLength(1);
    r.env.close();
  });

  it('card parse_failed (invalid twice, the repair call held): parse_failed in the window, not result_deleted', async () => {
    const r = await windowAndAfter(cardInput(), { outputs: [INVALID, INVALID], holdCall: 2 });
    expect(r.inWindow.cards).toEqual([{ status: 'parse_failed', errorCode: 'parse_failed' }]);
    expect(terminalOf(r.initial)).toEqual([expect.objectContaining({ event: 'run.error', data: expect.objectContaining({ code: 'parse_failed' }) })]);
    sameAnswer(r);
    expect(r.llm.calls).toHaveLength(2);
    r.env.close();
  });

  it('message stored (guard — the message owner check already passed): run.done in the window', async () => {
    const r = await windowAndAfter(messageInput(), { holdCall: 1 });
    expect(r.inWindow.row).toEqual({ status: 'ok', errorCode: null });
    expect(terminalOf(r.initial).map((e) => e.event)).toEqual(['run.done']);
    sameAnswer(r);
    r.env.close();
  });

  it('the terminal written, then the paper tombstoned in the window: the same answer as after the end (the finished-run rule)', async () => {
    const llm = new GateAdapter();
    const hold = llm.holdAfterResult(1);
    const env = await makeRunEnv({ adapter: llm });
    const input = cardInput();
    const h = env.manager.runTask(input);
    const first = events(h);
    await hold.resulted;
    env.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(Date.now(), SEED_PAPER_ID);
    const inWindow = await events(env.manager.runTask(input)); // a finished run whose result is gone → the DB replay (static)
    hold.release();
    await first;
    await h.done;
    const after = await events(env.manager.runTask(input));
    expect(inWindow).toEqual(after);
    expect(terminalOf(after)).toEqual([expect.objectContaining({ event: 'run.error', data: expect.objectContaining({ code: 'result_deleted' }) })]);
    env.close();
  });
});
