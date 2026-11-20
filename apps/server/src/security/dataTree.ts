// The link-free data tree rule (INTEGRATION_NOTES 결정 62). Owner: supervisor.
//
// Threat model: an accidental scratch copy of the user's data — a folder joined in with a symbolic link, or a `cp -al`
// copy whose files share their inodes with the original. Writing such a copy (a migration, the start-up clean-up, a
// seal's chmod, a PID file) would change the original. Deliberate attacks and swaps while a command runs (TOCTOU) are
// out of scope. One rule instead of a check per sub-path: the tree a command opens must not contain a symbolic link
// anywhere, and every regular file in it must have all its hard links inside that same tree (a link the command made
// itself and a crash left behind — the instance lock, a published file's .part — stays inside and is no copy).
//
// The walk never follows a link: readdir with file types, lstat only for regular files (their link count).
import { lstatSync, readdirSync, statSync, Stats, type Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * The managed tree of a data directory: every entry the app or its tools create, open or write (dataPaths; fixtures/ is
 * written by fetch-fixtures). Links are judged over all of them at once, so two names of one file inside the managed
 * tree (papers/ ↔ fixtures/) are internal. Anything else in the directory (a scratch folder) is not managed and not
 * walked; shared read-only fixtures belong outside it (SP_FIXTURES_DIR), not linked in.
 */
export const APP_DATA_ENTRIES = ['db', 'papers', 'backups', 'tmp', 'claude-cwd', 'run', 'fixtures'] as const;

export type TreeLink =
  | { kind: 'symlink'; rel: string }
  | { kind: 'hardlink'; rel: string; links: number; inTree: number };

/**
 * The first link `root` holds (walk order), or null. `entries`: walk only these top-level names (a data directory);
 * absent: the whole tree (a snapshot). A missing root or entry holds nothing; a root that is not a directory is not
 * walked (the callers' own checks refuse it). The root path itself may be reached through a link — its contents are
 * what is checked.
 */
export function findTreeLink(root: string, entries?: readonly string[]): TreeLink | null {
  try {
    if (!statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  const shared = new Map<string, { rel: string; links: number; inTree: number }>();
  const dirs: { abs: string; rel: string }[] = [];
  /** One entry: a link ends the walk, a directory is queued, a regular file with more than one link is counted. */
  const visit = (abs: string, rel: string, type: Dirent | Stats): TreeLink | null => {
    if (type.isSymbolicLink()) return { kind: 'symlink', rel };
    if (type.isDirectory()) dirs.push({ abs, rel });
    else if (type.isFile()) {
      const st = type instanceof Stats ? type : lstatSync(abs);
      if (st.nlink > 1) {
        const key = `${st.dev}:${st.ino}`;
        const seen = shared.get(key);
        if (seen) seen.inTree++;
        else shared.set(key, { rel, links: st.nlink, inTree: 1 });
      }
    }
    return null;
  };
  if (entries) {
    for (const name of entries) {
      let st: Stats;
      try {
        st = lstatSync(join(root, name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      const found = visit(join(root, name), name, st);
      if (found) return found;
    }
  } else {
    dirs.push({ abs: root, rel: '' });
  }
  for (let i = 0; i < dirs.length; i++) {
    const { abs, rel } = dirs[i]!;
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const found = visit(join(abs, d.name), rel ? `${rel}/${d.name}` : d.name, d);
      if (found) return found;
    }
  }
  for (const s of shared.values()) if (s.inTree < s.links) return { kind: 'hardlink', ...s };
  return null;
}
