// Owner A. The html step deadline (PLAN_M2 3.1, BRIEF_A A1): ONE deadline of 60 s for the whole step — queue waits,
// cooldowns, headers and body — decided before the first wait from the time left. Late → step warn + html_deferred,
// the import continues with v1; the shared cooldown is never shortened. Mock fetch, fake clock (and one short real
// deadline for a hanging response).
import { afterEach, describe, expect, it } from 'vitest';
import { QueueAbortedError } from '../../src/ingest/hostQueue';
import { configureIngest, HTML_STEP_DEADLINE_MS, ingestService } from '../../src/ingest/pipeline';
import type { FetchImpl } from '../../src/ingest/safeFetch';
import { startTestServer, type TestServer } from '../helpers/server';
import { atomFeed, freshId, importAndWait, SYNTHETIC_PDF } from './helpers';
import { warnings } from './m2helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function clock() {
  const c = { t: Date.parse('2026-11-16T12:00:00Z') };
  return {
    c,
    now: () => c.t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new QueueAbortedError(signal.reason);
      await new Promise((r) => setTimeout(r, 1));
      c.t += ms;
    },
  };
}
/** arXiv answering metadata + PDF; the HTML URL answers with `html` (a Response, or 'hang' until aborted). */
function arxiv(id: string, html: () => Response | 'hang', now: () => number) {
  const log: { url: string; at: number }[] = [];
  const impl: FetchImpl = (url, init) => {
    log.push({ url, at: now() });
    if (url.startsWith('https://export.arxiv.org/api/query')) return Promise.resolve(new Response(atomFeed([{ id, version: 1 }]), { headers: { 'content-type': 'application/atom+xml' } }));
    if (url === `https://arxiv.org/pdf/${id}v1`) return Promise.resolve(new Response(new Uint8Array(SYNTHETIC_PDF)));
    if (url === `https://arxiv.org/html/${id}v1`) {
      const r = html();
      if (r !== 'hang') return Promise.resolve(r);
      return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    }
    return Promise.resolve(new Response('', { status: 404 }));
  };
  return { impl, log, htmlRequests: () => log.filter((l) => l.url.includes('/html/')) };
}
async function prodServer(): Promise<TestServer> {
  const s = await startTestServer({ env: 'prod' });
  servers.push(s);
  return s;
}
const htmlStep = (stepsJson: string) => (JSON.parse(stepsJson) as { step: string; status: string; detail?: string }[]).find((x) => x.step === 'html');

describe('html step deadline', () => {
  it('is 60 s', () => expect(HTML_STEP_DEADLINE_MS).toBe(60_000));

  it('429 with Retry-After 90 s (longer than the 60 s left): one request, step warn html_deferred, v1; the cooldown stays 90 s', async () => {
    const s = await prodServer();
    const clk = clock();
    const id = freshId();
    const a = arxiv(id, () => new Response('', { status: 429, headers: { 'retry-after': '90' } }), clk.now);
    configureIngest(s.deps, { fetchImpl: a.impl, now: clk.now, queueSleep: clk.sleep, arxivRetry: { now: clk.now }, cooldownStore: null });
    const { job, paper } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(a.htmlRequests()).toHaveLength(1);
    expect(htmlStep(job.stepsJson)).toMatchObject({ status: 'warn', detail: expect.stringContaining('html_deferred') });
    expect(paper).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(warnings(s.deps, paper.id)).toEqual(['html_deferred']);
    expect(ingestService(s.deps).queue.cooldownOf('arxiv.org')).toEqual({ until: a.htmlRequests()[0]!.at + 90_000, cause: 'HTTP 429' });
  });

  it('a shared cooldown of 70 s already set by another job: refused before the first wait — 0 HTML requests, html_deferred', async () => {
    const s = await prodServer();
    const clk = clock();
    const id = freshId();
    const a = arxiv(id, () => new Response('<html></html>'), clk.now);
    configureIngest(s.deps, {
      fetchImpl: a.impl,
      now: clk.now,
      queueSleep: clk.sleep,
      arxivRetry: { now: clk.now },
      cooldownStore: null,
      beforeStep: (step) => {
        if (step === 'html') ingestService(s.deps).queue.cooldown('arxiv.org', clk.now() + 70_000, 'HTTP 503');
      },
    });
    const { job } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(a.htmlRequests()).toHaveLength(0);
    expect(htmlStep(job.stepsJson)).toMatchObject({ status: 'warn', detail: expect.stringContaining('html_deferred') });
  });

  it('a cooldown over the 120 s wait cap → html_deferred at once (the arXiv cooldown message), 0 HTML requests', async () => {
    const s = await prodServer();
    const clk = clock();
    const id = freshId();
    const a = arxiv(id, () => new Response('<html></html>'), clk.now);
    configureIngest(s.deps, {
      fetchImpl: a.impl,
      now: clk.now,
      queueSleep: clk.sleep,
      arxivRetry: { now: clk.now },
      cooldownStore: null,
      beforeStep: (step) => {
        if (step === 'html') ingestService(s.deps).queue.cooldown('arxiv.org', clk.now() + 600_000, 'HTTP 429');
      },
    });
    const { job } = await importAndWait(s.deps, id);
    expect(a.htmlRequests()).toHaveLength(0);
    expect(htmlStep(job.stepsJson)!.detail).toContain('약 10분 뒤');
  });

  it('a response that never comes: the step ends at its deadline (short real deadline injected) → html_deferred, the job finishes', async () => {
    const s = await prodServer();
    const id = freshId();
    const a = arxiv(id, () => 'hang', Date.now);
    configureIngest(s.deps, { fetchImpl: a.impl, htmlDeadlineMs: 4_000, cooldownStore: null });
    const t0 = Date.now();
    const { job, paper } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(htmlStep(job.stepsJson)).toMatchObject({ status: 'warn', detail: expect.stringContaining('html_deferred') });
    expect(warnings(s.deps, paper.id)).toEqual(['html_deferred']);
  }, 30_000);
});
