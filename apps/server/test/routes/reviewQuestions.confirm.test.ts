import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { createReviewCard } from '../../src/routes/review';
import { reviewSelectionPosition } from '../../src/study/selectionAnchor';
import { events, makeRunEnv } from '../llm/runEnv';
import { SelectionQuestions } from '@study-paper/shared/contracts/api';

it('atomically saves only confirmed items, binds the original location, and reuses its highlight on retries and other accepted items', async () => {
  const env = await makeRunEnv({ adapter: new MockLlmAdapter({ chunkDelayMs: 0 }) });
  try {
    const quote = { exact: 'fixed threshold of 0.5 m' };
    const page = 1, paperId = SEED_PAPER_ID;
    const pos = reviewSelectionPosition(env.db, paperId, page, quote)!;
    expect(pos).not.toBeNull();
    const run = env.manager.runTask({ task: 'selection_questions', paperId, clientRequestId: randomUUID(), reviewSelection: { page, start: pos.start, quote }, inputs: { selection: quote.exact, page: String(page) } });
    const done = (await events(run)).at(-1);
    if (done?.event !== 'run.done') throw new Error('preview failed');
    const questions = SelectionQuestions.parse(JSON.parse(done.data.text)).cards;
    const anchor = { page, quote, rects: [{ page, x: 0.1, y: 0.1, w: 0.2, h: 0.03 }] };
    const accept = (n: number) => ({ ...questions[n]!, questionIndex: n, anchor, runId: run.runId, paperId });
    const count = (table: 'highlights' | 'review_cards') => (env.sqlite.prepare('SELECT count(*) AS n FROM ' + table + ' WHERE paperId=?').get(paperId) as { n: number }).n;
    const before = [count('highlights'), count('review_cards')];
    expect(() => createReviewCard(env, { ...accept(0), backMd: 'Not the approved answer' })).toThrow();
    expect(() => createReviewCard(env, { ...accept(0), highlightId: 'missing' })).toThrow();
    expect(() => createReviewCard(env, { ...accept(0), anchor: { ...anchor, quote: { exact: 'some other source' } } })).toThrow();
    env.sqlite.exec("CREATE TRIGGER reject_card BEFORE INSERT ON review_cards BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
    expect(() => createReviewCard(env, accept(0))).toThrow();
    env.sqlite.exec('DROP TRIGGER reject_card');
    expect([count('highlights'), count('review_cards')]).toEqual(before);
    const first = createReviewCard(env, accept(0));
    expect(first).toMatchObject({ paperId, origin: 'llm', highlightId: expect.any(String), fsrs: { state: 0, reps: 0 } });
    expect(createReviewCard(env, accept(0))).toEqual(first);
    const second = createReviewCard(env, accept(1));
    expect(second.id).not.toBe(first.id);
    expect(second.highlightId).toBe(first.highlightId);
    expect([count('highlights'), count('review_cards')]).toEqual([before[0]! + 1, before[1]! + 2]);
    expect(env.sqlite.prepare('SELECT page,startOffset,endOffset FROM highlights WHERE id=?').get(first.highlightId)).toEqual({ page, startOffset: pos.start, endOffset: pos.end });
    env.sqlite.prepare('UPDATE papers SET deletingAt=? WHERE id=?').run(Date.now(), paperId);
    expect(() => createReviewCard(env, accept(0))).toThrow();
  } finally { env.close(); }
});

it('locates long literal selections and distinguishes two occurrences using the PDF context', async () => {
  const env = await makeRunEnv({ adapter: new MockLlmAdapter() });
  try {
    const long = 'Robotics '.repeat(700).trim();
    const text = 'First repeat. Second repeat. ' + long;
    env.sqlite.prepare('UPDATE page_texts SET text=? WHERE paperId=? AND page=1').run(text, SEED_PAPER_ID);
    const position = (exact: string, prefix?: string) => reviewSelectionPosition(env.db, SEED_PAPER_ID, 1, { exact, prefix });
    expect(position('repeat.')).toBeNull();
    expect(position('repeat.', 'Second ')).toEqual({ page: 1, start: text.lastIndexOf('repeat.'), end: text.lastIndexOf('repeat.') + 7 });
    expect(position(long)).toEqual({ page: 1, start: text.indexOf(long), end: text.length });
    expect(position('Robotics never mentioned')).toBeNull();
  } finally { env.close(); }
});
