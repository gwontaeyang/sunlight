// Glossary terms (PLAN_M2 3.4 rule 6, D9, D29, BRIEF_B B8): server-side matching of the definition, the duplicate 409
// with normalizeTerm, and the origin decision that checks the TERM and the DEFINITION against a usable suggestion
// (glossary_define → suggestionAvailable, explain / chat → that answer's <glossary>). Owner B.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlossaryTermDto } from '@study-paper/shared/contracts/api';
import { normalizeTerm } from '@study-paper/shared/contracts/domain';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { readMockFile, readMockManifest } from '@study-paper/shared/mock-outputs';
import { SEED_M2_PAPER_ID, SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { makeTestPngBase64 } from '../helpers/png';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';

const DAY = 86_400_000;
let s: TestServer;
let llm: ControlledAdapter;
afterEach(async () => {
  vi.useRealTimers();
  await s?.close();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; events: SseEvent[] }> {
  const r = await s.req(`/api${path}`, { method, headers: { 'X-SP-Token': s.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = String(r.headers['content-type'] ?? '');
  const events = type.includes('event-stream')
    ? r.text
        .split('\n\n')
        .filter((f) => f.trim())
        .map((f) => parseSseEvent(/^event: (.*)$/m.exec(f)![1]!, JSON.parse(/^data: (.*)$/m.exec(f)![1]!)))
    : [];
  return { status: r.status, json: type.includes('json') ? (JSON.parse(r.text) as unknown) : undefined, events };
}
const G = (paper = SEED_M2_PAPER_ID) => `/papers/${paper}/glossary`;
const create = async (body: Record<string, unknown>, paper = SEED_M2_PAPER_ID) => call('POST', G(paper), body);
const origin = async (body: Record<string, unknown>) => {
  const r = await create(body);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const t = r.json as GlossaryTermDto;
  await call('DELETE', `/glossary/${t.id}`); // free the term for the next case
  return t.origin;
};
/** A glossary_define run; returns its run id and the suggested definition (the <term> body). */
async function define(term: string, paper = SEED_M2_PAPER_ID): Promise<{ runId: string; definition: string }> {
  const r = await call('POST', `${G(paper)}/define`, { term, clientRequestId: randomUUID() });
  const a = r.events[0]!;
  const done = r.events.at(-1)!;
  if (a.event !== 'run.accepted' || done.event !== 'run.done') throw new Error(`define failed: ${JSON.stringify(r.events.at(-1))}`);
  return { runId: a.data.runId, definition: (done.data.parsed as unknown as { items: { body: string }[] }).items[0]!.body };
}
async function start(): Promise<void> {
  llm = new ControlledAdapter();
  s = await startTestServer({ env: 'prod', papers: ['m1', 'm2'], llm });
}

describe('glossary.create / patch: the server matches; duplicates are 409', () => {
  it('citations come from the server parse + match; changing the definition recomputes them in one transaction', async () => {
    await start();
    const r = await create({ term: 'robust kernel', definitionKo: '정의 <q>The robust kernel down-weights outliers in the residual.</q> [[P]]' });
    const t = r.json as GlossaryTermDto;
    expect(t.citations.map((c) => c.status)).toEqual(['verbatim']);
    expect(s.deps.sqlite.prepare(`SELECT termNorm FROM glossary_terms WHERE id = ?`).get(t.id)).toEqual({ termNorm: normalizeTerm('robust kernel') });
    const p = await call('PATCH', `/glossary/${t.id}`, { definitionKo: '바뀐 정의 <q>A sentence that is nowhere in the paper.</q> <eq n="1"/> [[P]]' });
    expect((p.json as GlossaryTermDto).citations.map((c) => [c.kind, c.status])).toEqual([
      ['quote', 'not_found'],
      ['equation', 'resolved'],
    ]);
    expect((s.deps.sqlite.prepare(`SELECT count(*) AS n FROM citations WHERE ownerType = 'glossary_term' AND ownerId = ?`).get(t.id) as { n: number }).n).toBe(2);
  });

  it('a term that differs only in case, width or spaces → 409 (create and patch)', async () => {
    await start();
    const a = (await create({ term: 'Robust Kernel' })).json as GlossaryTermDto;
    for (const term of ['robust kernel', 'ＲＯＢＵＳＴ   KERNEL', ' robust\tkernel ']) expect((await create({ term })).status, term).toBe(409);
    const b = (await create({ term: 'residual' })).json as GlossaryTermDto;
    expect((await call('PATCH', `/glossary/${b.id}`, { term: 'robust  KERNEL' })).status).toBe(409);
    expect((await call('PATCH', `/glossary/${a.id}`, { term: 'Robust kernel' })).status).toBe(200); // itself
  });
});

describe('origin: term AND definition against a usable suggestion', () => {
  it('glossary_define: as suggested → llm; edited → llm_edited; NFC / spaces only → llm; term equal under normalizeTerm → llm; another term → manual', async () => {
    await start();
    const { runId, definition } = await define('robust kernel');
    expect(await origin({ term: 'robust kernel', definitionKo: definition, llmCallId: runId })).toBe('llm');
    expect(await origin({ term: 'robust kernel', definitionKo: `${definition} 덧붙임.`, llmCallId: runId })).toBe('llm_edited');
    expect(await origin({ term: 'robust kernel', definitionKo: `  ${definition.replace(/ /g, '   ')}\n`, llmCallId: runId })).toBe('llm');
    expect(await origin({ term: 'Robust  KERNEL', definitionKo: definition, llmCallId: runId })).toBe('llm');
    expect(await origin({ term: 'residual', definitionKo: definition, llmCallId: runId })).toBe('manual');
    expect(await origin({ term: 'robust kernel', definitionKo: definition })).toBe('manual');
  });

  it('another paper, a failed run, a task outside the three → manual', async () => {
    await start();
    const other = await define('robust kernel', SEED_PAPER_ID);
    expect(await origin({ term: 'robust kernel', definitionKo: other.definition, llmCallId: other.runId })).toBe('manual');
    // a failed run: the wrong term twice → one repair, then parse_failed. With repairMinRemainingMs(glossary_define)
    // = 60 s (S-1, review B-R3-01) the repair is reached on the real clock; both queued outputs are taken, nothing is
    // left to leak into the card run below (review B-R3-02). The repaired define is covered in runManager.repair.test.ts.
    const wrong = readMockFile(readMockManifest().m2.blocksInvalid.glossary_wrong_name!.file);
    llm.queueOutputs(wrong, wrong);
    const callsBefore = llm.calls.length;
    const failed = await call('POST', `${G()}/define`, { term: 'robust kernel', clientRequestId: randomUUID() });
    expect(failed.events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'parse_failed' } });
    expect(llm.calls.slice(callsBefore).map((c) => c.task)).toEqual(['glossary_define', 'glossary_define']);
    expect(failed.events.filter((e) => e.event === 'run.retrying')).toHaveLength(1);
    expect(llm.clearOutputs()).toBe(0);
    expect(llm.pendingOutputs).toBe(0);
    const failedRun = (failed.events[0]!.data as { runId: string }).runId;
    expect(await origin({ term: 'robust kernel', definitionKo: '큰 잔차의 가중치를 줄이는 손실 함수', llmCallId: failedRun })).toBe('manual');
    // a successful notation card run with the same term / definition: one call, the mock card, no repair
    const cardCallsBefore = llm.calls.length;
    const card = await call('POST', `/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, { clientRequestId: randomUUID() });
    expect(card.events.at(-1)!.event).toBe('run.done');
    expect(card.events.filter((e) => e.event === 'run.retrying')).toHaveLength(0);
    expect(llm.calls.slice(cardCallsBefore).map((c) => c.task)).toEqual(['notation_card']);
    const cardRun = (card.events[0]!.data as { runId: string }).runId;
    expect(await origin({ term: 'robust kernel', definitionKo: '큰 잔차의 가중치를 줄이는 손실 함수', llmCallId: cardRun })).toBe('manual');
    // a figure_area answer that carries a <glossary> with the same term (+ sourceMessageId)
    llm.queueOutputs('그림 설명 [[N]]\n\n<glossary><term name="robust kernel">큰 잔차의 가중치를 줄이는 손실 함수</term></glossary>');
    const fig = await call('POST', `/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'figure', anchor: { kind: 'area', rects: [{ page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.3 }] }, imagePng: makeTestPngBase64({ width: 30, height: 30 }), clientRequestId: randomUUID() });
    const fa = fig.events[0]!.data as { runId: string; messageId: string };
    expect(await origin({ term: 'robust kernel', definitionKo: '큰 잔차의 가중치를 줄이는 손실 함수', llmCallId: fa.runId, sourceMessageId: fa.messageId })).toBe('manual');
  });

  it('explain / chat answers: the <glossary> entry with the same term → llm; a term that answer does not suggest → manual', async () => {
    await start();
    const ex = await call('POST', `/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'explain', text: 'robust kernel', clientRequestId: randomUUID() });
    const a = ex.events[0]!.data as { runId: string; messageId: string };
    expect(await origin({ term: 'robust kernel', definitionKo: '큰 잔차의 가중치를 줄이는 손실 함수', llmCallId: a.runId, sourceMessageId: a.messageId })).toBe('llm');
    expect(await origin({ term: 'robust kernel', definitionKo: '고친 정의', llmCallId: a.runId })).toBe('llm_edited');
    expect(await origin({ term: 'residual', definitionKo: '큰 잔차의 가중치를 줄이는 손실 함수', llmCallId: a.runId })).toBe('manual');
  });

  it('the 30-day boundary is decided at use time (Date faked, no restart, resultRaw still in the DB)', async () => {
    await start();
    const { runId, definition } = await define('robust kernel');
    const finishedAt = (s.deps.sqlite.prepare(`SELECT finishedAt AS f FROM llm_calls WHERE runId = ?`).get(runId) as { f: number }).f;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(finishedAt + 30 * DAY - 1);
    expect(await origin({ term: 'robust kernel', definitionKo: definition, llmCallId: runId })).toBe('llm');
    for (const t of [finishedAt + 30 * DAY, finishedAt + 30 * DAY + 1]) {
      vi.setSystemTime(t);
      expect(await origin({ term: 'robust kernel', definitionKo: definition, llmCallId: runId })).toBe('manual');
    }
    expect(s.deps.sqlite.prepare(`SELECT resultRaw IS NOT NULL AS kept FROM llm_calls WHERE runId = ?`).get(runId)).toEqual({ kept: 1 });
  });

  it('the decision reads the STORED output: another definition there → llm_edited, another term there → manual', async () => {
    await start();
    const { runId, definition } = await define('robust kernel');
    s.deps.sqlite.prepare(`UPDATE llm_calls SET resultRaw = ? WHERE runId = ?`).run('<term name="robust kernel">다른 정의.</term>', runId);
    expect(await origin({ term: 'robust kernel', definitionKo: definition, llmCallId: runId })).toBe('llm_edited');
    s.deps.sqlite.prepare(`UPDATE llm_calls SET resultRaw = ? WHERE runId = ?`).run(`<term name="residual">${definition}</term>`, runId);
    expect(await origin({ term: 'robust kernel', definitionKo: definition, llmCallId: runId })).toBe('manual');
  });

  it('patch: the definition only → llm becomes llm_edited; a new term → manual', async () => {
    await start();
    const { runId, definition } = await define('robust kernel');
    const t = (await create({ term: 'robust kernel', definitionKo: definition, llmCallId: runId })).json as GlossaryTermDto;
    expect(t.origin).toBe('llm');
    expect(((await call('PATCH', `/glossary/${t.id}`, { definitionKo: `${definition} 수정.` })).json as GlossaryTermDto).origin).toBe('llm_edited');
    expect(((await call('PATCH', `/glossary/${t.id}`, { term: 'kernel' })).json as GlossaryTermDto).origin).toBe('manual');
  });
});

describe('glossary.create: the source message link (review B-R1-09)', () => {
  const sourceOf = (id: string) => (s.deps.sqlite.prepare(`SELECT sourceMessageId AS m FROM glossary_terms WHERE id = ?`).get(id) as { m: string | null }).m;
  it("kept only for a message of this paper — and for an AI origin only for the run's own assistant message", async () => {
    await start();
    const ex = await call('POST', `/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'explain', text: 'robust kernel', clientRequestId: randomUUID() });
    const a = ex.events[0]!.data as { runId: string; messageId: string };
    const other = await call('POST', `/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text: 'robust kernel', clientRequestId: randomUUID() });
    const o = other.events[0]!.data as { runId: string; messageId: string };
    const userMsg = (s.deps.sqlite.prepare(`SELECT id FROM messages WHERE threadId = (SELECT threadId FROM messages WHERE id = ?) AND role = 'user'`).get(a.messageId) as { id: string }).id;
    const def = '큰 잔차의 가중치를 줄이는 손실 함수';
    const make = async (body: Record<string, unknown>) => {
      const r = await create(body);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const t = r.json as GlossaryTermDto;
      const out = { origin: t.origin, source: sourceOf(t.id) };
      await call('DELETE', `/glossary/${t.id}`);
      return out;
    };
    // the run's own answer → AI origin, link kept
    expect(await make({ term: 'robust kernel', definitionKo: def, llmCallId: a.runId, sourceMessageId: a.messageId })).toEqual({ origin: 'llm', source: a.messageId });
    // another paper's message: never stored (manual, and with this paper's AI run)
    expect(await make({ term: 'robust kernel', definitionKo: def, sourceMessageId: o.messageId })).toEqual({ origin: 'manual', source: null });
    expect(await make({ term: 'robust kernel', definitionKo: def, llmCallId: a.runId, sourceMessageId: o.messageId })).toEqual({ origin: 'manual', source: null });
    // a manual term may link a message of this paper
    expect(await make({ term: 'robust kernel', definitionKo: def, sourceMessageId: userMsg })).toEqual({ origin: 'manual', source: userMsg });
    // an AI-origin term from a glossary_define run: a message is not that run's answer → no link
    const d = await define('robust kernel');
    expect(await make({ term: 'robust kernel', definitionKo: d.definition, llmCallId: d.runId, sourceMessageId: a.messageId })).toEqual({ origin: 'llm', source: null });
    // a message id that does not exist
    expect(await make({ term: 'robust kernel', definitionKo: def, sourceMessageId: randomUUID() })).toEqual({ origin: 'manual', source: null });
  });
});

describe('glossary.define: a term that cannot be a <term name> is a 400 before any run (review B-R1-04)', () => {
  it('" < > or a control character → 400 validation, no llm_calls row, no adapter call; whitespace inside is fine', async () => {
    await start();
    for (const term of ['say "hi"', 'a<b', 'x>y', 'bell\u0007']) {
      const r = await call('POST', `${G()}/define`, { term, clientRequestId: randomUUID() });
      expect(r.status, term).toBe(400);
      expect((r.json as { error: { code: string } }).error.code).toBe('validation');
    }
    expect((s.deps.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls WHERE task = 'glossary_define'`).get() as { n: number }).n).toBe(0);
    expect(llm.calls).toHaveLength(0);
    // a newline or tab in the term: normalizeTerm collapses it, so the answer can validate
    const ok = await call('POST', `${G()}/define`, { term: 'robust\n\tkernel', clientRequestId: randomUUID() });
    expect(ok.events.at(-1)?.event).toBe('run.done');
  });
});
