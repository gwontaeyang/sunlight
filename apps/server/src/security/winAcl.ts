// Best-effort Windows ACL hardening for per-user data directories (task item 3). POSIX file modes (0o700 / 0o600) are
// meaningless on win32, so on Windows we instead ask icacls to restrict a directory to the current user (plus SYSTEM
// and the local Administrators group, by well-known SID so it works on any system locale), and remove inherited broad
// access. This is ALWAYS best-effort and non-fatal: on any failure the caller keeps running and relies on the
// %APPDATA% user-profile ACLs that Windows already applies to a user's roaming profile. UNVERIFIED on Windows — this
// code is written and reasoned about on Linux and cannot be executed here; the Windows validation procedure in the
// report checks it on a real PC.
//
// This is the second (and only other) file allowed to import node:child_process; the spawn-entry-point inventory test
// pins it and asserts the spawn is a win32-guarded icacls call, never a model child (those stay in claudeCli.ts).
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';

export interface AclResult {
  /** true only when icacls ran and reported success. */
  applied: boolean;
  /** A short reason, for an optional startup log; never contains secrets. */
  detail: string;
}

/** Well-known SIDs kept alongside the user, so admin tools / the OS still reach the data. Locale-independent. */
const SYSTEM_SID = '*S-1-5-18';
const ADMINISTRATORS_SID = '*S-1-5-32-544';

/**
 * Restrict `dir` to the current user on win32 (best-effort, non-fatal). Returns applied:false with a reason on any
 * other OS or on any icacls failure. The platform is injectable for tests.
 */
export function restrictDirToCurrentUser(dir: string, opts: { platform?: NodeJS.Platform } = {}): AclResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { applied: false, detail: 'not win32: relying on POSIX modes' };
  let user: string;
  try {
    user = userInfo().username;
  } catch (e) {
    return { applied: false, detail: `userInfo failed: ${(e as Error).message}` };
  }
  if (!user) return { applied: false, detail: 'no current user name' };
  try {
    const r = spawnSync(
      'icacls',
      [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/grant:r', `${SYSTEM_SID}:(OI)(CI)F`, '/grant:r', `${ADMINISTRATORS_SID}:(OI)(CI)F`],
      { timeout: 5_000, windowsHide: true, stdio: 'ignore' },
    );
    if (r.error) return { applied: false, detail: `icacls not run: ${r.error.message}` };
    if (typeof r.status === 'number' && r.status !== 0) return { applied: false, detail: `icacls exit ${r.status}` };
    return { applied: true, detail: `restricted to ${user} (+SYSTEM,Administrators)` };
  } catch (e) {
    return { applied: false, detail: `icacls threw: ${(e as Error).message}` };
  }
}
