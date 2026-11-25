import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vitest setup for the server project (BRIEF_S S5b). Owner: supervisor.
// Removes process-wide switches a shell may still carry, so unit tests that inject a mock fetch or start the fake
// CLI behave the same everywhere: the network guard (SP_NETWORK, SP_ARXIV_OFFLINE_DIR) would refuse injected fetches,
// and a live ledger (SP_LIVE_LEDGER, SP_LIVE) would spend the real M2 budget or refuse with budget_exhausted.
// Tests that need one of them set it on the process they start, or set it inside the test and remove it after.
// A real fetch inside vitest is still blocked by defaultFetch's VITEST check.
for (const k of ['SP_NETWORK', 'SP_ARXIV_OFFLINE_DIR', 'SP_LIVE_LEDGER', 'SP_LIVE']) delete process.env[k];
// The same for an M3 campaign selected in the shell (SP_M3_CAMPAIGN, SP_M3_PHASE and any later SP_M3_* switch): with
// it, every guarded request of a test would reserve from the campaign's sealed HTTP or CLI budget (S-a fix round).
for (const k of Object.keys(process.env)) if (k.startsWith('SP_M3_')) delete process.env[k];

// A contract test that spawns a child CLI (m3-campaign.ts, smoke-live.ts) inherits this process's env, and that child's
// credential bootstrap requires SP_DATA_DIR, SP_CONFIG_PATH and SP_SECRETS_DIR — three separate sibling directories.
// Without them a bare `npm test` fails there, so a contributor has to copy the README's Development exports first. When
// the shell (or CI) has not set them, point them at a fresh temp triple so the default suite is hermetic; a value the
// shell already set still wins. Tests that start their own server pass an explicit data dir, which overrides this.
if (!process.env.SP_DATA_DIR?.trim()) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sp-test-')));
  const data = join(root, 'data');
  const configDir = join(root, 'config');
  const secrets = join(root, 'secrets');
  for (const d of [data, configDir]) mkdirSync(d);
  mkdirSync(secrets);
  chmodSync(secrets, 0o700); // mkdir's mode is masked by umask; the secret store insists on exactly 0700
  process.env.SP_DATA_DIR = data;
  process.env.SP_CONFIG_PATH = join(configDir, 'config.json');
  process.env.SP_SECRETS_DIR = secrets;
  process.once('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort: the OS clears its temp dir anyway */
    }
  });
}
