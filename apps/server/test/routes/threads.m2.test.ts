// threads.create / messages.create in M2 (PLAN_M2 3.5–3.7, BRIEF_B B7): translate (paragraphs, readable only), figure
// (capture stored, imageFileId, image re-attached to follow-ups), equation (equationId or capture), the kind table,
// PNG checks, capture write order (one file per request id), tombstones, pendingReplace of a regenerate turn. Owner B.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThreadDetailResponse } from '@study-paper/shared/contracts/api';
import { parseSseEvent, type SseEvent } from '@study-paper/shared/contracts/sse';
import { SEED_M2_PAPER_ID, SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { checkKind } from '../../src/routes/threads';
import { HttpError } from '../../src/deps';
import { makeTestPng, makeTestPngBase64 } from '../helpers/png';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';

interface Res {
  status: number;
  json: unknown;
  events: SseEvent[];
}
let s: TestServer;
let llm: ControlledAdapter;
afterEach(async () => {
  await s?.close();
});
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const raw = typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body);
  const r = await s.req(`/api${path}`, { method, headers: { 'X-SP-Token': s.token, ...(raw !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: raw });
  const type = String(r.headers['content-type'] ?? '');
  const events = type.includes('event-stream')
    ? r.text
        .split('\n\n')
        .filter((f) => f.trim())
        .map((f) => parseSseEvent(/^event: (.*)$/m.exec(f)![1]!, JSON.parse(/^data: (.*)$/m.exec(f)![1]!)))
    : [];
  return { status: r.status, json: type.includes('json') ? (JSON.parse(r.text) as unknown) : undefined, events };
}
const post = (path: string, body: unknown) => call('POST', path, body);
const P = (paper = SEED_M2_PAPER_ID) => `/papers/${paper}/threads`;
const accepted = (r: Res) => r.events[0]!.data as { runId: string; threadId: string; messageId: string };
const lastText = (n = 1) => {
  const t = llm.calls.at(-n)!.tail.at(-1)!;
  if (t.type !== 'text') throw new Error('not text');
  return t.text;
};
const AREA = { kind: 'area' as const, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.3 }] };
async function start(papers: ('m1' | 'm2')[] = ['m2']) {
  llm = new ControlledAdapter();
  s = await startTestServer({ env: 'prod', papers, llm });
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const captures = (paper = SEED_M2_PAPER_ID) => {
  const dir = s.deps.paths.capturesDir(paper);
  const files = existsSync(dir) ? readdirSync(dir).sort().map((n) => ({ n, sha: sha(readFileSync(join(dir, n))) })) : [];
  const rows = s.deps.sqlite.prepare(`SELECT id, sha256, bytes FROM files WHERE kind = 'capture' AND paperId = ? ORDER BY id`).all(paper);
  return { files, rows, calls: llm.calls.length };
};

describe('translate', () => {
  it('selection + 600 chars of paragraph before / after + the glossary; no prefix; readable is enough (context not ready)', async () => {
    await start(['m2']);
    await post(`/papers/${SEED_M2_PAPER_ID}/glossary`, { term: 'residual', definitionKo: '잔차' });
    const quote = 'propagated with a first-order Jacobian';
    const r = await post(P(), { kind: 'translate', anchor: { kind: 'text', quote: { exact: quote }, rects: [{ page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.02 }] }, clientRequestId: randomUUID() });
    expect(r.events.at(-1)!.event).toBe('run.done');
    const t = lastText();
    expect(t).toContain('<task name="translate_selection" v="1">');
    expect(t).toContain(`<selection trust="paper">${quote}</selection>`);
    expect(t).toMatch(/<paragraph_before trust="paper">[\s\S]+<\/paragraph_before>/);
    const before = /<paragraph_before trust="paper">([\s\S]*?)<\/paragraph_before>/.exec(t)![1]!;
    expect(before.length).toBeLessThanOrEqual(601);
    expect(t).toContain('<glossary_known trust="user">residual: 잔차</glossary_known>');
    expect(llm.calls.at(-1)!.prefix).toEqual([]);
    // a paper whose context is not ready: translate runs, explain is 409
    s.deps.sqlite.prepare(`UPDATE papers SET contextReadyAt = NULL WHERE id = ?`).run(SEED_M2_PAPER_ID);
    expect((await post(P(), { kind: 'translate', text: quote, clientRequestId: randomUUID() })).events.at(-1)!.event).toBe('run.done');
    expect((await post(P(), { kind: 'explain', text: quote, clientRequestId: randomUUID() })).status).toBe(409);
    // no follow-up question; regenerate re-translates
    const tid = accepted(r).threadId;
    s.deps.sqlite.prepare(`UPDATE papers SET contextReadyAt = 1 WHERE id = ?`).run(SEED_M2_PAPER_ID);
    expect((await post(`/threads/${tid}/messages`, { text: '더 자세히', clientRequestId: randomUUID() })).status).toBe(400);
    const regen = await post(`/threads/${tid}/messages`, { text: quote, regenerate: true, clientRequestId: randomUUID() });
    expect(regen.events[0]).toMatchObject({ data: { task: 'translate_selection' } });
    expect(regen.events.at(-1)!.event).toBe('run.done');
  });
});

describe('figure', () => {
  it('the PNG is stored, ThreadDto.imageFileId names it, the image is tail[0]; a follow-up (task chat) and a regenerate re-attach it', async () => {
    await start(['m2']);
    const png = makeTestPngBase64({ width: 64, height: 48 });
    const r = await post(P(), { kind: 'figure', anchor: AREA, imagePng: png, question: '무엇?', clientRequestId: randomUUID() });
    expect(r.events.at(-1)!.event).toBe('run.done');
    const t = (await call('GET', `/threads/${accepted(r).threadId}`)).json as ThreadDetailResponse;
    expect(t.thread.imageFileId).toBeTruthy();
    expect(readFileSync(s.deps.paths.captureFile(SEED_M2_PAPER_ID, t.thread.imageFileId!)).toString('base64')).toBe(png);
    expect(llm.calls.at(-1)!.tail[0]).toMatchObject({ type: 'image', source: { data: png } });
    expect(lastText()).toContain('<area trust="user" page="1"/>');
    expect(lastText()).toContain('<nearby_captions trust="paper">- Overview of the synthetic registration pipeline.</nearby_captions>');
    const follow = await post(`/threads/${t.thread.id}/messages`, { text: '왜?', clientRequestId: randomUUID() });
    expect(follow.events[0]).toMatchObject({ data: { task: 'chat' } });
    expect(llm.calls.at(-1)!.tail[0]).toMatchObject({ type: 'image', source: { data: png } });
    const regen = await post(`/threads/${t.thread.id}/messages`, { text: '왜?', regenerate: true, clientRequestId: randomUUID() });
    expect(regen.events.at(-1)!.event).toBe('run.done');
    expect(llm.calls.at(-1)!.tail[0]).toMatchObject({ type: 'image' });
  });
});

describe('equation', () => {
  it('by equationId: <equation n html_id> with the LaTeX and the neighbours; by capture: the image', async () => {
    await start(['m2']);
    const eq = s.deps.sqlite.prepare(`SELECT id, htmlId, latex FROM equations WHERE paperId = ? AND number = '2'`).get(SEED_M2_PAPER_ID) as { id: string; htmlId: string; latex: string };
    const r = await post(P(), { kind: 'equation', equationId: eq.id, clientRequestId: randomUUID() });
    expect(r.events.at(-1)!.event).toBe('run.done');
    const t = lastText();
    expect(t).toContain(`<equation trust="paper" n="2" html_id="${eq.htmlId}">`);
    expect(t).toMatch(/<neighbors trust="paper" prev="1" next="3">/);
    expect(llm.calls.at(-1)!.tail.map((b) => b.type)).toEqual(['text']);
    expect(((await call('GET', `/threads/${accepted(r).threadId}`)).json as ThreadDetailResponse).thread.equationId).toBe(eq.id);
    const c = await post(P(), { kind: 'equation', anchor: AREA, imagePng: makeTestPngBase64({ width: 30, height: 20 }), clientRequestId: randomUUID() });
    expect(c.events.at(-1)!.event).toBe('run.done');
    expect(llm.calls.at(-1)!.tail[0]!.type).toBe('image');
    // an unnumbered equation → 400, another paper's → 404
    const unnumbered = s.deps.sqlite.prepare(`SELECT id FROM equations WHERE paperId = ? AND number IS NULL`).get(SEED_M2_PAPER_ID) as { id: string } | undefined;
    if (unnumbered) expect((await post(P(), { kind: 'equation', equationId: unnumbered.id, clientRequestId: randomUUID() })).status).toBe(400);
    expect((await post(P(), { kind: 'equation', equationId: randomUUID(), clientRequestId: randomUUID() })).status).toBe(404);
  });
});

describe('equation: the neighbours come from the stored context (seed S-5: the parser context values)', () => {
  it('equation 4: before / after from equations.contextBefore / contextAfter, prev 3, next A.1', async () => {
    await start(['m2']);
    const eq = s.deps.sqlite.prepare(`SELECT id, contextBefore, contextAfter FROM equations WHERE paperId = ? AND number = '4'`).get(SEED_M2_PAPER_ID) as { id: string; contextBefore: string | null; contextAfter: string | null };
    expect(eq.contextBefore).toContain('An unsupported command');
    expect(eq.contextAfter).toBe('The error of the estimate is written without a number.');
    const r = await post(P(), { kind: 'equation', equationId: eq.id, clientRequestId: randomUUID() });
    expect(r.events.at(-1)!.event).toBe('run.done');
    const t = lastText();
    expect(t).toMatch(/<neighbors trust="paper" prev="3" next="A\.1">before: [^\n]*An unsupported command[^\n]*github\.com\/example\/synthetic-registration\.\nafter: The error of the estimate is written without a number\.<\/neighbors>/);
  });
});

describe('the kind table (checkKind): every row', () => {
  const png = makeTestPngBase64({ width: 20, height: 20 });
  const text = { kind: 'text' as const, quote: { exact: 'sel' }, rects: [] };
  const ok: [string, Record<string, unknown>][] = [
    ['explain text', { kind: 'explain', text: 'sel' }],
    ['explain anchor + question', { kind: 'explain', anchor: text, question: 'q' }],
    ['chat', { kind: 'chat', question: 'q' }],
    ['chat + selection + deep', { kind: 'chat', question: 'q', anchor: text, text: 'sel', deep: true }],
    ['translate', { kind: 'translate', text: 'sel' }],
    ['figure', { kind: 'figure', anchor: AREA, imagePng: png }],
    ['figure + question', { kind: 'figure', anchor: AREA, imagePng: png, question: 'q' }],
    ['equation id', { kind: 'equation', equationId: randomUUID() }],
    ['equation capture + question', { kind: 'equation', anchor: AREA, imagePng: png, question: 'q' }],
  ];
  const bad: [string, Record<string, unknown>][] = [
    ['explain without selection', { kind: 'explain', question: 'q' }],
    ['explain + image', { kind: 'explain', text: 'sel', anchor: AREA, imagePng: png }],
    ['explain + equationId', { kind: 'explain', text: 'sel', equationId: randomUUID() }],
    ['explain + deep', { kind: 'explain', text: 'sel', deep: true }],
    ['chat without question', { kind: 'chat', text: 'sel' }],
    ['chat + image', { kind: 'chat', question: 'q', anchor: AREA, imagePng: png }],
    ['chat + equationId', { kind: 'chat', question: 'q', equationId: randomUUID() }],
    ['translate + question', { kind: 'translate', text: 'sel', question: 'q' }],
    ['translate + deep', { kind: 'translate', text: 'sel', deep: true }],
    ['translate + equationId', { kind: 'translate', text: 'sel', equationId: randomUUID() }],
    ['translate area', { kind: 'translate', anchor: AREA, imagePng: png }],
    ['figure without image', { kind: 'figure', anchor: AREA }],
    ['figure two rects', { kind: 'figure', anchor: { kind: 'area', rects: [AREA.rects[0], AREA.rects[0]] }, imagePng: png }],
    ['figure + text', { kind: 'figure', anchor: AREA, imagePng: png, text: 't' }],
    ['figure + deep', { kind: 'figure', anchor: AREA, imagePng: png, deep: true }],
    ['figure + equationId', { kind: 'figure', anchor: AREA, imagePng: png, equationId: randomUUID() }],
    ['equation neither', { kind: 'equation' }],
    ['equation both', { kind: 'equation', equationId: randomUUID(), anchor: AREA, imagePng: png }],
    ['equation + deep', { kind: 'equation', equationId: randomUUID(), deep: true }],
    ['equation + text', { kind: 'equation', equationId: randomUUID(), text: 't' }],
  ];
  it.each(ok)('%s → accepted', (_n, body) => {
    expect(() => checkKind(body as never)).not.toThrow();
  });
  it.each(bad)('%s → 400', (_n, body) => {
    let e: unknown;
    try {
      checkKind(body as never);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
  });
});

describe('PNG checks (400 before anything is written; 413 over the body limit)', () => {
  it('4 MiB passes; +1 / +2 / +3 B, no IDAT, a bad CRC → 400; a pad-bit variant → 400 even for an id that already succeeded; > 6 MiB body → 413', async () => {
    await start(['m2']);
    const MiB4 = 4 * 1024 * 1024;
    const fig = (crid: string, imagePng: string) => ({ kind: 'figure', anchor: AREA, imagePng, clientRequestId: crid });
    expect((await post(P(), fig(randomUUID(), makeTestPng({ width: 64, height: 48, padToBytes: MiB4 }).toString('base64')))).status).toBe(200);
    for (const extra of [1, 2, 3]) expect((await post(P(), fig(randomUUID(), makeTestPng({ width: 64, height: 48, padToBytes: MiB4 + extra }).toString('base64')))).status, `+${extra}`).toBe(400);
    const noIdat = Buffer.concat([makeTestPng({ width: 20, height: 20 }).subarray(0, 33), makeTestPng({ width: 20, height: 20 }).subarray(-12)]).toString('base64');
    expect((await post(P(), fig(randomUUID(), noIdat))).status).toBe(400);
    const crc = makeTestPng({ width: 20, height: 20 });
    crc[crc.length - 1]! ^= 1;
    expect((await post(P(), fig(randomUUID(), crc.toString('base64')))).status).toBe(400);
    const eq2 = makeTestPngBase64({ width: 20, height: 20, padToBytes: 1000 });
    const variant = eq2.slice(0, -3) + String.fromCharCode(eq2.charCodeAt(eq2.length - 3) + 1) + '==';
    const G = randomUUID();
    expect((await post(P(), fig(G, eq2))).status).toBe(200);
    expect((await post(P(), fig(G, variant))).status).toBe(400);
    expect((await call('POST', P(), JSON.stringify({ ...fig(randomUUID(), 'AAAA'), question: 'x'.repeat(6_291_456) }))).status).toBe(413);
  });

  it('a tombstoned paper: a capture request writes no file', async () => {
    await start(['m2']);
    s.deps.sqlite.prepare(`UPDATE papers SET deletingAt = ? WHERE id = ?`).run(Date.now(), SEED_M2_PAPER_ID);
    const before = captures();
    expect((await post(P(), { kind: 'figure', anchor: AREA, imagePng: makeTestPngBase64({ width: 20, height: 20 }), clientRequestId: randomUUID() })).status).toBe(404);
    expect(captures()).toEqual(before);
  });
});

describe('one capture file per request id', () => {
  it('a resend after completion, two concurrent sends of the same id, the same id with another PNG (409): 1 file, same bytes, 1 row, 1 adapter call', async () => {
    await start(['m2']);
    const png = makeTestPngBase64({ width: 64, height: 48 });
    const F = randomUUID();
    const body = { kind: 'figure', anchor: AREA, imagePng: png, clientRequestId: F };
    expect((await post(P(), body)).events.at(-1)!.event).toBe('run.done');
    const after1 = captures();
    expect(after1.files).toHaveLength(1);
    expect(after1.rows).toHaveLength(1);
    await post(P(), body);
    await Promise.all([post(P(), body), post(P(), body)]);
    expect((await post(P(), { ...body, imagePng: makeTestPngBase64({ width: 65, height: 48 }) })).status).toBe(409);
    expect(captures()).toEqual(after1);
  });
});

describe('regenerate: the new turn is pending until its run commits', () => {
  it('while the run streams both new messages are pendingReplace=1; after success 0; after a failure they are gone', async () => {
    await start(['m1']);
    const r = await post(P(SEED_PAPER_ID), { kind: 'chat', question: 'q', clientRequestId: randomUUID() });
    const tid = accepted(r).threadId;
    const hold = llm.holdNext();
    const regen = post(`/threads/${tid}/messages`, { text: 'q', regenerate: true, clientRequestId: randomUUID() });
    await hold.started;
    const pending = () => s.deps.sqlite.prepare(`SELECT role, pendingReplace FROM messages WHERE threadId = ? ORDER BY createdAt, rowid`).all(tid) as { role: string; pendingReplace: number }[];
    expect(pending().map((m) => m.pendingReplace)).toEqual([0, 0, 1, 1]);
    hold.release();
    expect((await regen).events.at(-1)!.event).toBe('run.done');
    expect(pending().map((m) => m.pendingReplace)).toEqual([0, 0]);
    // a failure: the pending turn goes, the committed turn stays
    const hold2 = llm.holdNext();
    const failing = post(`/threads/${tid}/messages`, { text: 'q', regenerate: true, clientRequestId: randomUUID() });
    await hold2.started;
    const runId = (s.deps.sqlite.prepare(`SELECT runId FROM llm_calls WHERE threadId = ? AND status = 'running'`).get(tid) as { runId: string }).runId;
    s.deps.runs.cancel(runId);
    hold2.release();
    expect((await failing).events.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
    expect(pending().map((m) => m.pendingReplace)).toEqual([0, 0]);
  });
});
