import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startServer } from '../apps/server/src/index';
import { configFilePath, resolveDataDir } from '../apps/server/src/security/runtimePaths';

if (process.argv.length !== 3 || process.argv[2] !== '--user-data') throw new Error('start:user requires --user-data');
const supplied = ['SP_DATA_DIR', 'SP_CONFIG_PATH', 'SP_SECRETS_DIR'].some((k) => process.env[k] !== undefined);
if (!supplied) {
  const data = resolveDataDir();
  const config = join(dirname(data), 'study_paper-config', 'config.json');
  if (existsSync(configFilePath()) && !existsSync(config))
    throw new Error('Move your previous config.json into study_paper-config beside your data directory, then restart.');
  process.env.SP_DATA_DIR = data;
  process.env.SP_CONFIG_PATH = config;
  process.env.SP_SECRETS_DIR = join(dirname(data), 'study_paper-secrets');
}
await startServer(true);
