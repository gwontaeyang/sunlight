// Probe for network.guard.test — SP_NETWORK_MAX_REQUESTS (BRIEF_INTEGRATION I9). Owner: supervisor.
// Runs in its own process (no VITEST). Replaces globalThis.fetch with a counting stub (never the network) and records
// the console.log lines, then drives guardedFetch / assertNetworkAllowed / safeFetch / the arXiv retry loop as
// `argv[2]` says. Prints one JSON line.
import dns from 'node:dns';
import { DEFAULT_ARXIV_RETRY, withArxivRetry } from '../../src/ingest/arxivApi';
import { HostQueue } from '../../src/ingest/hostQueue';
import { safeFetchText } from '../../src/ingest/safeFetch';
import { assertNetworkAllowed, guardedFetch, isNetworkDisabled, NETWORK_REQUEST_LOG_RE, networkRequestsUsed } from '../../src/security/network';

const spies = { fetch: 0, lookup: 0 };
let status = 200;
globalThis.fetch = (async () => {
  spies.fetch++;
  return new Response('<feed/>', { status, headers: { 'content-type': 'application/atom+xml' } });
}) as typeof fetch;
(dns as unknown as { lookup: unknown }).lookup = (...a: unknown[]) => {
  spies.lookup++;
  const cb = a[a.length - 1] as (e: Error | null, addr?: string, fam?: number) => void;
  cb(null, '127.0.0.1', 4);
};
const logs: string[] = [];
const origLog = console.log.bind(console);
console.log = (...a: unknown[]) => {
  logs.push(a.map(String).join(' '));
};

interface Outcome {
  ok: boolean;
  code: string | null;
  disabled: boolean | null;
  causeCode: string | null;
}
async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return { ok: true, code: null, disabled: null, causeCode: null };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    return { ok: false, code: (e as { code?: string }).code ?? null, disabled: isNetworkDisabled(e), causeCode: cause?.code ?? null };
  }
}

const scenario = process.argv[2];
const out: Record<string, unknown> = { scenario };
if (scenario === 'budget') {
  // n = 2 (env): two requests reach the stub, the third is refused before fetch; the guard refuses afterwards too.
  const guarded: Outcome[] = [];
  for (const u of ['https://export.arxiv.org/api/query?id_list=1', 'https://arxiv.org/pdf/1v1', 'https://arxiv.org/html/1v1']) guarded.push(await attempt(() => guardedFetch(u, {})));
  out.guarded = guarded;
  out.fetchAfterGuarded = spies.fetch;
  let assertCode: string | null = null;
  try {
    assertNetworkAllowed('after budget');
  } catch (e) {
    assertCode = (e as { code?: string }).code ?? 'thrown';
  }
  out.assertCode = assertCode;
  // safeFetch with the default fetch: refused at the entry guard → FetchError blocked_url with the budget error as cause.
  out.safeFetch = await attempt(() => safeFetchText('https://arxiv.org/abs/1', { kind: 'atom', queue: new HostQueue() }));
} else if (scenario === 'retry') {
  // n = 2 (env), the stub answers 503: the arXiv retry loop sends 2 real requests, then the budget refusal (not
  // retryable) ends it — the 3rd attempt never reaches fetch, there is no 4th attempt.
  status = 503;
  let t = 1_000_000;
  const now = () => t;
  const queue = new HostQueue(now, async (ms) => {
    t += ms;
  });
  let attempts = 0;
  const o = { ...DEFAULT_ARXIV_RETRY, now };
  out.retry = await attempt(() =>
    withArxivRetry(
      (ctx) => {
        attempts++;
        return safeFetchText('https://export.arxiv.org/api/query?id_list=2', { kind: 'atom', queue, ...ctx });
      },
      { o, bodySafe: true },
    ),
  );
  out.attempts = attempts;
} else if (scenario === 'off-not-counted') {
  // SP_NETWORK=off at first (env flipped in-process): refused requests are not counted; then on → n requests pass.
  process.env.SP_NETWORK = 'off';
  const off: Outcome[] = [];
  for (let i = 0; i < 3; i++) off.push(await attempt(() => guardedFetch('https://arxiv.org/abs/3', {})));
  out.off = off;
  out.usedAfterOff = networkRequestsUsed();
  delete process.env.SP_NETWORK;
  const on: Outcome[] = [];
  for (let i = 0; i < 3; i++) on.push(await attempt(() => guardedFetch('https://arxiv.org/abs/3', {})));
  out.on = on;
} else if (scenario === 'unlimited') {
  const results: Outcome[] = [];
  for (let i = 0; i < 20; i++) results.push(await attempt(() => guardedFetch('https://arxiv.org/abs/4', {})));
  out.okCount = results.filter((r) => r.ok).length;
} else {
  out.error = `unknown scenario ${scenario}`;
}
out.spies = spies;
out.used = networkRequestsUsed();
out.logLines = logs.filter((l) => NETWORK_REQUEST_LOG_RE.test(l)).map((l) => {
  const m = NETWORK_REQUEST_LOG_RE.exec(l)!;
  return { k: Number(m[1]), n: Number(m[2]), host: m[3] };
});
out.otherLogs = logs.filter((l) => !NETWORK_REQUEST_LOG_RE.test(l)).length;
origLog(JSON.stringify(out));
