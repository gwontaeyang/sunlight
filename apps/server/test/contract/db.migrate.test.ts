import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/db/client';
import { DEFAULT_MIGRATIONS_FOLDER, migrateWithBackup, pendingMigrations } from '../../src/db/migrate';
import { migrationsWithExtra } from '../helpers/migrations';
import { tempDir } from '../helpers/tmp';

const EXPECTED_TABLES = [
  'api_charges', 'citations', 'collections', 'equations', 'explain_backs', 'figures', 'files', 'glossary_terms', 'highlights', 'http_cache', 'jobs',
  'llm_calls', 'messages', 'notes', 'page_texts', 'paper_card_items', 'paper_cards', 'paper_references', 'papers', 'reading_progress',
  'review_cards', 'review_logs', 'sections', 'settings', 'study_paths', 'threads',
];
const EXPECTED_TRIGGERS = [
  'citations_owner_exists_bi', 'citations_owner_explain_backs_ad', 'citations_owner_fixed_bu', 'citations_owner_glossary_terms_ad',
  'citations_owner_messages_ad', 'citations_owner_paper_card_items_ad', 'citations_owner_review_cards_ad',
];

async function freshDb() {
  const dir = tempDir();
  const sqlite = openSqlite(join(dir, 'db.sqlite'));
  const r = await migrateWithBackup(sqlite, { backupsDir: join(dir, 'backups') });
  return { dir, sqlite, r };
}
const names = (sqlite: ReturnType<typeof openSqlite>, type: string) =>
  (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`).all(type) as { name: string }[]).map((r) => r.name);

describe('DB migration (PLAN 6)', () => {
  it('a new DB gets every table and citation trigger, without a backup', async () => {
    const { sqlite, r } = await freshDb();
    expect(r.applied).toEqual(['0000_init', '0001_citations_triggers', '0002_m2', '0003_api', '0004_study_path']);
    expect(r.backupPath).toBeNull();
    expect(names(sqlite, 'table')).toEqual(EXPECTED_TABLES);
    expect(names(sqlite, 'trigger')).toEqual(EXPECTED_TRIGGERS);
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    sqlite.close();
  });

  it('re-running is a no-op (no pending migration, schema unchanged)', async () => {
    const { dir, sqlite } = await freshDb();
    const dump = () => JSON.stringify(sqlite.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`).all());
    const before = dump();
    expect(pendingMigrations(sqlite)).toEqual([]);
    const r = await migrateWithBackup(sqlite, { backupsDir: join(dir, 'backups') });
    expect(r).toEqual({ applied: [], backupPath: null });
    expect(dump()).toBe(before);
    sqlite.close();
  });

  it('deleting a paper cascades and the triggers leave no orphan citation; usage rows are kept', async () => {
    const { sqlite } = await freshDb();
    const t = 1;
    const ins = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    ins(`INSERT INTO papers (id, source, title, ingestStatus, createdAt, updatedAt) VALUES ('p1','arxiv','T','done',?,?)`, t, t);
    ins(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t1','p1','explain','x',?,?)`, t, t);
    ins(`INSERT INTO llm_calls (runId, task, paperId, threadId, model, effort, status, acceptedAt) VALUES ('r1','explain_selection','p1','t1','opus','low','ok',?)`, t);
    ins(`INSERT INTO messages (id, threadId, role, contentMd, status, llmCallId, createdAt) VALUES ('m1','t1','assistant','a','complete','r1',?)`, t);
    ins(`INSERT INTO paper_cards (id, paperId, kind, status, createdAt) VALUES ('c1','p1','notation','complete',?)`, t);
    ins(`INSERT INTO paper_card_items (id, cardId, ordinal, bodyMd) VALUES ('ci1','c1',1,'b')`);
    ins(`INSERT INTO review_cards (id, paperId, type, frontMd, backMd, origin, due, stability, difficulty, elapsedDays, scheduledDays, learningSteps, reps, lapses, state, createdAt, updatedAt) VALUES ('rc1','p1','definition','f','b','manual',?,0,0,0,0,0,0,0,0,?,?)`, t, t, t);
    ins(`INSERT INTO explain_backs (id, paperId, userText, createdAt) VALUES ('e1','p1','u',?)`, t);
    ins(`INSERT INTO glossary_terms (id, paperId, term, termNorm, origin, createdAt) VALUES ('g1','p1','ICP','icp','manual',?)`, t);
    const owners: [string, string][] = [['message', 'm1'], ['paper_card_item', 'ci1'], ['review_card', 'rc1'], ['explain_back', 'e1'], ['glossary_term', 'g1']];
    owners.forEach(([type, id], i) =>
      ins(`INSERT INTO citations (id, ownerType, ownerId, ordinal, kind, quote, status, score) VALUES (?,?,?,?, 'quote','q','verbatim',1)`, `cit${i}`, type, id, i + 1),
    );
    const count = () => (sqlite.prepare('SELECT count(*) AS n FROM citations').get() as { n: number }).n;
    expect(count()).toBe(5);

    ins(`DELETE FROM papers WHERE id='p1'`);
    expect(count()).toBe(0);
    expect(sqlite.prepare(`SELECT runId, paperId, threadId FROM llm_calls`).all()).toEqual([{ runId: 'r1', paperId: null, threadId: null }]);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    sqlite.close();
  });

  it('citations: a missing owner, a duplicate ordinal and an owner change are rejected', async () => {
    const { sqlite } = await freshDb();
    sqlite.exec(`INSERT INTO papers (id, source, title, ingestStatus, createdAt, updatedAt) VALUES ('p','arxiv','T','done',1,1);
      INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t','p','chat','x',1,1);
      INSERT INTO messages (id, threadId, role, contentMd, status, createdAt) VALUES ('m1','t','assistant','','complete',1), ('m2','t','assistant','','complete',2);`);
    const ins = sqlite.prepare(`INSERT INTO citations (id, ownerType, ownerId, ordinal, kind, status, score) VALUES (?, ?, ?, ?, 'quote', 'verbatim', 1)`);
    ins.run('c1', 'message', 'm1', 1);
    expect(() => ins.run('c2', 'message', 'no-such-message', 1)).toThrow(/owner row does not exist/);
    expect(() => ins.run('c3', 'review_card', 'm1', 1)).toThrow(/owner row does not exist/); // right id, wrong owner type
    expect(() => ins.run('c4', 'message', 'm1', 1)).toThrow(/UNIQUE/);
    expect(() => sqlite.prepare(`UPDATE citations SET ownerId='m2' WHERE id='c1'`).run()).toThrow(/cannot be changed/);
    sqlite.prepare(`UPDATE citations SET status='fuzzy' WHERE id='c1'`).run(); // other columns stay editable
    expect(sqlite.prepare(`SELECT count(*) AS n FROM citations`).get()).toEqual({ n: 1 });
    sqlite.close();
  });

  it('llm_calls: one run per clientRequestId (NULL allowed many times)', async () => {
    const { sqlite } = await freshDb();
    const ins = sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, task, model, effort, status, acceptedAt) VALUES (?, ?, 'chat', 'opus', 'low', 'queued', 1)`);
    ins.run('r1', 'req-1');
    expect(() => ins.run('r2', 'req-1')).toThrow(/UNIQUE/);
    ins.run('r3', null);
    ins.run('r4', null);
    sqlite.close();
  });

  it('fails closed when the applied history differs from the checkout (edited SQL, reordered, DB newer than code)', async () => {
    const { dir, sqlite } = await freshDb();
    const count = () => (sqlite.prepare(`SELECT count(*) AS n FROM __drizzle_migrations`).get() as { n: number }).n;
    // 1. an already applied migration file was edited
    const edited = migrationsWithExtra(dir + '/edited', '0002_test_noop', 'SELECT 1;');
    appendFileSync(join(edited, '0000_init.sql'), '\n-- edited after it was applied\n');
    await expect(migrateWithBackup(sqlite, { backupsDir: join(dir, 'backups'), migrationsFolder: edited })).rejects.toThrow(/history mismatch at 0000_init.*SQL text/);
    // 2. the DB is newer than the code
    const withExtra = migrationsWithExtra(dir + '/extra', '0002_test_noop', 'SELECT 1;');
    await migrateWithBackup(sqlite, { backupsDir: join(dir, 'backups'), migrationsFolder: withExtra });
    expect(count()).toBe(6);
    await expect(migrateWithBackup(sqlite, { backupsDir: join(dir, 'backups') })).rejects.toThrow(/newer than the code/);
    // 3. a migration with an earlier timestamp appears (branch merge): order no longer matches
    const reordered = migrationsWithExtra(dir + '/reordered', '0002_test_other', 'SELECT 2;');
    await expect(migrateWithBackup(sqlite, { backupsDir: join(dir, 'backups'), migrationsFolder: reordered })).rejects.toThrow(/history mismatch at 0002_test_other/);
    expect(count()).toBe(6); // nothing was applied by the failed attempts
    sqlite.close();
  });

  it('0002_m2 on an M1-shaped DB (0000–0001 with data, foreign_keys=ON): rows kept, new columns at defaults, triggers/indexes unchanged + 1, backup, re-run no-op', async () => {
    const dir = tempDir();
    // M1 checkout: the real migration folder cut to its first two entries.
    const m1Folder = join(dir, 'm1-drizzle');
    cpSync(DEFAULT_MIGRATIONS_FOLDER, m1Folder, { recursive: true });
    const journalPath = join(m1Folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => e.tag === '0000_init' || e.tag === '0001_citations_triggers');
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    const sqlite = openSqlite(join(dir, 'db.sqlite'));
    expect((await migrateWithBackup(sqlite, { backupsDir: join(dir, 'backups'), migrationsFolder: m1Folder })).applied).toEqual(['0000_init', '0001_citations_triggers']);

    const ins = (sql: string, ...a: unknown[]) => sqlite.prepare(sql).run(...a);
    ins(`INSERT INTO papers (id, source, arxivId, title, ingestStatus, supplementVersion, createdAt, updatedAt) VALUES ('p1','arxiv','2301.00002','T','done',1,1,1)`);
    ins(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t1','p1','explain','a',1,1), ('t2','p1','chat','b',2,2)`);
    ins(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, threadId, model, effort, status, acceptedAt, finishedAt) VALUES
      ('r1','00000000-0000-4000-8000-0000000000a1','h1','explain_selection','p1','t1','opus','low','ok',1,2),
      ('r2','00000000-0000-4000-8000-0000000000a2','v2:h2','chat','p1','t2','opus','medium','ok',3,4),
      ('r3',NULL,NULL,'chat','p1','t2','opus','medium','error',5,6)`);
    ins(`INSERT INTO messages (id, threadId, role, contentMd, status, statsJson, llmCallId, clientRequestId, createdAt) VALUES
      ('m1','t1','user','q','complete',NULL,NULL,'00000000-0000-4000-8000-0000000000a1',1),
      ('m2','t1','assistant','a <q>x</q> [[P]]','complete','{"blocks":{"p":1,"pUnverified":0,"n":0,"g":0,"unlabeled":0}}','r1',NULL,2),
      ('m3','t2','user','q2','complete',NULL,NULL,'00000000-0000-4000-8000-0000000000a2',3),
      ('m4','t2','assistant','b <eq n="1"/>','complete',NULL,'r2',NULL,4)`);
    ins(`INSERT INTO citations (id, ownerType, ownerId, ordinal, kind, quote, eqNumber, status, score, page, startOffset, endOffset) VALUES
      ('c1','message','m2',1,'quote','x',NULL,'verbatim',1,1,0,1),
      ('c2','message','m2',2,'quote','y',NULL,'fuzzy',0.9,1,2,3),
      ('c3','message','m2',3,'quote','z',NULL,'not_found',0,NULL,NULL,NULL),
      ('c4','message','m4',1,'equation',NULL,'1','unindexed',0,NULL,NULL,NULL),
      ('c5','message','m4',2,'quote','w',NULL,'ambiguous',0,NULL,NULL,NULL)`);
    ins(`INSERT INTO highlights (id, paperId, kind, color, quoteExact, page, rectsJson, createdAt, updatedAt) VALUES
      ('h1','p1','text',1,'x',1,'[]',1,1), ('h2','p1','text',2,'y',1,'[]',1,1), ('h3','p1','text',3,'z',2,'[]',1,1)`);

    const TABLES = ['papers', 'threads', 'messages', 'citations', 'highlights', 'llm_calls'];
    const dumpRows = () => Object.fromEntries(TABLES.map((t) => [t, sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
    const objects = (type: string) => (sqlite.prepare(`SELECT name, sql FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%' ORDER BY name`).all(type) as { name: string; sql: string | null }[]);
    const before = dumpRows();
    const triggersBefore = objects('trigger');
    const indexesBefore = objects('index');

    const m2Folder = join(dir, 'm2-drizzle');
    cpSync(DEFAULT_MIGRATIONS_FOLDER, m2Folder, { recursive: true });
    const m2Journal = join(m2Folder, 'meta', '_journal.json');
    const historic = JSON.parse(readFileSync(m2Journal, 'utf8'));
    historic.entries = historic.entries.slice(0, 3);
    writeFileSync(m2Journal, JSON.stringify(historic));
    // 0002's SQL: only ALTER TABLE … ADD and the partial unique index (no table rebuild).
    const sql = readFileSync(join(DEFAULT_MIGRATIONS_FOLDER, '0002_m2.sql'), 'utf8');
    expect(sql).not.toMatch(/DROP TABLE|__new_|PRAGMA foreign_keys/i);
    const statements = sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    expect(statements.filter((s) => /^ALTER TABLE `\w+` ADD `\w+`/.test(s))).toHaveLength(6);
    expect(statements.filter((s) => /^CREATE UNIQUE INDEX `paper_cards_generating_uq` ON `paper_cards` \(`paperId`,`kind`\) WHERE/.test(s))).toHaveLength(1);
    expect(statements).toHaveLength(7);

    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    const r = await migrateWithBackup(sqlite, { backupsDir: join(dir, 'backups'), migrationsFolder: m2Folder });
    expect(r.applied).toEqual(['0002_m2']);
    expect(r.backupPath).not.toBeNull();
    expect(existsSync(r.backupPath!)).toBe(true);

    // Existing rows unchanged (new columns at their defaults, messages.llmCallId kept).
    const after = dumpRows() as Record<string, Record<string, unknown>[]>;
    const strip = (rows: Record<string, unknown>[], cols: string[]) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !cols.includes(k))));
    expect(strip(after.citations!, ['equationId', 'detail'])).toEqual(before.citations);
    expect(strip(after.messages!, ['pendingReplace'])).toEqual(before.messages);
    expect(strip(after.llm_calls!, ['parentRunId', 'resultRaw'])).toEqual(before.llm_calls);
    for (const t of ['papers', 'threads', 'highlights']) expect(after[t]).toEqual(before[t]);
    expect(after.citations!.every((c) => c.equationId === null && c.detail === null)).toBe(true);
    expect(after.messages!.every((m) => m.pendingReplace === 0)).toBe(true);
    expect(after.messages!.filter((m) => m.llmCallId !== null).map((m) => m.llmCallId)).toEqual(['r1', 'r2']);
    expect(after.llm_calls!.every((c) => c.parentRunId === null && c.resultRaw === null)).toBe(true);

    // Triggers identical; indexes identical plus exactly the new one.
    expect(objects('trigger')).toEqual(triggersBefore);
    expect(objects('trigger').map((t) => t.name)).toEqual(EXPECTED_TRIGGERS);
    const newIndexes = objects('index').filter((i) => !indexesBefore.some((b) => b.name === i.name && b.sql === i.sql));
    expect(newIndexes.map((i) => i.name)).toEqual(['paper_cards_generating_uq']);
    expect(objects('index').length).toBe(indexesBefore.length + 1);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');

    // The partial index allows one generating card per (paper, kind) and any number of others.
    ins(`INSERT INTO paper_cards (id, paperId, kind, status, createdAt) VALUES ('k1','p1','notation','generating',1), ('k2','p1','notation','complete',1), ('k3','p1','notation','complete',2)`);
    expect(() => ins(`INSERT INTO paper_cards (id, paperId, kind, status, createdAt) VALUES ('k4','p1','notation','generating',3)`)).toThrow(/UNIQUE/);
    ins(`INSERT INTO paper_cards (id, paperId, kind, status, createdAt) VALUES ('k5','p1','assumptions','generating',3)`);

    // Re-running is a no-op.
    const dump = () => JSON.stringify(sqlite.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`).all());
    const schemaBefore = dump();
    expect(await migrateWithBackup(sqlite, { backupsDir: join(dir, 'backups'), migrationsFolder: m2Folder })).toEqual({ applied: [], backupPath: null });
    expect(dump()).toBe(schemaBefore);
    sqlite.close();
  });
});
