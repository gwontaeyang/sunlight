// queue.ts lanes and limits, and the slot lifetime inside the run manager (released only at child close). Owner B.
import { describe, expect, it } from 'vitest';
import { QueueError, RunQueue, type Slot } from '../../src/llm/queue';
import { CHILD_KILL_GRACE_MS } from '../../src/lifecycle';
import { alive } from './fakeCli';
import { events, makeRunEnv, request, waitFor } from './runEnv';

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('RunQueue', () => {
  it('interactive 2 + background 1 run at once; the rest wait FIFO', async () => {
    const q = new RunQueue();
    const started: string[] = [];
    const take = (lane: 'interactive' | 'background', name: string) => q.enqueue(lane).then((s) => (started.push(name), s));
    const i1 = take('interactive', 'i1');
    const i2 = take('interactive', 'i2');
    const b1 = take('background', 'b1');
    const i3 = take('interactive', 'i3');
    const b2 = take('background', 'b2');
    await settle();
    expect(started).toEqual(['i1', 'i2', 'b1']);
    expect(q.stats()).toEqual({ running: { interactive: 2, background: 1 }, waiting: { interactive: 1, background: 1 } });
    (await i1).release();
    await settle();
    expect(started).toEqual(['i1', 'i2', 'b1', 'i3']);
    (await b1).release();
    await settle();
    expect(started.at(-1)).toBe('b2');
    for (const s of [await i2, await i3, await b2]) s.release();
    expect(q.stats().running).toEqual({ interactive: 0, background: 0 });
  });

  it('priority: while interactive work waits, no new background run starts', async () => {
    const q = new RunQueue({ interactive: 1, background: 1 });
    const started: string[] = [];
    const i1 = await q.enqueue('interactive');
    const b1 = await q.enqueue('background');
    const i2 = q.enqueue('interactive').then((s) => (started.push('i2'), s));
    b1.release(); // a background slot is free, but interactive is waiting → b2 must not start
    const b2 = q.enqueue('background').then((s) => (started.push('b2'), s));
    await settle();
    expect(started).toEqual([]);
    i1.release();
    await settle();
    expect(started).toEqual(['i2', 'b2']);
    (await i2).release();
    (await b2).release();
  });

  it('a queued entry can be cancelled; positions are reported and updated', async () => {
    const q = new RunQueue({ interactive: 1, background: 1 });
    const s1 = await q.enqueue('interactive');
    const positions: number[][] = [[], []];
    const ac = new AbortController();
    const w1 = q.enqueue('interactive', { signal: ac.signal, onPosition: (p) => positions[0]!.push(p) });
    const w2 = q.enqueue('interactive', { onPosition: (p) => positions[1]!.push(p) });
    ac.abort();
    await expect(w1).rejects.toMatchObject({ code: 'cancelled' });
    expect(positions).toEqual([[0], [1, 0]]);
    s1.release();
    (await w2).release();
    await expect(q.enqueue('interactive', { signal: ac.signal })).rejects.toBeInstanceOf(QueueError);
  });

  it('waiting longer than the lane timeout → queue_timeout, and the slot count is unaffected', async () => {
    const q = new RunQueue({ interactive: 1, background: 1 }, { interactive: 50, background: 50 });
    const s: Slot = await q.enqueue('interactive');
    await expect(q.enqueue('interactive')).rejects.toMatchObject({ code: 'queue_timeout' });
    s.release();
    s.release(); // idempotent
    expect(q.stats().running.interactive).toBe(0);
  });
});

describe('slot lifetime in the run manager', () => {
  it('a cancelled run keeps its slot until its child closed (SIGINT ignored → SIGKILL after 2 s)', async () => {
    const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: 'hang_after_init', FAKE_CLAUDE_IGNORE_SIGINT: '1' }, deps: { concurrency: { interactive: 1, background: 1 } } });
    const a = env.manager.runTask(request());
    await waitFor(() => env.pids.length === 1, 'first child');
    await waitFor(() => (env.sqlite.prepare(`SELECT modelResolved FROM llm_calls WHERE runId = ?`).get(a.runId) as { modelResolved: string | null }).modelResolved !== null, 'started');
    env.fakeEnv.FAKE_CLAUDE_SCENARIO = 'ok';
    env.fakeEnv.FAKE_CLAUDE_IGNORE_SIGINT = '0';
    const b = env.manager.runTask(request());
    const t0 = Date.now();
    a.cancel();
    await waitFor(() => env.pids.length === 2, 'second child', 10_000);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(CHILD_KILL_GRACE_MS - 50);
    expect(alive(env.pids[0]!)).toBe(false);
    expect((await events(b)).at(-1)!.event).toBe('run.done');
    env.close();
  }, 15_000);
});
