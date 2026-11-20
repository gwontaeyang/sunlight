// Owner B. Contract cases of the glossary route module (see ../helpers/routeCases.ts).
import { expect } from 'vitest';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import type { CaseContext, RouteCase } from '../helpers/routeCases';

const MISSING = '00000000-0000-4000-8000-00000000dead';
const uuid = () => crypto.randomUUID();

/** Stores a term on the seed paper through the route; its id goes to ctx.vars.termId. */
async function termOnSeed(ctx: CaseContext, term = `term ${uuid()}`): Promise<void> {
  const s = ctx.server;
  const r = await s.req(`/api/papers/${SEED_PAPER_ID}/glossary`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ term, definitionKo: '정의 <q>The robust kernel down-weights outliers in the residual.</q> [[P]]' }) });
  if (r.status !== 200) throw new Error(`setup term failed: ${r.text}`);
  ctx.vars.termId = (JSON.parse(r.text) as { id: string }).id;
  ctx.vars.term = term;
}

export const cases: RouteCase[] = [
  {
    route: 'glossary.create',
    name: 'manual term: the server matches the definition (origin manual)',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: () => ({ term: `robust kernel ${uuid()}`, definitionKo: '정의 <q>The robust kernel down-weights outliers in the residual.</q> [[P]]' }),
    check: (r) => expect(r.json).toMatchObject({ origin: 'manual', citations: [{ kind: 'quote', status: 'verbatim' }] }),
  },
  { route: 'glossary.create', name: 'a client-sent citation field', expect: 'validation', params: { id: SEED_PAPER_ID }, body: { term: 'x', citations: [] } },
  { route: 'glossary.create', name: 'unknown paper', expect: 'not_found', params: { id: MISSING }, body: { term: 'x' } },
  {
    route: 'glossary.create',
    name: 'a duplicate term (normalizeTerm: case and width)',
    expect: 'conflict',
    setup: (ctx) => termOnSeed(ctx, 'Duplicate Term'),
    params: { id: SEED_PAPER_ID },
    body: { term: 'ｄｕｐｌｉｃａｔｅ   term' },
  },
  {
    route: 'glossary.list',
    name: 'the terms of the paper with their citations',
    expect: 'ok',
    setup: (ctx) => termOnSeed(ctx),
    params: { id: SEED_PAPER_ID },
    check: (r, ctx) => expect((r.json as { terms: { id: string; citations: unknown[] }[] }).terms.find((t) => t.id === ctx.vars.termId)?.citations).toHaveLength(1),
  },
  { route: 'glossary.list', name: 'unknown paper', expect: 'not_found', params: { id: MISSING } },
  {
    route: 'glossary.define',
    name: 'a suggestion for the requested term (stored as the run result, not as a term)',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: () => ({ term: 'robust kernel', clientRequestId: uuid() }),
    check: (r, ctx) => {
      const done = r.events.at(-1)!;
      expect(done.event).toBe('run.done');
      if (done.event !== 'run.done') return;
      expect((done.data.parsed as unknown as { items: { tag: string; attrs: Record<string, string> }[] }).items[0]).toMatchObject({ tag: 'term', attrs: { name: 'robust kernel' } });
      const a = r.events[0]!;
      if (a.event !== 'run.accepted') throw new Error('first event');
      expect(ctx.server.deps.sqlite.prepare(`SELECT resultRaw IS NOT NULL AS stored FROM llm_calls WHERE runId = ?`).get(a.data.runId)).toEqual({ stored: 1 });
    },
  },
  { route: 'glossary.define', name: 'unknown paper', expect: 'not_found', params: { id: MISSING }, body: () => ({ term: 'x', clientRequestId: uuid() }) },
  { route: 'glossary.define', name: 'an empty term', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ term: '', clientRequestId: uuid() }) },
  { route: 'glossary.define', name: 'a term with a quote mark (cannot be a <term name>)', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ term: 'say "hi"', clientRequestId: uuid() }) },
  { route: 'glossary.define', name: 'a term with < or > (cannot be a <term name>)', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ term: 'a<b>', clientRequestId: uuid() }) },
  {
    route: 'glossary.patch',
    name: 'change the definition: citations again',
    expect: 'ok',
    setup: (ctx) => termOnSeed(ctx),
    params: (ctx) => ({ id: ctx.vars.termId! }),
    body: { definitionKo: '새 정의 <q>A sentence that is not in the paper at all.</q> [[P]]' },
    check: (r) => expect(r.json).toMatchObject({ origin: 'manual', citations: [{ status: 'not_found' }] }),
  },
  { route: 'glossary.patch', name: 'unknown term', expect: 'not_found', params: { id: MISSING }, body: { term: 'x' } },
  { route: 'glossary.patch', name: 'origin cannot be sent', expect: 'validation', params: { id: MISSING }, body: { origin: 'llm' } },
  {
    route: 'glossary.delete',
    name: 'deletes the term and its citations',
    expect: 'ok',
    setup: (ctx) => termOnSeed(ctx),
    params: (ctx) => ({ id: ctx.vars.termId! }),
    check: (_r, ctx) => expect(ctx.server.deps.sqlite.prepare(`SELECT count(*) AS n FROM citations WHERE ownerType = 'glossary_term' AND ownerId = ?`).get(ctx.vars.termId)).toEqual({ n: 0 }),
  },
  { route: 'glossary.delete', name: 'unknown term', expect: 'not_found', params: { id: MISSING } },
];
