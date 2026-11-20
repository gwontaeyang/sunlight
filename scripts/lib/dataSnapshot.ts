// Data-set snapshot / verify / restore / compare — the cutover and rollback tool (PLAN_M2 7절 6, D24;
// BRIEF_INTEGRATION I6). Owner: supervisor. The CLI is scripts/data-snapshot.ts.
//
// The unit is DB + papers/ as ONE set: db/study_paper.sqlite (an online backup) and papers/ (a real byte copy — never a
// hard link or a reflink), plus SNAPSHOT.json and MANIFEST.sha256 (every other file, `sha256sum -c` format, sorted).
// backups/ claude-cwd/ run/ tmp/ (and anything else in the data directory) are not part of the set.
//
// Rules this file keeps:
// - A data directory is only read or replaced while its instance lock is held (no server, no other restore).
// - A snapshot's DB is never opened where it lies (a WAL-format file opened in place grows -shm/-wal there, which breaks
//   the MANIFEST check, and a sealed snapshot cannot even be opened): every DB check runs on a copy in a mkdtemp
//   directory (0700) that is removed in `finally` (and, through installSignalCleanup, on process.exit).
// - The live DB is opened read-only; the -wal/-shm such a connection leaves behind are removed when they did not exist
//   before (the lock guarantees no other connection).
// - restore: verify a writable staging copy first, then rename live → aside (never deleted), then staging → live. A
//   failed verify removes only the staging; a failed second rename renames the aside back. Nothing else touches live.
// - Signals (the CLI, installSignalCleanup): SIGINT / SIGTERM only record the signal. The long steps are synchronous, so
//   a signal that comes during one is handled when that stretch ends, at the next checkpoint — an event-loop yield
//   between the stretches (after each file of a copy or a hash pass, after a DB copy, between the DB checks). There the
//   command stops with SnapshotInterrupted: the finally blocks remove the temp DB copy (sp-snapdb-*), the snapshot's
//   .partial-* or the restore's staging, the lock is released, and the CLI exits 130 / 143. restore's last checkpoint
//   is before rename 1: a signal after it lets both renames finish (or the first be undone). A signal after a command's
//   last checkpoint lets it finish; the exit is 130 / 143 all the same (stdout shows the result and `signal`).
// - A path under the real data directory (~/.local/share/study_paper*, or $XDG_DATA_HOME/study_paper*) is refused unless
//   SP_SNAPSHOT_ALLOW_REAL=1 (exit 2) — only the coordinator's cutover sets it.
// Errors: SnapshotUsageError (exit 2: usage or precondition, nothing changed) / SnapshotCheckError (exit 1).
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { openSqlite, type Sqlite } from '../../apps/server/src/db/client';
import { DEFAULT_MIGRATIONS_FOLDER, MIGRATIONS_TABLE } from '../../apps/server/src/db/migrate';
import { acquireInstanceLock, InstanceLockError, type InstanceLock } from '../../apps/server/src/instanceLock';
import { dataPaths } from '../../apps/server/src/paths';
import { APP_DATA_ENTRIES, findTreeLink } from '../../apps/server/src/security/dataTree';
import { compareTables, DIFF_ID_LIST_MAX, DUMP_TABLES, type TableDiff } from './dataDump';
import { existingRealpath, realDataDirPrefixOf } from './realDataDir';

export const SNAPSHOT_JSON = 'SNAPSHOT.json';
export const MANIFEST = 'MANIFEST.sha256';
export const DB_REL = 'db/study_paper.sqlite';
/** The only top-level entries of a snapshot. */
const TOP_LEVEL = new Set(['db', 'papers', SNAPSHOT_JSON, MANIFEST]);
const COPY_CHUNK = 1 << 20;

export class SnapshotUsageError extends Error {
  readonly exitCode = 2;
}
export class SnapshotCheckError extends Error {
  readonly exitCode = 1;
  constructor(
    message: string,
    readonly result: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type RenameFn = (from: string, to: string) => void;
export interface SnapshotEnv {
  /** Environment for HOME / XDG_DATA_HOME / SP_SNAPSHOT_ALLOW_REAL (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** restore's renames (tests inject failures). */
  rename?: RenameFn;
  /** Called with each temp DB copy directory once the copy is made (tests: a signal while a copy exists). */
  onDbCopy?: (dir: string) => void;
  now?: () => number;
}

// ---------------------------------------------------------------------------------------------------------- paths

/**
 * Refuses a path inside the real data directory (or a sibling sharing its name prefix), with no switch: the shared
 * judgement of ./realDataDir (the one localApi uses for token files) as a SnapshotUsageError. scripts/rehearsal.ts uses
 * this — a rehearsal never runs on the real data, whatever the environment says (M-M2-R2-3).
 */
export function refuseRealDataDir(label: string, path: string, envIn: NodeJS.ProcessEnv = process.env): void {
  const pre = realDataDirPrefixOf(path, envIn);
  if (pre !== null) throw new SnapshotUsageError(`${label} ${resolve(path)} is under the real data directory (${pre}…); refused`);
}

/**
 * data:snapshot's policy on top of the shared judgement: refuseRealDataDir unless SP_SNAPSHOT_ALLOW_REAL=1 — the
 * switch only the coordinator's cutover / rollback sets, and only for snapshot · verify · restore · compare.
 */
export function assertNotRealDataDir(label: string, path: string, envIn: NodeJS.ProcessEnv = process.env): void {
  if (envIn.SP_SNAPSHOT_ALLOW_REAL === '1') return;
  const pre = realDataDirPrefixOf(path, envIn);
  if (pre !== null) throw new SnapshotUsageError(`${label} ${resolve(path)} is under the real data directory (${pre}…); refused without SP_SNAPSHOT_ALLOW_REAL=1`);
}

const lexInside = (parent: string, child: string): boolean => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
};
/**
 * `child` is `parent` or inside it — as written, or between the real paths (the realpath of the nearest existing
 * ancestor + the missing rest, a dangling link counting as its target): a symbolic link that leads into the other
 * directory is the same place (M-M2-R2-4). Callers test both directions.
 */
export function isInside(parent: string, child: string): boolean {
  const [p, c] = [resolve(parent), resolve(child)];
  return lexInside(p, c) || lexInside(existingRealpath(p), existingRealpath(c));
}

/** A path argument that is itself a symbolic link is refused (an alias of another place; restore would move the link). */
export function refuseLinkArg(label: string, p: string): void {
  if (isSymlink(p)) throw new SnapshotUsageError(`${label} ${p} is a symbolic link; give the real directory`);
}

/**
 * The link-free tree rule (INTEGRATION_NOTES 결정 62, apps/server/src/security/dataTree.ts) for a directory argument:
 * no symbolic link inside it and no regular file sharing its inode with a file outside it — or the command would read
 * another place's DB as this one or chmod a shared inode. `data`: a data directory (its app entries: db/, papers/,
 * backups/, tmp/, claude-cwd/, run/, fixtures/); otherwise the whole tree (a snapshot). Exit 2, nothing done. The real data
 * directory under SP_SNAPSHOT_ALLOW_REAL keeps the same rule: a linked user tree stops the cutover.
 */
export function refuseLinkedTree(label: string, root: string, kind: 'data' | 'snapshot'): void {
  const link = findTreeLink(root, kind === 'data' ? APP_DATA_ENTRIES : undefined);
  if (link?.kind === 'symlink') throw new SnapshotUsageError(`${label} ${root}: ${link.rel} is a symbolic link; the tree must not contain links`);
  if (link?.kind === 'hardlink') throw new SnapshotUsageError(`${label} ${root}: ${link.rel} has ${link.links} hard links (${link.links - link.inTree} outside the tree); the tree must not share files`);
}

function requireDir(label: string, p: string): void {
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new SnapshotUsageError(`${label} ${p} is not a directory`);
}
function requireAbsent(label: string, p: string): void {
  if (existsSync(p) || isSymlink(p)) throw new SnapshotUsageError(`${label} ${p} already exists`);
}
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------- files

export function sha256File(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(COPY_CHUNK);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/** Byte copy through read/write (no copy_file_range / reflink, no link): a new inode with its own data. */
function copyBytes(src: string, dst: string, mode: number): void {
  const inFd = openSync(src, 'r');
  try {
    const outFd = openSync(dst, 'wx', mode);
    try {
      const buf = Buffer.allocUnsafe(COPY_CHUNK);
      for (let n; (n = readSync(inFd, buf, 0, buf.length, null)) > 0; ) {
        for (let off = 0; off < n; ) off += writeSync(outFd, buf, off, n - off);
      }
      fsyncSync(outFd);
    } finally {
      closeSync(outFd);
    }
  } finally {
    closeSync(inFd);
  }
  chmodSync(dst, mode);
}

/** Copies a tree of directories and regular files; anything else (symlink, socket …) is refused. A checkpoint after each file. */
async function copyTree(src: string, dst: string, fileMode: number, dirMode: number): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (s: string, d: string) => {
    mkdirSync(d, { mode: dirMode });
    chmodSync(d, dirMode);
    for (const name of readdirSync(s).sort()) {
      const sp = join(s, name);
      const dp = join(d, name);
      const st = lstatSync(sp);
      if (st.isDirectory()) await walk(sp, dp);
      else if (st.isFile()) {
        copyBytes(sp, dp, fileMode);
        files++;
        bytes += st.size;
        await checkpoint();
      } else throw new SnapshotUsageError(`${sp} is neither a regular file nor a directory (refused)`);
    }
  };
  await walk(src, dst);
  return { files, bytes };
}

interface Listing {
  files: string[];
  dirs: string[];
  /** Entries that are neither regular files nor directories. */
  others: string[];
}
/** Every entry under `root`, relative POSIX paths (lstat: symlinks are not followed). */
function listTree(root: string): Listing {
  const out: Listing = { files: [], dirs: [], others: [] };
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      const a = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(a);
      if (st.isDirectory()) {
        out.dirs.push(r);
        walk(a, r);
      } else if (st.isFile()) out.files.push(r);
      else out.others.push(r);
    }
  };
  walk(root, '');
  return out;
}

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

async function writeManifest(root: string): Promise<string> {
  const { files, others } = listTree(root);
  if (others.length) throw new SnapshotUsageError(`unexpected entries in ${root}: ${others.join(', ')}`);
  const lines: string[] = [];
  for (const f of files.filter((x) => x !== MANIFEST).sort(byteOrder)) {
    if (/[\n\r\\]/.test(f)) throw new SnapshotUsageError(`file name not representable in ${MANIFEST}: ${JSON.stringify(f)}`);
    lines.push(`${sha256File(join(root, f))}  ${f}\n`);
    await checkpoint();
  }
  writeFileSync(join(root, MANIFEST), lines.join(''), { mode: 0o600, flag: 'wx' });
  return sha256File(join(root, MANIFEST));
}

// ---------------------------------------------------------------------------------------------------------- DB access

/** Opens a COPY of `dbFile` (in a fresh 0700 temp dir) read-only; the copy is removed afterwards. */
// ---------------------------------------------------------------------------------------------------------- exit / signals

/**
 * The temporary DB copies (sp-snapdb-*: the user's whole DB during a cutover) that exist right now. withDbCopy removes
 * each in its finally; installSignalCleanup also removes them on process.exit (which skips every finally).
 */
const tempCopies = new Set<string>();
export function removeTempCopies(): void {
  for (const d of tempCopies) rmSync(d, { recursive: true, force: true });
  tempCopies.clear();
}
export type StopSignal = 'SIGINT' | 'SIGTERM';
/** A signal stopped the command at a checkpoint (exit 130 / 143); everything it had made so far is removed. */
export class SnapshotInterrupted extends Error {
  readonly exitCode: 130 | 143;
  constructor(readonly signal: StopSignal) {
    super(`interrupted by ${signal}`);
    this.exitCode = signal === 'SIGINT' ? 130 : 143;
  }
}
let received: StopSignal | null = null;
let signalCleanupInstalled = false;
/**
 * For the CLI (scripts/data-snapshot.ts): temp copies are removed on exit; SIGINT / SIGTERM are recorded (the first one
 * counts) and never end the process themselves — the command stops at its next checkpoint (or finishes when none is
 * left), and the CLI exits 130 / 143. Without this (the library in a test), signals keep their default.
 */
export function installSignalCleanup(): void {
  if (signalCleanupInstalled) return;
  signalCleanupInstalled = true;
  process.on('exit', removeTempCopies);
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.on(sig, () => {
      received ??= sig;
    });
}
/** The signal the CLI received, if any. */
export function receivedSignal(): StopSignal | null {
  return received;
}
const turn = () => new Promise<void>((r) => setImmediate(r));
/**
 * Lets a signal that came during the synchronous stretch before reach its handler: two event-loop turns, so that a
 * poll phase (where libuv hands a signal to its handler) has run in between. The CLI calls it before it reports.
 */
export async function settleSignals(): Promise<void> {
  await turn();
  await turn();
}
/** A checkpoint: settleSignals, then the command stops (SnapshotInterrupted) when a signal was received. */
async function checkpoint(): Promise<void> {
  await settleSignals();
  if (received !== null) throw new SnapshotInterrupted(received);
}

async function withDbCopy<T>(dbFile: string, fn: (db: Sqlite) => T | Promise<T>, onDbCopy?: (dir: string) => void): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sp-snapdb-'));
  tempCopies.add(dir);
  let db: Sqlite | undefined;
  try {
    chmodSync(dir, 0o700);
    const copy = join(dir, 'study_paper.sqlite');
    copyBytes(dbFile, copy, 0o600);
    onDbCopy?.(dir);
    await checkpoint();
    db = openSqlite(copy, { readonly: true });
    return await fn(db);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
    tempCopies.delete(dir);
  }
}

/** Opens the live DB read-only (lock held by the caller) and removes the empty -wal / the -shm it caused. */
async function withLiveDb<T>(dbFile: string, fn: (db: Sqlite) => T | Promise<T>): Promise<T> {
  const sidecars = ['-wal', '-shm'].map((s) => `${dbFile}${s}`).filter((f) => !existsSync(f));
  let db: Sqlite | undefined;
  try {
    db = openSqlite(dbFile, { readonly: true });
    return await fn(db);
  } finally {
    db?.close();
    for (const f of sidecars) {
      if (!existsSync(f)) continue;
      if (f.endsWith('-wal') && statSync(f).size !== 0) continue; // a read-only connection never writes one; keep it if it did
      rmSync(f, { force: true });
    }
  }
}

interface MigrationRow {
  tag: string;
  createdAt: number;
  hash: string;
}
function appliedMigrations(db: Sqlite): MigrationRow[] | null {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(MIGRATIONS_TABLE)) return null;
  const rows = db.prepare(`SELECT hash, created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at`).all() as { hash: string; created_at: number }[];
  let journal: { when: number; tag: string }[] = [];
  try {
    journal = (JSON.parse(readFileSync(join(DEFAULT_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: { when: number; tag: string }[] }).entries;
  } catch {
    journal = [];
  }
  return rows.map((r) => ({ tag: journal.find((e) => e.when === Number(r.created_at))?.tag ?? String(r.created_at), createdAt: Number(r.created_at), hash: r.hash }));
}
function tableCounts(db: Sqlite): Record<string, number> {
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, (db.prepare(`SELECT count(*) AS n FROM "${n.replace(/"/g, '""')}"`).get() as { n: number }).n]));
}

// ---------------------------------------------------------------------------------------------------------- lock

interface HeldLock {
  lock: InstanceLock;
  /** The run/ directory did not exist and was made for the lock. */
  madeRunDir: boolean;
}
function takeLock(dataDir: string): HeldLock {
  const paths = dataPaths(dataDir);
  const madeRunDir = !existsSync(paths.runDir);
  if (madeRunDir) mkdirSync(paths.runDir, { mode: 0o700 });
  try {
    return { lock: acquireInstanceLock(paths.lockFile, 'restore'), madeRunDir };
  } catch (e) {
    if (madeRunDir) rmdirSync(paths.runDir);
    if (e instanceof InstanceLockError) throw new SnapshotUsageError(e.holder ? `${dataDir} is in use by a study_paper ${e.holder.role} (pid ${e.holder.pid}); stop it first` : e.message);
    throw e;
  }
}
/** Releases the lock wherever the data directory now is (restore moves it); removes a run/ we made when empty. */
function dropLock(h: HeldLock, dirNow: string): void {
  const runDir = join(dirNow, 'run');
  const file = join(runDir, 'instance.lock');
  try {
    if (readFileSync(file, 'utf8') === JSON.stringify(h.lock.info)) rmSync(file, { force: true });
  } catch {
    /* not there */
  }
  if (h.madeRunDir) {
    try {
      if (readdirSync(runDir).length === 0) rmdirSync(runDir);
    } catch {
      /* gone */
    }
  }
}

// ---------------------------------------------------------------------------------------------------------- snapshot

export interface SnapshotResult {
  snapshot: string;
  source: string;
  files: number;
  bytes: number;
  papersFiles: number;
  tables: Record<string, number>;
  migrations: string[];
  manifestSha256: string;
}

/** `snapshot --data <dataDir> --out <snapDir>` (BRIEF_INTEGRATION I6 ①–⑥). */
export async function snapshot(o: { data: string; out: string }, se: SnapshotEnv = {}): Promise<SnapshotResult> {
  const env = se.env ?? process.env;
  const now = se.now ?? Date.now;
  const data = resolve(o.data);
  const out = resolve(o.out);
  assertNotRealDataDir('--data', data, env);
  assertNotRealDataDir('--out', out, env);
  refuseLinkArg('--data', data);
  refuseLinkArg('--out', out);
  requireDir('--data', data);
  const paths = dataPaths(data);
  if (!existsSync(paths.dbFile)) throw new SnapshotUsageError(`${paths.dbFile} does not exist`);
  requireAbsent('--out', out);
  requireDir('the parent of --out', dirname(out));
  if (isInside(data, out) || isInside(out, data)) throw new SnapshotUsageError('--out and --data must not contain each other (as written or by real path)');
  const staging = `${out}.partial-${process.pid}-${now()}`;
  requireAbsent('staging', staging);
  if (isInside(data, staging) || isInside(staging, data)) throw new SnapshotUsageError('the staging directory and --data must not contain each other (by real path)');
  refuseLinkedTree('--data', data, 'data');

  const held = takeLock(data);
  try {
    await checkpoint();
    let manifestSha256 = '';
    let tables: Record<string, number> = {};
    let migrations: MigrationRow[] = [];
    let papersFiles = 0;
    await withLiveDb(paths.dbFile, async (live) => {
      const busy = live.prepare(`SELECT (SELECT count(*) FROM llm_calls WHERE status IN ('queued','running')) AS calls, (SELECT count(*) FROM jobs WHERE status = 'running') AS jobs`).get() as { calls: number; jobs: number };
      if (busy.calls > 0 || busy.jobs > 0) throw new SnapshotUsageError(`the data directory has work in progress (llm_calls queued/running ${busy.calls}, jobs running ${busy.jobs})`);
      mkdirSync(staging, { mode: 0o700 });
      mkdirSync(join(staging, 'db'), { mode: 0o700 });
      try {
        await live.backup(join(staging, DB_REL));
      } catch (e) {
        throw new SnapshotCheckError(`backup failed: ${(e as Error).message}`, {});
      }
    });
    try {
      await checkpoint();
      chmodSync(join(staging, DB_REL), 0o600);
      for (const s of ['-wal', '-shm', '-journal']) if (existsSync(join(staging, `${DB_REL}${s}`))) throw new SnapshotCheckError(`the backup left ${DB_REL}${s}`, {});
      await withDbCopy(join(staging, DB_REL), async (db) => {
        const integrity = db.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new SnapshotCheckError(`integrity_check of the backup returned ${String(integrity)}`, {});
        await checkpoint();
        const fk = db.pragma('foreign_key_check') as unknown[];
        if (fk.length > 0) throw new SnapshotCheckError(`foreign_key_check of the backup returned ${fk.length} row(s)`, {});
        const m = appliedMigrations(db);
        if (m === null) throw new SnapshotCheckError(`the DB has no ${MIGRATIONS_TABLE} table (not a study_paper DB)`, {});
        migrations = m;
        tables = tableCounts(db);
      }, se.onDbCopy);
      if (existsSync(paths.papersDir)) {
        if (!lstatSync(paths.papersDir).isDirectory()) throw new SnapshotUsageError(`${paths.papersDir} is not a directory`);
        papersFiles = (await copyTree(paths.papersDir, join(staging, 'papers'), 0o600, 0o700)).files;
      } else mkdirSync(join(staging, 'papers'), { mode: 0o700 });
      const meta = { format: 1, createdAt: new Date(now()).toISOString(), source: data, migrations, tables, papersFiles };
      writeFileSync(join(staging, SNAPSHOT_JSON), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      manifestSha256 = await writeManifest(staging);
      await checkpoint(); // the last one: after the rename the snapshot is complete
      renameSync(staging, out);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    const { files } = listTree(out);
    const bytes = files.reduce((s, f) => s + statSync(join(out, f)).size, 0);
    return { snapshot: out, source: data, files: files.length, bytes, papersFiles, tables, migrations: migrations.map((m) => m.tag), manifestSha256 };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  } finally {
    dropLock(held, data);
  }
}

// ---------------------------------------------------------------------------------------------------------- verify

export interface VerifyFailure {
  check: 'm' | 'd' | 'a' | 'b' | 'c';
  what: string;
  /** Path relative to the snapshot, or a row id. */
  ref?: string;
}
export interface VerifyResult {
  ok: boolean;
  snapshot: string;
  failures: VerifyFailure[];
  /** Failures listed (the count is exact). */
  failureCount: number;
  manifestFiles: number;
  filesRows: number;
  paperRows: number;
  paperDirs: number;
  /** (c) papers rows without a directory and without files rows (failed imports): allowed, counted. */
  papersWithoutDir: number;
  /** Files under papers/ that no files row points at (reported only). */
  unreferencedFiles: number;
  migrations: string[];
  sealed: boolean;
}
const FAILURES_LISTED = DIFF_ID_LIST_MAX;

/** The checks of `verify` on a snapshot-shaped directory (also restore's staging). Changes nothing. */
export async function verifyDir(root: string, onDbCopy?: (dir: string) => void): Promise<VerifyResult> {
  const failures: VerifyFailure[] = [];
  let failureCount = 0;
  const fail = (f: VerifyFailure) => {
    failureCount++;
    if (failures.length < FAILURES_LISTED) failures.push(f);
  };
  const res: VerifyResult = { ok: false, snapshot: root, failures, failureCount: 0, manifestFiles: 0, filesRows: 0, paperRows: 0, paperDirs: 0, papersWithoutDir: 0, unreferencedFiles: 0, migrations: [], sealed: false };

  // (m) MANIFEST
  const listing = listTree(root);
  for (const o of listing.others) fail({ check: 'm', what: 'not a regular file or directory', ref: o });
  // The top level holds the set and its two records only (an empty extra directory has no file to miss in the manifest,
  // and restore would refuse it after verify passed).
  if (existsSync(root)) for (const n of readdirSync(root).sort(byteOrder)) if (!TOP_LEVEL.has(n)) fail({ check: 'm', what: 'unexpected top-level entry', ref: n });
  const listed = new Map<string, string>();
  if (!listing.files.includes(MANIFEST)) fail({ check: 'm', what: `${MANIFEST} missing` });
  else {
    const text = readFileSync(join(root, MANIFEST), 'utf8');
    const lines = text.split('\n');
    if (lines.pop() !== '') fail({ check: 'm', what: `${MANIFEST} does not end with a newline` });
    for (const line of lines) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (!m) {
        fail({ check: 'm', what: 'malformed manifest line' });
        continue;
      }
      if (listed.has(m[2]!)) fail({ check: 'm', what: 'listed twice', ref: m[2]! });
      listed.set(m[2]!, m[1]!);
    }
    const sorted = [...listed.keys()];
    if (sorted.join('\n') !== [...sorted].sort(byteOrder).join('\n')) fail({ check: 'm', what: 'manifest not sorted by path' });
  }
  res.manifestFiles = listed.size;
  const present = new Set(listing.files.filter((f) => f !== MANIFEST));
  for (const [rel, sha] of listed) {
    if (!present.has(rel)) fail({ check: 'm', what: 'listed file missing', ref: rel });
    else if (sha256File(join(root, rel)) !== sha) fail({ check: 'm', what: 'sha256 differs from the manifest', ref: rel });
    await checkpoint();
  }
  for (const rel of present) if (!listed.has(rel)) fail({ check: 'm', what: 'file not in the manifest', ref: rel });

  // (d) DB on a copy, then (a)(b)(c) from the same copy
  const dbFile = join(root, DB_REL);
  if (!existsSync(dbFile) || !lstatSync(dbFile).isFile()) fail({ check: 'd', what: `${DB_REL} missing` });
  else {
    try {
      await withDbCopy(dbFile, async (db) => {
        const integrity = db.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') fail({ check: 'd', what: `integrity_check returned ${String(integrity)}` });
        await checkpoint();
        const fk = db.pragma('foreign_key_check') as unknown[];
        if (fk.length > 0) fail({ check: 'd', what: `foreign_key_check returned ${fk.length} row(s)` });
        await checkpoint();
        const mig = appliedMigrations(db);
        if (mig === null) {
          fail({ check: 'd', what: `no ${MIGRATIONS_TABLE} table` });
          return;
        }
        res.migrations = mig.map((m) => m.tag);
        if (existsSync(join(root, SNAPSHOT_JSON))) {
          try {
            const meta = JSON.parse(readFileSync(join(root, SNAPSHOT_JSON), 'utf8')) as { migrations?: MigrationRow[] };
            const want = (meta.migrations ?? []).map((m) => `${m.createdAt}:${m.hash}`).join(',');
            if (want !== mig.map((m) => `${m.createdAt}:${m.hash}`).join(',')) fail({ check: 'd', what: `migration table differs from ${SNAPSHOT_JSON}` });
          } catch {
            fail({ check: 'd', what: `${SNAPSHOT_JSON} is not readable JSON` });
          }
        }
        // (a) every files row ↔ a file of the snapshot
        const rows = db.prepare(`SELECT id, paperId, relPath, sha256, bytes FROM files ORDER BY id`).all() as { id: string; paperId: string; relPath: unknown; sha256: string; bytes: number }[];
        res.filesRows = rows.length;
        const referenced = new Set<string>();
        for (const r of rows) {
          await checkpoint();
          const rel = r.relPath;
          if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0') || posix.isAbsolute(rel) || posix.normalize(rel) !== rel || !rel.startsWith('papers/') || rel.split('/').includes('..')) {
            fail({ check: 'a', what: 'relPath is not a normalized path under papers/', ref: r.id });
            continue;
          }
          referenced.add(rel);
          const abs = join(root, ...rel.split('/'));
          let st;
          try {
            st = lstatSync(abs);
          } catch {
            fail({ check: 'a', what: 'file of a files row missing', ref: r.id });
            continue;
          }
          if (!st.isFile()) fail({ check: 'a', what: 'files row points at a non-regular file', ref: r.id });
          else if (st.size !== r.bytes) fail({ check: 'a', what: 'bytes differ from the files row', ref: r.id });
          else if (sha256File(abs) !== r.sha256) fail({ check: 'a', what: 'sha256 differs from the files row', ref: r.id });
        }
        res.unreferencedFiles = [...present].filter((f) => f.startsWith('papers/') && !referenced.has(f)).length;
        // (b) every papers/<id>/ directory has a papers row
        const paperIds = new Set((db.prepare(`SELECT id FROM papers`).all() as { id: string }[]).map((r) => r.id));
        res.paperRows = paperIds.size;
        const papersDir = join(root, 'papers');
        const dirs = new Set<string>();
        if (!existsSync(papersDir) || !lstatSync(papersDir).isDirectory()) fail({ check: 'b', what: 'papers/ missing' });
        else {
          for (const name of readdirSync(papersDir)) {
            const st = lstatSync(join(papersDir, name));
            if (!st.isDirectory()) fail({ check: 'b', what: 'entry in papers/ is not a directory', ref: `papers/${name}` });
            else {
              dirs.add(name);
              if (!paperIds.has(name)) fail({ check: 'b', what: 'paper directory without a papers row', ref: `papers/${name}` });
            }
          }
        }
        res.paperDirs = dirs.size;
        // (c) a papers row without a directory only when it has no files rows
        const filesPerPaper = new Map<string, number>();
        for (const r of rows) filesPerPaper.set(r.paperId, (filesPerPaper.get(r.paperId) ?? 0) + 1);
        for (const id of paperIds) {
          if (dirs.has(id)) continue;
          if ((filesPerPaper.get(id) ?? 0) === 0) res.papersWithoutDir++;
          else fail({ check: 'c', what: 'papers row without a directory has files rows', ref: id });
        }
      }, onDbCopy);
    } catch (e) {
      if (e instanceof SnapshotInterrupted) throw e;
      fail({ check: 'd', what: `the DB could not be read: ${(e as Error).message}` });
    }
  }
  res.failureCount = failureCount;
  res.ok = failureCount === 0;
  return res;
}

function seal(root: string): void {
  const { files, dirs } = listTree(root);
  for (const f of files) chmodSync(join(root, f), 0o444);
  for (const d of dirs.sort((a, b) => b.length - a.length)) chmodSync(join(root, d), 0o555);
  chmodSync(root, 0o555);
}

/** `verify --snapshot <snapDir> [--seal]`. Throws SnapshotCheckError (exit 1) on any failure; changes nothing then. */
export async function verify(o: { snapshot: string; seal?: boolean }, se: SnapshotEnv = {}): Promise<VerifyResult> {
  const env = se.env ?? process.env;
  const snap = resolve(o.snapshot);
  assertNotRealDataDir('--snapshot', snap, env);
  refuseLinkArg('--snapshot', snap);
  requireDir('--snapshot', snap);
  refuseLinkedTree('--snapshot', snap, 'snapshot');
  const r = await verifyDir(snap, se.onDbCopy);
  if (!r.ok) throw new SnapshotCheckError(`verify failed (${r.failureCount} failure(s))`, { ...r });
  await checkpoint(); // not sealed after a signal
  if (o.seal) {
    seal(snap);
    r.sealed = true;
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------- restore

export interface RestoreResult {
  ok: boolean;
  data: string;
  snapshot: string;
  /** Where the replaced live directory went (never deleted). null when nothing was swapped. */
  aside: string | null;
  staging: string;
  /** Where the user's data is when the restore stopped half-way (aside after a failed rename back). */
  dataAt: string;
  verify: VerifyResult | null;
  error?: string;
}

/** `restore --snapshot <snapDir> --data <dataDir>` (BRIEF_INTEGRATION I6 ①–⑤). */
export async function restore(o: { snapshot: string; data: string }, se: SnapshotEnv = {}): Promise<RestoreResult> {
  const env = se.env ?? process.env;
  const now = se.now ?? Date.now;
  const rename = se.rename ?? renameSync;
  const snap = resolve(o.snapshot);
  const data = resolve(o.data);
  assertNotRealDataDir('--snapshot', snap, env);
  assertNotRealDataDir('--data', data, env);
  refuseLinkArg('--snapshot', snap);
  refuseLinkArg('--data', data);
  requireDir('--snapshot', snap);
  requireDir('--data', data);
  if (isInside(data, snap) || isInside(snap, data)) throw new SnapshotUsageError('--snapshot and --data must not contain each other (as written or by real path)');
  // --data must look like a data directory (the server always makes db/ and papers/) or be empty: a mistyped path must
  // not be moved aside and replaced.
  const isDirAt = (n: string) => {
    try {
      return lstatSync(join(data, n)).isDirectory();
    } catch {
      return false;
    }
  };
  if (readdirSync(data).length > 0 && !(isDirAt('db') && isDirAt('papers'))) throw new SnapshotUsageError(`--data ${data} is not a data directory (no db/ and papers/) and not empty; nothing changed`);
  const epoch = now();
  const staging = `${data}.restore-${epoch}`;
  const aside = join(dirname(data), `${basename(data)}-m2-aside-${epoch}`);
  assertNotRealDataDir('staging', staging, env);
  assertNotRealDataDir('aside', aside, env);
  requireAbsent('staging', staging);
  requireAbsent('aside', aside);
  for (const [label, p] of [['staging', staging], ['aside', aside]] as const) if (isInside(snap, p) || isInside(p, snap) || isInside(data, p)) throw new SnapshotUsageError(`the ${label} directory must be outside --snapshot and --data (by real path)`);
  refuseLinkedTree('--snapshot', snap, 'snapshot');
  refuseLinkedTree('--data', data, 'data');

  const held = takeLock(data);
  let dirNow = data;
  const base: RestoreResult = { ok: false, data, snapshot: snap, aside: null, staging, dataAt: data, verify: null };
  try {
    // ② writable copy, ③ verify it — any failure or signal up to rename 1 removes the staging; live is untouched
    try {
      try {
        await copyTree(snap, staging, 0o600, 0o700);
      } catch (e) {
        if (e instanceof SnapshotInterrupted) throw e;
        throw new SnapshotCheckError(`copying the snapshot failed: ${(e as Error).message}`, { ...base, error: (e as Error).message });
      }
      const v = await verifyDir(staging, se.onDbCopy);
      base.verify = { ...v, snapshot: snap };
      if (!v.ok) throw new SnapshotCheckError(`the snapshot copy failed verify (${v.failureCount} failure(s)); ${data} is unchanged`, { ...base, error: 'verify failed' });
      rmSync(join(staging, SNAPSHOT_JSON), { force: true });
      rmSync(join(staging, MANIFEST), { force: true });
      const top = readdirSync(staging).sort();
      if (top.join(',') !== 'db,papers') throw new SnapshotCheckError(`unexpected top-level entries in the snapshot: ${top.join(', ')}; ${data} is unchanged`, { ...base, error: 'unexpected entries' });
      chmodSync(staging, 0o700);
      // the last checkpoint: from rename 1 on, nothing yields until both renames are done (or the first is undone)
      await checkpoint();
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    // ④ rename 1: live → aside
    try {
      rename(data, aside);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw new SnapshotCheckError(`moving ${data} aside failed: ${(e as Error).message}; ${data} is unchanged`, { ...base, error: (e as Error).message });
    }
    dirNow = aside;
    // rename 2: staging → live
    try {
      rename(staging, data);
    } catch (e2) {
      try {
        rename(aside, data);
      } catch (e3) {
        // Nothing more is touched: the user's data is in the aside.
        base.aside = aside;
        base.dataAt = aside;
        const msg = `restore failed and moving the data back failed too: the data is at ${aside} (staging ${staging} left as it is): ${(e2 as Error).message}; ${(e3 as Error).message}`;
        process.stderr.write(`data-snapshot: ${msg}\n`);
        throw new SnapshotCheckError(msg, { ...base, error: msg });
      }
      dirNow = data;
      rmSync(staging, { recursive: true, force: true });
      throw new SnapshotCheckError(`installing the snapshot failed: ${(e2 as Error).message}; ${data} was put back unchanged`, { ...base, error: (e2 as Error).message });
    }
    return { ...base, ok: true, aside, dataAt: data };
  } finally {
    dropLock(held, dirNow);
  }
}

// ---------------------------------------------------------------------------------------------------------- compare

export interface PdfCheck {
  papers: number;
  ok: number;
  /** Paper ids (no text). */
  missingPaper: string[];
  missingFilesRow: string[];
  shaDiffersFromSnapshot: string[];
  fileMissing: string[];
  fileShaDiffers: string[];
}
export interface CompareResult {
  ok: boolean;
  snapshot: string;
  data: string;
  tables: TableDiff[];
  pdf: PdfCheck;
}

/** `compare --snapshot <snapDir> --data <dataDir> --out <dir>`: the 4 tables + the snapshot papers' PDFs. */
export async function compare(o: { snapshot: string; data: string }, se: SnapshotEnv = {}): Promise<CompareResult> {
  const env = se.env ?? process.env;
  const snap = resolve(o.snapshot);
  const data = resolve(o.data);
  assertNotRealDataDir('--snapshot', snap, env);
  assertNotRealDataDir('--data', data, env);
  refuseLinkArg('--snapshot', snap);
  refuseLinkArg('--data', data);
  requireDir('--snapshot', snap);
  requireDir('--data', data);
  if (isInside(data, snap) || isInside(snap, data)) throw new SnapshotUsageError('--snapshot and --data must not contain each other (as written or by real path)');
  refuseLinkedTree('--snapshot', snap, 'snapshot');
  refuseLinkedTree('--data', data, 'data');
  const snapDb = join(snap, DB_REL);
  const paths = dataPaths(data);
  if (!existsSync(snapDb)) throw new SnapshotUsageError(`${snapDb} does not exist`);
  if (!existsSync(paths.dbFile)) throw new SnapshotUsageError(`${paths.dbFile} does not exist`);
  const held = takeLock(data);
  try {
    await checkpoint();
    return await withLiveDb(paths.dbFile, (live) =>
      withDbCopy(snapDb, async (s) => {
        const tables = compareTables(s, live, DUMP_TABLES);
        await checkpoint();
        const pdf: PdfCheck = { papers: 0, ok: 0, missingPaper: [], missingFilesRow: [], shaDiffersFromSnapshot: [], fileMissing: [], fileShaDiffers: [] };
        const snapPdfs = s.prepare(`SELECT p.id AS id, f.sha256 AS sha FROM papers p JOIN files f ON f.paperId = p.id AND f.kind = 'pdf' ORDER BY p.id, f.id`).all() as { id: string; sha: string }[];
        for (const sp of snapPdfs) {
          await checkpoint();
          pdf.papers++;
          if (!live.prepare(`SELECT 1 FROM papers WHERE id = ?`).get(sp.id)) {
            pdf.missingPaper.push(sp.id);
            continue;
          }
          const rows = live.prepare(`SELECT relPath, sha256 FROM files WHERE paperId = ? AND kind = 'pdf'`).all(sp.id) as { relPath: string; sha256: string }[];
          const row = rows.find((r) => r.sha256 === sp.sha) ?? rows[0];
          if (!row) {
            pdf.missingFilesRow.push(sp.id);
            continue;
          }
          if (row.sha256 !== sp.sha) {
            pdf.shaDiffersFromSnapshot.push(sp.id);
            continue;
          }
          const rel = row.relPath;
          if (typeof rel !== 'string' || !rel.startsWith('papers/') || posix.normalize(rel) !== rel || rel.split('/').includes('..')) {
            pdf.fileMissing.push(sp.id);
            continue;
          }
          const abs = join(data, ...rel.split('/'));
          if (!existsSync(abs) || !lstatSync(abs).isFile()) pdf.fileMissing.push(sp.id);
          else if (sha256File(abs) !== row.sha256) pdf.fileShaDiffers.push(sp.id);
          else pdf.ok++;
        }
        const ok = tables.every((t) => t.equal) && pdf.ok === pdf.papers;
        return { ok, snapshot: snap, data, tables, pdf };
      }, se.onDbCopy),
    );
  } finally {
    dropLock(held, data);
  }
}
