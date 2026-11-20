import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostQueue } from '../../src/ingest/hostQueue';
import { safeFetchText } from '../../src/ingest/safeFetch';
import { guardedFetch } from '../../src/security/network';
import { campaignModel, CLI_CAPS, initCampaign, readCampaign, reserveCampaignHttp } from '../../src/security/m3Campaign';
import { guardLiveRun } from '../../src/llm/liveLedger';
import { REPO_ROOT, runProbe } from '../helpers/proc';
import { tempDir } from '../helpers/tmp';

const pins = { haiku: 'claude-haiku-4-5', opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-5' };
const root = () => { const p = join(tempDir(), 'campaign'); initCampaign(p, pins); return p; };
const env = (dir: string, phase: string) => ({ SP_M3_CAMPAIGN: dir, SP_M3_PHASE: phase });
const probe = join(REPO_ROOT, 'apps/server/test/fixtures/m3-http-probe.ts');
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('sealed M3 campaign', () => {
  it('enforces every budget cell, restart and exact totals from independent expectations', () => {
    const dir = root();
    const hosts = ['export.arxiv.org','api.crossref.org','api.openalex.org','api.semanticscholar.org'];
    const rows = { spike: [0,4,4,2], record: [4,8,10,6], final: [18,3,4,2] };
    for (const [stage, caps] of Object.entries(rows)) {
      for (const [i, count] of caps.entries()) {
        const url = 'https://' + hosts[i] + '/fixture';
        for (let n = 0; n < count; n++) expect(reserveCampaignHttp(env(dir, stage), url)).toBe(true);
        expect(() => reserveCampaignHttp(env(dir, stage), url)).toThrow(/cap/);
      }
    }
    initCampaign(dir, pins);
    expect(readCampaign(dir).http.reduce((n, row) => n + row.used, 0)).toBe(65);
    expect(() => initCampaign(dir, { ...pins, opus: 'claude-opus-4-7' })).toThrow();
    expect(() => reserveCampaignHttp(env(dir, 'spike'), 'https://example.invalid/')).toThrow();
    expect(() => reserveCampaignHttp(env(dir, 'poc'), 'https://arxiv.org/')).toThrow();
  });
  it('moving the entire campaign cannot create a second budget at the original or sibling path', () => {
    const parent = tempDir();
    const original = join(parent, 'campaign');
    const held = join(parent, 'moved');
    const sibling = join(parent, 'restart');
    initCampaign(original, pins);
    reserveCampaignHttp(env(original, 'spike'), 'https://api.crossref.org/works');
    renameSync(original, held);
    expect(() => initCampaign(original, pins)).toThrow();
    expect(() => initCampaign(sibling, pins)).toThrow();
    expect(() => readCampaign(held)).toThrow();
    expect([existsSync(original), existsSync(sibling)]).toEqual([false, false]);
    renameSync(held, original);
    initCampaign(original, pins);
    expect(readCampaign(original).http).toEqual([{ phase: 'spike', provider: 'crossref', used: 1 }]);
  });

  it('reserves before transport, keeps failed dispatch and admits only one competing process to the last slot', async () => {
    const dir = root();
    vi.stubEnv('SP_M3_CAMPAIGN', dir); vi.stubEnv('SP_M3_PHASE','spike');
    const send = vi.fn(() => { throw new Error('transport fixture'); }); vi.stubGlobal('fetch', send);
    for (let n = 0; n < 3; n++) expect(() => guardedFetch('https://api.crossref.org/works', {})).toThrow('transport fixture');
    await expect(guardedFetch('https://arxiv.org/', {})).rejects.toThrow(/reservation/);
    expect(send).toHaveBeenCalledTimes(3);
    const runs = await Promise.all(Array.from({ length: 4 }, () => runProbe(probe, env(dir,'spike'))));
    expect(runs.map(r => r.status)).toEqual([0,0,0,0]);
    expect(runs.map(r => JSON.parse(r.stdout).sent).sort()).toEqual([0,0,0,1]);
    expect(readCampaign(dir).http).toEqual([{ phase: 'spike', provider: 'crossref', used: 4 }]);
  });
  it('charges an allowed redirect and retry separately, and refuses a mismatched phase before any transport', async () => {
    const dir = root();
    vi.stubEnv('SP_M3_CAMPAIGN', dir);
    vi.stubEnv('SP_M3_PHASE', 'record');
    let time = 0;
    const queue = new HostQueue(() => time += 60_000);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://arxiv.org/final' } }))
      .mockResolvedValueOnce(new Response('paper'))
      .mockResolvedValueOnce(new Response('retry'));
    vi.stubGlobal('fetch', fetch);
    const opts = { kind: 'html' as const, queue, fetchImpl: guardedFetch };
    expect((await safeFetchText('https://arxiv.org/start', opts)).text).toBe('paper');
    expect((await safeFetchText('https://arxiv.org/start', opts)).text).toBe('retry');
    expect(fetch.mock.calls.map(([url, init]) => [url, init.redirect])).toEqual([
      ['https://arxiv.org/start', 'manual'], ['https://arxiv.org/final', 'manual'], ['https://arxiv.org/start', 'manual'],
    ]);
    vi.stubEnv('SP_LIVE_LEDGER', join(dir, 'poc'));
    await expect(guardedFetch('https://arxiv.org/start', {})).rejects.toThrow(/reservation/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(readCampaign(dir).http).toEqual([{ phase: 'record', provider: 'arxiv', used: 3 }]);
  });

  it('reads or resumes an HTTP-only phase and rejects mismatched phase, ledger and root at the CLI', async () => {
    const dir = root();
    const cli = join(REPO_ROOT, 'scripts/m3-campaign.ts');
    const phase = env(dir, 'spike');
    for (const command of ['read', 'resume']) {
      const ok = await runProbe(cli, phase, [command, dir, 'spike']);
      expect(ok.status, ok.stderr).toBe(0);
      expect(JSON.parse(ok.stdout).id).toBe('sunlight-m3');
    }
    expect((await runProbe(cli, phase, ['resume', dir, 'record'])).status).toBe(3);
    expect((await runProbe(cli, { ...phase, SP_LIVE_LEDGER: join(dir, 'final') }, ['read', dir])).status).toBe(3);
    const other = join(tempDir(), 'wrong');
    expect((await runProbe(cli, { SP_M3_CAMPAIGN: dir }, ['init', other, JSON.stringify(pins)])).status).toBe(3);
    expect(() => readCampaign(other)).toThrow(/ENOENT/);
  });

  it('requires the phase ledger at the point of reservation when caps were sealed', () => {
    vi.stubEnv('SP_LIVE_LEDGER', undefined);
    const send = vi.fn();
    expect(guardLiveRun('sonnet', { task: 'summary', runId: 'missing' }, send, { expectedCaps: CLI_CAPS.poc })).toEqual({ ok: false, reason: 'no_caps' });
    expect(send).not.toHaveBeenCalled();
  });
  it('stage and caps bind both CLI reservations; no reset, transfer, or dispatch after ledger damage', () => {
    const dir = root();
    for (const phase of ['poc','final'] as const) {
      const ledger = join(dir, phase);
      const e = { ...env(dir, phase), SP_LIVE_LEDGER: ledger }; vi.stubEnv('SP_LIVE_LEDGER',ledger);
      const counts = phase === 'poc' ? { haiku: 0, opus: 0, sonnet: 22 } : { haiku: 3, opus: 11, sonnet: 9 };
      for (const alias of ['haiku','opus','sonnet'] as const) {
        const mock = vi.fn();
        if (counts[alias]) expect(campaignModel(e, alias)?.id).toBe(pins[alias]);
        for (let i=0; i<=counts[alias]; i++) guardLiveRun(alias, { task: 'summary', runId: String(i) }, mock, { expectedCaps: CLI_CAPS[phase] });
        expect(mock).toHaveBeenCalledTimes(counts[alias]);
      }
      expect(() => campaignModel({ ...e, SP_M3_PHASE: phase === 'poc' ? 'final':'poc' }, 'sonnet')).toThrow();
    }
    expect(readCampaign(dir).poc.used.total).toBe(22);
    expect(readCampaign(dir).final.used.total).toBe(23);
    writeFileSync(join(dir,'final/caps.json'), '{}');
    expect(() => initCampaign(dir, pins)).toThrow();
    expect(() => reserveCampaignHttp(env(dir,'final'), 'https://arxiv.org/')).toThrow();
    rmSync(join(dir,'m3-campaign.sqlite'));
    expect(() => initCampaign(dir,pins)).toThrow();
  });
});
