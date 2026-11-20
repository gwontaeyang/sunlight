// The capture-discard branch of threads.create for a runTask that answers `attached: true` (captures.ts call-order
// contract 5: a concurrent resend won the start, so this request's capture was never committed). Today that branch
// is unreachable through HTTP — the second request of the same id ends at findExisting before storeCapture (gate G4)
// — so it is tested directly (review X-I10-02, coordinator notes 추가 지시 8 B 5): a stubbed runTask that answers
// attached → no capture file and no files row; a throw → the same; a start that committed the row → the file stays.
// Owner B.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSseEvent } from '@study-paper/shared/contracts/sse';
import { storeCapture } from '../../src/captures';
import { SEED_M2_PAPER_ID } from '../../src/dev/seedFixture';
import type { RunHandle } from '../../src/llm/runContract';
import type { RunTaskRequest } from '../../src/llm/runManager';
import { startWithCapture } from '../../src/routes/threads';
import { makeTestPngBase64 } from '../helpers/png';
import { ControlledAdapter, startTestServer, type TestServer } from '../helpers/server';

let s: TestServer;
afterEach(async () => {
  await s?.close();
});
const captureState = () => {
  const dir = s.deps.paths.capturesDir(SEED_M2_PAPER_ID);
  return {
    files: existsSync(dir) ? readdirSync(dir).length : 0,
    rows: (s.deps.sqlite.prepare(`SELECT count(*) AS n FROM files WHERE kind = 'capture' AND paperId = ?`).get(SEED_M2_PAPER_ID) as { n: number }).n,
  };
};
const attachedHandle: RunHandle = { runId: 'won-by-another-request', attached: true, subscribe: async function* () {}, cancel: () => {}, done: Promise.resolve() };
const INPUT = { task: 'figure_area', clientRequestId: 'x', paperId: SEED_M2_PAPER_ID, inputs: {} } as unknown as RunTaskRequest;
const store = () => storeCapture({ paths: s.deps.paths, sqlite: s.deps.sqlite }, SEED_M2_PAPER_ID, makeTestPngBase64({ width: 40, height: 30 }));

describe('startWithCapture discards the capture on every path where its row did not commit', () => {
  it('runTask answers attached: true → the written capture file is removed, no files row, the handle is returned', async () => {
    s = await startTestServer({ env: 'prod', papers: ['m2'] });
    const capture = store();
    expect(captureState()).toEqual({ files: 1, rows: 0 }); // written, not committed
    const h = startWithCapture({ runTask: () => attachedHandle }, INPUT, capture);
    expect(h).toBe(attachedHandle);
    expect(captureState()).toEqual({ files: 0, rows: 0 });
  });

  it('runTask throws → removed too, the error passes through', async () => {
    s = await startTestServer({ env: 'prod', papers: ['m2'] });
    const capture = store();
    expect(() =>
      startWithCapture(
        {
          runTask: () => {
            throw new Error('start failed');
          },
        },
        INPUT,
        capture,
      ),
    ).toThrow('start failed');
    expect(captureState()).toEqual({ files: 0, rows: 0 });
  });

  it('a new run whose start committed the row (attached: false) → the file and its row stay', async () => {
    s = await startTestServer({ env: 'prod', papers: ['m2'] });
    const capture = store();
    const h = startWithCapture(
      {
        runTask: () => {
          s.deps.db.transaction((tx) => capture.insertRow(tx));
          return { ...attachedHandle, attached: false };
        },
      },
      INPUT,
      capture,
    );
    expect(h.attached).toBe(false);
    expect(captureState()).toEqual({ files: 1, rows: 1 });
  });

  it('through the route: a runTask that answers another request\'s run (attached) for a new figure request → that request\'s capture is discarded', async () => {
    s = await startTestServer({ env: 'prod', papers: ['m2'], llm: new ControlledAdapter() });
    const real = s.deps.runTask;
    let first: Parameters<typeof real>[0] | undefined;
    // the first start runs; the next start is answered with the first run's handle (what runTask gives a request
    // whose start lost to a concurrent one: attached: true)
    s.deps.runTask = (input) => {
      if (!first) {
        first = input;
        return real(input);
      }
      const h = real(first);
      expect(h.attached).toBe(true);
      return h;
    };
    const AREA = { kind: 'area' as const, rects: [{ page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.3 }] };
    const post = (png: string) =>
      s.req(`/api/papers/${SEED_M2_PAPER_ID}/threads`, { method: 'POST', headers: { 'X-SP-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'figure', anchor: AREA, imagePng: png, clientRequestId: randomUUID() }) });
    const a = await post(makeTestPngBase64({ width: 40, height: 30 }));
    expect(captureState()).toEqual({ files: 1, rows: 1 });
    const b = await post(makeTestPngBase64({ width: 50, height: 20 }));
    expect(b.status).toBe(200);
    const runOf = (text: string) => {
      const f = text.split('\n\n').find((x) => x.includes('event: run.accepted'))!;
      return (parseSseEvent('run.accepted', JSON.parse(/^data: (.*)$/m.exec(f)![1]!)).data as { runId: string }).runId;
    };
    expect(runOf(b.text)).toBe(runOf(a.text));
    expect(captureState()).toEqual({ files: 1, rows: 1 }); // the second PNG left nothing behind
  });
});
