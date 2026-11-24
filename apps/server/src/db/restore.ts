// Restore a backup made by migrateWithBackup (PLAN 6 step 4). Owner: supervisor.
// Takes the data-directory lock (so no server and no other restore can run), verifies the backup BEFORE touching
// the current DB, stages a verified copy next to the DB, then swaps it in with rename(); a failed swap puts the
// original files back.
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isWindows } from '../security/platform';
import { restrictDirToCurrentUser } from '../security/winAcl';
import { acquireInstanceLock, InstanceLockError } from '../instanceLock';
import type { DataPaths } from '../paths';
import { MIGRATIONS_TABLE } from './migrate';
import { openSqlite } from './client';

export class RestoreError extends Error {}

/** integrity_check = ok, no FK violations, and it is a study_paper DB (has the migrations table). */
export function verifyDatabaseFile(file: string): void {
  // Opening a WAL-mode file read-only may create -wal/-shm next to it: remove the ones we caused.
  const sidecars = ['-wal', '-shm'].map((x) => `${file}${x}`).filter((f) => !existsSync(f));
  let db;
  try {
    db = openSqlite(file, { readonly: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new RestoreError(`${file}: integrity_check returned ${String(integrity)}`);
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0) throw new RestoreError(`${file}: foreign_key_check returned ${fk.length} row(s)`);
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(MIGRATIONS_TABLE)) throw new RestoreError(`${file} is not a study_paper database (no ${MIGRATIONS_TABLE} table)`);
  } catch (e) {
    throw e instanceof RestoreError ? e : new RestoreError(`${file} is not a readable SQLite database: ${(e as Error).message}`);
  } finally {
    db?.close();
    for (const f of sidecars) rmSync(f, { force: true });
  }
}

export interface RestoreHooks {
  /** Test hook: runs right before the staged copy is renamed into place. */
  beforeSwap?: () => void;
}

/** Moves the current DB (+ -wal/-shm) to backups/failed.<epoch>/ and installs a verified copy of the backup. */
export function restoreBackup(paths: DataPaths, backupPath: string, now = Date.now(), hooks: RestoreHooks = {}): { movedTo: string } {
  if (!existsSync(backupPath)) throw new RestoreError(`backup not found: ${backupPath}`);
  if (existsSync(paths.dbFile) && realpathSync(backupPath) === realpathSync(paths.dbFile)) throw new RestoreError('the backup path is the live database file');
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = acquireInstanceLock(paths.lockFile, 'restore');
  } catch (e) {
    if (e instanceof InstanceLockError) throw new RestoreError(e.holder ? `a study_paper ${e.holder.role} is running (pid ${e.holder.pid}); stop it first` : e.message);
    throw e;
  }
  mkdirSync(paths.dbDir, { recursive: true, mode: 0o700 });
  const staged = `${paths.dbFile}.restore.${now}.tmp`;
  try {
    verifyDatabaseFile(backupPath); // nothing has been touched yet
    copyFileSync(backupPath, staged);
    verifyDatabaseFile(staged); // catches a short or failed copy
    const failedDir = join(paths.backupsDir, `failed.${now}`);
    mkdirSync(failedDir, { recursive: true, mode: 0o700 });
    if (isWindows()) restrictDirToCurrentUser(failedDir); // POSIX 0700 is meaningless on win32; ACL instead (best-effort)
    const moved: [from: string, to: string][] = [];
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const f = `${paths.dbFile}${suffix}`;
        if (!existsSync(f)) continue;
        const to = join(failedDir, basename(f));
        renameSync(f, to);
        moved.push([f, to]);
      }
      hooks.beforeSwap?.();
      renameSync(staged, paths.dbFile);
    } catch (e) {
      for (const [from, to] of moved.reverse()) renameSync(to, from); // put the original files back
      throw new RestoreError(`restore failed, the original database was put back: ${(e as Error).message}`);
    }
    return { movedTo: failedDir };
  } finally {
    rmSync(staged, { force: true });
    lock.release();
  }
}
