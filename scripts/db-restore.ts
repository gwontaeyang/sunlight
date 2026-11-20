// Usage (server stopped): npm run db:restore -- <backup file>
import { resolve } from 'node:path';
import { restoreBackup } from '../apps/server/src/db/restore';
import { dataPaths } from '../apps/server/src/paths';
import { assertStartupPaths } from '../apps/server/src/security/startupPaths';
import { resolveDataDir } from '../apps/server/src/security/runtimePaths';

const backup = process.argv[2];
if (!backup) {
  console.error('usage: npm run db:restore -- <backup file>');
  process.exit(2);
}
try {
  assertStartupPaths();
  const paths = dataPaths(resolveDataDir());
  const r = restoreBackup(paths, resolve(backup));
  console.log(`restored ${backup} -> ${paths.dbFile}\nprevious DB files moved to ${r.movedTo}`);
} catch (e) {
  console.error(`db:restore failed: ${(e as Error).message}`);
  process.exit(1);
}
