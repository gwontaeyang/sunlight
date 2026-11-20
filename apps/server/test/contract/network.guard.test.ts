// Network guard (BRIEF_S S5b, PLAN_M2 D23). Owner: supervisor. Every cell runs in its own process (no VITEST), so
// the guard — not the vitest check in defaultFetch — is what refuses.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { networkMaxRequests, networkMode } from '../../src/security/network';
import { runProbe, serverEnv, startServerProcess } from '../helpers/proc';
import { freePort } from '../helpers/server';
import { tempDir } from '../helpers/tmp';

const PROBE = join(__dirname, '..', 'fixtures', 'network-probe.ts');
type Cell = { spEnv: 'dev' | 'prod' | 'test' | undefined; network: 'off' | undefined; offline: boolean };
const cells: Cell[] = [];
for (const spEnv of ['dev', 'prod', 'test', undefined] as const) for (const network of ['off', undefined] as const) for (const offline of [true, false]) cells.push({ spEnv, network, offline });
const expectedMode = (c: Cell) => (c.network === 'off' || ((c.spEnv ?? 'prod') !== 'prod' && c.offline) ? 'off' : 'on');

describe('networkMode', () => {
  it('rule table (pure)', () => {
    for (const c of cells) {
      expect(networkMode({ SP_ENV: c.spEnv, SP_NETWORK: c.network, SP_ARXIV_OFFLINE_DIR: c.offline ? '/tmp/x' : undefined }), JSON.stringify(c)).toBe(expectedMode(c));
    }
    expect(networkMode({ SP_NETWORK: 'on' })).toBe('on');
    expect(() => networkMode({ SP_NETWORK: 'bogus' })).toThrow(/SP_NETWORK/);
  });

  it('loadConfig: network is networkMode of the same env; arxivCooldownReset only for SP_ARXIV_COOLDOWN_RESET=1', () => {
    const base = { SP_CONFIG_PATH: '/nonexistent/study_paper-config.json', SP_DATA_DIR: '/tmp/sp-unused' };
    expect(loadConfig({ ...base, SP_NETWORK: 'off' })).toMatchObject({ network: 'off', arxivCooldownReset: false });
    expect(loadConfig({ ...base, SP_ENV: 'dev', SP_ARXIV_OFFLINE_DIR: '/x' })).toMatchObject({ network: 'off' });
    expect(loadConfig({ ...base, SP_ARXIV_OFFLINE_DIR: '/x' })).toMatchObject({ network: 'on' });
    expect(loadConfig({ ...base, SP_ARXIV_COOLDOWN_RESET: '1' }).arxivCooldownReset).toBe(true);
    expect(loadConfig({ ...base, SP_ARXIV_COOLDOWN_RESET: 'true' }).arxivCooldownReset).toBe(false);
    expect(() => loadConfig({ ...base, SP_NETWORK: 'bogus' })).toThrow(/SP_NETWORK/);
  });
});

describe('network guard in a separate process (fetch / DNS / injected fetch spies)', () => {
  for (const c of cells) {
    const want = expectedMode(c);
    it(`SP_ENV=${c.spEnv ?? '(unset)'} SP_NETWORK=${c.network ?? '(unset)'} offline=${c.offline} → ${want}`, async () => {
      const r = await runProbe(PROBE, { SP_ENV: c.spEnv, SP_NETWORK: c.network, SP_ARXIV_OFFLINE_DIR: c.offline ? tempDir() : undefined, SP_NET: undefined });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as { mode: string; spies: Record<string, number>; outcomes: { path: string; ok: boolean; code: string | null; disabled: boolean | null; ms: number }[] };
      expect(out.mode).toBe(want);
      if (want === 'off') {
        expect(out.spies).toEqual({ fetch: 0, lookup: 0, lookupPromises: 0, impl: 0 });
        expect(out.outcomes.map((o) => o.path)).toEqual(['injected', 'default', 'defaultFetch-direct', 'redirect']);
        for (const o of out.outcomes) {
          expect(o.ok, o.path).toBe(false);
          expect(o.disabled, o.path).toBe(true);
          expect(o.ms, `${o.path}: no retry backoff`).toBeLessThan(1_000);
          if (o.path !== 'defaultFetch-direct') expect(o.code, o.path).toBe('blocked_url');
        }
      } else {
        const by = Object.fromEntries(out.outcomes.map((o) => [o.path, o]));
        expect(by.injected).toMatchObject({ ok: true });
        expect(by.redirect).toMatchObject({ ok: true });
        expect(by['blocked-host']).toMatchObject({ ok: false, code: 'blocked_url', disabled: false });
        // hop guard: the redirect hop after the env turned off is refused (the injected fetch is not called again)
        expect(by['hop-flip']).toMatchObject({ ok: false, code: 'blocked_url', disabled: true });
        expect(out.spies.impl).toBe(1 + 2 + 1); // injected 1, redirect 2 hops, hop-flip first hop only
        expect(out.spies.fetch).toBe(0); // the default fetch path is never run in an on cell (no real network)
        expect(out.spies.lookup + out.spies.lookupPromises).toBe(0);
      }
    }, 60_000);
  }

  it('SP_NETWORK=bogus: the server does not start', async () => {
    const root = tempDir();
    const env = { ...serverEnv(root, 'data', await freePort()), SP_NETWORK: 'bogus' };
    const p = startServerProcess(env);
    const code = await p.exit;
    expect(code).not.toBe(0);
    expect(p.output()).toMatch(/SP_NETWORK must be on\|off/);
  }, 60_000);
});

// SP_NETWORK_MAX_REQUESTS (BRIEF_INTEGRATION I9): the per-process request budget, counted in guardedFetch only.
const BUDGET_PROBE = join(__dirname, '..', 'fixtures', 'network-budget-probe.ts');
type BudgetOut = {
  guarded?: { ok: boolean; code: string | null; disabled: boolean | null }[];
  fetchAfterGuarded?: number;
  assertCode?: string | null;
  safeFetch?: { ok: boolean; code: string | null; disabled: boolean | null; causeCode: string | null };
  retry?: { ok: boolean; code: string | null; disabled: boolean | null; causeCode: string | null };
  attempts?: number;
  off?: { ok: boolean; code: string | null; disabled: boolean | null }[];
  usedAfterOff?: number;
  on?: { ok: boolean; code: string | null; disabled: boolean | null }[];
  okCount?: number;
  spies: { fetch: number; lookup: number };
  used: number;
  logLines: { k: number; n: number; host: string }[];
};
async function budgetProbe(scenario: string, max: string | undefined): Promise<BudgetOut> {
  const r = await runProbe(BUDGET_PROBE, { SP_ENV: 'prod', SP_NETWORK: undefined, SP_ARXIV_OFFLINE_DIR: undefined, SP_NET: undefined, SP_NETWORK_MAX_REQUESTS: max }, [scenario]);
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as BudgetOut;
}

describe('SP_NETWORK_MAX_REQUESTS (request budget of the process)', () => {
  it('networkMaxRequests: unset → null, non-negative integers only; loadConfig carries the value and refuses others', () => {
    expect(networkMaxRequests({})).toBeNull();
    expect(networkMaxRequests({ SP_NETWORK_MAX_REQUESTS: '0' })).toBe(0);
    expect(networkMaxRequests({ SP_NETWORK_MAX_REQUESTS: '12' })).toBe(12);
    for (const bad of ['-1', '1.5', 'abc', '', ' 3', '03', '1e3']) expect(() => networkMaxRequests({ SP_NETWORK_MAX_REQUESTS: bad }), bad).toThrow(/SP_NETWORK_MAX_REQUESTS must be a non-negative integer/);
    const base = { SP_CONFIG_PATH: '/nonexistent/study_paper-config.json', SP_DATA_DIR: '/tmp/sp-unused' };
    expect(loadConfig(base).networkMaxRequests).toBeNull();
    expect(loadConfig({ ...base, SP_NETWORK_MAX_REQUESTS: '12' }).networkMaxRequests).toBe(12);
    expect(() => loadConfig({ ...base, SP_NETWORK_MAX_REQUESTS: 'abc' })).toThrow(/SP_NETWORK_MAX_REQUESTS/);
  });

  it('n = 2: two requests reach fetch, the third is refused before fetch (network_budget, a NetworkDisabledError), the guard refuses afterwards, two log lines with the host', async () => {
    const out = await budgetProbe('budget', '2');
    expect(out.guarded!.map((g) => g.ok)).toEqual([true, true, false]);
    expect(out.guarded![2]).toMatchObject({ code: 'network_budget', disabled: true });
    expect(out.fetchAfterGuarded).toBe(2);
    expect(out.assertCode).toBe('network_budget');
    // safeFetch's existing guard path: FetchError blocked_url with the budget error as the cause (not retried)
    expect(out.safeFetch).toMatchObject({ ok: false, code: 'blocked_url', disabled: true, causeCode: 'network_budget' });
    expect(out.spies).toEqual({ fetch: 2, lookup: 0 });
    expect(out.used).toBe(2);
    expect(out.logLines).toEqual([
      { k: 1, n: 2, host: 'export.arxiv.org' },
      { k: 2, n: 2, host: 'arxiv.org' },
    ]);
  }, 60_000);

  it('the arXiv retry loop stops at the refusal: n = 2 with 503 answers → 2 real requests, 3 attempts, no 4th (the refusal is not retried)', async () => {
    const out = await budgetProbe('retry', '2');
    expect(out.retry).toMatchObject({ ok: false, code: 'blocked_url', disabled: true, causeCode: 'network_budget' });
    expect(out.attempts).toBe(3);
    expect(out.spies.fetch).toBe(2);
    expect(out.logLines.map((l) => l.k)).toEqual([1, 2]);
  }, 60_000);

  it('requests refused by SP_NETWORK=off are not counted', async () => {
    const out = await budgetProbe('off-not-counted', '2');
    expect(out.off!.every((o) => !o.ok && o.code === 'network_disabled')).toBe(true);
    expect(out.usedAfterOff).toBe(0);
    expect(out.on!.map((o) => o.ok)).toEqual([true, true, false]);
    expect(out.on![2]!.code).toBe('network_budget');
    expect(out.spies.fetch).toBe(2);
  }, 60_000);

  it('without the env: no cap, no count, no log line (behaviour unchanged)', async () => {
    const out = await budgetProbe('unlimited', undefined);
    expect(out.okCount).toBe(20);
    expect(out.spies.fetch).toBe(20);
    expect(out.used).toBe(0);
    expect(out.logLines).toEqual([]);
  }, 60_000);

  for (const bad of ['-1', '1.5', 'abc']) {
    it(`SP_NETWORK_MAX_REQUESTS=${bad}: the server does not start`, async () => {
      const root = tempDir();
      const env = { ...serverEnv(root, 'data', await freePort()), SP_NETWORK_MAX_REQUESTS: bad };
      const p = startServerProcess(env);
      const code = await p.exit;
      expect(code).not.toBe(0);
      expect(p.output()).toMatch(/SP_NETWORK_MAX_REQUESTS must be a non-negative integer/);
    }, 60_000);
  }
});
