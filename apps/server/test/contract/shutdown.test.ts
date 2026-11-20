// Shutdown contract (lifecycle.ts, review B3): in-flight runs are aborted, their terminal rows are written and
// the process waits for that before closing the DB. Owner: supervisor.
// B's M1 adapter adds the child-process half (SIGINT → 2 s → SIGKILL → close) in its own tests.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { openSqlite } from '../../src/db/client';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { Lifecycle } from '../../src/lifecycle';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { seedDataDir, serverEnv, startWithPortRetry, waitFor } from '../helpers/proc';
import { freePort, startTestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';

/** POSTs an explain thread and returns the events as they arrive. */
async function streamExplain(port: number, token: string, onEvent: (e: SseEvent) => void): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/papers/${SEED_PAPER_ID}/threads`, {
    method: 'POST',
    headers: { 'X-SP-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'explain', text: 'robust kernel', clientRequestId: crypto.randomUUID() }),
  });
  expect(res.status).toBe(200);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (event && data) onEvent(parseSseEvent(event, JSON.parse(data)));
    }
  }
}

describe('Lifecycle', () => {
  it('drain waits for participants and reports a missed deadline', async () => {
    const lc = new Lifecycle();
    let fastActive = 1;
    lc.register({ name: 'fast', active: () => fastActive, drain: async () => void (fastActive = 0) });
    lc.register({ name: 'stuck', active: () => 1, drain: () => new Promise(() => {}) });
    const reports = await lc.drain(100);
    expect(lc.stopping).toBe(true);
    expect(reports.find((r) => r.name === 'fast')).toMatchObject({ ok: true, activeBefore: 1, activeAfter: 0 });
    expect(reports.find((r) => r.name === 'stuck')).toMatchObject({ ok: false, activeAfter: 1 });
  });
});

describe('shutdown with a run in flight', () => {
  it('in process: drain aborts the run and resolves only after its terminal rows are written', async () => {
    const s = await startTestServer({ env: 'prod', seed: true, llm: new MockLlmAdapter({ chunkDelayMs: 100 }) });
    const events: SseEvent[] = [];
    const stream = streamExplain(s.port, s.token, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.event === 'run.delta'), 'first delta');
    const reports = await s.deps.lifecycle.drain(5_000);
    expect(reports.every((r) => r.ok)).toBe(true);
    expect(reports).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'llm-runs', ok: true, activeBefore: 1, activeAfter: 0 })]));
    // The DB already holds the terminal state when drain() resolves (before the server would close it).
    expect(s.deps.sqlite.prepare(`SELECT status, errorCode FROM llm_calls`).all()).toEqual([{ status: 'cancelled', errorCode: 'cancelled' }]);
    expect(s.deps.sqlite.prepare(`SELECT status FROM messages WHERE role='assistant'`).all()).toEqual([{ status: 'cancelled' }]);
    await stream;
    expect(events[0]!.event).toBe('run.accepted');
    expect(events.filter((e) => e.event === 'run.done' || e.event === 'run.error')).toEqual([expect.objectContaining({ event: 'run.error', data: expect.objectContaining({ code: 'cancelled' }) })]);
    // A run accepted after shutdown began does no work and ends cancelled.
    const late: SseEvent[] = [];
    await streamExplain(s.port, s.token, (e) => late.push(e));
    expect(late.map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
    await s.close();
  }, 20_000);

  it('real process: SIGINT during a stream → terminal event delivered, rows terminal, lock released, exit 0', async () => {
    const root = tempDir('sp-shutdown-');
    const env = { ...serverEnv(root, 'data', await freePort()), SP_MOCK_CHUNK_DELAY_MS: '100' };
    seedDataDir(env);
    const srv = await startWithPortRetry(env, freePort);
    const { port } = srv;
    await waitFor(() => srv.output().includes('listening on'), 'server start');
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const token = /name="sp-token" content="([0-9a-f]+)"/.exec(html)![1]!;
    const events: SseEvent[] = [];
    const stream = streamExplain(port, token, (e) => events.push(e)).catch(() => undefined);
    await waitFor(() => events.some((e) => e.event === 'run.delta'), 'first delta');
    srv.child.kill('SIGINT');
    expect(await srv.exit).toBe(0);
    await stream;
    expect(events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
    expect(srv.output()).toContain('drain llm-runs: ok');
    const db = openSqlite(join(root, 'data', 'db', 'study_paper.sqlite'), { readonly: true });
    expect(db.prepare(`SELECT status FROM llm_calls`).all()).toEqual([{ status: 'cancelled' }]);
    expect(db.prepare(`SELECT status FROM messages WHERE role='assistant'`).all()).toEqual([{ status: 'cancelled' }]);
    db.close();
    expect(existsSync(join(root, 'data', 'run', 'instance.lock'))).toBe(false);
  }, 30_000);
});
