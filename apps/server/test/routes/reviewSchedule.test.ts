import { randomUUID } from 'node:crypto';
import { FSRSVersion } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewCardDto, ReviewQueueResponse, ReviewStatsResponse } from '@study-paper/shared/contracts/api';
import { SEED_M2_PAPER_ID, SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { startTestServer, type TestServer } from '../helpers/server';

let server: TestServer;
const now = Date.parse('2026-08-01T14:59:59.999Z');

beforeEach(async () => {
  server = await startTestServer({ env: 'test', papers: ['m1', 'm2'] });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(async () => { vi.useRealTimers(); await server.close(); });

async function request(path: string, body?: unknown) {
  const headers = { 'X-SP-Token': server.token, 'Content-Type': 'application/json' };
  return server.req('/api/review/' + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function create(paperId = SEED_PAPER_ID) {
  const r = await request('cards', { paperId, type: 'definition', frontMd: 'What does an estimate describe?', backMd: 'A quantity inferred from observations.' });
  expect(r.status).toBe(200);
  return ReviewCardDto.parse(JSON.parse(r.text));
}
const grade = (id: string, rating: 1 | 2 | 3 | 4 = 3, expectedReps = 0, clientRequestId = randomUUID()) =>
  request('cards/' + id + '/grade', { clientRequestId, expectedReps, rating });
const queue = async () => ReviewQueueResponse.parse(JSON.parse((await request('queue')).text));
const stats = async () => ReviewStatsResponse.parse(JSON.parse((await request('stats')).text));
const logs = (id: string) => server.deps.sqlite.prepare('SELECT state,rating,reviewedAt,fsrsLibVersion FROM review_logs WHERE cardId=?').all(id);

describe('review scheduling over HTTP', () => {
  it('previews and actual grades agree at the same time, and a retry or a stale request cannot grade twice', async () => {
    for (const rating of [1, 2, 3, 4] as const) {
      const card = await create();
      const row = (await queue()).cards.find(entry => entry.card.id === card.id);
      const preview = row?.preview.find(p => p.rating === rating);
      expect(preview).toBeDefined();
      const clientRequestId = randomUUID();
      const [first, retried] = await Promise.all([grade(card.id, rating, 0, clientRequestId), grade(card.id, rating, 0, clientRequestId)]);
      expect([first.status, retried.status]).toEqual([200, 200]);
      const updated = ReviewCardDto.parse(JSON.parse(first.text));
      expect(ReviewCardDto.parse(JSON.parse(retried.text))).toEqual(updated);
      expect(updated.fsrs).toMatchObject({ due: preview!.due, scheduledDays: preview!.scheduledDays, reps: 1 });
      expect((await grade(card.id, rating, 0)).status).toBe(409);
      expect(logs(card.id)).toEqual([{ state: 0, rating, reviewedAt: now, fsrsLibVersion: FSRSVersion }]);
    }
  });

  it('reserves up to 20 new cards per calendar day and resets at configured midnight', async () => {
    // Just before midnight in Seoul, still daytime in UTC.
    server.deps.config.timezone = 'Asia/Seoul';
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) ids.push((await create()).id);
    const first = await queue();
    expect(first.cards).toHaveLength(20);
    expect(first.newRemainingToday).toBe(20);
    expect(await stats()).toMatchObject({ newToday: 20, reviewedToday: 0, total: 21 });
    for (const { card } of first.cards) expect((await grade(card.id, 4)).status).toBe(200);
    expect(await queue()).toMatchObject({ cards: [], newRemainingToday: 0 });
    const remainingId = ids.find(id => !first.cards.some(({ card }) => card.id === id))!;
    expect((await grade(remainingId, 4)).status).toBe(409);
    expect(await stats()).toMatchObject({ newToday: 0, reviewedToday: 20, total: 21 });
    server.deps.config.timezone = 'UTC';
    vi.setSystemTime(now + 1);
    expect((await queue()).newRemainingToday).toBe(0);
    server.deps.config.timezone = 'Asia/Seoul';
    const next = await queue();
    expect(next.newRemainingToday).toBe(20);
    expect(next.cards.map(x => x.card.id)).toEqual([remainingId]);
    expect(await stats()).toMatchObject({ newToday: 1, reviewedToday: 0, total: 21 });
  });

  it('hides suspended cards and tombstoned papers even if every card is due', async () => {
    const visible = await create();
    const suspended = await create();
    const tombstoned = await create(SEED_M2_PAPER_ID);
    server.deps.sqlite.prepare('UPDATE review_cards SET suspended=1 WHERE id=?').run(suspended.id);
    server.deps.sqlite.prepare('UPDATE papers SET deletingAt=? WHERE id=?').run(now, SEED_M2_PAPER_ID);
    expect((await queue()).cards.map(row => row.card.id)).toEqual([visible.id]);
    expect(await stats()).toMatchObject({ newToday: 1, total: 1 });
    expect((await grade(suspended.id)).status).toBe(404);
    expect((await grade(tombstoned.id)).status).toBe(404);
    expect(logs(tombstoned.id)).toEqual([]);
  });
});
