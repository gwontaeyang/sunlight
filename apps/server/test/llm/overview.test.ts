import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { readMockOutput } from '@study-paper/shared/mock-outputs';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { readOverview, startOverviewRows } from '../../src/overview/store';
import { startupRecovery } from '../../src/startupRecovery';
import { events, makeRunEnv, terminalOf } from './runEnv';

it('attaches by request id, persists grounded results, and keeps the old overview through failed regeneration', async () => {
  const good = readMockOutput('paper_overview');
  const mock = new MockLlmAdapter({ chunkChars: 200, chunkDelayMs: 0, outputs: { paper_overview: [good, 'incomplete', good] } });
  const env = await makeRunEnv({ adapter: mock });
  const paperId = SEED_PAPER_ID;
  const input = (regenerate = false) => ({
    task: 'paper_overview' as const, paperId, clientRequestId: randomUUID(),
    inputs: { answerLanguage: 'ko' }, identity: { route: 'overview.generate', paperId, regenerate }, startRows: startOverviewRows(paperId, regenerate),
  });
  const get = () => readOverview(env.db, paperId);
  try {
    const req = input();
    const run = env.manager.runTask(req);
    expect(get().pending).toEqual({ runId: run.runId, clientRequestId: req.clientRequestId, regenerate: false });
    expect(() => env.manager.runTask(input())).toThrow(/being generated/);
    const attached = env.manager.runTask(req);
    expect(attached.runId).toBe(run.runId);
    const stream = await events(attached);
    expect(stream.filter(e => e.event === 'run.delta').length).toBeGreaterThan(1);
    const terminal = terminalOf(stream);
    expect(terminal).toMatchObject([{ event: 'run.done', data: { citations: Array.from({ length: 3 }, () => ({ kind: 'quote', status: 'verbatim' })) } }]);
    expect(stream.find(e => e.event === 'run.started')).toMatchObject({ data: { model: 'sonnet', effort: 'medium' } });
    const saved = get();
    expect(saved).toMatchObject({ pending: null, result: { runId: run.runId, text: good } });
    const restarted = env.restart();
    expect(terminalOf(await events(restarted.runTask(req)))).toEqual(terminal);
    expect(() => restarted.runTask(input())).toThrow(/already has/);
    expect(terminalOf(await events(restarted.runTask(input(true))))).toMatchObject([{ event: 'run.error', data: { code: 'parse_failed' } }]);
    expect(get()).toEqual(saved);
    const replacement = restarted.runTask(input(true));
    expect(terminalOf(await events(replacement))[0]?.event).toBe('run.done');
    expect(terminalOf(await events(restarted.runTask(req)))).toMatchObject([{ event: 'run.error', data: { code: 'superseded' } }]);
    expect(get().result?.runId).toBe(replacement.runId);
    expect(mock.requests).toHaveLength(3);
  } finally { env.close(); }
});

it('represents upload quotations as unchecked, clears interrupted reservations, and cascades on paper deletion', async () => {
  const env = await makeRunEnv({ adapter: new MockLlmAdapter({ chunkDelayMs: 0 }) });
  const paperId = SEED_PAPER_ID;
  try {
    env.sqlite.prepare("UPDATE papers SET source='upload', structureSource='pdf-inferred' WHERE id=?").run(paperId);
    const stream = await events(env.manager.runTask({ task: 'paper_overview', paperId, clientRequestId: randomUUID(), inputs: {},
      startRows: startOverviewRows(paperId, false) }));
    expect(terminalOf(stream)).toMatchObject([{ event: 'run.done', data: { citations: Array.from({ length: 3 }, () => ({ status: 'unchecked' })) } }]);
    const saved = readOverview(env.db, paperId);
    env.db.transaction(tx => startOverviewRows(paperId, true).insert(tx, randomUUID()));
    startupRecovery(env.sqlite, env.paths);
    expect(readOverview(env.db, paperId)).toEqual(saved);
    env.db.transaction(tx => startOverviewRows(paperId, true).insert(tx, randomUUID()));
    env.sqlite.prepare('DELETE FROM papers WHERE id=?').run(paperId);
    expect(readOverview(env.db, paperId)).toEqual({ pending: null, result: null });
  } finally { env.close(); }
});
