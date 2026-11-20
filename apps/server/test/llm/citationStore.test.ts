// citationStore (PLAN_M2 3.3, D7, BRIEF_B B6): one read / write path for message, paper_card_item and glossary_term
// citations; equation fields joined from `equations` on read; the delete triggers leave no orphan; a stored LaTeX over
// EQUATION_LATEX_MAX is left out on read so threads.get and cards.list stay valid responses. Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Citation, CitationOwnerType } from '@study-paper/shared/contracts/domain';
import { EQUATION_LATEX_MAX } from '@study-paper/shared/contracts/domain';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { SEED_M2_PAPER_ID, seedFixture } from '../../src/dev/seedFixture';
import { equationIndex, readCitations, writeCitations } from '../../src/llm/citationStore';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';
import { makeRunEnv } from './runEnv';

describe('round trip for the three owners', () => {
  it('quote (position, unchecked reason) and equation (equationId → latex / katexOk; ambiguous → eqCandidates) come back as written', async () => {
    const env = await makeRunEnv();
    await seedFixture(env.db, env.sqlite, env.paths, Date.now(), { papers: ['m2'] });
    const idx = equationIndex(env.db, SEED_M2_PAPER_ID);
    const one = idx.find((e) => e.number === '1')!;
    const amb = idx.filter((e) => e.number === 'A.1');
    const now = Date.now();
    // owners: a thread message, a card item, a glossary term of SEED_M2
    const threadId = randomUUID();
    const msgId = randomUUID();
    const cardId = randomUUID();
    const itemId = randomUUID();
    const termId = randomUUID();
    env.sqlite.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES (?, ?, 'chat', 't', ?, ?)`).run(threadId, SEED_M2_PAPER_ID, now, now);
    env.sqlite.prepare(`INSERT INTO messages (id, threadId, role, contentMd, status, createdAt) VALUES (?, ?, 'assistant', 'x', 'complete', ?)`).run(msgId, threadId, now);
    env.sqlite.prepare(`INSERT INTO paper_cards (id, paperId, kind, status, createdAt) VALUES (?, ?, 'notation', 'complete', ?)`).run(cardId, SEED_M2_PAPER_ID, now);
    env.sqlite.prepare(`INSERT INTO paper_card_items (id, cardId, ordinal, bodyMd) VALUES (?, ?, 1, 'x')`).run(itemId, cardId);
    env.sqlite.prepare(`INSERT INTO glossary_terms (id, paperId, term, termNorm, origin, createdAt) VALUES (?, ?, 't', 't', 'manual', ?)`).run(termId, SEED_M2_PAPER_ID, now);
    const cites: Citation[] = [
      { ordinal: 1, kind: 'quote', quote: 'We estimate the robot pose', status: 'verbatim', score: 1, position: { page: 1, start: 3, end: 29 } },
      { ordinal: 2, kind: 'quote', quote: 'too much', status: 'unchecked', score: 0, uncheckedReason: 'work_budget' },
      { ordinal: 3, kind: 'equation', eqNumber: '1', status: 'resolved', score: 1, equationId: one.id! },
      { ordinal: 4, kind: 'equation', eqNumber: 'A.1', status: 'ambiguous', score: 0, candidates: 2 },
      { ordinal: 5, kind: 'equation', eqNumber: '9', status: 'not_found', score: 0 },
    ];
    for (const [type, id] of [['message', msgId], ['paper_card_item', itemId], ['glossary_term', termId]] as [CitationOwnerType, string][]) {
      env.db.transaction((tx) => writeCitations(tx, type, id, cites));
      const back = readCitations(env.db, type, id);
      expect(back[0]).toEqual(cites[0]);
      expect(back[1]).toEqual(cites[1]);
      expect(back[2]).toEqual({ ...cites[2], latex: one.latex, katexOk: true });
      expect(back[3]).toEqual({ ...cites[3], eqCandidates: amb.map((e) => ({ equationId: e.id, sectionNumber: e.sectionNumber, pdfPage: e.pdfPage })) });
      expect(back[4]).toEqual(cites[4]);
      // writing again replaces (no duplicate ordinal)
      env.db.transaction((tx) => writeCitations(tx, type, id, cites.slice(0, 1)));
      expect(readCitations(env.db, type, id)).toHaveLength(1);
      env.db.transaction((tx) => writeCitations(tx, type, id, cites));
    }
    // equationId stored only for resolved | no_anchor, detail only for unchecked
    expect(env.sqlite.prepare(`SELECT ordinal, equationId IS NOT NULL AS e, detail FROM citations WHERE ownerId = ? ORDER BY ordinal`).all(msgId)).toEqual([
      { ordinal: 1, e: 0, detail: null },
      { ordinal: 2, e: 0, detail: 'work_budget' },
      { ordinal: 3, e: 1, detail: null },
      { ordinal: 4, e: 0, detail: null },
      { ordinal: 5, e: 0, detail: null },
    ]);
    // deleting the owners: the triggers remove their citations, no orphan is left
    env.sqlite.prepare(`DELETE FROM threads WHERE id = ?`).run(threadId);
    env.sqlite.prepare(`DELETE FROM paper_cards WHERE id = ?`).run(cardId);
    env.sqlite.prepare(`DELETE FROM glossary_terms WHERE id = ?`).run(termId);
    expect(env.sqlite.prepare(`SELECT count(*) AS n FROM citations`).get()).toEqual({ n: 0 });
    env.close();
  });
});

describe('a stored LaTeX of 4,001 chars', () => {
  let s: TestServer;
  afterEach(async () => {
    await s?.close();
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await s.req(`/api${path}`, { method, headers: { 'X-SP-Token': s.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const events: SseEvent[] = String(r.headers['content-type']).includes('event-stream')
      ? r.text
          .split('\n\n')
          .filter((f) => f.trim())
          .map((f) => parseSseEvent(/^event: (.*)$/m.exec(f)![1]!, JSON.parse(/^data: (.*)$/m.exec(f)![1]!)))
      : [];
    return { status: r.status, json: String(r.headers['content-type']).includes('json') ? (JSON.parse(r.text) as unknown) : undefined, events };
  };
  it('a message and a card item citing it: threads.get and cards.list answer 200 without `latex`', async () => {
    const llm = new ControlledAdapter();
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm });
    s.deps.sqlite.prepare(`UPDATE equations SET latex = ? WHERE paperId = ? AND number = '1'`).run('x'.repeat(EQUATION_LATEX_MAX + 1), SEED_M2_PAPER_ID);
    llm.queueOutputs('식 <eq n="1"/> 을 본다. [[P]]');
    const r = await call('POST', `/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'chat', question: 'q', clientRequestId: randomUUID() });
    const a = r.events[0]!;
    if (a.event !== 'run.accepted') throw new Error('accepted');
    const t = await call('GET', `/threads/${a.data.threadId}`);
    expect(t.status).toBe(200);
    const cite = (t.json as { messages: { citations: Citation[] }[] }).messages[1]!.citations[0]!;
    expect(cite).toMatchObject({ status: 'resolved', equationId: expect.any(String), katexOk: true });
    expect('latex' in cite).toBe(false);
    const g = await call('POST', `/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, { clientRequestId: randomUUID() });
    expect(g.events.at(-1)!.event).toBe('run.done');
    const list = await call('GET', `/papers/${SEED_M2_PAPER_ID}/cards`);
    expect(list.status).toBe(200);
    const eqCites = (list.json as { cards: { items: { citations: Citation[] }[] }[] }).cards[0]!.items.flatMap((i) => i.citations).filter((c) => c.eqNumber === '1');
    expect(eqCites.length).toBeGreaterThan(0);
    for (const c of eqCites) expect('latex' in c).toBe(false);
  });
});
