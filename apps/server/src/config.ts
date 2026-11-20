import { credentialDirectory } from './byok/credentials';
// Runtime configuration: config file (optional) + environment overrides. PLAN 2.1, 2.2.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_CONCURRENCY } from '@study-paper/shared/contracts/tasks';
import { configFilePath, DEFAULT_PORT, DEFAULT_WEB_PORT, resolveApiPort, resolveDataDir, resolveWebPort } from './security/runtimePaths';
import { assertStartupPaths } from './security/startupPaths';
import { networkMaxRequests, networkMode, type NetworkMode } from './security/network';

export { configFilePath, DEFAULT_PORT, DEFAULT_WEB_PORT };

export const APP_VERSION = '0.0.0';
export const HOST = '127.0.0.1';

export type SpEnv = 'dev' | 'prod' | 'test';

const ConfigFileSchema = z
  .object({
    port: z.number().int().min(1024).max(65535),
    claudeBin: z.string().min(1),
    timezone: z.string().min(1),
    s2ApiKey: z.string().min(1),
    concurrency: z.object({ interactive: z.number().int().min(1).max(8), background: z.number().int().min(0).max(4) }),
  })
  .partial();

export interface AppConfig {
  env: SpEnv;
  host: typeof HOST;
  port: number;
  /** Vite dev server port (dev mode allow-list only). */
  webPort: number;
  dataDir: string;
  configPath: string;
  secretsDir?: string;
  claudeBin: string;
  llmMode: 'cli' | 'mock';
  timezone: string;
  s2ApiKey: string | null;
  concurrency: { interactive: number; background: number };
  /** prod only: directory with the built web app (apps/web/dist). */
  webDistDir: string;
  /**
   * Outbound network of THIS process (security/network.ts networkMode — the one decision). 'off' refuses every fetch
   * before DNS. It does not govern the `claude` child (SP_LLM and the live ledger do); SP_NETWORK=off with SP_LLM=cli
   * is allowed (live E2E: offline arXiv fixtures + real CLI).
   */
  network: NetworkMode;
  /**
   * SP_NETWORK_MAX_REQUESTS (security/network.ts networkMaxRequests): cap of this process's real outbound requests,
   * null = no cap. An invalid value stops the start here. The count itself is kept by guardedFetch.
   */
  networkMaxRequests: number | null;
  /** SP_ARXIV_COOLDOWN_RESET=1: the user explicitly clears a stored arXiv cooldown at start (read by A, PLAN_M2 D28). */
  arxivCooldownReset: boolean;
  autoEnabled: boolean;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env, userLauncher = false, requireSecrets = false): AppConfig {
  assertStartupPaths(env, userLauncher);
  const secretsDir = requireSecrets ? credentialDirectory(env, userLauncher) : undefined;
  if (env.SP_AUTO !== undefined && env.SP_AUTO !== 'off' && env.SP_AUTO !== 'on') throw new Error('SP_AUTO must be on|off');
  const configPath = configFilePath(env);
  let file: z.infer<typeof ConfigFileSchema> = {};
  if (existsSync(configPath)) {
    const parsed = ConfigFileSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')));
    if (!parsed.success) throw new Error(`invalid config file ${configPath}: ${parsed.error.message}`);
    file = parsed.data;
  }
  const spEnv = (env.SP_ENV ?? 'prod') as SpEnv;
  if (!['dev', 'prod', 'test'].includes(spEnv)) throw new Error(`SP_ENV must be dev|prod|test, got ${spEnv}`);
  const llm = env.SP_LLM ?? 'cli';
  if (llm !== 'cli' && llm !== 'mock') throw new Error(`SP_LLM must be cli|mock, got ${llm}`);
  return {
    env: spEnv,
    host: HOST,
    port: resolveApiPort(env),
    webPort: resolveWebPort(env),
    dataDir: resolveDataDir(env),
    configPath,
    secretsDir,
    claudeBin: env.SP_CLAUDE_BIN ?? file.claudeBin ?? 'claude',
    llmMode: llm,
    timezone: file.timezone ?? 'Asia/Seoul',
    s2ApiKey: file.s2ApiKey ?? null,
    concurrency: file.concurrency ?? { ...DEFAULT_CONCURRENCY },
    webDistDir: env.SP_WEB_DIST ? resolve(env.SP_WEB_DIST) : resolve(new URL('../../web/dist', import.meta.url).pathname),
    network: networkMode(env),
    networkMaxRequests: networkMaxRequests(env),
    autoEnabled: env.SP_AUTO === 'on',
    arxivCooldownReset: env.SP_ARXIV_COOLDOWN_RESET === '1',
  };
}
