// The server project's setup (helpers/vitestSetup.ts) removes every SP_M3_* switch a shell carried. A test worker sees
// none; with SP_TEST_M3_ENV_REPORT set (vitestSetupEnv.test.ts runs this file in a nested vitest with such a shell),
// the keys still present are also written there. Owner: supervisor.
import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('no SP_M3_* switch reaches a server test worker', () => {
  const left = Object.keys(process.env).filter((k) => k.startsWith('SP_M3_')).sort();
  const report = process.env.SP_TEST_M3_ENV_REPORT;
  if (report) writeFileSync(report, JSON.stringify(left));
  expect(left).toEqual([]);
});
