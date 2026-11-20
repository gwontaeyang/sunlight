// Owner A. arXiv cooldown persistence (PLAN_M2 D28, BRIEF_A A1): the server-given wait is stored and restored AS IS —
// never capped, shortened or replaced; a job that cannot wait fails at once (retryable) with the real resume time;
// unreadable rows → deleted + a conservative 120 s; non-finite / out-of-range values → indefinite; the only ways out
// are the time passing and SP_ARXIV_COOLDOWN_RESET=1. Fake clock + mock fetch: no network, no real waits.
import { afterEach, describe, expect, it } from 'vitest';
import { ArxivCooldownError, NetworkArxivSource } from '../../src/ingest/arxivApi';
import { COOLDOWN_RESET_HINT, cooldownKey, formatResumeAt, MAX_DATE_MS, resetStoredCooldown, SettingsCooldownStore, UNREADABLE_COOLDOWN_MS } from '../../src/ingest/cooldownStore';
import { HostQueue, QueueAbortedError } from '../../src/ingest/hostQueue';
import { HttpCache } from '../../src/ingest/httpCache';
import type { FetchImpl } from '../../src/ingest/safeFetch';
import { startTestServer, type TestServer } from '../helpers/server';
import { atomFeed, freshId } from './helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup() {
  const c = { t: Date.parse('2026-11-16T12:00:00Z') };
  const now = () => c.t;
  const sleep = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new QueueAbortedError(signal.reason);
    await new Promise((r) => setTimeout(r, 1));
    c.t += ms;
  };
  const log: { url: string; at: number }[] = [];
  const script: Record<string, Response[]> = {};
  const fetchImpl: FetchImpl = async (url) => {
    log.push({ url, at: c.t });
    const id = /id_list=([^&]+)/.exec(url)?.[1] ?? '';
    return script[url]?.shift() ?? new Response(atomFeed([{ id, version: 1 }]), { headers: { 'content-type': 'application/atom+xml' } });
  };
  return { c, now, sleep, log, script, fetchImpl };
}
type Env = ReturnType<typeof setup>;
const apiUrl = (id: string) => `https://export.arxiv.org/api/query?id_list=${id}&max_results=1`;
const status429 = (retryAfter: string) => new Response('', { status: 429, headers: { 'retry-after': retryAfter } });

async function db(): Promise<TestServer> {
  const s = await startTestServer({ env: 'prod' });
  servers.push(s);
  return s;
}
const stored = (s: TestServer) => (s.deps.sqlite.prepare(`SELECT valueJson FROM settings WHERE key = ?`).get(cooldownKey('arxiv')) as { valueJson: string } | undefined)?.valueJson ?? null;
const putRow = (s: TestServer, v: string) => s.deps.sqlite.prepare(`INSERT INTO settings (key, valueJson) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET valueJson = excluded.valueJson`).run(cooldownKey('arxiv'), v);

/** A queue + source with the DB store, like IngestService builds them (a "server start"). */
function start(e: Env, s: TestServer, logs: string[] = []) {
  const store = new SettingsCooldownStore(s.deps.sqlite, (m) => logs.push(m));
  const queue = new HostQueue(e.now, e.sleep, { store });
  const src = new NetworkArxivSource({ queue, cache: new HttpCache(s.deps.sqlite, e.now), fetchImpl: e.fetchImpl, retry: { now: e.now } });
  return { queue, src, logs };
}
const err = async (p: Promise<unknown>) => p.then(() => null, (x: unknown) => x as Error);

describe('arXiv cooldown persistence', () => {
  it('Retry-After 86400 → memory and stored value = now + 86,400 s (not cut); another paper 1 h + 1 s later and after a restart: 0 requests, failed at once with the real resume time; after it passes: requests again, row deleted', async () => {
    const e = setup();
    const s = await db();
    const a = start(e, s);
    const id1 = freshId();
    e.script[apiUrl(id1)] = [status429('86400')];
    const t0 = e.c.t;
    expect(await err(a.src.metadata(id1, undefined))).toBeInstanceOf(ArxivCooldownError);
    const until = t0 + 86_400_000;
    expect(a.queue.cooldownOf('arxiv.org')).toEqual({ until, cause: 'HTTP 429' });
    expect(JSON.parse(stored(s)!)).toEqual({ until, cause: 'HTTP 429', setAt: t0 });

    e.c.t += HOUR + 1_000;
    const before = e.log.length;
    const e2 = await err(a.src.metadata(freshId(), undefined));
    expect(e2).toBeInstanceOf(ArxivCooldownError);
    expect(e2!.message).toBe(`arXiv가 ${formatResumeAt(until)} 이후에 다시 요청하라고 응답했습니다 (HTTP 429) — 그 뒤 다시 시도하세요`);
    expect(e.log.length).toBe(before); // no request

    const b = start(e, s); // restart: new queue, same DB
    expect(b.queue.cooldownOf('export.arxiv.org')).toEqual({ until, cause: 'HTTP 429' });
    expect(await err(b.src.metadata(freshId(), undefined))).toBeInstanceOf(ArxivCooldownError);
    expect(e.log.length).toBe(before);

    e.c.t = until + 1;
    const id3 = freshId();
    expect(await b.src.metadata(id3, undefined)).toMatchObject({ requests: 1 });
    expect(e.log.at(-1)!.url).toBe(apiUrl(id3));
    expect(stored(s)).toBeNull();
    // and a restart after the time passed finds nothing either
    expect(start(e, s).queue.cooldownOf('arxiv.org')).toBeNull();
  });

  it('under an hour → "약 N분 뒤"; the cooldown only grows (a shorter value later keeps the stored one)', async () => {
    const e = setup();
    const s = await db();
    const a = start(e, s);
    const id = freshId();
    e.script[apiUrl(id)] = [status429('600')];
    const t0 = e.c.t;
    expect((await err(a.src.metadata(id, undefined)))!.message).toBe('arXiv가 약 10분 뒤 다시 요청하라고 응답했습니다 (HTTP 429) — 그 뒤 다시 시도하세요');
    a.queue.cooldown('arxiv.org', t0 + 60_000, 'shorter');
    expect(JSON.parse(stored(s)!)).toMatchObject({ until: t0 + 600_000, cause: 'HTTP 429' });
    expect(a.queue.cooldownOf('arxiv.org')).toEqual({ until: t0 + 600_000, cause: 'HTTP 429' });
  });

  it('an unreadable row ({ / until not a number) → row deleted, warning logged, a 120 s cooldown (memory only)', async () => {
    for (const bad of ['{', '{"until":"x"}', '[]', 'null']) {
      const e = setup();
      const s = await db();
      putRow(s, bad);
      const { queue, logs } = start(e, s);
      expect(stored(s), bad).toBeNull();
      expect(queue.cooldownOf('arxiv.org')).toEqual({ until: e.c.t + UNREADABLE_COOLDOWN_MS, cause: 'stored cooldown unreadable' });
      expect(logs.some((l) => l.includes('unreadable'))).toBe(true);
    }
  });

  it('non-finite / out-of-range waits are indefinite: Retry-After of 400 digits, Retry-After 99999999999999, a stored {"until":1e400} — blocked after a restart (0 requests), no Invalid Date, the reset hint', async () => {
    for (const ra of ['9'.repeat(400), '99999999999999']) {
      const e = setup();
      const s = await db();
      const id = freshId();
      e.script[apiUrl(id)] = [status429(ra)];
      const first = await err(start(e, s).src.metadata(id, undefined));
      expect(first).toBeInstanceOf(ArxivCooldownError);
      expect(first!.message).not.toContain('Invalid Date');
      expect(JSON.parse(stored(s)!)).toEqual({ until: MAX_DATE_MS, indefinite: true, cause: 'HTTP 429', setAt: e.c.t });
      e.c.t += 30 * DAY;
      const n = e.log.length;
      const b = start(e, s);
      expect(b.queue.cooldownOf('arxiv.org')?.until).toBe(Number.POSITIVE_INFINITY);
      const again = await err(b.src.metadata(freshId(), undefined));
      expect(again).toBeInstanceOf(ArxivCooldownError);
      expect(again!.message).toBe(`arXiv가 기한 없는 대기를 요청했습니다 (HTTP 429) — ${COOLDOWN_RESET_HINT}`);
      expect(e.log.length).toBe(n);
    }
    const e = setup();
    const s = await db();
    putRow(s, '{"until":1e400,"cause":"HTTP 429","setAt":1}');
    const b = start(e, s);
    expect(stored(s)).not.toBeNull(); // never "repaired" into a short wait
    const x = await err(b.src.metadata(freshId(), undefined));
    expect(x!.message).not.toContain('Invalid Date');
    expect(x!.message).toContain(COOLDOWN_RESET_HINT);
    expect(e.log).toHaveLength(0);
  });

  it('until = now + 30 days → restored as is after a restart (blocked, 0 requests), the error names the date and the reset hint', async () => {
    const e = setup();
    const s = await db();
    const until = e.c.t + 30 * DAY;
    putRow(s, JSON.stringify({ until, cause: 'HTTP 503', setAt: e.c.t }));
    const b = start(e, s);
    expect(b.queue.cooldownOf('arxiv.org')).toEqual({ until, cause: 'HTTP 503' });
    const x = await err(b.src.metadata(freshId(), undefined));
    expect(x!.message).toBe(`arXiv가 ${formatResumeAt(until)} 이후에 다시 요청하라고 응답했습니다 (HTTP 503) — 그 뒤 다시 시도하세요 (${COOLDOWN_RESET_HINT})`);
    expect(e.log).toHaveLength(0);
    expect(stored(s)).not.toBeNull();
  });

  it('SP_ARXIV_COOLDOWN_RESET=1 (resetStoredCooldown): the row is deleted and logged; requests are allowed after the restart', async () => {
    const e = setup();
    const s = await db();
    putRow(s, JSON.stringify({ until: MAX_DATE_MS, indefinite: true, cause: 'HTTP 429', setAt: 1 }));
    const logs: string[] = [];
    expect(resetStoredCooldown(s.deps.sqlite, 'arxiv', (m) => logs.push(m))).toContain('"indefinite":true');
    expect(stored(s)).toBeNull();
    expect(logs[0]).toContain('SP_ARXIV_COOLDOWN_RESET=1');
    expect(await start(e, s).src.metadata(freshId(), undefined)).toMatchObject({ requests: 1 });
    expect(resetStoredCooldown(s.deps.sqlite, 'arxiv', () => {})).toBeNull();
  });
});
