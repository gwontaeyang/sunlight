// Seeds synthetic papers into SP_DATA_DIR (default app data dir).
// Usage: SP_DATA_DIR=<dir> npm run seed:fixture [-- <list>]
//   <list> = comma-separated m1,m2,upgrade,links, or `all` (default: m1 — the M1 seed only)
import { openSqlite, toDrizzle } from '../apps/server/src/db/client';
import { migrateWithBackup } from '../apps/server/src/db/migrate';
import { ALL_SEED_PAPERS, seedFixture, type SeedPaper } from '../apps/server/src/dev/seedFixture';
import { dataPaths, ensureDataDirs } from '../apps/server/src/paths';
import { assertStartupPaths } from '../apps/server/src/security/startupPaths';
import { resolveDataDir } from '../apps/server/src/security/runtimePaths';

assertStartupPaths();
const arg = process.argv[2];
const papers: SeedPaper[] = !arg ? ['m1'] : arg === 'all' ? [...ALL_SEED_PAPERS] : (arg.split(',') as SeedPaper[]);
for (const p of papers) if (!ALL_SEED_PAPERS.includes(p)) throw new Error(`unknown seed ${p} (use ${ALL_SEED_PAPERS.join(',')} or all)`);
const paths = dataPaths(resolveDataDir());
ensureDataDirs(paths);
const sqlite = openSqlite(paths.dbFile);
await migrateWithBackup(sqlite, { backupsDir: paths.backupsDir });
const id = await seedFixture(toDrizzle(sqlite), sqlite, paths, Date.now(), { papers });
sqlite.close();
console.log(`seeded ${papers.join(', ')} (first ${id}) into ${paths.root}`);
