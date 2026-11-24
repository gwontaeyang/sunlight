// Path and port rules shared by the server and the Vite dev plugin (apps/web/vite.config.ts imports this file),
// so both always agree on the data dir, the token file and the ports.
// Keep it free of side effects and of imports other than node:fs / node:path / node:os.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';

type Env = Record<string, string | undefined>;

/**
 * SP_DATA_DIR, else the per-OS default (PLAN 2.1):
 *  - Linux/macOS: ${XDG_DATA_HOME:-~/.local/share}/study_paper (unchanged);
 *  - Windows (win32): %APPDATA%\Sunlight (fallback %LOCALAPPDATA%, then the home directory).
 * The Windows folder uses the shown app name (Sunlight) because that is where a Windows user expects per-user app
 * data; the package / repository name stays study_paper. win32 joins keep this correct under a mocked platform.
 */
export function resolveDataDir(env: Env = process.env): string {
  if (env.SP_DATA_DIR) return resolve(env.SP_DATA_DIR);
  if (process.platform === 'win32') {
    const base = env.APPDATA || env.LOCALAPPDATA || homedir();
    return win32.join(base, 'Sunlight');
  }
  const xdg = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdg, 'study_paper');
}

/** ${XDG_RUNTIME_DIR}/study_paper, else <dataDir>/run (PLAN 3 "runtime token 파일"). */
export function runtimeDir(env: Env = process.env): string {
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'study_paper') : join(resolveDataDir(env), 'run');
}

/**
 * One token file per backend port so parallel worktrees (own SP_PORT) do not overwrite each other.
 * The dev Vite plugin reads the file of the port it proxies to.
 */
export function tokenFilePath(port: number, env: Env = process.env): string {
  return join(runtimeDir(env), `token.${port}`);
}

export const DEFAULT_PORT = 4310;
export const DEFAULT_WEB_PORT = 5173;

/** SP_CONFIG_PATH, else ${XDG_CONFIG_HOME:-~/.config}/study_paper/config.json (PLAN 2.1). */
export function configFilePath(env: Env = process.env): string {
  if (env.SP_CONFIG_PATH) return resolve(env.SP_CONFIG_PATH);
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'study_paper', 'config.json');
}

function portFrom(value: unknown, source: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`${source} must be a port number (1024–65535), got ${String(value)}`);
  return n;
}

/** Backend port: SP_PORT, else `port` of the config file, else 4310. The one rule for server AND Vite. */
export function resolveApiPort(env: Env = process.env): number {
  const fromEnv = portFrom(env.SP_PORT, 'SP_PORT');
  if (fromEnv !== undefined) return fromEnv;
  const file = configFilePath(env);
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`invalid config file ${file}: ${(e as Error).message}`);
    }
    const fromFile = portFrom((parsed as { port?: unknown } | null)?.port, `port in ${file}`);
    if (fromFile !== undefined) return fromFile;
  }
  return DEFAULT_PORT;
}

/** Vite dev port: SP_WEB_PORT, else 5173. */
export function resolveWebPort(env: Env = process.env): number {
  return portFrom(env.SP_WEB_PORT, 'SP_WEB_PORT') ?? DEFAULT_WEB_PORT;
}
