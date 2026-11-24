// OS flavour helpers shared by the path/security code so the Windows (win32) branches are exercised by Linux unit
// tests that override process.platform. No side effects; imports node:path only (safe for the Vite config too).
//
// The platform is read at call time (never cached) so a test can set process.platform = 'win32' with
// Object.defineProperty before calling in. On a real OS this is a no-op: activePath() is node's native path, and on
// Linux posix === the default `path`, so every caller keeps byte-identical POSIX behaviour.
import { posix, win32 } from 'node:path';

/** True on native Windows (and under a test that mocked process.platform to 'win32'). */
export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/** The path flavour of the active OS: path.win32 on Windows, path.posix elsewhere (identical to native on each). */
export function activePath(): typeof posix {
  return isWindows() ? win32 : posix;
}

/**
 * Does the resolved path `child` fall under the prefix string `prefix`? A plain string-prefix test (so siblings such
 * as `study_paper-pre-m2` / `Sunlight-pre-m2` count, by design). On win32 the comparison is case-insensitive because
 * the filesystem is; separators are already unified by activePath().resolve() before this is called.
 */
export function pathStartsWithPrefix(child: string, prefix: string): boolean {
  return isWindows() ? child.toLowerCase().startsWith(prefix.toLowerCase()) : child.startsWith(prefix);
}

/**
 * Are two paths the same place by name? Exact on posix; case-insensitive on win32 (NTFS), because realpathSync there
 * returns the on-disk casing, which a direct `===` against the requested path would wrongly reject. Both paths are
 * expected already resolved (same separators).
 */
export function pathEquals(a: string, b: string): boolean {
  return isWindows() ? a.toLowerCase() === b.toLowerCase() : a === b;
}
