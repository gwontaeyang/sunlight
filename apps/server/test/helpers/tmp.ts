import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';

const perTest: string[] = [];
const perFile: string[] = [];
/** Temp dir removed after the current test (tests never use the user's data dir). */
export function tempDir(prefix = 'sp-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  perTest.push(d);
  return d;
}
/** Temp dir removed after the test file (for beforeAll fixtures such as a running server). */
export function fileTempDir(prefix = 'sp-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  perFile.push(d);
  return d;
}

/** Gives the owner rwx on every directory under `dir` (lstat: a symlink is never followed, its target never changed). */
function unseal(dir: string): void {
  let mode: number;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return;
    mode = st.mode;
  } catch {
    return;
  }
  chmodSync(dir, (mode & 0o7777) | 0o700);
  for (const n of readdirSync(dir)) unseal(join(dir, n));
}
/**
 * Removes a temp tree — also one a test left sealed (`verify --seal` makes the snapshot's directories read-only, and a
 * test that fails before it unseals them left the tree behind: `rmSync` gives EACCES on the first sealed directory).
 */
export function removeTempTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw e;
  }
  unseal(dir);
  rmSync(dir, { recursive: true, force: true });
}
/** Removes every dir, going on past one that fails, then throws what failed (a leftover is still a failure of the test). */
export function removeTempDirs(dirs: string[], remove: (dir: string) => void = removeTempTree): void {
  const failed: unknown[] = [];
  for (const d of dirs) {
    try {
      remove(d);
    } catch (e) {
      failed.push(e);
    }
  }
  if (failed.length === 1) throw failed[0];
  if (failed.length > 1) throw new AggregateError(failed, `${failed.length} temp dirs not removed`);
}
afterEach(() => {
  removeTempDirs(perTest.splice(0));
});
afterAll(() => {
  removeTempDirs(perFile.splice(0));
});
