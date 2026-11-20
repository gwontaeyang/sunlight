// Probe for captures.test (separate process, run under a file size limit — runProbeWithFileSizeLimit). Owner:
// supervisor. Same condition as the Codex M-S-1 reproduction: a valid PNG larger than the limit, the real
// storeCapture, then (only if it returned) insertRow in a real SQLite/Drizzle transaction.
// Usage: capture-probe.ts <json {root, paperId, bytes}>
//   root: data dir (the parent made papers/<paperId>/ before the limit applied); the DB is in memory with the real
//   migrations (reading only), so the limit hits nothing but the files this probe writes.
// Prints one JSON line: {limitCheck, stored, error, rows}
//   limitCheck — bytes a single 4,096 B writeSync stored in another file (proves the limit is in force: < 4,096)
//   stored     — storeCapture returned (the bug); then insertRow ran and `rows` counts the files rows
//   error      — {code, message} of what storeCapture threw
import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { storeCapture } from '../../src/captures';
import { DEFAULT_MIGRATIONS_FOLDER } from '../../src/db/migrate';
import * as schema from '../../src/db/schema';
import { dataPaths } from '../../src/paths';
import { makeTestPng } from '../helpers/png';

const o = JSON.parse(process.argv[2] ?? '{}') as { root: string; paperId: string; bytes: number };
const paths = dataPaths(o.root);

// ① the limit is in force for this process
const checkFile = join(o.root, 'limit-check');
const fd = openSync(checkFile, 'w', 0o600);
let limitCheck: number | string;
try {
  limitCheck = writeSync(fd, Buffer.alloc(4096, 0x61));
} catch (e) {
  limitCheck = (e as NodeJS.ErrnoException).code ?? String(e);
} finally {
  closeSync(fd);
  rmSync(checkFile, { force: true });
}

// ② the real storeCapture with a valid PNG of `bytes`
const sqlite = new Database(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder: DEFAULT_MIGRATIONS_FOLDER });
sqlite.prepare(`INSERT INTO papers (id, source, title, ingestStatus, createdAt, updatedAt) VALUES (?, 'upload', 'probe', 'done', 1, 1)`).run(o.paperId);
const png = makeTestPng({ width: 16, height: 16, padToBytes: o.bytes });
let stored = false;
let error: { code: string | null; message: string } | null = null;
try {
  const c = storeCapture({ paths, sqlite }, o.paperId, png.toString('base64'));
  stored = true;
  db.transaction((tx) => c.insertRow(tx));
} catch (e) {
  error = { code: (e as NodeJS.ErrnoException).code ?? null, message: String((e as Error).message ?? e) };
}
const rows = (sqlite.prepare(`SELECT count(*) AS n FROM files`).get() as { n: number }).n;
sqlite.close();
process.stdout.write(`${JSON.stringify({ limitCheck, stored, error, rows })}\n`);
