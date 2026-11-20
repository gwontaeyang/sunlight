// Owner A. The service wiring of the arXiv cooldown (PLAN_M2 D28): IngestService stores the queue's cooldown in the
// app DB and restores it at construction (a restart); SP_ARXIV_COOLDOWN_RESET=1 (config.arxivCooldownReset) deletes
// the stored row when the service is created, logs it, and requests go out again.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { cooldownKey } from '../../src/ingest/cooldownStore';
import { IngestService, peekIngest } from '../../src/ingest/pipeline';
import type { FetchImpl } from '../../src/ingest/safeFetch';
import { startTestServer, type TestServer } from '../helpers/server';
import { atomFeed, freshId, SYNTHETIC_PDF } from './helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const stored = (s: TestServer) => (s.deps.sqlite.prepare(`SELECT valueJson FROM settings WHERE key = ?`).get(cooldownKey('arxiv')) as { valueJson: string } | undefined)?.valueJson ?? null;

describe('IngestService cooldown wiring', () => {
  it('a 429 of one import is stored; a new service (restart) is blocked without a request; with arxivCooldownReset the row is deleted, logged, and the import goes through', async () => {
    const s = await startTestServer({ env: 'prod' });
    servers.push(s);
    const calls: string[] = [];
    let block = true;
    const fetchImpl: FetchImpl = async (url) => {
      calls.push(url);
      if (block) return new Response('', { status: 429, headers: { 'retry-after': '7200' } });
      const id = /id_list=([^&]+)/.exec(url)?.[1];
      if (id) return new Response(atomFeed([{ id, version: 1 }]), { headers: { 'content-type': 'application/atom+xml' } });
      if (url.includes('/pdf/')) return new Response(new Uint8Array(SYNTHETIC_PDF));
      return new Response('', { status: 404 });
    };
    const first = new IngestService(s.deps, { fetchImpl });
    const a = first.importArxiv(freshId());
    await first.whenDone(a.jobId!);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(stored(s)!)).toMatchObject({ cause: 'HTTP 429' });

    const second = new IngestService(s.deps, { fetchImpl }); // "restart"
    expect(second.queue.cooldownOf('arxiv.org')).not.toBeNull();
    const b = second.importArxiv(freshId());
    await second.whenDone(b.jobId!);
    expect(calls).toHaveLength(1);
    expect(s.deps.sqlite.prepare(`SELECT error FROM jobs WHERE id = ?`).get(b.jobId)).toEqual({ error: expect.stringMatching(/^network: arXiv가 .* 이후에 다시 요청하라고 응답했습니다/) });

    block = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const third = new IngestService({ ...s.deps, config: { ...s.deps.config, arxivCooldownReset: true } }, { fetchImpl });
    expect(stored(s)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('SP_ARXIV_COOLDOWN_RESET=1'))).toBe(true);
    const c = third.importArxiv(freshId());
    await third.whenDone(c.jobId!);
    expect(s.deps.sqlite.prepare(`SELECT status FROM jobs WHERE id = ?`).get(c.jobId)).toEqual({ status: 'done' });
    expect(calls.length).toBeGreaterThan(1);
  }, 30_000);

  it('SP_ARXIV_COOLDOWN_RESET=1 deletes the stored row at server start (createApp), before any import creates the ingest service', async () => {
    const s = await startTestServer({ env: 'prod' });
    servers.push(s);
    const row = JSON.stringify({ until: Date.now() + 3_600_000, cause: 'HTTP 429', setAt: Date.now() });
    s.deps.sqlite.prepare(`INSERT INTO settings (key, valueJson) VALUES (?, ?)`).run(cooldownKey('arxiv'), row);
    // Without the flag, building the app keeps the row.
    createApp({ ...s.deps });
    expect(stored(s)).toBe(row);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = { ...s.deps, config: { ...s.deps.config, arxivCooldownReset: true } };
    createApp(deps); // what index.ts does at start: no import, no retry, no upgrade
    expect(peekIngest(deps)).toBeUndefined();
    expect(stored(s)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('SP_ARXIV_COOLDOWN_RESET=1') && String(c[0]).includes('HTTP 429'))).toBe(true);
  });
});
