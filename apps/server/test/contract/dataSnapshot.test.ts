// data-snapshot (BRIEF_INTEGRATION I6, PLAN_M2 7절 6): snapshot / verify / restore / compare on temp directories with the
// four seed papers + one capture. Owner: supervisor. Never touches the user's data directory.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertNotRealDataDir, compare, DB_REL, MANIFEST, restore, sha256File, snapshot, SNAPSHOT_JSON, SnapshotCheckError, SnapshotUsageError, verify, type RenameFn } from '../../../../scripts/lib/dataSnapshot';
import { storeCapture } from '../../src/captures';
import { openSqlite, toDrizzle } from '../../src/db/client';
import { migrateWithBackup } from '../../src/db/migrate';
import { ALL_SEED_PAPERS, SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID, SEED_PAPER_ID, SEED_UPGRADE_PAPER_ID, seedFixture } from '../../src/dev/seedFixture';
import { acquireInstanceLock } from '../../src/instanceLock';
import { dataPaths, ensureDataDirs } from '../../src/paths';
import { makeTestPngBase64 } from '../helpers/png';
import { REPO_ROOT, runCommand, runProbe, waitFor } from '../helpers/proc';
import { startTestServer } from '../helpers/server';
import { fileTempDir, tempDir } from '../helpers/tmp';

const NOW = 1_700_000_000_000;
let TEMPLATE = '';
let CAPTURE_FILE_ID = '';

/** Seed data dir: 4 seed papers, one area highlight with a capture PNG, a thread with two messages and a citation. */
async function makeSeeded(dir: string): Promise<void> {
  const paths = dataPaths(dir);
  ensureDataDirs(paths);
  const sqlite = openSqlite(paths.dbFile);
  await migrateWithBackup(sqlite, { backupsDir: paths.backupsDir });
  const db = toDrizzle(sqlite);
  await seedFixture(db, sqlite, paths, NOW, { papers: ALL_SEED_PAPERS });
  const c = storeCapture({ paths, sqlite }, SEED_M2_PAPER_ID, makeTestPngBase64({ width: 20, height: 10 }));
  db.transaction((tx) => c.insertRow(tx));
  CAPTURE_FILE_ID = c.fileId;
  sqlite.prepare(`INSERT INTO highlights (id, paperId, kind, color, page, rectsJson, imageFileId, createdAt, updatedAt) VALUES ('h-area', ?, 'area', 1, 1, '[]', ?, 1, 1)`).run(SEED_M2_PAPER_ID, c.fileId);
  sqlite.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t1', ?, 'chat', 'x', 1, 1)`).run(SEED_M2_PAPER_ID);
  sqlite.exec(`INSERT INTO messages (id, threadId, role, contentMd, status, createdAt) VALUES ('u1','t1','user','q','complete',1), ('a1','t1','assistant','a','complete',2)`);
  sqlite.exec(`INSERT INTO citations (id, ownerType, ownerId, ordinal, kind, quote, status, score) VALUES ('c1','message','a1',1,'quote','x','verbatim',1)`);
  sqlite.close();
}

beforeAll(async () => {
  TEMPLATE = join(fileTempDir('sp-snap-tpl-'), 'data');
  await makeSeeded(TEMPLATE);
}, 60_000);

/** A fresh copy of the seeded data dir (the "live" directory of a test). */
function freshData(): string {
  const d = join(tempDir('sp-snap-'), 'data');
  cpSync(TEMPLATE, d, { recursive: true });
  return d;
}
const snapDirNear = (data: string) => join(data, '..', 'snap');

/** rel path → sha256 of every regular file under dir (lstat; a symlink or other entry is listed as such). */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const n of readdirSync(abs).sort()) {
      const a = join(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(a);
      if (st.isDirectory()) walk(a, r);
      else out[r] = st.isFile() ? sha256File(a) : 'not-a-file';
    }
  };
  walk(dir, '');
  return out;
}
/** Only db/ and papers/ (the set). */
const setOf = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('db/') || k.startsWith('papers/')));
const withDb = <T>(dir: string, fn: (db: ReturnType<typeof openSqlite>) => T): T => {
  const db = openSqlite(join(dir, DB_REL));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
/** Reads a (possibly sealed) snapshot DB through a copy. */
const readSnapDb = <T>(snap: string, fn: (db: ReturnType<typeof openSqlite>) => T): T => {
  const d = tempDir('sp-snap-read-');
  cpSync(join(snap, DB_REL), join(d, 'x.sqlite'));
  chmodSync(join(d, 'x.sqlite'), 0o600);
  const db = openSqlite(join(d, 'x.sqlite'), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
function unseal(dir: string): void {
  chmodSync(dir, 0o755);
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (lstatSync(p).isDirectory()) unseal(p);
    else chmodSync(p, 0o644);
  }
}
async function expectReject<E>(p: Promise<unknown> | (() => unknown), cls: new (...a: never[]) => E): Promise<E> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(cls);
    return e as E;
  }
  throw new Error('expected a rejection');
}
const checksOf = (e: SnapshotCheckError) => [...new Set((e.result.failures as { check: string }[]).map((f) => f.check))].sort();

/**
 * A preload (NODE_OPTIONS --import) that injects one fault into the CLI process, chosen by SNAPTEST_FAULT:
 * `sealfail` = the first chmod to 0444 (verify --seal, after verify passed) throws a plain Error · `reportgone` = when
 * the first temp DB copy (sp-snapdb-*) is made — after the CLI checked --report — the directory SNAPTEST_REPORT is
 * replaced by a file, so the report can no longer be written at the end.
 */
const FAULT_PRELOAD = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const fault = process.env.SNAPTEST_FAULT;
if (fault && (process.argv[1] ?? '').endsWith('data-snapshot.ts')) {
  const { chmodSync, mkdtempSync, rmSync, writeFileSync } = fs;
  fs.chmodSync = function (p, mode) {
    if (fault === 'sealfail' && mode === 0o444) throw new Error('injected fault: chmod ' + String(p));
    return chmodSync.call(this, p, mode);
  };
  let gone = false;
  fs.mkdtempSync = function (prefix, ...rest) {
    const d = mkdtempSync.call(this, prefix, ...rest);
    if (fault === 'reportgone' && !gone && String(prefix).includes('sp-snapdb-')) {
      gone = true;
      rmSync(process.env.SNAPTEST_REPORT, { recursive: true, force: true });
      writeFileSync(process.env.SNAPTEST_REPORT, '');
    }
    return d;
  };
  syncBuiltinESMExports();
}
`;
let faultPreload = '';
function faultEnv(fault: string): Record<string, string> {
  if (faultPreload === '') {
    const f = join(fileTempDir('sp-snap-fault-'), 'fault.mjs');
    writeFileSync(f, FAULT_PRELOAD);
    faultPreload = pathToFileURL(f).href;
  }
  return { NODE_OPTIONS: `--import=${faultPreload}`, SNAPTEST_FAULT: fault };
}

describe('data-snapshot (I6)', () => {
  it('1. snapshot → verify → live changed (paper deleted, file added, row added) → restore: every set file of live = snapshot, the aside keeps the changed state, DB integrity ok', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    const s = await snapshot({ data, out: snap });
    expect(s.tables).toMatchObject({ papers: 4, threads: 1, messages: 2, citations: 1, highlights: 1 });
    expect(s.migrations).toEqual(['0000_init', '0001_citations_triggers', '0002_m2', '0003_api', '0004_study_path', '0005_overview']);
    const v = await verify({ snapshot: snap });
    expect(v).toMatchObject({ ok: true, failureCount: 0, paperRows: 4, paperDirs: 4, papersWithoutDir: 0, unreferencedFiles: 0 });
    const snapSet = Object.fromEntries(Object.entries(tree(snap)).filter(([k]) => k !== SNAPSHOT_JSON && k !== MANIFEST));

    withDb(data, (db) => {
      db.prepare(`DELETE FROM papers WHERE id = ?`).run(SEED_LINKS_PAPER_ID);
      db.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t-after', ?, 'chat', 'later', 5, 5)`).run(SEED_PAPER_ID);
    });
    rmSync(join(data, 'papers', SEED_LINKS_PAPER_ID), { recursive: true });
    writeFileSync(join(data, 'papers', SEED_M2_PAPER_ID, 'added.bin'), 'later');

    const r = await restore({ snapshot: snap, data }, { now: () => NOW });
    expect(r.ok).toBe(true);
    expect(r.aside).toBe(join(data, '..', `data-m2-aside-${NOW}`));
    expect(setOf(tree(data))).toEqual(snapSet);
    withDb(data, (db) => {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare(`SELECT count(*) AS n FROM papers`).get()).toEqual({ n: 4 });
      expect(db.prepare(`SELECT id FROM threads ORDER BY id`).all()).toEqual([{ id: 't1' }]);
    });
    // the replaced directory is kept with the changed state
    expect(existsSync(join(r.aside!, 'papers', SEED_M2_PAPER_ID, 'added.bin'))).toBe(true);
    expect(existsSync(join(r.aside!, 'papers', SEED_LINKS_PAPER_ID))).toBe(false);
    withDb(r.aside!, (db) => expect(db.prepare(`SELECT id FROM threads ORDER BY id`).all()).toEqual([{ id: 't-after' }, { id: 't1' }]));
    expect(existsSync(r.staging)).toBe(false);
  });

  it('2. a failed import (papers row, no directory, no files rows) passes and is counted; the same row with a files row fails (c)', async () => {
    const data = freshData();
    withDb(data, (db) => db.prepare(`INSERT INTO papers (id, source, title, ingestStatus, createdAt, updatedAt) VALUES ('p-failed','arxiv','x','failed',1,1)`).run());
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap });
    expect(await verify({ snapshot: snap })).toMatchObject({ ok: true, papersWithoutDir: 1 });

    const data2 = freshData();
    withDb(data2, (db) => {
      db.prepare(`INSERT INTO papers (id, source, title, ingestStatus, createdAt, updatedAt) VALUES ('p-failed','arxiv','x','failed',1,1)`).run();
      db.prepare(`INSERT INTO files (id, paperId, kind, relPath, sha256, bytes, mime, createdAt) VALUES ('f-x','p-failed','pdf','papers/p-failed/paper.pdf','${'0'.repeat(64)}',1,'application/pdf',1)`).run();
    });
    const snap2 = snapDirNear(data2);
    await snapshot({ data: data2, out: snap2 });
    const e = await expectReject(() => verify({ snapshot: snap2 }), SnapshotCheckError);
    expect(checksOf(e)).toEqual(['a', 'c']);
    expect(e.result.failures).toContainEqual({ check: 'c', what: 'papers row without a directory has files rows', ref: 'p-failed' });
  });

  it('3. (b) a paper directory without a papers row; (a) files row → file missing / other sha / other bytes / relPath escaping papers/', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap });
    mkdirSync(join(snap, 'papers', 'orphan-dir'));
    const eb = await expectReject(() => verify({ snapshot: snap }), SnapshotCheckError);
    expect(checksOf(eb)).toEqual(['b']);
    expect(eb.result.failures).toEqual([{ check: 'b', what: 'paper directory without a papers row', ref: 'papers/orphan-dir' }]);

    const pdfOf = (id: string) => `papers/${id}/paper.pdf`;
    const cases: [string, (d: string) => void, string][] = [
      ['missing', (d) => rmSync(join(d, pdfOf(SEED_PAPER_ID))), 'file of a files row missing'],
      ['sha', (d) => withDb(d, (db) => db.prepare(`UPDATE files SET sha256 = ? WHERE paperId = ? AND kind = 'pdf'`).run('0'.repeat(64), SEED_PAPER_ID)), 'sha256 differs from the files row'],
      ['bytes', (d) => withDb(d, (db) => db.prepare(`UPDATE files SET bytes = bytes + 1 WHERE paperId = ? AND kind = 'pdf'`).run(SEED_PAPER_ID)), 'bytes differ from the files row'],
      ['escape', (d) => withDb(d, (db) => db.prepare(`UPDATE files SET relPath = ? WHERE paperId = ? AND kind = 'pdf'`).run(`papers/../${DB_REL}`, SEED_PAPER_ID)), 'relPath is not a normalized path under papers/'],
      ['absolute', (d) => withDb(d, (db) => db.prepare(`UPDATE files SET relPath = ? WHERE paperId = ? AND kind = 'pdf'`).run(join(d, pdfOf(SEED_PAPER_ID)), SEED_PAPER_ID)), 'relPath is not a normalized path under papers/'],
    ];
    for (const [name, mutate, what] of cases) {
      const d = freshData();
      mutate(d);
      const sn = join(d, '..', `snap-${name}`);
      await snapshot({ data: d, out: sn });
      const e = await expectReject(() => verify({ snapshot: sn }), SnapshotCheckError);
      expect(checksOf(e), name).toEqual(['a']);
      expect((e.result.failures as { what: string }[]).map((f) => f.what), name).toEqual([what]);
    }
  });

  it('4. MANIFEST: snapshot and two unsealed verifies leave exactly the listed files; 1 byte changed / file added / file removed → (m)', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap });
    const listed = () =>
      readFileSync(join(snap, MANIFEST), 'utf8')
        .trim()
        .split('\n')
        .map((l) => l.slice(66));
    const files = () => Object.keys(tree(snap)).filter((f) => f !== MANIFEST);
    expect(files().sort()).toEqual([...listed()].sort());
    expect(listed()).toEqual([...listed()].sort());
    expect(listed()).toContain(DB_REL);
    expect(listed()).toContain(SNAPSHOT_JSON);
    expect(listed()).toContain(`papers/${SEED_M2_PAPER_ID}/captures/${CAPTURE_FILE_ID}.png`);
    await verify({ snapshot: snap });
    await verify({ snapshot: snap });
    expect(files().sort()).toEqual([...listed()].sort()); // no -shm / -wal grew next to the snapshot DB
    if (existsSync('/usr/bin/sha256sum')) {
      const sum = await runCommand('/usr/bin/sha256sum', ['--quiet', '-c', MANIFEST], { cwd: snap });
      expect(sum.status, sum.stdout + sum.stderr).toBe(0);
    }

    const mutations: [string, (s: string) => void][] = [
      ['byte', (s) => appendFileSync(join(s, SNAPSHOT_JSON), ' ')],
      ['added', (s) => writeFileSync(join(s, 'papers', SEED_M2_PAPER_ID, 'stray.txt'), 'x')],
      ['removed', (s) => rmSync(join(s, SNAPSHOT_JSON))],
      ['top-level dir', (s) => mkdirSync(join(s, 'extra'))],
    ];
    for (const [name, mutate] of mutations) {
      const s2 = join(snap, '..', `snap-${name}`);
      cpSync(snap, s2, { recursive: true });
      mutate(s2);
      const e = await expectReject(() => verify({ snapshot: s2 }), SnapshotCheckError);
      expect(checksOf(e), name).toContain('m');
      expect(checksOf(e).filter((c) => c !== 'm' && c !== 'd'), name).toEqual([]);
    }
    // an empty extra directory at the top level: (m) only, and restore stops at the same check with live unchanged
    const s3 = join(snap, '..', 'snap-top');
    cpSync(snap, s3, { recursive: true });
    mkdirSync(join(s3, 'extra'));
    const et = await expectReject(() => verify({ snapshot: s3 }), SnapshotCheckError);
    expect(et.result.failures).toEqual([{ check: 'm', what: 'unexpected top-level entry', ref: 'extra' }]);
    const before = tree(data);
    const er = await expectReject(() => restore({ snapshot: s3, data }, { now: () => NOW }), SnapshotCheckError);
    expect(er.message).toMatch(/failed verify/);
    expect(tree(data)).toEqual(before);
    expect(existsSync(join(data, '..', `data-m2-aside-${NOW}`))).toBe(false);
    expect(existsSync(join(data, '..', `data.restore-${NOW}`))).toBe(false);
  });

  it('5. restore whose staging fails verify: live unchanged (every file), no staging, no aside, exit-1 error', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap });
    appendFileSync(join(snap, 'papers', SEED_PAPER_ID, 'paper.pdf'), 'x'); // injected verify failure
    const before = tree(data);
    const e = await expectReject(() => restore({ snapshot: snap, data }, { now: () => NOW }), SnapshotCheckError);
    expect(e.exitCode).toBe(1);
    expect(tree(data)).toEqual(before);
    expect(readdirSync(join(data, '..')).sort()).toEqual(['data', 'snap']);
  });

  it('5b. restore whose second rename throws: the aside is renamed back — live unchanged, no aside, no staging', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap });
    withDb(data, (db) => db.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t-after', ?, 'chat', 'later', 5, 5)`).run(SEED_PAPER_ID));
    const before = tree(data);
    let calls = 0;
    const rename: RenameFn = (from, to) => {
      calls++;
      if (calls === 2) throw new Error('injected rename failure');
      renameSync(from, to);
    };
    const e = await expectReject(() => restore({ snapshot: snap, data }, { now: () => NOW, rename }), SnapshotCheckError);
    expect(calls).toBe(3);
    expect(e.message).toMatch(/put back unchanged/);
    expect(tree(data)).toEqual(before);
    expect(readdirSync(join(data, '..')).sort()).toEqual(['data', 'snap']);
  });

  it('5b′. when the rename back fails too: exit-1 error naming the aside, which holds the data; nothing else touched', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap });
    const before = tree(data);
    let calls = 0;
    const rename: RenameFn = (from, to) => {
      calls++;
      if (calls >= 2) throw new Error('injected rename failure');
      renameSync(from, to);
    };
    const e = await expectReject(() => restore({ snapshot: snap, data }, { now: () => NOW, rename }), SnapshotCheckError);
    const aside = join(data, '..', `data-m2-aside-${NOW}`);
    expect(e.result.dataAt).toBe(aside);
    expect(e.message).toContain(aside);
    expect(existsSync(data)).toBe(false);
    const { ['run/instance.lock']: _lock, ...asideTree } = tree(aside);
    expect(asideTree).toEqual(before);
    expect(existsSync(join(data, '..', `data.restore-${NOW}`))).toBe(true); // left as it is
  });

  it('5c. after a successful restore the data directory holds exactly db/ and papers/', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap });
    await restore({ snapshot: snap, data }, { now: () => NOW });
    expect(readdirSync(data).sort()).toEqual(['db', 'papers']);
    expect(readdirSync(join(data, 'db'))).toEqual(['study_paper.sqlite']);
  });

  it('6. a real copy: every snapshot file has nlink 1 and another inode; changing the original later leaves the snapshot unchanged', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    const source = tree(data);
    await snapshot({ data, out: snap });
    expect(tree(data)).toEqual(source); // the source is not changed by a byte (no lock, no -wal/-shm left behind)
    const papersFiles = Object.keys(tree(snap)).filter((f) => f.startsWith('papers/'));
    expect(papersFiles.length).toBeGreaterThanOrEqual(10);
    for (const f of [...papersFiles, DB_REL]) {
      const st = statSync(join(snap, f));
      expect(st.nlink, f).toBe(1);
      if (f.startsWith('papers/')) expect(st.ino, f).not.toBe(statSync(join(data, f)).ino);
    }
    const before = tree(snap);
    appendFileSync(join(data, 'papers', SEED_PAPER_ID, 'paper.pdf'), 'changed');
    expect(tree(snap)).toEqual(before);
    expect((await verify({ snapshot: snap })).ok).toBe(true);
  });

  it('7. a write that is only in the -wal file is in the snapshot', async () => {
    const data = freshData();
    const w = openSqlite(join(data, DB_REL), { walAutocheckpoint: 0 });
    try {
      w.pragma('wal_checkpoint(TRUNCATE)');
      w.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t-wal', ?, 'chat', 'wal only', 9, 9)`).run(SEED_PAPER_ID);
      expect(statSync(join(data, `${DB_REL}-wal`)).size).toBeGreaterThan(0);
      const snap = snapDirNear(data);
      await snapshot({ data, out: snap });
      expect(readSnapDb(snap, (db) => db.prepare(`SELECT id FROM threads WHERE id = 't-wal'`).all())).toEqual([{ id: 't-wal' }]);
      expect((await verify({ snapshot: snap })).ok).toBe(true);
    } finally {
      w.close();
    }
  });

  it('8. refused with exit 2 and nothing written: a held lock, a running llm call, a running job, an existing --out, a real-data path', async () => {
    const parentEntries = (d: string) => readdirSync(join(d, '..')).sort();
    // lock held by a live "server"
    {
      const data = freshData();
      const lock = acquireInstanceLock(dataPaths(data).lockFile, 'server');
      try {
        const before = tree(data);
        await expectReject(snapshot({ data, out: snapDirNear(data) }), SnapshotUsageError);
        expect(tree(data)).toEqual(before);
        expect(parentEntries(data)).toEqual(['data']);
        // restore and compare take the same lock
        await expectReject(() => restore({ snapshot: TEMPLATE, data }), SnapshotUsageError);
        await expectReject(compare({ snapshot: TEMPLATE, data }), SnapshotUsageError);
        expect(tree(data)).toEqual(before);
        expect(parentEntries(data)).toEqual(['data']);
      } finally {
        lock.release();
      }
    }
    // work in progress
    for (const sql of [
      `INSERT INTO llm_calls (runId, task, model, effort, status, acceptedAt) VALUES ('r-run','chat','opus','low','running',1)`,
      `INSERT INTO llm_calls (runId, task, model, effort, status, acceptedAt) VALUES ('r-q','chat','opus','low','queued',1)`,
      `INSERT INTO jobs (id, kind, paperId, status, createdAt, updatedAt) VALUES ('j-run','import_arxiv',NULL,'running',1,1)`,
    ]) {
      const data = freshData();
      withDb(data, (db) => db.exec(sql));
      const before = tree(data);
      await expectReject(snapshot({ data, out: snapDirNear(data) }), SnapshotUsageError);
      expect(tree(data)).toEqual(before);
      expect(parentEntries(data)).toEqual(['data']);
    }
    // an existing --out
    {
      const data = freshData();
      mkdirSync(snapDirNear(data));
      await expectReject(snapshot({ data, out: snapDirNear(data) }), SnapshotUsageError);
      expect(readdirSync(snapDirNear(data))).toEqual([]);
    }
    // restore --data that is not a data directory (and not empty): refused before the lock, nothing moved or created
    for (const [name, make] of [
      ['other files', (d: string) => (mkdirSync(join(d, 'src'), { recursive: true }), writeFileSync(join(d, 'src', 'a.txt'), 'x'))],
      ['db/ without papers/', (d: string) => mkdirSync(join(d, 'db'), { recursive: true })],
      ['papers is a file', (d: string) => (mkdirSync(join(d, 'db'), { recursive: true }), writeFileSync(join(d, 'papers'), 'x'))],
    ] as const) {
      const d = join(tempDir('sp-snap-notdata-'), 'not-a-data-dir');
      make(d);
      const before = tree(d);
      const e = await expectReject(() => restore({ snapshot: TEMPLATE, data: d }, { now: () => NOW }), SnapshotUsageError);
      expect(e.message, name).toMatch(/not a data directory/);
      expect(tree(d), name).toEqual(before);
      expect(readdirSync(join(d, '..')), name).toEqual(['not-a-data-dir']);
    }
    // an empty directory is accepted (nothing to lose): it receives the set
    {
      const parent = tempDir('sp-snap-empty-');
      const d = join(parent, 'data');
      mkdirSync(d);
      const snap = join(parent, 'snap');
      await snapshot({ data: freshData(), out: snap });
      expect((await restore({ snapshot: snap, data: d }, { now: () => NOW })).ok).toBe(true);
      expect(readdirSync(d).sort()).toEqual(['db', 'papers']);
    }
    // a path under the real data directory (HOME moved to a temp dir)
    {
      const home = tempDir('sp-snap-home-');
      const real = join(home, '.local', 'share', 'study_paper');
      cpSync(TEMPLATE, real, { recursive: true });
      const env = { HOME: home };
      const before = tree(real);
      const elsewhere = join(home, 'snap');
      await expectReject(snapshot({ data: real, out: elsewhere }, { env }), SnapshotUsageError);
      await expectReject(snapshot({ data: freshData(), out: join(home, '.local', 'share', 'study_paper-pre-m2') }, { env }), SnapshotUsageError);
      await expectReject(() => restore({ snapshot: TEMPLATE, data: real }, { env }), SnapshotUsageError);
      await expectReject(() => verify({ snapshot: join(home, '.local', 'share', 'study_paper-pre-m2') }, { env }), SnapshotUsageError);
      await expectReject(compare({ snapshot: TEMPLATE, data: real }, { env }), SnapshotUsageError);
      expect(tree(real)).toEqual(before);
      expect(existsSync(elsewhere)).toBe(false);
      expect(readdirSync(join(home, '.local', 'share'))).toEqual(['study_paper']);
      // the switch lets the coordinator's cutover through
      await snapshot({ data: real, out: elsewhere }, { env: { ...env, SP_SNAPSHOT_ALLOW_REAL: '1' } });
      expect(existsSync(join(elsewhere, MANIFEST))).toBe(true);
    }
    // RM-R1-04 (1): ~/.local/share/study_paper-pre-m2 is a link → paths inside its target are the real data directory
    {
      const home = tempDir('sp-snap-home-');
      const target = tempDir('sp-snap-linked-');
      mkdirSync(join(home, '.local', 'share'), { recursive: true });
      symlinkSync(target, join(home, '.local', 'share', 'study_paper-pre-m2'));
      const env = { HOME: home };
      const linkedData = join(target, 'data');
      cpSync(TEMPLATE, linkedData, { recursive: true });
      const before = tree(linkedData);
      await expectReject(snapshot({ data: linkedData, out: join(home, 'snap') }, { env }), SnapshotUsageError);
      await expectReject(snapshot({ data: freshData(), out: join(target, 'snap') }, { env }), SnapshotUsageError);
      await expectReject(() => restore({ snapshot: TEMPLATE, data: linkedData }, { env }), SnapshotUsageError);
      await expectReject(compare({ snapshot: TEMPLATE, data: linkedData }, { env }), SnapshotUsageError);
      expect(tree(linkedData)).toEqual(before);
      expect(readdirSync(target)).toEqual(['data']);
      expect(existsSync(join(home, 'snap'))).toBe(false);
    }
    // RM-R1-04 (2): with HOME moved, the account's home (user database) is still refused. Only the guard is called —
    // a name that does not exist, nothing under the real home is opened or written.
    {
      const env = { HOME: tempDir('sp-snap-home-') };
      const accountData = join(userInfo().homedir, '.local', 'share', 'study_paper-rm-r1-04-probe-does-not-exist');
      expect(() => assertNotRealDataDir('--data', accountData, env)).toThrow(/real data directory/);
      expect(() => assertNotRealDataDir('--out', join(accountData, 'snap'), env)).toThrow(/real data directory/);
    }
  });

  it('9. after --seal (0444 files, 0555 dirs) restore still works, and a server starts on the restored directory (papers.get 200)', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap });
    const v = await verify({ snapshot: snap, seal: true });
    try {
      expect(v.sealed).toBe(true);
      expect(statSync(join(snap, DB_REL)).mode & 0o777).toBe(0o444);
      expect(statSync(join(snap, 'papers')).mode & 0o777).toBe(0o555);
      expect(statSync(snap).mode & 0o777).toBe(0o555);
      expect((await verify({ snapshot: snap })).ok).toBe(true); // a sealed snapshot still verifies (DB read through a copy)
      const before = tree(snap);
      const r = await restore({ snapshot: snap, data }, { now: () => NOW });
      expect(r.ok).toBe(true);
      expect(tree(snap)).toEqual(before);
      expect(statSync(join(data, DB_REL)).mode & 0o200).toBe(0o200); // the restored copy is writable
      const s = await startTestServer({ env: 'test', dataDir: data });
      try {
        for (const id of [SEED_PAPER_ID, SEED_M2_PAPER_ID]) {
          const res = await s.req(`/api/papers/${id}`, { headers: { 'X-SP-Token': s.token } });
          expect(res.status, id).toBe(200);
        }
      } finally {
        await s.close();
      }
    } finally {
      unseal(snap);
    }
  });

  it('compare: equal after restore; a changed message, an extra row and a missing paper PDF are reported by id', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap });
    const same = await compare({ snapshot: snap, data });
    expect(same.ok).toBe(true);
    expect(same.tables.map((t) => [t.table, t.equal, t.count.a])).toEqual([
      ['threads', true, 1],
      ['messages', true, 2],
      ['citations', true, 1],
      ['highlights', true, 1],
    ]);
    expect(same.pdf).toMatchObject({ papers: 4, ok: 4 });
    expect(readdirSync(data).sort()).toEqual(readdirSync(TEMPLATE).sort()); // compare leaves the data dir as it was

    withDb(data, (db) => {
      db.prepare(`UPDATE messages SET contentMd = 'edited' WHERE id = 'a1'`).run();
      db.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t-new', ?, 'chat', 'n', 3, 3)`).run(SEED_PAPER_ID);
      db.prepare(`DELETE FROM papers WHERE id = ?`).run(SEED_LINKS_PAPER_ID);
    });
    const diff = await compare({ snapshot: snap, data });
    expect(diff.ok).toBe(false);
    const by = Object.fromEntries(diff.tables.map((t) => [t.table, t]));
    expect(by.messages).toMatchObject({ equal: false, changed: 1, changedIds: ['a1'] });
    expect(by.threads).toMatchObject({ equal: false, onlyInB: 1, onlyInBIds: ['t-new'] });
    expect(JSON.stringify(diff)).not.toContain('edited'); // ids only, never text
    expect(diff.pdf.missingPaper).toEqual([SEED_LINKS_PAPER_ID]);
  });

  it('compare PDF check: no pdf files row / files.sha256 changed / file missing / file bytes changed — each reported by paper id only', async () => {
    const data = freshData();
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap });
    const pdfRel = (id: string) => withDb(data, (db) => (db.prepare(`SELECT relPath FROM files WHERE paperId = ? AND kind = 'pdf'`).get(id) as { relPath: string }).relPath);
    const linksPdf = pdfRel(SEED_LINKS_PAPER_ID);
    const upgradePdf = pdfRel(SEED_UPGRADE_PAPER_ID);
    withDb(data, (db) => {
      db.prepare(`DELETE FROM files WHERE paperId = ? AND kind = 'pdf'`).run(SEED_PAPER_ID);
      db.prepare(`UPDATE files SET sha256 = ? WHERE paperId = ? AND kind = 'pdf'`).run('f'.repeat(64), SEED_M2_PAPER_ID);
    });
    rmSync(join(data, ...linksPdf.split('/')));
    appendFileSync(join(data, ...upgradePdf.split('/')), 'x');
    const r = await compare({ snapshot: snap, data });
    expect(r.ok).toBe(false);
    expect(r.pdf).toEqual({
      papers: 4,
      ok: 0,
      missingPaper: [],
      missingFilesRow: [SEED_PAPER_ID],
      shaDiffersFromSnapshot: [SEED_M2_PAPER_ID],
      fileMissing: [SEED_LINKS_PAPER_ID],
      fileShaDiffers: [SEED_UPGRADE_PAPER_ID],
    });
    expect(r.tables.every((t) => t.equal)).toBe(true); // the four dumped tables are untouched by these changes
  });

  it('CLI: exit codes 2 (usage, real path) / 0 / 1, one JSON object on stdout', async () => {
    const script = join(REPO_ROOT, 'scripts/data-snapshot.ts');
    const home = tempDir('sp-snap-clihome-');
    const env = { HOME: home, SP_SNAPSHOT_ALLOW_REAL: undefined };
    const data = freshData();
    const snap = snapDirNear(data);
    const none = await runProbe(script, env, []);
    expect(none.status).toBe(2);
    const noOut = await runProbe(script, env, ['snapshot', '--data', data]);
    expect(noOut.status).toBe(2);
    expect(JSON.parse(noOut.stdout)).toMatchObject({ command: 'snapshot', ok: false, exitCode: 2 });
    mkdirSync(join(home, '.local', 'share'), { recursive: true }); // so only the guard can refuse it (the parent exists)
    const realPath = await runProbe(script, env, ['snapshot', '--data', data, '--out', join(home, '.local', 'share', 'study_paper-pre-m2')]);
    expect(realPath.status).toBe(2);
    expect(realPath.stderr).toMatch(/under the real data directory/);
    expect(readdirSync(join(home, '.local', 'share'))).toEqual([]);
    const ok = await runProbe(script, env, ['snapshot', '--data', data, '--out', snap]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ command: 'snapshot', ok: true, snapshot: snap });
    const report = join(data, '..', 'report');
    const v = await runProbe(script, env, ['verify', '--snapshot', snap, '--report', report]);
    expect(v.status).toBe(0);
    expect(JSON.parse(readFileSync(join(report, 'verify.json'), 'utf8'))).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(report, 'verify.json'), 'utf8'))).toEqual(JSON.parse(v.stdout));
    // a --report that cannot be written (a file where the directory should be): refused before the command runs, exit 2
    // (INT5-R2-02; a report that fails only at the end is the 'reportgone' case below)
    const blocked = join(data, '..', 'report-is-a-file');
    writeFileSync(blocked, '');
    const nb = await runProbe(script, env, ['verify', '--snapshot', snap, '--report', blocked]);
    expect(nb.status, nb.stderr).toBe(2);
    expect(JSON.parse(nb.stdout)).toMatchObject({ command: 'verify', ok: false, exitCode: 2 });
    expect(JSON.parse(nb.stdout)).not.toHaveProperty('reportError');
    expect(nb.stderr).toMatch(/--report \S+ cannot be written/);
    expect(readFileSync(blocked, 'utf8')).toBe('');
    const inside = await runProbe(script, env, ['verify', '--snapshot', snap, '--report', join(snap, 'r')]);
    expect(inside.status).toBe(2);
    appendFileSync(join(snap, SNAPSHOT_JSON), ' ');
    const bad = await runProbe(script, env, ['verify', '--snapshot', snap]);
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ command: 'verify', ok: false, exitCode: 1 });
    const cmp = await runProbe(script, env, ['compare', '--snapshot', snap, '--data', data, '--out', join(data, '..', 'cmp')]);
    expect(cmp.status).toBe(0);
    expect(JSON.parse(readFileSync(join(data, '..', 'cmp', 'compare.json'), 'utf8'))).toMatchObject({ ok: true });

    // restore: --report inside --data → 2 (nothing written); a snapshot failing verify → 1 with live unchanged; then → 0
    const good = join(data, '..', 'snap-good');
    expect((await runProbe(script, env, ['snapshot', '--data', data, '--out', good])).status).toBe(0);
    const before = tree(data);
    const repIn = await runProbe(script, env, ['restore', '--snapshot', good, '--data', data, '--report', join(data, 'rep')]);
    expect(repIn.status).toBe(2);
    expect(JSON.parse(repIn.stdout)).toMatchObject({ command: 'restore', ok: false, exitCode: 2 });
    expect(tree(data)).toEqual(before);
    const rep = join(data, '..', 'rep-restore');
    const fail = await runProbe(script, env, ['restore', '--snapshot', snap, '--data', data, '--report', rep]); // snap's SNAPSHOT.json was changed above
    expect(fail.status).toBe(1);
    expect(JSON.parse(fail.stdout)).toMatchObject({ command: 'restore', ok: false, exitCode: 1 });
    expect(JSON.parse(readFileSync(join(rep, 'restore.json'), 'utf8'))).toMatchObject({ ok: false, exitCode: 1 });
    expect(tree(data)).toEqual(before);
    expect(readdirSync(join(data, '..')).filter((n) => n.includes('aside') || n.includes('.restore-'))).toEqual([]);
    const done = await runProbe(script, env, ['restore', '--snapshot', good, '--data', data, '--report', rep]);
    expect(done.status).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({ command: 'restore', ok: true, exitCode: 0 });
    expect(readdirSync(data).sort()).toEqual(['db', 'papers']);
    expect(JSON.parse(readFileSync(join(rep, 'restore.json'), 'utf8'))).toMatchObject({ ok: true });
  }, 60_000);

  it('CLI --report: a usage / precondition refusal (exit 2) leaves a report already there as it was; another error (exit 1) replaces it with the stdout object (INT5-R2-01)', async () => {
    const script = join(REPO_ROOT, 'scripts/data-snapshot.ts');
    const env = { HOME: tempDir('sp-snap-clihome-'), SP_SNAPSHOT_ALLOW_REAL: undefined };
    const data = freshData();
    const rep = join(data, '..', 'rep');
    mkdirSync(rep);
    const stale = JSON.stringify({ command: 'stale', ok: true, exitCode: 0 });
    for (const n of ['verify.json', 'restore.json']) writeFileSync(join(rep, n), stale);
    const before = tree(data);
    const missing = join(data, '..', 'no-such-snap'); // refused by the command (precondition), after --report was accepted
    const v = await runProbe(script, env, ['verify', '--snapshot', missing, '--report', rep]);
    expect(v.status, v.stderr).toBe(2);
    expect(JSON.parse(v.stdout)).toMatchObject({ command: 'verify', ok: false, exitCode: 2 });
    const r = await runProbe(script, env, ['restore', '--snapshot', missing, '--data', data, '--report', rep]);
    expect(r.status, r.stderr).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ command: 'restore', ok: false, exitCode: 2 });
    const u = await runProbe(script, env, ['verify', '--report', rep, '--snapshot', missing, '--bogus']);
    expect(u.status, u.stderr).toBe(2);
    for (const n of ['verify.json', 'restore.json']) expect(readFileSync(join(rep, n), 'utf8'), n).toBe(stale);
    expect(readdirSync(rep).sort()).toEqual(['restore.json', 'verify.json']);
    expect(tree(data)).toEqual(before);

    // another error (neither a check failure nor a refusal): verify passes, then sealing throws a plain Error → exit 1
    const snap = snapDirNear(data);
    await snapshot({ data, out: snap }, { env: { HOME: env.HOME } });
    const g = await runProbe(script, { ...env, ...faultEnv('sealfail') }, ['verify', '--snapshot', snap, '--seal', '--report', rep]);
    expect(g.status, g.stderr).toBe(1);
    expect(JSON.parse(g.stdout)).toMatchObject({ command: 'verify', ok: false, exitCode: 1, error: expect.stringMatching(/^injected fault/) });
    expect(JSON.parse(readFileSync(join(rep, 'verify.json'), 'utf8'))).toEqual(JSON.parse(g.stdout));
    expect(readFileSync(join(rep, 'restore.json'), 'utf8')).toBe(stale);
  }, 60_000);

  it('CLI --report checked before the command: one that cannot be written is exit 2 with nothing changed, so restore exit 1 still means live unchanged; only a report lost during the run gives exit 1 + reportError (INT5-R2-02)', async () => {
    const script = join(REPO_ROOT, 'scripts/data-snapshot.ts');
    const env = { HOME: tempDir('sp-snap-clihome-'), SP_SNAPSHOT_ALLOW_REAL: undefined };
    const src = freshData();
    const snap = snapDirNear(src);
    await snapshot({ data: src, out: snap }, { env: { HOME: env.HOME } });
    const want = setOf(tree(snap));
    const data = freshData();
    withDb(data, (db) => db.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t-live', ?, 'chat', 'live', 1, 1)`).run(SEED_M2_PAPER_ID));
    const before = tree(data);
    const parent = join(data, '..');
    const quiet = () => readdirSync(parent).filter((n) => n.includes('-m2-aside-') || n.includes('.restore-'));
    const refused = async (args: string[], what: string) => {
      const r = await runProbe(script, env, args);
      expect(r.status, `${what}\n${r.stderr}`).toBe(2);
      expect(JSON.parse(r.stdout), what).toMatchObject({ ok: false, exitCode: 2 });
      expect(JSON.parse(r.stdout), what).not.toHaveProperty('reportError');
      expect(tree(data), what).toEqual(before);
      expect(quiet(), what).toEqual([]);
      return r;
    };

    // a file where the directory should be
    const asFile = join(parent, 'rep-file');
    writeFileSync(asFile, 'x');
    const f = await refused(['restore', '--snapshot', snap, '--data', data, '--report', asFile], 'report path is a file');
    expect(f.stderr).toMatch(/--report \S+ cannot be written/);
    expect(readFileSync(asFile, 'utf8')).toBe('x');
    // restore.json is a directory
    const asDir = join(parent, 'rep-dir');
    mkdirSync(join(asDir, 'restore.json'), { recursive: true });
    await refused(['restore', '--snapshot', snap, '--data', data, '--report', asDir], 'restore.json is a directory');
    expect(readdirSync(join(asDir, 'restore.json'))).toEqual([]);
    // a directory the process cannot write into (not checkable as root, which may write anyway)
    if (process.getuid?.() !== 0) {
      const ro = join(parent, 'rep-ro');
      mkdirSync(ro);
      chmodSync(ro, 0o555);
      try {
        await refused(['restore', '--snapshot', snap, '--data', data, '--report', ro], 'read-only report directory');
        await refused(['verify', '--snapshot', snap, '--report', ro], 'read-only report directory (verify)');
        expect(readdirSync(ro)).toEqual([]);
      } finally {
        chmodSync(ro, 0o755);
      }
    }
    // a new directory made by the check is removed again when the command is refused afterwards (exit 2 changes nothing)
    const fresh = join(parent, 'rep-new');
    await refused(['restore', '--snapshot', join(parent, 'no-such-snap'), '--data', data, '--report', join(fresh, 'a', 'b')], 'refused after the check');
    expect(existsSync(fresh)).toBe(false);
    const vNew = await runProbe(script, env, ['verify', '--snapshot', snap, '--report', join(fresh, 'v')]);
    expect(vNew.status, vNew.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(fresh, 'v', 'verify.json'), 'utf8'))).toEqual(JSON.parse(vNew.stdout));

    // the report directory replaced by a file while restore runs: the replacement finishes, then exit 1 + reportError,
    // the JSON names the aside (the old live data)
    const gone = join(parent, 'rep-gone');
    mkdirSync(gone);
    const g = await runProbe(script, { ...env, ...faultEnv('reportgone'), SNAPTEST_REPORT: gone }, ['restore', '--snapshot', snap, '--data', data, '--report', gone]);
    expect(g.status, g.stderr).toBe(1);
    const out = JSON.parse(g.stdout) as { aside?: string };
    expect(out).toMatchObject({ command: 'restore', ok: false, exitCode: 1, reportError: expect.any(String) });
    expect(g.stderr).toMatch(/--report not written/);
    expect(statSync(gone).isFile()).toBe(true);
    expect(setOf(tree(data))).toEqual(want);
    expect(out.aside).toMatch(/-m2-aside-\d+$/);
    expect(setOf(tree(out.aside!))).toEqual(setOf(before));
  }, 60_000);
});


describe('data ↔ snapshot / staging / output / report by real path, symbolic link aliases refused (M-M2-R2-4)', () => {
  const env = { HOME: '/nonexistent-home-sp-snap', SP_SNAPSHOT_ALLOW_REAL: undefined };

  it('snapshot under an alias that points inside --data is refused, nothing made in data; a normal sibling is allowed', async () => {
    const data = freshData();
    const root = join(data, '..');
    symlinkSync(join(data, 'papers'), join(root, 'alias-papers')); // outside by name, inside --data by real path
    const before = tree(data);
    const e = await expectReject(snapshot({ data, out: join(root, 'alias-papers', 'snap') }, { env }), SnapshotUsageError);
    expect(e.message).toMatch(/--out and --data must not contain each other/);
    expect(tree(data)).toEqual(before);
    // the --out itself a (dangling) link into --data: refused, and the target is not made
    symlinkSync(join(data, 'snap-target'), join(root, 'link-out'));
    await expectReject(snapshot({ data, out: join(root, 'link-out') }, { env }), SnapshotUsageError);
    expect(existsSync(join(data, 'snap-target'))).toBe(false);
    // a normal sibling: allowed
    await snapshot({ data, out: join(root, 'snap-ok') }, { env });
    expect(existsSync(join(root, 'snap-ok', MANIFEST))).toBe(true);
  });

  it('data inside the snapshot (through a parent link) is refused by restore and compare; a link as --data is refused', async () => {
    const data = freshData();
    const root = join(data, '..');
    const snap = join(root, 'snap');
    await snapshot({ data, out: snap }, { env });
    const inner = join(snap, 'inner-data');
    cpSync(TEMPLATE, inner, { recursive: true }); // a data directory inside the snapshot …
    symlinkSync(snap, join(root, 'snap-alias')); // … named through a link to the snapshot
    const viaAlias = join(root, 'snap-alias', 'inner-data');
    const r = await expectReject(() => restore({ snapshot: snap, data: viaAlias }, { env }), SnapshotUsageError);
    expect(r.message).toMatch(/--snapshot and --data must not contain each other/);
    const c = await expectReject(compare({ snapshot: snap, data: viaAlias }, { env }), SnapshotUsageError);
    expect(c.message).toMatch(/--snapshot and --data must not contain each other/);
    rmSync(inner, { recursive: true, force: true });
    // --data given as a link (restore would move the link, not the directory)
    symlinkSync(data, join(root, 'data-link'));
    const before = tree(data);
    expect((await expectReject(() => restore({ snapshot: join(root, 'snap-x'), data: join(root, 'data-link') }, { env }), SnapshotUsageError)).message).toMatch(/symbolic link/);
    expect(tree(data)).toEqual(before);
    expect(readdirSync(root).filter((n) => n.includes('aside') || n.includes('.restore-'))).toEqual([]);
  });

  it('CLI: a --report or compare --out alias into --snapshot / --data is refused (exit 2, nothing written there)', async () => {
    const script = join(REPO_ROOT, 'scripts/data-snapshot.ts');
    const data = freshData();
    const root = join(data, '..');
    const snap = join(root, 'snap');
    await snapshot({ data, out: snap }, { env });
    symlinkSync(snap, join(root, 'to-snap'));
    symlinkSync(data, join(root, 'to-data'));
    const probeEnv = { HOME: tempDir('sp-snap-clihome-'), SP_SNAPSHOT_ALLOW_REAL: undefined };
    const rep = await runProbe(script, probeEnv, ['verify', '--snapshot', snap, '--report', join(root, 'to-snap', 'rep')]);
    expect(rep.status, rep.stderr).toBe(2);
    expect(existsSync(join(snap, 'rep'))).toBe(false);
    const cmp = await runProbe(script, probeEnv, ['compare', '--snapshot', snap, '--data', data, '--out', join(root, 'to-data', 'cmp')]);
    expect(cmp.status, cmp.stderr).toBe(2);
    expect(existsSync(join(data, 'cmp'))).toBe(false);
    const linkRep = await runProbe(script, probeEnv, ['verify', '--snapshot', snap, '--report', join(root, 'to-data')]);
    expect(linkRep.status, linkRep.stderr).toBe(2);
    // normal siblings: accepted
    expect((await runProbe(script, probeEnv, ['verify', '--snapshot', snap, '--report', join(root, 'rep-ok')])).status).toBe(0);
    expect((await runProbe(script, probeEnv, ['compare', '--snapshot', snap, '--data', data, '--out', join(root, 'cmp-ok')])).status).toBe(0);
  }, 60_000);
});

describe('signals from outside on the documented command forms; temp DB copies on exit (INT-I10-06, INT-FX-01)', () => {
  /**
   * A preload (NODE_OPTIONS --import, so the command line stays the documented one) that stops the CLI — inside one of
   * its synchronous stretches — at a named point until the test writes `go`: `dbcopy` = right after a temp DB copy
   * (sp-snapdb-*) is written · `partial` = snapshot copying papers/ into its .partial-* staging · `staging` = restore
   * copying the snapshot into its .restore-* staging · `rename1` = right after restore's rename 1 (live → aside). It
   * writes `at` when it stops and records every sp-snapdb-* directory made in `copies`. In the npm process (which loads
   * it too through NODE_OPTIONS) it only records in `forwarded` each signal npm passes on to its child.
   */
  const PRELOAD = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const point = process.env.SNAPTEST_POINT;
const dir = process.env.SNAPTEST_DIR;
if (point && dir && (process.argv[1] ?? '').endsWith('data-snapshot.ts')) {
  const { chmodSync, renameSync, mkdtempSync, writeFileSync, appendFileSync, existsSync } = fs;
  let stopped = false;
  const stop = (where) => {
    if (stopped) return;
    stopped = true;
    writeFileSync(dir + '/at.tmp', where);
    renameSync(dir + '/at.tmp', dir + '/at');
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const t0 = Date.now();
    while (!existsSync(dir + '/go') && Date.now() - t0 < 30000) Atomics.wait(cell, 0, 0, 5);
  };
  fs.mkdtempSync = function (prefix, ...rest) {
    const d = mkdtempSync.call(this, prefix, ...rest);
    if (String(prefix).includes('sp-snapdb-')) appendFileSync(dir + '/copies', d + '\\n');
    return d;
  };
  fs.chmodSync = function (p, mode) {
    chmodSync.call(this, p, mode);
    const s = String(p);
    if (point === 'dbcopy' && /sp-snapdb-[^/]+\\/study_paper\\.sqlite$/.test(s)) stop(s);
    if (point === 'partial' && /\\.partial-[^/]+\\/papers$/.test(s)) stop(s);
    if (point === 'staging' && /\\.restore-\\d+$/.test(s)) stop(s);
  };
  fs.renameSync = function (a, b) {
    renameSync.call(this, a, b);
    if (point === 'rename1' && /-m2-aside-\\d+$/.test(String(b))) stop(String(b));
  };
  syncBuiltinESMExports();
} else if (point && dir) {
  const { ChildProcess } = await import('node:child_process');
  const kill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function (sig) {
    const r = kill.call(this, sig);
    fs.appendFileSync(dir + '/forwarded', String(sig) + '\\n');
    return r;
  };
}
`;
  let preloadUrl = '';
  /**
   * The npm form's registry is a 127.0.0.1 listener that records every request: the gate makes no outside request
   * (BRIEF_COMMON), and npm (with no usable HOME, so no record of its last update check) would ask the registry for
   * its own latest version on every run (update-notifier, INT5-R1-01).
   */
  let registry: Server | null = null;
  let registryUrl = '';
  const registryHits: string[] = [];
  beforeAll(async () => {
    const f = join(fileTempDir('sp-snap-preload-'), 'preload.mjs');
    writeFileSync(f, PRELOAD);
    preloadUrl = pathToFileURL(f).href;
    const srv = createServer((req, res) => {
      registryHits.push(`${req.method} ${req.url}`);
      res.statusCode = 404;
      res.end();
    });
    srv.on('connection', () => registryHits.push('connection'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    registry = srv;
    const addr = srv.address();
    if (addr === null || typeof addr === 'string') throw new Error('registry listener has no port');
    registryUrl = `http://127.0.0.1:${addr.port}/`;
  });
  afterAll(async () => {
    if (registry) await new Promise<void>((r) => registry!.close(() => r()));
  });
  const started: ChildProcess[] = [];
  afterEach(() => {
    for (const c of started.splice(0)) if (c.exitCode === null && c.signalCode === null && c.pid) process.kill(-c.pid, 'SIGKILL');
  });

  type Form = 'npm' | 'node';
  interface Interrupted {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    /** Where the process was stopped when the signal was sent (null: it never got there). */
    at: string | null;
    /** Every sp-snapdb-* directory the process made. */
    copies: string[];
    /** Requests that reached the stand-in registry during the run (npm form). */
    outside: string[];
  }
  /**
   * Runs the CLI in a documented form (`npm run data:snapshot -- …` / `node --import tsx scripts/data-snapshot.ts …`) in
   * its own process group, waits until it stops at `point`, sends `sig` from outside — to the whole group (a terminal's
   * Ctrl-C) or to the top process only (npm: after npm has passed it on to the CLI) — and lets it go on.
   */
  async function interrupt(form: Form, args: string[], point: string, sig: 'SIGINT' | 'SIGTERM', to: 'group' | 'top'): Promise<Interrupted> {
    const dir = tempDir('sp-snap-sig-');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('VITEST') && k !== 'TEST' && k !== 'NODE_ENV' && !k.toLowerCase().startsWith('npm_')) env[k] = v;
    Object.assign(env, { HOME: '/nonexistent-sp-snap-probe', NODE_OPTIONS: `--import=${preloadUrl}`, SNAPTEST_POINT: point, SNAPTEST_DIR: dir });
    // no update check (npm asks the registry for its own latest version when it has no record of the last check, and
    // HOME above has none); anything npm still asks the network for shows up in registryHits
    Object.assign(env, { npm_config_update_notifier: 'false', npm_config_registry: registryUrl });
    const hits0 = registryHits.length;
    delete env.SP_SNAPSHOT_ALLOW_REAL;
    const [cmd, argv] = form === 'npm' ? ['npm', ['run', 'data:snapshot', '--', ...args]] : [process.execPath, ['--import', 'tsx', 'scripts/data-snapshot.ts', ...args]];
    const child = spawn(cmd, argv, { cwd: REPO_ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    started.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (c) => (stdout += c));
    child.stderr!.on('data', (c) => (stderr += c));
    const exit = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((res) => child.once('exit', (status, signal) => res({ status, signal })));
    let ended = false;
    void exit.then(() => (ended = true));
    let at: string | null = null;
    try {
      await waitFor(() => ended || existsSync(join(dir, 'at')), `the CLI to reach ${point}`, 45_000);
      if (existsSync(join(dir, 'at'))) {
        at = readFileSync(join(dir, 'at'), 'utf8');
        process.kill(to === 'group' ? -child.pid! : child.pid!, sig);
        if (form === 'npm' && to === 'top') await waitFor(() => ended || existsSync(join(dir, 'forwarded')), 'npm to pass the signal on', 30_000);
      }
    } finally {
      writeFileSync(join(dir, 'go'), '');
    }
    const r = await exit;
    const copies = existsSync(join(dir, 'copies')) ? readFileSync(join(dir, 'copies'), 'utf8').split('\n').filter(Boolean) : [];
    await new Promise((res) => setImmediate(res)); // a connection npm opened before it exited is polled by now
    return { ...r, stdout, stderr, at, copies, outside: registryHits.slice(hits0) };
  }
  const exitOf = (sig: 'SIGINT' | 'SIGTERM') => (sig === 'SIGINT' ? 130 : 143);
  /** The last stdout line is the command's JSON object (npm prints its banner before it). */
  const lastJson = (stdout: string): Record<string, unknown> => JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
  function expectCleanStop(r: Interrupted, sig: 'SIGINT' | 'SIGTERM', what: string): void {
    expect(r.at, `${what}: never reached the point\n${r.stderr}`).not.toBeNull();
    expect(r.signal, `${what}: ended by a signal (no cleanup ran)\n${r.stderr}`).toBeNull();
    expect(r.status, `${what}\n${r.stderr}`).toBe(exitOf(sig));
    expect(r.copies.filter((d) => existsSync(d)), `${what}: sp-snapdb-* left`).toEqual([]);
    expect(r.outside, `${what}: requests to the (stand-in) npm registry`).toEqual([]);
  }
  /** The --report file: written with the exit the command really ends with (a stale one from an earlier run replaced). */
  const reportOf = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
  const staleReport = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify({ command: 'stale', ok: true, exitCode: 0 }));
  };
  const siblings = (dir: string, part: string) => readdirSync(join(dir, '..')).filter((n) => n.includes(part));
  const lockAt = (dir: string) => existsSync(join(dir, 'run', 'instance.lock'));
  /** A row the snapshot does not have, so an installed snapshot is visible. */
  const sqliteTouch = (dir: string) => withDb(dir, (db) => db.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES ('t-live', ?, 'chat', 'live', 1, 1)`).run(SEED_M2_PAPER_ID));

  const FORMS: Form[] = ['node', 'npm'];

  it.each(FORMS)('%s form: snapshot stopped while a temp DB copy exists or while papers/ is copied — no copy, no .partial-*, no snapshot, data and lock as before', async (form) => {
    for (const [point, sig, to] of [['dbcopy', 'SIGINT', 'group'], ['partial', 'SIGTERM', 'top']] as const) {
      const data = freshData();
      const before = setOf(tree(data));
      const out = join(data, '..', `snap-${point}`);
      const r = await interrupt(form, ['snapshot', '--data', data, '--out', out], point, sig, to);
      expectCleanStop(r, sig, `${form} snapshot ${point} ${sig}`);
      if (point === 'dbcopy') expect(r.copies.length).toBeGreaterThan(0);
      expect(lastJson(r.stdout)).toMatchObject({ command: 'snapshot', ok: false, exitCode: exitOf(sig), signal: sig });
      expect(existsSync(out)).toBe(false);
      expect(siblings(data, '.partial-')).toEqual([]);
      expect(setOf(tree(data))).toEqual(before);
      expect(lockAt(data)).toBe(false);
    }
  }, 120_000);

  it.each(FORMS)('%s form: verify and compare stopped while their temp DB copy exists — no copy left, 130 / 143, no compare.json', async (form) => {
    const data = freshData();
    const snap = join(data, '..', 'snap');
    await snapshot({ data, out: snap }, { env: { HOME: '/nonexistent-sp-snap-probe' } });
    const vRep = join(data, '..', 'rep-verify');
    staleReport(vRep, 'verify.json');
    const v = await interrupt(form, ['verify', '--snapshot', snap, '--seal', '--report', vRep], 'dbcopy', 'SIGTERM', 'top');
    expectCleanStop(v, 'SIGTERM', `${form} verify`);
    expect(reportOf(vRep, 'verify.json')).toEqual(lastJson(v.stdout));
    expect(reportOf(vRep, 'verify.json')).toMatchObject({ command: 'verify', ok: false, exitCode: 143, signal: 'SIGTERM' });
    expect(v.copies.length).toBeGreaterThan(0);
    expect(statSync(snap).mode & 0o200).toBe(0o200); // not sealed
    const outDir = join(data, '..', 'cmp');
    const c = await interrupt(form, ['compare', '--snapshot', snap, '--data', data, '--out', outDir], 'dbcopy', 'SIGINT', 'group');
    expectCleanStop(c, 'SIGINT', `${form} compare`);
    expect(c.copies.length).toBeGreaterThan(0);
    expect(existsSync(join(outDir, 'compare.json'))).toBe(false);
    expect(lockAt(data)).toBe(false);
  }, 120_000);

  it.each(FORMS)('%s form: restore stopped before rename 1 (copying the staging, verifying it) — staging removed, data unchanged, lock released', async (form) => {
    const src = freshData();
    const snap = join(src, '..', 'snap');
    await snapshot({ data: src, out: snap }, { env: { HOME: '/nonexistent-sp-snap-probe' } });
    for (const [point, sig, to] of [['staging', 'SIGINT', 'group'], ['dbcopy', 'SIGTERM', 'top']] as const) {
      const data = freshData();
      const before = tree(data);
      const rRep = join(data, '..', `rep-${point}`);
      staleReport(rRep, 'restore.json');
      const r = await interrupt(form, ['restore', '--snapshot', snap, '--data', data, '--report', rRep], point, sig, to);
      expectCleanStop(r, sig, `${form} restore ${point} ${sig}`);
      expect(r.at).toMatch(point === 'staging' ? /\.restore-\d+$/ : /sp-snapdb-/);
      expect(lastJson(r.stdout)).toMatchObject({ command: 'restore', ok: false, exitCode: exitOf(sig), signal: sig });
      expect(reportOf(rRep, 'restore.json')).toEqual(lastJson(r.stdout));
      expect(tree(data)).toEqual(before);
      expect(siblings(data, '.restore-')).toEqual([]);
      expect(siblings(data, '-m2-aside-')).toEqual([]);
      expect(lockAt(data)).toBe(false);
    }
  }, 120_000);

  it.each(FORMS)('%s form: a signal after restore\'s rename 1 waits for rename 2 — snapshot installed, old data aside, no staging, exit 130 / 143', async (form) => {
    const src = freshData();
    const snap = join(src, '..', 'snap');
    await snapshot({ data: src, out: snap }, { env: { HOME: '/nonexistent-sp-snap-probe' } });
    const want = setOf(tree(snap)); // restore installs a byte copy of the snapshot's db/ and papers/
    for (const [sig, to] of [['SIGINT', 'group'], ['SIGTERM', 'top']] as const) {
      const data = freshData();
      sqliteTouch(data); // the live data differs from the snapshot, so "installed" is visible
      const rRep = join(data, '..', 'rep-rename1');
      const r = await interrupt(form, ['restore', '--snapshot', snap, '--data', data, '--report', rRep], 'rename1', sig, to);
      expectCleanStop(r, sig, `${form} restore rename1 ${sig}`);
      expect(lastJson(r.stdout)).toMatchObject({ command: 'restore', ok: true, exitCode: exitOf(sig), signal: sig });
      expect(reportOf(rRep, 'restore.json')).toEqual(lastJson(r.stdout));
      expect(existsSync(data)).toBe(true);
      expect(setOf(tree(data))).toEqual(want);
      expect(siblings(data, '.restore-')).toEqual([]);
      const aside = siblings(data, '-m2-aside-');
      expect(aside).toHaveLength(1);
      expect(lockAt(join(data, '..', aside[0]!))).toBe(false);
    }
  }, 120_000);

  it('process.exit while a temp copy exists: removed by the exit handler', async () => {
    const f = join(tempDir('sp-snap-probe-'), 'probe.mts'); // ESM (top-level await) outside the repo's package.json
    writeFileSync(
      f,
      `import * as lib from ${JSON.stringify(join(REPO_ROOT, 'scripts', 'lib', 'dataSnapshot.ts'))};
const [a1, a2] = process.argv.slice(2);
lib.installSignalCleanup();
await lib.snapshot({ data: a1, out: a2 }, { env: { HOME: '/nonexistent-sp-snap-probe' }, onDbCopy: (dir: string) => {
  process.stdout.write('copy ' + dir + '\\n');
  process.exit(7);
} });
`,
    );
    const data = freshData();
    const r = await runProbe(f, {}, [data, join(data, '..', 'snap-c')]);
    expect(r.status).toBe(7);
    const dir = /^copy (.+)$/m.exec(r.stdout)?.[1];
    expect(dir, r.stderr).toMatch(/sp-snapdb-/);
    expect(existsSync(dir!)).toBe(false);
  });

  it('the documented form is the one without the tsx CLI wrapper; the CLI installs the handlers before any command', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    // exec: npm's sh is replaced by node, so a signal npm passes on reaches the CLI (a plain sh -c dies of it and npm
    // with it, while the CLI goes on unsignalled)
    expect(pkg.scripts['data:snapshot']).toBe('exec node --import tsx scripts/data-snapshot.ts');
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'data-snapshot.ts'), 'utf8');
    expect(src.indexOf('installSignalCleanup();')).toBeGreaterThan(0);
    expect(src.indexOf('installSignalCleanup();')).toBeLessThan(src.indexOf('const [command, ...rest]'));
  });
});
