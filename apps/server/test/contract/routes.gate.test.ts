/// <reference types="vite/client" />
// Permanent route gate (review B2, M8). Owner: supervisor. Runs on every branch and at every merge.
//   1. Every route of a milestone <= the gated milestone is implemented (GATED_MILESTONE in routeManifest.ts;
//      SP_GATE_MILESTONE can only raise it for a preview on a builder branch — helpers/gate.ts).
//   2. Every implemented route has contract cases (test/routes/*.cases.ts): >= 1 ok case, and >= 1 error case
//      unless the route takes no params, query or body.
//   3. Every case passes: status + framing from contracts/routes.ts, JSON body parsed with contracts/api.ts,
//      SSE streams start correctly and end with exactly one terminal event, errors are the error DTO.
//   4. Only routes of a later milestone may still answer 501.
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_SCHEMAS, type RouteSchemas } from '@study-paper/shared/contracts/api';
import { inspectPng } from '@study-paper/shared/image/png';
import { API_ERROR_STATUS, ErrorDtoSchema } from '@study-paper/shared/contracts/errors';
import { gateStage, routeDue, GATED_MILESTONE, ROUTE_MANIFEST } from '@study-paper/shared/contracts/routeManifest';
import { gateMilestone } from '../helpers/gate';
import { API_PREFIX, ROUTE_BY_ID, ROUTES, routePath, type RouteId } from '@study-paper/shared/contracts/routes';
import { JOB_TERMINAL_EVENTS, parseSseEvent, RUN_TERMINAL_EVENTS, type SseEvent } from '@study-paper/shared/contracts/sse';
import { collectHandlers, withContract } from '../../src/app';
import { makeTestPng } from '../helpers/png';
import { resolveLazy, type CaseContext, type CaseResponse, type RouteCase } from '../helpers/routeCases';
import { startTestServer, type TestServer } from '../helpers/server';

const modules = import.meta.glob<{ cases: RouteCase[] }>('../routes/*.cases.ts', { eager: true });
const ALL_CASES: RouteCase[] = Object.values(modules).flatMap((m) => m.cases);
const gate = gateMilestone();
const stage = gateStage(process.env.SP_GATE_STAGE);

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((f) => f.trim() !== '')
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (!event || data === undefined) throw new Error(`malformed SSE frame: ${frame.slice(0, 120)}`);
      return parseSseEvent(event, JSON.parse(data));
    });
}

function checkStream(route: RouteId, events: SseEvent[]): void {
  const family = route === 'jobs.events' ? 'job' : 'run';
  const terminals: readonly string[] = family === 'job' ? JOB_TERMINAL_EVENTS : RUN_TERMINAL_EVENTS;
  expect(events.length, 'stream has events').toBeGreaterThan(0);
  for (const e of events) expect(e.event.startsWith(`${family}.`), `${e.event} in a ${family} stream`).toBe(true);
  if (family === 'run') expect(events[0]!.event).toBe('run.accepted');
  expect(events.filter((e) => terminals.includes(e.event)).length, 'exactly one terminal event').toBe(1);
  expect(terminals.includes(events.at(-1)!.event), 'the terminal event is last').toBe(true);
}

/** The `ok` branch: framing per response kind of contracts/routes.ts. An unknown kind is an error, never a pass. */
function checkOk(route: RouteId, res: CaseResponse, type: string): void {
  const def = ROUTE_BY_ID[route];
  expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);
  if (def.response === 'json') (API_SCHEMAS[route] as RouteSchemas).response!.parse(res.json);
  else if (def.response === 'sse') {
    expect(type).toContain('text/event-stream');
    res.events = parseSse(res.text);
    checkStream(route, res.events);
  } else if (def.response === 'pdf') expect(type).toContain('application/pdf');
  else if (def.response === 'markdown') expect(type).toContain('text/markdown');
  else if (def.response === 'png') {
    expect(res.status).toBe(200);
    expect(type).toContain('image/png');
    expect(inspectPng(res.body.toString('base64')), 'png body passes inspectPng').toMatchObject({ ok: true });
  } else if (def.response === 'empty') expect(res.status).toBe(204);
  else throw new Error(`route ${route}: response kind ${String(def.response)} has no check in routes.gate`);
}

describe('route gate: the png branch (fake papers.capture handler through withContract)', () => {
  const ID = '00000000-0000-4000-8000-000000000001';
  async function call(handler: Parameters<typeof withContract>[1]): Promise<{ res: CaseResponse; type: string }> {
    const def = ROUTE_BY_ID['papers.capture'] as typeof ROUTE_BY_ID['papers.capture'] & { id: RouteId };
    const app = new Hono();
    app.on(def.method, def.path, withContract({ ...def, id: 'papers.capture' }, handler));
    const r = await app.request(`/papers/${ID}/captures/${ID}`);
    const body = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') ?? '';
    return { res: { status: r.status, headers: Object.fromEntries(r.headers), text: body.toString('latin1'), body, json: undefined, events: [] }, type };
  }

  it('a valid PNG with image/png passes the ok branch', async () => {
    const png = makeTestPng({ width: 16, height: 12 });
    const { res, type } = await call(() => new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }));
    expect(res.status).toBe(200);
    checkOk('papers.capture', res, type);
  });

  it('a broken PNG body fails the ok branch; a wrong content type is a 500 from withContract', async () => {
    const broken = makeTestPng({ width: 16, height: 12 });
    broken[broken.length - 1] ^= 1; // IEND CRC
    const bad = await call(() => new Response(broken, { status: 200, headers: { 'Content-Type': 'image/png' } }));
    expect(() => checkOk('papers.capture', bad.res, bad.type)).toThrow();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const wrong = await call((c) => c.json({ not: 'png' }));
      expect(wrong.res.status).toBe(500);
    } finally {
      err.mockRestore();
    }
  });

  it('empty stays exactly 204 and an unknown kind throws', () => {
    const res: CaseResponse = { status: 200, headers: {}, text: '', body: Buffer.alloc(0), json: undefined, events: [] };
    expect(() => checkOk('papers.delete', res, '')).toThrow();
    expect(() => checkOk('papers.delete', { ...res, status: 204 }, '')).not.toThrow();
    const def = ROUTE_BY_ID['papers.delete'] as { response: string };
    const saved = def.response;
    def.response = 'zip';
    try {
      expect(() => checkOk('papers.delete', { ...res, status: 204 }, '')).toThrow(/has no check/);
    } finally {
      def.response = saved;
    }
  });
});

describe('route gate', () => {
  let s: TestServer;
  let implemented: Set<RouteId>;
  beforeAll(async () => {
    s = await startTestServer({ env: 'prod', seed: true });
    implemented = collectHandlers(s.deps).implemented;
  });
  afterAll(async () => {
    await s.close();
  });

  it(`every route up to milestone ${gate} is implemented`, () => {
    const missing = ROUTE_MANIFEST.filter((m) => routeDue(m, gate, stage) && !implemented.has(m.route)).map((m) => `${m.route} (${m.owner}, M${m.milestone})`);
    expect(missing).toEqual([]);
  });

  it('every implemented route has contract cases, and no case targets an unimplemented route', () => {
    const problems: string[] = [];
    for (const route of implemented) {
      const mine = ALL_CASES.filter((c) => c.route === route);
      const schemas: RouteSchemas = API_SCHEMAS[route];
      const canFail = Boolean(schemas.params || schemas.query || schemas.body) || route === 'papers.upload';
      if (!mine.some((c) => c.expect === 'ok')) problems.push(`${route}: no ok case`);
      if (canFail && !mine.some((c) => c.expect !== 'ok')) problems.push(`${route}: no error case`);
    }
    for (const c of ALL_CASES) if (!implemented.has(c.route)) problems.push(`${c.route}: case "${c.name}" but the route is not implemented`);
    expect(problems, 'add cases in apps/server/test/routes/<module>.cases.ts').toEqual([]);
  });

  it('only routes of a later milestone answer 501', async () => {
    for (const r of ROUTES) {
      const m = ROUTE_MANIFEST.find((x) => x.route === r.id)!;
      if (implemented.has(r.id)) continue;
      expect(routeDue(m, gate, stage), r.id).toBe(false);
      expect(m.milestone, `${r.id} is not implemented`).toBeGreaterThan(gate);
    }
  });

  for (const c of ALL_CASES) {
    it(`${c.route} — ${c.name} → ${c.expect}`, async () => {
      const ctx: CaseContext = { server: s, vars: {} };
      await c.setup?.(ctx);
      const def = ROUTE_BY_ID[c.route];
      const query = resolveLazy(c.query, ctx);
      const path = API_PREFIX + routePath(c.route, resolveLazy(c.params, ctx) ?? {}) + (query ? `?${new URLSearchParams(query)}` : '');
      const raw = resolveLazy(c.raw, ctx);
      const body = resolveLazy(c.body, ctx);
      const headers: Record<string, string> = { 'X-SP-Token': s.token, ...(raw ? { 'Content-Type': raw.contentType, ...raw.headers } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
      const r = await s.req(path, { method: def.method, headers, body: raw ? raw.body : body !== undefined ? JSON.stringify(body) : undefined });
      const type = String(r.headers['content-type'] ?? '');
      const res: CaseResponse = { status: r.status, headers: r.headers, text: r.text, body: r.body, json: type.includes('application/json') ? JSON.parse(r.text) : undefined, events: [] };

      if (c.expect !== 'ok') {
        expect(res.status, r.text.slice(0, 300)).toBe(API_ERROR_STATUS[c.expect]);
        expect(ErrorDtoSchema.parse(res.json).error.code).toBe(c.expect);
      } else checkOk(c.route, res, type);
      await c.check?.(res, ctx);
    });
  }
});
