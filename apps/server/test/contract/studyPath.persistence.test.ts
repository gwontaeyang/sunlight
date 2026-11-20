import { randomUUID } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { openSqlite } from '../../src/db/client';
import { DEFAULT_MIGRATIONS_FOLDER, migrateWithBackup } from '../../src/db/migrate';
import { readSettings } from '../../src/byok/settings';
import { llmCalls, papers } from '../../src/db/schema';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { checkStudyPath, commitStudyPath, failStudyPath, readStudyPath, startStudyPathRows } from '../../src/studyPath/store';
import { tempDir } from '../helpers/tmp';
import { sseEvents } from '../routes/threads.cases';
import { ControlledAdapter, startTestServer } from '../helpers/server';

it('serializes generation, retains a checked lesson through failure and restart, and rejects stale writes', async () => {
  let server = await startTestServer({ env: 'test', seed: true });
  const paperId = SEED_PAPER_ID;
  const start = (regenerate: boolean) => {
    const runId = randomUUID();
    const clientRequestId = randomUUID();
    server.deps.db.transaction((tx) => {
      startStudyPathRows(paperId, regenerate, 'cpp17').insert(tx, runId);
      tx.insert(llmCalls).values({ paperId, runId, clientRequestId, task: 'study_path', status: 'running',
        model: 'opus', effort: 'high', acceptedAt: Date.now() }).run();
    });
    return { runId, clientRequestId };
  };
  const commit = (runId: string, text: string, n: number) => server.deps.db.transaction((tx) => {
    const stale = commitStudyPath(tx, paperId, runId, text, [], n);
    if (stale !== null) tx.update(llmCalls).set({ status: 'ok' }).where(eq(llmCalls.runId, runId)).run();
    return stale;
  });
  const get = () => readStudyPath(server.deps.db, paperId);
  try {
    const first = start(false);
    expect(get().pending).toEqual({ ...first, regenerate: false, codeLanguage: 'cpp17' });
    expect(() => start(true)).toThrow(/being generated/);
    expect(commit(first.runId, 'first', 2)).toEqual([]);
    expect(() => start(false)).toThrow(/already has/);
    expect(checkStudyPath(server.deps.db, paperId, first.runId, 1, true).result?.checked).toEqual([false, true]);
    const saved = get().result;
    const failed = start(true);
    expect(get().result).toEqual(saved);
    server.deps.db.transaction((tx) => failStudyPath(tx, paperId, failed.runId));
    expect(get()).toEqual({ pending: null, result: saved });
    expect(commit(failed.runId, 'late', 1)).toBe(null);

    const crashed = start(true);
    server = await server.restart();
    expect(get()).toEqual({ pending: null, result: saved });
    expect(server.deps.sqlite.prepare('SELECT status FROM llm_calls WHERE runId=?').get(crashed.runId)).toEqual({ status: 'interrupted' });
    const second = start(true);
    expect(commit(second.runId, 'second', 1)).toEqual([first.runId]);
    expect(get().result?.checked).toEqual([false]);
    expect(server.deps.sqlite.prepare('SELECT errorCode FROM llm_calls WHERE runId=?').get(first.runId)).toEqual({ errorCode: 'superseded' });
    expect(() => checkStudyPath(server.deps.db, paperId, first.runId, 0, true)).toThrow(/changed/);
    expect(() => checkStudyPath(server.deps.db, paperId, second.runId, 1, true)).toThrow(/unknown checklist/);

    const racing = start(true);
    server.deps.db.update(papers).set({ deletingAt: Date.now() }).where(eq(papers.id, paperId)).run();
    expect(commit(racing.runId, 'late deletion', 1)).toBe(null);
    expect(() => checkStudyPath(server.deps.db, paperId, second.runId, 0, true)).toThrow();
    server.deps.db.delete(papers).where(eq(papers.id, paperId)).run();
    expect(get()).toEqual({ result: null, pending: null });
  } finally { await server.close(); }
});

it('upgrades a populated BYOK database once and keeps its pre-study backup readable', async () => {
  const root = tempDir();
  const historical = join(root, 'byok');
  cpSync(DEFAULT_MIGRATIONS_FOLDER, historical, { recursive: true });
  const journalPath = join(historical, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.slice(0, 4);
  writeFileSync(journalPath, JSON.stringify(journal));
  const sqlite = openSqlite(join(root, 'data.sqlite'));
  const backupsDir = join(root, 'backups');
  try {
    await migrateWithBackup(sqlite, { backupsDir, migrationsFolder: historical });
    sqlite.prepare("INSERT INTO settings(key,valueJson) VALUES('llm.backend',?), ('llm.economy','true')").run('"api"');
    sqlite.prepare("INSERT INTO llm_calls(runId,task,model,effort,status,acceptedAt) VALUES(?, 'chat','fable','low','ok',1)").run('historical');
    const migration = await migrateWithBackup(sqlite, { backupsDir });
    expect(migration.applied).toEqual(['0004_study_path']);
    expect(sqlite.prepare('SELECT count(*) AS n FROM study_paths').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT runId,model FROM llm_calls').all()).toEqual([{ runId: 'historical', model: 'fable' }]);
    expect(readSettings(sqlite)).toMatchObject({ 'llm.backend': 'api', 'llm.economy': true, 'study.codeLanguage': 'cpp17', 'llm.answerLanguage': 'ko' });
    expect((await migrateWithBackup(sqlite, { backupsDir })).applied).toEqual([]);
    const saved = openSqlite(migration.backupPath!, { readonly: true });
    try {
      expect(saved.prepare("SELECT name FROM sqlite_schema WHERE name='study_paths'").get()).toBeUndefined();
      expect(saved.prepare('SELECT runId FROM llm_calls').all()).toEqual([{ runId: 'historical' }]);
    } finally { saved.close(); }
  } finally { sqlite.close(); }
});

it('attaches the same request, refuses another during regeneration, and keeps the prior result when cancellation races the model', async () => {
  const adapter = new ControlledAdapter();
  const server = await startTestServer({ env: 'test', seed: true, llm: adapter });
  const path = '/api/papers/' + SEED_PAPER_ID + '/study-path';
  const call = (method: string, url: string, body?: unknown) => server.req(url, {
    method, headers: { 'X-SP-Token': server.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const generate = (body: unknown) => call('POST', path + '/generate', body);
  const get = async () => JSON.parse((await call('GET', path)).text);
  const first = { clientRequestId: randomUUID() };
  const second = { clientRequestId: randomUUID(), regenerate: true };
  const hold = adapter.holdCall(2, { ignoreAbort: true, lateResult: true });
  try {
    expect(sseEvents((await generate(first)).text).at(-1)?.event).toBe('run.done');
    const previous = await get();
    const running = generate(second);
    await hold.started;
    const active = await get();
    expect(active).toMatchObject({ result: previous.result, pending: { clientRequestId: second.clientRequestId, regenerate: true } });
    const duplicate = generate(second);
    const refused = await generate({ clientRequestId: randomUUID(), regenerate: true });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.text)).toMatchObject({ error: { details: { reason: 'study_path_generating', runId: active.pending.runId } } });
    expect((await call('POST', '/api/llm/runs/' + active.pending.runId + '/cancel', {})).status).toBe(204);
    hold.release();
    for (const r of await Promise.all([running, duplicate])) {
      const events = sseEvents(r.text);
      expect(events[0]).toMatchObject({ event: 'run.accepted', data: { runId: active.pending.runId } });
      expect(events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
    }
    expect(await get()).toEqual(previous);
    expect(adapter.calls).toHaveLength(2);
    expect(sseEvents((await generate({ clientRequestId: randomUUID(), regenerate: true })).text).at(-1)?.event).toBe('run.done');
    expect(sseEvents((await generate(first)).text).at(-1)).toMatchObject({ event: 'run.error', data: { code: 'superseded' } });
    expect(adapter.calls).toHaveLength(3);
  } finally { hold.release(); await server.close(); }
});
