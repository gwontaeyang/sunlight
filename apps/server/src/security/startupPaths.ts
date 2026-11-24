import { lstatSync } from 'node:fs';
import { APP_DATA_ENTRIES, findTreeLink } from './dataTree';
import { activePath } from './platform';
import { existingRealpath, realDataDirMatcher, realDataRoots } from './realDataDir';

type Env = Record<string, string | undefined>;

/**
 * Validate caller-supplied paths before using the optional config file or touching any application data: both set;
 * outside the user data directory (unless the approved user launcher); and the data tree link-free (결정 62 — also for
 * the user launcher: a linked real data directory stops rather than writes through the link); and, unless approved, no
 * managed entry overlapping one of a user data directory by real path (결정 64).
 */
export function assertStartupPaths(env: Env = process.env, userLauncher = false): void {
  for (const key of ['SP_DATA_DIR', 'SP_CONFIG_PATH'] as const) {
    if (!env[key]?.trim()) throw new Error(`${key} is required`);
  }
  const P = activePath();
  const underRealData = realDataDirMatcher(env);
  if (!userLauncher) {
    for (const key of ['SP_DATA_DIR', 'SP_CONFIG_PATH'] as const) {
      if (underRealData(env[key]!)) throw new Error(`${key} points into the user data directory`);
    }
  }
  const root = P.resolve(env.SP_DATA_DIR!);
  // Before any directory is listed: a managed entry shared with a user data directory is never walked (결정 64).
  if (!userLauncher) assertNoOverlapWithUserData(root, env);
  const link = findTreeLink(root, APP_DATA_ENTRIES);
  if (link?.kind === 'symlink') {
    const where = !userLauncher && underRealData(P.join(root, link.rel)) ? 'resolves into the user data directory' : 'is a symbolic link';
    throw new Error(`SP_DATA_DIR entry ${link.rel} ${where}; the data tree must not contain links`);
  }
  if (link?.kind === 'hardlink') {
    const name = link.rel.startsWith('db/') ? `database file ${P.relative('db', link.rel)}` : `file ${link.rel}`;
    throw new Error(`SP_DATA_DIR ${name} has ${link.links} hard links (${link.links - link.inTree} outside the data directory); the data tree must not share files`);
  }
}

/** `a` and `b` (real paths) are the same place or one holds the other. */
function overlap(a: string, b: string): boolean {
  const P = activePath();
  const inside = (dir: string, p: string) => {
    const r = P.relative(dir, p);
    return r === '' || (r !== '..' && !r.startsWith(`..${P.sep}`) && !P.isAbsolute(r));
  };
  return inside(a, b) || inside(b, a);
}

/**
 * The other direction of 결정 64: a user data directory whose own entry is a link into this tree (its tmp/ → the
 * scratch tmp/) is not seen by the tree walk, and start-up recovery would empty it. The real path of every managed
 * entry here must neither hold nor lie inside the real path of any managed entry of a user data directory. That side
 * is resolved from metadata only (realpath / lstat / readlink): never listed inside, never written; a missing one is
 * fine (it resolves to its own place).
 */
function assertNoOverlapWithUserData(root: string, env: Env): void {
  const P = activePath();
  const mine = APP_DATA_ENTRIES.map((name) => ({ name, at: existingRealpath(P.join(root, name)) }));
  for (const userRoot of realDataRoots(env)) {
    for (const theirs of APP_DATA_ENTRIES) {
      const at = existingRealpath(P.join(userRoot, theirs));
      const hit = mine.find((m) => overlap(m.at, at));
      if (!hit) continue;
      // The entry here is itself the link (the tree rule's case, worded as the tree walk words it); otherwise the link
      // is on the user data side.
      if (isSymlink(P.join(root, hit.name))) throw new Error(`SP_DATA_DIR entry ${hit.name} resolves into the user data directory; the data tree must not contain links`);
      throw new Error(`SP_DATA_DIR ${hit.name} overlaps ${theirs} of the user data directory ${userRoot} (${at}); refused before start-up`);
    }
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
