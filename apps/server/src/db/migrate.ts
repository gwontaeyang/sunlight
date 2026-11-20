// Applies Drizzle SQL migrations with a verified online backup first (PLAN 6 steps 1–3).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate as drizzleMigrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { backupDatabase } from './backup';
import type { Sqlite } from './client';

export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));
export const MIGRATIONS_TABLE = '__drizzle_migrations';

export interface MigrationInfo {
  tag: string;
  folderMillis: number;
  hash: string;
}

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function journalTags(migrationsFolder: string): JournalEntry[] {
  // readMigrationFiles validates the journal; we read tags for messages and backup file names.
  return (JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as { entries: JournalEntry[] }).entries;
}

/** Migrations in the folder that the DB has not applied yet (same rule as drizzle: created_at < folderMillis). */
export function pendingMigrations(sqlite: Sqlite, migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): MigrationInfo[] {
  const files = readMigrationFiles({ migrationsFolder });
  const tags = journalTags(migrationsFolder);
  const hasTable = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(MIGRATIONS_TABLE);
  let last: number | null = null;
  if (hasTable) {
    const row = sqlite.prepare(`SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`).get() as { created_at: number } | undefined;
    last = row ? Number(row.created_at) : null;
  }
  return files
    .map((m, i) => ({ tag: tags[i]?.tag ?? `#${i}`, folderMillis: m.folderMillis, hash: m.hash }))
    .filter((m) => last === null || last < m.folderMillis);
}

export function lastAppliedMigration(sqlite: Sqlite, migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): string | null {
  const hasTable = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(MIGRATIONS_TABLE);
  if (!hasTable) return null;
  const row = sqlite.prepare(`SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`).get() as { created_at: number } | undefined;
  if (!row) return null;
  return journalTags(migrationsFolder).find((e) => e.when === Number(row.created_at))?.tag ?? String(row.created_at);
}

/**
 * Fails closed when the migrations already applied to the DB are not exactly the first N migrations of this
 * checkout (same order, timestamp and SQL hash): an edited or reordered migration, a migration that landed
 * "in the past" after a branch merge, or a DB that is newer than the code.
 */
export function verifyAppliedMigrations(sqlite: Sqlite, migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): void {
  const hasTable = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(MIGRATIONS_TABLE);
  if (!hasTable) return;
  const applied = sqlite.prepare(`SELECT hash, created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at ASC, id ASC`).all() as { hash: string; created_at: number }[];
  const files = readMigrationFiles({ migrationsFolder });
  const tags = journalTags(migrationsFolder);
  if (applied.length > files.length) {
    throw new MigrationError(`migration history mismatch: the database has ${applied.length} applied migrations but this checkout has only ${files.length} (the database is newer than the code)`, null);
  }
  applied.forEach((row, i) => {
    const f = files[i]!;
    const tag = tags[i]?.tag ?? `#${i}`;
    if (Number(row.created_at) !== f.folderMillis || row.hash !== f.hash) {
      throw new MigrationError(`migration history mismatch at ${tag}: the database was migrated with a different ${Number(row.created_at) !== f.folderMillis ? 'migration order/timestamp' : 'SQL text'} than this checkout. Applied migrations must never be edited or reordered; restore a backup or check out the matching code`, null);
    }
  });
}

/** True when the DB already holds app data (any table besides sqlite internals). */
function hasExistingSchema(sqlite: Sqlite): boolean {
  const row = sqlite.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).get() as { n: number };
  return row.n > 0;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly backupPath: string | null,
  ) {
    super(message);
  }
}

export interface MigrateResult {
  applied: string[];
  backupPath: string | null;
}

/**
 * 0. applied history must match this checkout (verifyAppliedMigrations) → else throw, nothing touched.
 * 1. nothing pending → no-op. 2. existing DB → online backup + verify (failure → throw, migrations NOT run).
 * 3. migrate (one transaction, rolled back on error) → on failure throw MigrationError with backup path.
 */
export async function migrateWithBackup(
  sqlite: Sqlite,
  opts: { backupsDir: string; migrationsFolder?: string; now?: number },
): Promise<MigrateResult> {
  const migrationsFolder = opts.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  if (!existsSync(migrationsFolder)) throw new MigrationError(`migrations folder not found: ${migrationsFolder}`, null);
  verifyAppliedMigrations(sqlite, migrationsFolder); // before anything is backed up or changed
  const pending = pendingMigrations(sqlite, migrationsFolder);
  if (pending.length === 0) return { applied: [], backupPath: null };
  let backupPath: string | null = null;
  if (hasExistingSchema(sqlite)) {
    const tag = pending[pending.length - 1]!.tag;
    backupPath = await backupDatabase(sqlite, opts.backupsDir, tag, opts.now);
  }
  try {
    drizzleMigrate(drizzle(sqlite), { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
  } catch (e) {
    const restore = backupPath ? ` Restore with: npm run db:restore -- ${backupPath}` : '';
    throw new MigrationError(`migration failed: ${(e as Error).message}.${restore}`, backupPath);
  }
  return { applied: pending.map((p) => p.tag), backupPath };
}
