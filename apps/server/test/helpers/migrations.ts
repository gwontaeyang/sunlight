import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MIGRATIONS_FOLDER } from '../../src/db/migrate';

/** Copies the real migrations into `dir` and appends one extra migration with the given SQL. */
export function migrationsWithExtra(dir: string, tag: string, sql: string): string {
  const folder = join(dir, 'drizzle');
  cpSync(DEFAULT_MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; when: number; tag: string; version: string; breakpoints: boolean }[] };
  const last = journal.entries[journal.entries.length - 1]!;
  journal.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag, breakpoints: true });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  writeFileSync(join(folder, `${tag}.sql`), sql);
  return folder;
}

/** The M1 checkout's migrations: the real folder copied into `dir` with its journal cut to 0000_init + 0001_citations_triggers. */
export function m1MigrationsFolder(dir: string): string {
  const folder = join(dir, 'm1-drizzle');
  cpSync(DEFAULT_MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag === '0000_init' || e.tag === '0001_citations_triggers');
  if (journal.entries.length !== 2) throw new Error('the migration folder no longer has 0000_init and 0001_citations_triggers');
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}
