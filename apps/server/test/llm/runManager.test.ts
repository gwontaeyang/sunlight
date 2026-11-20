// runContract.ts rules 1–6 against the real run manager + ClaudeCliAdapter + fake-claude (strict). Owner B.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/db/client';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { HttpError } from '../../src/deps';
import { CHILD_KILL_GRACE_MS } from '../../src/lifecycle';
import { TASK_SPECS } from '@study-paper/shared/contracts/tasks';
import { payloadHash, PROMPT_VERSION, resolveEffort } from '../../src/llm/runManager';
import { alive } from './fakeCli';
import { events, makeRunEnv, request, terminalOf, threadRows, waitFor } from './runEnv';

const row = (env: Awaited<ReturnType<typeof makeRunEnv>>, runId: string) => env.sqlite.prepare(`SELECT * FROM llm_calls WHERE runId = ?`).get(runId) as Record<string, unknown>;
const msg = (env: Awaited<ReturnType<typeof makeRunEnv>>, id: string) => env.sqlite.prepare(`SELECT status, contentMd, llmCallId FROM messages WHERE id = ?`).get(id) as { status: string; contentMd: string; llmCallId: string } | undefined;

describe('runManager × fake-claude', () => {
  it('a run: accepted → started → response_started → delta… → done; rows terminal; child gone when done resolves', async () => {
    const env = await makeRunEnv();
    const rows = threadRows();
    const h = env.manager.runTask(request({ startRows: rows }));
    const ev = await events(h);
    await h.done;
    expect(ev[0]).toMatchObject({ event: 'run.accepted', data: { runId: h.runId, task: 'explain_selection', threadId: rows.ids.threadId, messageId: rows.ids.messageId } });
    expect(ev.map((e) => e.event)).toEqual(expect.arrayContaining(['run.started', 'run.response_started', 'run.delta']));
    expect(terminalOf(ev)).toHaveLength(1);
    expect(ev.at(-1)!.event).toBe('run.done');
    expect(row(env, h.runId)).toMatchObject({ status: 'ok', model: 'opus', modelResolved: 'fake-opus-model', cliVersion: '0.0.0-fake', promptVersion: PROMPT_VERSION, contextMode: 'pdf', cacheReadTokens: 3000, cacheCreationTokens: 120, payloadHash: expect.any(String), prefixFingerprint: expect.any(String) });
    expect(msg(env, rows.ids.messageId!)).toMatchObject({ status: 'complete', llmCallId: h.runId });
    expect(env.pids).toHaveLength(1);
    expect(alive(env.pids[0]!)).toBe(false);
    env.close();
  });

  describe('rule 1: identity', () => {
    it('same id + same payload while running → attached to the live run (one row, one child)', async () => {
      const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: 'slow' } });
      const req = request();
      const a = env.manager.runTask(req);
      const b = env.manager.runTask({ ...req, startRows: threadRows() });
      expect(b).toMatchObject({ runId: a.runId, attached: true });
      const [ea, eb] = await Promise.all([events(a), events(b)]);
      expect(eb).toEqual(ea);
      expect(env.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls WHERE clientRequestId = ?`).get(req.clientRequestId)).toEqual({ n: 1 });
      expect(env.sqlite.prepare(`SELECT count(*) AS n FROM threads`).get()).toEqual({ n: 1 });
      expect(env.pids).toHaveLength(1);
      env.close();
    });

    it('same id + another payload → 409 conflict, live or finished; the finished run is replayed from the DB after eviction and after a restart', async () => {
      const env = await makeRunEnv({ deps: { retention: { max: 0, ms: 60_000 } } });
      const req = request();
      const first = await events(env.manager.runTask(req));
      expect(() => env.manager.runTask({ ...req, inputs: { selection: 'something else' } })).toThrow(HttpError);
      try {
        env.manager.runTask({ ...req, inputs: { selection: 'something else' } });
      } catch (e) {
        expect(e).toMatchObject({ status: 409, code: 'conflict' });
      }
      // Evicted at once (max 0): the repeat is rebuilt from the DB: run.accepted + run.done, identical ids.
      const again = env.manager.runTask({ ...req, startRows: threadRows() });
      expect(again.attached).toBe(true);
      const replay = await events(again);
      expect(replay.map((e) => e.event)).toEqual(['run.accepted', 'run.done']);
      expect(replay[0]).toEqual(first[0]);
      expect(replay[1]!.data).toMatchObject({ text: (first.at(-1)!.data as { text: string }).text });
      expect((replay[1]!.data as { citations: unknown[] }).citations).toEqual((first.at(-1)!.data as { citations: unknown[] }).citations);
      // A new manager on the same DB (server restart) decides from llm_calls.payloadHash.
      const m2 = env.restart();
      expect((await events(m2.runTask({ ...req, startRows: threadRows() })))[0]).toEqual(first[0]);
      expect(() => m2.runTask({ ...req, inputs: { selection: 'x' } })).toThrow(/different request/);
      expect(env.pids).toHaveLength(1);
      env.close();
    });

    it('payload identity covers task, paper, existing thread, inputs and image', () => {
      const base = { task: 'chat' as const, clientRequestId: 'x', paperId: 'p', inputs: { question: 'q', selection: undefined } };
      const h = payloadHash(base);
      expect(payloadHash({ ...base, inputs: { question: 'q' } })).toBe(h); // undefined values do not count
      expect(payloadHash({ ...base, clientRequestId: 'y' })).toBe(h);
      for (const other of [{ ...base, task: 'explain_selection' as const }, { ...base, paperId: 'p2' }, { ...base, threadId: 't' }, { ...base, inputs: { question: 'q2' } }, { ...base, imagePngBase64: 'AAAA' }]) expect(payloadHash(other)).not.toBe(h);
    });

    it('with an explicit identity (the routes): the normalised request decides, key order and undefined members do not; DB-derived task/inputs do not', () => {
      const anchor = { kind: 'text', quote: { exact: 'x', prefix: 'a' }, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.04 }] };
      const base = { task: 'chat' as const, clientRequestId: 'x', paperId: 'p', inputs: { question: 'q' }, identity: { kind: 'explain', anchor, extra: undefined } };
      const h = payloadHash(base);
      expect(payloadHash({ ...base, identity: { anchor: { rects: [{ h: 0.04, w: 0.3, y: 0.2, x: 0.1, page: 1 }], quote: { prefix: 'a', exact: 'x' }, kind: 'text' }, kind: 'explain' } })).toBe(h);
      expect(payloadHash({ ...base, task: 'explain_selection', inputs: { question: 'other', history: 'h' } })).toBe(h);
      for (const identity of [{ kind: 'chat', anchor }, { kind: 'explain', anchor: { ...anchor, quote: { exact: 'x', prefix: 'b' } } }, { kind: 'explain', anchor: { ...anchor, rects: [] } }, { kind: 'explain', anchor: { ...anchor, position: { page: 1, start: 0, end: 1 } } }]) {
        expect(payloadHash({ ...base, identity })).not.toBe(h);
      }
      expect(payloadHash({ ...base, imagePngBase64: 'AAAA' })).not.toBe(h);
      expect(payloadHash({ ...base, threadId: 't' })).not.toBe(h);
    });
  });

  describe('rule 2: atomic start', () => {
    it('a failing owner insert leaves nothing behind (no llm_calls row, no thread)', async () => {
      const env = await makeRunEnv();
      const req = request({
        startRows: {
          insert: (tx) => {
            threadRows().insert(tx, 'x');
            throw new HttpError(409, 'conflict', 'refused');
          },
        },
      });
      expect(() => env.manager.runTask(req)).toThrow(/refused/);
      expect(env.sqlite.prepare(`SELECT (SELECT count(*) FROM llm_calls) AS c, (SELECT count(*) FROM threads) AS t, (SELECT count(*) FROM messages) AS m`).get()).toEqual({ c: 0, t: 0, m: 0 });
      env.close();
    });

    it('losing the unique-index race to another writer attaches to the winner instead of failing', async () => {
      const env = await makeRunEnv();
      const req = request();
      const winner = randomUUID();
      const other = openSqlite(env.paths.dbFile);
      const h = env.manager.runTask({
        ...req,
        startRows: {
          insert: (tx, runId) => {
            // Another process commits the same clientRequestId between our lookup and our insert.
            other
              .prepare(`INSERT INTO llm_calls (runId, clientRequestId, payloadHash, task, paperId, model, effort, status, errorCode, acceptedAt, finishedAt) VALUES (?, ?, ?, 'explain_selection', ?, 'opus', 'low', 'cancelled', 'cancelled', 1, 2)`)
              .run(winner, req.clientRequestId, payloadHash(req), SEED_PAPER_ID);
            return threadRows().insert(tx, runId);
          },
        },
      });
      other.close();
      expect(h).toMatchObject({ runId: winner, attached: true });
      expect((await events(h)).map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
      expect(env.sqlite.prepare(`SELECT count(*) AS n FROM threads`).get()).toEqual({ n: 0 });
      expect(env.pids).toHaveLength(0);
      env.close();
    });
  });

  describe('rule 3: events', () => {
    it('late subscribers replay from run.accepted; a subscriber that stops reading does not stop the run', async () => {
      const env = await makeRunEnv();
      const h = env.manager.runTask(request());
      for await (const e of h.subscribe()) {
        expect(e.event).toBe('run.accepted');
        break; // stop reading
      }
      await h.done;
      const late = await events(env.manager.runs.get(h.runId)!);
      expect(late[0]!.event).toBe('run.accepted');
      expect(late.at(-1)!.event).toBe('run.done');
      expect(terminalOf(late)).toHaveLength(1);
      env.close();
    });
  });

  describe('rule 4: persistence', () => {
    it('thread deleted while the run is in flight → the run ends, nothing is inserted, llm_calls still terminal', async () => {
      const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: 'slow' } });
      const rows = threadRows();
      const h = env.manager.runTask(request({ startRows: rows }));
      const ev: string[] = [];
      const codes: string[] = [];
      const reading = (async () => {
        for await (const e of h.subscribe()) {
          ev.push(e.event);
          if (e.event === 'run.error') codes.push(e.data.code);
        }
      })();
      await waitFor(() => ev.includes('run.delta'), 'first delta');
      env.sqlite.prepare(`DELETE FROM threads WHERE id = ?`).run(rows.ids.threadId);
      await h.done;
      await reading;
      // M2 B-CX-2 (coordinator notes 추가 지시 4, Codex M-M2-2): a result whose owner was deleted is not a success —
      // terminal run.error{result_deleted} (no run.done), the row is not ok (cancelled + result_deleted), usage kept
      expect(ev.at(-1)).toBe('run.error');
      expect(ev).not.toContain('run.done');
      expect(codes).toEqual(['result_deleted']);
      expect(env.sqlite.prepare(`SELECT (SELECT count(*) FROM messages) AS m, (SELECT count(*) FROM citations) AS c`).get()).toEqual({ m: 0, c: 0 });
      expect(row(env, h.runId)).toMatchObject({ status: 'cancelled', errorCode: 'result_deleted', threadId: null, outputTokens: expect.any(Number) });
      expect(alive(env.pids[0]!)).toBe(false);
      env.close();
    });

    it('missing usage fields are stored as null, not 0', async () => {
      const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_CACHE: 'missing' } });
      const h = env.manager.runTask(request());
      await h.done;
      expect(row(env, h.runId)).toMatchObject({ status: 'ok', inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, outputTokens: 42, cacheMissUnexpected: null });
      env.close();
    });

    it('cache observation: same fingerprint within 50 min and a cache read of 0 → cacheMissUnexpected', async () => {
      const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_CACHE: 'cold' } });
      const a = env.manager.runTask(request());
      await a.done;
      const b = env.manager.runTask(request());
      await b.done;
      env.fakeEnv.FAKE_CLAUDE_CACHE = 'hit';
      const c = env.manager.runTask(request());
      await c.done;
      expect([a, b, c].map((h) => row(env, h.runId).cacheMissUnexpected)).toEqual([0, 1, 0]);
      expect(new Set([a, b, c].map((h) => row(env, h.runId).prefixFingerprint)).size).toBe(1);
      env.close();
    });

    it('an adapter error keeps the partial text in the message and the stderr detail only in llm_calls', async () => {
      const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: 'no_result_exit' } });
      const rows = threadRows();
      const h = env.manager.runTask(request({ startRows: rows }));
      const ev = await events(h);
      expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cli_error', retryable: true, partialText: expect.stringContaining('합성 답변') } });
      expect(JSON.stringify(ev)).not.toContain('fake-claude:');
      expect(row(env, h.runId)).toMatchObject({ status: 'error', errorCode: 'cli_error', errorDetail: expect.stringContaining('exiting without result') });
      expect(msg(env, rows.ids.messageId!)).toMatchObject({ status: 'error', contentMd: expect.stringContaining('합성 답변') });
      env.close();
    });
  });

  describe('rule 5: cancel', () => {
    it('running → SIGINT, cancelled, child gone; terminal → no-op; unknown → unknown', async () => {
      const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: 'hang_after_init' } });
      const rows = threadRows();
      const h = env.manager.runTask(request({ startRows: rows }));
      await waitFor(() => env.pids.length === 1 && row(env, h.runId).modelResolved !== null, 'started');
      expect(env.manager.runs.cancel(h.runId)).toBe('cancelled');
      const ev = await events(h);
      await h.done;
      expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'cancelled', retryable: false } });
      expect(row(env, h.runId)).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });
      expect(msg(env, rows.ids.messageId!)?.status).toBe('cancelled');
      expect(alive(env.pids[0]!)).toBe(false);
      expect(env.manager.runs.cancel(h.runId)).toBe('already_terminal');
      expect(row(env, h.runId).status).toBe('cancelled');
      expect(env.manager.runs.cancel('nope')).toBe('unknown');
      env.close();
    });

    it('queued → removed from the queue without a child', async () => {
      const env = await makeRunEnv({ fakeEnv: { FAKE_CLAUDE_SCENARIO: 'hang_after_init' }, deps: { concurrency: { interactive: 1, background: 1 } } });
      const a = env.manager.runTask(request());
      const b = env.manager.runTask(request());
      const evB: string[] = [];
      const reading = (async () => {
        for await (const e of b.subscribe()) evB.push(e.event);
      })();
      await waitFor(() => evB.includes('run.queued'), 'b queued');
      expect(env.manager.runs.cancel(b.runId)).toBe('cancelled');
      await b.done;
      await reading;
      expect(evB).toEqual(['run.accepted', 'run.queued', 'run.error']);
      expect(row(env, b.runId)).toMatchObject({ status: 'cancelled', startedAt: null });
      env.manager.runs.cancel(a.runId);
      await a.done;
      expect(env.pids).toHaveLength(1);
      env.close();
    });
  });

  describe('rule 6: shutdown', () => {
    it('drain: running (SIGINT ignored → SIGKILL), queued and an unsubscribed background run end terminal; every child is gone before drain resolves', async () => {
      const env = await makeRunEnv({
        fakeEnv: { FAKE_CLAUDE_SCENARIO: 'hang_after_init', FAKE_CLAUDE_IGNORE_SIGINT: '1' },
        deps: { concurrency: { interactive: 1, background: 1 }, taskTemplates: { summary: '논문을 요약한다.' } },
      });
      const interactive = threadRows();
      const background = threadRows();
      const queued = threadRows();
      const hi = env.manager.runTask(request({ startRows: interactive }));
      // A background artifact run nobody is subscribed to (its connection is long gone).
      const hb = env.manager.runTask(request({ inputs: {}, startRows: background }, 'summary'));
      const hq = env.manager.runTask(request({ startRows: queued }));
      await waitFor(() => env.pids.length === 2, 'two children');
      await waitFor(() => (env.sqlite.prepare(`SELECT count(*) AS n FROM llm_calls WHERE modelResolved IS NOT NULL`).get() as { n: number }).n === 2, 'both started');
      const t0 = Date.now();
      const reports = await env.lifecycle.drain(6_000);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(CHILD_KILL_GRACE_MS - 50); // SIGINT was ignored → SIGKILL
      expect(reports).toEqual([expect.objectContaining({ name: 'llm-runs', ok: true, activeBefore: 3, activeAfter: 0 })]);
      for (const pid of env.pids) expect(alive(pid)).toBe(false);
      const statuses = env.sqlite.prepare(`SELECT runId, status, errorCode FROM llm_calls`).all() as { runId: string; status: string }[];
      expect(statuses.map((s) => s.status).sort()).toEqual(['cancelled', 'cancelled', 'cancelled']);
      for (const r of [interactive, background, queued]) expect(msg(env, r.ids.messageId!)?.status).toBe('cancelled');
      expect(row(env, hb.runId)).toMatchObject({ task: 'summary', status: 'cancelled' });
      // After shutdown began: accepted, then cancelled without a child.
      const late = env.manager.runTask(request());
      expect((await events(late)).map((e) => e.event)).toEqual(['run.accepted', 'run.error']);
      expect(env.pids).toHaveLength(2);
      void hi;
      void hq;
      env.close();
    }, 20_000);
  });

  it('effort comes from TASK_SPECS in one place: llm_calls.effort, run.started and the CLI --effort follow a change there', async () => {
    const env = await makeRunEnv();
    const record = join(env.root, 'effort-record.json');
    env.fakeEnv.FAKE_CLAUDE_RECORD = record;
    const before = TASK_SPECS.explain_selection.effort;
    TASK_SPECS.explain_selection.effort = 'high';
    try {
      expect(resolveEffort('explain_selection')).toBe('high');
      const h = env.manager.runTask(request());
      const ev = await events(h);
      expect(ev.find((e) => e.event === 'run.started')).toMatchObject({ data: { effort: 'high' } });
      expect(env.sqlite.prepare(`SELECT effort FROM llm_calls WHERE runId = ?`).get(h.runId)).toEqual({ effort: 'high' });
      const argv = (JSON.parse(readFileSync(record, 'utf8')) as { argv: string[] }).argv;
      expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
    } finally {
      TASK_SPECS.explain_selection.effort = before;
      env.close();
    }
  });

  describe('paper context at run start', () => {
    it('supplement changed on disk (sha mismatch) → context_not_ready, no child', async () => {
      const env = await makeRunEnv();
      writeFileSync(join(env.paths.paperDir(SEED_PAPER_ID), 'supplement.txt'), 'tampered');
      const ev = await events(env.manager.runTask(request()));
      expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'context_not_ready' } });
      expect(env.pids).toHaveLength(0);
      env.close();
    });
    it("contextMode 'text' → too_large until M3, no child", async () => {
      const env = await makeRunEnv();
      env.sqlite.prepare(`UPDATE papers SET contextMode = 'text' WHERE id = ?`).run(SEED_PAPER_ID);
      const ev = await events(env.manager.runTask(request()));
      expect(ev.at(-1)).toMatchObject({ event: 'run.error', data: { code: 'too_large' } });
      expect(env.pids).toHaveLength(0);
      env.close();
    });
  });

  it('finished handles are bounded (max) and dropped after their retention time', async () => {
    const env = await makeRunEnv({ deps: { retention: { max: 2, ms: 300 } } });
    const hs = [];
    for (let i = 0; i < 3; i++) {
      const h = env.manager.runTask(request());
      await h.done;
      hs.push(h);
    }
    expect(hs.map((h) => env.manager.runs.get(h.runId) !== null)).toEqual([false, true, true]);
    await new Promise((r) => setTimeout(r, 400));
    expect(hs.map((h) => env.manager.runs.get(h.runId) !== null)).toEqual([false, false, false]);
    expect(env.manager.runs.status(hs[0]!.runId)).toBe('ok');
    env.close();
  });
});
