// The real data directory rule, in one place for every script that must not touch it: localApi (dev token files) and
// dataSnapshot (path arguments of data:snapshot and rehearsal). Each caller keeps its own error type and wording (and
// dataSnapshot its SP_SNAPSHOT_ALLOW_REAL switch); the judgement is this function.
//
// The real data directory is ~/.local/share/study_paper* or $XDG_DATA_HOME/study_paper* on Linux/macOS, and on
// Windows (win32) %APPDATA%\Sunlight* / %LOCALAPPDATA%\Sunlight* / <home>\Sunlight* — a string prefix, so siblings
// such as study_paper-pre-m2 (or Sunlight-pre-m2) count — and a path counts as under it before and after resolving
// symbolic links / junctions (of the path and of the prefix's parent). "~" is both env.HOME and the account's home
// from the user database (RM-R1-04 (2): a run with HOME moved to a scratch directory still refuses the user's real
// home). An entry of the prefix's parent whose name has the prefix and that is a symbolic link (study_paper itself,
// study_paper-pre-m2, …) also refuses everything inside its target (RM-R1-04 (1)), even when the target does not
// exist yet.
//
// All path arithmetic goes through activePath() (path.win32 on Windows, path.posix elsewhere) so the comparison uses
// the OS's own separators, drive letters and — on win32 — case-insensitivity; on Linux this is byte-identical to the
// previous POSIX code. realpathSync/lstatSync are the OS-native calls and resolve junctions on real Windows.
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { activePath, isWindows, pathStartsWithPrefix } from './platform';

/** Symbolic links followed through dangling links before the path is taken as it is (a loop ends there). */
const MAX_LINK_HOPS = 40;

/**
 * The real path of `p` (absolute) as far as it can be known: the realpath of its longest existing ancestor with the
 * missing rest appended — and a dangling symbolic link on the way counts as its target (a link to a directory that
 * does not exist yet is where a later mkdir lands). `p` itself when nothing exists.
 */
export function existingRealpath(p: string, hops = 0): string {
  const P = activePath();
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return P.join(realpathSync(cur), ...rest.reverse());
    } catch {
      /* missing, or a dangling link (looked at below) */
    }
    if (hops < MAX_LINK_HOPS) {
      try {
        if (lstatSync(cur).isSymbolicLink()) return P.join(existingRealpath(P.resolve(P.dirname(cur), readlinkSync(cur)), hops + 1), ...rest.reverse());
      } catch {
        /* not there at all: go up */
      }
    }
    const parent = P.dirname(cur);
    if (parent === cur) return p;
    rest.push(P.basename(cur));
    cur = parent;
  }
}

/** The account's home from the user database (not $HOME), or null when there is none. */
function accountHome(): string | null {
  try {
    return userInfo().homedir || null;
  } catch {
    return null;
  }
}

/** `child` is `dir` or inside it (both absolute). */
function isInsideDir(dir: string, child: string): boolean {
  const P = activePath();
  const r = P.relative(dir, child);
  return r === '' || (r !== '..' && !r.startsWith(`..${P.sep}`) && !P.isAbsolute(r));
}

/** Resolved targets of the symbolic links in dirname(pre) whose names start with basename(pre). */
function linkedTargets(pre: string): string[] {
  const P = activePath();
  const parent = P.dirname(pre);
  const stem = P.basename(pre);
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink() || !startsWithStem(entry.name, stem)) continue;
    const p = P.join(parent, entry.name);
    try {
      out.push(existingRealpath(P.resolve(parent, readlinkSync(p))));
    } catch {
      /* gone meanwhile or unreadable: nothing to add */
    }
  }
  return out;
}

/** Entry-name prefix test — case-insensitive on win32 (NTFS), exact on posix. */
function startsWithStem(name: string, stem: string): boolean {
  return isWindows() ? name.toLowerCase().startsWith(stem.toLowerCase()) : name.startsWith(stem);
}

/**
 * The rule below for many paths at once: the prefixes and the targets of linked entries are looked up once, then the
 * returned function answers for each path (the startup check asks for every entry of a data directory).
 */
export function realDataDirMatcher(env: Record<string, string | undefined>): (path: string) => string | null {
  const P = activePath();
  const prefixes = realDataPrefixes(env);
  const targets = [...new Set(prefixes.flatMap(linkedTargets))];
  return (path) => {
    const abs = P.resolve(path);
    for (const cand of [abs, existingRealpath(abs)]) {
      for (const pre of prefixes) if (pathStartsWithPrefix(cand, pre)) return pre;
      for (const dir of targets) if (isInsideDir(dir, cand)) return dir;
    }
    return null;
  };
}

/**
 * The real-data directory prefixes. On Windows (win32): %APPDATA%\Sunlight, %LOCALAPPDATA%\Sunlight and
 * <home>\Sunlight (every base resolveDataDir might pick), each with its parent resolved. On Linux/macOS:
 * ~/.local/share/study_paper of HOME and of the account, $XDG_DATA_HOME/study_paper, and each with its parent
 * resolved. Unchanged POSIX behaviour.
 */
function realDataPrefixes(env: Record<string, string | undefined>): string[] {
  const P = activePath();
  const withResolvedParents = (prefixes: string[]): string[] => {
    for (const pre of [...prefixes]) if (existsSync(P.dirname(pre))) prefixes.push(P.join(existingRealpath(P.dirname(pre)), P.basename(pre)));
    return [...new Set(prefixes)];
  };
  if (isWindows()) {
    const bases = [env.APPDATA, env.LOCALAPPDATA, env.HOME || homedir(), accountHome()].filter((b): b is string => !!b);
    return withResolvedParents([...new Set(bases)].map((b) => P.join(b, 'Sunlight')));
  }
  const homes = [env.HOME || homedir()];
  const account = accountHome();
  if (account !== null && !homes.includes(account)) homes.push(account);
  const prefixes = homes.map((h) => P.join(h, '.local', 'share', 'study_paper'));
  if (env.XDG_DATA_HOME) prefixes.push(P.join(P.resolve(env.XDG_DATA_HOME), 'study_paper'));
  return withResolvedParents(prefixes);
}

/**
 * The user data directories themselves: each prefix and every entry of its parent whose name has the prefix
 * (study_paper, study_paper-pre-m2, …; on win32 Sunlight, Sunlight-pre-m2, …) — the parent is listed, never the
 * inside of a user data directory.
 */
export function realDataRoots(env: Record<string, string | undefined>): string[] {
  const P = activePath();
  const roots = new Set<string>();
  for (const pre of realDataPrefixes(env)) {
    roots.add(pre);
    let names: string[];
    try {
      names = readdirSync(P.dirname(pre));
    } catch {
      continue;
    }
    for (const name of names) if (startsWithStem(name, P.basename(pre))) roots.add(P.join(P.dirname(pre), name));
  }
  return [...roots];
}

/** The real-data-directory prefix that `path` (resolved) falls under, or null. HOME and XDG_DATA_HOME come from `env`. */
export function realDataDirPrefixOf(path: string, env: Record<string, string | undefined>): string | null {
  return realDataDirMatcher(env)(path);
}
