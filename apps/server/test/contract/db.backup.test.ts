import { chmodSync, copyFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqlite, type Sqlite } from '../../src/db/client';
import { BackupError, backupDatabase } from '../../src/db/backup';
import { MigrationError, migrateWithBackup, pendingMigrations } from '../../src/db/migrate';
import { RestoreError, restoreBackup } from '../../src/db/restore';
import { acquireInstanceLock } from '../../src/instanceLock';
import { dataPaths, ensureDataDirs } from '../../src/paths';
import { migrationsWithExtra } from '../helpers/migrations';
import { tempDir } from '../helpers/tmp';

/** DB at v1 whose newest rows are only in the -wal file (auto-checkpoint disabled). */
async function walOnlyDb() {
  const root = tempDir();
  const paths = dataPaths(root);
  ensureDataDirs(paths);
  const sqlite = openSqlite(paths.dbFile, { walAutocheckpoint: 0 });
  await migrateWithBackup(sqlite, { backupsDir: paths.backupsDir });
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  sqlite.prepare(`INSERT INTO papers (id, source, title, ingestStatus, createdAt, updatedAt) VALUES ('p-latest','arxiv','Latest','done',1,1)`).run();
  sqlite.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t-latest','p-latest','chat','x',1,1)`).run();
  // The main file alone does not contain the rows yet.
  const mainOnly = join(root, 'main-only.sqlite');
  copyFileSync(paths.dbFile, mainOnly);
  const probe = openSqlite(mainOnly, { readonly: true });
  expect((probe.prepare(`SELECT count(*) AS n FROM papers`).get() as { n: number }).n).toBe(0);
  probe.close();
  expect(statSync(`${paths.dbFile}-wal`).size).toBeGreaterThan(0);
  return { root, paths, sqlite };
}

const rowCount = (db: ReturnType<typeof openSqlite>, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe('backup before migration (PLAN 6, db.backup.test)', () => {
  it('backs up rows that are only in the WAL, with FKs intact, then migrates', async () => {
    const { root, paths, sqlite } = await walOnlyDb();
    const folder = migrationsWithExtra(root, '0002_test_add_column', 'ALTER TABLE `papers` ADD `extraTest` text;');
    const r = await migrateWithBackup(sqlite, { backupsDir: paths.backupsDir, migrationsFolder: folder });
    expect(r.applied).toEqual(['0002_test_add_column']);
    expect(r.backupPath).toMatch(/study_paper\.0002_test_add_column\.\d+\.sqlite$/);
    const b = openSqlite(r.backupPath!, { readonly: true });
    expect(b.prepare(`SELECT t.id AS tid, p.title FROM threads t JOIN papers p ON p.id = t.paperId`).all()).toEqual([{ tid: 't-latest', title: 'Latest' }]);
    expect(b.pragma('foreign_key_check')).toEqual([]);
    expect(b.pragma('integrity_check', { simple: true })).toBe('ok');
    expect((b.prepare(`SELECT name FROM pragma_table_info('papers') WHERE name='extraTest'`).all() as unknown[]).length).toBe(0);
    b.close();
    expect((sqlite.prepare(`SELECT name FROM pragma_table_info('papers') WHERE name='extraTest'`).all() as unknown[]).length).toBe(1);
    expect(readdirSync(paths.backupsDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    sqlite.close();
  });

  it('a failing migration leaves the DB unchanged, and the backup restores the latest rows', async () => {
    const { root, paths, sqlite } = await walOnlyDb();
    const folder = migrationsWithExtra(root, '0002_test_broken', 'ALTER TABLE `papers` ADD `willRollBack` text;\n--> statement-breakpoint\nALTER TABLE `no_such_table` ADD `x` text;');
    let err: unknown;
    try {
      await migrateWithBackup(sqlite, { backupsDir: paths.backupsDir, migrationsFolder: folder });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationError);
    const backupPath = (err as MigrationError).backupPath!;
    expect(existsSync(backupPath)).toBe(true);
    expect((err as Error).message).toContain('npm run db:restore --');
    // Original unchanged: rows present, partial DDL rolled back, still 5 applied migrations.
    expect(rowCount(sqlite, `SELECT count(*) AS n FROM papers WHERE id='p-latest'`)).toBe(1);
    expect((sqlite.prepare(`SELECT name FROM pragma_table_info('papers') WHERE name='willRollBack'`).all() as unknown[]).length).toBe(0);
    expect(rowCount(sqlite, `SELECT count(*) AS n FROM __drizzle_migrations`)).toBe(5);
    sqlite.close();

    // Simulate a damaged DB, then restore.
    const r = restoreBackup(paths, backupPath);
    expect(existsSync(join(r.movedTo, 'study_paper.sqlite'))).toBe(true);
    const restored = openSqlite(paths.dbFile);
    expect(restored.prepare(`SELECT id FROM threads`).all()).toEqual([{ id: 't-latest' }]);
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    restored.close();
  });

  it('when the backup cannot be written, the migration does not run', async () => {
    const { root, paths, sqlite } = await walOnlyDb();
    const folder = migrationsWithExtra(root, '0002_test_add_column', 'ALTER TABLE `papers` ADD `extraTest` text;');
    chmodSync(paths.backupsDir, 0o500);
    try {
      await expect(migrateWithBackup(sqlite, { backupsDir: paths.backupsDir, migrationsFolder: folder })).rejects.toBeInstanceOf(BackupError);
    } finally {
      chmodSync(paths.backupsDir, 0o700);
    }
    expect(pendingMigrations(sqlite, folder).map((m) => m.tag)).toEqual(['0002_test_add_column']);
    expect((sqlite.prepare(`SELECT name FROM pragma_table_info('papers') WHERE name='extraTest'`).all() as unknown[]).length).toBe(0);
    sqlite.close();
  });

  it('restore refuses while the data directory lock is held (server or another restore)', async () => {
    const { root, paths, sqlite } = await walOnlyDb();
    const backup = join(root, 'b.sqlite');
    await sqlite.backup(backup);
    sqlite.close();
    const held = acquireInstanceLock(paths.lockFile, 'server'); // this test process plays the running server
    try {
      expect(() => restoreBackup(paths, backup)).toThrow(/server is running/);
      expect(rowCountOf(paths.dbFile, `SELECT count(*) AS n FROM papers`)).toBe(1); // untouched
    } finally {
      held.release();
    }
    restoreBackup(paths, backup); // free again → works, and releases its own lock
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it('restore verifies the backup before touching the current DB', async () => {
    const { root, paths, sqlite } = await walOnlyDb();
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.close();
    const garbage = join(root, 'garbage.sqlite');
    writeFileSync(garbage, 'this is not a database');
    const empty = join(root, 'empty.sqlite');
    openSqlite(empty).close(); // valid SQLite file, but not a study_paper DB
    for (const bad of [garbage, empty]) {
      expect(() => restoreBackup(paths, bad)).toThrow(RestoreError);
      expect(rowCountOf(paths.dbFile, `SELECT count(*) AS n FROM papers`)).toBe(1);
    }
    expect(() => restoreBackup(paths, paths.dbFile)).toThrow(/live database file/);
    expect(readdirSync(paths.dbDir).filter((f) => f.includes('.restore.'))).toEqual([]);
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it('a failed swap puts the original DB files back', async () => {
    const { root, paths, sqlite } = await walOnlyDb();
    const backup = join(root, 'b.sqlite');
    await sqlite.backup(backup);
    sqlite.prepare(`INSERT INTO papers (id, source, title, ingestStatus, createdAt, updatedAt) VALUES ('p-after-backup','arxiv','After','done',2,2)`).run();
    sqlite.close();
    expect(() =>
      restoreBackup(paths, backup, Date.now(), {
        beforeSwap: () => {
          throw new Error('disk full (simulated)');
        },
      }),
    ).toThrow(/original database was put back/);
    expect(rowCountOf(paths.dbFile, `SELECT count(*) AS n FROM papers`)).toBe(2); // the newer original, not the backup
    expect(readdirSync(paths.dbDir).filter((f) => f.includes('.restore.'))).toEqual([]);
    expect(existsSync(paths.lockFile)).toBe(false);
  });
});

function rowCountOf(file: string, sql: string): number {
  const db = openSqlite(file, { readonly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

// S2b-R1-07 (a): the read-only check of the `.tmp` copy creates `<tmp>-shm` / `<tmp>-wal` next to it; pruneBackups never
// matches them, so backupDatabase itself must leave no `.tmp*` file, on success and on failure.
describe('backupDatabase leaves no temporary files in backups/ (S2b-R1-07)', () => {
  const tmpLeftovers = (dir: string) => readdirSync(dir).filter((f) => f.includes('.tmp'));

  it('a WAL-mode source with writes only in its -wal → backups/ holds exactly the final .sqlite, no *.tmp* file', async () => {
    const { root, sqlite } = await walOnlyDb();
    const dir = join(root, 'backups-r1-07');
    const finalPath = await backupDatabase(sqlite, dir, 'test');
    expect(readdirSync(dir)).toEqual([basename(finalPath)]);
    expect(tmpLeftovers(dir)).toEqual([]);
    const b = openSqlite(finalPath, { readonly: true });
    expect(b.prepare(`SELECT id FROM threads`).all()).toEqual([{ id: 't-latest' }]); // the -wal-only rows are in the copy
    b.close();
    sqlite.close();
  });

  it('a failing verification (foreign_key_check violation) → BackupError, no final file and no *.tmp* file', async () => {
    const { root, sqlite } = await walOnlyDb();
    sqlite.pragma('foreign_keys = OFF');
    sqlite.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t-orphan','no-such-paper','chat','x',1,1)`).run();
    sqlite.pragma('foreign_keys = ON');
    const dir = join(root, 'backups-r1-07-fail');
    await expect(backupDatabase(sqlite, dir, 'test')).rejects.toThrow(/foreign_key_check/);
    expect(readdirSync(dir)).toEqual([]);
    expect(tmpLeftovers(dir)).toEqual([]);
    sqlite.close();
  });

  it('a <tmp>-wal with content after the read-only check (the copy was written by another connection) → BackupError, no final file and no *.tmp* file', async () => {
    const { root, sqlite } = await walOnlyDb();
    const dir = join(root, 'backups-r1-07-wal');
    // The backup itself is the real one; right after it, another connection writes to the .tmp copy (auto-checkpoint
    // off) and stays open, so the copy's -wal still holds that write when the read-only check closes.
    let writer: Sqlite | undefined;
    const wrapped = {
      backup: async (p: string) => {
        await sqlite.backup(p);
        writer = openSqlite(p, { walAutocheckpoint: 0 });
        writer.prepare(`UPDATE threads SET title = 'written after the backup'`).run(); // a new value: an unchanged row writes no page
      },
    } as unknown as Sqlite;
    try {
      await expect(backupDatabase(wrapped, dir, 'test')).rejects.toThrow(/-wal holds \d+ byte/);
      expect(readdirSync(dir)).toEqual([]);
      expect(tmpLeftovers(dir)).toEqual([]);
    } finally {
      writer?.close();
      sqlite.close();
    }
    expect(writer).toBeDefined();
    expect(readdirSync(dir)).toEqual([]); // closing the writer does not bring a file back
  });
});
