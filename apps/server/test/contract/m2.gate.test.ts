/// <reference types="vite/client" />
// M2 milestone gate (BRIEF_S S11, PLAN_M2 3–4). Owner: supervisor. Runs only when GATED_MILESTONE >= 2 or
// SP_GATE_MILESTONE=2 (a builder's preview): on a builder branch the items of other builders fail as "not
// implemented" — that is expected. G7c runs only with the constant GATED_MILESTONE >= 2 (integration).
// Only HTTP routes + the mock LLM (ControlledAdapter) + the seeds; no builder-internal function is imported.
// One item = one `it` (G7a, G7b, G7c separately) so a builder can report its own items.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardItemDto, ListCardsResponse, PaperDetailDto, StructureResponse, ThreadDetailResponse } from '@study-paper/shared/contracts/api';
import type { Citation, ParsedAnswer } from '@study-paper/shared/contracts/domain';
import { ASSUMPTION_CATEGORIES, ASSUMPTION_CATEGORY_KO, ASSUMPTION_STATED, NOTATION_KEYS, NOTATION_TITLES_KO } from '@study-paper/shared/contracts/domain';
import { parseConflictDetails } from '@study-paper/shared/contracts/errors';
import { cardBadgeCounts, itemBadge, pairCitations } from '@study-paper/shared/contracts/grounding';
import type { ParseOptions } from '@study-paper/shared/contracts/markupApi';
import { GATED_MILESTONE } from '@study-paper/shared/contracts/routeManifest';
import { gateMilestone } from '../helpers/gate';
import { JOB_TERMINAL_EVENTS, parseSseEvent, RUN_TERMINAL_EVENTS, type SseEvent } from '@study-paper/shared/contracts/sse';
import { parseAnswer as parseAnswerM1 } from '@study-paper/shared/markup/parseAnswer';
import { readMockFile, readMockManifest, readMockOutput } from '@study-paper/shared/mock-outputs';
import { SEED_M2_PAPER_ID, SEED_PAPER_ID, SEED_UPGRADE_INGEST_JOB_ID, SEED_UPGRADE_PAPER_ID } from '../../src/dev/seedFixture';
import { makeTestPng, makeTestPngBase64 } from '../helpers/png';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';

const gate = gateMilestone();
const describeGate = gate >= 2 ? describe : describe.skip;
const itIntegration = GATED_MILESTONE >= 2 ? it : it.skip;
const parseAnswer = parseAnswerM1 as unknown as (raw: string, o?: ParseOptions) => ParsedAnswer;

const DAY = 86_400_000;
const FIXTURES = join(__dirname, '..', 'fixtures');
const AREA = { kind: 'area' as const, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.3 }] };
const TEXT_ANCHOR = { kind: 'text' as const, quote: { exact: 'robust kernel' }, rects: [{ page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }] };

const servers: TestServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});
async function server(o: Parameters<typeof startTestServer>[0] & { llm?: ControlledAdapter }): Promise<TestServer> {
  const s = await startTestServer(o);
  servers.push(s);
  return s;
}
async function restart(s: TestServer): Promise<TestServer> {
  servers.splice(servers.indexOf(s), 1);
  const next = await s.restart();
  servers.push(next);
  return next;
}

interface Res {
  status: number;
  text: string;
  json: unknown;
  events: SseEvent[];
}
function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((f) => f.trim() !== '')
    .map((frame) => parseSseEvent(/^event: (.*)$/m.exec(frame)![1]!, JSON.parse(/^data: (.*)$/m.exec(frame)![1]!)));
}
/**
 * The stream rule (Codex m-S-3), checked on EVERY SSE response this gate reads (toRes below — new requests, live
 * attaches, repairs, concurrent resends, replays, jobs.events): only events of its family; a run stream starts with
 * run.accepted; exactly one terminal event (run.done | run.error, job.done | job.error), and it is the last one.
 */
function checkStream(events: readonly { event: string }[], family: 'run' | 'job'): void {
  const terminals: readonly string[] = family === 'job' ? JOB_TERMINAL_EVENTS : RUN_TERMINAL_EVENTS;
  expect(events.length, 'the stream has events').toBeGreaterThan(0);
  for (const e of events) expect(e.event.startsWith(`${family}.`), `${e.event} in a ${family} stream`).toBe(true);
  if (family === 'run') expect(events[0]!.event, 'a run stream starts with run.accepted').toBe('run.accepted');
  expect(events.filter((e) => terminals.includes(e.event)).length, 'exactly one terminal event').toBe(1);
  expect(terminals.includes(events.at(-1)!.event), 'the terminal event is last (nothing after it)').toBe(true);
}
function toRes(path: string, status: number, type: string, text: string): Res {
  const events = type.includes('event-stream') ? parseSse(text) : [];
  if (type.includes('event-stream')) checkStream(events, path.startsWith('/jobs/') ? 'job' : 'run');
  return { status, text, json: type.includes('json') ? JSON.parse(text) : undefined, events };
}
async function call(s: TestServer, method: string, path: string, body?: unknown): Promise<Res> {
  const r = await s.req(`/api${path}`, { method, headers: { 'X-SP-Token': s.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return toRes(path, r.status, String(r.headers['content-type'] ?? ''), r.text);
}
const get = (s: TestServer, path: string) => call(s, 'GET', path);
const post = (s: TestServer, path: string, body: unknown) => call(s, 'POST', path, body);
const del = (s: TestServer, path: string) => call(s, 'DELETE', path);
/** A streamed request: `headers` resolves when the response headers arrived (or the request ended), `done` at its end. */
function openStream(s: TestServer, path: string, body: unknown): { headers: Promise<void>; done: Promise<Res> } {
  let gotHeaders!: () => void;
  const headersP = new Promise<void>((r) => (gotHeaders = r));
  const done = fetch(`http://127.0.0.1:${s.port}/api${path}`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => {
    gotHeaders();
    return toRes(path, r.status, r.headers.get('content-type') ?? '', await r.text());
  });
  return { headers: Promise.race([headersP, done.then(() => undefined, () => undefined)]), done };
}
/** A streamed request that is still running (fetch keeps reading in the background). */
const startStream = (s: TestServer, path: string, body: unknown): Promise<Res> => openStream(s, path, body).done;
const uuid = () => crypto.randomUUID();
/** The terminal event (toRes already checked that it is the only one and the last). */
const terminal = (r: Res) => r.events.at(-1)!;
const accepted = (r: Res) => r.events.find((e) => e.event === 'run.accepted') as Extract<SseEvent, { event: 'run.accepted' }> | undefined;
const rows = (s: TestServer, table: string) => (s.deps.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const one = <T>(s: TestServer, sql: string, ...a: unknown[]) => s.deps.sqlite.prepare(sql).get(...a) as T;
async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
interface CaptureRow {
  id: string;
  sha256: string;
  bytes: number;
}
/**
 * Capture state for G4 (Codex m-S-1): every file's real bytes (length + sha256) and every files row (id, sha256,
 * bytes), so a file rewritten with other bytes of the same length changes the snapshot.
 */
function captureSnapshot(dir: string, rowsOf: () => CaptureRow[]): { files: { name: string; bytes: number; sha256: string }[]; rows: CaptureRow[] } {
  const files = (existsSync(dir) ? readdirSync(dir).sort() : []).map((name) => {
    const b = readFileSync(join(dir, name));
    return { name, bytes: b.length, sha256: sha256(b) };
  });
  return { files, rows: [...rowsOf()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}
const captureRows = (s: TestServer) => s.deps.sqlite.prepare(`SELECT id, sha256, bytes FROM files WHERE kind = 'capture'`).all() as CaptureRow[];
/** Each row's file exists with exactly the row's bytes and sha256, and there is no file without a row. */
function expectRowsMatchFiles(snap: ReturnType<typeof captureSnapshot>): void {
  expect(snap.files).toEqual(snap.rows.map((r) => ({ name: `${r.id}.png`, bytes: r.bytes, sha256: r.sha256 })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}
const generate = (s: TestServer, paperId: string, kind: string, crid: string) => post(s, `/papers/${paperId}/cards/${kind}/generate`, { clientRequestId: crid });
const cards = async (s: TestServer, paperId: string) => (await get(s, `/papers/${paperId}/cards`)).json as ListCardsResponse;
/** Waits for a held adapter call to start; fails at once when the request already ended (e.g. 501, 400). */
const startedOrFail = (started: Promise<void>, req: Promise<Res>) => Promise.race([started, req.then((r) => Promise.reject(new Error(`the request ended before the adapter call started: ${r.status} ${r.text.slice(0, 200)}`)))]);
const resultDeleted = (r: Res) => r.status === 200 && r.events[0]?.event === 'run.accepted' && r.events.length === 2 && r.events[1]!.event === 'run.error' && (r.events[1]!.data as { code: string }).code === 'result_deleted';

describeGate('M2 gate', () => {
  it('G1 cards.generate(notation): artifactId, a complete card of 11 items, card_generating 409 for a new id, attach for the same id, replay after restart, other kind → 409', async () => {
    const llm = new ControlledAdapter();
    let s = await server({ env: 'prod', papers: ['m2'], llm });
    const hold = llm.holdNext();
    const A = uuid();
    const first = startStream(s, `/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, { clientRequestId: A });
    await startedOrFail(hold.started, first);
    const runRow = one<{ runId: string }>(s, `SELECT runId FROM llm_calls WHERE clientRequestId = ?`, A);
    const cardRow = one<{ id: string }>(s, `SELECT id FROM paper_cards WHERE paperId = ? AND status = 'generating'`, SEED_M2_PAPER_ID);
    const before = { calls: rows(s, 'llm_calls'), cards: rows(s, 'paper_cards') };
    const other = await generate(s, SEED_M2_PAPER_ID, 'notation', uuid());
    expect(other.status).toBe(409);
    expect((other.json as { error: { code: string; details: unknown } }).error.code).toBe('conflict');
    expect(parseConflictDetails((other.json as { error: { details: unknown } }).error.details)).toEqual({ reason: 'card_generating', runId: runRow.runId, cardId: cardRow.id });
    expect({ calls: rows(s, 'llm_calls'), cards: rows(s, 'paper_cards') }).toEqual(before);
    // the same id while the run is live: release the held call only after the second response has its headers, so
    // the second request is a live attach and not a replay of a finished run
    const again = openStream(s, `/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, { clientRequestId: A });
    await again.headers;
    hold.release();
    const [r1, r2] = await Promise.all([first, again.done]);
    for (const r of [r1, r2]) {
      expect(accepted(r)?.data).toMatchObject({ runId: runRow.runId, artifactId: cardRow.id });
      expect(terminal(r).event).toBe('run.done');
    }
    expect(llm.calls).toHaveLength(1);
    const card = (await cards(s, SEED_M2_PAPER_ID)).cards.find((c) => c.kind === 'notation')!;
    expect(card).toMatchObject({ id: cardRow.id, status: 'complete' });
    expect(card.items).toHaveLength(11);
    // per-item citations: the `units` item of the mock card quotes one verbatim line of synthetic-m2.pdf
    const units = card.items.find((it) => it.key === 'units');
    expect(units?.citations.length).toBeGreaterThanOrEqual(1);
    expect(units!.citations.map((c) => [c.kind, c.status])).toEqual([['quote', 'verbatim']]);
    s = await restart(s);
    const callsBefore = rows(s, 'llm_calls');
    const replay = await generate(s, SEED_M2_PAPER_ID, 'notation', A);
    expect(replay.events.map((e) => e.event)).toEqual(['run.accepted', 'run.done']);
    expect(accepted(replay)?.data.runId).toBe(runRow.runId);
    expect(rows(s, 'llm_calls')).toBe(callsBefore);
    expect(llm.calls).toHaveLength(1);
    expect((await generate(s, SEED_M2_PAPER_ID, 'assumptions', A)).status).toBe(409);
  });

  it('G2 SP-Blocks repair: one run.retrying, a second llm_calls row with parentRunId, the parent running meanwhile; two failures → parse_failed with rawOutput, the old complete card stays', async () => {
    const llm = new ControlledAdapter();
    const s = await server({ env: 'prod', papers: ['m2'], llm });
    const invalid = readMockFile(readMockManifest().m2.blocksInvalid.notation_missing_key!.file);
    // (1) invalid then valid, with the repair call held
    llm.queueOutputs(invalid, readMockOutput('notation_card'));
    const repairHold = llm.holdCall(2);
    const A = uuid();
    const run = startStream(s, `/papers/${SEED_M2_PAPER_ID}/cards/notation/generate`, { clientRequestId: A });
    await startedOrFail(repairHold.started, run);
    const parent = one<{ runId: string }>(s, `SELECT runId FROM llm_calls WHERE clientRequestId = ?`, A);
    expect(((await get(s, `/llm/runs/${parent.runId}`)).json as { status: string }).status).toBe('running');
    const during = await generate(s, SEED_M2_PAPER_ID, 'notation', uuid());
    expect(during.status).toBe(409);
    expect(parseConflictDetails((during.json as { error: { details: unknown } }).error.details)).toMatchObject({ reason: 'card_generating', runId: parent.runId });
    expect(llm.calls).toHaveLength(2);
    repairHold.release();
    const r = await run;
    expect(r.events.filter((e) => e.event === 'run.retrying')).toHaveLength(1);
    expect(terminal(r).event).toBe('run.done');
    const calls = s.deps.sqlite.prepare(`SELECT runId, clientRequestId, parentRunId FROM llm_calls ORDER BY acceptedAt, rowid`).all() as { runId: string; clientRequestId: string | null; parentRunId: string | null }[];
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ clientRequestId: null, parentRunId: parent.runId });
    expect((await cards(s, SEED_M2_PAPER_ID)).cards.find((c) => c.kind === 'notation')?.status).toBe('complete');
    // (2) invalid twice → parse_failed with rawOutput; the complete card is kept
    llm.queueOutputs(invalid, invalid);
    const failed = await generate(s, SEED_M2_PAPER_ID, 'notation', uuid());
    expect(terminal(failed)).toMatchObject({ event: 'run.error', data: { code: 'parse_failed' } });
    const list = (await cards(s, SEED_M2_PAPER_ID)).cards.filter((c) => c.kind === 'notation');
    expect(list.map((c) => c.status).sort()).toEqual(['complete', 'parse_failed']);
    expect(list.find((c) => c.status === 'parse_failed')?.rawOutput).toBeTruthy();
    expect(llm.calls).toHaveLength(4);
    expect(llm.pendingOutputs).toBe(0);
  });

  it('G3 SP-Blocks provenance: adversarial outputs yield no forged citation, whitelist labels/attrs, server titles, ≤ 60 items; the four pairing mismatches turn a grounded item into "unconfirmed"', async () => {
    const llm = new ControlledAdapter();
    const s = await server({ env: 'prod', papers: ['m2'], llm });
    const m2 = readMockManifest().m2;
    const legitQuotes = new Set([...readMockOutput('notation_card').matchAll(/<q>([\s\S]*?)<\/q>/g)].map((m) => m[1]!));
    const titles = new Set<string>([...Object.values(NOTATION_TITLES_KO), ...Object.values(ASSUMPTION_CATEGORY_KO)]);
    // attrs: whitelist names, and each value one of that name's enum values
    const allowedAttrs: Record<string, readonly string[]> = { key: NOTATION_KEYS, label: ['P', 'N', 'G'], category: ASSUMPTION_CATEGORIES, stated: ASSUMPTION_STATED };
    // the valid:false branch below is switched on only by the manifest key; pin which entries carry it (boolean false)
    // so that dropping or retyping the key cannot silently release the R2-01 decision (same-kind nesting = validation error)
    expect(
      Object.entries(m2.blocksAdversarial).filter(([, e]) => e.expect.valid === false).map(([n]) => n),
      'manifest pins same-kind nesting as a validation error',
    ).toEqual(['nested_item']);
    for (const [name, entry] of Object.entries(m2.blocksAdversarial)) {
      // the same file for the first call and a possible repair call; whatever the request did not use is dropped
      // afterwards so it can never become the next entry's (or the normal card's) output
      const callsBefore = llm.calls.length;
      llm.queueOutputs(readMockFile(entry.file), readMockFile(entry.file));
      const kind = entry.task === 'assumptions_card' ? 'assumptions' : 'notation';
      const itemCitations = () => one<{ n: number }>(s, `SELECT count(*) AS n FROM citations WHERE ownerType = 'paper_card_item'`).n;
      const itemCitationsBefore = itemCitations();
      const res = await generate(s, SEED_M2_PAPER_ID, kind, uuid());
      expect(res.status, `${name}: ${res.text.slice(0, 200)}`).toBe(200);
      const used = llm.calls.length - callsBefore;
      expect([1, 2], `${name}: adapter calls`).toContain(used);
      expect(llm.calls.slice(callsBefore).map((c) => c.task), name).toEqual(Array(used).fill(entry.task));
      expect(llm.clearOutputs(), `${name}: unused outputs`).toBe(2 - used);
      if (entry.expect.valid === false) {
        // a validation error (coordinator note 3(b), e.g. same-kind <item> nesting): the card is invalid → one repair
        // with the same invalid output → still invalid → parse_failed; nothing of it is stored as items
        expect(used, `${name}: first call + one repair`).toBe(2);
        expect(terminal(res).event, name).toBe('run.error');
        expect((terminal(res).data as { code: string }).code, name).toBe('parse_failed');
        const failed = (await cards(s, SEED_M2_PAPER_ID)).cards.find((c) => c.kind === kind && c.runId === accepted(res)?.data.runId);
        expect(failed?.status, name).toBe('parse_failed');
        expect(failed?.items, `${name}: no item or citation of an invalid output is stored`).toEqual([]);
        // the same in the DB itself, not only in the DTO (Codex m-S-R2-2, integration decision T2): no item row of that
        // card, and the request added no citation owned by a card item
        expect(one<{ n: number }>(s, `SELECT count(*) AS n FROM paper_card_items WHERE cardId = ?`, failed!.id).n, `${name}: paper_card_items rows`).toBe(0);
        expect(itemCitations(), `${name}: paper_card_item citations added by the request`).toBe(itemCitationsBefore);
      }
      if (typeof entry.expect.items === 'number') {
        // a valid card at the first call (manifest): no repair, run.done, that many items
        expect(used, `${name}: no repair`).toBe(1);
        expect(terminal(res).event, name).toBe('run.done');
        const stored = (await cards(s, SEED_M2_PAPER_ID)).cards.find((c) => c.kind === kind && c.runId === accepted(res)?.data.runId);
        expect(stored?.items, name).toHaveLength(entry.expect.items);
      }
      for (const card of (await cards(s, SEED_M2_PAPER_ID)).cards) {
        expect(card.items.length, name).toBeLessThanOrEqual(60);
        for (const item of card.items) {
          expect([null, 'P', 'N', 'G'], name).toContain(item.label);
          if (item.title !== null) expect(titles.has(item.title), `${name}: ${item.title}`).toBe(true);
          for (const [k, v] of Object.entries(item.attrs)) {
            expect(allowedAttrs[k], `${name}: attr ${k}`).toBeDefined();
            expect(allowedAttrs[k], `${name}: ${k}=${String(v)}`).toContain(v);
          }
          for (const c of item.citations) if (c.kind === 'quote') expect(legitQuotes.has(c.quote!), `${name}: forged quote ${c.quote}`).toBe(true);
        }
      }
    }
    // a normal card (the mock's notation_card output: nothing queued), then the four pairing mismatches on the P item
    // with a verbatim quote and <eq n="1"/>
    expect(llm.pendingOutputs).toBe(0);
    const callsBeforeOk = llm.calls.length;
    const ok = await generate(s, SEED_M2_PAPER_ID, 'notation', uuid());
    expect(llm.calls.slice(callsBeforeOk).map((c) => c.task)).toEqual(['notation_card']);
    expect(terminal(ok).event).toBe('run.done');
    const latest = async () => (await cards(s, SEED_M2_PAPER_ID)).cards.find((c) => c.kind === 'notation' && c.status === 'complete')!;
    const badges = (items: CardItemDto[]) => items.map((it) => itemBadge(it.label, pairCitations(parseAnswer(it.bodyMd, { labels: 'strip' }).citations, it.citations)));
    const card = await latest();
    const target = card.items.find((it) => it.label === 'P' && it.citations.some((c) => c.kind === 'quote' && c.status === 'verbatim') && it.citations.some((c) => c.kind === 'equation' && c.eqNumber === '1'))!;
    expect(target).toBeDefined();
    const eqOnly = card.items.find((it) => it.label === 'P' && it.citations.length > 0 && it.citations.every((c) => c.kind === 'equation' && c.eqNumber === '2'))!;
    expect(eqOnly).toBeDefined();
    const baseCounts = cardBadgeCounts(badges(card.items));
    expect(badges([target])).toEqual(['grounded_quote']);
    expect(badges([eqOnly])).toEqual(['equation_ref']);
    const quoteRow = one<Record<string, unknown>>(s, `SELECT * FROM citations WHERE ownerType = 'paper_card_item' AND ownerId = ? AND kind = 'quote'`, target.id);
    const eqRow = one<Record<string, unknown>>(s, `SELECT * FROM citations WHERE ownerType = 'paper_card_item' AND ownerId = ? AND kind = 'equation'`, target.id);
    const restore = () => {
      s.deps.sqlite.prepare(`DELETE FROM citations WHERE ownerType = 'paper_card_item' AND ownerId = ?`).run(target.id);
      for (const row of [quoteRow, eqRow]) {
        const cols = Object.keys(row);
        s.deps.sqlite.prepare(`INSERT INTO citations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
      }
    };
    const mismatches: [string, () => void][] = [
      ['count', () => s.deps.sqlite.prepare(`DELETE FROM citations WHERE id = ?`).run(quoteRow.id)],
      ['kind', () => s.deps.sqlite.prepare(`UPDATE citations SET kind = 'equation', status = 'resolved', eqNumber = '1', quote = NULL, page = NULL, startOffset = NULL, endOffset = NULL, candidates = NULL WHERE id = ?`).run(quoteRow.id)],
      ['quote', () => s.deps.sqlite.prepare(`UPDATE citations SET quote = 'A different sentence entirely.' WHERE id = ?`).run(quoteRow.id)],
      ['eqNumber', () => s.deps.sqlite.prepare(`UPDATE citations SET eqNumber = '2' WHERE id = ?`).run(eqRow.id)],
    ];
    for (const [name, mutate] of mismatches) {
      mutate();
      const res = await get(s, `/papers/${SEED_M2_PAPER_ID}/cards`);
      expect(res.status, name).toBe(200);
      const c = (res.json as ListCardsResponse).cards.find((x) => x.id === card.id)!;
      const item = c.items.find((it) => it.id === target.id)!;
      expect(pairCitations(parseAnswer(item.bodyMd, { labels: 'strip' }).citations, item.citations), name).toBeNull();
      expect(itemBadge('P', null)).toBe('unconfirmed');
      const counts = cardBadgeCounts(badges(c.items));
      expect(counts.grounded_quote, name).toBe(baseCounts.grounded_quote - 1);
      expect(counts.unconfirmed, name).toBe(baseCounts.unconfirmed + 1);
      expect(counts.equation_ref, name).toBe(baseCounts.equation_ref); // the equation-only item never counts as grounded
      restore();
    }
  });

  it('G4 capture PNG: the prefix is byte-identical to explain and the image is tail[0]; boundaries (4 MiB, +1/+2/+3 B, padding, pad bits, signature, IDAT, CRC, 413); one capture file per request id', async () => {
    const llm = new ControlledAdapter();
    const s = await server({ env: 'prod', papers: ['m2'], llm });
    const P = `/papers/${SEED_M2_PAPER_ID}/threads`;
    const figure = (crid: string, imagePng: string) => ({ kind: 'figure', anchor: AREA, imagePng, clientRequestId: crid });
    expect(terminal(await post(s, P, { kind: 'explain', anchor: TEXT_ANCHOR, text: 'robust kernel', clientRequestId: uuid() })).event).toBe('run.done');
    const png = makeTestPngBase64({ width: 64, height: 48 });
    const F = uuid();
    expect(terminal(await post(s, P, figure(F, png))).event).toBe('run.done');
    expect(JSON.stringify(llm.calls[1]!.prefix)).toBe(JSON.stringify(llm.calls[0]!.prefix));
    expect(llm.calls[1]!.tail[0]!.type).toBe('image');
    // the same request id: resend, two at once, another PNG (409) — one capture file / row, one adapter call
    const capturesDir = s.deps.paths.capturesDir(SEED_M2_PAPER_ID);
    const snapshot = () => ({ ...captureSnapshot(capturesDir, () => captureRows(s)), calls: llm.calls.length });
    const after1 = snapshot();
    expect(after1.files).toHaveLength(1);
    expect(after1.rows).toHaveLength(1);
    // the first capture is the requested PNG byte for byte, and its row says so
    const sent = Buffer.from(png, 'base64');
    expect(after1.rows[0]).toMatchObject({ sha256: sha256(sent), bytes: sent.length });
    expectRowsMatchFiles(after1);
    await post(s, P, figure(F, png));
    await Promise.all([post(s, P, figure(F, png)), post(s, P, figure(F, png))]);
    expect((await post(s, P, figure(F, makeTestPngBase64({ width: 65, height: 48 })))).status).toBe(409);
    expect(snapshot()).toEqual(after1);
    // two requests with a NEW id at once: threads.create runs findExisting → storeCapture → runTask with no await in
    // between, so the second request finds the first one's run in findExisting and attaches there — before
    // storeCapture, so it writes no capture at all. (The runTask race branch of PLAN_M2 3.5 — attached: true → the
    // loser discards its capture, routes/threads.ts startWithCapture — is not reached here; B tests it directly.) The run
    // is held until both have their response headers → one file / row, one adapter call, one runId
    const H = uuid();
    const pngH = makeTestPngBase64({ width: 66, height: 48 });
    const holdH = llm.holdNext();
    const a = openStream(s, P, figure(H, pngH));
    const b = openStream(s, P, figure(H, pngH));
    await startedOrFail(holdH.started, a.done);
    await Promise.all([a.headers, b.headers]);
    holdH.release();
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(accepted(rb)?.data.runId).toBe(accepted(ra)!.data.runId);
    expect([terminal(ra).event, terminal(rb).event]).toEqual(['run.done', 'run.done']);
    const after2 = snapshot();
    expect(after2.files).toHaveLength(2);
    expect(after2.rows).toHaveLength(2);
    expectRowsMatchFiles(after2);
    const sentH = Buffer.from(pngH, 'base64');
    expect(after2.rows.map((r) => r.sha256).sort()).toEqual([sha256(sent), sha256(sentH)].sort());
    expect(after2.rows.filter((r) => after1.rows.some((o) => o.id === r.id))).toEqual(after1.rows); // the first row unchanged
    expect(after2.calls).toBe(after1.calls + 1);
    // size boundaries — PNG bytes, base64 length/padding and the JSON body size of each case
    const MiB4 = 4 * 1024 * 1024;
    const sized = (bytes: number) => makeTestPng({ width: 64, height: 48, padToBytes: bytes });
    const cases: [string, number, number, string, number][] = [
      ['exactly 4 MiB', MiB4, 5_592_408, '==', 200],
      ['+1 B', MiB4 + 1, 5_592_408, '=', 400],
      ['+2 B', MiB4 + 2, 5_592_408, '', 400],
      ['+3 B', MiB4 + 3, 5_592_412, '==', 400],
    ];
    for (const [name, bytes, len, pad, status] of cases) {
      const b64 = sized(bytes).toString('base64');
      expect(b64.length, name).toBe(len);
      expect(b64.endsWith('==') ? '==' : b64.endsWith('=') ? '=' : '', name).toBe(pad);
      const body = JSON.stringify(figure(uuid(), b64));
      expect(Buffer.byteLength(body), name).toBeLessThan(6_291_456);
      const r = await post(s, P, body);
      expect(r.status, name).toBe(status);
      if (status === 400) expect((r.json as { error: { code: string } }).error.code).toBe('validation');
    }
    // padding missing / extra; pad-bit variant (new id AND the id that already succeeded) → 400, never 409
    const eq2 = makeTestPngBase64({ width: 20, height: 20, padToBytes: 1000 });
    expect(eq2.endsWith('==')).toBe(true);
    const variant = eq2.slice(0, -3) + String.fromCharCode(eq2.charCodeAt(eq2.length - 3) + 1) + '==';
    expect(Buffer.from(variant, 'base64').equals(Buffer.from(eq2, 'base64'))).toBe(true);
    const G = uuid();
    expect(terminal(await post(s, P, figure(G, eq2))).event).toBe('run.done');
    const beforeBad = snapshot();
    for (const [name, b64, crid] of [
      ['missing padding', eq2.replace(/=+$/, ''), uuid()],
      ['extra padding', `${eq2}=`, uuid()],
      ['pad bits, new id', variant, uuid()],
      ['pad bits, the succeeded id', variant, G],
    ] as const) {
      const r = await post(s, P, figure(crid, b64));
      expect(r.status, name).toBe(400);
    }
    const broken = (mutate: (b: Buffer) => void) => {
      const b = makeTestPng({ width: 20, height: 20 });
      mutate(b);
      return b.toString('base64');
    };
    const noIdat = Buffer.concat([makeTestPng({ width: 20, height: 20 }).subarray(0, 33), makeTestPng({ width: 20, height: 20 }).subarray(-12)]).toString('base64');
    for (const [name, b64] of [['bad signature', broken((b) => (b[1] = 0x51))], ['bad CRC', broken((b) => (b[b.length - 1]! ^= 1))], ['no IDAT', noIdat]] as const) {
      expect((await post(s, P, figure(uuid(), b64))).status, name).toBe(400);
    }
    expect(snapshot()).toEqual(beforeBad);
    expectRowsMatchFiles(beforeBad);
    // over the 6 MiB request limit → 413; a 4 MiB PNG body is below it
    const huge = JSON.stringify({ ...figure(uuid(), 'A'.repeat(4)), question: 'x'.repeat(6_291_456) });
    expect((await post(s, P, huge)).status).toBe(413);
  });

  it('G5 chat effort: low by default, deep → high; deep refused where the task does not support it; regenerate inherits; deep is part of the identity only when true', async () => {
    const llm = new ControlledAdapter();
    const s = await server({ env: 'prod', papers: ['m2'], llm });
    const P = `/papers/${SEED_M2_PAPER_ID}/threads`;
    const effortOf = (r: Res) => (r.events.find((e) => e.event === 'run.started')?.data as { effort: string } | undefined)?.effort;
    const rowEffort = (r: Res) => one<{ effort: string }>(s, `SELECT effort FROM llm_calls WHERE runId = ?`, accepted(r)!.data.runId).effort;
    const low = await post(s, P, { kind: 'chat', question: 'q low', clientRequestId: uuid() });
    expect([effortOf(low), rowEffort(low)]).toEqual(['low', 'low']);
    const high = await post(s, P, { kind: 'chat', question: 'q deep', deep: true, clientRequestId: uuid() });
    expect([effortOf(high), rowEffort(high)]).toEqual(['high', 'high']);
    expect((await post(s, P, { kind: 'explain', anchor: TEXT_ANCHOR, text: 'robust kernel', deep: true, clientRequestId: uuid() })).status).toBe(400);
    const explain = await post(s, P, { kind: 'explain', anchor: TEXT_ANCHOR, text: 'robust kernel', clientRequestId: uuid() });
    const threadId = accepted(explain)!.data.threadId!;
    const follow = await post(s, `/threads/${threadId}/messages`, { text: 'why?', deep: true, clientRequestId: uuid() });
    expect(effortOf(follow)).toBe('high');
    const regen = await post(s, `/threads/${threadId}/messages`, { text: 'why?', regenerate: true, clientRequestId: uuid() });
    expect(effortOf(regen)).toBe('high');
    expect((await post(s, `/threads/${threadId}/messages`, { text: 'why?', regenerate: true, deep: true, clientRequestId: uuid() })).status).toBe(400);
    const id = uuid();
    const plain = await post(s, P, { kind: 'chat', question: 'same id', clientRequestId: id });
    expect((await post(s, P, { kind: 'chat', question: 'same id', deep: true, clientRequestId: id })).status).toBe(409);
    const asFalse = await post(s, P, { kind: 'chat', question: 'same id', deep: false, clientRequestId: id });
    expect(accepted(asFalse)?.data.runId).toBe(accepted(plain)!.data.runId);
  });

  it('G6 translate: no prefix, sonnet, no fingerprint; tags in the translation produce no citation and no stats', async () => {
    const llm = new ControlledAdapter();
    const s = await server({ env: 'prod', papers: ['m2'], llm });
    llm.queueOutputs(readMockFile(readMockManifest().m2.adversarial.translate_with_tags!.file));
    const r = await post(s, `/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'translate', anchor: TEXT_ANCHOR, text: 'robust kernel', clientRequestId: uuid() });
    expect(terminal(r).event).toBe('run.done');
    expect(llm.calls[0]).toMatchObject({ task: 'translate_selection', model: 'sonnet' });
    expect(llm.calls[0]!.prefix).toHaveLength(0);
    expect(one<{ f: string | null }>(s, `SELECT prefixFingerprint AS f FROM llm_calls WHERE runId = ?`, accepted(r)!.data.runId).f).toBeNull();
    const t = (await get(s, `/threads/${accepted(r)!.data.threadId}`)).json as ThreadDetailResponse;
    const answer = t.messages.find((m) => m.role === 'assistant')!;
    expect(answer.citations).toEqual([]);
    expect(answer.stats).toBeNull();
    expect(llm.calls).toHaveLength(1);
    expect(llm.pendingOutputs).toBe(0);
  });

  it('G7a (A) structure upgrade of an M1 paper: offline HTML, no fetch; supplement v2 next to the unchanged v1; anchors from the M1 PDF; user data unchanged; lastJob stays the ingest job; a second call → 409', async () => {
    const offline = tempDir('sp-offline-');
    copyFileSync(join(FIXTURES, 'synthetic-m2.html'), join(offline, '2301.00002v1.html'));
    const fetchSpy = vi.fn(async () => new Response('', { status: 599 }));
    const s = await server({ env: 'test', papers: ['upgrade'], offlineDir: offline, fetchImpl: fetchSpy });
    const id = SEED_UPGRADE_PAPER_ID;
    const explain1 = await post(s, `/papers/${id}/threads`, { kind: 'explain', anchor: TEXT_ANCHOR, text: 'robust kernel', clientRequestId: uuid() });
    const threadId = accepted(explain1)!.data.threadId!;
    await post(s, `/papers/${id}/highlights`, { kind: 'text', color: 1, quote: { exact: 'robust kernel' }, page: 2, rects: TEXT_ANCHOR.rects });
    const dump = async () => ({ thread: (await get(s, `/threads/${threadId}`)).json, highlights: (await get(s, `/papers/${id}/highlights`)).json });
    const before = await dump();
    const v1 = readFileSync(s.deps.paths.supplementFile(id, 1));
    const fp1 = one<{ f: string }>(s, `SELECT prefixFingerprint AS f FROM llm_calls WHERE runId = ?`, accepted(explain1)!.data.runId).f;
    // the seed's finished ingest job (what M1 import leaves) is lastJob before the upgrade — and must stay it after
    const jobOf = (d: PaperDetailDto) => (d.lastJob === null ? null : { id: d.lastJob.id, kind: d.lastJob.kind, status: d.lastJob.status });
    const lastJobBefore = jobOf((await get(s, `/papers/${id}`)).json as PaperDetailDto);
    expect(lastJobBefore).toEqual({ id: SEED_UPGRADE_INGEST_JOB_ID, kind: 'import_arxiv', status: 'done' });
    const up = await post(s, `/papers/${id}/upgrade-structure`, {});
    expect(up.status).toBe(200);
    const jobId = (up.json as { jobId: string }).jobId;
    const events = (await get(s, `/jobs/${jobId}/events`)).events;
    expect(events.at(-1)!.event).toBe('job.done');
    // step order (integration decision T3, PLAN_M2 3.1): the stream subscribed right after the POST has job.step events of
    // html → structure → anchor → supplement (first appearance, whether replayed or live), every one before job.done, the
    // last of them `supplement ok`, and each step ends ok. checkStream (shared) keeps the first event unspecified.
    const steps = events.filter((e) => e.event === 'job.step').map((e) => e.data as { step: string; status: string });
    expect(events.findIndex((e) => e.event === 'job.done')).toBe(events.length - 1);
    expect([...new Set(steps.map((x) => x.step))]).toEqual(['html', 'structure', 'anchor', 'supplement']);
    expect(steps.at(-1)).toMatchObject({ step: 'supplement', status: 'ok' });
    expect(Object.fromEntries(steps.map((x) => [x.step, x.status]))).toEqual({ html: 'ok', structure: 'ok', anchor: 'ok', supplement: 'ok' });
    // a replay of the finished job (current behaviour, recorded by T3): the four stored steps (ok) and job.done — no
    // job.state (an upgrade job replays its steps only) and never a terminal alone
    const replay = (await get(s, `/jobs/${jobId}/events`)).events.map((e) => (e.event === 'job.step' ? `${(e.data as { step: string }).step}:${(e.data as { status: string }).status}` : e.event));
    expect(replay).toEqual(['html:ok', 'structure:ok', 'anchor:ok', 'supplement:ok', 'job.done']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readFileSync(s.deps.paths.supplementFile(id, 1)).equals(v1)).toBe(true);
    expect(existsSync(s.deps.paths.supplementFile(id, 2))).toBe(true);
    const detail = (await get(s, `/papers/${id}`)).json as PaperDetailDto;
    expect(detail.supplementVersion).toBe(2);
    expect(jobOf(detail)).toEqual(lastJobBefore);
    expect(detail.lastJob?.id).not.toBe(jobId); // the upgrade job never shows up as lastJob
    const st = (await get(s, `/papers/${id}/structure`)).json as StructureResponse;
    expect(st.sections).toHaveLength(4);
    expect(st.equations.some((e) => e.number === '3')).toBe(true);
    const page = (n: string, list: { number: string | null; pdfPage: number | null }[]) => list.find((x) => x.number === n)?.pdfPage ?? null;
    expect([page('I', st.sections), page('II', st.sections)].every((p) => p !== null)).toBe(true);
    expect([page('1', st.equations), page('2', st.equations)].every((p) => p !== null)).toBe(true);
    expect([page('II-A', st.sections), page('II-B', st.sections)]).toEqual([null, null]);
    expect(await dump()).toEqual(before);
    const explain2 = await post(s, `/papers/${id}/threads`, { kind: 'explain', anchor: TEXT_ANCHOR, text: 'robust kernel', clientRequestId: uuid() });
    expect(one<{ f: string }>(s, `SELECT prefixFingerprint AS f FROM llm_calls WHERE runId = ?`, accepted(explain2)!.data.runId).f).not.toBe(fp1);
    expect((await post(s, `/papers/${id}/upgrade-structure`, {})).status).toBe(409);
  });

  it('G7b (B) equation citations on SEED_M2: <eq n="1"/> resolved with equationId and latex; <eq n="A.1"/> ambiguous with 2 candidates', async () => {
    const llm = new ControlledAdapter();
    const s = await server({ env: 'prod', papers: ['m2'], llm });
    llm.queueOutputs('식 <eq n="1"/> 과 부록의 <eq n="A.1"/> 을 본다. [[P]]');
    const r = await post(s, `/papers/${SEED_M2_PAPER_ID}/threads`, { kind: 'explain', anchor: TEXT_ANCHOR, text: 'robust kernel', clientRequestId: uuid() });
    const done = terminal(r);
    expect(done.event).toBe('run.done');
    const cites = (done.data as { citations: Citation[] }).citations;
    expect(cites.find((c) => c.eqNumber === '1')).toMatchObject({ status: 'resolved', equationId: expect.any(String), latex: 'r_{i}=R\\,p_{i}+t-q_{i}' });
    const amb = cites.find((c) => c.eqNumber === 'A.1')!;
    expect(amb.status).toBe('ambiguous');
    expect(amb.eqCandidates).toHaveLength(2);
    expect(llm.calls).toHaveLength(1);
    expect(llm.pendingOutputs).toBe(0);
  });

  itIntegration('G7c (integration) after the upgrade the same paper resolves <eq n="1"/>', async () => {
    const offline = tempDir('sp-offline-');
    copyFileSync(join(FIXTURES, 'synthetic-m2.html'), join(offline, '2301.00002v1.html'));
    const llm = new ControlledAdapter();
    const s = await server({ env: 'test', papers: ['upgrade'], offlineDir: offline, llm });
    const up = await post(s, `/papers/${SEED_UPGRADE_PAPER_ID}/upgrade-structure`, {});
    await get(s, `/jobs/${(up.json as { jobId: string }).jobId}/events`);
    llm.queueOutputs('식 <eq n="1"/> 을 본다. [[P]]');
    const r = await post(s, `/papers/${SEED_UPGRADE_PAPER_ID}/threads`, { kind: 'explain', anchor: TEXT_ANCHOR, text: 'robust kernel', clientRequestId: uuid() });
    expect((terminal(r).data as { citations: Citation[] }).citations.find((c) => c.eqNumber === '1')?.status).toBe('resolved');
  });

  it('G8 glossary.create: citation fields in the request → 400; stored citations come from the server matching against synthetic-m2.pdf', async () => {
    const s = await server({ env: 'prod', papers: ['m2'] });
    const G = `/papers/${SEED_M2_PAPER_ID}/glossary`;
    expect((await post(s, G, { term: 'robust kernel', citations: [{ ordinal: 1, kind: 'quote', quote: 'x', status: 'verbatim', score: 1 }] })).status).toBe(400);
    expect((await post(s, G, { term: 'robust kernel', origin: 'llm' })).status).toBe(400);
    const r = await post(s, G, { term: 'robust kernel', definitionKo: '정의 <q>The robust kernel down-weights outliers in the residual.</q> 와 없는 문장 <q>The method requires a GPU with 24 GB of memory.</q> [[P]]' });
    expect(r.status).toBe(200);
    const statuses = (r.json as { citations: Citation[] }).citations.map((c) => c.status);
    expect(statuses).toEqual(['verbatim', 'not_found']);
  });

  it('G9 request id first (rule 1a): deleted/replaced results replay result_deleted/superseded the same way before and after a restart; tombstones and the 30-day boundary; M1 rows; figure follow-ups; pendingReplace', async () => {
    const llm = new ControlledAdapter();
    let s = await server({ env: 'prod', papers: ['m1', 'm2'], llm, deleteWaitMs: 150 });
    const P = (id = SEED_M2_PAPER_ID) => `/papers/${id}/threads`;
    const noNewWork = async (f: () => Promise<void>) => {
      const before = { calls: rows(s, 'llm_calls'), adapter: llm.calls.length };
      await f();
      expect({ calls: rows(s, 'llm_calls'), adapter: llm.calls.length }).toEqual(before);
    };
    const twice = async (f: (srv: TestServer) => Promise<Res>, check: (r: Res) => void) => {
      check(await f(s)); // (가) right after the deletion — the finished run is still in memory
      s = await restart(s);
      check(await f(s)); // (나) after a restart
    };
    // ① messages.create
    const chat = await post(s, P(), { kind: 'chat', question: 'q', clientRequestId: uuid() });
    const tid = accepted(chat)!.data.threadId!;
    const M = uuid();
    expect(terminal(await post(s, `/threads/${tid}/messages`, { text: 'follow', clientRequestId: M })).event).toBe('run.done');
    expect((await del(s, `/threads/${tid}`)).status).toBe(204);
    await noNewWork(() =>
      twice(
        (srv) => post(srv, `/threads/${tid}/messages`, { text: 'follow', clientRequestId: M }),
        (r) => expect(resultDeleted(r)).toBe(true),
      ),
    );
    await noNewWork(async () => expect((await post(s, `/threads/${tid}/messages`, { text: 'other', clientRequestId: M })).status).toBe(409));
    // ② threads.create
    const T = uuid();
    const created = await post(s, P(), { kind: 'chat', question: 'q2', clientRequestId: T });
    expect((await del(s, `/threads/${accepted(created)!.data.threadId}`)).status).toBe(204);
    await noNewWork(() => twice((srv) => post(srv, P(), { kind: 'chat', question: 'q2', clientRequestId: T }), (r) => expect(resultDeleted(r)).toBe(true)));
    await noNewWork(async () => expect((await post(s, P(), { kind: 'chat', question: 'q3', clientRequestId: T })).status).toBe(409));
    // ③ cards: replaced → superseded
    const C1 = uuid();
    expect(terminal(await generate(s, SEED_M2_PAPER_ID, 'notation', C1)).event).toBe('run.done');
    expect(terminal(await generate(s, SEED_M2_PAPER_ID, 'notation', uuid())).event).toBe('run.done');
    await noNewWork(() => twice((srv) => generate(srv, SEED_M2_PAPER_ID, 'notation', C1), (r) => expect(terminal(r)).toMatchObject({ event: 'run.error', data: { code: 'superseded' } })));
    // ④ glossary.define: replay after a restart; another term → 409
    const D = uuid();
    const define = (srv: TestServer, term = 'robust kernel') => post(srv, `/papers/${SEED_M2_PAPER_ID}/glossary/define`, { term, clientRequestId: D });
    const firstDefine = await define(s);
    expect(terminal(firstDefine).event).toBe('run.done');
    s = await restart(s);
    await noNewWork(async () => {
      const again = await define(s);
      expect((terminal(again).data as { parsed: unknown }).parsed).toEqual((terminal(firstDefine).data as { parsed: unknown }).parsed);
    });
    await noNewWork(async () => expect((await define(s, 'residual')).status).toBe(409));
    // 30-day boundary (Date only is faked; no restart)
    const finishedAt = one<{ f: number }>(s, `SELECT finishedAt AS f FROM llm_calls WHERE clientRequestId = ?`, D).f;
    // every boundary point is a replay or a result_deleted answer: no new llm_calls row, no adapter call
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(finishedAt + 30 * DAY - 1);
    await noNewWork(async () => {
      const r = await define(s);
      expect(r.events.map((e) => e.event)).toEqual(['run.accepted', 'run.done']);
      expect((terminal(r).data as { parsed: unknown }).parsed).toEqual((terminal(firstDefine).data as { parsed: unknown }).parsed);
    });
    for (const t of [finishedAt + 30 * DAY, finishedAt + 30 * DAY + 1]) {
      vi.setSystemTime(t);
      await noNewWork(async () => expect(resultDeleted(await define(s))).toBe(true));
    }
    vi.useRealTimers();
    // ③/④ paper deleted — immediately (204) and while the deletion is deferred (a held run ignores the abort and, once
    // released, still answers its result: a late result after the deletion's cancel — B-CX-2)
    const C2 = uuid();
    expect(terminal(await generate(s, SEED_M2_PAPER_ID, 'assumptions', C2)).event).toBe('run.done');
    const D2 = uuid();
    expect(terminal(await post(s, `/papers/${SEED_M2_PAPER_ID}/glossary/define`, { term: 'kernel', clientRequestId: D2 })).event).toBe('run.done');
    const hold = llm.holdNext({ ignoreAbort: true, lateResult: true });
    const STUCK = uuid();
    const stuckBody = { kind: 'chat', question: 'stuck', clientRequestId: STUCK };
    const stuck = startStream(s, P(), stuckBody);
    await startedOrFail(hold.started, stuck);
    expect((await del(s, `/papers/${SEED_M2_PAPER_ID}`)).status).toBe(204);
    expect(one<{ d: number | null } | undefined>(s, `SELECT deletingAt AS d FROM papers WHERE id = ?`, SEED_M2_PAPER_ID)?.d).toEqual(expect.any(Number)); // tombstone kept (deferred)
    expect(one<{ r: string | null }>(s, `SELECT resultRaw AS r FROM llm_calls WHERE clientRequestId = ?`, D2).r).toBeNull();
    await noNewWork(async () => {
      expect(resultDeleted(await post(s, `/papers/${SEED_M2_PAPER_ID}/glossary/define`, { term: 'kernel', clientRequestId: D2 }))).toBe(true);
      expect(resultDeleted(await generate(s, SEED_M2_PAPER_ID, 'assumptions', C2))).toBe(true);
    });
    // PLAN_M2 9절 60 ② (B-F2-01, B-CX-1): a resend of the held run's id while the deletion is still deferred answers
    // from the tombstone — run.accepted + run.error{result_deleted}, no run.delta, no new llm_calls row, no adapter call —
    // without attaching to the live log (an attach could only end after the held call ends; the 10 s race is a loose
    // bound, the answer needs no LLM)
    await noNewWork(async () => {
      const resend = startStream(s, P(), stuckBody);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const early = await Promise.race([resend, new Promise<null>((r) => (timer = setTimeout(() => r(null), 10_000)))]);
      clearTimeout(timer);
      if (early === null) hold.release(); // let the attached stream end, so the failure below shows what it answered
      const r = early ?? (await resend);
      expect(early, `the resend waited for the held run (attached to its live log): ${r.events.map((e) => e.event).join(', ')}`).not.toBeNull();
      expect(r.events.filter((e) => e.event === 'run.delta')).toEqual([]);
      expect(resultDeleted(r)).toBe(true);
    });
    hold.release();
    const stuckRes = await stuck;
    await waitFor(() => one<{ n: number }>(s, `SELECT count(*) AS n FROM papers WHERE id = ?`, SEED_M2_PAPER_ID).n === 0, 'deferred cleanup');
    // PLAN_M2 9절 60 ① (B-F2-01, B-CX-2): the deferred deletion cancelled the held run; the adapter still answered a
    // result after the release (lateResult), and that late result is not stored — the run ends like the cancel path —
    // run.error{cancelled}, no run.done, its llm_calls row `cancelled` (≠ ok).
    // (Not result_deleted: that is the answer to a resend, above, and to an owner removed without a cancel.)
    expect(terminal(stuckRes)).toMatchObject({ event: 'run.error', data: { code: 'cancelled' } });
    expect(stuckRes.events.filter((e) => e.event === 'run.done')).toEqual([]);
    expect(one<{ st: string }>(s, `SELECT status AS st FROM llm_calls WHERE clientRequestId = ?`, STUCK).st).toBe('cancelled');
    // after the cleanup (가) and after a restart (나): the same answer, nothing new
    const afterDelete = async () => {
      expect(resultDeleted(await post(s, `/papers/${SEED_M2_PAPER_ID}/glossary/define`, { term: 'kernel', clientRequestId: D2 }))).toBe(true);
      expect(resultDeleted(await generate(s, SEED_M2_PAPER_ID, 'assumptions', C2))).toBe(true);
    };
    await noNewWork(afterDelete);
    s = await restart(s);
    await noNewWork(afterDelete);
    // ⑤ M1 rows (v1 hash) → 409 payload_version with the runId, nothing new
    // The M1 (v1) payload hash, written out here from the M1 rule (task + paper + thread + sorted defined inputs + image).
    const legacyPayloadHash = (o: { task: string; paperId: string; threadId?: string; inputs: Record<string, string | undefined> }) =>
      createHash('sha256')
        .update(JSON.stringify({ task: o.task, paperId: o.paperId, threadId: o.threadId ?? null, inputs: Object.entries(o.inputs).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), image: null }))
        .digest('hex');
    const V = uuid();
    const inputs = { selection: undefined, page: undefined, question: 'old question' };
    const legacyHash = legacyPayloadHash({ task: 'chat', paperId: SEED_PAPER_ID, inputs });
    s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, model, effort, status, acceptedAt) VALUES ('m1-run', ?, ?, 'chat', ?, 'opus', 'medium', 'ok', 1)`).run(V, legacyHash, SEED_PAPER_ID);
    await noNewWork(async () => {
      const r = await post(s, P(SEED_PAPER_ID), { kind: 'chat', question: 'old question', clientRequestId: V });
      expect(r.status).toBe(409);
      expect((r.json as { error: { details: unknown } }).error.details).toEqual({ reason: 'payload_version', runId: 'm1-run' });
    });
    const t1 = accepted(await post(s, P(SEED_PAPER_ID), { kind: 'chat', question: 'base', clientRequestId: uuid() }))!.data.threadId!;
    const W = uuid();
    const mInputs = { question: 'old follow-up', regenerate: undefined };
    s.deps.sqlite.prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, threadId, model, effort, status, acceptedAt) VALUES ('m1-run-2', ?, ?, 'chat', ?, ?, 'opus', 'medium', 'ok', 1)`).run(W, legacyPayloadHash({ task: 'chat', paperId: SEED_PAPER_ID, threadId: t1, inputs: mInputs }), SEED_PAPER_ID, t1);
    await noNewWork(async () => {
      const r = await post(s, `/threads/${t1}/messages`, { text: 'old follow-up', clientRequestId: W });
      expect(r.status).toBe(409);
      expect((r.json as { error: { details: unknown } }).error.details).toEqual({ reason: 'payload_version', runId: 'm1-run-2' });
    });
    // ⑥ a figure thread's follow-up re-attaches the stored capture (tail[0] image), the same id is the same run, after the thread is deleted → result_deleted
    const fig = await post(s, P(SEED_PAPER_ID), { kind: 'figure', anchor: AREA, imagePng: makeTestPngBase64({ width: 40, height: 30 }), clientRequestId: uuid() });
    const figThread = accepted(fig)!.data.threadId!;
    const Q = uuid();
    const q1 = await post(s, `/threads/${figThread}/messages`, { text: 'and this?', clientRequestId: Q });
    expect(llm.calls.at(-1)!.tail[0]!.type).toBe('image');
    await noNewWork(async () => {
      const q2 = await post(s, `/threads/${figThread}/messages`, { text: 'and this?', clientRequestId: Q });
      expect(q2.status).toBe(200);
      expect(accepted(q2)?.data.runId).toBe(accepted(q1)!.data.runId);
    });
    expect((await del(s, `/threads/${figThread}`)).status).toBe(204);
    await noNewWork(async () => expect(resultDeleted(await post(s, `/threads/${figThread}/messages`, { text: 'and this?', clientRequestId: Q }))).toBe(true));
    // pendingReplace=1 turn in the DB → the restart deletes it and keeps the old turn
    const t2 = accepted(await post(s, P(SEED_PAPER_ID), { kind: 'chat', question: 'keep me', clientRequestId: uuid() }))!.data.threadId!;
    const oldTurn = s.deps.sqlite.prepare(`SELECT id FROM messages WHERE threadId = ? ORDER BY createdAt`).all(t2);
    s.deps.sqlite.prepare(`INSERT INTO messages (id, threadId, role, contentMd, status, pendingReplace, createdAt) VALUES (?, ?, 'user', 'new q', 'complete', 1, ?), (?, ?, 'assistant', 'partial', 'streaming', 1, ?)`).run(uuid(), t2, Date.now() + 10, uuid(), t2, Date.now() + 11);
    s = await restart(s);
    expect(s.deps.sqlite.prepare(`SELECT id FROM messages WHERE threadId = ? ORDER BY createdAt`).all(t2)).toEqual(oldTurn);
  }, 120_000);
});

// The gate's own checks are tested in every run (not gated by SP_GATE_MILESTONE): each must fail on a wrong input.
describe('M2 gate helpers (always run)', () => {
  const ev = (event: string) => ({ event });
  it('checkStream (m-S-3): accepts one terminal at the end; fails on two terminals, an event after the terminal, no run.accepted, or a foreign family', () => {
    expect(() => checkStream(['run.accepted', 'run.started', 'run.delta', 'run.done'].map(ev), 'run')).not.toThrow();
    expect(() => checkStream(['run.accepted', 'run.error'].map(ev), 'run')).not.toThrow();
    expect(() => checkStream(['job.step', 'job.state', 'job.done'].map(ev), 'job')).not.toThrow();
    for (const [name, events, family] of [
      ['two terminals (error then done)', ['run.accepted', 'run.error', 'run.done'], 'run'],
      ['two terminals (done twice)', ['run.accepted', 'run.done', 'run.done'], 'run'],
      ['an event after the terminal', ['run.accepted', 'run.done', 'run.delta'], 'run'],
      ['no run.accepted', ['run.started', 'run.done'], 'run'],
      ['run.accepted not first', ['run.started', 'run.accepted', 'run.done'], 'run'],
      ['no terminal', ['run.accepted', 'run.delta'], 'run'],
      ['empty', [], 'run'],
      ['a job event in a run stream', ['run.accepted', 'job.step', 'run.done'], 'run'],
      ['two job terminals', ['job.step', 'job.error', 'job.done'], 'job'],
      ['a job event after job.done', ['job.done', 'job.step'], 'job'],
    ] as const) {
      expect(() => checkStream(events.map(ev), family), name).toThrow();
    }
  });

  it('toRes applies checkStream to every SSE response (run and jobs.events), never to JSON', () => {
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const acceptedFrame = frame('run.accepted', { runId: '00000000-0000-4000-8000-0000000000aa', task: 'chat' });
    const err = frame('run.error', { code: 'cancelled', message: 'x', retryable: false });
    const sse = 'text/event-stream; charset=utf-8';
    // the frames must parse; then only the stream rule decides
    expect(parseSse(acceptedFrame + err).map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
    expect(() => toRes('/papers/p/threads', 200, sse, acceptedFrame + err)).not.toThrow();
    expect(() => toRes('/papers/p/threads', 200, sse, acceptedFrame + err + err)).toThrow();
    expect(() => toRes('/papers/p/threads', 200, sse, err)).toThrow();
    expect(() => toRes('/jobs/j/events', 200, sse, frame('job.done', { paperId: 'p' }))).not.toThrow();
    expect(() => toRes('/jobs/j/events', 200, sse, frame('job.done', { paperId: 'p' }) + frame('job.done', { paperId: 'p' }))).toThrow();
    expect(toRes('/papers/p/threads', 409, 'application/json', '{"error":{"code":"conflict"}}').events).toEqual([]);
  });

  it('captureSnapshot (m-S-1): a file rewritten with the same length but one different byte, or a row with another sha256, changes the snapshot', () => {
    const dir = tempDir('sp-gate-snap-');
    const png = makeTestPng({ width: 8, height: 8 });
    const id = '00000000-0000-4000-8000-0000000000c1';
    writeFileSync(join(dir, `${id}.png`), png);
    let rowList: CaptureRow[] = [{ id, sha256: sha256(png), bytes: png.length }];
    const snap = () => captureSnapshot(dir, () => rowList);
    const before = snap();
    expectRowsMatchFiles(before);
    expect(snap()).toEqual(before);
    // one byte flipped, same length
    const changed = Buffer.from(png);
    changed[changed.length - 20]! ^= 0xff;
    writeFileSync(join(dir, `${id}.png`), changed);
    const after = snap();
    expect(after.files[0]!.bytes).toBe(before.files[0]!.bytes);
    expect(after).not.toEqual(before);
    expect(() => expectRowsMatchFiles(after)).toThrow();
    // the row's sha256 changed (file restored)
    writeFileSync(join(dir, `${id}.png`), png);
    expect(snap()).toEqual(before);
    rowList = [{ id, sha256: sha256(changed), bytes: png.length }];
    expect(snap()).not.toEqual(before);
    expect(() => expectRowsMatchFiles(snap())).toThrow();
  });
});
