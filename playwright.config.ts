// E2E (PLAN 9.2, 10): builds nothing itself — `npm run test:e2e` builds the web app first.
// Starts an isolated prod server, a dev server + Vite, all in a temp data dir with SP_LLM=mock, on ports that do
// not collide with `npm run dev` (4310/5173). Chrome comes from the system (`channel: 'chrome'`).
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { OFFLINE_ARXIV, OFFLINE_ARXIV_K1, offlineAtomFeed, offlineAtomFeedOf } from './e2e/helpers';

export const E2E_PORTS = {
  prod: Number(process.env.SP_E2E_PROD_PORT ?? 4321),
  devApi: Number(process.env.SP_E2E_DEV_API_PORT ?? 4322),
  devWeb: Number(process.env.SP_E2E_DEV_WEB_PORT ?? 5175),
  restart: Number(process.env.SP_E2E_RESTART_PORT ?? 4323),
  attacker: Number(process.env.SP_E2E_ATTACKER_PORT ?? 4329),
};
// Evaluated in the runner and again in each worker: the env var keeps one temp root for all of them.
process.env.SP_E2E_ROOT ??= mkdtempSync(join(tmpdir(), 'study_paper-e2e-'));
const root = process.env.SP_E2E_ROOT;

// Offline arXiv source for the dev server (never used in prod): the synthetic PDF under a synthetic id.
const offlineDir = join(root, 'offline');
mkdirSync(offlineDir, { recursive: true });
writeFileSync(join(offlineDir, `${OFFLINE_ARXIV.id}.atom.xml`), offlineAtomFeed());
copyFileSync(join(import.meta.dirname, 'apps/server/test/fixtures/synthetic.pdf'), join(offlineDir, `${OFFLINE_ARXIV.id}v${OFFLINE_ARXIV.version}.pdf`));
// M2: the LaTeXML HTML of the offline import and of the upgrade target (SEED_UPGRADE = 2301.00002v1). Both are
// synthetic-m2.html, whose own arXiv mention is another id (no version mismatch).
for (const id of [`${OFFLINE_ARXIV.id}v${OFFLINE_ARXIV.version}`, '2301.00002v1']) copyFileSync(join(import.meta.dirname, 'apps/server/test/fixtures/synthetic-m2.html'), join(offlineDir, `${id}.html`));
// M2 integration K1 (e2e/skeleton.spec.ts): an import of its own with HTML — Atom + the M1 synthetic.pdf + synthetic-m2.html.
const k1 = `${OFFLINE_ARXIV_K1.id}v${OFFLINE_ARXIV_K1.version}`;
writeFileSync(join(offlineDir, `${OFFLINE_ARXIV_K1.id}.atom.xml`), offlineAtomFeedOf(OFFLINE_ARXIV_K1));
copyFileSync(join(import.meta.dirname, 'apps/server/test/fixtures/synthetic.pdf'), join(offlineDir, `${k1}.pdf`));
copyFileSync(join(import.meta.dirname, 'apps/server/test/fixtures/synthetic-m2.html'), join(offlineDir, `${k1}.html`));

// Test hooks (window.__spViewer / __spReader) exist only when the servers run with SP_E2E=1.
process.env.SP_E2E = '1';
// Every e2e server (the webServers and the restart servers specs start with ...process.env) runs with the outbound
// network off (PLAN_M2 D23): the guard refuses any fetch before DNS.
process.env.SP_NETWORK ??= 'off';
const common = { SP_E2E: '1', SP_LLM: 'mock', SP_CONFIG_PATH: join(root, 'config','no-config.json'), XDG_RUNTIME_DIR: join(root, 'run') };
// Every server starts with the four seed papers (M1 seed + the M2 seeds — PLAN_M2 D19).
const server = 'node --import tsx scripts/seed-fixture.ts all && exec node --import tsx apps/server/src/index.ts';

export default defineConfig({
  testDir: 'e2e',
  // Only specs: e2e/helpers.test.ts is a vitest file (root vitest project `e2e-helpers`).
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalTeardown: './e2e/global-teardown.ts',
  use: { channel: 'chrome', headless: true, viewport: { width: 1400, height: 1000 } },
  projects: [
    { name: 'prod', use: { baseURL: `http://127.0.0.1:${E2E_PORTS.prod}` } },
    { name: 'dev', use: { baseURL: `http://127.0.0.1:${E2E_PORTS.devWeb}` } },
  ],
  webServer: [
    {
      command: server,
      env: { ...common, SP_ENV: 'prod', SP_PORT: String(E2E_PORTS.prod), SP_DATA_DIR: join(root, 'prod'), SP_SECRETS_DIR: join(root, 'prod-secrets') },
      url: `http://127.0.0.1:${E2E_PORTS.prod}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
    },
    {
      command: server,
      env: { ...common, SP_ENV: 'dev', SP_PORT: String(E2E_PORTS.devApi), SP_WEB_PORT: String(E2E_PORTS.devWeb), SP_DATA_DIR: join(root, 'dev'), SP_SECRETS_DIR: join(root, 'dev-secrets'), SP_ARXIV_OFFLINE_DIR: offlineDir },
      url: `http://127.0.0.1:${E2E_PORTS.devApi}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
    },
    {
      command: `exec node node_modules/vite/bin/vite.js --config apps/web/vite.config.ts`,
      env: { ...common, SP_PORT: String(E2E_PORTS.devApi), SP_WEB_PORT: String(E2E_PORTS.devWeb) },
      url: `http://127.0.0.1:${E2E_PORTS.devWeb}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
    },
  ],
});
