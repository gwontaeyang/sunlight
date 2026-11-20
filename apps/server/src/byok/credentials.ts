import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PutSecretRequest } from '@study-paper/shared/contracts/api';
import { existingRealpath, realDataDirMatcher } from '../security/realDataDir';

type Env = Record<string, string | undefined>;
type Stored = { generation: string; updatedAt: number; key: string | null };
const unsafe = () => new Error('credential storage is unavailable');
const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Validate all paths before creating directories or opening a DB. Existing app data stays in place. */
export function credentialDirectory(env: Env, userLauncher: boolean): string {
  const { SP_SECRETS_DIR: raw, SP_DATA_DIR: data, SP_CONFIG_PATH: config } = env;
  if (!raw?.trim() || !data?.trim() || !config?.trim()) throw new Error('SP_DATA_DIR, SP_CONFIG_PATH and SP_SECRETS_DIR are required');
  const roots = [resolve(data), dirname(resolve(config)), resolve(raw)];
  if (new Set(roots).size !== 3 || new Set(roots.map((dir) => dirname(dir))).size !== 1)
    throw new Error('data, config and secrets must be separate sibling directories');
  if ([...roots, resolve(config)].some((path) => existingRealpath(path) !== path))
    throw new Error('linked application paths are forbidden');
  try {
    const st = lstatSync(resolve(config));
    if (!st.isFile() || st.nlink !== 1) throw new Error('config must be an unlinked regular file');
  } catch (e) {
    if (!missing(e)) throw e;
  }
  if (!userLauncher && roots.some(realDataDirMatcher(env))) throw new Error('scratch paths overlap user data');
  return roots[2]!;
}

export class CredentialStore {
  private listeners = new Set<() => void>();
  constructor(readonly dir: string) {}
  private ensureDir() {
    if (existingRealpath(this.dir) !== this.dir) throw unsafe();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.dir);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw unsafe();
  }
  read(): Stored | null {
    this.ensureDir();
    let fd: number;
    try {
      fd = openSync(join(this.dir, 'anthropic.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      if (missing(e)) return null;
      throw unsafe();
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 2048 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1)
        throw unsafe();
      const v = JSON.parse(readFileSync(fd, 'utf8')) as Stored;
      if (
        typeof v.generation !== 'string' ||
        !Number.isSafeInteger(v.updatedAt) ||
        (v.key !== null && !PutSecretRequest.safeParse({ key: v.key }).success)
      )
        throw unsafe();
      return { generation: v.generation, updatedAt: v.updatedAt, key: v.key };
    } catch {
      throw unsafe();
    } finally {
      closeSync(fd);
    }
  }
  status() {
    const v = this.read();
    return { keyConfigured: Boolean(v?.key), generation: v?.generation ?? null, updatedAt: v?.updatedAt ?? null };
  }
  change(key: string | null) {
    if (key !== null && !PutSecretRequest.safeParse({ key }).success) throw new Error('invalid inference credential');
    this.read(); // Validate any existing destination before replacing it.
    const target = join(this.dir, 'anthropic.json');
    const tmp = join(this.dir, '.anthropic-' + process.pid + '-' + randomUUID() + '.tmp');
    const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify({ key, generation: randomUUID(), updatedAt: Date.now() }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, target);
      for (const listener of this.listeners) listener();
      const directory = openSync(this.dir, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      if (existsSync(tmp)) rmSync(tmp);
    }
    return this.status();
  }
  recoverTemps() {
    this.ensureDir();
    for (const name of readdirSync(this.dir)) {
      const match = /^\.anthropic-(\d+)-[\da-f-]{36}\.tmp$/.exec(name);
      if (!match) continue;
      try {
        process.kill(Number(match[1]), 0);
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      }
      const path = join(this.dir, name);
      const st = lstatSync(path);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw unsafe();
      rmSync(path);
    }
  }
  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
