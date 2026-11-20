// Real-data rehearsal driver (PLAN_M2 7절 5, 3.1 보존 검증; BRIEF_INTEGRATION I7). Owner: supervisor.
// A client + DB reader only: the servers are started and stopped by shell (by PID), this script never starts a process
// and talks HTTP only through scripts/lib/localApi.ts (loopback, explicit timeouts). It works on COPIES of the user's
// data ($REH/{fwd,rb,inj}); outputs carry row counts, sha256, ids, statuses and distributions — never thread, message,
// highlight or note text.
//
//   precheck      --snapshot <fwd/pre> --out <dir>
//                 the migrate-BEFORE DB (a copy of the snapshot DB): the two papers' (arxivId, version), supplement v1,
//                 structureSource 'none', equations 0 rows, every statsJson eqRefs.resolved + noAnchor = 0, equation
//                 citation status distribution                                                       → precheck.json
//   forward       --base-url <m2 dev server> --data <fwd/data> --pre <fwd/pre> --structure-eval <structure_eval.json>
//                 --server-log <log> --out <dir>
//                 papers.upgradeStructure on both papers → job.done; then (before any new run) the 6-table dump, the
//                 papers row (D4), the files, papers.get, the structure vs the gold; then one mock explain per paper →
//                 a new prefixFingerprint                                                            → forward.json
//   mutate        --base-url <m2 dev server> --data <rb/data> --server-log <log> --out <dir>
//                 delete one existing paper, import 2301.00001 (offline), one area highlight with a PNG, one note
//                                                                                                    → mutate.json
//   verify-m1     --base-url <m1-ref dev server> --data <rb/data> --snapshot <rb/pre-m2> --orig <orig> --mutate <mutate.json>
//                 --server-log <m1 log> --out <dir>   GET only (the m1 server has no network guard)  → rollback-m1.json
//   rollback-post --data <rb/data> --snapshot <rb/pre-m2> --verify-m1 <rollback-m1.json> --compare <compare.json>
//                 --compare-exit <n> --server-log <m1 log> --restore <restore.json> --restore-exit <n>
//                 --mutate <mutate.json> --out <dir>
//                 (after the m1 server stopped) restore exit 0 + the aside keeps step 2's state, compare, jobs, m1 log,
//                 http_cache, lock                                                                   → rollback.json
//   inject        --snapshot <inj/snap> --data <inj/data> --modified <relPath> --before <sha256sum list> --after <list>
//                 --restore-exit <n> --restore-stdout <file> --out <dir>                            → inject.json
//
// The dev token is read from the token file, so run this with the server's XDG_RUNTIME_DIR.
// forward · mutate · verify-m1 first check the server's log (the one `listening on` line: env=dev · llm=mock · network=off
// for m2 / no network field for m1 · data = the copy; the migrations applied at start). Any difference → exit 2 before the
// first request (BRIEF_INTEGRATION I7-1 "다르면 즉시 종료").
// stdout: one JSON summary object. Exit: 0 pass · 1 a check failed · 2 usage / precondition (nothing written, no request).
// Every path argument (directories and files) is refused under the real data directory — no switch lifts it, not even
// SP_SNAPSHOT_ALLOW_REAL; files a command reads must exist.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { openSqlite, type Sqlite } from '../apps/server/src/db/client';
import { HTML_STEP_DEADLINE_MS } from '../apps/server/src/ingest/pipeline';
import { TOTAL_TIMEOUT_MS } from '../apps/server/src/ingest/safeFetch';
import { TEXT_TIMEOUT_MS } from '../apps/server/src/ingest/pdfText';
import { ARXIV_API_HEADER_TIMEOUT_MS } from '../apps/server/src/ingest/arxivApi';
import { makeTestPngBase64 } from '../apps/server/test/helpers/png';
import { compareTables } from './lib/dataDump';
import { DB_REL, refuseLinkedTree, refuseRealDataDir } from './lib/dataSnapshot';
import { LocalApi, runStreamTimeoutMs, STREAM_SLACK_MS, type SseResponse } from './lib/localApi';
import {
  diffPaperRow,
  diffShaListings,
  equationCitationStatus,
  jobStreamShape,
  M1_LOG_ALLOWED,
  parseServerLog,
  parseShaListing,
  restoreAsideChecks,
  runStreamShape,
  serverLogPrecondition,
  statsPremise,
  unexpectedLogLines,
  type ServerLogFacts,
  type ServerLogWant,
} from './lib/rehearsalChecks';
import { compareWithGold, type GoldItem, type ParserItem } from './lib/structureEval';

/** The two papers of the user's library the rehearsal expects (the fixture HTML must match these versions). */
const EXPECTED_PAPERS = [
  { arxivId: '2209.15397', version: 2, numberedEquations: 15, references: 36 },
  { arxivId: '2107.06829', version: 1, numberedEquations: 19, references: 63 },
] as const;
/** The synthetic paper added in the rollback rehearsal (offline: <id>.atom.xml + <id>v1.pdf + <id>v1.html). */
const ADDED_ARXIV_ID = '2301.00001';
/** The paper deleted in the rollback rehearsal (the other one gets the capture and the note). */
const DELETE_ARXIV_ID = '2209.15397';
/** Tables whose rows the upgrade must keep (PLAN_M2 3.1 보존 검증). */
const PRESERVED_TABLES = ['threads', 'messages', 'citations', 'highlights', 'llm_calls', 'page_texts'] as const;
/** Generic selection text for the mock explain runs (not a sentence of either paper). */
const MOCK_SELECTION = 'robust kernel';
const JSON_TIMEOUT_MS = 30_000;
/**
 * Job stream (upgrade / offline import): A exports no overall ingest limit, so the sum of the step limits it does export
 * — Atom header (60 s) + PDF body (120 s) + text extraction (120 s) + HTML step deadline (60 s) = 360 s — plus 30 s.
 * Offline jobs finish in seconds; this only has to be finite and above any real step bound.
 */
const JOB_STREAM_TIMEOUT_MS = ARXIV_API_HEADER_TIMEOUT_MS + TOTAL_TIMEOUT_MS + TEXT_TIMEOUT_MS + HTML_STEP_DEADLINE_MS + STREAM_SLACK_MS;
const GOLD_FILE = new URL('../apps/server/test/fixtures/structure-gold.json', import.meta.url);

// ---------------------------------------------------------------------------------------------------------- CLI

const COMMANDS: Record<string, string[]> = {
  precheck: ['--snapshot', '--out'],
  forward: ['--base-url', '--data', '--pre', '--structure-eval', '--server-log', '--out'],
  mutate: ['--base-url', '--data', '--server-log', '--out'],
  'verify-m1': ['--base-url', '--data', '--snapshot', '--orig', '--mutate', '--server-log', '--out'],
  'rollback-post': ['--data', '--snapshot', '--verify-m1', '--compare', '--compare-exit', '--server-log', '--restore', '--restore-exit', '--mutate', '--out'],
  inject: ['--snapshot', '--data', '--modified', '--before', '--after', '--restore-exit', '--restore-stdout', '--out'],
};
function usage(msg: string): never {
  process.stderr.write(`rehearsal: ${msg}\nusage: rehearsal.ts <${Object.keys(COMMANDS).join('|')}> …\n${Object.entries(COMMANDS)
    .map(([c, a]) => `  ${c} ${a.map((x) => `${x} <v>`).join(' ')}`)
    .join('\n')}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, exitCode: 2, error: msg })}\n`);
  process.exit(2);
}
const [command, ...rest] = process.argv.slice(2);
if (!command || !COMMANDS[command]) usage(command ? `unknown command ${command}` : 'a command is required');
const opt: Record<string, string> = {};
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i]!;
  const v = rest[i + 1];
  if (!COMMANDS[command].includes(k)) usage(`unknown argument ${k} for ${command}`);
  if (v === undefined || v.startsWith('--')) usage(`${k} needs a value`);
  if (k in opt) usage(`${k} given twice`);
  opt[k] = v;
}
for (const k of COMMANDS[command]) if (!(k in opt)) usage(`${k} is required`);
const OUT = resolve(opt['--out']!);
/** Arguments that are not paths; every other argument (directories and files, read or written) is a path. */
const NON_PATH_ARGS = ['--base-url', '--compare-exit', '--restore-exit', '--modified'];
// the real data directory is refused unconditionally: SP_SNAPSHOT_ALLOW_REAL (data:snapshot's cutover switch) never
// lifts it here — mutate deletes a paper, and a rehearsal only ever works on copies (M-M2-R2-3)
for (const [k, v] of Object.entries(opt)) {
  if (NON_PATH_ARGS.includes(k)) continue;
  try {
    refuseRealDataDir(k, v);
  } catch (e) {
    usage((e as Error).message);
  }
}
for (const k of ['--compare-exit', '--restore-exit']) if (opt[k] !== undefined && !/^\d{1,3}$/.test(opt[k]!)) usage(`${k} must be an exit code, got ${opt[k]}`);
if (opt['--modified'] !== undefined) {
  const m = opt['--modified']!;
  if (!m.startsWith('papers/') || isAbsolute(m) || m.includes('\\') || m.split('/').some((x) => x === '..' || x === '.' || x === '')) usage(`--modified must be a relative path under papers/, got ${m}`);
}
/** Files each command reads; a missing one is a precondition (exit 2) checked before anything else runs. */
const dbOf = (k: string) => join(resolve(opt[k]!), DB_REL);
const REQUIRED_FILES: Record<string, () => string[]> = {
  precheck: () => [dbOf('--snapshot')],
  forward: () => [dbOf('--pre'), dbOf('--data'), opt['--structure-eval']!, opt['--server-log']!],
  mutate: () => [dbOf('--data'), opt['--server-log']!],
  'verify-m1': () => [dbOf('--data'), dbOf('--snapshot'), opt['--mutate']!, opt['--server-log']!],
  'rollback-post': () => [dbOf('--data'), dbOf('--snapshot'), opt['--verify-m1']!, opt['--server-log']!, opt['--mutate']!],
  inject: () => [opt['--before']!, opt['--after']!, opt['--restore-stdout']!],
};
for (const p of REQUIRED_FILES[command]!()) if (!existsSync(resolve(p)) || !statSync(resolve(p)).isFile()) usage(`${resolve(p)} does not exist`);
if (command === 'verify-m1' && (!existsSync(resolve(opt['--orig']!)) || !statSync(resolve(opt['--orig']!)).isDirectory())) usage(`--orig ${resolve(opt['--orig']!)} is not a directory`);
// the link-free tree rule (결정 62) for every directory a rehearsal reads or a dev server under it writes: a working copy
// joined to another place by a link, or sharing inodes with one (`cp -al`), is refused before anything is read
for (const [k, kind] of [['--data', 'data'], ['--pre', 'snapshot'], ['--snapshot', 'snapshot'], ['--orig', 'snapshot']] as const) {
  if (opt[k] === undefined) continue;
  try {
    refuseLinkedTree(k, resolve(opt[k]!), kind);
  } catch (e) {
    usage((e as Error).message);
  }
}

/**
 * Temp DB copies (they hold the user's data): removed in withDbCopy's finally, and again on any exit — process.exit
 * (usage / finish) skips pending finally blocks, and a signal ends the process without them.
 */
const tempDirs = new Set<string>();
process.on('exit', () => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) process.on(sig, () => process.exit(code));

// ---------------------------------------------------------------------------------------------------------- helpers

interface Check {
  id: string;
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
}
const checks: Check[] = [];
function check(id: string, pass: boolean, expected?: unknown, actual?: unknown): boolean {
  checks.push({ id, pass, ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) });
  return pass;
}
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sha256File = (p: string) => sha256(readFileSync(p));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A COPY of a DB file in a 0700 temp dir, opened read-only (never the original — snapshot / read-only dirs). */
function withDbCopy<T>(dbFile: string, fn: (db: Sqlite) => T): T {
  if (!existsSync(dbFile)) throw new Error(`${dbFile} does not exist`);
  const dir = mkdtempSync(join(tmpdir(), 'sp-reh-'));
  tempDirs.add(dir);
  chmodSync(dir, 0o700);
  let db: Sqlite | undefined;
  try {
    const copy = join(dir, 'db.sqlite');
    copyFileSync(dbFile, copy);
    db = openSqlite(copy, { readonly: true });
    return fn(db);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }
}
/** The live DB of a writable working copy, read-only (a server may hold it; WAL readers do not block it). */
function withLiveDb<T>(dataDir: string, fn: (db: Sqlite) => T): T {
  const f = join(dataDir, DB_REL);
  if (!existsSync(f)) throw new Error(`${f} does not exist`);
  const db = openSqlite(f, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const all = <T>(db: Sqlite, sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
const one = <T>(db: Sqlite, sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined;
const count = (db: Sqlite, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const tableExists = (db: Sqlite, t: string) => !!one(db, `SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?`, t);
const tablesWithPaperId = (db: Sqlite) =>
  all<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .map((r) => r.name)
    .filter((t) => all<{ name: string }>(db, `SELECT name FROM pragma_table_info(?)`, t).some((c) => c.name === 'paperId'));

function finish(name: string, body: Record<string, unknown>, summary: Record<string, unknown> = {}): never {
  const pass = checks.every((c) => c.pass);
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.json`);
  const failed = checks.filter((c) => !c.pass).map((c) => c.id);
  writeFileSync(file, `${JSON.stringify({ tool: 'rehearsal', command, createdAt: new Date().toISOString(), pass, failed, ...body, checks }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ command, pass, exitCode: pass ? 0 : 1, out: file, checks: checks.length, failed, ...summary })}\n`);
  process.exit(pass ? 0 : 1);
}

async function openApi(): Promise<LocalApi> {
  return LocalApi.open({ baseUrl: opt['--base-url']!, token: 'dev', timeoutMs: JSON_TIMEOUT_MS });
}
/** GET jobs.events (whole body) and its shape. */
async function jobStream(api: LocalApi, jobId: string): Promise<{ status: number; events: string[]; shape: ReturnType<typeof jobStreamShape>; steps: string[]; error: string | null }> {
  const r: SseResponse = await api.sse('GET', `/api/jobs/${encodeURIComponent(jobId)}/events`, { timeoutMs: JOB_STREAM_TIMEOUT_MS });
  const names = r.events.map((e) => e.event);
  const steps = r.events.flatMap((e) => (e.event === 'job.step' ? [`${e.data.step}:${e.data.status}`] : e.event === 'job.state' ? [`state:${e.data.state}`] : []));
  const err = r.events.find((e) => e.event === 'job.error');
  return { status: r.status, events: names, shape: jobStreamShape(names), steps, error: err && err.event === 'job.error' ? err.data.code : null };
}
/**
 * The server log as a precondition, before any request: a missing log or any difference from `want` → usage (exit 2,
 * nothing sent, no result file). On success it is recorded as a passed check.
 */
function requireServerLog(want: ServerLogWant): ServerLogFacts {
  const file = resolve(opt['--server-log']!);
  if (!existsSync(file)) usage(`--server-log ${file} does not exist`);
  const facts = parseServerLog(readFileSync(file, 'utf8'));
  const violations = serverLogPrecondition(facts, want);
  if (violations.length) usage(`server log precondition failed — no request sent: ${violations.join('; ')}`);
  check('server log precondition (one listening line: env · llm · network · data; migrations applied at start)', true, want, { env: facts.env, llm: facts.llm, network: facts.network, data: facts.data, migrations: facts.migrations, backupLines: facts.backupLines });
  return facts;
}

// ---------------------------------------------------------------------------------------------------------- precheck

function precheck(): never {
  const snap = resolve(opt['--snapshot']!);
  const body = withDbCopy(join(snap, DB_REL), (db) => {
    const papers = all<{ id: string; arxivId: string | null; arxivVersion: number | null; supplementVersion: number | null; structureSource: string | null; source: string; structureReadyAt: number | null; deletingAt: number | null; ingestWarningsJson: string }>(
      db,
      `SELECT id, arxivId, arxivVersion, supplementVersion, structureSource, source, structureReadyAt, deletingAt, ingestWarningsJson FROM papers ORDER BY arxivId`,
    );
    const pairs = papers.map((p) => `${p.arxivId}v${p.arxivVersion}`).sort();
    const want = EXPECTED_PAPERS.map((p) => `${p.arxivId}v${p.version}`).sort();
    check('papers = the two fixture versions', JSON.stringify(pairs) === JSON.stringify(want), want, pairs);
    for (const p of papers) {
      check(`${p.arxivId}: supplementVersion 1`, p.supplementVersion === 1, 1, p.supplementVersion);
      check(`${p.arxivId}: structureSource 'none'`, p.structureSource === 'none', 'none', p.structureSource);
      check(`${p.arxivId}: upgrade target (arxiv, structureReadyAt set, not deleting)`, p.source === 'arxiv' && p.structureReadyAt !== null && p.deletingAt === null);
    }
    const equations = tableExists(db, 'equations') ? count(db, `SELECT count(*) AS n FROM equations`) : 0;
    check('equations 0 rows', equations === 0, 0, equations);
    const stats = statsPremise(all<{ id: string; statsJson: string | null }>(db, `SELECT id, statsJson FROM messages ORDER BY id`));
    check('every statsJson eqRefs.resolved + noAnchor = 0 (PLAN_M2 3.4 rule 2 premise)', stats.holds, 0, stats.resolvedPlusNoAnchor);
    const eqStatus = equationCitationStatus(all<{ status: string; ownerType: string; ownerId: string }>(db, `SELECT status, ownerType, ownerId FROM citations WHERE kind = 'equation' ORDER BY id`));
    const tables = Object.fromEntries(
      all<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => [r.name, count(db, `SELECT count(*) AS n FROM "${r.name}"`)]),
    );
    const quoteStatus = Object.fromEntries(all<{ status: string; n: number }>(db, `SELECT status, count(*) AS n FROM citations WHERE kind = 'quote' GROUP BY status ORDER BY status`).map((r) => [r.status, r.n]));
    return {
      snapshot: snap,
      dbCopy: 'opened a temp copy of the snapshot DB (read-only)',
      papers: papers.map((p) => ({ id: p.id, arxivId: p.arxivId, arxivVersion: p.arxivVersion, supplementVersion: p.supplementVersion, structureSource: p.structureSource, warnings: JSON.parse(p.ingestWarningsJson) as unknown })),
      tables,
      statsPremise: stats,
      equationCitationStatus: eqStatus,
      quoteCitationStatus: quoteStatus,
    };
  });
  finish('precheck', body, { equationCitationStatus: body.equationCitationStatus.byStatus, notFound: body.equationCitationStatus.notFound.count, statsPremiseHolds: body.statsPremise.holds });
}

// ---------------------------------------------------------------------------------------------------------- forward

interface PaperGet {
  status: number;
  supplementVersion?: number | null;
  structureSource?: string | null;
  structureUpgrade?: { available: boolean; reason: string | null; job: { id: string; status: string } | null };
  lastJob?: { id: string; kind: string; status: string } | null;
  state?: { readable: boolean; contextReady: boolean; structureReady: boolean };
  structureReadyAt?: number | null;
  ingestStatus?: string;
}
async function paperGet(api: LocalApi, id: string): Promise<PaperGet> {
  const r = await api.get(`/api/papers/${encodeURIComponent(id)}`, { timeoutMs: JSON_TIMEOUT_MS });
  if (r.status !== 200) return { status: r.status };
  const d = r.json<Required<PaperGet> & { lastJob: { id: string; kind: string; status: string } | null }>();
  return {
    status: 200,
    supplementVersion: d.supplementVersion,
    structureSource: d.structureSource,
    structureUpgrade: { available: d.structureUpgrade.available, reason: d.structureUpgrade.reason, job: d.structureUpgrade.job ? { id: d.structureUpgrade.job.id, status: d.structureUpgrade.job.status } : null },
    lastJob: d.lastJob ? { id: d.lastJob.id, kind: d.lastJob.kind, status: d.lastJob.status } : null,
    state: d.state,
    structureReadyAt: d.structureReadyAt,
    ingestStatus: d.ingestStatus,
  };
}

async function forward(): Promise<never> {
  const data = resolve(opt['--data']!);
  const pre = resolve(opt['--pre']!);
  const log = requireServerLog({ env: 'dev', llm: 'mock', network: 'off', data, migrations: ['0002_m2', '0003_api', '0004_study_path'], backup: true });
  const i5 = JSON.parse(readFileSync(resolve(opt['--structure-eval']!), 'utf8')) as { papers: { paper: string; sections: Record<string, number>; equations: Record<string, number> }[] };
  const gold = JSON.parse(readFileSync(GOLD_FILE, 'utf8')) as Record<string, { sections: GoldItem[]; equations: GoldItem[] }>;

  const prePapers = withDbCopy(join(pre, DB_REL), (db) => all<Record<string, unknown> & { id: string; arxivId: string; arxivVersion: number }>(db, `SELECT * FROM papers ORDER BY arxivId`));
  const api = await openApi();
  const perPaper: Record<string, unknown>[] = [];
  try {
    // 1. before: papers.get
    const before = new Map<string, PaperGet>();
    for (const p of prePapers) {
      const g = await paperGet(api, p.id);
      before.set(p.id, g);
      check(`${p.arxivId}: papers.get before 200 · upgrade available`, g.status === 200 && g.structureUpgrade?.available === true, true, g.structureUpgrade);
    }
    // 2. upgrade, one paper after the other, each to its terminal
    const jobs = new Map<string, Awaited<ReturnType<typeof jobStream>> & { jobId: string | null; startStatus: number }>();
    for (const p of prePapers) {
      const r = await api.post(`/api/papers/${encodeURIComponent(p.id)}/upgrade-structure`, { timeoutMs: JSON_TIMEOUT_MS });
      const jobId = r.status === 200 ? r.json<{ jobId: string }>().jobId : null;
      check(`${p.arxivId}: upgradeStructure 200 + jobId`, jobId !== null, 200, r.status);
      if (!jobId) continue;
      const s = await jobStream(api, jobId);
      jobs.set(p.id, { ...s, jobId, startStatus: r.status });
      check(`${p.arxivId}: upgrade job stream ends with job.done (one terminal, last)`, s.status === 200 && s.shape.ok && s.shape.terminal === 'job.done', 'job.done', s.shape.terminal ?? s.error);
    }
    // 3. comparisons before any new run
    const tableDiffs = withDbCopy(join(pre, DB_REL), (preDb) => withLiveDb(data, (live) => compareTables(preDb, live, PRESERVED_TABLES)));
    for (const t of tableDiffs) check(`dump ${t.table}: equal to fwd/pre (pre columns, pk order)`, t.equal, { count: t.count.a, sha256: t.sha256.a }, { count: t.count.b, sha256: t.sha256.b, onlyInPre: t.onlyInA, onlyInLive: t.onlyInB, changed: t.changed });
    const newColumnDefaults = withLiveDb(data, (live) => ({
      citationsEquationIdOrDetailSet: count(live, `SELECT count(*) AS n FROM citations WHERE equationId IS NOT NULL OR detail IS NOT NULL`),
      messagesPendingReplaceNonZero: count(live, `SELECT count(*) AS n FROM messages WHERE pendingReplace <> 0`),
      llmCallsParentRunIdOrResultRawSet: count(live, `SELECT count(*) AS n FROM llm_calls WHERE parentRunId IS NOT NULL OR resultRaw IS NOT NULL`),
    }));
    for (const [k, v] of Object.entries(newColumnDefaults)) check(`0002 column default: ${k} = 0`, v === 0, 0, v);

    for (const p of prePapers) {
      const out: Record<string, unknown> = { id: p.id, arxivId: p.arxivId, arxivVersion: p.arxivVersion };
      const exp = EXPECTED_PAPERS.find((e) => e.arxivId === p.arxivId)!;
      // papers row (D4)
      const after = withLiveDb(data, (live) => one<Record<string, unknown>>(live, `SELECT * FROM papers WHERE id = ?`, p.id));
      const diff = after ? diffPaperRow(p, after) : { ok: false, changed: [], violations: ['row missing'] };
      check(`${p.arxivId}: papers row changed only in D4 columns`, diff.ok, [], diff.violations);
      out.papersRow = { changedColumns: diff.changed, violations: diff.violations, codeUrlBefore: p.codeUrl === null ? null : 'set', codeUrlAfter: after?.codeUrl === null || after?.codeUrl === undefined ? null : 'set' };
      for (const col of ['ingestStatus', 'readableAt', 'contextReadyAt', 'structureReadyAt']) check(`${p.arxivId}: papers.${col} unchanged`, after !== undefined && JSON.stringify(after[col]) === JSON.stringify(p[col]));
      // files
      const preFiles = withDbCopy(join(pre, DB_REL), (db) => all<{ id: string; kind: string; relPath: string; sha256: string; bytes: number }>(db, `SELECT id, kind, relPath, sha256, bytes FROM files WHERE paperId = ? ORDER BY id`, p.id));
      const liveFiles = withLiveDb(data, (live) => all<{ id: string; kind: string; relPath: string; sha256: string; bytes: number }>(live, `SELECT id, kind, relPath, sha256, bytes FROM files WHERE paperId = ? ORDER BY id`, p.id));
      for (const f of preFiles) {
        const l = liveFiles.find((x) => x.id === f.id);
        const disk = existsSync(join(data, f.relPath)) ? sha256File(join(data, f.relPath)) : null;
        check(`${p.arxivId}: ${basename(f.relPath)} row and bytes unchanged`, !!l && l.sha256 === f.sha256 && l.bytes === f.bytes && l.relPath === f.relPath && disk === f.sha256, f.sha256, disk);
      }
      const fileOk = liveFiles.map((f) => {
        const abs = join(data, f.relPath);
        const ok = f.relPath.startsWith(`papers/${p.id}/`) && existsSync(abs) && statSync(abs).size === f.bytes && sha256File(abs) === f.sha256;
        return { id: f.id, kind: f.kind, name: basename(f.relPath), ok };
      });
      check(`${p.arxivId}: every files row matches its file (exists, bytes, sha256)`, fileOk.every((f) => f.ok), true, fileOk.filter((f) => !f.ok));
      const names = liveFiles.map((f) => basename(f.relPath));
      check(`${p.arxivId}: source.html and supplement.v2.txt published with files rows`, names.includes('source.html') && names.includes('supplement.v2.txt') && existsSync(join(data, 'papers', p.id, 'source.html')) && existsSync(join(data, 'papers', p.id, 'supplement.v2.txt')), ['source.html', 'supplement.v2.txt'], names);
      out.files = liveFiles.map((f) => ({ id: f.id, kind: f.kind, name: basename(f.relPath), bytes: f.bytes, sha256: f.sha256 }));
      // papers.get after
      const g = await paperGet(api, p.id);
      const b = before.get(p.id)!;
      check(`${p.arxivId}: papers.get supplementVersion 2 · structureSource latexml · upgrade not available`, g.status === 200 && g.supplementVersion === 2 && g.structureSource === 'latexml' && g.structureUpgrade?.available === false, { v: 2, s: 'latexml', available: false }, { v: g.supplementVersion, s: g.structureSource, available: g.structureUpgrade?.available });
      check(`${p.arxivId}: papers.get lastJob (id, kind, status) same as before the upgrade`, JSON.stringify(g.lastJob ?? null) === JSON.stringify(b.lastJob ?? null), b.lastJob ?? null, g.lastJob ?? null);
      const job = jobs.get(p.id);
      check(`${p.arxivId}: the upgrade job is not lastJob`, !!job && g.lastJob?.id !== job.jobId);
      out.papersGet = { before: { supplementVersion: b.supplementVersion, structureSource: b.structureSource, structureUpgrade: b.structureUpgrade, lastJob: b.lastJob }, after: { supplementVersion: g.supplementVersion, structureSource: g.structureSource, structureUpgrade: g.structureUpgrade, lastJob: g.lastJob } };
      out.upgradeJob = job ? { jobId: job.jobId, events: job.events, steps: job.steps, terminal: job.shape.terminal } : null;
      // structure vs gold
      const key = `${p.arxivId}v${p.arxivVersion}`;
      const st = withLiveDb(data, (live) => ({
        sections: all<{ htmlId: string | null; number: string | null; pdfPage: number | null; pdfOffset: number | null }>(live, `SELECT htmlId, number, pdfPage, pdfOffset FROM sections WHERE paperId = ? ORDER BY ordinal`, p.id),
        equations: all<{ htmlId: string | null; number: string | null; pdfPage: number | null; pdfOffset: number | null; katexOk: number }>(live, `SELECT htmlId, number, pdfPage, pdfOffset, katexOk FROM equations WHERE paperId = ? ORDER BY ordinal`, p.id),
        references: count(live, `SELECT count(*) AS n FROM paper_references WHERE paperId = ?`, p.id),
        figures: count(live, `SELECT count(*) AS n FROM figures WHERE paperId = ?`, p.id),
      }));
      const toItem = (r: { htmlId: string | null; number: string | null; pdfPage: number | null; pdfOffset: number | null }): ParserItem => ({ htmlId: r.htmlId, number: r.number, pos: r.pdfPage !== null && r.pdfOffset !== null ? { page: r.pdfPage, start: r.pdfOffset } : null });
      const numbered = st.equations.filter((e) => e.number !== null);
      const g0 = gold[key];
      const i5p = i5.papers.find((x) => x.paper === key);
      if (!g0 || !i5p) {
        check(`${p.arxivId}: gold and I5 result present`, false, key, null);
      } else {
        const sec = compareWithGold('sections', g0.sections, st.sections.map(toItem));
        const eq = compareWithGold('equations', g0.equations, numbered.map(toItem));
        const pick = (c: { matched: number; null: number; mismatched: number; extra: number; missing: number; orderViolations: number }) => ({ matched: c.matched, null: c.null, mismatched: c.mismatched, extra: c.extra, missing: c.missing, orderViolations: c.orderViolations });
        const i5pick = (c: Record<string, number>) => ({ matched: c.matched, null: c.null, mismatched: c.mismatched, extra: c.extra, missing: c.missing, orderViolations: c.orderViolations });
        check(`${p.arxivId}: sections vs gold = I5 result`, JSON.stringify(pick(sec)) === JSON.stringify(i5pick(i5p.sections)), i5pick(i5p.sections), pick(sec));
        check(`${p.arxivId}: equations vs gold = I5 result`, JSON.stringify(pick(eq)) === JSON.stringify(i5pick(i5p.equations)), i5pick(i5p.equations), pick(eq));
        check(`${p.arxivId}: mismatched 0`, sec.mismatched + eq.mismatched === 0, 0, sec.mismatched + eq.mismatched);
        out.structure = { gold: key, sections: { rows: st.sections.length, ...pick(sec), gold: sec.gold }, equations: { rows: st.equations.length, numbered: numbered.length, katexOkNumbered: numbered.filter((e) => e.katexOk === 1).length, ...pick(eq), gold: eq.gold }, references: st.references, figures: st.figures };
      }
      check(`${p.arxivId}: numbered equations ${exp.numberedEquations}`, numbered.length === exp.numberedEquations, exp.numberedEquations, numbered.length);
      check(`${p.arxivId}: references ${exp.references}`, st.references === exp.references, exp.references, st.references);
      perPaper.push(out);
    }

    // 4. one mock explain per paper → a new prefixFingerprint
    for (const p of prePapers) {
      const out = perPaper.find((x) => x.id === p.id)!;
      const preFps = withDbCopy(join(pre, DB_REL), (db) => all<{ runId: string; fp: string | null }>(db, `SELECT runId, prefixFingerprint AS fp FROM llm_calls WHERE paperId = ?`, p.id));
      const r = await api.sse('POST', `/api/papers/${encodeURIComponent(p.id)}/threads`, { timeoutMs: runStreamTimeoutMs('explain_selection'), json: { kind: 'explain', text: MOCK_SELECTION, clientRequestId: randomUUID() } });
      const names = r.events.map((e) => e.event);
      const shape = runStreamShape(names);
      check(`${p.arxivId}: mock explain ends with run.done`, r.status === 200 && shape.ok && shape.terminal === 'run.done', 'run.done', shape.terminal ?? r.status);
      const preRunIds = new Set(preFps.map((x) => x.runId));
      const newRows = withLiveDb(data, (live) => all<{ runId: string; fp: string | null; status: string }>(live, `SELECT runId, prefixFingerprint AS fp, status FROM llm_calls WHERE paperId = ?`, p.id)).filter((x) => !preRunIds.has(x.runId));
      const preSet = new Set(preFps.map((x) => x.fp).filter((x): x is string => x !== null));
      const fresh = newRows.length === 1 && newRows[0]!.fp !== null && !preSet.has(newRows[0]!.fp);
      check(`${p.arxivId}: new llm_calls.prefixFingerprint differs from every earlier one of the paper`, fresh, { newRuns: 1, earlierDistinct: preSet.size }, { newRuns: newRows.length, newFp: newRows[0]?.fp ? `${newRows[0].fp.slice(0, 12)}…` : null });
      out.mockExplain = { events: names, newRunIds: newRows.map((x) => x.runId), earlierFingerprints: preSet.size, earlierRuns: preFps.length, newFingerprintIsNew: fresh };
    }
  } finally {
    await api.dispose();
  }
  const calls = api.calls.map((c) => `${c.method} ${c.path} ${c.status}`);
  finish('forward', { data, pre, serverLog: log, papers: perPaper, calls, jobStreamTimeoutMs: JOB_STREAM_TIMEOUT_MS }, { papers: perPaper.map((p) => ({ arxivId: p.arxivId, structure: p.structure })) });
}

// ---------------------------------------------------------------------------------------------------------- mutate

async function mutate(): Promise<never> {
  const data = resolve(opt['--data']!);
  const log = requireServerLog({ env: 'dev', llm: 'mock', network: 'off', data, migrations: ['0002_m2', '0003_api', '0004_study_path'], backup: true });
  const papers = withLiveDb(data, (db) => all<{ id: string; arxivId: string }>(db, `SELECT id, arxivId FROM papers ORDER BY arxivId`));
  const del = papers.find((p) => p.arxivId === DELETE_ARXIV_ID);
  const keep = papers.find((p) => p.arxivId !== DELETE_ARXIV_ID);
  if (!del || !keep || papers.length !== 2) usage(`expected the two papers in ${data}, found ${papers.length}`);
  const api = await openApi();
  const out: Record<string, unknown> = { data, deletedPaperId: del.id, keptPaperId: keep.id };
  try {
    // delete one existing paper
    const d = await api.delete(`/api/papers/${encodeURIComponent(del.id)}`, { timeoutMs: JSON_TIMEOUT_MS });
    check('papers.delete 204', d.status === 204, 204, d.status);
    const dir = join(data, 'papers', del.id);
    for (let i = 0; i < 100 && existsSync(dir); i++) await delay(100);
    check('deleted paper directory gone', !existsSync(dir));
    check('deleted paper: papers.get 404', (await api.get(`/api/papers/${encodeURIComponent(del.id)}`, { timeoutMs: JSON_TIMEOUT_MS })).status === 404);
    // add one paper (offline)
    const imp = await api.post('/api/papers/import', { timeoutMs: JSON_TIMEOUT_MS, json: { input: ADDED_ARXIV_ID, clientRequestId: randomUUID() } });
    const ij = imp.status === 200 ? imp.json<{ paperId: string; jobId: string | null; existing: boolean }>() : null;
    check('papers.import 200, new paper with a job', !!ij && ij.jobId !== null && ij.existing === false, 200, imp.status);
    if (ij?.jobId) {
      const s = await jobStream(api, ij.jobId);
      check('import job ends with job.done', s.shape.ok && s.shape.terminal === 'job.done', 'job.done', s.shape.terminal ?? s.error);
      const g = await paperGet(api, ij.paperId);
      check('added paper structure_ready (structureReadyAt set, latexml, supplement v2)', g.status === 200 && g.structureReadyAt != null && g.state?.structureReady === true && g.structureSource === 'latexml' && g.supplementVersion === 2, { structureReady: true, structureSource: 'latexml', supplementVersion: 2 }, { structureReady: g.state?.structureReady, structureSource: g.structureSource, supplementVersion: g.supplementVersion });
      out.addedPaperId = ij.paperId;
      out.addedJobId = ij.jobId;
      out.addedJobSteps = s.steps;
    }
    // one capture: area highlight + PNG on the kept paper
    const png = makeTestPngBase64({ width: 48, height: 32 });
    const h = await api.post(`/api/papers/${encodeURIComponent(keep.id)}/highlights`, { timeoutMs: JSON_TIMEOUT_MS, json: { kind: 'area', color: 2, page: 1, rects: [{ page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.2 }], imagePng: png } });
    const hj = h.status === 200 ? h.json<{ id: string; imageFileId: string | null }>() : null;
    check('area highlight with PNG created (imageFileId set)', !!hj && hj.imageFileId !== null, 200, h.status);
    if (hj?.imageFileId) {
      const cap = join(data, 'papers', keep.id, 'captures', `${hj.imageFileId}.png`);
      const ok = existsSync(cap) && sha256File(cap) === sha256(Buffer.from(png, 'base64'));
      check('capture file on disk = request PNG bytes', ok);
      out.highlightId = hj.id;
      out.captureFileId = hj.imageFileId;
      out.capturePngSha256 = sha256(Buffer.from(png, 'base64'));
    }
    // one note
    const n = await api.post(`/api/papers/${encodeURIComponent(keep.id)}/notes`, { timeoutMs: JSON_TIMEOUT_MS, json: { bodyMd: 'rehearsal note (synthetic)' } });
    const nj = n.status === 200 ? n.json<{ id: string }>() : null;
    check('note created', !!nj, 200, n.status);
    out.noteId = nj?.id ?? null;
  } finally {
    await api.dispose();
  }
  out.counts = withLiveDb(data, (db) => ({
    papers: count(db, `SELECT count(*) AS n FROM papers`),
    captureFiles: count(db, `SELECT count(*) AS n FROM files WHERE kind = 'capture'`),
    notes: count(db, `SELECT count(*) AS n FROM notes`),
    highlights: count(db, `SELECT count(*) AS n FROM highlights`),
  }));
  out.calls = api.calls.map((c) => `${c.method} ${c.path} ${c.status}`);
  out.serverLog = log;
  finish('mutate', out, { ids: { deleted: out.deletedPaperId, added: out.addedPaperId, highlight: out.highlightId, capture: out.captureFileId, note: out.noteId } });
}

// ---------------------------------------------------------------------------------------------------------- verify-m1

async function verifyM1(): Promise<never> {
  const data = resolve(opt['--data']!);
  const snap = resolve(opt['--snapshot']!);
  const orig = resolve(opt['--orig']!);
  // the m1 server: no network field, no migration at start (the restored DB is M1-shaped)
  const log = requireServerLog({ env: 'dev', llm: 'mock', network: null, data, migrations: [], backup: false });
  const m = JSON.parse(readFileSync(resolve(opt['--mutate']!), 'utf8')) as { addedPaperId?: string; highlightId?: string; captureFileId?: string; noteId?: string; deletedPaperId: string };
  const snapPapers = withDbCopy(join(snap, DB_REL), (db) => ({
    papers: all<{ id: string; arxivId: string }>(db, `SELECT id, arxivId FROM papers ORDER BY arxivId`),
    pdfs: all<{ paperId: string; relPath: string; sha256: string }>(db, `SELECT paperId, relPath, sha256 FROM files WHERE kind = 'pdf' ORDER BY paperId`),
  }));
  // m1 has no network guard: this client sends GET only (recorded in api.calls)
  const api = await openApi();
  const perPaper: Record<string, unknown>[] = [];
  try {
    for (const p of snapPapers.papers) {
      const g = await api.get(`/api/papers/${encodeURIComponent(p.id)}`, { timeoutMs: JSON_TIMEOUT_MS });
      check(`${p.arxivId}: m1 papers.get 200${p.id === m.deletedPaperId ? ' (the paper deleted under m2)' : ''}`, g.status === 200, 200, g.status);
      const pdfRow = snapPapers.pdfs.find((f) => f.paperId === p.id);
      const pdf = await api.get(`/api/papers/${encodeURIComponent(p.id)}/pdf`, { timeoutMs: JSON_TIMEOUT_MS });
      const got = pdf.status === 200 ? sha256(pdf.body) : null;
      const origSha = pdfRow && existsSync(join(orig, pdfRow.relPath)) ? sha256File(join(orig, pdfRow.relPath)) : null;
      const liveRow = withLiveDb(data, (db) => one<{ sha256: string }>(db, `SELECT sha256 FROM files WHERE paperId = ? AND kind = 'pdf'`, p.id));
      check(`${p.arxivId}: PDF bytes sha256 = files.sha256 = orig`, !!pdfRow && got === pdfRow.sha256 && liveRow?.sha256 === pdfRow.sha256 && origSha === pdfRow.sha256, pdfRow?.sha256, { served: got, filesRow: liveRow?.sha256 ?? null, orig: origSha });
      perPaper.push({ id: p.id, arxivId: p.arxivId, papersGet: g.status, pdfStatus: pdf.status, pdfSha256: got, pdfBytes: pdf.body.length });
    }
  } finally {
    await api.dispose();
  }
  const absent = withLiveDb(data, (db) => {
    const added = m.addedPaperId ?? null;
    const rowsOfAdded = added ? Object.fromEntries(tablesWithPaperId(db).map((t) => [t, count(db, `SELECT count(*) AS n FROM "${t}" WHERE paperId = ?`, added)])) : {};
    return {
      papers: count(db, `SELECT count(*) AS n FROM papers`),
      paperIds: all<{ id: string }>(db, `SELECT id FROM papers ORDER BY id`).map((r) => r.id),
      addedPaperRow: added ? count(db, `SELECT count(*) AS n FROM papers WHERE id = ?`, added) : null,
      rowsOfAddedPaper: rowsOfAdded,
      captureFiles: count(db, `SELECT count(*) AS n FROM files WHERE kind = 'capture'`),
      notes: tableExists(db, 'notes') ? count(db, `SELECT count(*) AS n FROM notes`) : 0,
      mutateHighlight: m.highlightId ? count(db, `SELECT count(*) AS n FROM highlights WHERE id = ?`, m.highlightId) : null,
      addedPaperDir: added ? existsSync(join(data, 'papers', added)) : null,
      deletedPaperDirBack: existsSync(join(data, 'papers', m.deletedPaperId)),
    };
  });
  check('papers 2 rows = the snapshot papers', absent.papers === 2 && JSON.stringify(absent.paperIds) === JSON.stringify(snapPapers.papers.map((p) => p.id).sort()), 2, absent.papers);
  check('added paper: 0 rows in every table with paperId, no papers row, no directory', absent.addedPaperRow === 0 && Object.values(absent.rowsOfAddedPaper).every((n) => n === 0) && absent.addedPaperDir === false, 0, absent.rowsOfAddedPaper);
  check("files(kind='capture') 0", absent.captureFiles === 0, 0, absent.captureFiles);
  check('notes 0 rows', absent.notes === 0, 0, absent.notes);
  check('the mutate highlight is gone', absent.mutateHighlight === 0, 0, absent.mutateHighlight);
  check('the deleted paper directory is back', absent.deletedPaperDirBack);
  const nonGet = api.calls.filter((c) => c.method !== 'GET');
  check('every request to the m1 server was a GET', nonGet.length === 0, 0, nonGet.length);
  finish('rollback-m1', { data, snapshot: snap, serverLog: log, papers: perPaper, absent, requests: api.calls.map((c) => ({ method: c.method, path: c.path, status: c.status })) }, { requests: api.calls.length, nonGet: nonGet.length });
}

// ---------------------------------------------------------------------------------------------------------- rollback-post

function rollbackPost(): never {
  const data = resolve(opt['--data']!);
  const snap = resolve(opt['--snapshot']!);
  const v = JSON.parse(readFileSync(resolve(opt['--verify-m1']!), 'utf8')) as { pass: boolean; checks: Check[]; requests: { method: string }[] };
  check('verify-m1 passed', v.pass === true);
  // I7-3 3: restore exit 0 and the aside keeps the M2 state of step 2
  let restoreJson: Record<string, unknown> | null = null;
  try {
    restoreJson = JSON.parse(readFileSync(resolve(opt['--restore']!), 'utf8')) as Record<string, unknown>;
  } catch {
    restoreJson = null;
  }
  const mutateJson = JSON.parse(readFileSync(resolve(opt['--mutate']!), 'utf8')) as Record<string, unknown>;
  const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
  const asideChecks = restoreAsideChecks({
    restoreExit: Number(opt['--restore-exit']),
    restore: restoreJson,
    data,
    snapshot: snap,
    mutate: mutateJson,
    siblings: readdirSync(dirname(data)),
    fs: { isDir, isFile: (p) => existsSync(p) && statSync(p).isFile(), sha256: (p) => (existsSync(p) ? sha256File(p) : null) },
  });
  for (const a of asideChecks) check(a.id, a.pass, a.expected, a.actual);
  check('verify-m1: requests all GET', v.requests.every((r) => r.method === 'GET'), 'GET', [...new Set(v.requests.map((r) => r.method))]);
  const cmpExit = Number(opt['--compare-exit']);
  const cmp = existsSync(resolve(opt['--compare']!)) ? (JSON.parse(readFileSync(resolve(opt['--compare']!), 'utf8')) as { ok: boolean; tables: { table: string; equal: boolean; count: { a: number; b: number }; sha256: { a: string; b: string } }[]; pdf: { papers: number; ok: number } }) : null;
  check('data-snapshot compare exit 0', cmpExit === 0, 0, cmpExit);
  check('compare: threads · messages · citations · highlights dumps equal to rb/pre-m2, PDFs = files.sha256', !!cmp && cmp.ok && cmp.tables.every((t) => t.equal) && cmp.pdf.ok === cmp.pdf.papers, true, cmp ? { tables: cmp.tables.map((t) => [t.table, t.equal]), pdf: cmp.pdf } : null);
  const jobsSnap = withDbCopy(join(snap, DB_REL), (db) => ({ n: count(db, `SELECT count(*) AS n FROM jobs`), ids: all<{ id: string }>(db, `SELECT id FROM jobs ORDER BY id`).map((r) => r.id), latest: one<{ id: string }>(db, `SELECT id FROM jobs ORDER BY createdAt DESC, id DESC LIMIT 1`)?.id ?? null }));
  const jobsLive = withLiveDb(data, (db) => ({ n: count(db, `SELECT count(*) AS n FROM jobs`), ids: all<{ id: string }>(db, `SELECT id FROM jobs ORDER BY id`).map((r) => r.id), latest: one<{ id: string }>(db, `SELECT id FROM jobs ORDER BY createdAt DESC, id DESC LIMIT 1`)?.id ?? null }));
  check('jobs rows and the latest job id = rb/pre-m2 (no collect job while m1 ran)', jobsSnap.n === jobsLive.n && jobsSnap.latest === jobsLive.latest && JSON.stringify(jobsSnap.ids) === JSON.stringify(jobsLive.ids), { n: jobsSnap.n, latest: jobsSnap.latest }, { n: jobsLive.n, latest: jobsLive.latest });
  // m1 log after the server stopped: judged by an allow-list (the listening line + the signal shutdown line, nothing else)
  const logText = readFileSync(resolve(opt['--server-log']!), 'utf8');
  const log = parseServerLog(logText);
  const unexpected = unexpectedLogLines(logText, M1_LOG_ALLOWED);
  check('m1 log: one listening line, env=dev · llm=mock · no network field · data = rb copy', log.listeningLines === 1 && log.env === 'dev' && log.llm === 'mock' && log.network === null && log.data === data, { env: 'dev', llm: 'mock', network: null, data }, { listeningLines: log.listeningLines, env: log.env, llm: log.llm, network: log.network, data: log.data });
  check('m1 log: no migration applied (the restored DB is M1-shaped)', log.migrations.length === 0, [], log.migrations);
  check('m1 log: only allowed lines (listening + signal shutdown) — no recovery, migration, error, drain, [ingest], [server], [llm] line', unexpected.count === 0, 0, unexpected);
  check('m1 log: no error-like line (/error|fail|exception|recovery/i)', log.errorLikeLines === 0, 0, log.errorLikeLines);
  check("m1 log: no '[ingest]' line — m1 logs nothing for a normal job; 0 = no job terminal-write failure (m1 ingest/pipeline.ts console.error ×2)", log.ingestLines === 0, 0, log.ingestLines);
  // indirect evidence that m1 fetched nothing: http_cache (arXiv responses) unchanged
  const cacheRows = (db: Sqlite) => {
    const rows = all<Record<string, unknown>>(db, `SELECT key, url, status, body, fetchedAt, expiresAt FROM http_cache ORDER BY key`);
    return { n: rows.length, keys: rows.map((r) => String(r.key)), sha256: sha256(JSON.stringify(rows)) };
  };
  const cacheSnap = withDbCopy(join(snap, DB_REL), cacheRows);
  const cacheLive = withLiveDb(data, cacheRows);
  check('http_cache rows (count · keys · row sha256) = rb/pre-m2 (no fetch while m1 ran)', cacheSnap.n === cacheLive.n && JSON.stringify(cacheSnap.keys) === JSON.stringify(cacheLive.keys) && cacheSnap.sha256 === cacheLive.sha256, { n: cacheSnap.n, sha256: cacheSnap.sha256 }, { n: cacheLive.n, sha256: cacheLive.sha256 });
  const lockGone = !existsSync(join(data, 'run', 'instance.lock'));
  check('no instance.lock after the m1 server stopped', lockGone);
  const vm1 = JSON.parse(readFileSync(resolve(opt['--verify-m1']!), 'utf8')) as Record<string, unknown>;
  finish('rollback', { data, snapshot: snap, restore: { exit: Number(opt['--restore-exit']), ok: restoreJson?.ok ?? null, aside: restoreJson?.aside ?? null, checks: asideChecks.map((a) => [a.id, a.pass]) }, verifyM1: vm1, compare: cmp ? { ok: cmp.ok, tables: cmp.tables.map((t) => ({ table: t.table, equal: t.equal, count: t.count, sha256: t.sha256 })), pdf: cmp.pdf } : null, compareExit: cmpExit, jobs: { snapshot: { n: jobsSnap.n, latest: jobsSnap.latest }, live: { n: jobsLive.n, latest: jobsLive.latest } }, m1Log: { ...log, unexpected, ingestGrep: '[ingest]', ingestNote: 'm1 logs [ingest] only when a job terminal write fails (pipeline.ts:412·430); a normal job logs nothing' }, httpCache: { snapshot: { n: cacheSnap.n, sha256: cacheSnap.sha256 }, live: { n: cacheLive.n, sha256: cacheLive.sha256 } } }, { compareOk: cmp?.ok ?? null });
}

// ---------------------------------------------------------------------------------------------------------- inject

function inject(): never {
  const data = resolve(opt['--data']!);
  const before = parseShaListing(readFileSync(resolve(opt['--before']!), 'utf8'));
  const after = parseShaListing(readFileSync(resolve(opt['--after']!), 'utf8'));
  const d = diffShaListings(before, after);
  const exit = Number(opt['--restore-exit']);
  let restoreOut: Record<string, unknown> | null = null;
  try {
    restoreOut = JSON.parse(readFileSync(resolve(opt['--restore-stdout']!), 'utf8').trim().split('\n').pop() ?? 'null') as Record<string, unknown>;
  } catch {
    restoreOut = null;
  }
  check('restore exit 1', exit === 1, 1, exit);
  check('inj/data file list and sha256 unchanged', d.equal && before.size > 0, true, { files: before.size, onlyBefore: d.onlyBefore.length, onlyAfter: d.onlyAfter.length, changed: d.changed.length });
  const siblings = readdirSync(dirname(data));
  const staging = siblings.filter((n) => n.startsWith(`${basename(data)}.restore-`));
  const aside = siblings.filter((n) => n.startsWith(`${basename(data)}-m2-aside-`));
  check('no inj/data.restore-* (staging removed)', staging.length === 0, [], staging);
  check('no inj/data-m2-aside-* (live never moved)', aside.length === 0, [], aside);
  check('restore JSON says not ok', !!restoreOut && restoreOut.ok === false, false, restoreOut?.ok ?? null);
  const failures = ((restoreOut?.verify as { failures?: { check: string; what: string; ref?: string }[] } | null | undefined)?.failures ?? []).map((f) => ({ check: f.check, what: f.what, ref: f.ref ?? null }));
  check('restore stopped at its verify step (the modified file is among the failures)', failures.some((f) => f.ref !== null && String(f.ref).endsWith(opt['--modified']!)), opt['--modified'], failures.map((f) => `${f.check}:${f.ref ?? ''}`));
  finish('inject', { snapshot: resolve(opt['--snapshot']!), data, modified: opt['--modified'], files: before.size, restoreExit: exit, restoreError: restoreOut?.error ?? null, restoreFailures: failures, siblings }, { restoreExit: exit, unchanged: d.equal });
}

// ---------------------------------------------------------------------------------------------------------- main

try {
  if (command === 'precheck') precheck();
  else if (command === 'forward') await forward();
  else if (command === 'mutate') await mutate();
  else if (command === 'verify-m1') await verifyM1();
  else if (command === 'rollback-post') rollbackPost();
  else inject();
} catch (e) {
  process.stderr.write(`rehearsal: ${(e as Error).stack ?? String(e)}\n`);
  check(`unexpected error: ${(e as Error).message.slice(0, 200)}`, false);
  finish(command === 'verify-m1' ? 'rollback-m1' : command === 'rollback-post' ? 'rollback' : command, { error: (e as Error).message });
}
