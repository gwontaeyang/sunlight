// Owner B. Contract cases of the threads route module (see ../helpers/routeCases.ts).
import { expect } from 'vitest';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { makeTestPngBase64 } from '../helpers/png';
import type { CaseContext, RouteCase } from '../helpers/routeCases';

const MISSING = '00000000-0000-4000-8000-00000000dead';
const uuid = () => crypto.randomUUID();

export function sseEvents(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((f) => f.trim())
    .map((f) => parseSseEvent(/^event: (.*)$/m.exec(f)![1]!, JSON.parse(/^data: (.*)$/m.exec(f)![1]!)));
}

/** Runs one explain on the seed paper; stores threadId / messageId / runId in ctx.vars. */
export async function explainOnSeed(ctx: CaseContext, text = 'We estimate the robot pose'): Promise<void> {
  const s = ctx.server;
  const r = await s.req(`/api/papers/${SEED_PAPER_ID}/threads`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'explain', text, clientRequestId: uuid() }) });
  const ev = sseEvents(r.text);
  const a = ev[0];
  if (a?.event !== 'run.accepted' || ev.at(-1)?.event !== 'run.done') throw new Error(`setup run failed: ${r.text.slice(0, 300)}`);
  ctx.vars.threadId = a.data.threadId!;
  ctx.vars.messageId = a.data.messageId!;
  ctx.vars.runId = a.data.runId;
}

const insertNotReadyPaper = (ctx: CaseContext) => {
  ctx.vars.paperId = uuid();
  ctx.server.deps.sqlite.prepare(`INSERT INTO papers (id, source, title, ingestStatus, createdAt, updatedAt) VALUES (?, 'arxiv', 'Not ready', 'running', 1, 1)`).run(ctx.vars.paperId);
};

export const cases: RouteCase[] = [
  // threads.create
  {
    route: 'threads.create',
    name: 'explain on the seed paper streams accepted → … → done',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: () => ({ kind: 'explain', text: 'We estimate the robot pose', clientRequestId: uuid() }),
    check: (r, ctx) => {
      expect(r.events.at(-1)!.event).toBe('run.done');
      const accepted = r.events[0]!;
      if (accepted.event !== 'run.accepted') throw new Error('first event');
      expect(accepted.data.threadId && accepted.data.messageId).toBeTruthy();
      // The assistant message points at its run (model, usage and error provenance).
      expect(ctx.server.deps.sqlite.prepare(`SELECT llmCallId, status FROM messages WHERE id = ?`).get(accepted.data.messageId)).toEqual({ llmCallId: accepted.data.runId, status: 'complete' });
      expect(ctx.server.deps.sqlite.prepare(`SELECT quoteHash IS NOT NULL AS h, kind FROM threads WHERE id = ?`).get(accepted.data.threadId)).toEqual({ h: 1, kind: 'explain' });
    },
  },
  {
    route: 'threads.create',
    name: 'chat without a selection (question about the whole paper)',
    expect: 'ok',
    params: { id: SEED_PAPER_ID },
    body: () => ({ kind: 'chat', question: 'What does the paper use for data association?', clientRequestId: uuid() }),
    check: (r) => expect(r.events.at(-1)!.event).toBe('run.done'),
  },
  { route: 'threads.create', name: 'unknown paper', expect: 'not_found', params: { id: MISSING }, body: () => ({ kind: 'explain', text: 'x', clientRequestId: uuid() }) },
  { route: 'threads.create', name: 'missing clientRequestId', expect: 'validation', params: { id: SEED_PAPER_ID }, body: { kind: 'explain', text: 'x' } },
  { route: 'threads.create', name: 'explain without a selection', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'explain', question: 'why?', clientRequestId: uuid() }) },
  // M2 kind table (contracts/api.ts CreateThreadRequest comment): translate takes no question (the M1 case "translate
  // is not available yet" became this one when translate arrived — BRIEF_B B7)
  { route: 'threads.create', name: 'translate with a question (not in the kind table)', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'translate', text: 'x', question: 'why?', clientRequestId: uuid() }) },
  ...m2CreateCases(),
  {
    route: 'threads.create',
    name: 'same clientRequestId with another payload',
    expect: 'conflict',
    setup: async (ctx) => {
      ctx.vars.crid = uuid();
      const s = ctx.server;
      await s.req(`/api/papers/${SEED_PAPER_ID}/threads`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'explain', text: 'first selection', clientRequestId: ctx.vars.crid }) });
    },
    params: { id: SEED_PAPER_ID },
    body: (ctx: CaseContext) => ({ kind: 'explain', text: 'another selection', clientRequestId: ctx.vars.crid }),
  },
  {
    route: 'threads.create',
    name: 'paper that is not context_ready',
    expect: 'context_not_ready',
    setup: insertNotReadyPaper,
    params: (ctx) => ({ id: ctx.vars.paperId! }),
    body: () => ({ kind: 'explain', text: 'x', clientRequestId: uuid() }),
  },

  // messages.create
  {
    route: 'messages.create',
    name: 'follow-up question in an explain thread',
    expect: 'ok',
    setup: (ctx) => explainOnSeed(ctx),
    params: (ctx) => ({ id: ctx.vars.threadId! }),
    body: () => ({ text: 'How fast is the method?', clientRequestId: uuid() }),
    check: (r, ctx) => {
      expect(r.events.at(-1)!.event).toBe('run.done');
      expect(ctx.server.deps.sqlite.prepare(`SELECT count(*) AS n FROM messages WHERE threadId = ?`).get(ctx.vars.threadId)).toEqual({ n: 4 });
    },
  },
  {
    route: 'messages.create',
    name: 'regenerate replaces the last turn',
    expect: 'ok',
    setup: (ctx) => explainOnSeed(ctx),
    params: (ctx) => ({ id: ctx.vars.threadId! }),
    body: () => ({ text: 'We estimate the robot pose', regenerate: true, clientRequestId: uuid() }),
    check: (r, ctx) => {
      expect(r.events.at(-1)!.event).toBe('run.done');
      const rows = ctx.server.deps.sqlite.prepare(`SELECT id, role FROM messages WHERE threadId = ?`).all(ctx.vars.threadId) as { id: string }[];
      expect(rows).toHaveLength(2);
      expect(rows.map((m) => m.id)).not.toContain(ctx.vars.messageId);
    },
  },
  {
    route: 'messages.create',
    name: 'a follow-up with deep: true runs at high effort',
    expect: 'ok',
    setup: (ctx) => explainOnSeed(ctx),
    params: (ctx) => ({ id: ctx.vars.threadId! }),
    body: () => ({ text: 'Why that threshold?', deep: true, clientRequestId: uuid() }),
    check: (r, ctx) => {
      const started = r.events.find((e) => e.event === 'run.started');
      expect(started?.data).toMatchObject({ effort: 'high' });
      const a = r.events[0]!;
      if (a.event !== 'run.accepted') throw new Error('first event');
      expect(ctx.server.deps.sqlite.prepare(`SELECT effort, task FROM llm_calls WHERE runId = ?`).get(a.data.runId)).toEqual({ effort: 'high', task: 'chat' });
    },
  },
  {
    route: 'messages.create',
    name: 'regenerate together with deep',
    expect: 'validation',
    setup: (ctx) => explainOnSeed(ctx),
    params: (ctx) => ({ id: ctx.vars.threadId! }),
    body: () => ({ text: 'again', regenerate: true, deep: true, clientRequestId: uuid() }),
  },
  { route: 'messages.create', name: 'unknown thread', expect: 'not_found', params: { id: MISSING }, body: () => ({ text: 'q', clientRequestId: uuid() }) },
  { route: 'messages.create', name: 'empty text', expect: 'validation', params: { id: MISSING }, body: () => ({ text: '', clientRequestId: uuid() }) },
  {
    route: 'messages.create',
    name: 'regenerate in a thread without an answer',
    expect: 'conflict',
    setup: (ctx) => {
      ctx.vars.threadId = uuid();
      ctx.server.deps.sqlite.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES (?, ?, 'chat', 't', 1, 1)`).run(ctx.vars.threadId, SEED_PAPER_ID);
    },
    params: (ctx) => ({ id: ctx.vars.threadId! }),
    body: () => ({ text: 'q', regenerate: true, clientRequestId: uuid() }),
  },
  {
    route: 'messages.create',
    name: 'thread of a paper that is not context_ready',
    expect: 'context_not_ready',
    setup: (ctx) => {
      insertNotReadyPaper(ctx);
      ctx.vars.threadId = uuid();
      ctx.server.deps.sqlite.prepare(`INSERT INTO threads (id, paperId, kind, title, createdAt, updatedAt) VALUES (?, ?, 'chat', 't', 1, 1)`).run(ctx.vars.threadId, ctx.vars.paperId);
    },
    params: (ctx) => ({ id: ctx.vars.threadId! }),
    body: () => ({ text: 'q', clientRequestId: uuid() }),
  },

  // threads.list / get / delete
  {
    route: 'threads.list',
    name: 'threads of the seed paper with their last stats',
    expect: 'ok',
    setup: (ctx) => explainOnSeed(ctx),
    params: { id: SEED_PAPER_ID },
    check: (r, ctx) => {
      const list = (r.json as { threads: { id: string; lastStats: unknown }[] }).threads;
      expect(list.find((t) => t.id === ctx.vars.threadId)?.lastStats).toMatchObject({ quotes: { verbatim: 2 } });
    },
  },
  { route: 'threads.list', name: 'unknown paper', expect: 'not_found', params: { id: MISSING } },
  {
    route: 'threads.get',
    name: 'thread with messages and citations',
    expect: 'ok',
    setup: (ctx) => explainOnSeed(ctx),
    params: (ctx) => ({ id: ctx.vars.threadId! }),
    check: (r, ctx) => {
      const d = r.json as { messages: { id: string; role: string; citations: { status: string }[] }[] };
      expect(d.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(d.messages.find((m) => m.id === ctx.vars.messageId)!.citations.map((x) => x.status)).toEqual(['verbatim', 'resolved', 'verbatim']);
    },
  },
  { route: 'threads.get', name: 'unknown thread', expect: 'not_found', params: { id: MISSING } },
  {
    route: 'threads.delete',
    name: 'deletes the thread, its messages and their citations',
    expect: 'ok',
    setup: (ctx) => explainOnSeed(ctx),
    params: (ctx) => ({ id: ctx.vars.threadId! }),
    check: (_r, ctx) => {
      const db = ctx.server.deps.sqlite;
      expect(db.prepare(`SELECT count(*) AS n FROM messages WHERE threadId = ?`).get(ctx.vars.threadId)).toEqual({ n: 0 });
      expect(db.prepare(`SELECT count(*) AS n FROM citations WHERE ownerId = ?`).get(ctx.vars.messageId)).toEqual({ n: 0 });
      expect(db.prepare(`SELECT status, threadId FROM llm_calls WHERE runId = ?`).get(ctx.vars.runId)).toEqual({ status: 'ok', threadId: null });
    },
  },
  { route: 'threads.delete', name: 'unknown thread', expect: 'not_found', params: { id: MISSING } },
];

const AREA = { kind: 'area' as const, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.3 }] };
const equationOfSeed = (ctx: CaseContext, number: string) => {
  ctx.vars.equationId = (ctx.server.deps.sqlite.prepare(`SELECT id FROM equations WHERE paperId = ? AND number = ?`).get(SEED_PAPER_ID, number) as { id: string }).id;
};
const accepted = (r: { events: SseEvent[] }) => {
  const a = r.events[0]!;
  if (a.event !== 'run.accepted') throw new Error('first event is not run.accepted');
  return a.data;
};

/** M2 threads.create cases: translate, figure, equation (both inputs), deep, the kind table and PNG errors. */
function m2CreateCases(): RouteCase[] {
  return [
    {
      route: 'threads.create',
      name: 'translate: sonnet, no prefix fingerprint, no citations',
      expect: 'ok',
      params: { id: SEED_PAPER_ID },
      body: () => ({ kind: 'translate', anchor: { kind: 'text', quote: { exact: 'We estimate the robot pose' }, rects: [] }, clientRequestId: uuid() }),
      check: (r, ctx) => {
        const done = r.events.at(-1)!;
        expect(done.event).toBe('run.done');
        if (done.event === 'run.done') expect([done.data.parsed, done.data.citations, done.data.stats]).toEqual([null, [], null]);
        expect(ctx.server.deps.sqlite.prepare(`SELECT task, model, prefixFingerprint FROM llm_calls WHERE runId = ?`).get(accepted(r).runId)).toEqual({ task: 'translate_selection', model: 'sonnet', prefixFingerprint: null });
      },
    },
    {
      route: 'threads.create',
      name: 'figure: the capture is stored and the thread shows imageFileId',
      expect: 'ok',
      params: { id: SEED_PAPER_ID },
      body: () => ({ kind: 'figure', anchor: AREA, imagePng: makeTestPngBase64({ width: 64, height: 48 }), question: '이 그림은?', clientRequestId: uuid() }),
      check: (r, ctx) => {
        expect(r.events.at(-1)!.event).toBe('run.done');
        const t = ctx.server.deps.sqlite.prepare(`SELECT t.kind, f.kind AS fileKind FROM threads t JOIN files f ON f.id = t.imageFileId WHERE t.id = ?`).get(accepted(r).threadId);
        expect(t).toEqual({ kind: 'figure', fileKind: 'capture' });
      },
    },
    {
      route: 'threads.create',
      name: 'equation by equationId (a numbered equation of the paper)',
      expect: 'ok',
      setup: (ctx) => equationOfSeed(ctx, '2'),
      params: { id: SEED_PAPER_ID },
      body: (ctx: CaseContext) => ({ kind: 'equation', equationId: ctx.vars.equationId, clientRequestId: uuid() }),
      check: (r, ctx) => {
        expect(r.events.at(-1)!.event).toBe('run.done');
        expect(ctx.server.deps.sqlite.prepare(`SELECT kind, equationId FROM threads WHERE id = ?`).get(accepted(r).threadId)).toEqual({ kind: 'equation', equationId: ctx.vars.equationId });
      },
    },
    {
      route: 'threads.create',
      name: 'equation by an area capture',
      expect: 'ok',
      params: { id: SEED_PAPER_ID },
      body: () => ({ kind: 'equation', anchor: AREA, imagePng: makeTestPngBase64({ width: 40, height: 20 }), clientRequestId: uuid() }),
      check: (r) => expect(r.events.at(-1)!.event).toBe('run.done'),
    },
    {
      route: 'threads.create',
      name: 'chat with deep: true → effort high',
      expect: 'ok',
      params: { id: SEED_PAPER_ID },
      body: () => ({ kind: 'chat', question: 'What is the main contribution?', deep: true, clientRequestId: uuid() }),
      check: (r) => expect(r.events.find((e) => e.event === 'run.started')?.data).toMatchObject({ effort: 'high' }),
    },
    { route: 'threads.create', name: 'explain with deep (task without deepEffort)', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'explain', text: 'x', deep: true, clientRequestId: uuid() }) },
    { route: 'threads.create', name: 'translate with deep', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'translate', text: 'x', deep: true, clientRequestId: uuid() }) },
    { route: 'threads.create', name: 'figure without imagePng', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'figure', anchor: AREA, clientRequestId: uuid() }) },
    { route: 'threads.create', name: 'figure with text', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'figure', anchor: AREA, imagePng: makeTestPngBase64({ width: 20, height: 20 }), text: 'x', clientRequestId: uuid() }) },
    { route: 'threads.create', name: 'figure with two rects', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'figure', anchor: { kind: 'area', rects: [AREA.rects[0], AREA.rects[0]] }, imagePng: makeTestPngBase64({ width: 20, height: 20 }), clientRequestId: uuid() }) },
    {
      route: 'threads.create',
      name: 'equation with both equationId and a capture',
      expect: 'validation',
      setup: (ctx) => equationOfSeed(ctx, '1'),
      params: { id: SEED_PAPER_ID },
      body: (ctx: CaseContext) => ({ kind: 'equation', equationId: ctx.vars.equationId, anchor: AREA, imagePng: makeTestPngBase64({ width: 20, height: 20 }), clientRequestId: uuid() }),
    },
    { route: 'threads.create', name: 'equation with neither equationId nor a capture', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'equation', clientRequestId: uuid() }) },
    { route: 'threads.create', name: 'equation of another paper / unknown id', expect: 'not_found', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'equation', equationId: MISSING, clientRequestId: uuid() }) },
    { route: 'threads.create', name: 'chat with an image', expect: 'validation', params: { id: SEED_PAPER_ID }, body: () => ({ kind: 'chat', question: 'q', anchor: AREA, imagePng: makeTestPngBase64({ width: 20, height: 20 }), clientRequestId: uuid() }) },
    {
      route: 'threads.create',
      name: 'a PNG with a broken CRC',
      expect: 'validation',
      params: { id: SEED_PAPER_ID },
      body: () => {
        const b = Buffer.from(makeTestPngBase64({ width: 20, height: 20 }), 'base64');
        b[b.length - 1]! ^= 1;
        return { kind: 'figure', anchor: AREA, imagePng: b.toString('base64'), clientRequestId: uuid() };
      },
    },
  ];
}
