// dataDump (BRIEF_INTEGRATION I6 case 10): an M2 DB (0002 columns) and an M1-shaped DB compare equal on the baseline
// (M1) columns; one changed value names its table and id. Owner: supervisor.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareTables, DUMP_TABLES, dumpTable, tableShape } from '../../../../scripts/lib/dataDump';
import { openSqlite, type Sqlite } from '../../src/db/client';
import { migrateWithBackup } from '../../src/db/migrate';
import { m1MigrationsFolder } from '../helpers/migrations';
import { tempDir } from '../helpers/tmp';

/** The same rows in each of the 4 tables (only M1 columns are written). */
function fill(db: Sqlite): void {
  db.exec(`
    INSERT INTO papers (id, source, title, ingestStatus, createdAt, updatedAt) VALUES ('p1','arxiv','P','done',1,1);
    INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t1','p1','chat','x',1,1), ('t2','p1','explain','y',2,2);
    INSERT INTO messages (id, threadId, role, contentMd, status, createdAt) VALUES ('m1','t1','user','q','complete',1), ('m2','t1','assistant','a','complete',2);
    INSERT INTO citations (id, ownerType, ownerId, ordinal, kind, quote, status, score, page, startOffset, endOffset) VALUES ('c1','message','m2',1,'quote','q1','verbatim',1,1,10,20), ('c2','message','m2',2,'quote','q2','not_found',0,NULL,NULL,NULL);
    INSERT INTO highlights (id, paperId, kind, color, quoteExact, page, startOffset, endOffset, rectsJson, createdAt, updatedAt) VALUES ('h1','p1','text',2,'z',1,3,4,'[]',1,1);
  `);
}

async function dbs(): Promise<{ m1: Sqlite; m2: Sqlite }> {
  const dir = tempDir('sp-dump-');
  const m1 = openSqlite(join(dir, 'm1.sqlite'));
  await migrateWithBackup(m1, { backupsDir: join(dir, 'b1'), migrationsFolder: m1MigrationsFolder(dir) });
  const m2 = openSqlite(join(dir, 'm2.sqlite'));
  await migrateWithBackup(m2, { backupsDir: join(dir, 'b2') });
  fill(m1);
  fill(m2);
  return { m1, m2 };
}

describe('dataDump (I6 case 10)', () => {
  it('m1MigrationsFolder gives the M1 shape: the M2 DB has more columns in the dumped tables', async () => {
    const { m1, m2 } = await dbs();
    expect(tableShape(m2, 'citations').columns.length).toBeGreaterThan(tableShape(m1, 'citations').columns.length);
    expect(tableShape(m2, 'messages').columns).toContain('pendingReplace');
    expect(tableShape(m1, 'messages').columns).not.toContain('pendingReplace');
    m1.close();
    m2.close();
  });

  it('the M1-shaped DB and the M2 DB are equal on the baseline (M1) columns, table by table', async () => {
    const { m1, m2 } = await dbs();
    const diffs = compareTables(m1, m2, DUMP_TABLES);
    expect(diffs.map((d) => [d.table, d.equal, d.count.a, d.count.b])).toEqual([
      ['threads', true, 2, 2],
      ['messages', true, 2, 2],
      ['citations', true, 2, 2],
      ['highlights', true, 1, 1],
    ]);
    // projected onto its own (wider) columns the M2 dump is a different hash: the projection is what makes them equal
    expect(dumpTable(m2, 'citations').sha256).not.toBe(dumpTable(m1, 'citations').sha256);
    m1.close();
    m2.close();
  });

  it('one changed value → only that table, only that id', async () => {
    const { m1, m2 } = await dbs();
    m2.prepare(`UPDATE citations SET score = 0.5 WHERE id = 'c2'`).run();
    const diffs = compareTables(m1, m2, DUMP_TABLES);
    expect(diffs.filter((d) => !d.equal).map((d) => [d.table, d.changedIds, d.onlyInAIds, d.onlyInBIds])).toEqual([['citations', ['c2'], [], []]]);
    m1.close();
    m2.close();
  });

  it('a row only on one side is listed by id; a missing baseline column makes the table not comparable', async () => {
    const { m1, m2 } = await dbs();
    m1.prepare(`DELETE FROM highlights WHERE id = 'h1'`).run();
    const d = compareTables(m1, m2, ['highlights'])[0]!;
    expect(d).toMatchObject({ equal: false, onlyInA: 0, onlyInB: 1, onlyInBIds: ['h1'] });
    // baseline = M2 (wider): the M1 DB lacks pendingReplace → not equal, the column is named
    const back = compareTables(m2, m1, ['messages'])[0]!;
    expect(back.equal).toBe(false);
    expect(back.missingInB.columns).toContain('pendingReplace');
    m1.close();
    m2.close();
  });
});
