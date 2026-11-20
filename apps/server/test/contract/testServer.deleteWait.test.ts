// Test helper (startTestServer) — the `deleteWaitMs` option is applied for real (review B-F3R1-03). papers.delete
// reads the wait from the ingest service (peekIngest); a server that only seeds and never imports had no service, so
// the option stayed pending and every deferred-delete test waited the 5 s default. Owner: supervisor.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import { DELETE_WAIT_MS, peekIngest } from '../../src/ingest/pipeline';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';

let s: TestServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await s?.close();
  s = undefined;
});

describe('startTestServer deleteWaitMs', () => {
  it('a seeded server that never imported: papers.delete waits the given ms (not the 5 s default) before deferring', async () => {
    const llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m1', 'm2'], llm, deleteWaitMs: 50 });
    expect(peekIngest(s.deps)?.deleteWaitMs).toBe(50);
    const hold = llm.holdNext({ ignoreAbort: true });
    const first = s.req(`/api/papers/${SEED_M2_PAPER_ID}/glossary/define`, {
      method: 'POST',
      headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'robust kernel', clientRequestId: randomUUID() }),
    });
    await hold.started;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
    const t0 = Date.now();
    const del = await s.req(`/api/papers/${SEED_M2_PAPER_ID}`, { method: 'DELETE', headers: { 'X-SP-Token': s.token } });
    const waited = Date.now() - t0;
    expect(del.status).toBe(204);
    // deferred: the held call ignores the abort, so the wait ran out — and it was the given one
    expect(errors.filter((e) => e.includes(`delete ${SEED_M2_PAPER_ID}`))).toEqual([expect.stringContaining('still running after 50 ms')]);
    expect(waited).toBeLessThan(DELETE_WAIT_MS / 2); // loose upper bound only
    hold.release();
    await first;
  });

  it('kept across restart(): the restarted server applies the same wait', async () => {
    s = await startTestServer({ env: 'prod', papers: ['m1'], deleteWaitMs: 70 });
    s = await s.restart();
    expect(peekIngest(s.deps)?.deleteWaitMs).toBe(70);
  });

  it('without the option nothing is created up front (the app keeps its lazily created ingest service)', async () => {
    s = await startTestServer({ env: 'prod', papers: ['m1'] });
    expect(peekIngest(s.deps)).toBeUndefined();
  });
});
