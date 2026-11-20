import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqlite } from '../../src/db/client';
import { initLiveLedger } from '../../src/llm/liveLedger';
import { liveE2eExit } from '../../../../scripts/live-e2e';
import { LocalApi } from '../../../../scripts/lib/localApi';
import { ALL_NOTATION_KEYS, LIVE_CALL_PLAN, LIVE_CAPS, LIVE_PAPERS } from '../../../../scripts/lib/liveE2ePlan';

// Exercise the CLI through its real loop, disk records, eight conditions, ledger and exit mapper.
// The server, DB rows and PDF text are fixtures. The fs hooks only select an exact point in the loop.
const hooks = vi.hoisted(() => ({
  list: undefined as ((path: string) => void) | undefined,
  unreadable: undefined as string | undefined,
  step: undefined as ((kind: string, id?: string) => void) | undefined,
  onLoopEnd: undefined as (() => void) | undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readdirSync: new Proxy(fs.readdirSync, { apply(fn, self, args) {
      hooks.list?.(String(args[0]));
      return Reflect.apply(fn, self, args);
    } }),
    openSync: new Proxy(fs.openSync, { apply(fn, self, args) {
      if (hooks.unreadable === args[0]) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return Reflect.apply(fn, self, args);
    } }),
  };
});
vi.mock('../../../../scripts/lib/liveE2ePlan', async (original) => {
  const plan = await original<typeof import('../../../../scripts/lib/liveE2ePlan')>();
  return { ...plan, stepBeforeCall: (...args: Parameters<typeof plan.stepBeforeCall>) => {
    const step = plan.stepBeforeCall(...args);
    hooks.step?.(step.kind, 'call' in step ? step.call.id : undefined);
    if (step.kind === 'end') hooks.onLoopEnd?.();
    return step;
  } };
});
vi.mock('../../src/db/client', () => ({ openSqlite: vi.fn() }));
vi.mock('../../../../scripts/lib/liveE2eChecks', async (original) => ({
  ...await original<typeof import('../../../../scripts/lib/liveE2eChecks')>(),
  checkServerEnv: () => [],
  checkPlanSelections: () => [],
}));

const calls = LIVE_CALL_PLAN.filter((c) => !c.conditional);
const eqText = '## 기호 표\n\n| 기호 | 뜻 |\n|---|---|\n| x | 상태 |\n\n## 단계별 유도\n<eq n="10"/> 에서 시작한다.\n\n## 쓰인 가정\n가정.\n\n## 확인 질문\n질문.';
const rows = calls.map((c, i) => ({
  runId: c.id, threadId: c.id, acceptedAt: 100 + i, task: c.task, model: c.model, effort: c.effort, status: 'ok',
  errorCode: null, prefixFingerprint: c.id.startsWith('S') ? null : 'prefix', cacheReadTokens: 21, cacheCreationTokens: 0,
  inputTokens: 1, outputTokens: 1, ttftMs: 1, durationMs: 1, parentRunId: null, rateLimitJson: null,
}));

const jsonFile = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
let root: string, out: string, ledger: string, data: string;
let onGet: ((route: string) => void | Promise<void>) | undefined;
let onSend: (() => void) | undefined;
let sends: number;
let sampleCall: boolean;
let dispose: (() => void) | undefined;
const zero = { total: 0, perModel: {} };
const one = { total: 1, perModel: { opus: 1 } };
function reserveOne() {
  for (const name of ['opus.1', 'total.1']) writeFileSync(join(ledger, name), '{}', { flag: 'wx' });
}
function argv(command: 'run' | 'evaluate') {
  return [command, '--mode', 'dry-fake', '--base-url', 'http://127.0.0.1:4594', '--data', data, '--out', out,
    '--scratch-root', root, '--ledger', ledger, '--server-log', join(out, 'server.log'), ...(command === 'run' ? ['--only', 'O1'] : [])];
}
function writeGreenEvidence() {
  mkdirSync(join(out, 'calls'), { recursive: true });
  jsonFile(join(out, 'run.1.json'), { run: 1, mode: 'dry-fake', startedAt: 1, data, serverPid: null,
    selector: { from: null, only: null }, callsStarted: calls.length, stoppedReason: null });
  jsonFile(join(out, 'post_check.1.json'), { verdict: { result: 'pass' } });
  jsonFile(join(out, 'argv_samples.jsonl'), { run: 1, pid: 12345, callId: 'O1', userTextHit: false, base64Hit: false, argvChars: 10 });
  for (const c of calls) {
    jsonFile(join(out, 'calls', c.id + '.json'), { id: c.id, run: 1, runId: c.id, threadId: c.id, termId: 'term',
      outcome: 'run.done', decision: 'next: run.done', ...(c.id === 'F1' ? { f1Passed: true } : {}) });
  }
}
function checkVerdict(exit: number, index: number, reason: RegExp | null, usage: typeof zero | null, version: string, expectedCode = reason ? 3 : 0) {
  const latest = json(join(out, 'live_e2e.json'));
  expect(json(join(out, version))).toEqual(latest);
  const meta = json(join(out, `run.${index}.json`));
  expect([exit, meta.exitCode, latest.exitCode]).toEqual([expectedCode, expectedCode, expectedCode]);
  expect(meta.stoppedReason).toEqual(latest.stoppedReason);
  if (reason) expect(meta.stoppedReason).toMatch(reason);
  else expect(meta.stoppedReason).toBeNull();
  expect(meta.ledgerUsed).toEqual(usage);
  expect(latest.records.ledgerUsed).toEqual(usage);
  return latest;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ledger-judgment-'));
  out = join(root, 'out'); ledger = join(root, 'ledger-dry-test'); data = join(root, 'data');
  mkdirSync(out); mkdirSync(join(data, 'run'), { recursive: true });
  jsonFile(join(data, 'run', 'server.pid'), process.pid);
  initLiveLedger(ledger, LIVE_CAPS);
  sends = 0; sampleCall = true;
  vi.mocked(openSqlite).mockReturnValue({ close() {}, prepare: () => ({ all: () => rows, get: () => ({ text: 'x'.repeat(10_000) }) }) } as unknown as ReturnType<typeof openSqlite>);
  const api = {
    async json(route: string, opts: { params?: { id?: string } }) {
      await onGet?.(route);
      const id = opts.params?.id;
      switch (route) {
        case 'papers.list': return { data: { papers: Object.entries(LIVE_PAPERS).map(([key,p]) => ({
          id: key, arxivId: p.arxivId, arxivVersion: p.version, title: p.name, supplementVersion: 2, structureSource: 'latexml',
        })) } };
        case 'papers.structure': return { data: { equations: Array.from({ length: 19 }, (_,i) => ({ number: String(i + 1) })) } };
        case 'threads.get': return { data: { thread: { kind: id?.startsWith('S') ? 'translate' : 'explain' },
          messages: [{ role: 'assistant', llmCallId: id, contentMd: id === 'F1' ? eqText : 'answer', stats: null,
            citations: id === 'F1' ? [{ ordinal: 1, kind: 'equation', eqNumber: '10', status: 'resolved', score: 1 }] : [] }] } };
        case 'glossary.list': return { data: { terms: [{ id: 'term', definitionKo: 'term', citations: [] }] } };
        case 'cards.list': return { data: { cards: calls.filter((c) => c.paper === id && ['notation_card','summary','assumptions_card'].includes(c.task)).map((c) => ({
          runId: c.id, kind: c.id === 'F2' ? 'notation' : c.task, items: (c.id === 'F2' ? ALL_NOTATION_KEYS : [null]).map((key,i) => ({
            ordinal: i+1, key, label: i === 0 ? 'P' : 'N', bodyMd: 'fixture', citations: [],
          })),
        })) } };
        default: throw new Error('unexpected fixture route ' + route);
      }
    },
    async sse() {
      sends++; onSend?.();
      if (sampleCall) {
        const run = json(join(out, 'calls/O1.started.json')).run;
        appendFileSync(join(out, 'argv_samples.jsonl'), '\n' + JSON.stringify({ run, pid: 23456, callId: 'O1', userTextHit: false, base64Hit: false, argvChars: 10 }) + '\n');
      }
      return { events: [{ event: 'run.accepted', data: { runId: 'O1', threadId: 'O1' } }], terminal: { event: 'run.done', data: {} }, ms: 1 };
    },
    async dispose() { dispose?.(); },
  };
  vi.spyOn(LocalApi, 'open').mockResolvedValue(api as unknown as LocalApi);
});
afterEach(() => {
  hooks.step = undefined; dispose = undefined;
  hooks.list = undefined; hooks.onLoopEnd = undefined; hooks.unreadable = undefined; onGet = undefined; onSend = undefined;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('run and evaluate publish the last ledger observation', () => {
  it('preserves normal exits 0 and 1 and the original per-run result', async () => {
    writeGreenEvidence();
    const run = await liveE2eExit(argv('run'));
    const result = checkVerdict(run, 2, null, zero, 'live_e2e.2.json');
    expect(result.conditions.slice(0, 7).map((c: { result: string }) => c.result)).toEqual(Array(7).fill('pass'));
    const missingPost = await liveE2eExit(argv('evaluate'));
    checkVerdict(missingPost, 2, null, zero, 'live_e2e.2.evaluate.1.json', 1);
    jsonFile(join(out, 'post_check.2.json'), { verdict: { result: 'pass' } });
    checkVerdict(await liveE2eExit(argv('evaluate')), 2, null, zero, 'live_e2e.2.evaluate.2.json');
    expect(json(join(out, 'live_e2e.2.json'))).toEqual(result);
    expect(sends).toBe(1);
  });

  it('does not certify a run without its own sample when another run has one', async () => {
    writeGreenEvidence();
    sampleCall = false;
    const run = await liveE2eExit(argv('run'));
    const r = checkVerdict(run, 2, null, zero, 'live_e2e.2.json', 1);
    expect(r.conditions[6]).toMatchObject({ result: 'not_evaluated', evidence: { missingRuns: [2], runs: [1] } });
    jsonFile(join(out, 'post_check.2.json'), { verdict: { result: 'pass' } });
    const replay = checkVerdict(await liveE2eExit(argv('evaluate')), 2, null, zero, 'live_e2e.2.evaluate.1.json', 1);
    expect(replay.conditions[6]).toEqual(r.conditions[6]);
    expect(sends).toBe(1);
  });

  it.each(['skip', 'end'])('keeps a transient STOP captured at the %s step', async (target) => {
    writeGreenEvidence();
    const marker = join(ledger, 'STOP_REQUESTED');
    const before = target === 'skip' ? 'O2' : 'S3';
    let observed = false;
    hooks.step = (kind, id) => {
      if (kind === 'skip' && id === before) writeFileSync(marker, 'brief marker');
      if ((target === 'skip' ? kind === 'skip' && id === 'O3' : kind === 'end') && existsSync(marker)) {
        unlinkSync(marker); observed = true;
      }
    };
    const reason = target === 'skip' ? /while skipping O3.*brief marker/ : /end of the run.*brief marker/;
    checkVerdict(await liveE2eExit(argv('run')), 2, reason, zero, 'live_e2e.2.json');
    expect(observed).toBe(true);
    expect(sends).toBe(1);
  });

  it('evaluate persists a first-read stop even if the marker disappears during the first lookup', async () => {
    writeGreenEvidence();
    const marker = join(ledger, 'STOP_REQUESTED');
    writeFileSync(marker, 'first evaluation read');
    onGet = () => { onGet = undefined; unlinkSync(marker); };
    checkVerdict(await liveE2eExit(argv('evaluate')), 1, /first evaluation read/, zero, 'live_e2e.1.json');
    expect(existsSync(marker)).toBe(false);
    expect(sends).toBe(0);
  });

  it.each(['run', 'evaluate'] as const)('%s writes the verdict and closes the DB even if api cleanup fails', async (command) => {
    writeGreenEvidence();
    const closed = vi.fn();
    const open = vi.mocked(openSqlite);
    const existing = open.getMockImplementation()!;
    open.mockImplementation((...args) => Object.assign(existing(...args), { close: closed }));
    dispose = () => { throw new Error('cleanup fixture'); };
    const n = command === 'run' ? 2 : 1;
    checkVerdict(await liveE2eExit(argv(command)), n, /close the api/, zero, `live_e2e.${n}.json`);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('sees STOP_REQUESTED during the final child sample and counts the last reservation', async () => {
    writeGreenEvidence();
    hooks.list = (path) => {
      if (path !== '/proc') return;
      const rec = json(join(out, 'calls/O1.json'));
      if (rec.run !== 2 || !rec.decision) return; // after the full record and loop-end read
      hooks.list = undefined;
      reserveOne();
      writeFileSync(join(ledger, 'STOP_REQUESTED'), 'during sampler');
    };
    const result = checkVerdict(await liveE2eExit(argv('run')), 2, /STOP_REQUESTED: during sampler/, one, 'live_e2e.2.json');
    expect(result.conditions.slice(0, 7).map((c: { result: string }) => c.result)).toEqual(Array(7).fill('pass'));
    expect(sends).toBe(1);
  });

  it('sees STOP_REQUESTED and new usage during an awaited evaluate query and keeps the first reason on replay', async () => {
    writeGreenEvidence();
    const green = checkVerdict(await liveE2eExit(argv('evaluate')), 1, null, zero, 'live_e2e.1.json');
    onGet = async (route) => {
      if (route !== 'threads.get') return;
      onGet = undefined;
      await Promise.resolve();
      reserveOne();
      writeFileSync(join(ledger, 'STOP_REQUESTED'), 'during query');
    };
    const result = checkVerdict(await liveE2eExit(argv('evaluate')), 1, /STOP_REQUESTED: during query/, one, 'live_e2e.1.evaluate.1.json');
    expect(result.conditions).toEqual(green.conditions);
    expect(result.conditions.map((c: { result: string }) => c.result)).toEqual(Array(8).fill('pass'));
    unlinkSync(join(ledger, 'STOP_REQUESTED')); writeFileSync(join(ledger, 'STOP'), 'later stop');
    checkVerdict(await liveE2eExit(argv('evaluate')), 1, /STOP_REQUESTED: during query/, one, 'live_e2e.1.evaluate.2.json');
    expect(sends).toBe(0);
  });

  it('checks a new STOP_REQUESTED between run setup and the selected call', async () => {
    writeGreenEvidence();
    onGet = (route) => {
      if (route !== 'papers.structure') return;
      onGet = undefined;
      writeFileSync(join(ledger, 'STOP_REQUESTED'), 'during setup');
    };
    checkVerdict(await liveE2eExit(argv('run')), 2, /before the call.*during setup/, zero, 'live_e2e.2.json');
    expect(sends).toBe(0);
  });

  it('applies the same final ledger check to live-mode evaluate with an offline API double', async () => {
    // Live-mode argument validation checks the basenames and URL. LocalApi.open is stubbed: no listener or request.
    ledger = join(root, 'ledger-live-e2e');
    data = join(root, 'm2-live-e2e');
    mkdirSync(join(data, 'run'), { recursive: true });
    jsonFile(join(data, 'run', 'server.pid'), process.pid);
    initLiveLedger(ledger, LIVE_CAPS);
    writeGreenEvidence();
    const metaFile = join(out, 'run.1.json');
    jsonFile(metaFile, { ...json(metaFile), mode: 'live' });
    const args = ['evaluate', '--mode', 'live', '--base-url', 'http://127.0.0.1:4570', '--data', data, '--out', out, '--ledger', ledger];
    onGet = (route) => {
      if (route !== 'threads.get') return;
      onGet = undefined;
      writeFileSync(join(ledger, 'STOP'), 'while judging live records');
    };
    checkVerdict(await liveE2eExit(args), 1, /STOP: while judging live records/, zero, 'live_e2e.1.json');
    expect(sends).toBe(0);
  });

  it.each(['STOP', 'STOP_REQUESTED'])('keeps an unreadable %s and its error after permissions recover', async (name) => {
    writeGreenEvidence();
    const marker = join(ledger, name);
    writeFileSync(marker, 'first'); chmodSync(marker, 0);
    // root can read mode 000. Inject the same OS error only on systems with that privilege.
    if (process.getuid?.() === 0) hooks.unreadable = marker;
    const reason = new RegExp(name + '.*EACCES');
    expect(await liveE2eExit(argv('run'))).toBe(3);
    expect(json(join(out, 'run.2.json'))).toMatchObject({ callsStarted: 0, exitCode: 3, stoppedReason: expect.stringMatching(reason) });
    checkVerdict(await liveE2eExit(argv('evaluate')), 1, reason, zero, 'live_e2e.1.json');
    hooks.unreadable = undefined; chmodSync(marker, 0o600); unlinkSync(marker);
    checkVerdict(await liveE2eExit(argv('evaluate')), 1, /EACCES/, zero, 'live_e2e.1.evaluate.1.json');
  });

  it.each(['missing directory', 'missing caps', 'malformed caps', 'invalid caps', 'different caps'])('refuses %s for run and evaluate and keeps the stop after repair', async (scenario) => {
    writeGreenEvidence();
    const caps = join(ledger, 'caps.json');
    let reason = /caps\.json/;
    if (scenario === 'missing directory') { renameSync(ledger, ledger + '.held'); reason = /ENOENT/; }
    else if (scenario === 'missing caps') unlinkSync(caps);
    else if (scenario === 'malformed caps') writeFileSync(caps, '{');
    else jsonFile(caps, scenario === 'invalid caps' ? { total: -1 } : { ...LIVE_CAPS, total: 24 });
    expect(await liveE2eExit(argv('run'))).toBe(3);
    expect(json(join(out, 'run.2.json'))).toMatchObject({ callsStarted: 0, exitCode: 3, stoppedReason: expect.stringMatching(reason), ledgerUsed: null });
    checkVerdict(await liveE2eExit(argv('evaluate')), 1, reason, null, 'live_e2e.1.json');
    if (scenario === 'missing directory') renameSync(ledger + '.held', ledger);
    else jsonFile(caps, LIVE_CAPS);
    checkVerdict(await liveE2eExit(argv('evaluate')), 1, reason, zero, 'live_e2e.1.evaluate.1.json');
    expect(sends).toBe(0);
  });

  it.each(['before call', 'after call', 'after loop'])('persists a transient ledger I/O failure %s even when later reads succeed', async (phase) => {
    writeGreenEvidence();
    let injected = false;
    let armed = false;
    onGet = async (route) => { if (route === 'papers.structure') armed = true; };
    // Inject on the first ledger read after the real state machine has reached end.
    let atEnd = false;
    hooks.onLoopEnd = () => { atEnd = true; };
    hooks.list = (path) => {
      if (path !== ledger || !armed || injected) return;
      const rec = json(join(out, 'calls/O1.json'));
      if (phase === 'before call' && sends !== 0) return;
      if (phase === 'after call' && !(rec.run === 2 && rec.minimal)) return;
      if (phase === 'after loop' && !atEnd) return;
      injected = true;
      throw Object.assign(new Error('EACCES: ledger directory'), { code: 'EACCES' });
    };
    checkVerdict(await liveE2eExit(argv('run')), 2, /EACCES/, zero, 'live_e2e.2.json');
    expect(injected).toBe(true);
    expect(sends).toBe(phase === 'before call' ? 0 : 1);
    if (sends) checkVerdict(await liveE2eExit(argv('evaluate')), 2, /EACCES/, zero, 'live_e2e.2.evaluate.1.json');
  });

  it('publishes unknown usage for a final ledger read error and retains it as the reason after recovery', async () => {
    writeGreenEvidence();
    onGet = (route) => {
      if (route !== 'threads.get') return;
      onGet = undefined;
      renameSync(ledger, ledger + '.held');
    };
    checkVerdict(await liveE2eExit(argv('evaluate')), 1, /ENOENT/, null, 'live_e2e.1.json');
    renameSync(ledger + '.held', ledger);
    checkVerdict(await liveE2eExit(argv('evaluate')), 1, /ENOENT/, zero, 'live_e2e.1.evaluate.1.json');
  });

  it('records STOP observed immediately after --only O1 before any other call or query', async () => {
    writeGreenEvidence();
    onSend = () => writeFileSync(join(ledger, 'STOP'), 'after O1');
    // The marker disappears at the next owner lookup. Its reason must already be durable at this point.
    onGet = (route) => {
      if (route !== 'threads.get' || !existsSync(join(ledger, 'STOP'))) return;
      expect(json(join(out, 'run.2.json')).stoppedReason).toMatch(/O1.*STOP: after O1/);
      unlinkSync(join(ledger, 'STOP'));
    };
    checkVerdict(await liveE2eExit(argv('run')), 2, /O1.*STOP: after O1/, zero, 'live_e2e.2.json');
    expect(sends).toBe(1);
  });
});
