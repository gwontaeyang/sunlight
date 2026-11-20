// Exclusive lock per data directory. Owner: supervisor.
// It must be held BEFORE the DB is opened, migrated or recovered and before any token/pid file is written:
// a second process on the same SP_DATA_DIR would otherwise run startupRecovery against a live server
// (marking its running rows `interrupted`, emptying tmp/) or restore a DB that is in use.
// The server holds it until exit; `npm run db:restore` takes the same lock.
//
// Mechanism (no dependency): the lock file is created atomically with its content (write a private temp file,
// then link() it to the lock path — link fails with EEXIST when the lock exists). A lock whose holder is gone
// (pid dead, or pid reused: /proc start time differs) is taken over by rename(), which only one contender wins.
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export type LockRole = 'server' | 'restore';
export interface LockInfo {
  pid: number;
  /** /proc/<pid>/stat start time (clock ticks since boot) — distinguishes a recycled pid. null without /proc. */
  startTime: string | null;
  role: LockRole;
  acquiredAt: number;
}

export class InstanceLockError extends Error {
  constructor(
    readonly holder: LockInfo | null,
    readonly lockFile: string,
  ) {
    super(
      holder
        ? `this data directory is in use by a study_paper ${holder.role} (pid ${holder.pid}). Stop it first, or set SP_DATA_DIR to a different directory. Lock file: ${lockFile}`
        : `could not take the data directory lock ${lockFile} (another process is starting at the same time); try again`,
    );
  }
}

export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the last ')' start at field 3 (state); starttime is field 22.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/** The holder is alive when its pid exists and (where /proc is available) is still the same process. */
export function isHolderAlive(info: LockInfo): boolean {
  try {
    process.kill(info.pid, 0);
  } catch {
    return false;
  }
  const now = processStartTime(info.pid);
  if (now === null || info.startTime === null) return true;
  return now === info.startTime;
}

function readLock(lockFile: string): { raw: string; info: LockInfo | null } | null {
  let raw: string;
  try {
    raw = readFileSync(lockFile, 'utf8');
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(raw) as LockInfo;
    if (Number.isInteger(v.pid) && v.pid > 0 && (v.role === 'server' || v.role === 'restore')) return { raw, info: v };
  } catch {
    /* garbage → stale */
  }
  return { raw, info: null };
}

export interface InstanceLock {
  file: string;
  info: LockInfo;
  /** Removes the lock only while it is still ours. Safe to call twice. */
  release(): void;
}

export interface AcquireOptions {
  pid?: number;
  isAlive?: (info: LockInfo) => boolean;
  now?: number;
}

export function acquireInstanceLock(lockFile: string, role: LockRole, opts: AcquireOptions = {}): InstanceLock {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? isHolderAlive;
  const info: LockInfo = { pid, startTime: processStartTime(pid), role, acquiredAt: opts.now ?? Date.now() };
  const mine = JSON.stringify(info);
  const tmp = `${lockFile}.${pid}.${process.hrtime.bigint()}.tmp`;
  writeFileSync(tmp, mine, { mode: 0o600, flag: 'wx' }); // a new file (never into an existing one), then linked
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, lockFile); // atomic create-with-content; EEXIST when held
        return { file: lockFile, info, release: () => releaseIfOurs(lockFile, mine) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const existing = readLock(lockFile);
      if (existing === null) continue; // vanished between link and read: retry
      if (existing.info && isAlive(existing.info)) throw new InstanceLockError(existing.info, lockFile);
      // Stale: move it aside. Only one contender wins the rename; the loser retries and meets the winner's lock.
      const aside = `${lockFile}.stale.${pid}.${process.hrtime.bigint()}`;
      try {
        renameSync(lockFile, aside);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      const moved = readLock(aside);
      if (moved && moved.raw !== existing.raw) {
        // We moved a lock that another process created after our read: put it back and give up.
        try {
          linkSync(aside, lockFile);
        } catch {
          /* a newer lock exists already */
        }
        rmSync(aside, { force: true });
        throw new InstanceLockError(moved.info, lockFile);
      }
      rmSync(aside, { force: true });
    }
    throw new InstanceLockError(null, lockFile);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function releaseIfOurs(lockFile: string, mine: string): void {
  const cur = readLock(lockFile);
  if (cur && cur.raw === mine) rmSync(lockFile, { force: true });
}
