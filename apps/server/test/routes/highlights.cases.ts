// Owner A. Contract cases of the highlights route module (see ../helpers/routeCases.ts).
import { expect } from 'vitest';
import type { HighlightDto } from '@study-paper/shared/contracts/api';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { makeTestPng, makeTestPngBase64 } from '../helpers/png';
import type { CaseContext, RouteCase } from '../helpers/routeCases';

/** A PNG whose last chunk CRC is wrong (inspectPng → 400). */
function brokenPng(): string {
  const b = Buffer.from(makeTestPng({ width: 16, height: 16 }));
  b[b.length - 1] = b[b.length - 1]! ^ 0xff;
  return b.toString('base64');
}

const MISSING = '00000000-0000-4000-8000-00000000dead';
const rect = (page: number) => ({ page, x: 0.1, y: 0.2, w: 0.3, h: 0.02 });

async function createHighlight(ctx: CaseContext, body: Record<string, unknown>): Promise<HighlightDto> {
  const r = await ctx.server.req(`/api/papers/${SEED_PAPER_ID}/highlights`, {
    method: 'POST',
    headers: { 'X-SP-Token': ctx.server.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status !== 200) throw new Error(`create highlight: ${r.status} ${r.text}`);
  return JSON.parse(r.text) as HighlightDto;
}

export const cases: RouteCase[] = [
  {
    route: 'highlights.create',
    name: 'verbatim quote → server fills position',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: { kind: 'text', color: 2, quote: { exact: 'fixed threshold of 0.5 m' }, page: 1, rects: [rect(1)] },
    check: (r) => {
      const h = r.json as HighlightDto;
      expect(h.position?.page).toBe(1);
      expect(h.position!.end - h.position!.start).toBeGreaterThan(0);
      expect(h.sectionId).toBeNull();
    },
  },
  {
    route: 'highlights.create',
    name: 'ambiguous quote on the page → position null',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: { kind: 'text', color: 1, quote: { exact: 'robust kernel' }, page: 2, rects: [rect(2)] },
    check: (r) => expect((r.json as HighlightDto).position).toBeNull(),
  },
  // M2 (BRIEF_A A8): area highlights are allowed — one rect, no quote, optional capture PNG.
  {
    route: 'highlights.create',
    name: 'area highlight (M2): one rect, no image → position null, no file',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: { kind: 'area', color: 1, page: 1, rects: [rect(1)] },
    check: (r) => expect(r.json).toMatchObject({ kind: 'area', quote: null, position: null, imageFileId: null, rects: [rect(1)] }),
  },
  {
    route: 'highlights.create',
    name: 'area highlight with a capture PNG → imageFileId',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: () => ({ kind: 'area', color: 2, page: 1, rects: [rect(1)], imagePng: makeTestPngBase64({ width: 32, height: 24 }) }),
    check: (r) => expect((r.json as HighlightDto).imageFileId).toMatch(/^[0-9a-f-]{36}$/),
  },
  { route: 'highlights.create', name: 'area highlight with two rects', expect: 'validation', params: { id: SEED_PAPER_ID }, body: { kind: 'area', color: 1, page: 1, rects: [rect(1), rect(1)] } },
  { route: 'highlights.create', name: 'area highlight with a quote', expect: 'validation', params: { id: SEED_PAPER_ID }, body: { kind: 'area', color: 1, quote: { exact: 'robust kernel' }, page: 1, rects: [rect(1)] } },
  { route: 'highlights.create', name: 'area highlight with a broken PNG (bad CRC)', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'area', color: 1, page: 1, rects: [rect(1)], imagePng: brokenPng() }) },
  { route: 'highlights.create', name: 'rect on another page', expect: 'validation', params: { id: SEED_PAPER_ID }, body: { kind: 'text', color: 1, quote: { exact: 'robust kernel' }, page: 1, rects: [rect(2)] } },
  { route: 'highlights.create', name: 'page beyond the paper', expect: 'validation', params: { id: SEED_PAPER_ID }, body: { kind: 'text', color: 1, quote: { exact: 'x' }, page: 9, rects: [rect(9)] } },
  { route: 'highlights.create', name: 'unknown paper', expect: 'not_found', params: { id: MISSING }, body: { kind: 'text', color: 1, quote: { exact: 'x' }, page: 1, rects: [rect(1)] } },

  {
    route: 'highlights.list',
    name: 'seed paper highlights',
    expect: 'ok',
    setup: async (ctx) => {
      ctx.vars.hid = (await createHighlight(ctx, { kind: 'text', color: 3, quote: { exact: 'first-order Jacobian' }, page: 2, rects: [rect(2)] })).id;
    },
    params: { id: SEED_PAPER_ID },
    check: (r, ctx) => expect((r.json as { highlights: HighlightDto[] }).highlights.map((h) => h.id)).toContain(ctx.vars.hid),
  },
  { route: 'highlights.list', name: 'unknown paper', expect: 'not_found', params: { id: MISSING } },

  {
    route: 'highlights.patch',
    name: 'color and comment',
    expect: 'ok',
    setup: async (ctx) => {
      ctx.vars.hid = (await createHighlight(ctx, { kind: 'text', color: 1, quote: { exact: '10 Hz' }, page: 2, rects: [rect(2)] })).id;
    },
    params: (ctx) => ({ id: ctx.vars.hid! }),
    body: { color: 5, comment: '실시간' },
    check: (r) => expect(r.json).toMatchObject({ color: 5, comment: '실시간' }),
  },
  { route: 'highlights.patch', name: 'unknown highlight', expect: 'not_found', params: { id: MISSING }, body: { color: 2 } },
  { route: 'highlights.patch', name: 'color out of range', expect: 'validation', params: { id: MISSING }, body: { color: 9 } },

  {
    route: 'highlights.delete',
    name: 'deletes the highlight',
    expect: 'ok',
    setup: async (ctx) => {
      ctx.vars.hid = (await createHighlight(ctx, { kind: 'text', color: 1, quote: { exact: 'single CPU core' }, page: 2, rects: [rect(2)] })).id;
    },
    params: (ctx) => ({ id: ctx.vars.hid! }),
    check: (_r, ctx) => expect(ctx.server.deps.sqlite.prepare(`SELECT count(*) AS n FROM highlights WHERE id = ?`).get(ctx.vars.hid)).toEqual({ n: 0 }),
  },
  { route: 'highlights.delete', name: 'unknown highlight', expect: 'not_found', params: { id: MISSING } },
];
