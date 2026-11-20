// Online backup before migrations (PLAN 6 "Migration과 백업", review B1).
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openSqlite, type Sqlite } from './client';

export const BACKUP_KEEP = 5;

export class BackupError extends Error {}

/**
 * Removes the side files the read-only check leaves next to the `.tmp` copy (S2b-R1-07 (a)): opening a WAL-mode copy
 * creates `<tmp>-shm` and `<tmp>-wal`, which pruneBackups never matches, so they would stay in backups/ for ever.
 */
function removeTmpSideFiles(tmpPath: string): void {
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}
function removeTmp(tmpPath: string): void {
  rmSync(tmpPath, { force: true });
  removeTmpSideFiles(tmpPath);
}

/**
 * better-sqlite3 online backup (includes writes that are still only in the -wal file) → open the copy
 * read-only → PRAGMA integrity_check = ok and foreign_key_check = 0 rows → close it and remove the -shm/-wal it
 * left → rename to the final name. Any failure throws BackupError and leaves no final file and no `.tmp*` file behind.
 * A `<tmp>-wal` with content after the check is a failure: a read-only connection never writes it, so the copy was
 * written to by something else and the final file (renamed without that -wal) would not hold what was checked.
 */
export async function backupDatabase(sqlite: Sqlite, backupsDir: string, tag: string, now = Date.now()): Promise<string> {
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const finalPath = join(backupsDir, `study_paper.${tag}.${now}.sqlite`);
  const tmpPath = `${finalPath}.tmp`;
  try {
    await sqlite.backup(tmpPath);
  } catch (e) {
    removeTmp(tmpPath);
    throw new BackupError(`backup to ${tmpPath} failed: ${(e as Error).message}`);
  }
  let check: Sqlite | undefined;
  try {
    check = openSqlite(tmpPath, { readonly: true });
    const integrity = check.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new BackupError(`integrity_check of ${tmpPath} returned ${String(integrity)}`);
    const fk = check.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0) throw new BackupError(`foreign_key_check of ${tmpPath} returned ${fk.length} row(s)`);
  } catch (e) {
    check?.close();
    removeTmp(tmpPath);
    throw e instanceof BackupError ? e : new BackupError(`verifying ${tmpPath} failed: ${(e as Error).message}`);
  }
  check.close();
  const walPath = `${tmpPath}-wal`;
  const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
  if (walBytes > 0) {
    removeTmp(tmpPath);
    throw new BackupError(`verifying ${tmpPath} failed: its -wal holds ${walBytes} byte(s) after a read-only check`);
  }
  removeTmpSideFiles(tmpPath);
  renameSync(tmpPath, finalPath);
  try {
    chmodSync(finalPath, 0o600);
  } catch {
    /* best effort */
  }
  pruneBackups(backupsDir);
  return finalPath;
}

/** Keeps the newest BACKUP_KEEP `study_paper.<tag>.<epoch>.sqlite` files. */
export function pruneBackups(backupsDir: string, keep = BACKUP_KEEP): void {
  if (!existsSync(backupsDir)) return;
  const files = readdirSync(backupsDir)
    .map((f) => ({ f, m: /^study_paper\..+\.(\d+)\.sqlite$/.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => !!x.m)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
  for (const { f } of files.slice(keep)) rmSync(join(backupsDir, basename(f)), { force: true });
}
