// Owner A. Contract cases of the progress route module (M2): progress.list, progress.put, papers.position.
import { expect } from 'vitest';
import type { PaperDetailDto, ProgressDto } from '@study-paper/shared/contracts/api';
import { SEED_LINKS_PAPER_ID, SEED_PAPER_ID, seedFixture } from '../../src/dev/seedFixture';
import type { CaseContext, RouteCase } from '../helpers/routeCases';

const MISSING = '00000000-0000-4000-8000-00000000dead';
const sections = (ctx: CaseContext, paperId: string) => (ctx.server.deps.sqlite.prepare(`SELECT id FROM sections WHERE paperId = ? ORDER BY ordinal`).all(paperId) as { id: string }[]).map((r) => r.id);

export const cases: RouteCase[] = [
  {
    route: 'progress.put',
    name: 'a section of the paper → upserted state',
    expect: 'ok',
    params: (ctx) => ({ id: SEED_PAPER_ID, sectionId: sections(ctx, SEED_PAPER_ID)[0]! }),
    body: { state: 'understood' },
    check: (r, ctx) => expect(r.json).toMatchObject({ sectionId: sections(ctx, SEED_PAPER_ID)[0], state: 'understood' }),
  },
  {
    route: 'progress.put',
    name: 'a section of another paper → 404',
    expect: 'not_found',
    setup: async (ctx) => {
      await seedFixture(ctx.server.deps.db, ctx.server.deps.sqlite, ctx.server.deps.paths, Date.now(), { papers: ['links'] });
    },
    params: (ctx) => ({ id: SEED_PAPER_ID, sectionId: sections(ctx, SEED_LINKS_PAPER_ID)[0]! }),
    body: { state: 'skimmed' },
  },
  { route: 'progress.put', name: 'unknown state → 400', expect: 'validation', params: (ctx) => ({ id: SEED_PAPER_ID, sectionId: sections(ctx, SEED_PAPER_ID)[0]! }), body: { state: 'mastered' } },
  { route: 'progress.put', name: 'unknown paper → 404', expect: 'not_found', params: { id: MISSING, sectionId: MISSING }, body: { state: 'skimmed' } },

  {
    route: 'progress.list',
    name: 'states of the paper in section order',
    expect: 'ok',
    setup: async (ctx) => {
      const [s1, s2] = sections(ctx, SEED_PAPER_ID);
      for (const [sid, state] of [
        [s2, 'skimmed'],
        [s1, 'reimplementable'],
      ] as const) {
        await ctx.server.req(`/api/papers/${SEED_PAPER_ID}/progress/${sid}`, { method: 'PUT', headers: { 'X-SP-Token': ctx.server.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) });
      }
    },
    params: { id: SEED_PAPER_ID },
    check: (r, ctx) => expect((r.json as { progress: ProgressDto[] }).progress.map((p) => [p.sectionId, p.state])).toEqual([
      [sections(ctx, SEED_PAPER_ID)[0], 'reimplementable'],
      [sections(ctx, SEED_PAPER_ID)[1], 'skimmed'],
    ]),
  },
  { route: 'progress.list', name: 'unknown paper → 404', expect: 'not_found', params: { id: MISSING } },

  {
    route: 'papers.position',
    name: 'stores the position (papers.get.lastPosition) and lastOpenedAt',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: { page: 2, zoom: 1.25, mode: 'custom', top: 0.4 },
    check: async (_r, ctx) => {
      const d = JSON.parse((await ctx.server.req(`/api/papers/${SEED_PAPER_ID}`, { headers: { 'X-SP-Token': ctx.server.token } })).text) as PaperDetailDto;
      expect(d.lastPosition).toEqual({ page: 2, zoom: 1.25, mode: 'custom', top: 0.4 });
      expect(d.lastOpenedAt).not.toBeNull();
    },
  },
  { route: 'papers.position', name: 'a page beyond the paper → 400', expect: 'validation', params: { id: SEED_PAPER_ID }, body: { page: 3, zoom: 1, mode: 'page-width', top: 0 } },
  { route: 'papers.position', name: 'top outside 0..1 → 400', expect: 'validation', params: { id: SEED_PAPER_ID }, body: { page: 1, zoom: 1, mode: 'custom', top: 1.5 } },
  { route: 'papers.position', name: 'unknown paper → 404', expect: 'not_found', params: { id: MISSING }, body: { page: 1, zoom: 1 } },
];
