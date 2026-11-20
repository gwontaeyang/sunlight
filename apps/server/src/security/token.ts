// Per-start API token (PLAN 3 "token 수명·전달", "runtime token 파일").
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { tokenFilePath } from './runtimePaths';

export const TOKEN_HEADER = 'x-sp-token';
export const TOKEN_META_NAME = 'sp-token';

/** New random 32-byte token (hex) for each server start. A restart invalidates the old token. */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function tokensEqual(a: string | undefined | null, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The runtime dir must be a real directory (not a symlink) owned by us with mode 0700. */
function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`runtime dir ${dir} is not a plain directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`runtime dir ${dir} is not owned by the current user`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/**
 * Writes the token for the dev Vite plugin: unlink any old file, then create with
 * O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600. Returns the file path.
 */
export function writeRuntimeTokenFile(port: number, token: string, env: Record<string, string | undefined> = process.env): string {
  const file = tokenFilePath(port, env);
  ensurePrivateDir(dirname(file));
  if (existsSync(file) || lstatExists(file)) {
    const st = lstatSync(file);
    if (st.isDirectory()) throw new Error(`token path ${file} is a directory`);
    unlinkSync(file);
  }
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return file;
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Removes the token file only while it still holds OUR token (never the file of another server on this port). */
export function removeRuntimeTokenFile(file: string, token: string): void {
  try {
    if (lstatSync(file).isFile() && readFileSync(file, 'utf8') === token) unlinkSync(file);
  } catch {
    /* already gone */
  }
}
