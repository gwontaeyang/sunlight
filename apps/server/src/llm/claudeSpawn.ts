// How to launch the `claude` CLI on each OS, as a pure function (no child_process here, so the spawn-entry-point
// inventory test still pins claudeCli.ts as the only model spawn). claudeCli.ts calls this, then does the one spawn.
//
// POSIX: run claudeBin directly, no shell (unchanged).
//
// Windows (win32): Node cannot exec a .cmd/.bat batch shim without a shell, and a shell (cmd.exe) mangles this app's
// argv — the run carries a ~3 KB multi-line --system-prompt and sometimes a --json-schema, which cmd.exe would split
// on spaces and reinterpret quotes/metacharacters. So we PREFER a directly-spawnable image (claude.exe / .com): run
// it with shell:false, where Node quotes each argument and the real executable receives the argv intact. Only when no
// such image can be found (a .cmd/.bat shim, or an unresolved bare name) do we fall back to shell:true — documented as
// unreliable for long prompts; the README tells Windows users to install the native claude.exe or point SP_CLAUDE_BIN
// at an .exe. SP_CLAUDE_BIN keeps working on both OSes (an explicit path is honoured as given).
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface SpawnPlan {
  /** First argument to spawn(). */
  command: string;
  /** argv (unchanged from buildArgs). */
  args: string[];
  /** spawn()'s shell option. true only as the win32 last resort for a batch shim / unresolved bare name. */
  shell: boolean;
}

export interface ResolveSpawnOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Injected in tests to resolve a synthetic PATH × PATHEXT without touching the real filesystem. */
  fileExists?: (p: string) => boolean;
}

/** Windows images Node can spawn directly without a shell. */
const DIRECT_EXTS = new Set(['.exe', '.com']);

/** Resolve how to spawn `claudeBin` with `args` on the active OS. See the file header for the win32 reasoning. */
export function resolveClaudeSpawn(claudeBin: string, args: string[], opts: ResolveSpawnOptions = {}): SpawnPlan {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { command: claudeBin, args, shell: false };

  const env = opts.env ?? process.env;
  const exists = opts.fileExists ?? existsSync;
  const hasSeparator = claudeBin.includes('\\') || claudeBin.includes('/');
  const ext = win32.extname(claudeBin).toLowerCase();

  // An explicit path, or a name that already carries an extension: honour it exactly.
  if (hasSeparator || ext) {
    return { command: claudeBin, args, shell: !DIRECT_EXTS.has(ext) };
  }

  // A bare name ("claude"): search PATH × PATHEXT, preferring a directly-spawnable image over a batch shim.
  const pathext = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  const dirs = (env.PATH ?? env.Path ?? '').split(win32.delimiter).filter(Boolean);
  let shellFallback: string | null = null;
  for (const dir of dirs) {
    for (const pe of pathext) {
      const candidate = win32.join(dir, claudeBin + pe);
      if (!exists(candidate)) continue;
      if (DIRECT_EXTS.has(pe.toLowerCase())) return { command: candidate, args, shell: false };
      shellFallback ??= candidate; // first batch shim found; used only if no direct image exists
    }
  }
  if (shellFallback) return { command: shellFallback, args, shell: true };
  // Nothing on PATH: let the shell resolve "claude" via PATHEXT at spawn time (last resort).
  return { command: claudeBin, args, shell: true };
}
