// Probe for liveLedger.test (separate processes). Owner: supervisor. SP_LIVE_LEDGER comes from the environment.
// Usage: ledger-probe.ts <mode> [json options]
//   guard   {who, model, count, go?, barrier?: {marker, release}, events}  — `count` guardLiveRun calls; spawnFn appends
//           "spawn <who> stopRequested=<bool> stop=<bool>" to `events` (and, with barrier, writes `marker` then waits
//           until `release` exists — the lock is held meanwhile). Prints {results:[reason|'ok'…]}.
//   stop    {reason, lockWaitMs, waitForStop?, events} — stopLiveLedger; appends "stop <status>" to events; with
//           waitForStop keeps the process alive (async polling) until STOP exists, then appends "stop-confirmed".
//   churn   {n} — n guarded no-op spawns (lock acquire/release cycles).
//   watchlock {ms, started?, until?} — reads `lock` and counts reads that were empty or not JSON. With `started`, writes
//           that file once its read loop has made its first read attempt ("reader started reading"). Stops when `until`
//           exists (checked every 16 reads) or after ms, whichever comes first. Prints {bad, reads, stoppedBy: until|ms}.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardLiveRun, stopLiveLedger } from '../../src/llm/liveLedger';

const [mode, raw] = process.argv.slice(2);
const o = JSON.parse(raw ?? '{}') as Record<string, unknown>;
const dir = process.env.SP_LIVE_LEDGER!;
const cell = new Int32Array(new SharedArrayBuffer(4));
const waitFile = (p: string, maxMs = 60_000) => {
  const t0 = Date.now();
  while (!existsSync(p)) {
    if (Date.now() - t0 > maxMs) throw new Error(`timeout waiting for ${p}`);
    Atomics.wait(cell, 0, 0, 5);
  }
};
const log = (line: string) => {
  if (typeof o.events === 'string') appendFileSync(o.events, `${line}\n`);
};

if (mode === 'guard') {
  if (typeof o.go === 'string') waitFile(o.go);
  const results: string[] = [];
  for (let i = 0; i < (o.count as number); i++) {
    const r = guardLiveRun(o.model as never, { runId: `${String(o.who)}-${i}`, task: 'chat' }, () => {
      log(`spawn ${String(o.who)} stopRequested=${existsSync(join(dir, 'STOP_REQUESTED'))} stop=${existsSync(join(dir, 'STOP'))}`);
      const b = o.barrier as { marker: string; release: string } | undefined;
      if (b) {
        writeFileSync(b.marker, String(process.pid));
        waitFile(b.release, 120_000);
      }
      return true;
    }, typeof o.lockWaitMs === 'number' ? { lockWaitMs: o.lockWaitMs } : {});
    results.push(r.ok ? 'ok' : r.reason);
  }
  console.log(JSON.stringify({ results }));
} else if (mode === 'stop') {
  const r = stopLiveLedger(dir, String(o.reason ?? 'test'), { lockWaitMs: o.lockWaitMs as number });
  log(`stop ${r.status}`);
  console.log(JSON.stringify(r));
  if (o.waitForStop) {
    const t = setInterval(() => {
      if (existsSync(join(dir, 'STOP'))) {
        clearInterval(t);
        log('stop-confirmed');
      }
    }, 20);
  }
} else if (mode === 'churn') {
  for (let i = 0; i < (o.n as number); i++) guardLiveRun('haiku', { runId: `c${i}`, task: 'chat' }, () => true);
  console.log(JSON.stringify({ done: true }));
} else if (mode === 'watchlock') {
  const t0 = Date.now();
  let bad = 0;
  let reads = 0;
  let attempts = 0;
  let stoppedBy: 'until' | 'ms' = 'ms';
  const started = typeof o.started === 'string' ? o.started : null;
  const until = typeof o.until === 'string' ? o.until : null;
  while (Date.now() - t0 < (o.ms as number)) {
    if (until !== null && attempts % 16 === 0 && existsSync(until)) {
      stoppedBy = 'until';
      break;
    }
    let text: string | null = null;
    try {
      text = readFileSync(join(dir, 'lock'), 'utf8');
    } catch {
      text = null; // absent is fine
    }
    if (attempts++ === 0 && started !== null) writeFileSync(started, String(process.pid));
    if (text !== null) {
      reads++;
      try {
        const v = JSON.parse(text) as { pid?: unknown };
        if (typeof v.pid !== 'number') bad++;
      } catch {
        bad++;
      }
    }
  }
  console.log(JSON.stringify({ bad, reads, stoppedBy }));
}
