// Outbound network switch (PLAN_M2 D23). Owner: supervisor — frozen; A and every worktree use it as is.
//
// SP_NETWORK=off (any SP_ENV), or a non-prod server ((SP_ENV ?? 'prod') !== 'prod' — the same default as loadConfig)
// with SP_ARXIV_OFFLINE_DIR set → mode 'off': every outbound fetch of the server and of the scripts is refused
// BEFORE fetch or DNS runs. safeFetch (entry + every hop, also for an injected fetchImpl), defaultFetch,
// scripts/fetch-fixtures.ts and scripts/smoke-ingest.ts go through it. index.ts additionally replaces
// globalThis.fetch with a refusing function when off. SP_NETWORK only governs this process's fetch; the `claude`
// child's traffic is governed by SP_LLM and the live ledger (coordinator decision 12: SP_NETWORK=off + SP_LLM=cli is
// allowed). The decision is read from the environment at call time.
// network.entrypoints.test fails when the global fetch (called or as a value), WebSocket, EventSource, node:http /
// http2 / https / dns / net / tls / dgram or undici appear outside this file (and safeFetch's fetchImpl( call) in
// apps/server/src or scripts. Only fetch is also blocked at run time (index.ts); the other entries are kept out by
// that static scan alone, and the scan does not follow a global reached through a call or another module, run-time
// built names, or eval (see sourceScan.fetchReferences).
//
// Request budget (BRIEF_INTEGRATION I9, coordinator decision 1-6): SP_NETWORK_MAX_REQUESTS=<n> (a non-negative
// integer; any other value stops the server at start, like SP_NETWORK=bogus) caps the real outbound requests of this
// process. They are counted in guardedFetch only (the one place that calls the global fetch: one real request, a
// redirect hop or a retry, is exactly one count), synchronously after the allow decision and before fetch / DNS.
// Once n requests were allowed, assertNetworkAllowed and guardedFetch throw NetworkBudgetError (a
// NetworkDisabledError, code 'network_budget') — safeFetch's guard turns it into FetchError 'blocked_url', which is
// never retried. Every allowed request logs one line NETWORK_REQUEST_LOG_RE reads. The count belongs to the process
// (a restarted server starts from 0). Without the env nothing changes: no count, no log line, no refusal.

import { reserveCampaignHttp } from './m3Campaign';

type Env = Record<string, string | undefined>;
export type NetworkMode = 'on' | 'off';

/** The one decision. Throws on an SP_NETWORK value other than on / off / unset. */
export function networkMode(env: Env = process.env): NetworkMode {
  const v = env.SP_NETWORK;
  if (v !== undefined && v !== 'on' && v !== 'off') throw new Error(`SP_NETWORK must be on|off, got ${v}`);
  if (v === 'off') return 'off';
  if ((env.SP_ENV ?? 'prod') !== 'prod' && env.SP_ARXIV_OFFLINE_DIR) return 'off';
  return 'on';
}

export class NetworkDisabledError extends Error {
  readonly code: 'network_disabled' | 'network_budget' = 'network_disabled';
  constructor(message: string) {
    super(message);
    this.name = 'NetworkDisabledError';
  }
}

/** The request budget of this process is used up (SP_NETWORK_MAX_REQUESTS). */
export class NetworkBudgetError extends NetworkDisabledError {
  override readonly code = 'network_budget' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NetworkBudgetError';
  }
}

/** SP_NETWORK_MAX_REQUESTS: null when unset, else a non-negative integer. Throws on any other value. */
export function networkMaxRequests(env: Env = process.env): number | null {
  const v = env.SP_NETWORK_MAX_REQUESTS;
  if (v === undefined) return null;
  if (!/^(0|[1-9][0-9]{0,8})$/.test(v)) throw new Error(`SP_NETWORK_MAX_REQUESTS must be a non-negative integer, got ${v}`);
  return Number(v);
}

/** The log line of one allowed request: `[study_paper] network request <k>/<n> host=<hostname>` (k, n, host). */
export const NETWORK_REQUEST_LOG_RE = /^\[study_paper\] network request (\d+)\/(\d+) host=(\S+)$/;

let requestsUsed = 0;
/** Requests counted so far in this process (only while SP_NETWORK_MAX_REQUESTS is set). */
export function networkRequestsUsed(): number {
  return requestsUsed;
}
/** Tests: start the process count from 0 again. */
export function resetNetworkRequestCount(): void {
  requestsUsed = 0;
}

/**
 * Throws NetworkDisabledError when the mode is off (decided from `env`, by default process.env at call time), and
 * NetworkBudgetError when SP_NETWORK_MAX_REQUESTS is set and that many requests were already allowed.
 */
export function assertNetworkAllowed(what: string, env: Env = process.env): void {
  if (networkMode(env) === 'off') throw new NetworkDisabledError(`network access is disabled (SP_NETWORK=off or an offline arXiv directory): ${what}`);
  const max = networkMaxRequests(env);
  if (max !== null && requestsUsed >= max) throw new NetworkBudgetError(`network request budget used up (SP_NETWORK_MAX_REQUESTS=${max}, ${requestsUsed} sent): ${what}`);
}

function hostOf(input: string): string {
  try {
    return new URL(input).hostname || '-';
  } catch {
    return '-';
  }
}

/** The only place in apps/server/src and scripts that calls the global fetch directly (and counts the request budget). */
export function guardedFetch(input: string, init: RequestInit, beforeSend?: () => void): Promise<Response> {
  try {
    assertNetworkAllowed(input);
    try {
      if (reserveCampaignHttp(process.env, input)) init = { ...init, redirect: init.redirect === 'error' ? 'error' : 'manual' };
    } catch {
      throw new NetworkBudgetError('M3 campaign refused the HTTP reservation');
    }
    const max = networkMaxRequests();
    if (max !== null) {
      requestsUsed += 1; // after the allow decision, before fetch / DNS
      console.log(`[study_paper] network request ${requestsUsed}/${max} host=${hostOf(input)}`);
    }
  } catch (e) {
    return Promise.reject(e);
  }
  beforeSend?.();
  return globalThis.fetch(input, init);
}

/** True when `e` (or its cause) is a NetworkDisabledError — tells a guard refusal from a real blocked URL (both FetchError 'blocked_url'). */
export function isNetworkDisabled(e: unknown): boolean {
  if (e instanceof NetworkDisabledError) return true;
  const cause = (e as { cause?: unknown } | null | undefined)?.cause;
  return cause instanceof NetworkDisabledError;
}

/** index.ts (mode off): replaces globalThis.fetch so a call that bypasses the guard is refused as well. */
export function disableGlobalFetch(): void {
  globalThis.fetch = (() => Promise.reject(new NetworkDisabledError('global fetch is disabled (SP_NETWORK=off)'))) as typeof fetch;
}
