// One port rule for the server and the Vite dev plugin (review M13). Owner: supervisor.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { resolveApiPort, resolveWebPort } from '../../src/security/runtimePaths';
import { tempDir } from '../helpers/tmp';

describe('port resolution', () => {
  it('SP_PORT, else the config file, else 4310 — identical for loadConfig (server) and resolveApiPort (Vite)', () => {
    const dir = tempDir();
    const file = join(dir, 'config.json');
    const none = { SP_CONFIG_PATH: join(dir, 'missing.json'), SP_DATA_DIR: dir };
    expect(resolveApiPort(none)).toBe(4310);
    expect(resolveWebPort(none)).toBe(5173);
    writeFileSync(file, JSON.stringify({ port: 4311 }));
    const fromFile = { SP_CONFIG_PATH: file, SP_DATA_DIR: dir };
    expect(resolveApiPort(fromFile)).toBe(4311);
    expect(loadConfig(fromFile).port).toBe(4311);
    const fromEnv = { ...fromFile, SP_PORT: '4444', SP_WEB_PORT: '5222' };
    expect(resolveApiPort(fromEnv)).toBe(4444);
    expect(loadConfig(fromEnv)).toMatchObject({ port: 4444, webPort: 5222 });
  });

  it('rejects ports that are not integers in 1024–65535', () => {
    const dir = tempDir();
    const env = { SP_CONFIG_PATH: join(dir, 'missing.json') };
    expect(() => resolveApiPort({ ...env, SP_PORT: '80' })).toThrow(/SP_PORT/);
    expect(() => resolveApiPort({ ...env, SP_PORT: 'abc' })).toThrow(/SP_PORT/);
    expect(() => resolveWebPort({ SP_WEB_PORT: '70000' })).toThrow(/SP_WEB_PORT/);
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ port: 'x' }));
    expect(() => resolveApiPort({ SP_CONFIG_PATH: file })).toThrow(/port in/);
  });
});
