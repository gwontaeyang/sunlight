import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type Sqlite = Database.Database;
export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenDbOptions {
  readonly?: boolean;
  /** For tests only: disable WAL auto-checkpoint so recent writes stay in the -wal file. */
  walAutocheckpoint?: number;
}

/** Opens the app DB with the PLAN 6 pragmas: WAL, foreign_keys=ON, busy_timeout=5000. */
export function openSqlite(file: string, opts: OpenDbOptions = {}): Sqlite {
  const sqlite = new Database(file, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  if (!opts.readonly) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  if (opts.walAutocheckpoint !== undefined) sqlite.pragma(`wal_autocheckpoint = ${opts.walAutocheckpoint}`);
  return sqlite;
}

export function toDrizzle(sqlite: Sqlite): Db {
  return drizzle(sqlite, { schema });
}
