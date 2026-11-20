// Live E2E (BRIEF_INTEGRATION I9, PLAN_M2 7절). Owner: supervisor. Run only through scripts/live-runbook.sh, which
// starts and stops the server (this script never starts a process, never uses fetch / node:http / child_process).
//   init       --mode live|dry-fake --ledger <dir> …   ledger with LIVE_CAPS (an existing ledger must have the same caps)
//              [--allow-rate-warning]                 + the coordinator approval <ledger>/ALLOW_RATE_WARNING (INTEGRATION_NOTES
//                                                     결정 26: a rate-limit status of exactly allowed_warning is recorded,
//                                                     not a stop; rejected / other / rate_limited still stop; caps the
//                                                     same). live or dry-fake only; the runbook adds it when
//                                                     RATE_WARNING_OK=1. init without it on a ledger that already has the
//                                                     approval is refused (exit 2): the flag and the ledger always agree
//   import     --mode live|dry-mock …                  papers.import of KISS-ICP, then FAST-LIO2, once each and at the
//                                                     planned version (<id>v<N>); the second only when the first
//                                                     ended job.done (or was already imported) and meets its own
//                                                     preconditions; then the preconditions of both (version · v2 ·
//                                                     latexml · FAST-LIO2 equations 1…19) and every plan
//                                                     selection's sha256; LLM 0
//   run        --mode … [--from <id> | --only <id>]   the call plan (scripts/lib/liveE2ePlan.ts), the pass conditions
//   evaluate   --mode …                               live_e2e.json again from calls/ + DB + read-only API (no LLM
//                                                     call, no POST, no arXiv request) for the last run of --out
//                                                     that started a call
//   post-check --out <dir>                            after the server stopped: every started call has its record
//                                                     and no child is alive (recorded, or in <data>/claude-cwd)
// Records in --out: run.<n>.json per run invocation (written first; "no call" only on its explicit refusedBeforeCall),
// calls/<id>.started.json before each request and calls/<id>.json right after its terminal, children.<n>.jsonl and
// argv_samples.jsonl appended while the run goes on. Per run, never overwritten (INT-I10-01): live_e2e.<n>.json,
// children.<n>.jsonl, post_check.<n>.json, captures/<id>.<n>.png; live_e2e.json is the latest aggregate. run.<n>.json and
// live_e2e(.<n>).json carry rateWarningAllowed + rateWarningApproval (the ledger's ALLOW_RATE_WARNING, 결정 26), and
// live_e2e(.<n>).json the ledger's rate_warnings.jsonl as rateLimitWarnings [{call, runId, status, rateLimitType, utilization, resetsAt, at}]. Conditions 7 and 8 are judged over
// every run of --out: an earlier run's argv hit or post-check failure keeps the final result not pass (exit 1; a stopped run exits 3 whatever the conditions — run and evaluate).
//   check-args --mode … [--smoke-data <dir>] …         the argument rules of init / import / run (and SMOKE_DATA in
//                                                     live) only: no request, no LLM call, no file read or written.
//                                                     The runbook runs it first, before build, mkdir, server and log
// Common: --base-url http://127.0.0.1:4570 --data <SP_DATA_DIR of the server> --out <dir> --server-log <file>
//         dry modes: --scratch-root <dir>; live / dry-fake: --ledger <dir>.
// Exit codes: 0 pass · 1 pass condition failed (plan finished) · 2 usage / precondition / environment refused (no LLM
// call in that invocation) · 3 stopped (ledger, rate limit, breaker; a failed lookup after a call — of the llm_calls rows,
// the ledger, or F1's / F1r's verdict — or of F1's verdict before a resume's first call; nothing more is sent; nextAction).
// run checks the ledger before/after each call and when its loop ends. Both run and evaluate read it again after
// all asynchronous checks, immediately before publishing. A missing/invalid ledger or an unreadable stop marker
// stops the verdict. The first stop is kept in run.<n>.json across later evaluations.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { openSqlite } from '../apps/server/src/db/client';
import { dataPaths } from '../apps/server/src/paths';
import { allowRateWarning, initLiveLedger, readLiveLedger, RATE_WARNING_APPROVAL_FILE } from '../apps/server/src/llm/liveLedger';
import { DEFAULT_ARXIV_RETRY } from '../apps/server/src/ingest/arxivApi';
import { HTML_STEP_DEADLINE_MS } from '../apps/server/src/ingest/pipeline';
import { TEXT_TIMEOUT_MS } from '../apps/server/src/ingest/pdfText';
import { KATEX_BUDGET_MS } from '../apps/server/src/ingest/katexCheck';
import type { CardItemDto, GlossaryTermDto, ImportPaperResponse, ListCardsResponse, ListGlossaryResponse, ListPapersResponse, PaperDetailDto, StructureResponse, ThreadDetailResponse } from '../packages/shared/src/contracts/api';
import type { Citation, GroundingLabel, MessageStats, ParsedBlocks } from '../packages/shared/src/contracts/domain';
import { pairCitations } from '../packages/shared/src/contracts/grounding';
import type { SseEvent } from '../packages/shared/src/contracts/sse';
import { TASK_SPECS } from '../packages/shared/src/contracts/tasks';
import { inspectPngBytes } from '../packages/shared/src/image/png';
import { parseAnswer } from '../packages/shared/src/markup/parseAnswer';
import { chooseCapture, ctrlDragArea, openPaper, showPage, waitForAnswerTerminal } from '../e2e/actions';
import { devTokenFile, LocalApi, LocalApiError, runStreamTimeoutMs, type SseResult } from './lib/localApi';
import {
  afterSkip,
  CALL_BY_ID,
  FASTLIO2_STATED_KEYS,
  importInput,
  initialRunState,
  LIVE_CALL_PLAN,
  LIVE_CAPS,
  LIVE_PAPERS,
  nextAction,
  describeOutcome,
  selected,
  stepAfterCall,
  stepAtEnd,
  stepBeforeCall,
  type CallId,
  type CallOutcome,
  type LedgerView,
  type PaperKey,
  type PlannedCall,
  type RunState,
  type Selection,
  type Selector,
  type Verdict,
} from './lib/liveE2ePlan';
import { existingRealpath } from './lib/realDataDir';
import {
  ALLOW_RATE_WARNING_FLAG,
  badgeOf,
  callRecordOf,
  checkRateWarningFlag,
  rateWarningApprovalFields,
  rateWarningResultFields,
  checkArgs,
  checkFirstPaperImport,
  checkPlanSelections,
  checkPostCheckArgs,
  checkPreconditions,
  checkServerEnv,
  checkSmokeDataArg,
  cond1Notation,
  cond2EquationDeep,
  cond3Chips,
  cond4CapturePrefix,
  cond5TranslateNoPrefix,
  cond6DeepEffort,
  cond7Argv,
  ARGV_SAMPLES_FILE,
  callRecordFile,
  callsNotDone,
  captureFile,
  childrenFile,
  cond8EarlierRuns,
  cond8Evaluate,
  cond8OfVerdict,
  liveE2eRunFile,
  POST_CHECK_RE,
  postCheckFile,
  equationDeepVerdict,
  evaluateExitCode,
  evaluateStoppedReason,
  evaluateTarget,
  judgeArgv,
  LiveE2eResultSchema,
  parseEnviron,
  parseNetworkLog,
  parseProcStat,
  postCheckVerdict,
  resolveF1Resume,
  RUN_META_RE,
  startedMarkerFile,
  summaryLine,
  type ArgvSample,
  type CallRecord,
  type CallRow,
  type ChildSeen,
  type CardItemFacts,
  type Command,
  type Condition,
  type EquationDeepAttempt,
  type LiveArgs,
  type Mode,
  type OwnerChips,
  type PaperFacts,
  type PostCheckResult,
  type RunMeta,
  type ServerFacts,
  type StartedMarker,
} from './lib/liveE2eChecks';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_CLAUDE = join(REPO_ROOT, 'apps/server/test/fixtures/fake-claude.mjs');
/** Timeout of the JSON calls (lists, gets, import start). */
const JSON_TIMEOUT_MS = 30_000;
/**
 * Client wait for one import job stream. A has no exported "whole ingest" limit, so it is the sum of the step limits
 * it exports: metadata and PDF retries (each DEFAULT_ARXIV_RETRY.maxTotalMs = 6 min) + text extraction
 * (TEXT_TIMEOUT_MS) + html step (HTML_STEP_DEADLINE_MS) + KaTeX budget + 60 s for structure / anchor / supplement,
 * + 30 s slack (BRIEF_INTEGRATION script rule).
 */
export const IMPORT_JOB_STREAM_TIMEOUT_MS = 2 * DEFAULT_ARXIV_RETRY.maxTotalMs + TEXT_TIMEOUT_MS + HTML_STEP_DEADLINE_MS + KATEX_BUDGET_MS + 60_000 + 30_000;
/** Screen steps other than the answer itself (open the paper, drag, menu). */
const SCREEN_STEP_TIMEOUT_MS = 60_000;
const SAMPLE_INTERVAL_MS = 200;

// ------------------------------------------------------------------------------------------------------------------
// arguments

class Exit extends Error {
  constructor(
    readonly code: 0 | 1 | 2 | 3,
    message: string,
  ) {
    super(message);
  }
}

function parseArgs(argv: string[]): LiveArgs & { command: Command } {
  const [command, ...rest] = argv;
  if (command !== 'init' && command !== 'import' && command !== 'run' && command !== 'post-check' && command !== 'check-args' && command !== 'evaluate') throw new Exit(2, 'usage: live-e2e.ts init|import|run|evaluate|post-check|check-args --mode … (see the file header)');
  const o: Record<string, string> = {};
  let allowFlag = false;
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!;
    if (k === ALLOW_RATE_WARNING_FLAG) {
      // the one option without a value (결정 26)
      if (allowFlag) throw new Exit(2, `${k} given twice`);
      allowFlag = true;
      continue;
    }
    if (!k.startsWith('--')) throw new Exit(2, `unexpected argument ${k}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Exit(2, `${k} needs a value`);
    if (o[k] !== undefined) throw new Exit(2, `${k} given twice`);
    o[k] = v;
    i++;
  }
  const known = new Set(['--mode', '--base-url', '--data', '--out', '--server-log', '--ledger', '--scratch-root', '--from', '--only', ...(command === 'check-args' ? ['--smoke-data'] : [])]);
  for (const k of Object.keys(o)) if (!known.has(k)) throw new Exit(2, `unknown option ${k}`);
  if (command === 'post-check') {
    if (!o['--out'] || Object.keys(o).length !== 1 || allowFlag) throw new Exit(2, 'post-check takes --out <dir> only');
    const problems = checkPostCheckArgs(o['--out'], process.env, isDirectory);
    if (problems.length) throw new Exit(2, `arguments refused:\n  ${problems.join('\n  ')}`);
    return { command, mode: 'dry-mock', baseUrl: '', data: '', out: o['--out'] };
  }
  const mode = o['--mode'];
  if (mode !== 'live' && mode !== 'dry-mock' && mode !== 'dry-fake') throw new Exit(2, '--mode live|dry-mock|dry-fake is required');
  const flagProblems = checkRateWarningFlag(command, mode, allowFlag);
  if (flagProblems.length) throw new Exit(2, `arguments refused:\n  ${flagProblems.join('\n  ')}`);
  for (const k of ['--base-url', '--data', '--out']) if (!o[k]) throw new Exit(2, `${k} is required`);
  if ((command === 'init' || command === 'import' || command === 'evaluate') && (o['--from'] || o['--only'])) throw new Exit(2, '--from / --only belong to run (evaluate takes the selector of the run it judges)');
  const a: LiveArgs & { command: Command } = {
    command,
    mode: mode as Mode,
    baseUrl: o['--base-url']!,
    data: o['--data']!,
    out: o['--out']!,
    ...(o['--server-log'] ? { serverLog: o['--server-log'] } : {}),
    ...(o['--ledger'] ? { ledger: o['--ledger'] } : {}),
    ...(o['--scratch-root'] ? { scratchRoot: o['--scratch-root'] } : {}),
    ...(o['--from'] ? { from: o['--from'] } : {}),
    ...(o['--only'] ? { only: o['--only'] } : {}),
    ...(allowFlag ? { allowRateWarning: true as const } : {}),
  };
  const problems = checkArgs(a, process.env);
  if (a.mode !== 'dry-mock' && a.ledger === undefined) problems.push(`${a.mode}: --ledger is required`);
  if ((command === 'import' || command === 'run' || command === 'check-args') && a.serverLog === undefined) problems.push('--server-log is required');
  if (command === 'check-args') problems.push(...checkSmokeDataArg(a, o['--smoke-data'], process.env));
  if (problems.length) throw new Exit(2, `arguments refused:\n  ${problems.join('\n  ')}`);
  return a;
}

// ------------------------------------------------------------------------------------------------------------------
// facts about the server (files and /proc only)

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function serverFacts(data: string): ServerFacts {
  const pidText = readText(dataPaths(data).pidFile);
  const pid = pidText !== null && /^\d+$/.test(pidText.trim()) ? Number(pidText.trim()) : null;
  if (pid === null) return { pid: null, alive: false, environ: null, configFileExists: null, claudeBin: null, pathFirst: null };
  const alive = existsSync(`/proc/${pid}`);
  const raw = alive ? readText(`/proc/${pid}/environ`) : null;
  const environ = raw === null ? null : parseEnviron(raw);
  const cfg = environ?.SP_CONFIG_PATH;
  let claudeBin: ServerFacts['claudeBin'] = null;
  if (environ?.SP_CLAUDE_BIN) {
    try {
      const rp = realpathSync(environ.SP_CLAUDE_BIN);
      claudeBin = { realpath: rp, content: readFileSync(rp, 'utf8').slice(0, 64 * 1024) };
    } catch {
      claudeBin = null;
    }
  }
  let pathFirst: ServerFacts['pathFirst'] = null;
  const first = environ?.PATH?.split(':')[0];
  if (first) {
    try {
      pathFirst = { dir: first, realDir: realpathSync(first), claudeContent: readText(join(first, 'claude')) };
    } catch {
      pathFirst = null;
    }
  }
  return { pid, alive, environ, configFileExists: cfg === undefined ? null : existsSync(cfg), claudeBin, pathFirst };
}

function requireServer(a: LiveArgs): ServerFacts & { pid: number; environ: Record<string, string> } {
  const f = serverFacts(a.data);
  const problems = checkServerEnv(a, f, FAKE_CLAUDE);
  if (problems.length) throw new Exit(2, `server environment refused (mode ${a.mode}, ${a.command}):\n  ${problems.join('\n  ')}`);
  return f as ServerFacts & { pid: number; environ: Record<string, string> };
}

async function openApi(a: LiveArgs, f: { environ: Record<string, string> }): Promise<LocalApi> {
  const port = Number(new URL(a.baseUrl).port);
  return f.environ.SP_ENV === 'dev' ? LocalApi.open(a.baseUrl, { token: { file: devTokenFile(port, f.environ) }, timeoutMs: JSON_TIMEOUT_MS }) : LocalApi.open(a.baseUrl, { token: 'html', timeoutMs: JSON_TIMEOUT_MS });
}

/**
 * Records are never written in place (FIX4-R1-03): the body goes to a temporary file next to the target first, then
 * replaces it by rename — a kill leaves the old record or the new one, never an empty or half-written one. The
 * temporary name (`.<name>.tmp-<pid>`) matches none of the record patterns (run.<n>.json, calls/<id>.json, …).
 */
const tmpOf = (file: string) => join(dirname(file), `.${basename(file)}.tmp-${process.pid}`);
function writeJson(file: string, v: unknown): void {
  const tmp = tmpOf(file);
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`);
  renameSync(tmp, file);
}
/** Like writeJson, but only when `file` does not exist yet (EEXIST otherwise): the complete body appears at once (link). */
function writeJsonExclusive(file: string, v: unknown): void {
  const tmp = tmpOf(file);
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`);
  try {
    linkSync(tmp, file);
  } finally {
    unlinkSync(tmp);
  }
}
/** `name` in `dir` when it does not exist yet, else the first free `other(k)` (k = 1, 2, …): evidence is never overwritten. */
function writeExclusive(dir: string, name: string, other: (k: number) => string, v: unknown): string {
  for (let k = 0; ; k++) {
    const file = join(dir, k === 0 ? name : other(k));
    try {
      writeJsonExclusive(file, v);
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}
/** The verdicts of the first post-check of each run in --out (post_check.<n>.json). */
function postCheckResults(out: string): Map<number, PostCheckResult> {
  const m = new Map<number, PostCheckResult>();
  if (!isDirectory(out)) return m;
  for (const name of readdirSync(out)) {
    const hit = POST_CHECK_RE.exec(name);
    if (!hit) continue;
    try {
      const v = (JSON.parse(readFileSync(join(out, name), 'utf8')) as { verdict?: { result?: PostCheckResult } }).verdict?.result;
      m.set(Number(hit[1]), v ?? 'unverified');
    } catch {
      m.set(Number(hit[1]), 'unverified');
    }
  }
  return m;
}
/** One JSON line appended (records written while the run goes on). */
const appendLine = (file: string, v: unknown) => appendFileSync(file, `${JSON.stringify(v)}\n`);
/** The JSON lines of a file ([] when it does not exist; a torn last line is skipped). */
function readJsonLines(file: string): Record<string, unknown>[] {
  const t = readText(file);
  if (t === null) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of t.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* torn by a kill mid-write */
    }
  }
  return out;
}
const networkLog = (a: LiveArgs) => parseNetworkLog(a.serverLog ? (readText(a.serverLog) ?? '') : '');

// ------------------------------------------------------------------------------------------------------------------
// papers and preconditions

interface LivePaper {
  key: PaperKey;
  id: string;
  title: string;
}

async function paperFacts(api: LocalApi): Promise<{ facts: Record<PaperKey, PaperFacts>; papers: Partial<Record<PaperKey, LivePaper>> }> {
  const list = (await api.json<ListPapersResponse>('papers.list', { timeoutMs: JSON_TIMEOUT_MS })).data.papers;
  const facts = {} as Record<PaperKey, PaperFacts>;
  const papers: Partial<Record<PaperKey, LivePaper>> = {};
  for (const key of ['kiss', 'fastlio2'] as const) {
    const p = list.find((x) => x.arxivId === LIVE_PAPERS[key].arxivId);
    if (!p) {
      facts[key] = { found: false, arxivVersion: null, supplementVersion: null, structureSource: null, numberedEquations: [] };
      continue;
    }
    const s = (await api.json<StructureResponse>('papers.structure', { params: { id: p.id }, timeoutMs: JSON_TIMEOUT_MS })).data;
    facts[key] = { found: true, arxivVersion: p.arxivVersion, supplementVersion: p.supplementVersion, structureSource: p.structureSource, numberedEquations: s.equations.map((e) => e.number).filter((n): n is string => n !== null) };
    papers[key] = { key, id: p.id, title: p.title };
  }
  return { facts, papers };
}

// ------------------------------------------------------------------------------------------------------------------
// init

/** The approval init --allow-rate-warning writes (INTEGRATION_NOTES 결정 26 — user-approved, given by the coordinator). */
const rateWarningApprovalOf = (mode: Mode) => ({
  approvedBy: 'coordinator (user decision, INTEGRATION_NOTES 결정 26)',
  reason: `RATE_WARNING_OK=1 (${mode}): a rate-limit status of exactly allowed_warning does not stop the ledger — it is recorded in rate_warnings.jsonl; rejected, any other status and a terminal rate_limited still stop; caps unchanged`,
  at: new Date().toISOString(),
});

function cmdInit(a: LiveArgs): void {
  if (a.mode === 'dry-mock') return;
  const dir = a.ledger!;
  // without the flag, an existing approval would still apply: refused, so RATE_WARNING_OK and the ledger never disagree
  if (!a.allowRateWarning && existsSync(join(dir, RATE_WARNING_APPROVAL_FILE))) throw new Exit(2, `ledger refused: ${dir} carries ${RATE_WARNING_APPROVAL_FILE} — init it with ${ALLOW_RATE_WARNING_FLAG} (RATE_WARNING_OK=1) or use a new ledger`);
  try {
    initLiveLedger(dir, { total: LIVE_CAPS.total, perModel: { ...LIVE_CAPS.perModel } });
  } catch (e) {
    throw new Exit(2, `ledger refused: ${(e as Error).message}`);
  }
  let approval = null;
  if (a.allowRateWarning) {
    try {
      approval = allowRateWarning(dir, rateWarningApprovalOf(a.mode));
    } catch (e) {
      throw new Exit(2, `ledger refused: ${(e as Error).message}`);
    }
  }
  console.log(JSON.stringify({ init: 'ok', ledger: readLiveLedger(dir), rateWarningAllowed: approval !== null, rateWarningApproval: approval }));
}

// ------------------------------------------------------------------------------------------------------------------
// import

async function cmdImport(a: LiveArgs): Promise<void> {
  const f = requireServer(a);
  mkdirSync(a.out, { recursive: true });
  const api = await openApi(a, f);
  const steps: Record<string, unknown>[] = [];
  const finish = (code: 0 | 2, extra: Record<string, unknown>) => {
    const net = networkLog(a);
    writeJson(join(a.out, 'arxiv_requests.json'), net);
    writeJson(join(a.out, 'import.json'), { mode: a.mode, steps, arxivRequests: { used: net.used, max: net.max }, ...extra });
    console.log(JSON.stringify({ import: code === 0 ? 'ok' : 'refused', arxivRequests: net.used, ...extra }));
    if (code !== 0) throw new Exit(code, `import: ${String(extra.reason ?? 'refused')}`);
  };
  try {
    for (const key of ['kiss', 'fastlio2'] as const) {
      const paper = LIVE_PAPERS[key];
      const r = (await api.json<ImportPaperResponse>('papers.import', { body: { input: importInput(key), clientRequestId: randomUUID() }, timeoutMs: JSON_TIMEOUT_MS })).data;
      let terminal: SseEvent | null = null;
      if (r.jobId) terminal = (await api.sse('jobs.events', { params: { id: r.jobId }, timeoutMs: IMPORT_JOB_STREAM_TIMEOUT_MS })).terminal;
      steps.push({ paper: key, input: importInput(key), paperId: r.paperId, jobId: r.jobId, existing: r.existing, terminal: terminal?.event ?? null, ...(terminal?.event === 'job.error' ? { code: terminal.data.code } : {}) });
      if (key === 'kiss') {
        const first = checkFirstPaperImport(terminal?.event ?? null, (await paperFacts(api)).facts.kiss, networkLog(a).used, r.existing && r.jobId === null);
        if (first.length) return finish(2, { reason: `${first.join('; ')} — FAST-LIO2 not started` });
      }
    }
    const { facts, papers } = await paperFacts(api);
    const pre = checkPreconditions(facts);
    if (!pre.ok) return finish(2, { preconditions: pre, reason: `preconditions failed: ${pre.problems.join('; ')}` });
    // every selection of the plan against the stored page text, here (before test:live) and again at the start of run
    const db = new Db(a.data);
    let selections: string[];
    try {
      selections = checkPlanSelections(LIVE_CALL_PLAN, (k, page) => (papers[k] ? db.pageText(papers[k].id, page) : null));
    } finally {
      db.close();
    }
    return finish(selections.length ? 2 : 0, { preconditions: pre, selections: selections.length ? selections : 'ok', ...(selections.length ? { reason: `selections refused: ${selections.join('; ')}` } : {}) });
  } catch (e) {
    if (e instanceof Exit) throw e;
    return finish(2, { reason: `import failed: ${(e as Error).message}` });
  } finally {
    await api.dispose();
  }
}

// ------------------------------------------------------------------------------------------------------------------
// run

interface DbRow extends CallRow {
  clientRequestId: string | null;
  threadId: string | null;
  paperId: string | null;
}

class Db {
  private readonly sqlite;
  constructor(data: string) {
    this.sqlite = openSqlite(dataPaths(data).dbFile, { readonly: true });
  }
  rows(): DbRow[] {
    return this.sqlite
      .prepare(
        'SELECT runId, clientRequestId, task, paperId, threadId, model, effort, status, errorCode, prefixFingerprint, cacheReadTokens, cacheCreationTokens, inputTokens, outputTokens, ttftMs, durationMs, parentRunId, rateLimitJson, acceptedAt FROM llm_calls ORDER BY acceptedAt, rowid',
      )
      .all() as DbRow[];
  }
  pageText(paperId: string, page: number): string | null {
    const r = this.sqlite.prepare('SELECT text FROM page_texts WHERE paperId = ? AND page = ?').get(paperId, page) as { text: string } | undefined;
    return r?.text ?? null;
  }
  close() {
    this.sqlite.close();
  }
}

/**
 * Sampler of the server's children (pass condition 7, and the PIDs post-check looks at). Written as it goes, not only at
 * the end (a killed run keeps what it saw): a child's first sighting → a line of children.<n>.jsonl, an argv sample that
 * differs from the last one of that child → a line of argv_samples.jsonl (with the run index).
 */
class ChildSampler {
  readonly samples: ArgvSample[] = [];
  readonly children = new Map<number, ChildSeen>();
  current: { callId: string; userStrings: string[] } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lastKey = new Map<number, string>();
  constructor(
    private readonly serverPid: number,
    private readonly out: string,
    private readonly run: number,
  ) {}
  start() {
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  sample() {
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      return;
    }
    for (const e of entries) {
      if (!/^\d+$/.test(e)) continue;
      const st = readText(`/proc/${e}/stat`);
      const parsed = st ? parseProcStat(st) : null;
      if (!parsed || parsed.ppid !== this.serverPid) continue;
      const pid = Number(e);
      if (!this.children.has(pid)) {
        const seen: ChildSeen = { pid, starttime: parsed.starttime, firstCall: this.current?.callId ?? '-' };
        this.children.set(pid, seen);
        appendLine(join(this.out, childrenFile(this.run)), { run: this.run, ...seen, at: Date.now() });
      }
      const cmd = readText(`/proc/${e}/cmdline`);
      if (cmd === null || cmd === '') continue;
      const s: ArgvSample = { pid, callId: this.current?.callId ?? '-', ...judgeArgv(cmd, this.current?.userStrings ?? []) };
      const key = `${s.callId}|${s.argvChars}|${s.userTextHit}|${s.base64Hit}`;
      if (this.lastKey.get(pid) === key) continue;
      this.lastKey.set(pid, key);
      this.samples.push(s);
      appendLine(join(this.out, ARGV_SAMPLES_FILE), { run: this.run, ...s });
    }
  }
}

interface CallResult {
  outcome: CallOutcome;
  clientMs: number | null;
  runId: string | null;
  threadId: string | null;
  done: Extract<SseEvent, { event: 'run.done' }>['data'] | null;
  capture: { file: string; bytes: number; width: number; height: number } | null;
  /** glossary_define: the term stored from the suggestion (glossary.create). */
  termId?: string;
  /** glossary_define: glossary.create failed after a done call (the call itself stays done). */
  termStoreError?: string;
}

function outcomeOfSse(r: SseResult): CallOutcome {
  if (!r.terminal) return { kind: 'no_terminal' };
  if (r.terminal.event === 'run.done') return { kind: 'done' };
  if (r.terminal.event === 'run.error') return { kind: 'run_error', code: r.terminal.data.code };
  return { kind: 'no_terminal' };
}
function outcomeOfError(e: unknown): CallOutcome {
  if (e instanceof LocalApiError) {
    if (e.kind === 'timeout') return { kind: 'client_timeout' };
    if (e.kind === 'http_status') return { kind: 'http_error', status: e.status ?? 0, ...(e.errorCode ? { code: e.errorCode } : {}) };
    if (e.kind === 'schema') return { kind: 'schema_mismatch', detail: e.message.slice(0, 200) };
  }
  return { kind: 'client_error', detail: (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200) };
}

/** Run records in --out (scripts/lib/liveE2eChecks RunMeta): the next index, written exclusively so two runs never share one. */
function claimRunMeta(out: string, meta: Omit<RunMeta, 'run'>): RunMeta {
  mkdirSync(out, { recursive: true });
  for (let n = runFileIndices(out).reduce((m, r) => Math.max(m, r), 0) + 1; ; n++) {
    try {
      const m: RunMeta = { run: n, ...meta };
      writeJsonExclusive(join(out, `run.${n}.json`), m);
      return m;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}
/** The indices of every run.<n>.json in --out, readable or not (a gap or an unreadable one is a run without its record). */
function runFileIndices(out: string): number[] {
  if (!isDirectory(out)) return [];
  return readdirSync(out)
    .map((name) => RUN_META_RE.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((p, q) => p - q);
}
function runMetas(out: string): RunMeta[] {
  if (!isDirectory(out)) return [];
  const metas: RunMeta[] = [];
  for (const name of readdirSync(out)) {
    if (!RUN_META_RE.test(name)) continue;
    const t = readText(join(out, name));
    try {
      if (t !== null) metas.push(JSON.parse(t) as RunMeta);
    } catch {
      /* a torn write: post-check then finds no meta for that index */
    }
  }
  return metas.sort((p, q) => p.run - q.run);
}
const writeMeta = (out: string, m: RunMeta) => writeJson(join(out, `run.${m.run}.json`), m);

/**
 * The record files of the plan in calls/ (`<id>.json` only — not the started markers, not an earlier run's copies). An
 * unreadable record is left out (FIX4-R1-03): post-check then sees a started marker without its record (unverified),
 * evaluate a call without a record (callsNotDone), instead of every reader ending on a JSON error.
 */
function callRecords(callsDir: string): Record<string, unknown>[] {
  if (!isDirectory(callsDir)) return [];
  const out: Record<string, unknown>[] = [];
  for (const n of readdirSync(callsDir)) {
    if (callRecordFile(n) === null) continue;
    const r = readCallRecord(join(callsDir, n));
    if (r) out.push(r);
    else console.error(`live-e2e: ${join(callsDir, n)} is unreadable: counted as a call without its record`);
  }
  return out;
}
/** One call record, or null when it is missing or unreadable (torn, not an object). */
function readCallRecord(file: string): Record<string, unknown> | null {
  const t = readText(file);
  if (t === null) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
/**
 * Before a call is (re)sent: an earlier run's started marker and record of the same id are kept under
 * `<id>.started.r<k>.json` / `<id>.r<k>.json` (k = that run) instead of being overwritten.
 */
function keepEarlier(callsDir: string, id: CallId, run: number): void {
  for (const [file, kept] of [
    [`${id}.started.json`, (k: number) => `${id}.started.r${k}.json`],
    [`${id}.json`, (k: number) => `${id}.r${k}.json`],
  ] as const) {
    const t = readText(join(callsDir, file));
    if (t === null) continue;
    let k: number | null = null;
    try {
      const r = (JSON.parse(t) as { run?: unknown }).run;
      k = typeof r === 'number' ? r : null;
    } catch {
      k = null;
    }
    if (k === run) continue;
    let target = kept(k ?? 0);
    for (let i = 1; existsSync(join(callsDir, target)); i++) target = kept(k ?? 0).replace(/\.json$/, `.${i}.json`);
    renameSync(join(callsDir, file), join(callsDir, target));
  }
}

/** Keep the first observed stop on disk, including when a later lookup or cleanup fails. */
function rememberStop(a: LiveArgs, meta: RunMeta, reason: string | null): void {
  if (reason === null || meta.stoppedReason != null) return;
  meta.stoppedReason = reason;
  meta.exitCode = 3;
  writeMeta(a.out, meta);
}

/** Verdicts require an initialized ledger with the agreed caps. dry-mock alone has no ledger. */
function readRunLedger(a: LiveArgs, meta: RunMeta): LedgerView | null {
  if (a.mode === 'dry-mock') return null;
  let ledger: LedgerView;
  try {
    ledger = readLiveLedger(a.ledger!, LIVE_CAPS);
  } catch (error) {
    meta.ledgerUsed = null;
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    rememberStop(a, meta, `could not read the live ledger (${detail})`);
    return null;
  }
  meta.ledgerUsed = ledger.used;
  return ledger;
}

async function cmdRun(a: LiveArgs): Promise<void> {
  const sel: Selector = { ...(a.from ? { from: a.from as CallId } : {}), ...(a.only ? { only: a.only as CallId } : {}) };
  // the run record first: post-check counts "no call" only on this record's explicit refusedBeforeCall
  // the approval of the rate-limit warning exception (결정 26) as the run starts: watchLiveRun reads the same file
  const meta = claimRunMeta(a.out, { mode: a.mode, startedAt: Date.now(), data: resolve(a.data), serverPid: null, selector: { from: sel.from ?? null, only: sel.only ?? null }, callsStarted: 0, ...rateWarningApprovalFields(a.mode, a.ledger) });
  let thrown: unknown = undefined;
  try {
    await runInvocation(a, sel, meta);
  } catch (e) {
    thrown = meta.stoppedReason != null ? new Exit(3, meta.stoppedReason) : e;
    throw thrown;
  } finally {
    meta.endedAt = Date.now();
    meta.exitCode = thrown === undefined ? 0 : thrown instanceof Exit ? thrown.code : 3;
    if (meta.callsStarted === 0) meta.refusedBeforeCall = thrown === undefined ? 'no call selected' : thrown instanceof Error ? thrown.message.split('\n')[0]!.slice(0, 300) : String(thrown);
    try {
      writeMeta(a.out, meta);
    } catch (e) {
      console.error(`live-e2e: could not write run.${meta.run}.json: ${(e as Error).message}`);
    }
  }
}

async function runInvocation(a: LiveArgs, sel: Selector, meta: RunMeta): Promise<void> {
  const f = requireServer(a);
  meta.serverPid = f.pid;
  writeMeta(a.out, meta);
  const resume = sel.from !== undefined || sel.only !== undefined;
  // ledger state (no request yet)
  let ledger = readRunLedger(a, meta);
  rememberStop(a, meta, evaluateStoppedReason(meta.stoppedReason ?? null, ledger));
  if (meta.stoppedReason != null) throw new Exit(3, meta.stoppedReason);
  if (ledger) {
    if (a.mode === 'live' && (ledger.used.perModel.haiku ?? 0) !== 3) throw new Exit(2, `live: ledger haiku used must be 3 (test:live), is ${ledger.used.perModel.haiku ?? 0}`);
    if (a.mode === 'live' && !resume && ledger.used.total !== 3) throw new Exit(2, `live: ledger used.total must be 3 before the plan, is ${ledger.used.total}`);
    if (a.mode === 'dry-fake' && !resume && ledger.used.total !== 0) throw new Exit(2, `dry-fake: ledger used.total must be 0, is ${ledger.used.total}`);
  }
  const callsDir = join(a.out, 'calls');
  if (existsSync(callsDir) && !resume) throw new Exit(2, `${callsDir} exists: resume with --from <id> or --only <id> (the plan is never sent twice)`);

  const api = await openApi(a, f);
  const db = new Db(a.data);
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const sampler = new ChildSampler(f.pid, a.out, meta.run);
  let samplerStarted = false;
  const startedAt = meta.startedAt;
  let result: Awaited<ReturnType<typeof evaluate>>;
  try {
    const { facts, papers } = await paperFacts(api);
    const pre = checkPreconditions(facts);
    if (!pre.ok) throw new Exit(2, `preconditions failed: ${pre.problems.join('; ')}`);
    const paperOf = (k: PaperKey) => papers[k]!;
    // every selection of the plan against the stored page text (range + sha256 of the fixture text), before any call:
    // a live PDF whose text differs is refused here (exit 2, no call) instead of in the middle of the plan
    const selectionProblems = checkPlanSelections(LIVE_CALL_PLAN, (k, page) => db.pageText(paperOf(k).id, page));
    if (selectionProblems.length) throw new Exit(2, `selections refused (no call made):\n  ${selectionProblems.join('\n  ')}`);
    // calls/ and captures/ only now, right before the first call: a run refused before it leaves no calls/ behind
    mkdirSync(callsDir, { recursive: true });
    mkdirSync(join(a.out, 'captures'), { recursive: true });
    // equation (10) of FAST-LIO2 for F1 / F1r: the numbered row(s) of the structure
    const fastStructure = (await api.json<StructureResponse>('papers.structure', { params: { id: paperOf('fastlio2').id }, timeoutMs: JSON_TIMEOUT_MS })).data;
    const selectionText = (paper: PaperKey, s: Selection): string => {
      const t = db.pageText(paperOf(paper).id, s.page);
      // checked by checkPlanSelections before the first call; a change since then is an unexpected error (exit 3)
      if (t === null || s.end > t.length || s.start >= s.end) throw new Error(`selection ${paper} p${s.page} [${s.start}, ${s.end}) is outside the stored page text`);
      return t.slice(s.start, s.end);
    };
    const userStringsOf = (c: PlannedCall): string[] => {
      const t = c.target;
      if (t.kind === 'explain' || t.kind === 'translate') return [selectionText(c.paper, t.selection)];
      if (t.kind === 'chat' || t.kind === 'followup') return [t.question];
      if (t.kind === 'glossary') return [t.term];
      return [];
    };
    // existing calls of an earlier invocation (resume): F1's verdict and the thread F1 made
    const prior = (id: CallId): Record<string, unknown> | null => readCallRecord(join(callsDir, `${id}.json`));
    const threadOfCall = new Map<CallId, string>();
    for (const id of ['F1'] as const) {
      const p = prior(id);
      if (p && typeof p.threadId === 'string') threadOfCall.set(id, p.threadId);
    }

    const execute = async (c: PlannedCall, clientRequestId: string): Promise<CallResult> => {
      const t = c.target;
      const paper = paperOf(c.paper);
      const timeoutMs = runStreamTimeoutMs(c.task);
      const base: CallResult = { outcome: { kind: 'client_error', detail: 'not run' }, clientMs: null, runId: null, threadId: null, done: null, capture: null };
      const fromSse = (r: SseResult): CallResult => {
        const acc = r.events.find((e) => e.event === 'run.accepted');
        const done = r.terminal?.event === 'run.done' ? r.terminal.data : null;
        return { ...base, outcome: outcomeOfSse(r), clientMs: r.ms, runId: acc?.event === 'run.accepted' ? acc.data.runId : null, threadId: acc?.event === 'run.accepted' ? (acc.data.threadId ?? null) : null, done };
      };
      try {
        if (c.path === 'screen') {
          if (t.kind !== 'capture') throw new Error(`${c.id}: a screen call must be a capture`);
          if (!browser) {
            browser = await chromium.launch({ channel: 'chrome', headless: true });
            context = await browser.newContext({ baseURL: a.baseUrl, viewport: { width: 1400, height: 1000 } });
          }
          const page = await context!.newPage();
          const t0 = Date.now();
          try {
            await openPaper(page, { paperId: paper.id, title: paper.title, timeoutMs: SCREEN_STEP_TIMEOUT_MS });
            await showPage(page, { pageNumber: t.area.page, timeoutMs: SCREEN_STEP_TIMEOUT_MS });
            await ctrlDragArea(page, { pageNumber: t.area.page, from: t.area.from, to: t.area.to, timeoutMs: SCREEN_STEP_TIMEOUT_MS });
            const phase = await waitForAnswerTerminal(page, { start: () => chooseCapture(page, t.choice, { timeoutMs: SCREEN_STEP_TIMEOUT_MS }), timeoutMs });
            return { ...base, outcome: phase === 'done' ? { kind: 'done' } : { kind: 'client_error', detail: 'screen: the answer ended in error' }, clientMs: Date.now() - t0 };
          } finally {
            await page.close();
          }
        }
        if (t.kind === 'explain' || t.kind === 'translate') {
          const exact = selectionText(c.paper, t.selection);
          const anchor = { kind: 'text' as const, quote: { exact }, position: { page: t.selection.page, start: t.selection.start, end: t.selection.end }, rects: [] };
          return fromSse(await api.sse('threads.create', { params: { id: paper.id }, body: { kind: t.kind, anchor, clientRequestId }, timeoutMs }));
        }
        if (t.kind === 'chat') return fromSse(await api.sse('threads.create', { params: { id: paper.id }, body: { kind: 'chat', question: t.question, ...(t.deep ? { deep: true } : {}), clientRequestId }, timeoutMs }));
        if (t.kind === 'summary') return fromSse(await api.sse('cards.generate', { params: { id: paper.id, kind: 'summary' }, body: { clientRequestId }, timeoutMs }));
        if (t.kind === 'card') return fromSse(await api.sse('cards.generate', { params: { id: paper.id, kind: t.card }, body: { clientRequestId }, timeoutMs }));
        if (t.kind === 'glossary') {
          const r = fromSse(await api.sse('glossary.define', { params: { id: paper.id }, body: { term: t.term, clientRequestId }, timeoutMs }));
          // store the suggestion like the panel's "저장" (glossary.create with the run id): its citations are matched then.
          // This is the script's own step after the LLM call: its failure (409 for a term stored by an earlier --only O7,
          // an empty name, …) is recorded as termStoreError (calls/O7.json and live_e2e.json calls) and the call stays
          // `done`; condition 3 then lists `O7:term` in missingOwners and is not_evaluated (not a pass → exit 1).
          const item = (r.done?.parsed as ParsedBlocks | null)?.items?.[0];
          if (r.outcome.kind === 'done' && item && item.tag === 'term' && typeof item.attrs.name === 'string' && r.runId) {
            try {
              const term = (await api.json<GlossaryTermDto>('glossary.create', { params: { id: paper.id }, body: { term: item.attrs.name.slice(0, 200), definitionKo: item.body.slice(0, 4000), llmCallId: r.runId }, timeoutMs: JSON_TIMEOUT_MS })).data;
              return { ...r, termId: term.id };
            } catch (e) {
              return { ...r, termStoreError: describeOutcome(outcomeOfError(e)) };
            }
          }
          return r;
        }
        if (t.kind === 'equation_tab') {
          const rows = fastStructure.equations.filter((e) => e.number === t.eqNumber);
          if (rows.length === 0) throw new Error(`equation (${t.eqNumber}) is not in the structure`);
          const r = fromSse(await api.sse('threads.create', { params: { id: paper.id }, body: { kind: 'equation', equationId: rows[0]!.id, clientRequestId }, timeoutMs }));
          if (r.threadId) threadOfCall.set(c.id, r.threadId);
          return r;
        }
        if (t.kind === 'followup') {
          const threadId = threadOfCall.get(t.of);
          if (!threadId) throw new Error(`${c.id}: no thread of ${t.of}`);
          return fromSse(await api.sse('messages.create', { params: { id: threadId }, body: { text: t.question, ...(t.deep ? { deep: true } : {}), clientRequestId }, timeoutMs }));
        }
        throw new Error(`${c.id}: unknown target`);
      } catch (e) {
        if (e instanceof Exit) throw e;
        return { ...base, outcome: outcomeOfError(e) };
      }
    };

    // F1's verdict from an earlier run (resume): calls/F1.json's f1Passed, or — none recorded — looked up again before
    // the first call, with the record's own thread and run; a failed lookup ends the run here (exit 3, no call) instead
    // of sending F1r on a guess (FIX4-R2-01, FIX4-R3-01: resolveF1Resume)
    let state: RunState = initialRunState();
    const f1Resume = await resolveF1Resume(prior('F1'), sel, (CALL_BY_ID.F1.target as { eqNumber: string }).eqNumber, (threadId, runId) => equationAttempt(api, 'F1', threadId, runId));
    if ('stop' in f1Resume) throw new Exit(3, f1Resume.stop);
    state.f1Passed = f1Resume.f1Passed;
    sampler.start();
    samplerStarted = true;
    const skipped: { id: string; record: string }[] = [];
    const retryModel = CALL_BY_ID.F1r.model;
    for (;;) {
      const rowsBefore = db.rows();
      const known = new Set(rowsBefore.map((r) => r.runId));
      let retryModelLeft: number;
      if (a.mode === 'dry-mock') retryModelLeft = LIVE_CAPS.perModel[retryModel] - rowsBefore.filter((r) => r.model === retryModel).length;
      else {
        ledger = readRunLedger(a, meta);
        if (!ledger) break;
        retryModelLeft = (ledger.caps?.perModel[retryModel] ?? 0) - (ledger.used.perModel[retryModel] ?? 0);
      }
      // I9: before every call readLiveLedger — stopped / stopRequested → exit 3. The ledger read right after a call goes
      // into nextAction, which stops on it first (M-M2-R4-1: e.g. a done call whose CLI reported a rejected status, or an
      // allowed_warning without ALLOW_RATE_WARNING — watchLiveRun stopped the ledger, the run itself ended with run.done;
      // with the approval (결정 26) a warning is only recorded and the plan goes on); stepAtEnd below covers the end
      const d = stepBeforeCall(state, sel, retryModelLeft, ledger);
      // Skipped calls and the end of a selector still observe stops.
      if (d.kind !== 'call' && d.kind !== 'stop') {
        rememberStop(a, meta, stepAtEnd(state, ledger, d.kind === 'skip' ? d.call.id : undefined).state.stopped);
        if (meta.stoppedReason != null) break;
      }
      if (d.kind === 'end') break;
      if (d.kind === 'stop') {
        state = d.state;
        rememberStop(a, meta, state.stopped);
        break;
      }
      if (d.kind === 'skip') {
        if (d.record !== 'not_selected') {
          skipped.push({ id: d.call.id, record: d.record });
          keepEarlier(callsDir, d.call.id, meta.run);
          writeJson(join(callsDir, `${d.call.id}.json`), { id: d.call.id, run: meta.run, skipped: d.record, at: Date.now() });
        }
        state = afterSkip(state);
        continue;
      }
      const c = d.call;
      const userStrings = userStringsOf(c);
      // the started marker before the request (post-check: a marker without its record = child state unverified)
      const requestId = randomUUID();
      keepEarlier(callsDir, c.id, meta.run);
      writeJson(join(callsDir, `${c.id}.started.json`), { id: c.id, run: meta.run, requestId, startedAt: Date.now() } satisfies StartedMarker);
      meta.callsStarted++;
      writeMeta(a.out, meta);
      sampler.current = { callId: c.id, userStrings };
      const res = await execute(c, requestId);
      // the minimal record right after the terminal, before any lookup that could throw (INT-I10-02)
      const callFile = join(callsDir, `${c.id}.json`);
      writeJson(callFile, { id: c.id, run: meta.run, requestId, outcome: describeOutcome(res.outcome), runId: res.runId, threadId: res.threadId, model: c.model, minimal: true, at: Date.now() });
      sampler.sample();
      sampler.current = null;
      // follow-up lookups: each failure is kept in the record; the DB rows and the ledger decide the verdict, so their
      // failure stops the run (exit 3) with the record written, as does F1 / F1r's equation lookup (below); a capture lookup
      // failure only goes into the record
      const lookupErrors: string[] = [];
      const lookup = async <T,>(what: string, fn: () => T | Promise<T>, fallback: T): Promise<T> => {
        try {
          return await fn();
        } catch (e) {
          lookupErrors.push(`${what}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200)}`);
          return fallback;
        }
      };
      const fresh = await lookup('llm_calls rows', () => db.rows().filter((r) => !known.has(r.runId)), null as DbRow[] | null);
      const primary = fresh ? ((res.runId ? fresh.find((r) => r.runId === res.runId) : undefined) ?? fresh.find((r) => r.parentRunId === null) ?? null) : null;
      const repairs = primary && fresh ? fresh.filter((r) => r.parentRunId === primary.runId).length : 0;
      let outcome = res.outcome;
      // screen calls see only the panel phase: the stored run tells the code
      if (c.path === 'screen' && outcome.kind === 'client_error' && primary?.errorCode) outcome = { kind: 'run_error', code: primary.errorCode as never };
      if (c.path === 'screen' && outcome.kind === 'done' && primary && primary.status !== 'ok') outcome = primary.errorCode ? { kind: 'run_error', code: primary.errorCode as never } : { kind: 'client_error', detail: `screen: run status ${primary.status}` };
      if (a.mode !== 'dry-mock') {
        ledger = readRunLedger(a, meta);
        if (!ledger) lookupErrors.push(meta.stoppedReason!);
      }
      const ledgerOk = a.mode === 'dry-mock' || ledger !== null;
      const outcomeVerdict = nextAction(c, outcome, state.consecutiveSoft, ledger);
      // A later equation/capture lookup may fail. Record the observed stop before awaiting one.
      if (ledger && (ledger.stopped !== null || ledger.stopRequested !== null)) rememberStop(a, meta, outcomeVerdict.reason);
      const threadId = res.threadId ?? primary?.threadId ?? null;
      // F1 / F1r: the equation-deep verdict decides whether F1r is sent. A failed lookup leaves it unknown, so
      // the run stops (exit 3, the record kept, no f1Passed) instead of spending the retry on a guess (FIX4-R1-05); the
      // verdict can be rebuilt later with `evaluate`. Without the llm_calls rows (fresh === null) the verdict is unknown too
      // (no f1Passed recorded, so a resume looks it up again — FIX4-R2-01); the run id falls back to the terminal's
      let f1Passed: boolean | undefined;
      let f1Unknown = false;
      if (c.id === 'F1' || c.id === 'F1r') {
        const attempt = fresh === null ? null : await lookup('equation attempt', () => equationAttempt(api, c.id as 'F1' | 'F1r', threadId, primary?.runId ?? res.runId), null);
        if (attempt === null) f1Unknown = true;
        else f1Passed = equationDeepVerdict(attempt, (c.target as { eqNumber: string }).eqNumber).ok;
      }
      const critical = fresh === null || !ledgerOk || f1Unknown;
      const v: Verdict = critical ? { action: 'stop', reason: `a lookup after the call failed (${lookupErrors.join('; ')}); the record is kept` } : outcomeVerdict;
      if (v.action === 'stop') rememberStop(a, meta, v.reason);
      // capture PNG of a screen call
      let capture: CallResult['capture'] = null;
      if (c.path === 'screen' && threadId) {
        capture = await lookup(
          'capture',
          async () => {
            const th = (await api.json<ThreadDetailResponse>('threads.get', { params: { id: threadId }, timeoutMs: JSON_TIMEOUT_MS })).data.thread;
            if (!th.imageFileId) return null;
            const png = (await api.bytes('papers.capture', { params: { id: th.paperId, fileId: th.imageFileId }, timeoutMs: JSON_TIMEOUT_MS })).body;
            // per run (FIX4-R1-04): a resend of O2 / O9 / F3 never replaces the PNG an earlier run's record points to
            const file = join(a.out, captureFile(c.id, meta.run));
            writeFileSync(file, png, { flag: 'wx' });
            const ins = inspectPngBytes(png);
            return ins.ok ? { file, bytes: ins.bytes, width: ins.width, height: ins.height } : { file, bytes: png.length, width: -1, height: -1 };
          },
          null,
        );
      }
      const rec = {
        id: c.id,
        run: meta.run,
        requestId,
        task: c.task,
        model: primary?.model ?? c.model,
        effort: c.effort,
        path: c.path,
        outcome: describeOutcome(outcome),
        decision: `${v.action}: ${v.reason}`,
        clientMs: res.clientMs,
        runId: primary?.runId ?? res.runId,
        threadId,
        status: primary?.status ?? null,
        errorCode: primary?.errorCode ?? null,
        ttftMs: primary?.ttftMs ?? null,
        durationMs: primary?.durationMs ?? null,
        cacheReadTokens: primary?.cacheReadTokens ?? null,
        cacheCreationTokens: primary?.cacheCreationTokens ?? null,
        inputTokens: primary?.inputTokens ?? null,
        outputTokens: primary?.outputTokens ?? null,
        prefixFingerprint: primary?.prefixFingerprint != null,
        repairs,
        newRows: fresh?.length ?? null,
        userStringChars: userStrings.map((s) => s.length),
        ...(res.termId ? { termId: res.termId } : {}),
        ...(res.termStoreError ? { termStoreError: res.termStoreError } : {}),
        capture,
        ...(f1Passed !== undefined ? { f1Passed } : {}),
        ...(lookupErrors.length ? { lookupErrors } : {}),
        at: Date.now(),
      };
      writeJson(callFile, rec);
      console.log(JSON.stringify({ call: c.id, outcome: rec.outcome, decision: rec.decision, clientMs: rec.clientMs }));
      if (c.id === 'F1' && f1Passed !== undefined) state.f1Passed = f1Passed;
      const after = stepAfterCall(state, v);
      state = after.state;
      if (after.exitCode !== null) break;
    }
    const endLedger = readRunLedger(a, meta);
    rememberStop(a, meta, stepAtEnd(state, endLedger).state.stopped);
    sampler.stop();
    sampler.sample();

    // everything this invocation and the earlier ones of the same --out made (resume): the calls/ files
    try {
      result = await evaluate(api, a, { judge: 'run', run: meta.run, calls: callRecords(callsDir), rows: db.rows(), papers: { kiss: paperOf('kiss'), fastlio2: paperOf('fastlio2') }, skipped, sel, startedAt });
    } catch (e) {
      throw new Error(`the plan ended but evaluating it failed (rebuild live_e2e.json with \`live-e2e.ts evaluate\`, no LLM call): ${(e as Error).message}`);
    }
  } finally {
    sampler.stop();
    // the last look at the children, whatever ended the run (children.<n>.jsonl already has every earlier sighting)
    if (samplerStarted) {
      try {
        sampler.sample();
      } catch (e) {
        console.error(`live-e2e: could not sample the children: ${(e as Error).message}`);
      }
    }
    await closeJudgmentResources(a, meta, db, api, browser);
  }
  finishResult(a, meta, result);
}

async function closeJudgmentResources(a: LiveArgs, meta: RunMeta, db: Db, api: LocalApi, browser: Browser | null = null): Promise<void> {
  const resources: [string, () => void | Promise<void>][] = [
    ['api', () => api.dispose()], ['database', () => db.close()],
  ];
  if (browser) resources.unshift(['browser', () => browser.close()]);
  for (const [name, close] of resources) {
    try { await close(); }
    catch { rememberStop(a, meta, `could not close the ${name} during judgment`); }
  }
}

/**
 * The judgement of run n (run and evaluate): schema-checked, written to live_e2e.<n>.json — never over an existing one
 * (a later evaluate of the same run goes to live_e2e.<n>.evaluate.<k>.json) — and to live_e2e.json (the latest
 * aggregate); then the summary line and the exit code.
 */
function finishResult(a: LiveArgs, meta: RunMeta, result: Awaited<ReturnType<typeof evaluate>>): void {
  // All asynchronous lookups and cleanup have finished. Publish one observation to every verdict.
  const ledger = readRunLedger(a, meta);
  const stoppedReason = evaluateStoppedReason(meta.stoppedReason ?? null, ledger);
  const code = evaluateExitCode(stoppedReason, result.conditions);
  const run = meta.run;
  const ledgerUsed = ledger?.used ?? null;
  const out = { ...result, records: { ...result.records, ledgerUsed }, stoppedReason, exitCode: code };
  LiveE2eResultSchema.parse(out);
  meta.stoppedReason = stoppedReason;
  meta.ledgerUsed = ledgerUsed;
  meta.exitCode = code;
  writeMeta(a.out, meta);
  writeExclusive(a.out, liveE2eRunFile(run), (k) => `live_e2e.${run}.evaluate.${k}.json`, out);
  writeJson(join(a.out, 'live_e2e.json'), out);
  console.log(JSON.stringify(summaryLine(run, code, stoppedReason, out)));
  if (code !== 0) throw new Exit(code as 1 | 3, code === 3 ? `stopped: ${stoppedReason}` : 'pass conditions not all met');
}

/**
 * `evaluate`: live_e2e.json rebuilt from calls/ + the DB + read-only API requests (lists and gets — no LLM call, no
 * POST, no arXiv request), for the last run of --out that started a call (evaluateTarget: its selector, start, stop
 * reason and skips; a later run refused before its first call is not judged). Same server environment check as run. Exit
 * codes as run's (0 pass · 1 conditions failed · 3 the run had stopped — its stored stoppedReason, or, with none stored,
 * a ledger that is STOP / STOP_REQUESTED now: evaluateStoppedReason, 결정 33).
 */
async function cmdEvaluate(a: LiveArgs): Promise<void> {
  const f = requireServer(a);
  const metas = runMetas(a.out);
  if (metas.length === 0) throw new Exit(2, `no run record (run.<n>.json) in ${a.out}`);
  const latest = evaluateTarget(metas);
  if (!latest) throw new Exit(2, `no run of ${a.out} started a call: nothing to evaluate`);
  const callsDir = join(a.out, 'calls');
  if (!isDirectory(callsDir)) throw new Exit(2, `${callsDir} does not exist: the run made no call`);
  const firstLedger = readRunLedger(a, latest);
  rememberStop(a, latest, evaluateStoppedReason(latest.stoppedReason ?? null, firstLedger));
  const api = await openApi(a, f);
  const db = new Db(a.data);
  let result: Awaited<ReturnType<typeof evaluate>>;
  try {
    const { papers } = await paperFacts(api);
    if (!papers.kiss || !papers.fastlio2) throw new Exit(2, 'the two live papers are not in the data directory');
    const calls = callRecords(callsDir);
    const skipped = LIVE_CALL_PLAN.map((c) => calls.find((r) => r.id === c.id && r.run === latest.run && typeof r.skipped === 'string')).filter((r): r is Record<string, unknown> => r !== undefined).map((r) => ({ id: String(r.id), record: String(r.skipped) }));
    const sel: Selector = { ...(latest.selector.from ? { from: latest.selector.from as CallId } : {}), ...(latest.selector.only ? { only: latest.selector.only as CallId } : {}) };
    result = await evaluate(api, a, { judge: 'evaluate', run: latest.run, calls, rows: db.rows(), papers: { kiss: papers.kiss, fastlio2: papers.fastlio2 }, skipped, sel, startedAt: latest.startedAt });
  } catch (error) {
    if (latest.stoppedReason != null) throw new Exit(3, latest.stoppedReason);
    throw error;
  } finally {
    await closeJudgmentResources(a, latest, db, api);
  }
  finishResult(a, latest, result);
}

async function equationAttempt(api: LocalApi, id: 'F1' | 'F1r', threadId: string | null, runId: string | null): Promise<EquationDeepAttempt> {
  if (!threadId || !runId) return { id, text: null, citations: null };
  const th = (await api.json<ThreadDetailResponse>('threads.get', { params: { id: threadId }, timeoutMs: JSON_TIMEOUT_MS })).data;
  const m = th.messages.find((x) => x.role === 'assistant' && x.llmCallId === runId);
  if (!m) return { id, text: null, citations: null };
  const parsed = parseAnswer(m.contentMd, { final: true });
  const paired = pairCitations(parsed.citations, m.citations);
  return { id, text: m.contentMd, citations: paired ? [...paired.values()] : null };
}

interface EvalInput {
  /** 'run': judged as the run ends (condition 8 = the earlier runs); 'evaluate': judged afterwards (cond8Evaluate). */
  judge: 'run' | 'evaluate';
  /** The run index being judged (conditions 7 and 8 also look at every other run of --out). */
  run: number;
  calls: Record<string, unknown>[];
  rows: DbRow[];
  papers: Record<PaperKey, LivePaper>;
  skipped: { id: string; record: string }[];
  sel: Selector;
  startedAt: number;
}

async function evaluate(api: LocalApi, a: LiveArgs, x: EvalInput) {
  const rowOf = (id: CallId): DbRow | null => {
    const r = x.calls.find((c) => c.id === id);
    return r && typeof r.runId === 'string' ? (x.rows.find((row) => row.runId === r.runId) ?? null) : null;
  };
  const executed = LIVE_CALL_PLAN.filter((c) => x.calls.some((r) => r.id === c.id && typeof r.runId === 'string'));
  // plan order: the primary llm_calls rows of the executed calls, in acceptedAt order, vs the plan
  const primaryRows = executed.map((c) => rowOf(c.id)).filter((r): r is DbRow => r !== null);
  const actual = [...primaryRows].sort((p, q) => p.acceptedAt - q.acceptedAt).map((r) => `${r.task}/${r.model}/${r.effort}`);
  const expected = executed.map((c) => `${c.task}/${c.model}/${c.effort}`);
  const planOrder = { pass: actual.length === expected.length && actual.every((v, i) => v === expected[i]), expected, actual };

  // owners of this run (messages, card items, terms) → chips and labels
  const owners: OwnerChips[] = [];
  const cardItems: { call: CallId; kind: string; item: CardItemDto; facts: CardItemFacts }[] = [];
  let notation: CardItemFacts[] | null = null;
  const quoteStatus: Record<string, number> = {};
  const eqStatus: Record<string, number> = {};
  let msgP = 0;
  let msgPEq = 0;
  const countCitations = (cs: readonly Citation[]) => {
    for (const ci of cs) {
      const bucket = ci.kind === 'quote' ? quoteStatus : eqStatus;
      bucket[ci.status] = (bucket[ci.status] ?? 0) + 1;
    }
  };
  const threadsSeen = new Map<string, ThreadDetailResponse>();
  const cardsOf = new Map<string, ListCardsResponse>();
  // a call that ended with run.done must have a stored answer (message / card / term): when it is not found, its chips
  // cannot be checked → missingOwners (condition 3 is then not_evaluated, never a pass)
  const missingOwners: string[] = [];
  const missing = (id: CallId, kind: 'message' | 'card' | 'term') => {
    if (x.calls.find((r) => r.id === id)?.outcome === 'run.done') missingOwners.push(`${id}:${kind}`);
  };
  for (const c of executed) {
    const ownerKind = c.task === 'summary' || c.task === 'notation_card' || c.task === 'assumptions_card' ? 'card' : c.task === 'glossary_define' ? 'term' : 'message';
    const row = rowOf(c.id);
    if (!row) {
      missing(c.id, ownerKind);
      continue;
    }
    if (c.task === 'summary' || c.task === 'notation_card' || c.task === 'assumptions_card') {
      const pid = x.papers[c.paper].id;
      if (!cardsOf.has(pid)) cardsOf.set(pid, (await api.json<ListCardsResponse>('cards.list', { params: { id: pid }, timeoutMs: JSON_TIMEOUT_MS })).data);
      const card = cardsOf.get(pid)!.cards.find((k) => k.runId === row.runId);
      if (!card) {
        missing(c.id, 'card');
        continue;
      }
      const labels = card.kind === 'summary' ? 'badge' : 'strip';
      const facts: CardItemFacts[] = [];
      for (const it of card.items) {
        const parsed = parseAnswer(it.bodyMd, { final: true, labels });
        owners.push({ owner: `${c.id}:item${it.ordinal}`, parsed: parsed.citations, stored: it.citations });
        countCitations(it.citations);
        const fct: CardItemFacts = { key: it.key, label: it.label as GroundingLabel | null, badge: badgeOf(it.label as GroundingLabel | null, parsed.citations, it.citations) };
        facts.push(fct);
        if (card.kind !== 'summary') cardItems.push({ call: c.id, kind: card.kind, item: it, facts: fct });
      }
      if (c.id === 'F2') notation = facts;
      continue;
    }
    if (c.task === 'glossary_define') {
      const pid = x.papers[c.paper].id;
      const termId = x.calls.find((r) => r.id === c.id)?.termId;
      const terms = termId === undefined ? [] : (await api.json<ListGlossaryResponse>('glossary.list', { params: { id: pid }, timeoutMs: JSON_TIMEOUT_MS })).data.terms.filter((t: GlossaryTermDto) => t.id === termId);
      if (terms.length === 0) missing(c.id, 'term');
      for (const t of terms) {
        const parsed = parseAnswer(t.definitionKo ?? '', { final: true });
        owners.push({ owner: `${c.id}:term`, parsed: parsed.citations, stored: t.citations });
        countCitations(t.citations);
      }
      continue;
    }
    const threadId = row.threadId;
    if (!threadId) {
      missing(c.id, 'message');
      continue;
    }
    if (!threadsSeen.has(threadId)) threadsSeen.set(threadId, (await api.json<ThreadDetailResponse>('threads.get', { params: { id: threadId }, timeoutMs: JSON_TIMEOUT_MS })).data);
    const th = threadsSeen.get(threadId)!;
    const answers = th.messages.filter((mm) => mm.role === 'assistant' && mm.llmCallId === row.runId);
    if (answers.length === 0) missing(c.id, 'message');
    for (const m of answers) {
      const plain = th.thread.kind === 'translate';
      const parsed = parseAnswer(m.contentMd, { final: true, mode: plain ? 'plain' : 'markup' });
      owners.push({ owner: `${c.id}:message`, parsed: parsed.citations, stored: m.citations });
      countCitations(m.citations);
      const st: MessageStats | null = m.stats;
      if (st) {
        msgP += st.blocks.p + st.blocks.pEquationOnly + st.blocks.pUnverified;
        msgPEq += st.blocks.pEquationOnly;
      }
    }
  }

  const f1Attempts: EquationDeepAttempt[] = [];
  for (const id of ['F1', 'F1r'] as const) {
    const r = x.calls.find((cc) => cc.id === id && typeof cc.runId === 'string');
    if (r) f1Attempts.push(await equationAttempt(api, id, (r.threadId as string | null) ?? rowOf(id)?.threadId ?? null, r.runId as string));
  }
  const deepSelected = LIVE_CALL_PLAN.filter((c) => (c.id === 'O4' || c.id === 'O10') && selected(c.id, x.sel)).length;
  const deepRows = (['O4', 'O10'] as const).map((id) => rowOf(id)).filter((r): r is DbRow => r !== null);
  const translateSelected = LIVE_CALL_PLAN.filter((c) => (c.id === 'S1' || c.id === 'S2' || c.id === 'S3') && selected(c.id, x.sel)).length;
  const translateRows = (['S1', 'S2', 'S3'] as const).map((id) => rowOf(id)).filter((r): r is DbRow => r !== null);
  const conditions: Condition[] = [
    cond1Notation(notation),
    cond2EquationDeep(f1Attempts, '10'),
    cond3Chips(owners, missingOwners),
    cond4CapturePrefix(rowOf('O1'), rowOf('O2')),
    cond5TranslateNoPrefix(translateRows, translateSelected),
    cond6DeepEffort(deepRows, deepSelected),
    // 7 and 8 over every run of --out: an earlier run's argv hit or child failure keeps the result not pass
    cond7Argv(readJsonLines(join(a.out, ARGV_SAMPLES_FILE)) as unknown as ArgvSample[], runMetas(a.out)),
    // run: its own children are post-check's (after it); evaluate: after the fact, run n's own post-check is included
    x.judge === 'evaluate' ? cond8Evaluate(x.run, runMetas(a.out), postCheckResults(a.out), runFileIndices(a.out)) : cond8EarlierRuns(x.run, runMetas(a.out), postCheckResults(a.out)),
  ];

  // records (not pass criteria)
  const labelled = cardItems.filter((ci) => ci.facts.label !== null);
  const cardLabels: Record<string, number> = {};
  const cardBadges: Record<string, number> = {};
  for (const ci of cardItems) {
    cardLabels[ci.facts.label ?? 'none'] = (cardLabels[ci.facts.label ?? 'none'] ?? 0) + 1;
    cardBadges[ci.facts.badge] = (cardBadges[ci.facts.badge] ?? 0) + 1;
  }
  const pItems = labelled.filter((ci) => ci.facts.label === 'P');
  const pEqItems = pItems.filter((ci) => ci.facts.badge === 'equation_ref').length;
  const stated = cardItems.filter((ci) => ci.call === 'F2' && ci.facts.key !== null && (FASTLIO2_STATED_KEYS as readonly string[]).includes(ci.facts.key));
  const statedP = stated.filter((ci) => ci.facts.label === 'P' && (ci.facts.badge === 'grounded_quote' || ci.facts.badge === 'equation_ref')).length;
  const eqTotal = Object.values(eqStatus).reduce((s, n) => s + n, 0);
  const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
  // A minimal record from an older plan may only identify the model in its saved DB row.
  const calls = LIVE_CALL_PLAN.map((c) => {
    const r = x.calls.find((rr) => rr.id === c.id && rr.skipped === undefined);
    if (r === undefined) return undefined;
    const model = r.model ?? x.rows.find((row) => row.runId === r.runId)?.model ?? 'unknown';
    return callRecordOf({ task: c.task, effort: c.effort, path: c.path, decision: 'unknown (minimal record)', ...r, model });
  }).filter((r): r is CallRecord => r !== undefined);
  const deepTasks = new Set<string>(Object.values(TASK_SPECS).filter((spec) => spec.model === 'deepModel').map((spec) => spec.id));
  const seenTask = new Set<string>();
  const timings = calls.map((r) => {
    const key = `${r.task}`;
    const cold = r.cacheReadTokens === null ? null : !seenTask.has(key) && (r.cacheReadTokens ?? 0) === 0;
    seenTask.add(key);
    return { id: r.id, task: r.task, ttftMs: r.ttftMs, durationMs: r.durationMs, cold };
  });
  let seven: number | null = null;
  // the rows of this --out's calls and their SP-Blocks repairs
  const ownIds = new Set(calls.map((c) => c.runId).filter((id): id is string => id !== null));
  for (const r of x.rows.filter((rr) => ownIds.has(rr.runId) || (rr.parentRunId !== null && ownIds.has(rr.parentRunId)))) {
    if (!r.rateLimitJson) continue;
    try {
      const v = (JSON.parse(r.rateLimitJson) as { sevenDayUtilization?: number | null }).sevenDayUtilization;
      if (typeof v === 'number') seven = v;
    } catch {
      /* not JSON */
    }
  }
  const arx = readText(join(a.out, 'arxiv_requests.json'));
  const repairsTotal = x.rows.filter((r) => r.parentRunId !== null && calls.some((c) => c.runId === r.parentRunId)).length;
  return {
    mode: a.mode,
    ...rateWarningResultFields(a.mode, a.ledger, calls, x.rows),
    startedAt: x.startedAt,
    finishedAt: Date.now(),
    selector: { from: x.sel.from ?? null, only: x.sel.only ?? null },
    calls,
    skipped: x.skipped,
    planOrder,
    callsNotDone: callsNotDone(LIVE_CALL_PLAN, x.calls),
    records: {
      timings,
      chatLowVsDeep: { lowTtftMs: calls.find((c) => c.id === 'O3')?.ttftMs ?? null, deepTtftMs: calls.find((c) => c.id === 'O4')?.ttftMs ?? null },
      v2PrefixCache: calls.filter((c) => c.prefixFingerprint).map((c) => ({ id: c.id, cacheCreationTokens: c.cacheCreationTokens, cacheReadTokens: c.cacheReadTokens })),
      quoteStatus,
      uncheckedQuotes: quoteStatus.unchecked ?? 0,
      eqStatus,
      eqResolvedRatio: ratio(eqStatus.resolved ?? 0, eqTotal),
      cardLabels,
      cardBadges,
      unverifiedRatio: ratio(cardBadges.unverified ?? 0, labelled.length),
      pEquationOnly: { cardItems: pEqItems, cardP: pItems.length, messageBlocks: msgPEq, messageP: msgP, ratio: ratio(pEqItems + msgPEq, pItems.length + msgP) },
      fastlio2StatedKeys: { keys: [...FASTLIO2_STATED_KEYS], pWithEvidence: statedP, ratio: ratio(statedP, FASTLIO2_STATED_KEYS.length) },
      deepTasks: calls.filter((c) => deepTasks.has(c.task)).map((c) => ({ id: c.id, model: c.model, durationMs: c.durationMs, over600s: c.durationMs === null ? null : c.durationMs > 600_000 })),
      fable: calls.filter((c) => c.model === 'fable').map((c) => ({ id: c.id, durationMs: c.durationMs, over600s: c.durationMs === null ? null : c.durationMs > 600_000 })),
      repairs: repairsTotal,
      translateInputTokens: calls.filter((c) => c.task === 'translate_selection').map((c) => ({ id: c.id, inputTokens: c.inputTokens })),
      sevenDayUtilization: seven,
      arxivRequests: arx ? (({ used, max }) => ({ used, max }))(JSON.parse(arx) as { used: number; max: number | null }) : null,
    },
    conditions,
  };
}

// ------------------------------------------------------------------------------------------------------------------
// post-check

/** Processes whose working directory is <data>/claude-cwd — where the server starts every claude child (by real path). */
function processesInClaudeCwd(data: string): number[] {
  const cwd = existingRealpath(join(resolve(data), 'claude-cwd'));
  const found: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    let target: string;
    try {
      target = readlinkSync(`/proc/${e}/cwd`);
    } catch {
      continue; // gone, or another user's process
    }
    if (target === cwd || target.startsWith(cwd + sep)) found.push(Number(e));
  }
  return found;
}

function cmdPostCheck(out: string): void {
  const metas = runMetas(out);
  let meta = metas[metas.length - 1] ?? null;
  // the latest run.<n>.json unreadable (torn by a kill, FIX4-R1-03): that run is the one judged, as a run that did not
  // end through its own code — never the earlier readable one, which would pass again under a new name
  const lastIndex = runFileIndices(out).pop();
  if (lastIndex !== undefined && (meta === null || meta.run < lastIndex)) {
    console.error(`live-e2e: run.${lastIndex}.json is unreadable: run ${lastIndex} is judged as not ended`);
    meta = { run: lastIndex, mode: meta?.mode ?? 'dry-mock', startedAt: 0, data: meta?.data ?? '', serverPid: null, selector: { from: null, only: null }, callsStarted: 0 };
  }
  const callsDir = join(out, 'calls');
  const markers: StartedMarker[] = [];
  if (isDirectory(callsDir))
    for (const n of readdirSync(callsDir)) {
      if (startedMarkerFile(n) === null) continue;
      try {
        markers.push(JSON.parse(readFileSync(join(callsDir, n), 'utf8')) as StartedMarker);
      } catch {
        markers.push({ id: startedMarkerFile(n)!, run: meta?.run ?? -1, requestId: '?', startedAt: 0 }); // unreadable: started (the safe side)
      }
    }
  const finished = new Set(
    callRecords(callsDir)
      .filter((r) => meta !== null && r.run === meta.run && r.skipped === undefined)
      .map((r) => String(r.id)),
  );
  const seen = meta ? readJsonLines(join(out, childrenFile(meta.run))) : [];
  const children = seen.map((c) => {
    const st = readText(`/proc/${String(c.pid)}/stat`);
    const p = st ? parseProcStat(st) : null;
    return { pid: Number(c.pid), alive: p !== null && p.starttime === c.starttime };
  });
  // independent of the records: any process still working in the claude-cwd of a data directory this --out ran on
  const leftover = [...new Set(metas.flatMap((m) => processesInClaudeCwd(m.data)))];
  const verdict = postCheckVerdict(meta, markers, finished, children, leftover);
  const condition = cond8OfVerdict(verdict, children.length);
  // the first post-check of a run is its evidence: a re-check of the same run never replaces it
  writeExclusive(out, postCheckFile(verdict.run ?? 0), (k) => `post_check.${verdict.run ?? 0}.re${k}.json`, { at: Date.now(), run: verdict.run, verdict, condition });
  console.log(JSON.stringify({ postCheck: verdict.result, run: verdict.run, children: children.length, alive: verdict.alive.length, leftover: verdict.leftover.length, reason: verdict.reason }));
  if (verdict.result === 'fail' || verdict.result === 'unverified') throw new Exit(1, verdict.reason);
}

// ------------------------------------------------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  if (a.command === 'check-args') {
    // parseArgs refused anything wrong (exit 2); nothing else is touched here
    console.log(JSON.stringify({ checkArgs: 'ok', mode: a.mode }));
    return;
  }
  if (a.command === 'post-check') return cmdPostCheck(resolve(a.out));
  if (a.command === 'init') return cmdInit(a);
  if (a.command === 'evaluate') return cmdEvaluate(a);
  if (a.command === 'import') return cmdImport(a);
  return cmdRun(a);
}

export async function liveE2eExit(argv: string[]): Promise<number> {
  try {
    await main(argv);
    return 0;
  } catch (e) {
    if (e instanceof Exit) {
      console.error(`live-e2e: ${e.message}`);
      return e.code;
    }
    console.error(`live-e2e: unexpected error: ${(e as Error)?.stack ?? String(e)}`);
    return 3;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  liveE2eExit(process.argv.slice(2)).then((code) => process.exit(code));
}

export type { PlannedCall };
export { CALL_BY_ID };
