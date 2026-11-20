import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARXIV_MIN_GAP_MS, groupForHost, HostQueue, QueueWaitRefusedError } from '../../src/ingest/hostQueue';

describe('HostQueue (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arxiv.org and export.arxiv.org share one queue', () => {
    expect(groupForHost('arxiv.org')).toBe(groupForHost('export.arxiv.org'));
    expect(() => groupForHost('example.com')).toThrow();
  });

  it('starts arXiv requests >= 3 s apart, one at a time, FIFO', async () => {
    const q = new HostQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    const log: string[] = [];
    const task = (name: string, ms: number) => () =>
      new Promise<string>((resolve) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        log.push(`start ${name} @${Date.now() - 1_000_000}`);
        setTimeout(() => {
          inFlight--;
          log.push(`end ${name} @${Date.now() - 1_000_000}`);
          resolve(name);
        }, ms);
      });
    const a = q.run('export.arxiv.org', task('a', 100));
    const b = q.run('arxiv.org', task('b', 5_000)); // long download: keeps the slot
    const c = q.run('arxiv.org', task('c', 10));
    expect(q.pending('arxiv.org')).toBe(3);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(Promise.all([a, b, c])).resolves.toEqual(['a', 'b', 'c']);
    expect(maxInFlight).toBe(1);
    expect(log).toEqual(['start a @0', 'end a @100', `start b @${ARXIV_MIN_GAP_MS}`, 'end b @8000', 'start c @8000', 'end c @8010']);
    const starts = q.starts.map((s) => s.at);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(ARXIV_MIN_GAP_MS);
    expect(q.pending('arxiv.org')).toBe(0);
  });

  it('a failing task frees the slot after the gap', async () => {
    const q = new HostQueue();
    const a = q.run('arxiv.org', async () => {
      throw new Error('boom');
    });
    const b = q.run('arxiv.org', async () => Date.now() - 1_000_000);
    await expect(a).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(ARXIV_MIN_GAP_MS);
    await expect(b).resolves.toBe(ARXIV_MIN_GAP_MS);
  });

  it('an aborted waiter never runs and does not open the slot early', async () => {
    const q = new HostQueue();
    const ctrl = new AbortController();
    let ranB = false;
    const a = q.run('arxiv.org', () => new Promise<void>((r) => setTimeout(r, 10_000)));
    const b = q.run(
      'arxiv.org',
      async () => {
        ranB = true;
      },
      ctrl.signal,
    );
    const cStart: number[] = [];
    const c = q.run('arxiv.org', async () => void cStart.push(Date.now() - 1_000_000));
    ctrl.abort('test');
    await expect(b).rejects.toThrow(/cancelled/);
    await vi.advanceTimersByTimeAsync(20_000);
    await a;
    await c;
    expect(ranB).toBe(false);
    expect(cStart).toEqual([10_000]); // after a finished, not when b gave up
  });
  // M1.1.2 review N5: shared cooldown.
  it('a cooldown set inside a failing task holds every later task of the group (both hosts), reported once', async () => {
    const q = new HostQueue();
    const starts: number[] = [];
    const waits: number[] = [];
    const a = q.run('export.arxiv.org', async () => {
      q.cooldown('export.arxiv.org', Date.now() + 40_000, 'HTTP 429');
      throw new Error('429');
    });
    const b = q.run('arxiv.org', async () => void starts.push(Date.now() - 1_000_000), undefined, { onCooldownWait: (ms) => waits.push(ms) });
    await expect(a).rejects.toThrow('429');
    expect(q.cooldownOf('arxiv.org')).toEqual({ until: 1_040_000, cause: 'HTTP 429' });
    await vi.advanceTimersByTimeAsync(39_000);
    expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    await b;
    expect(starts).toEqual([40_000]);
    expect(waits).toEqual([40_000]);
    q.cooldown('arxiv.org', 0, 'shorter'); // never shortens
    expect(q.cooldownOf('arxiv.org')).toBeNull();
  });

  it('refuses a cooldown longer than maxCooldownWaitMs or past the deadline, at once and without running', async () => {
    const q = new HostQueue();
    q.cooldown('arxiv.org', Date.now() + 600_000, 'HTTP 429');
    let ran = false;
    const task = async () => void (ran = true);
    await expect(q.run('arxiv.org', task, undefined, { maxCooldownWaitMs: 120_000 })).rejects.toMatchObject({ kind: 'too_long', waitMs: 600_000 });
    await expect(q.run('arxiv.org', task, undefined, { deadline: Date.now() + 60_000 })).rejects.toBeInstanceOf(QueueWaitRefusedError);
    expect(ran).toBe(false);
    // A refused waiter does not block the next one.
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(q.run('arxiv.org', async () => 'ok')).resolves.toBe('ok');
  });
});
