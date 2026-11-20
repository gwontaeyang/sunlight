// Runtime token file (security/token.ts, review M14). Owner: supervisor.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tokenFilePath } from '../../src/security/runtimePaths';
import { generateToken, removeRuntimeTokenFile, tokensEqual, writeRuntimeTokenFile } from '../../src/security/token';
import { tempDir } from '../helpers/tmp';

const mode = (p: string) => statSync(p).mode & 0o777;

describe('runtime token file', () => {
  it('creates a 0700 directory and a 0600 file, and replaces an older token', () => {
    const env = { XDG_RUNTIME_DIR: tempDir() };
    const file = writeRuntimeTokenFile(4310, 'a'.repeat(64), env);
    expect(file).toBe(tokenFilePath(4310, env));
    expect(mode(join(env.XDG_RUNTIME_DIR, 'study_paper'))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    writeRuntimeTokenFile(4310, 'b'.repeat(64), env);
    expect(readFileSync(file, 'utf8')).toBe('b'.repeat(64));
    expect(writeRuntimeTokenFile(4311, 'c'.repeat(64), env)).not.toBe(file); // one file per port
  });

  it('tightens a runtime directory that is too open', () => {
    const env = { XDG_RUNTIME_DIR: tempDir() };
    const dir = join(env.XDG_RUNTIME_DIR, 'study_paper');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    writeRuntimeTokenFile(4310, 'a'.repeat(64), env);
    expect(mode(dir)).toBe(0o700);
  });

  it('never writes through a symlink at the token path (existing or dangling target)', () => {
    for (const dangling of [false, true]) {
      const root = tempDir();
      const env = { XDG_RUNTIME_DIR: root };
      mkdirSync(join(root, 'study_paper'), { mode: 0o700 });
      const victim = join(root, 'victim.txt');
      if (!dangling) writeFileSync(victim, 'do not overwrite');
      symlinkSync(victim, tokenFilePath(4310, env));
      const file = writeRuntimeTokenFile(4310, 'a'.repeat(64), env);
      expect(lstatSync(file).isSymbolicLink()).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe('a'.repeat(64));
      if (dangling) expect(existsSync(victim)).toBe(false);
      else expect(readFileSync(victim, 'utf8')).toBe('do not overwrite');
    }
  });

  it('refuses a runtime directory that is a symlink or a file', () => {
    const root = tempDir();
    const real = join(root, 'elsewhere');
    mkdirSync(real);
    symlinkSync(real, join(root, 'study_paper'));
    expect(() => writeRuntimeTokenFile(4310, 'a'.repeat(64), { XDG_RUNTIME_DIR: root })).toThrow(/not a plain directory/);
    const root2 = tempDir();
    writeFileSync(join(root2, 'study_paper'), 'x');
    expect(() => writeRuntimeTokenFile(4310, 'a'.repeat(64), { XDG_RUNTIME_DIR: root2 })).toThrow();
  });

  it('removes the file only while it still holds our token', () => {
    const env = { XDG_RUNTIME_DIR: tempDir() };
    const file = writeRuntimeTokenFile(4310, 'mine', env);
    writeRuntimeTokenFile(4310, 'another server', env); // a newer server on the same port
    removeRuntimeTokenFile(file, 'mine');
    expect(readFileSync(file, 'utf8')).toBe('another server');
    removeRuntimeTokenFile(file, 'another server');
    expect(existsSync(file)).toBe(false);
    removeRuntimeTokenFile(file, 'another server'); // already gone: no throw
  });

  it('tokens are 64 hex chars, unique, and compared without early exit on length', () => {
    const a = generateToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken()).not.toBe(a);
    expect(tokensEqual(a, a)).toBe(true);
    expect(tokensEqual(a.slice(1), a)).toBe(false);
    expect(tokensEqual(undefined, a)).toBe(false);
    expect(tokensEqual('', a)).toBe(false);
  });
});
