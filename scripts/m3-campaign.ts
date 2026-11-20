// Coordinator tool; every operation after init reads the existing seal and refuses missing ledgers.
import { resolve } from 'node:path';
import { checkCampaignPhase, initCampaign, readCampaign } from '../apps/server/src/security/m3Campaign';
import { assertStartupPaths } from '../apps/server/src/security/startupPaths';
const [command, directory, argument, ...extra] = process.argv.slice(2);
try {
  assertStartupPaths();
  if (!directory || extra.length || !['init','read','resume','evaluate'].includes(command)) throw new Error('invalid campaign command');
  if (process.env.SP_M3_CAMPAIGN && resolve(directory) !== resolve(process.env.SP_M3_CAMPAIGN)) throw new Error('campaign root mismatch');
  if (command === 'init') {
    if (process.env.SP_M3_PHASE !== undefined || process.env.SP_LIVE_LEDGER !== undefined) throw new Error('init requires the campaign root without a selected phase');
    if (!argument) throw new Error('init requires model pins');
    initCampaign(directory, JSON.parse(argument));
  } else if (command !== 'read' || argument !== undefined || process.env.SP_M3_PHASE !== undefined || process.env.SP_LIVE_LEDGER !== undefined) {
    const phase = argument ?? process.env.SP_M3_PHASE;
    if (process.env.SP_M3_PHASE !== undefined && phase !== process.env.SP_M3_PHASE) throw new Error('campaign phase mismatch');
    checkCampaignPhase(resolve(directory), phase, process.env.SP_LIVE_LEDGER);
  }
  const state = readCampaign(directory);
  console.log(JSON.stringify(state));
  if (state.stopped !== null) process.exitCode = 3;
} catch (error) {
  console.error('M3 campaign refused:', error instanceof Error ? error.message : 'invalid ledger');
  process.exitCode = 3;
}
