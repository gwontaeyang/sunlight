// Owner A. Contract cases of the notes route module (M2).
import { expect } from 'vitest';
import type { NoteDto } from '@study-paper/shared/contracts/api';
import { SEED_LINKS_PAPER_ID, SEED_PAPER_ID, seedFixture } from '../../src/dev/seedFixture';
import type { CaseContext, RouteCase } from '../helpers/routeCases';

const MISSING = '00000000-0000-4000-8000-00000000dead';
const sectionOf = (ctx: CaseContext, paperId: string) => (ctx.server.deps.sqlite.prepare(`SELECT id FROM sections WHERE paperId = ? ORDER BY ordinal LIMIT 1`).get(paperId) as { id: string }).id;
async function createNote(ctx: CaseContext, body: Record<string, unknown>): Promise<NoteDto> {
  const r = await ctx.server.req(`/api/papers/${SEED_PAPER_ID}/notes`, { method: 'POST', headers: { 'X-SP-Token': ctx.server.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status !== 200) throw new Error(`create note: ${r.status} ${r.text}`);
  return JSON.parse(r.text) as NoteDto;
}

export const cases: RouteCase[] = [
  {
    route: 'notes.create',
    name: 'a note on a section of the paper',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: (ctx: CaseContext) => ({ bodyMd: '**핵심**: robust kernel', sectionId: sectionOf(ctx, SEED_PAPER_ID) }),
    check: (r, ctx) => expect(r.json).toMatchObject({ paperId: SEED_PAPER_ID, sectionId: sectionOf(ctx, SEED_PAPER_ID), highlightId: null, bodyMd: '**핵심**: robust kernel' }),
  },
  {
    route: 'notes.create',
    name: 'a section of another paper → 400',
    expect: 'validation',
    setup: async (ctx) => {
      await seedFixture(ctx.server.deps.db, ctx.server.deps.sqlite, ctx.server.deps.paths, Date.now(), { papers: ['links'] });
    },
    params: { id: SEED_PAPER_ID },
    body: (ctx: CaseContext) => ({ bodyMd: 'x', sectionId: sectionOf(ctx, SEED_LINKS_PAPER_ID) }),
  },
  { route: 'notes.create', name: 'an unknown highlight → 400', expect: 'validation', params: { id: SEED_PAPER_ID }, body: { bodyMd: 'x', highlightId: MISSING } },
  { route: 'notes.create', name: 'unknown paper → 404', expect: 'not_found', params: { id: MISSING }, body: { bodyMd: 'x' } },
  { route: 'notes.create', name: 'no bodyMd → 400', expect: 'validation', params: { id: SEED_PAPER_ID }, body: {} },

  {
    route: 'notes.list',
    name: 'the notes of the paper',
    expect: 'ok',
    setup: async (ctx) => {
      ctx.vars.nid = (await createNote(ctx, { bodyMd: 'listed' })).id;
    },
    params: { id: SEED_PAPER_ID },
    check: (r, ctx) => expect((r.json as { notes: NoteDto[] }).notes.map((n) => n.id)).toContain(ctx.vars.nid),
  },
  { route: 'notes.list', name: 'unknown paper → 404', expect: 'not_found', params: { id: MISSING } },

  {
    route: 'notes.patch',
    name: 'new body',
    expect: 'ok',
    setup: async (ctx) => {
      ctx.vars.nid = (await createNote(ctx, { bodyMd: 'before' })).id;
    },
    params: (ctx) => ({ id: ctx.vars.nid! }),
    body: { bodyMd: 'after' },
    check: (r) => expect(r.json).toMatchObject({ bodyMd: 'after' }),
  },
  { route: 'notes.patch', name: 'unknown note → 404', expect: 'not_found', params: { id: MISSING }, body: { bodyMd: 'x' } },
  { route: 'notes.patch', name: 'body too long → 400', expect: 'validation', params: { id: MISSING }, body: { bodyMd: 'x'.repeat(100_001) } },

  {
    route: 'notes.delete',
    name: 'deletes the note',
    expect: 'ok',
    setup: async (ctx) => {
      ctx.vars.nid = (await createNote(ctx, { bodyMd: 'gone' })).id;
    },
    params: (ctx) => ({ id: ctx.vars.nid! }),
    check: (_r, ctx) => expect(ctx.server.deps.sqlite.prepare(`SELECT count(*) AS n FROM notes WHERE id = ?`).get(ctx.vars.nid)).toEqual({ n: 0 }),
  },
  { route: 'notes.delete', name: 'unknown note → 404', expect: 'not_found', params: { id: MISSING } },
];
