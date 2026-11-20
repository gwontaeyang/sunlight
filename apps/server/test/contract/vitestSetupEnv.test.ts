// S-a fix round (MAJOR 2): an M3 campaign selected in the shell (SP_M3_*) never reaches the server tests, so running
// the test suite cannot reserve from the campaign's HTTP or CLI budget. Owner: supervisor.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { initCampaign, readCampaign } from '../../src/security/m3Campaign';
import { REPO_ROOT, runCommand } from '../helpers/proc';
import { tempDir } from '../helpers/tmp';

const VITEST = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

it('the network guard tests run with a campaign in the shell: they pass and the campaign keeps its whole budget', async () => {
  const campaign = join(tempDir(), 'campaign');
  initCampaign(campaign, { haiku: 'claude-haiku-5-5', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' });
  const r = await runCommand(
    process.execPath,
    [VITEST, 'run', '--project', 'server', 'apps/server/test/contract/network.guard.test.ts', '-t', 'SP_NETWORK_MAX_REQUESTS'],
    { cwd: REPO_ROOT, env: { SP_M3_CAMPAIGN: campaign, SP_M3_PHASE: 'record', SP_M3_NEXT_SWITCH: 'any' }, timeoutMs: 170_000 },
  );
  expect(r.status, (r.stdout + r.stderr).slice(-3000)).toBe(0);
  const state = readCampaign(campaign);
  expect(state.http).toEqual([]);
  expect([state.poc.used.total, state.final.used.total, state.stopped]).toEqual([0, 0, null]);
}, 180_000);

it('a worker started with SP_M3_CAMPAIGN, SP_M3_PHASE and another SP_M3_* switch sees none of them after the setup', async () => {
  const campaign = join(tempDir(), 'campaign');
  initCampaign(campaign, { haiku: 'claude-haiku-5-5', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' });
  const report = join(tempDir(), 'left.json');
  const r = await runCommand(
    process.execPath,
    [VITEST, 'run', '--project', 'server', 'apps/server/test/contract/m3EnvAfterSetup.test.ts'],
    { cwd: REPO_ROOT, env: { SP_M3_CAMPAIGN: campaign, SP_M3_PHASE: 'record', SP_M3_NEXT_SWITCH: 'any', SP_TEST_M3_ENV_REPORT: report }, timeoutMs: 120_000 },
  );
  expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual([]);
  expect(r.status, (r.stdout + r.stderr).slice(-3000)).toBe(0);
  expect(readCampaign(campaign).http).toEqual([]);
}, 150_000);
