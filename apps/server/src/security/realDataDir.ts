// The real data directory rule, in one place for every script that must not touch it: localApi (dev token files) and
// dataSnapshot (path arguments of data:snapshot and rehearsal). Each caller keeps its own error type and wording (and
// dataSnapshot its SP_SNAPSHOT_ALLOW_REAL switch); the judgement is this function.
//
// The real data directory is ~/.local/share/study_paper* or $XDG_DATA_HOME/study_paper* — a string prefix, so siblings
// such as study_paper-pre-m2 count — and a path counts as under it before and after resolving symbolic links (of the
// path and of the prefix's parent). "~" is both env.HOME and the account's home from the user database (RM-R1-04 (2):
// a run with HOME moved to a scratch directory still refuses the user's real home). An entry of the prefix's parent
// whose name has the prefix and that is a symbolic link (study_paper itself, study_paper-pre-m2, …) also refuses
// everything inside its target (RM-R1-04 (1)), even when the target does not exist yet.
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Symbolic links followed through dangling links before the path is taken as it is (a loop ends there). */
const MAX_LINK_HOPS = 40;

/**
 * The real path of `p` (absolute) as far as it can be known: the realpath of its longest existing ancestor with the
 * missing rest appended — and a dangling symbolic link on the way counts as its target (a link to a directory that
 * does not exist yet is where a later mkdir lands). `p` itself when nothing exists.
 */
export function existingRealpath(p: string, hops = 0): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      /* missing, or a dangling link (looked at below) */
    }
    if (hops < MAX_LINK_HOPS) {
      try {
        if (lstatSync(cur).isSymbolicLink()) return join(existingRealpath(resolve(dirname(cur), readlinkSync(cur)), hops + 1), ...rest.reverse());
      } catch {
        /* not there at all: go up */
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return p;
    rest.push(basename(cur));
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
  const r = relative(dir, child);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** Resolved targets of the symbolic links in dirname(pre) whose names start with basename(pre). */
function linkedTargets(pre: string): string[] {
  const parent = dirname(pre);
  const stem = basename(pre);
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink() || !entry.name.startsWith(stem)) continue;
    const p = join(parent, entry.name);
    try {
      out.push(existingRealpath(resolve(parent, readlinkSync(p))));
    } catch {
      /* gone meanwhile or unreadable: nothing to add */
    }
  }
  return out;
}

/**
 * The rule below for many paths at once: the prefixes and the targets of linked entries are looked up once, then the
 * returned function answers for each path (the startup check asks for every entry of a data directory).
 */
export function realDataDirMatcher(env: Record<string, string | undefined>): (path: string) => string | null {
  const prefixes = realDataPrefixes(env);
  const targets = [...new Set(prefixes.flatMap(linkedTargets))];
  return (path) => {
    const abs = resolve(path);
    for (const cand of [abs, existingRealpath(abs)]) {
      for (const pre of prefixes) if (cand.startsWith(pre)) return pre;
      for (const dir of targets) if (isInsideDir(dir, cand)) return dir;
    }
    return null;
  };
}

/** ~/.local/share/study_paper of HOME and of the account, $XDG_DATA_HOME/study_paper, and each with its parent resolved. */
function realDataPrefixes(env: Record<string, string | undefined>): string[] {
  const homes = [env.HOME || homedir()];
  const account = accountHome();
  if (account !== null && !homes.includes(account)) homes.push(account);
  const prefixes = homes.map((h) => join(h, '.local', 'share', 'study_paper'));
  if (env.XDG_DATA_HOME) prefixes.push(join(resolve(env.XDG_DATA_HOME), 'study_paper'));
  for (const pre of [...prefixes]) if (existsSync(dirname(pre))) prefixes.push(join(existingRealpath(dirname(pre)), basename(pre)));
  return prefixes;
}

/**
 * The user data directories themselves: each prefix and every entry of its parent whose name has the prefix
 * (study_paper, study_paper-pre-m2, …) — the parent is listed, never the inside of a user data directory.
 */
export function realDataRoots(env: Record<string, string | undefined>): string[] {
  const roots = new Set<string>();
  for (const pre of realDataPrefixes(env)) {
    roots.add(pre);
    let names: string[];
    try {
      names = readdirSync(dirname(pre));
    } catch {
      continue;
    }
    for (const name of names) if (name.startsWith(basename(pre))) roots.add(join(dirname(pre), name));
  }
  return [...roots];
}

/** The real-data-directory prefix that `path` (resolved) falls under, or null. HOME and XDG_DATA_HOME come from `env`. */
export function realDataDirPrefixOf(path: string, env: Record<string, string | undefined>): string | null {
  return realDataDirMatcher(env)(path);
}
