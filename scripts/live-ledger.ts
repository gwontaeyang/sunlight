// Live CLI ledger tool (PLAN_M2 D25). Owner: supervisor. The coordinator and the live E2E script create ledgers with it.
// Usage:
//   npx tsx scripts/live-ledger.ts init <dir> '{"total":3,"perModel":{"haiku":3}}'   (LiveCaps only)
//   npx tsx scripts/live-ledger.ts read <dir>                                         (caps, used, stopped, stopRequested, lock holder)
//   npx tsx scripts/live-ledger.ts unlock <dir>   — removes `lock` and `lock.break` ONLY after a person checked that no
//                                                  holder process exists; prints what it removed. STOP files and
//                                                  reservations are never touched.
//   npx tsx scripts/live-ledger.ts allowed <dir>   — prints 1 when the ledger carries a valid ALLOW_RATE_WARNING (the
//                                                  coordinator approval of INTEGRATION_NOTES 결정 26), else 0 (read only)
import { initLiveLedger, LiveCapsSchema, readLiveLedger, readRateWarningApproval, unlockLiveLedger } from '../apps/server/src/llm/liveLedger';

const [cmd, dir, capsJson] = process.argv.slice(2);
function fail(msg: string): never {
  console.error(`live-ledger: ${msg}`);
  process.exit(2);
}
if (!dir) fail('usage: live-ledger.ts init|read|unlock|allowed <dir> [capsJson]');
if (cmd === 'init') {
  if (!capsJson) fail('init needs a caps JSON like {"total":3,"perModel":{"haiku":3}}');
  let parsed: unknown;
  try {
    parsed = JSON.parse(capsJson);
  } catch {
    fail('caps is not JSON');
  }
  const caps = LiveCapsSchema.safeParse(parsed);
  if (!caps.success) fail(`caps must be {"total":n,"perModel":{model:n}}: ${caps.error.message}`);
  initLiveLedger(dir, caps.data);
  console.log(JSON.stringify(readLiveLedger(dir), null, 2));
} else if (cmd === 'read') {
  console.log(JSON.stringify(readLiveLedger(dir), null, 2));
} else if (cmd === 'allowed') {
  console.log(readRateWarningApproval(dir) === null ? '0' : '1');
} else if (cmd === 'unlock') {
  console.log(JSON.stringify(unlockLiveLedger(dir), null, 2));
} else fail(`unknown command ${cmd}`);
