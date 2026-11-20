// threads / messages routes beyond the contract cases: request content (selection context, history), regenerate,
// busy threads, deletion during a run, disconnects. Owner B.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeN1 } from '@study-paper/shared/anchor/normalize';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { CreateThreadRequest } from '@study-paper/shared/contracts/api';
import type { LlmErrorCode } from '@study-paper/shared/contracts/tasks';
import type { LlmAdapter, LlmEvent, LlmRunRequest } from '../../src/llm/adapter';
import { createIdentity } from '../../src/routes/threads';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { startTestServer, type TestServer } from '../helpers/server';
import { waitFor } from '../helpers/proc';

class RecordingAdapter implements LlmAdapter {
  readonly mode = 'mock' as const;
  readonly requests: LlmRunRequest[] = [];
  /** When set, the next run streams some text and then ends with this error (and the switch resets). */
  failNext: LlmErrorCode | null = null;
  constructor(readonly inner: MockLlmAdapter) {}
  run(req: LlmRunRequest) {
    this.requests.push(req);
    const code = this.failNext;
    this.failNext = null;
    if (code) {
      return (async function* (): AsyncGenerator<LlmEvent> {
        yield { type: 'started', modelResolved: 'mock-fail', cliVersion: 'mock' };
        yield { type: 'text', delta: 'PARTIAL-NEW ' };
        yield { type: 'error', code, message: code, retryable: false, partialText: 'PARTIAL-NEW ' };
      })();
    }
    return this.inner.run(req);
  }
  health() {
    return this.inner.health();
  }
}
const taskText = (r: LlmRunRequest) => {
  const last = r.tail.at(-1)!;
  if (last.type !== 'text') throw new Error('last block is not text');
  return last.text;
};

let s: TestServer;
let llm: RecordingAdapter;
let slow: { delay: number };
beforeAll(async () => {
  slow = { delay: 0 };
  // chunk delay switchable per test
  llm = new RecordingAdapter(
    new MockLlmAdapter({
      get chunkDelayMs() {
        return slow.delay;
      },
    }),
  );
  s = await startTestServer({ env: 'prod', seed: true, llm });
});
afterAll(async () => {
  await s.close();
});

const json = { 'Content-Type': 'application/json' };
const parse = (text: string): SseEvent[] =>
  text
    .split('\n\n')
    .filter((f) => f.trim())
    .map((f) => parseSseEvent(/^event: (.*)$/m.exec(f)![1]!, JSON.parse(/^data: (.*)$/m.exec(f)![1]!)));
const post = async (path: string, body: unknown) => {
  const r = await s.req(`/api${path}`, { method: 'POST', headers: { 'X-SP-Token': s.token, ...json }, body: JSON.stringify(body) });
  return { status: r.status, text: r.text, events: r.headers['content-type']?.includes('event-stream') ? parse(r.text) : [] };
};
const accepted = (ev: SseEvent[]) => {
  const e = ev[0]!;
  if (e.event !== 'run.accepted') throw new Error(`first event ${e.event}`);
  return e.data;
};
const q = <T>(sql: string, ...a: unknown[]) => s.deps.sqlite.prepare(sql).all(...a) as T[];
const uuid = () => crypto.randomUUID();

/** Streams with fetch so the connection can be aborted; resolves when the stream ends or is aborted. */
function openStream(path: string, body: unknown, signal: AbortSignal, onEvent: (e: SseEvent) => void): Promise<void> {
  return (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api${path}`, { method: 'POST', headers: { 'X-SP-Token': s.token, ...json }, body: JSON.stringify(body), signal });
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          onEvent(parse(buf.slice(0, i + 2))[0]!);
          buf = buf.slice(i + 2);
        }
      }
    } catch {
      /* aborted */
    }
  })();
}

describe('threads.create', () => {
  it('explain with an anchor: selection page, section and ±300 chars of context reach the task; quoteHash = sha256(N1(quote))', async () => {
    const exact = 'The data association uses a fixed threshold of 0.5 m and a robust kernel.';
    const page = (q<{ page: number }>(`SELECT page FROM page_texts WHERE paperId = ? AND text LIKE ?`, SEED_PAPER_ID, '%fixed threshold%')[0]!).page;
    const r = await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', anchor: { kind: 'text', quote: { exact }, rects: [{ page, x: 0.1, y: 0.1, w: 0.5, h: 0.02 }] }, question: '왜 0.5 m?', clientRequestId: uuid() });
    expect(r.events.at(-1)!.event).toBe('run.done');
    const t = taskText(llm.requests.at(-1)!);
    expect(t).toContain(`<selection trust="paper" page="${page}" section="`);
    expect(t).toMatch(/<context_before trust="paper">[^<]+<\/context_before>/);
    expect(t).toMatch(/<context_after trust="paper">[^<]*<\/context_after>|<\/selection>/);
    expect(t).toContain('<question trust="user">왜 0.5 m?</question>');
    const a = accepted(r.events);
    const th = q<{ quoteHash: string; title: string }>(`SELECT quoteHash, title FROM threads WHERE id = ?`, a.threadId)[0]!;
    expect(th.quoteHash).toBe(createHash('sha256').update(normalizeN1(exact).text).digest('hex'));
    expect(th.title).toBe('왜 0.5 m?');
    // the explain answer's quotes were matched starting at the selection's page (all verbatim on the seed)
    const done = r.events.at(-1)! as Extract<SseEvent, { event: 'run.done' }>;
    expect(done.data.citations.filter((c) => c.kind === 'quote').every((c) => c.status === 'verbatim')).toBe(true);
  });

  it('the thread exposes a text anchor even when only `text` was sent (web re-opens by anchor.quote.exact)', async () => {
    const a = accepted((await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text: 'robust kernel', clientRequestId: uuid() })).events);
    const d = JSON.parse((await s.req(`/api/threads/${a.threadId}`, { headers: { 'X-SP-Token': s.token } })).text) as { thread: { anchor: { kind: string; quote: { exact: string } } } };
    expect(d.thread.anchor).toEqual({ kind: 'text', quote: { exact: 'robust kernel' }, rects: [] });
  });
});

describe('messages.create', () => {
  it('a follow-up carries the thread history (escaped, user vs model trust) and the original selection', async () => {
    const a = accepted((await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text: 'We estimate the robot pose', clientRequestId: uuid() })).events);
    const r = await post(`/threads/${a.threadId}/messages`, { text: '속도는?', clientRequestId: uuid() });
    expect(r.events.at(-1)!.event).toBe('run.done');
    const req = llm.requests.at(-1)!;
    expect(req.task).toBe('chat');
    const t = taskText(req);
    // M2 (review B-F3R1-02): the question-less first message is the selection — it goes as <selection trust="paper">,
    // not as a user turn; the user's own follow-up is a user turn on the next request
    expect(t).not.toContain('<turn role="user" trust="user">We estimate the robot pose</turn>');
    expect(t).toMatch(/<turn role="assistant" trust="model">[^<]*&lt;q&gt;/);
    expect(t).toContain('<selection trust="paper">We estimate the robot pose</selection>');
    expect(t).toContain('<question trust="user">속도는?</question>');
    expect(req.prefix).toHaveLength(2); // paper context
    await post(`/threads/${a.threadId}/messages`, { text: '정확도는?', clientRequestId: uuid() });
    const t2 = taskText(llm.requests.at(-1)!);
    expect(t2).toContain('<turn role="user" trust="user">속도는?</turn>');
    expect(t2).toMatch(/<turn role="assistant" trust="model">[^<]*&lt;q&gt;/);
    expect(t2).toContain('<selection trust="paper">We estimate the robot pose</selection>');
  });

  it('history keeps only the most recent ≈ 24,000 chars of complete messages', async () => {
    const a = accepted((await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'start', clientRequestId: uuid() })).events);
    const ins = s.deps.sqlite.prepare(`INSERT INTO messages (id, threadId, role, contentMd, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 12; i++) ins.run(uuid(), a.threadId, i % 2 ? 'assistant' : 'user', `turn${i} `.padEnd(4000, 'x'), 'complete', Date.now() + 10 + i);
    ins.run(uuid(), a.threadId, 'assistant', 'FAILED-ANSWER', 'error', Date.now() + 30);
    await post(`/threads/${a.threadId}/messages`, { text: 'next', clientRequestId: uuid() });
    const t = taskText(llm.requests.at(-1)!);
    const hist = /<history>\n(<turn[\s\S]*?)<\/history>/.exec(t)![1]!;
    expect(hist).toContain('turn11 ');
    expect(hist).not.toContain('turn5 ');
    expect(hist).not.toContain('FAILED-ANSWER');
    expect(hist.replace(/<[^>]+>/g, '').length).toBeLessThanOrEqual(24_000 + 20);
  });

  it('regenerate: the only turn of an explain thread is explained again; the old answer and its citations are gone', async () => {
    const a = accepted((await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text: 'We estimate the robot pose', clientRequestId: uuid() })).events);
    expect(q(`SELECT id FROM citations WHERE ownerId = ?`, a.messageId).length).toBeGreaterThan(0);
    const r = await post(`/threads/${a.threadId}/messages`, { text: 'We estimate the robot pose', regenerate: true, clientRequestId: uuid() });
    expect(r.events.at(-1)!.event).toBe('run.done');
    expect(llm.requests.at(-1)!.task).toBe('explain_selection');
    expect(q(`SELECT id FROM messages WHERE id = ?`, a.messageId)).toEqual([]);
    expect(q(`SELECT id FROM citations WHERE ownerId = ?`, a.messageId)).toEqual([]);
    expect(q<{ role: string; status: string }>(`SELECT role, status FROM messages WHERE threadId = ? ORDER BY createdAt`, a.threadId)).toEqual([
      { role: 'user', status: 'complete' },
      { role: 'assistant', status: 'complete' },
    ]);
  });

  it('regenerate of a later turn is a chat turn whose history excludes the replaced turn', async () => {
    const a = accepted((await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text: 'robust kernel', clientRequestId: uuid() })).events);
    await post(`/threads/${a.threadId}/messages`, { text: 'FIRST-FOLLOWUP', clientRequestId: uuid() });
    await post(`/threads/${a.threadId}/messages`, { text: 'FIRST-FOLLOWUP again', regenerate: true, clientRequestId: uuid() });
    const req = llm.requests.at(-1)!;
    expect(req.task).toBe('chat');
    expect(taskText(req)).not.toContain('<turn role="user" trust="user">FIRST-FOLLOWUP</turn>');
    expect(q(`SELECT id FROM messages WHERE threadId = ?`, a.threadId)).toHaveLength(4);
  });

  it('a new question while a reply streams → 409; a retry of the streaming request attaches instead', async () => {
    slow.delay = 30;
    try {
      const ac = new AbortController();
      const crid = uuid();
      const evs: SseEvent[] = [];
      const first = await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'q1', clientRequestId: uuid() });
      const threadId = accepted(first.events).threadId!;
      const streaming = openStream(`/threads/${threadId}/messages`, { text: 'q2', clientRequestId: crid }, ac.signal, (e) => evs.push(e));
      await waitFor(() => evs.some((e) => e.event === 'run.delta'), 'delta');
      const busy = await post(`/threads/${threadId}/messages`, { text: 'q3', clientRequestId: uuid() });
      expect(busy.status).toBe(409);
      expect(JSON.parse(busy.text)).toMatchObject({ error: { code: 'conflict' } });
      const retry = await post(`/threads/${threadId}/messages`, { text: 'q2', clientRequestId: crid });
      expect(retry.status).toBe(200);
      expect(accepted(retry.events)).toEqual(accepted(evs));
      expect(retry.events.at(-1)!.event).toBe('run.done');
      await streaming;
    } finally {
      slow.delay = 0;
    }
  });
});

describe('runs and connections', () => {
  it('deleting the thread during a run cancels it; nothing of the thread remains', async () => {
    slow.delay = 30;
    try {
      const evs: SseEvent[] = [];
      const stream = openStream(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'long', clientRequestId: uuid() }, new AbortController().signal, (e) => evs.push(e));
      await waitFor(() => evs.some((e) => e.event === 'run.delta'), 'delta');
      const a = accepted(evs);
      expect((await s.req(`/api/threads/${a.threadId}`, { method: 'DELETE', headers: { 'X-SP-Token': s.token } })).status).toBe(204);
      await stream;
      await s.deps.runs.get(a.runId)!.done;
      expect(evs.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
      expect(q(`SELECT id FROM messages WHERE threadId = ?`, a.threadId)).toEqual([]);
      expect(q(`SELECT status, threadId FROM llm_calls WHERE runId = ?`, a.runId)).toEqual([{ status: 'cancelled', threadId: null }]);
    } finally {
      slow.delay = 0;
    }
  });

  it('a dropped connection cancels an interactive run — unless another stream still follows it', async () => {
    slow.delay = 30;
    try {
      // one follower: dropped → cancelled
      const ac = new AbortController();
      const evs: SseEvent[] = [];
      const st = openStream(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'drop me', clientRequestId: uuid() }, ac.signal, (e) => evs.push(e));
      await waitFor(() => evs.some((e) => e.event === 'run.delta'), 'delta');
      ac.abort();
      await st;
      const runId = accepted(evs).runId;
      await s.deps.runs.get(runId)!.done;
      expect(q(`SELECT status FROM llm_calls WHERE runId = ?`, runId)).toEqual([{ status: 'cancelled' }]);

      // two followers (a retry attached): dropping the first does not cancel the run
      const crid = uuid();
      const ac1 = new AbortController();
      const e1: SseEvent[] = [];
      const e2: SseEvent[] = [];
      const body = { kind: 'chat', question: 'keep me', clientRequestId: crid };
      const s1 = openStream(`/papers/${SEED_PAPER_ID}/threads`, body, ac1.signal, (e) => e1.push(e));
      await waitFor(() => e1.some((e) => e.event === 'run.delta'), 'delta 1');
      const s2 = openStream(`/papers/${SEED_PAPER_ID}/threads`, body, new AbortController().signal, (e) => e2.push(e));
      await waitFor(() => e2.length > 0, 'second stream');
      ac1.abort();
      await s1;
      await s2;
      expect(e2.at(-1)!.event).toBe('run.done');
      expect(q(`SELECT status FROM llm_calls WHERE clientRequestId = ?`, crid)).toEqual([{ status: 'ok' }]);
    } finally {
      slow.delay = 0;
    }
  });

  it('llm.runs.cancel on a queued or running run → 204 and the run ends cancelled', async () => {
    slow.delay = 30;
    try {
      const evs: SseEvent[] = [];
      const st = openStream(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'cancel me', clientRequestId: uuid() }, new AbortController().signal, (e) => evs.push(e));
      await waitFor(() => evs.some((e) => e.event === 'run.delta'), 'delta');
      const { runId } = accepted(evs);
      expect((await post(`/llm/runs/${runId}/cancel`, {})).status).toBe(204);
      await st;
      expect(evs.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled', partialText: expect.any(String) } });
      const run = JSON.parse((await s.req(`/api/llm/runs/${runId}`, { headers: { 'X-SP-Token': s.token } })).text) as { status: string; errorCode: string };
      expect(run).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });
    } finally {
      slow.delay = 0;
    }
  });
});

describe('M3: clientRequestId payload identity through the HTTP route', () => {
  const page = 1;
  const anchor = { kind: 'text', quote: { exact: 'robust kernel', prefix: 'and a ', suffix: '.' }, position: { page, start: 10, end: 23 }, rects: [{ page, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }] };
  const create = (body: Record<string, unknown>) => post(`/papers/${SEED_PAPER_ID}/threads`, body);

  it.each([
    ['position', { ...anchor, position: { page, start: 40, end: 53 } }],
    ['prefix', { ...anchor, quote: { ...anchor.quote, prefix: 'with a ' } }],
    ['suffix', { ...anchor, quote: { ...anchor.quote, suffix: ',' } }],
    ['rects', { ...anchor, rects: [{ page, x: 0.1, y: 0.6, w: 0.3, h: 0.02 }] }],
    ['no anchor (text only)', undefined],
  ])('same id + an anchor that differs in %s → 409, nothing new stored', async (_name, other) => {
    const crid = uuid();
    const first = await create({ kind: 'explain', anchor, text: 'robust kernel', clientRequestId: crid });
    expect(first.events.at(-1)!.event).toBe('run.done');
    const threads = q(`SELECT id FROM threads`).length;
    const r = await create({ kind: 'explain', ...(other ? { anchor: other } : {}), text: 'robust kernel', clientRequestId: crid });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.text)).toMatchObject({ error: { code: 'conflict' } });
    expect(q(`SELECT id FROM threads`)).toHaveLength(threads);
  });

  it('same id + the same anchor with its keys in another order → attaches to the same run', async () => {
    const crid = uuid();
    const a = accepted((await create({ kind: 'explain', anchor, clientRequestId: crid })).events);
    const reordered = { rects: anchor.rects.map((r) => ({ h: r.h, w: r.w, y: r.y, x: r.x, page: r.page })), position: { end: 23, start: 10, page }, quote: { suffix: '.', prefix: 'and a ', exact: 'robust kernel' }, kind: 'text' };
    const again = await create({ clientRequestId: crid, anchor: reordered, kind: 'explain' });
    expect(again.status).toBe(200);
    expect(accepted(again.events)).toEqual(a);
  });

  it('same id + another kind (explain vs chat with the same text and question) → 409', async () => {
    const crid = uuid();
    await create({ kind: 'explain', text: 'robust kernel', question: '왜?', clientRequestId: crid });
    const r = await create({ kind: 'chat', text: 'robust kernel', question: '왜?', clientRequestId: crid });
    expect(r.status).toBe(409);
  });

  it('fields the M1 kinds do not use are refused (400), not silently ignored', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    expect((await create({ kind: 'explain', text: 'robust kernel', imagePng: png, clientRequestId: uuid() })).status).toBe(400);
    expect((await create({ kind: 'explain', text: 'robust kernel', equationId: uuid(), clientRequestId: uuid() })).status).toBe(400);
  });

  it('messages.create: same id + another regenerate flag → 409; regenerate false and absent are the same request', async () => {
    const a = accepted((await create({ kind: 'chat', question: 'start', clientRequestId: uuid() })).events);
    const crid = uuid();
    const first = await post(`/threads/${a.threadId}/messages`, { text: 'next', clientRequestId: crid });
    expect(first.events.at(-1)!.event).toBe('run.done');
    expect((await post(`/threads/${a.threadId}/messages`, { text: 'next', regenerate: true, clientRequestId: crid })).status).toBe(409);
    const same = await post(`/threads/${a.threadId}/messages`, { text: 'next', regenerate: false, clientRequestId: crid });
    expect(same.status).toBe(200);
    expect(accepted(same.events)).toEqual(accepted(first.events));
  });

  it('createIdentity covers every CreateThreadRequest field except clientRequestId', () => {
    const base = { kind: 'explain' as const, anchor: { kind: 'text' as const, quote: { exact: 'x' }, rects: [] }, text: 't', question: 'q', imagePng: 'AAAA', equationId: uuid() };
    const h = JSON.stringify(createIdentity(SEED_PAPER_ID, base, base.question));
    const changed: Record<string, unknown> = { kind: 'chat', anchor: { ...base.anchor, quote: { exact: 'y' } }, text: 't2', question: 'q2', imagePng: 'BBBB', equationId: uuid(), deep: true };
    const fields = Object.keys(CreateThreadRequest.shape).filter((k) => k !== 'clientRequestId');
    expect(fields.sort()).toEqual(Object.keys(changed).sort()); // a new request field must be added to the identity
    for (const k of fields) {
      const body = { ...base, [k]: changed[k] } as typeof base;
      expect(JSON.stringify(createIdentity(SEED_PAPER_ID, body, body.question)), k).not.toBe(h);
    }
  });
});

describe('M4: regenerate keeps the old answer until the new one is stored (HTTP)', () => {
  const turn = (threadId: string) => q<{ id: string; role: string; status: string; contentMd: string }>(`SELECT id, role, status, contentMd FROM messages WHERE threadId = ? ORDER BY createdAt, rowid`, threadId);
  const getThread = async (id: string) => JSON.parse((await s.req(`/api/threads/${id}`, { headers: { 'X-SP-Token': s.token } })).text) as { messages: { id: string; status: string; citations: unknown[] }[] };
  async function explained() {
    const crid = uuid();
    const r = await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text: 'We estimate the robot pose', clientRequestId: crid });
    const a = accepted(r.events);
    const before = turn(a.threadId!);
    const cites = (await getThread(a.threadId!)).messages[1]!.citations;
    expect(cites.length).toBeGreaterThan(0);
    return { a, crid, before, cites, done: r.events.at(-1)! };
  }
  /** The thread is exactly as before, citations included, and the original request still replays its answer. */
  async function expectUnchanged(t: Awaited<ReturnType<typeof explained>>) {
    expect(turn(t.a.threadId!)).toEqual(t.before);
    expect((await getThread(t.a.threadId!)).messages[1]!.citations).toEqual(t.cites);
    const replay = await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text: 'We estimate the robot pose', clientRequestId: t.crid });
    expect(replay.events.at(-1)).toEqual(t.done);
  }

  it('success: while the new answer streams both turns are listed (old one complete); a retry attaches', async () => {
    const t = await explained();
    slow.delay = 30;
    try {
      const evs: SseEvent[] = [];
      const crid = uuid();
      const body = { text: 'We estimate the robot pose', regenerate: true, clientRequestId: crid };
      const st = openStream(`/threads/${t.a.threadId}/messages`, body, new AbortController().signal, (e) => evs.push(e));
      await waitFor(() => evs.some((e) => e.event === 'run.delta'), 'delta');
      const during = (await getThread(t.a.threadId!)).messages;
      expect(during.map((m) => m.status)).toEqual(['complete', 'complete', 'complete', 'streaming']);
      expect(during[1]!.citations).toEqual(t.cites);
      const retry = await post(`/threads/${t.a.threadId}/messages`, body);
      expect(accepted(retry.events)).toEqual(accepted(evs));
      await st;
      expect(evs.at(-1)!.event).toBe('run.done');
      expect(turn(t.a.threadId!).map((m) => m.id)).toEqual(during.slice(2).map((m) => m.id));
      expect(q(`SELECT id FROM citations WHERE ownerId = ?`, t.a.messageId)).toEqual([]);
    } finally {
      slow.delay = 0;
    }
  });

  it('failure (rate_limited): one run.error with the partial text; the old turn stays and replays', async () => {
    const t = await explained();
    llm.failNext = 'rate_limited';
    const r = await post(`/threads/${t.a.threadId}/messages`, { text: 'We estimate the robot pose', regenerate: true, clientRequestId: uuid() });
    expect(r.events.filter((e) => e.event === 'run.done' || e.event === 'run.error')).toHaveLength(1);
    expect(r.events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'rate_limited', partialText: 'PARTIAL-NEW ' } });
    await expectUnchanged(t);
  });

  it('cancel: the old turn stays and replays', async () => {
    const t = await explained();
    slow.delay = 30;
    try {
      const evs: SseEvent[] = [];
      const st = openStream(`/threads/${t.a.threadId}/messages`, { text: 'We estimate the robot pose', regenerate: true, clientRequestId: uuid() }, new AbortController().signal, (e) => evs.push(e));
      await waitFor(() => evs.some((e) => e.event === 'run.delta'), 'delta');
      expect((await post(`/llm/runs/${accepted(evs).runId}/cancel`, {})).status).toBe(204);
      await st;
      expect(evs.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
    } finally {
      slow.delay = 0;
    }
    await expectUnchanged(t);
  });

  it('a failed result transaction (B3): one persist_failed, never run.done; the old turn stays', async () => {
    const t = await explained();
    s.deps.sqlite.exec(`CREATE TEMP TRIGGER fail_citations BEFORE INSERT ON citations BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    try {
      const r = await post(`/threads/${t.a.threadId}/messages`, { text: 'We estimate the robot pose', regenerate: true, clientRequestId: uuid() });
      expect(r.events.filter((e) => e.event === 'run.done' || e.event === 'run.error')).toHaveLength(1);
      expect(r.events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'persist_failed' } });
      // A new thread under the same fault: the message ends `error` with the unsaved answer, llm_calls error.
      const n = await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'explain', text: 'robust kernel', clientRequestId: uuid() });
      expect(n.events.some((e) => e.event === 'run.done')).toBe(false);
      const na = accepted(n.events);
      expect(q(`SELECT status, errorCode FROM llm_calls WHERE runId = ?`, na.runId)).toEqual([{ status: 'error', errorCode: 'persist_failed' }]);
      expect(q<{ status: string; contentMd: string }>(`SELECT status, contentMd FROM messages WHERE id = ?`, na.messageId)[0]).toMatchObject({ status: 'error', contentMd: expect.stringMatching(/\S/) });
    } finally {
      s.deps.sqlite.exec(`DROP TRIGGER fail_citations`);
    }
    await expectUnchanged(t);
  });
});

describe('N4 / n2: replays after a regenerate and rows from older versions (HTTP)', () => {
  const sha = (x: string) => createHash('sha256').update(x).digest('hex');
  /** The M1 (v1) payload hash, copied from 17c55e9 — what an M1 server stored in llm_calls.payloadHash. */
  const m1Hash = (o: { task: string; paperId: string; threadId?: string; inputs: Record<string, string | undefined> }) =>
    sha(JSON.stringify({ task: o.task, paperId: o.paperId, threadId: o.threadId ?? null, inputs: Object.entries(o.inputs).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), image: null }));
  const counts = () => q<{ t: number; c: number }>(`SELECT (SELECT count(*) FROM threads) AS t, (SELECT count(*) FROM llm_calls) AS c`)[0]!;

  it('N4: after a successful regenerate the old id replays run.error superseded and llm.runs.get says so; the new id replays the new answer', async () => {
    const crid = uuid();
    const body = { kind: 'explain', text: 'We estimate the robot pose', clientRequestId: crid };
    const a = accepted((await post(`/papers/${SEED_PAPER_ID}/threads`, body)).events);
    const regenBody = { text: 'We estimate the robot pose', regenerate: true, clientRequestId: uuid() };
    const regen = await post(`/threads/${a.threadId}/messages`, regenBody);
    expect(regen.events.at(-1)!.event).toBe('run.done');
    const old = await post(`/papers/${SEED_PAPER_ID}/threads`, body);
    expect(old.events.map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
    expect(old.events[1]).toMatchObject({ data: { code: 'superseded', retryable: false } });
    const run = JSON.parse((await s.req(`/api/llm/runs/${a.runId}`, { headers: { 'X-SP-Token': s.token } })).text) as { status: string; errorCode: string };
    expect(run).toMatchObject({ status: 'ok', errorCode: 'superseded' });
    expect((await post(`/threads/${a.threadId}/messages`, regenBody)).events.at(-1)).toEqual(regen.events.at(-1));
  });

  /** Rows as an older server left them (thread, both messages, a finished llm_calls row) — never in this process's memory. */
  function oldServerRows(o: { crid: string; payloadHash: string; kind: 'explain' | 'chat'; selection?: string; question?: string; answer: string; threadId?: string }) {
    const now = Date.now();
    const threadId = o.threadId ?? uuid();
    const runId = uuid();
    const assistantId = uuid();
    if (!o.threadId) {
      s.deps.sqlite.prepare(`INSERT INTO threads (id, paperId, kind, title, anchorJson, createdAt, updatedAt) VALUES (?, ?, ?, 't', ?, ?, ?)`).run(threadId, SEED_PAPER_ID, o.kind, o.selection ? JSON.stringify({ kind: 'text', quote: { exact: o.selection }, rects: [] }) : null, now, now);
    }
    s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, threadId, model, effort, status, acceptedAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?, 'opus', 'low', 'ok', ?, ?)`).run(runId, o.crid, o.payloadHash, o.kind === 'explain' ? 'explain_selection' : 'chat', SEED_PAPER_ID, threadId, now, now);
    s.deps.sqlite.prepare(`INSERT INTO messages (id, threadId, role, contentMd, status, clientRequestId, createdAt) VALUES (?, ?, 'user', ?, 'complete', ?, ?)`).run(uuid(), threadId, o.question ?? o.selection ?? '', o.crid, now);
    s.deps.sqlite.prepare(`INSERT INTO messages (id, threadId, role, contentMd, status, llmCallId, createdAt) VALUES (?, ?, 'assistant', ?, 'complete', ?, ?)`).run(assistantId, threadId, o.answer, runId, now + 1);
    return { threadId, runId };
  }

  it('n2: an M1 (v1) row matching the request is refused with 409 payload_version (never attached, nothing new); a different request is a plain 409', async () => {
    const crid = uuid();
    const old = oldServerRows({ crid, payloadHash: m1Hash({ task: 'explain_selection', paperId: SEED_PAPER_ID, inputs: { selection: 'robust kernel' } }), kind: 'explain', selection: 'robust kernel', answer: 'M1 answer' });
    const body = { kind: 'explain', text: 'robust kernel', clientRequestId: crid };
    const before = counts();
    const same = await post(`/papers/${SEED_PAPER_ID}/threads`, body);
    expect(same.status).toBe(409);
    expect(JSON.parse(same.text)).toEqual({ error: { code: 'conflict', message: expect.stringContaining('older server version'), details: { reason: 'payload_version', runId: old.runId } } });
    const other = await post(`/papers/${SEED_PAPER_ID}/threads`, { ...body, text: 'another selection' });
    expect(other.status).toBe(409);
    expect(JSON.parse(other.text).error.details).toBeUndefined();
    expect(counts()).toEqual(before);
  });

  it('n2: an M1 (v1) row of messages.create is refused the same way', async () => {
    const t = accepted((await post(`/papers/${SEED_PAPER_ID}/threads`, { kind: 'chat', question: 'start', clientRequestId: uuid() })).events);
    const crid = uuid();
    const old = oldServerRows({ crid, threadId: t.threadId!, payloadHash: m1Hash({ task: 'chat', paperId: SEED_PAPER_ID, threadId: t.threadId!, inputs: { question: 'next' } }), kind: 'chat', question: 'next', answer: 'M1 follow-up' });
    const again = await post(`/threads/${t.threadId}/messages`, { text: 'next', clientRequestId: crid });
    expect(again.status).toBe(409);
    expect(JSON.parse(again.text).error.details).toEqual({ reason: 'payload_version', runId: old.runId });
  });

  it('n2: a v2 row written by M1.1 without the "v2:" prefix still attaches (replayed from the DB); new rows carry the prefix', async () => {
    const body = { kind: 'explain', text: 'robust kernel' };
    const a = accepted((await post(`/papers/${SEED_PAPER_ID}/threads`, { ...body, clientRequestId: uuid() })).events);
    const stored = q<{ payloadHash: string }>(`SELECT payloadHash FROM llm_calls WHERE runId = ?`, a.runId)[0]!.payloadHash;
    expect(stored).toMatch(/^v2:[0-9a-f]{64}$/);
    const crid = uuid();
    const old = oldServerRows({ crid, payloadHash: stored.slice(3), kind: 'explain', selection: 'robust kernel', answer: 'M1.1 answer' });
    const again = await post(`/papers/${SEED_PAPER_ID}/threads`, { ...body, clientRequestId: crid });
    expect(again.status).toBe(200);
    expect(again.events.map((e) => e.event)).toEqual(['run.accepted', 'run.done']);
    expect(again.events[0]!.data).toMatchObject({ runId: old.runId, threadId: old.threadId });
    expect(again.events[1]!.data).toMatchObject({ text: 'M1.1 answer' });
  });
});
