// Normalized table dumps for cutover / rollback comparisons (PLAN_M2 7절 5–6, BRIEF_INTEGRATION I6 `compare`). Owner:
// supervisor. Pure over an open better-sqlite3 connection: no file is written here.
//
// A dump of a table is projected onto a GIVEN column list (the snapshot side's columns), so a DB that gained columns
// in a later migration (0002) compares equal to the M1-shaped one when the shared columns hold the same values. Rows are
// read in primary-key order; each row is serialized as JSON of [pk values, projected values] (a BLOB becomes
// {"$blob": hex}); the table sha256 is over those lines. Differences are reported by primary key only — never values.
import { createHash } from 'node:crypto';
import type { Sqlite } from '../../apps/server/src/db/client';

/** The tables whose rows a cutover / rollback must keep (PLAN_M2 3.1 보존 검증, 7절 6 ⑤). */
export const DUMP_TABLES = ['threads', 'messages', 'citations', 'highlights'] as const;
/** At most this many primary keys are listed per difference kind (the counts are always exact). */
export const DIFF_ID_LIST_MAX = 200;

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface TableShape {
  exists: boolean;
  columns: string[];
  /** Primary-key columns in key order (rowid when the table has none). */
  pk: string[];
}

export function tableShape(db: Sqlite, table: string): TableShape {
  const exists = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!exists) return { exists: false, columns: [], pk: [] };
  const info = db.prepare(`SELECT name, pk FROM pragma_table_info(?) ORDER BY cid`).all(table) as { name: string; pk: number }[];
  const pk = info
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  return { exists: true, columns: info.map((c) => c.name), pk: pk.length ? pk : ['rowid'] };
}

const norm = (v: unknown): unknown => (Buffer.isBuffer(v) ? { $blob: v.toString('hex') } : typeof v === 'bigint' ? { $int: v.toString() } : v);

export interface TableDump {
  table: string;
  exists: boolean;
  columns: string[];
  pk: string[];
  /** Projected columns the table does not have (the dump is then not comparable). */
  missingColumns: string[];
  count: number;
  sha256: string;
  /** pk key (JSON of the pk values) → sha256 of the row line. */
  rows: Map<string, string>;
}

/** Dumps `table` projected onto `columns` (default: its own columns), in `pk` order (default: its own key). */
export function dumpTable(db: Sqlite, table: string, columns?: readonly string[], pk?: readonly string[]): TableDump {
  const shape = tableShape(db, table);
  const cols = [...(columns ?? shape.columns)];
  const keys = [...(pk ?? shape.pk)];
  const empty = createHash('sha256').digest('hex');
  if (!shape.exists) return { table, exists: false, columns: cols, pk: keys, missingColumns: cols, count: 0, sha256: empty, rows: new Map() };
  const have = new Set([...shape.columns, 'rowid']);
  const missingColumns = [...cols, ...keys].filter((c) => !have.has(c));
  if (missingColumns.length) return { table, exists: true, columns: cols, pk: keys, missingColumns: [...new Set(missingColumns)], count: 0, sha256: empty, rows: new Map() };
  const stmt = db.prepare(`SELECT ${[...keys, ...cols].map(q).join(', ')} FROM ${q(table)} ORDER BY ${keys.map(q).join(', ')}`).raw(true);
  const h = createHash('sha256');
  const rows = new Map<string, string>();
  for (const r of stmt.iterate() as Iterable<unknown[]>) {
    const key = JSON.stringify(r.slice(0, keys.length).map(norm));
    const line = JSON.stringify([JSON.parse(key), r.slice(keys.length).map(norm)]);
    h.update(line).update('\n');
    rows.set(key, createHash('sha256').update(line).digest('hex'));
  }
  return { table, exists: true, columns: cols, pk: keys, missingColumns: [], count: rows.size, sha256: h.digest('hex'), rows };
}

export interface TableDiff {
  table: string;
  equal: boolean;
  columns: string[];
  missingInB: { table: boolean; columns: string[] };
  count: { a: number; b: number };
  sha256: { a: string; b: string };
  /** Exact numbers; the id lists stop at DIFF_ID_LIST_MAX. */
  onlyInA: number;
  onlyInB: number;
  changed: number;
  onlyInAIds: string[];
  onlyInBIds: string[];
  changedIds: string[];
}

/** Compares two dumps made with the same columns and key. */
export function diffDumps(a: TableDump, b: TableDump): TableDiff {
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const changed: string[] = [];
  for (const [k, h] of a.rows) {
    const o = b.rows.get(k);
    if (o === undefined) onlyInA.push(k);
    else if (o !== h) changed.push(k);
  }
  for (const k of b.rows.keys()) if (!a.rows.has(k)) onlyInB.push(k);
  const id = (k: string) => {
    const v = JSON.parse(k) as unknown[];
    return v.length === 1 ? String(v[0]) : k;
  };
  const comparable = a.exists && b.exists && a.missingColumns.length === 0 && b.missingColumns.length === 0;
  return {
    table: a.table,
    equal: comparable && a.sha256 === b.sha256 && a.count === b.count && onlyInA.length === 0 && onlyInB.length === 0 && changed.length === 0,
    columns: a.columns,
    missingInB: { table: !b.exists, columns: b.missingColumns },
    count: { a: a.count, b: b.count },
    sha256: { a: a.sha256, b: b.sha256 },
    onlyInA: onlyInA.length,
    onlyInB: onlyInB.length,
    changed: changed.length,
    onlyInAIds: onlyInA.slice(0, DIFF_ID_LIST_MAX).map(id),
    onlyInBIds: onlyInB.slice(0, DIFF_ID_LIST_MAX).map(id),
    changedIds: changed.slice(0, DIFF_ID_LIST_MAX).map(id),
  };
}

/** Each table of `tables`, dumped on both sides with A's columns and key (A = the baseline, e.g. the snapshot). */
export function compareTables(a: Sqlite, b: Sqlite, tables: readonly string[] = DUMP_TABLES): TableDiff[] {
  return tables.map((t) => {
    const da = dumpTable(a, t);
    return diffDumps(da, dumpTable(b, t, da.columns, da.pk));
  });
}
