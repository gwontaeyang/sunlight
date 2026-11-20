// Probe for network.guard.test (separate process, no VITEST). Owner: supervisor.
// Installs spies on globalThis.fetch, dns.lookup and dns.promises.lookup, then calls safeFetch through
// ① an injected fetchImpl ② defaultFetch (only when the mode is off) ③ an injected fetchImpl whose first answer is a
// 302, plus (mode on) a blocked host and a hop whose env flips to off. Prints one JSON line.
import dns from 'node:dns';
import { defaultFetch, safeFetchText, type FetchImpl } from '../../src/ingest/safeFetch';
import { HostQueue } from '../../src/ingest/hostQueue';
import { isNetworkDisabled, networkMode } from '../../src/security/network';

const spies = { fetch: 0, lookup: 0, lookupPromises: 0, impl: 0 };
globalThis.fetch = (async () => {
  spies.fetch++;
  return new Response('spy', { status: 200 });
}) as typeof fetch;
(dns as unknown as { lookup: unknown }).lookup = (...a: unknown[]) => {
  spies.lookup++;
  const cb = a[a.length - 1] as (e: Error | null, addr?: string, fam?: number) => void;
  cb(null, '127.0.0.1', 4);
};
(dns.promises as unknown as { lookup: unknown }).lookup = async () => {
  spies.lookupPromises++;
  return { address: '127.0.0.1', family: 4 };
};

const impl: FetchImpl = async () => {
  spies.impl++;
  return new Response('<feed/>', { status: 200, headers: { 'content-type': 'application/atom+xml' } });
};
let redirected = 0;
const redirectImpl: FetchImpl = async (url) => {
  spies.impl++;
  if (redirected++ === 0) return new Response(null, { status: 302, headers: { location: 'https://arxiv.org/abs/2301.00002' } });
  return new Response(`ok ${url}`, { status: 200 });
};

interface Outcome {
  path: string;
  ok: boolean;
  code: string | null;
  disabled: boolean | null;
  ms: number;
}
async function attempt(path: string, fn: () => Promise<unknown>): Promise<Outcome> {
  const t0 = Date.now();
  try {
    await fn();
    return { path, ok: true, code: null, disabled: null, ms: Date.now() - t0 };
  } catch (e) {
    return { path, ok: false, code: (e as { code?: string }).code ?? null, disabled: isNetworkDisabled(e), ms: Date.now() - t0 };
  }
}

const mode = networkMode();
const opts = (fetchImpl?: FetchImpl) => ({ kind: 'atom' as const, queue: new HostQueue(), ...(fetchImpl ? { fetchImpl } : {}) });
const outcomes: Outcome[] = [];
outcomes.push(await attempt('injected', () => safeFetchText('https://export.arxiv.org/api/query?id_list=2301.00002', opts(impl))));
if (mode === 'off') outcomes.push(await attempt('default', () => safeFetchText('https://arxiv.org/abs/2301.00002', opts())));
if (mode === 'off') outcomes.push(await attempt('defaultFetch-direct', () => defaultFetch('https://arxiv.org/abs/2301.00002', {})));
outcomes.push(await attempt('redirect', () => safeFetchText('https://arxiv.org/abs/2301.00002v1', opts(redirectImpl))));
if (mode === 'on') {
  outcomes.push(await attempt('blocked-host', () => safeFetchText('https://evil.example/x', opts(impl))));
  // The hop guard: the first hop passes, the environment turns the network off, the redirect hop is refused.
  let flip = 0;
  const flipImpl: FetchImpl = async () => {
    spies.impl++;
    if (flip++ === 0) {
      process.env.SP_NETWORK = 'off';
      return new Response(null, { status: 302, headers: { location: 'https://arxiv.org/abs/2' } });
    }
    return new Response('second hop', { status: 200 });
  };
  outcomes.push(await attempt('hop-flip', () => safeFetchText('https://arxiv.org/abs/1', opts(flipImpl))));
  delete process.env.SP_NETWORK;
}
console.log(JSON.stringify({ mode, spies, outcomes }));
