// Startup recovery, M2 parts ①–④ (BRIEF_S S5). Owner: supervisor. B's glossary.define.replay relies on ④.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { RESULT_RAW_RETENTION_MS } from '../../src/resultRetention';
import { startupRecovery } from '../../src/startupRecovery';
import { makeTestPng } from '../helpers/png';
import { startTestServer, type TestServer } from '../helpers/server';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function server() {
  const s = await startTestServer({ env: 'prod', seed: true });
  servers.push(s);
  return s;
}
const all = (s: TestServer, sql: string, ...a: unknown[]) => s.deps.sqlite.prepare(sql).all(...a);
const run = (s: TestServer, sql: string, ...a: unknown[]) => s.deps.sqlite.prepare(sql).run(...a);

describe('startupRecovery M2', () => {
  it('① a pendingReplace turn (user + assistant, citations) is deleted before streaming → interrupted; the old turn stays', async () => {
    const s = await server();
    run(s, `INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t', ?, 'chat', 'x', 1, 1)`, SEED_PAPER_ID);
    run(s, `INSERT INTO messages (id, threadId, role, contentMd, status, createdAt) VALUES ('u1','t','user','q','complete',1), ('a1','t','assistant','old <q>robust kernel</q>','complete',2)`);
    run(s, `INSERT INTO messages (id, threadId, role, contentMd, status, pendingReplace, createdAt) VALUES ('u2','t','user','q again','complete',1,3), ('a2','t','assistant','new <q>x</q>','streaming',1,4)`);
    run(s, `INSERT INTO messages (id, threadId, role, contentMd, status, createdAt) VALUES ('a3','t','assistant','other stream','streaming',5)`);
    run(s, `INSERT INTO citations (id, ownerType, ownerId, ordinal, kind, quote, status, score) VALUES ('c1','message','a1',1,'quote','robust kernel','verbatim',1), ('c2','message','a2',1,'quote','x','not_found',0)`);
    const oldTurn = all(s, `SELECT * FROM messages WHERE id IN ('u1','a1') ORDER BY id`);
    const r = startupRecovery(s.deps.sqlite, s.deps.paths);
    expect(r.pendingReplaceMessages).toBe(2);
    expect(r.messages).toBe(1); // only a3 — the pending streaming message was deleted first, not marked interrupted
    expect(all(s, `SELECT id, status FROM messages WHERE threadId='t' ORDER BY createdAt`)).toEqual([
      { id: 'u1', status: 'complete' },
      { id: 'a1', status: 'complete' },
      { id: 'a3', status: 'interrupted' },
    ]);
    expect(all(s, `SELECT * FROM messages WHERE id IN ('u1','a1') ORDER BY id`)).toEqual(oldTurn);
    expect(all(s, `SELECT id FROM citations WHERE id IN ('c1','c2')`)).toEqual([{ id: 'c1' }]);
  });

  it('② capture rows nothing references and PNGs without a row are deleted; referenced ones stay', async () => {
    const s = await server();
    const png = makeTestPng({ width: 10, height: 10 });
    const dir = s.deps.paths.capturesDir(SEED_PAPER_ID);
    mkdirSync(dir, { recursive: true });
    const mk = (id: string, withRow: boolean) => {
      writeFileSync(join(dir, `${id}.png`), png);
      if (withRow) run(s, `INSERT INTO files (id, paperId, kind, relPath, sha256, bytes, mime, createdAt) VALUES (?, ?, 'capture', ?, 'x', ?, 'image/png', 1)`, id, SEED_PAPER_ID, `papers/${SEED_PAPER_ID}/captures/${id}.png`, png.length);
    };
    for (const [id, row] of [['thread-ref', true], ['highlight-ref', true], ['orphan-row', true], ['no-row', false]] as const) mk(id, row);
    run(s, `INSERT INTO threads (id, paperId, kind, title, imageFileId, createdAt, updatedAt) VALUES ('ft', ?, 'figure', 'x', 'thread-ref', 1, 1)`, SEED_PAPER_ID);
    run(s, `INSERT INTO highlights (id, paperId, kind, color, page, rectsJson, imageFileId, createdAt, updatedAt) VALUES ('h', ?, 'area', 1, 1, '[]', 'highlight-ref', 1, 1)`, SEED_PAPER_ID);
    const r = startupRecovery(s.deps.sqlite, s.deps.paths);
    expect(r.orphanCaptureRows).toBe(1);
    expect(r.orphanCaptureFiles).toBe(1);
    expect(all(s, `SELECT id FROM files WHERE kind='capture' ORDER BY id`)).toEqual([{ id: 'highlight-ref' }, { id: 'thread-ref' }]);
    for (const [id, kept] of [['thread-ref', true], ['highlight-ref', true], ['orphan-row', false], ['no-row', false]] as const) expect(existsSync(join(dir, `${id}.png`)), id).toBe(kept);
    // pdf / html / supplement rows are untouched
    expect((all(s, `SELECT count(*) AS n FROM files WHERE kind != 'capture'`)[0] as { n: number }).n).toBe(3);
  });

  it('③ a running upgrade_structure job → interrupted; papers.ingestStatus is not changed by it', async () => {
    const s = await server();
    run(s, `INSERT INTO jobs (id, kind, paperId, status, stepsJson, createdAt, updatedAt) VALUES ('j', 'upgrade_structure', ?, 'running', '[{"step":"html","status":"running"}]', 1, 1)`, SEED_PAPER_ID);
    const before = all(s, `SELECT ingestStatus, updatedAt FROM papers WHERE id = ?`, SEED_PAPER_ID);
    const r = startupRecovery(s.deps.sqlite, s.deps.paths);
    expect(r.jobs).toBe(1);
    expect(r.papersIngest).toBe(0);
    expect(all(s, `SELECT status, stepsJson FROM jobs WHERE id='j'`)).toEqual([{ status: 'interrupted', stepsJson: JSON.stringify([{ step: 'html', status: 'error', detail: 'interrupted' }]) }]);
    expect(all(s, `SELECT ingestStatus, updatedAt FROM papers WHERE id = ?`, SEED_PAPER_ID)).toEqual(before);
  });

  it('④ resultRaw: 30-day boundary (−1 ms kept / exactly / +1 ms cleared), paperId NULL and tombstoned papers cleared; rows and other columns stay', async () => {
    const s = await server();
    const now = Date.UTC(2026, 5, 1);
    const ins = (runId: string, paperId: string | null, finishedAt: number | null) =>
      run(s, `INSERT INTO llm_calls (runId, task, paperId, model, effort, status, acceptedAt, finishedAt, resultRaw) VALUES (?, 'glossary_define', ?, 'opus', 'low', 'ok', 1, ?, 'raw')`, runId, paperId, finishedAt);
    ins('keep', SEED_PAPER_ID, now - RESULT_RAW_RETENTION_MS + 1);
    ins('exact', SEED_PAPER_ID, now - RESULT_RAW_RETENTION_MS);
    ins('older', SEED_PAPER_ID, now - RESULT_RAW_RETENTION_MS - 1);
    ins('nopaper', null, now);
    ins('nofinish', SEED_PAPER_ID, null);
    // A second paper being deleted (tombstone): its rows lose their paper in the same transaction.
    run(s, `INSERT INTO papers (id, source, title, ingestStatus, deletingAt, createdAt, updatedAt) VALUES ('tomb','arxiv','T','done',1,1,1)`);
    ins('tombrun', 'tomb', now);
    const cols = () => all(s, `SELECT runId, task, model, effort, status, acceptedAt, finishedAt FROM llm_calls ORDER BY runId`);
    const before = cols();
    const r = startupRecovery(s.deps.sqlite, s.deps.paths, now);
    expect(r.resultRawCleared).toBe(5);
    expect(all(s, `SELECT runId, resultRaw FROM llm_calls ORDER BY runId`)).toEqual([
      { runId: 'exact', resultRaw: null },
      { runId: 'keep', resultRaw: 'raw' },
      { runId: 'nofinish', resultRaw: null },
      { runId: 'nopaper', resultRaw: null },
      { runId: 'older', resultRaw: null },
      { runId: 'tombrun', resultRaw: null },
    ]);
    expect(cols()).toEqual(before);
  });
});
