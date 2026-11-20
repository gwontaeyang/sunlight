// Live E2E checks (BRIEF_INTEGRATION I9): pure functions — argument rules, the server environment check per mode,
// the server log (arXiv request lines), the argv judgement, the eight live pass conditions and the result schema.
// The one exception is the path judgement: the real data directory rule is the shared realDataDirPrefixOf (no switch
// turns it off here), and the relations between paths (under the scratch root, data / out / ledger apart) hold both as
// written and between real paths (the realpath of the nearest existing ancestor + the missing rest, existingRealpath),
// so a symbolic link cannot carry a path into the real data directory or into another argument's directory.
// Owner: supervisor. scripts/live-e2e.ts gathers the facts (files, /proc, API, DB) and hands them here;
// apps/server/test/contract/liveE2ePlan.test.ts pins each rule with pass and fail inputs.
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Citation, GroundingLabel, RawCitation } from '../../packages/shared/src/contracts/domain';
import { itemBadge, pairCitations, type ItemBadge } from '../../packages/shared/src/contracts/grounding';
import { NETWORK_REQUEST_LOG_RE } from '../../apps/server/src/security/network';
import { EQUATION_DEEP_HEADINGS, headingIssues } from '../../apps/server/src/llm/headings';
import { RateWarningApprovalSchema, readRateWarningApproval, readRateWarnings, type RateWarningApproval, type RateWarningRecord } from '../../apps/server/src/llm/liveLedger';
import { ALL_NOTATION_KEYS, CALL_IDS, FASTLIO2_EQUATION_NUMBERS, IMPORT_FIRST_PAPER_MAX_REQUESTS, ledgerStopText, LIVE_NETWORK_MAX_REQUESTS, LIVE_PAPERS, selected, type LedgerView, type PaperKey, type PlannedCall, type Selector } from './liveE2ePlan';
import { existingRealpath, realDataDirPrefixOf } from './realDataDir';
import { assertStartupPaths } from '../../apps/server/src/security/startupPaths';

export type Mode = 'live' | 'dry-mock' | 'dry-fake';
export type Command = 'init' | 'import' | 'run' | 'post-check' | 'check-args' | 'evaluate';
export const LIVE_PORT = 4570;
const DRY_REVIEW_PORT = 4594;
const permittedPort = (mode: Mode, port: number | null) => port === LIVE_PORT || (mode !== 'live' && port === DRY_REVIEW_PORT);
export const LIVE_LEDGER_BASENAME = 'ledger-live-e2e';
export const LIVE_DATA_BASENAME = 'm2-live-e2e';
/** Names a dry run must never point at (the coordinator's live ledger / data dir, B's finished ledger). */
export const DRY_FORBIDDEN_NAMES: readonly string[] = [LIVE_LEDGER_BASENAME, LIVE_DATA_BASENAME, 'ledger-b'];
/** The stub every dry-fake server has first on PATH: a real `claude` found there exits 97 without doing anything. */
export const STUB_CLAUDE = '#!/bin/sh\nexit 97\n';

export interface LiveArgs {
  mode: Mode;
  command: Command;
  baseUrl: string;
  data: string;
  out: string;
  serverLog?: string;
  ledger?: string;
  scratchRoot?: string;
  from?: string;
  only?: string;
  /** init only: write the coordinator approval of the rate-limit warning exception into the ledger (결정 26). */
  allowRateWarning?: true;
}

/** The init flag of the rate-limit warning exception (INTEGRATION_NOTES 결정 26) — the runbook adds it when RATE_WARNING_OK=1. */
export const ALLOW_RATE_WARNING_FLAG = '--allow-rate-warning';
/**
 * Where the flag may be given: `init` in live (the exception's purpose) or dry-fake (D8 exercises it); refused in
 * dry-mock (no ledger) and on every other command. Problems, [] = ok.
 */
export function checkRateWarningFlag(command: Command, mode: Mode | null, given: boolean): string[] {
  if (!given) return [];
  if (command !== 'init') return [`${ALLOW_RATE_WARNING_FLAG} belongs to init (it writes the approval into the ledger once)`];
  if (mode !== 'live' && mode !== 'dry-fake') return [`${ALLOW_RATE_WARNING_FLAG}: live or dry-fake only (refused in ${mode ?? 'this mode'})`];
  return [];
}

/** HOME / XDG_DATA_HOME for the real data directory rule; a string is HOME alone. */
export type PathEnv = string | Record<string, string | undefined>;
const envOf = (e: PathEnv): Record<string, string | undefined> => (typeof e === 'string' ? { HOME: e } : e);
/** Real path of a path argument (tests inject one; the default resolves symbolic links on disk). */
export type RealPathFn = (p: string) => string;
const realOf: RealPathFn = (p) => existingRealpath(resolve(p));

const lexUnder = (p: string, root: string) => {
  const a = resolve(p);
  const r = resolve(root);
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
};
/** `p` is under `root` as written and between the real paths. */
const under = (p: string, root: string, real: RealPathFn = realOf) => lexUnder(p, root) && lexUnder(real(p), real(root));
/** One of `p`, `q` contains the other, as written or between the real paths (either direction). */
export function pathsOverlap(p: string, q: string, real: RealPathFn = realOf): boolean {
  const [rp, rq] = [real(p), real(q)];
  return lexUnder(p, q) || lexUnder(q, p) || lexUnder(rp, rq) || lexUnder(rq, rp);
}
const pathParts = (p: string) => resolve(p).split(sep).filter(Boolean);

/**
 * Rules every path argument shares (all commands, post-check included): absolute, never under the real data directory
 * (realDataDirPrefixOf: ~/.local/share/study_paper* of HOME and of the account, $XDG_DATA_HOME/study_paper*, before and
 * after resolving symbolic links).
 */
export function checkPathArg(name: string, v: string, env: PathEnv): string[] {
  const p: string[] = [];
  if (!isAbsolute(v)) p.push(`${name} must be an absolute path`);
  const pre = realDataDirPrefixOf(v, envOf(env));
  if (pre !== null) p.push(`${name} points into the real data directory (${pre}…)`);
  return p;
}

/**
 * `post-check --out <dir>`: the shared path rules, then the directory must exist (post-check never creates it).
 * `isDir` is asked only when the path rules pass, so a refused path is never even looked at.
 */
export function checkPostCheckArgs(out: string, env: PathEnv, isDir: (p: string) => boolean): string[] {
  const p = checkPathArg('--out', out, env);
  if (p.length === 0 && !isDir(out)) p.push('--out must be an existing directory (the out of the run)');
  return p;
}

/**
 * Argument rules of a mode (BRIEF_INTEGRATION I9 "mode와 서버 환경 확인"). `env` = HOME / XDG_DATA_HOME (a string is
 * HOME). --data, --out and --ledger never contain one another (as written or by real path). Problems, [] = ok.
 */
export function checkArgs(a: LiveArgs, env: PathEnv, real: RealPathFn = realOf): string[] {
  const p: string[] = [];
  let port: number | null = null;
  try {
    const u = new URL(a.baseUrl);
    port = u.hostname === '127.0.0.1' && u.protocol === 'http:' && u.port !== '' ? Number(u.port) : null;
  } catch {
    port = null;
  }
  if (!permittedPort(a.mode, port)) p.push(`--base-url must use http://127.0.0.1 on port ${LIVE_PORT}${a.mode === 'live' ? '' : ` or ${DRY_REVIEW_PORT}`}`);
  const paths: [string, string | undefined][] = [
    ['--data', a.data],
    ['--out', a.out],
    ['--ledger', a.ledger],
    ['--scratch-root', a.scratchRoot],
    ['--server-log', a.serverLog],
  ];
  for (const [name, v] of paths) {
    if (v === undefined) continue;
    p.push(...checkPathArg(name, v, env));
  }
  const apart: [string, string | undefined][] = [
    ['--data', a.data],
    ['--out', a.out],
    ['--ledger', a.ledger],
  ];
  for (let i = 0; i < apart.length; i++)
    for (let j = i + 1; j < apart.length; j++) {
      const [n1, v1] = apart[i]!;
      const [n2, v2] = apart[j]!;
      if (v1 !== undefined && v2 !== undefined && pathsOverlap(v1, v2, real)) p.push(`${n1} and ${n2} must not contain each other (as written or by real path)`);
    }
  if (a.from !== undefined && a.only !== undefined) p.push('--from and --only are exclusive');
  for (const [name, v] of [['--from', a.from], ['--only', a.only]] as const) if (v !== undefined && !(CALL_IDS as readonly string[]).includes(v)) p.push(`${name} must be a call id (${CALL_IDS.join(' ')})`);
  if (a.mode === 'live') {
    if (a.scratchRoot !== undefined) p.push('live: no --scratch-root');
    if (a.ledger === undefined || basename(a.ledger) !== LIVE_LEDGER_BASENAME) p.push(`live: --ledger must be a directory named ${LIVE_LEDGER_BASENAME}`);
    if (basename(a.data) !== LIVE_DATA_BASENAME) p.push(`live: --data must be a directory named ${LIVE_DATA_BASENAME}`);
    // one ledger root for the run (INT-I10-07): the 25-call cap is per ledger directory, so a ledger next to another
    // data directory would be a second, fresh 25
    if (a.ledger !== undefined && dirname(real(a.ledger)) !== dirname(real(a.data))) p.push('live: --ledger and --data must be in the same directory (by real path) — one ledger root for the run');
  } else {
    if (a.scratchRoot === undefined) p.push(`${a.mode}: --scratch-root is required`);
    else {
      for (const [name, v] of paths) if (v !== undefined && name !== '--scratch-root' && !under(v, a.scratchRoot, real)) p.push(`${a.mode}: ${name} must be under --scratch-root (as written and by real path)`);
    }
    for (const [name, v] of paths) if (v !== undefined && pathParts(v).some((x) => DRY_FORBIDDEN_NAMES.includes(x))) p.push(`${a.mode}: ${name} points at ${DRY_FORBIDDEN_NAMES.join(' / ')}`);
    if (a.mode === 'dry-mock' && a.ledger !== undefined) p.push('dry-mock: no --ledger');
    if (a.mode === 'dry-fake' && (a.ledger === undefined || !/^ledger-dry-/.test(basename(a.ledger)))) p.push('dry-fake: --ledger must be a directory named ledger-dry-*');
  }
  return p;
}

/**
 * `check-args --smoke-data <dir>` (the runbook's SMOKE_DATA, the data directory of `npm run test:live`): required in live,
 * absent in the dry modes, and the shared path rules. Problems, [] = ok.
 */
export function checkSmokeDataArg(a: Pick<LiveArgs, 'mode' | 'data' | 'ledger'>, smokeData: string | undefined, env: PathEnv, real: RealPathFn = realOf): string[] {
  if (a.mode !== 'live') return smokeData === undefined ? [] : [`${a.mode}: no --smoke-data (only live runs test:live)`];
  if (smokeData === undefined) return ['live: --smoke-data is required'];
  const p = checkPathArg('--smoke-data', smokeData, env);
  for (const [n, v] of [['--data', a.data], ['--ledger', a.ledger]] as const) if (v !== undefined && pathsOverlap(smokeData, v, real)) p.push(`--smoke-data and ${n} must not contain each other (as written or by real path)`);
  // test:live (smoke-live.ts) runs the server's startup check on SMOKE_DATA and its config path: what it would refuse
  // is refused here, before the runbook builds, makes the ledger or spends an import request.
  if (p.length === 0) {
    try {
      assertStartupPaths({ ...envOf(env), SP_DATA_DIR: smokeData, SP_CONFIG_PATH: smokeConfigPath(smokeData) });
    } catch (e) {
      p.push(`--smoke-data: test:live would refuse it: ${(e as Error).message}`);
    }
  }
  return p;
}

/** SP_CONFIG_PATH that live-runbook.sh gives `npm run test:live` (the same formula; m3CarryoverRunbook.test checks both). */
export function smokeConfigPath(smokeData: string): string {
  return `${smokeData}.no-config.json`;
}

/** What live-e2e.ts read about the server process (all from files and /proc — no request). */
export interface ServerFacts {
  /** <data>/run/server.pid (null = missing / unreadable). */
  pid: number | null;
  /** /proc/<pid> exists. */
  alive: boolean;
  /** /proc/<pid>/environ (null = unreadable). */
  environ: Record<string, string> | null;
  /** Whether the file SP_CONFIG_PATH names exists (null = SP_CONFIG_PATH unset). */
  configFileExists: boolean | null;
  /** SP_CLAUDE_BIN: realpath and content (null = unset or unreadable). */
  claudeBin: { realpath: string; content: string } | null;
  /** The first PATH directory of the server: its realpath and the content of its `claude` (null = none). */
  pathFirst: { dir: string; realDir: string; claudeContent: string | null } | null;
}

/**
 * The server environment of a mode (BRIEF_INTEGRATION I9 table). `fakeClaudePath` = absolute path of this repository's
 * apps/server/test/fixtures/fake-claude.mjs. Problems name the cell, [] = ok.
 */
export function checkServerEnv(a: LiveArgs, f: ServerFacts, fakeClaudePath: string, real: RealPathFn = realOf): string[] {
  const p: string[] = [];
  if (f.pid === null) return ['<data>/run/server.pid is missing'];
  if (!f.alive) return [`server pid ${f.pid} is not running`];
  const e = f.environ;
  if (!e) return [`/proc/${f.pid}/environ is not readable`];
  const has = (k: string) => e[k] !== undefined;
  const want = (k: string, v: string) => {
    if (e[k] !== v) p.push(`${k} must be ${v} (is ${e[k] ?? 'unset'})`);
  };
  const absent = (k: string) => {
    if (has(k)) p.push(`${k} must be unset`);
  };
  // common
  if (e.SP_DATA_DIR === undefined || resolve(e.SP_DATA_DIR) !== resolve(a.data) || real(e.SP_DATA_DIR) !== real(a.data)) p.push('SP_DATA_DIR must equal --data');
  if (!permittedPort(a.mode, Number(e.SP_PORT))) p.push(`SP_PORT is not permitted for ${a.mode} (default ${LIVE_PORT})`);
  try {
    if (new URL(a.baseUrl).port !== e.SP_PORT) p.push('--base-url port must equal SP_PORT');
  } catch {
    p.push('--base-url is not a URL');
  }
  if (f.configFileExists === null) p.push('SP_CONFIG_PATH must be set (to a file that does not exist)');
  else if (f.configFileExists) p.push('the file SP_CONFIG_PATH names must not exist (config.claudeBin could replace the CLI)');
  absent('SP_E2E');
  // the server's HOME / XDG_DATA_HOME (and the account's home, inside realDataDirPrefixOf)
  for (const k of ['SP_DATA_DIR', 'SP_LIVE_LEDGER']) if (e[k] !== undefined && realDataDirPrefixOf(e[k]!, { HOME: e.HOME, XDG_DATA_HOME: e.XDG_DATA_HOME }) !== null) p.push(`${k} points into the real data directory`);
  if (a.mode === 'live') {
    want('SP_ENV', 'prod');
    want('SP_LLM', 'cli');
    if (e.SP_LIVE_LEDGER === undefined || a.ledger === undefined || resolve(e.SP_LIVE_LEDGER) !== resolve(a.ledger) || real(e.SP_LIVE_LEDGER) !== real(a.ledger)) p.push('SP_LIVE_LEDGER must equal --ledger');
    const max = e.SP_NETWORK_MAX_REQUESTS;
    if (max === undefined || !/^(0|[1-9][0-9]?)$/.test(max) || Number(max) > LIVE_NETWORK_MAX_REQUESTS) p.push(`SP_NETWORK_MAX_REQUESTS must be an integer 0–${LIVE_NETWORK_MAX_REQUESTS}`);
    absent('SP_CLAUDE_BIN');
    if (e.SP_NETWORK === 'off') p.push('SP_NETWORK=off must not be set (live imports from arXiv)');
    absent('SP_ARXIV_OFFLINE_DIR');
    for (const k of Object.keys(e)) if (k.startsWith('FAKE_CLAUDE_')) p.push(`${k} must be unset`);
    return p;
  }
  const root = a.scratchRoot ?? '/nonexistent';
  if (a.mode === 'dry-mock') {
    want('SP_LLM', 'mock');
    want('SP_NETWORK', 'off');
    absent('SP_LIVE_LEDGER');
    absent('SP_CLAUDE_BIN');
    if (a.command === 'import') {
      want('SP_ENV', 'dev');
      if (e.SP_ARXIV_OFFLINE_DIR === undefined || !under(e.SP_ARXIV_OFFLINE_DIR, root, real)) p.push('SP_ARXIV_OFFLINE_DIR must be under --scratch-root');
    } else want('SP_ENV', 'prod');
    return p;
  }
  // dry-fake
  want('SP_ENV', 'prod');
  want('SP_LLM', 'cli');
  want('SP_NETWORK', 'off');
  if (e.SP_LIVE_LEDGER === undefined || a.ledger === undefined || resolve(e.SP_LIVE_LEDGER) !== resolve(a.ledger) || real(e.SP_LIVE_LEDGER) !== real(a.ledger)) p.push('SP_LIVE_LEDGER must equal --ledger');
  const bin = e.SP_CLAUDE_BIN;
  if (bin === undefined) p.push('SP_CLAUDE_BIN must be set (else the server runs the real claude on PATH)');
  else if (!isAbsolute(bin)) p.push('SP_CLAUDE_BIN must be an absolute path');
  else if (!f.claudeBin) p.push('SP_CLAUDE_BIN is not readable');
  else {
    if (!lexUnder(f.claudeBin.realpath, real(root))) p.push('SP_CLAUDE_BIN (realpath) must be under --scratch-root');
    if (!execsFile(f.claudeBin.content, fakeClaudePath)) p.push(`SP_CLAUDE_BIN must exec ${fakeClaudePath}`);
  }
  if (!f.pathFirst) p.push('PATH must start with the stub directory');
  else {
    if (!lexUnder(f.pathFirst.realDir, real(root))) p.push('the first PATH directory must be under --scratch-root');
    if (f.pathFirst.claudeContent !== STUB_CLAUDE) p.push('the first PATH directory must hold the `claude` stub (exit 97)');
  }
  return p;
}

/** A wrapper whose last command line is `exec <node> "<fake>" "$@"` (no other exec, no other script path). */
export function execsFile(content: string, file: string): boolean {
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  const execs = lines.filter((l) => /^exec\s/.test(l));
  if (execs.length !== 1 || lines[lines.length - 1] !== execs[0]) return false;
  const others = lines.slice(0, -1);
  if (!others.every((l) => /^export [A-Z_][A-Z0-9_]*=[^;&|`$()<>]*$/.test(l))) return false;
  const quoted = execs[0]!.match(/"([^"]*)"/g)?.map((q) => q.slice(1, -1)) ?? [];
  return quoted.length === 3 && quoted[1] === file && quoted[2] === '$@' && /\/node$/.test(quoted[0]!);
}

/** NUL-separated /proc/<pid>/environ → record. */
export function parseEnviron(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of raw.split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------
// server log

export interface ArxivRequests {
  used: number;
  max: number | null;
  requests: { k: number; host: string }[];
}
/** The `network request k/n host=…` lines of a server log (security/network.ts NETWORK_REQUEST_LOG_RE). */
export function parseNetworkLog(text: string): ArxivRequests {
  const requests: { k: number; host: string }[] = [];
  let max: number | null = null;
  for (const line of text.split('\n')) {
    const m = NETWORK_REQUEST_LOG_RE.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    requests.push({ k: Number(m[1]), host: m[3]! });
    max = Number(m[2]);
  }
  return { used: requests.length, max, requests };
}

// ------------------------------------------------------------------------------------------------------------------
// argv (pass condition 7)

export const BASE64_RUN_RE = /[A-Za-z0-9+/]{200,}/;
/** One argv sample of a child: only lengths and verdicts are kept (never the argv). */
export interface ArgvSample {
  /** The run index (argv_samples.jsonl lines carry it; condition 7 is judged over every run of --out). */
  run?: number;
  pid: number;
  callId: string;
  argvChars: number;
  userTextHit: boolean;
  base64Hit: boolean;
}
/** NUL-joined cmdline of a child vs the user strings of the current call (selection, question, term). */
export function judgeArgv(cmdline: string, userStrings: readonly string[]): { argvChars: number; userTextHit: boolean; base64Hit: boolean } {
  const argv = cmdline.split('\0').join(' ');
  const hit = userStrings.some((s) => s.trim().length >= 4 && argv.includes(s.trim()));
  return { argvChars: argv.length, userTextHit: hit, base64Hit: BASE64_RUN_RE.test(argv) };
}

/** /proc/<pid>/stat → ppid and starttime (fields after the parenthesised comm). */
export function parseProcStat(stat: string): { ppid: number; starttime: number } | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const f = stat.slice(close + 2).split(' ');
  const ppid = Number(f[1]);
  const starttime = Number(f[19]);
  return Number.isInteger(ppid) && Number.isFinite(starttime) ? { ppid, starttime } : null;
}

// ------------------------------------------------------------------------------------------------------------------
// pass conditions (PLAN_M2 7절, I9 1–8)

export type CondResult = 'pass' | 'fail' | 'not_evaluated';
export interface Condition {
  id: number;
  name: string;
  result: CondResult;
  evidence: Record<string, unknown>;
}

export interface CardItemFacts {
  key: string | null;
  label: GroundingLabel | null;
  badge: ItemBadge;
}
/** 1. notation card (FAST-LIO2, F2): the 11 keys stored + at least one item labelled P. */
export function cond1Notation(items: readonly CardItemFacts[] | null): Condition {
  if (items === null) return { id: 1, name: 'notation_card 11 keys + label P ≥ 1', result: 'not_evaluated', evidence: { reason: 'F2 did not produce a card' } };
  const keys = items.map((i) => i.key).filter((k): k is string => k !== null);
  const missing = ALL_NOTATION_KEYS.filter((k) => !keys.includes(k));
  const pCount = items.filter((i) => i.label === 'P').length;
  const ok = missing.length === 0 && keys.length === ALL_NOTATION_KEYS.length && pCount >= 1;
  return { id: 1, name: 'notation_card 11 keys + label P ≥ 1', result: ok ? 'pass' : 'fail', evidence: { storedKeys: keys.length, missing, labelP: pCount } };
}

export interface EquationDeepAttempt {
  id: 'F1' | 'F1r';
  /** The stored assistant answer (SP-Markup source) — null when the call made none. */
  text: string | null;
  /** Equation references paired with the stored citations (pairCitations), null when they do not pair. */
  citations: readonly Citation[] | null;
}
/** The symbol-table heading of equation_deep, taken from B's heading table (never copied into the script). */
export const SYMBOL_TABLE_HEADING: string = EQUATION_DEEP_HEADINGS[0];
const ATX_HEADING_RE = /^\s{0,3}#{1,6}(\s|$)/;
const PIPE_RE = /(?<!\\)\|/;
/** The ATX heading text of a line (`## x ##` → `x`), or null. */
function atxHeadingText(line: string): string | null {
  const m = /^\s{0,3}#{1,6}(?:\s+(.*?))?\s*$/.exec(line);
  if (!m) return null;
  return (m[1] ?? '').replace(/\s+#+$/, '').replace(/^#+$/, '').trim();
}
/** Cells of a table line: split on `|` (not `\|`), the empty cells outside a leading / trailing pipe dropped. */
function tableCells(line: string): string[] {
  const cells = line.trim().split(/(?<!\\)\|/);
  if (cells.length > 1 && cells[0]!.trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}
/** A GFM delimiter row: has a pipe, every cell is `:?-+:?` (`|---|`, `|:-:|:-:|`, `|--|--|`, `--- | ---`). */
export function isTableDelimiterRow(line: string): boolean {
  if (!PIPE_RE.test(line)) return false;
  const cells = tableCells(line);
  return cells.length >= 1 && cells.every((c) => /^:?-+:?$/.test(c));
}
/**
 * Body rows of the first GFM table under the `기호 표` heading (EQUATION_DEEP_HEADINGS[0]): a header line with a pipe,
 * the delimiter row right under it, then the following non-blank lines with a pipe (a blank line or a heading ends
 * the table). Leading / trailing pipes are optional, and any delimiter form GFM accepts counts.
 */
export function symbolTableRows(text: string): number {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.findIndex((l) => atxHeadingText(l)?.normalize('NFC') === SYMBOL_TABLE_HEADING.normalize('NFC'));
  if (start < 0) return 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ATX_HEADING_RE.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  for (let i = start + 2; i < end; i++) {
    const header = lines[i - 1]!;
    if (!isTableDelimiterRow(lines[i]!) || header.trim() === '' || !PIPE_RE.test(header) || isTableDelimiterRow(header)) continue;
    let rows = 0;
    for (let j = i + 1; j < end && lines[j]!.trim() !== '' && PIPE_RE.test(lines[j]!); j++) rows++;
    return rows;
  }
  return 0;
}
/** One attempt of condition 2: 4 fixed headings, `<eq n="10"/>` resolved, ≥ 1 symbol table row. */
export function equationDeepVerdict(a: EquationDeepAttempt, eqNumber: string): { ok: boolean; missingHeadings: number; eqResolved: boolean; symbolRows: number } {
  if (a.text === null) return { ok: false, missingHeadings: 4, eqResolved: false, symbolRows: 0 };
  const missingHeadings = headingIssues('equation_deep', a.text).length;
  const eqResolved = (a.citations ?? []).some((c) => c.kind === 'equation' && c.eqNumber === eqNumber && c.status === 'resolved');
  const symbolRows = symbolTableRows(a.text);
  return { ok: missingHeadings === 0 && eqResolved && symbolRows >= 1, missingHeadings, eqResolved, symbolRows };
}
/**
 * Where a resumed run takes F1's verdict from (it decides whether F1r is sent — FIX4-R2-01): calls/F1.json's
 * boolean f1Passed when it has one. A record without it that names F1's thread and run (the minimal record of a run
 * killed after the terminal, or a run that stopped because a lookup failed) is looked up again (one GET) when this
 * invocation decides F1r from it: F1r selected, F1 not (a selected F1 is sent again and judged), not `--only F1r` (explicit retries still require budget). Otherwise null — no F1 record, or one without a thread or run (F1 made no answer): not passed (decideNext).
 */
export type F1ResumeSource = { kind: 'known'; f1Passed: boolean | null } | { kind: 'lookup'; threadId: string; runId: string };
export function f1ResumeSource(rec: Record<string, unknown> | null, sel: Selector): F1ResumeSource {
  if (rec && typeof rec.f1Passed === 'boolean') return { kind: 'known', f1Passed: rec.f1Passed };
  const decidesF1r = selected('F1r', sel) && !selected('F1', sel) && sel.only !== 'F1r';
  if (decidesF1r && rec && typeof rec.threadId === 'string' && typeof rec.runId === 'string') return { kind: 'lookup', threadId: rec.threadId, runId: rec.runId };
  return { kind: 'known', f1Passed: null };
}
/**
 * F1's verdict from the resume lookup (f1ResumeSource 'lookup'): equationDeepVerdict of the attempt; a failed lookup
 * (an Error) leaves it unknown → stop before the first call (exit 3, no call), so F1r is never sent on a guess.
 */
export function f1ResumeVerdict(attempt: EquationDeepAttempt | Error, eqNumber: string): { f1Passed: boolean } | { stop: string } {
  if (attempt instanceof Error) return { stop: `resume: F1's verdict is unknown (calls/F1.json has no f1Passed and its equation lookup failed: ${attempt.message.split('\n')[0]!.slice(0, 200)}); no call sent` };
  return { f1Passed: equationDeepVerdict(attempt, eqNumber).ok };
}
/** Looks up F1's equation attempt of an earlier run by that run's thread and run (live-e2e: equationAttempt). */
export type F1AttemptLookup = (threadId: string, runId: string) => Promise<EquationDeepAttempt>;
/**
 * The resume's F1 verdict before the first call (FIX4-R2-01, FIX4-R3-01): the record's f1Passed, or — f1ResumeSource
 * 'lookup' — ONE lookup with the record's own threadId and runId; a lookup that throws or rejects → stop (exit 3, no call).
 */
export async function resolveF1Resume(rec: Record<string, unknown> | null, sel: Selector, eqNumber: string, lookup: F1AttemptLookup): Promise<{ f1Passed: boolean | null } | { stop: string }> {
  const source = f1ResumeSource(rec, sel);
  if (source.kind === 'known') return { f1Passed: source.f1Passed };
  const attempt = await Promise.resolve()
    .then(() => lookup(source.threadId, source.runId))
    .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  return f1ResumeVerdict(attempt, eqNumber);
}
/** 2. equation_deep from the equation tab (F1, or F1r once): pass when either attempt meets every part. */
export function cond2EquationDeep(attempts: readonly EquationDeepAttempt[], eqNumber: string): Condition {
  const name = `equation_deep: 4 headings + <eq n="${eqNumber}"/> resolved + symbol rows ≥ 1 (F1 or F1r)`;
  if (attempts.length === 0) return { id: 2, name, result: 'not_evaluated', evidence: { reason: 'F1 not run' } };
  const per = attempts.map((a) => ({ id: a.id, ...equationDeepVerdict(a, eqNumber) }));
  return { id: 2, name, result: per.some((x) => x.ok) ? 'pass' : 'fail', evidence: { attempts: per } };
}

export interface OwnerChips {
  owner: string;
  /** Citations the parser finds in the stored content (<q> and <eq>). */
  parsed: readonly RawCitation[];
  stored: readonly Citation[];
}
/**
 * 3. every chip has a status: for each message / card item / term of this run, parsed <q>·<eq> = stored citations (paired).
 * `missingOwners` = the owners of calls that ended with run.done but whose stored answer was not found (e.g. `O7:term`
 * when the script's glossary.create failed): their chips cannot be checked, so the condition is `not_evaluated`
 * (not a pass) unless another owner already fails.
 */
export function cond3Chips(owners: readonly OwnerChips[], missingOwners: readonly string[]): Condition {
  const name = 'every <q>/<eq> of the run has a stored citation';
  if (owners.length === 0) return { id: 3, name, result: 'not_evaluated', evidence: { owners: 0, missingOwners: [...missingOwners] } };
  const bad = owners.filter((o) => pairCitations(o.parsed, o.stored) === null).map((o) => ({ owner: o.owner, parsed: o.parsed.length, stored: o.stored.length }));
  const result: CondResult = bad.length > 0 ? 'fail' : missingOwners.length > 0 ? 'not_evaluated' : 'pass';
  return { id: 3, name, result, evidence: { owners: owners.length, chips: owners.reduce((n, o) => n + o.parsed.length, 0), unpaired: bad, missingOwners: [...missingOwners] } };
}

export interface CallRow {
  runId: string;
  task: string;
  model: string;
  effort: string;
  status: string;
  errorCode: string | null;
  prefixFingerprint: string | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  ttftMs: number | null;
  durationMs: number | null;
  parentRunId: string | null;
  rateLimitJson: string | null;
  acceptedAt: number;
}
/** 4. capture (O2) and explain (O1) share the prefix fingerprint, and O2 reads the cache. */
export function cond4CapturePrefix(o1: CallRow | null, o2: CallRow | null): Condition {
  const name = 'O2 prefixFingerprint = O1 and O2 cacheReadTokens > 0';
  if (!o1 || !o2) return { id: 4, name, result: 'not_evaluated', evidence: { o1: !!o1, o2: !!o2 } };
  const same = o1.prefixFingerprint !== null && o1.prefixFingerprint === o2.prefixFingerprint;
  const read = (o2.cacheReadTokens ?? 0) > 0;
  return { id: 4, name, result: same && read ? 'pass' : 'fail', evidence: { sameFingerprint: same, o1Fingerprint: o1.prefixFingerprint !== null, o2CacheReadTokens: o2.cacheReadTokens } };
}
/** 5. translation runs have no prefix fingerprint. `expected` = how many translate calls (S1–S3) the plan selected. */
export function cond5TranslateNoPrefix(rows: readonly CallRow[], expected: number): Condition {
  const name = 'translate runs: prefixFingerprint IS NULL';
  if (rows.length === 0 || rows.length < expected) return { id: 5, name, result: 'not_evaluated', evidence: { rows: rows.length, expected } };
  const withFp = rows.filter((r) => r.prefixFingerprint !== null).length;
  return { id: 5, name, result: withFp === 0 ? 'pass' : 'fail', evidence: { rows: rows.length, withFingerprint: withFp } };
}
/** 6. deep runs (O4, O10) have effort high. `expected` = how many deep calls the plan selected. */
export function cond6DeepEffort(rows: readonly CallRow[], expected: number): Condition {
  const name = 'deep runs (O4, O10): llm_calls.effort = high';
  if (rows.length === 0 || rows.length < expected) return { id: 6, name, result: 'not_evaluated', evidence: { rows: rows.length, expected } };
  const notHigh = rows.filter((r) => r.effort !== 'high').length;
  return { id: 6, name, result: notHigh === 0 ? 'pass' : 'fail', evidence: { rows: rows.length, notHigh } };
}
/** 7. no user text and no base64 run in any sampled `claude` argv. */
export function cond7Argv(samples: readonly ArgvSample[], metas: readonly Pick<RunMeta, 'run' | 'callsStarted'>[] = []): Condition {
  const name = 'claude argv: no user text, no base64 run of ≥ 200 chars';
  const hits = samples.filter((s) => s.userTextHit || s.base64Hit);
  const sampledRuns = new Set(samples.map((s) => s.run).filter((r): r is number => r !== undefined));
  const runs = [...sampledRuns].sort((x, y) => x - y);
  const missingRuns = metas.filter((m) => m.callsStarted > 0 && !sampledRuns.has(m.run)).map((m) => m.run);
  const result = hits.length ? 'fail' : missingRuns.length || !samples.length ? 'not_evaluated' : 'pass';
  return {
    id: 7, name, result,
    evidence: {
      samples: samples.length, children: new Set(samples.map((s) => `${s.run ?? ''}:${s.pid}`)).size,
      ...(runs.length ? { runs } : {}), ...(missingRuns.length ? { missingRuns } : {}),
      hits: hits.map(({ run, callId, userTextHit, base64Hit, argvChars }) => ({ ...(run !== undefined ? { run } : {}), callId, userTextHit, base64Hit, argvChars })),
    },
  };
}
/** 8. after the server stopped no child it had is alive (judged by post-check). */
export function cond8NoChildren(children: readonly { pid: number; alive: boolean }[] | null): Condition {
  const name = 'no child process after the server stopped';
  if (children === null) return { id: 8, name, result: 'not_evaluated', evidence: { reason: 'judged by post-check after the server stops' } };
  const alive = children.filter((c) => c.alive).map((c) => c.pid);
  return { id: 8, name, result: alive.length === 0 ? 'pass' : 'fail', evidence: { children: children.length, alive } };
}

/**
 * Exit code of `run`: 0 when the plan ran to its end, conditions 1–7 all pass and condition 8 did not fail (in `run`
 * it carries the earlier runs of --out — cond8EarlierRuns; the run's own children are post-check's); 1 otherwise
 * (stops are 3, decided earlier).
 */
export function runExitCode(conditions: readonly Condition[]): 0 | 1 {
  return conditions.filter((c) => c.id !== 8).every((c) => c.result === 'pass') && conditions.every((c) => c.id !== 8 || c.result !== 'fail') ? 0 : 1;
}
/**
 * Exit code of `evaluate` (FIX4-R2-03 · R3-03): 3 when the judged run had stopped (run.<n>.json's stoppedReason, or, none
 * stored, a ledger that is STOP / STOP_REQUESTED now — evaluateStoppedReason, 결정 33), whatever the conditions; otherwise
 * runExitCode — condition 8 (cond8Evaluate: the judged run's own post-check too) fails → 1.
 */
export function evaluateExitCode(stoppedReason: string | null, conditions: readonly Condition[]): 0 | 1 | 3 {
  return stoppedReason !== null ? 3 : runExitCode(conditions);
}
/**
 * The stop reason `evaluate` judges with (Codex r4 M-M2-R4-1, 결정 33): the one stored in run.<n>.json, kept as it is;
 * none stored but the ledger stopped now (STOP / STOP_REQUESTED — a record made before the run read the ledger after its
 * last call, or a stop after the run) → a reason, so evaluateExitCode is 3 and a stopped ledger never turns into a pass.
 * dry-mock (no ledger) → the stored value.
 */
export function evaluateStoppedReason(stored: string | null, ledger: Pick<LedgerView, 'stopped' | 'stopRequested'> | null): string | null {
  if (stored !== null) return stored;
  const stop = ledgerStopText(ledger);
  return stop === null ? null : `the ledger is stopped (${stop}); the run record had no stop reason`;
}

/**
 * The summary line `run` and `evaluate` print last (the runbook's EVALUATE branch reads it with eval_fields — FIX4-R2-02):
 * run index, verdict, stop reason, conditions and callsNotDone. postCheck — the judged run's own post-check, which
 * condition 8 carries only when `evaluate` judges (cond8Evaluate) — is written without spaces or hyphens (`no post-check` →
 * `no_post_check`) so it stays one field on the runbook's last line.
 */
export function summaryLine(runIndex: number, code: number, stoppedReason: string | null, out: { conditions: readonly Condition[]; callsNotDone: readonly string[] }): Record<string, unknown> {
  const pc = out.conditions.find((c) => c.id === 8)?.evidence.postCheck;
  return {
    run: code === 0 ? 'pass' : code === 3 ? 'stopped' : 'conditions_failed',
    runIndex,
    ...(typeof pc === 'string' ? { postCheck: pc.replace(/[\s-]+/g, '_') } : {}),
    stoppedReason,
    conditions: out.conditions.map((x) => `${x.id}:${x.result}`).join(' '),
    callsNotDone: out.callsNotDone.length === 0 ? 0 : `${out.callsNotDone.length}:${out.callsNotDone.join(',')}`,
  };
}

/** Card item badge from its label and its paired citations (D's rule — contracts/grounding itemBadge). */
export const badgeOf = (label: GroundingLabel | null, parsed: readonly RawCitation[], stored: readonly Citation[]): ItemBadge => itemBadge(label, pairCitations(parsed, stored));

// ------------------------------------------------------------------------------------------------------------------
// live_e2e.json

const Num = z.number().nullable();
export const CallRecordSchema = z.object({
  id: z.string(),
  task: z.string(),
  model: z.string(),
  effort: z.string(),
  path: z.enum(['api', 'screen']),
  outcome: z.string(),
  decision: z.string(),
  clientMs: z.number().nullable(),
  runId: z.string().nullable(),
  status: z.string().nullable(),
  errorCode: z.string().nullable(),
  ttftMs: Num,
  durationMs: Num,
  cacheReadTokens: Num,
  cacheCreationTokens: Num,
  inputTokens: Num,
  outputTokens: Num,
  prefixFingerprint: z.boolean(),
  repairs: z.number().int(),
  capture: z.object({ file: z.string(), bytes: z.number().int(), width: z.number().int(), height: z.number().int() }).nullable(),
  /** O7 only: the glossary term the script stored after the call, or why storing it failed (null otherwise). */
  termId: z.string().nullable(),
  termStoreError: z.string().nullable(),
});
export type CallRecord = z.infer<typeof CallRecordSchema>;
/** One `calls/<id>.json` record → its row in live_e2e.json `calls`. */
export const callRecordOf = (r: Record<string, unknown>): CallRecord => ({
  id: String(r.id),
  task: String(r.task),
  model: String(r.model),
  effort: String(r.effort),
  path: r.path as 'api' | 'screen',
  outcome: String(r.outcome),
  decision: String(r.decision),
  clientMs: (r.clientMs as number | null) ?? null,
  runId: (r.runId as string | null) ?? null,
  status: (r.status as string | null) ?? null,
  errorCode: (r.errorCode as string | null) ?? null,
  ttftMs: (r.ttftMs as number | null) ?? null,
  durationMs: (r.durationMs as number | null) ?? null,
  cacheReadTokens: (r.cacheReadTokens as number | null) ?? null,
  cacheCreationTokens: (r.cacheCreationTokens as number | null) ?? null,
  inputTokens: (r.inputTokens as number | null) ?? null,
  outputTokens: (r.outputTokens as number | null) ?? null,
  prefixFingerprint: r.prefixFingerprint === true,
  repairs: (r.repairs as number) ?? 0,
  capture: (r.capture as { file: string; bytes: number; width: number; height: number } | null) ?? null,
  termId: typeof r.termId === 'string' ? r.termId : null,
  termStoreError: typeof r.termStoreError === 'string' ? r.termStoreError : null,
});
/** One rate-limit warning the ledger let through (rate_warnings.jsonl), labelled with the plan call it belongs to. */
export const RateLimitWarningSchema = z.strictObject({
  /** The plan call (its own run or an SP-Blocks repair of it), H1–H3 for test:live, null when no record matches. */
  call: z.string().nullable(),
  runId: z.string().nullable(),
  status: z.string(),
  /** The CLI's rateLimitType of the warning (seven_day, five_hour, …): which window the warning is about. */
  rateLimitType: z.string().nullable(),
  /** Always the seven-day window's utilization (unifiedWindows.seven_day), whatever rateLimitType says. */
  utilization: Num,
  /** The warning's resetsAt (the window of rateLimitType). */
  resetsAt: Num,
  at: z.string(),
});
export type RateLimitWarning = z.infer<typeof RateLimitWarningSchema>;
/**
 * The ledger's rate_warnings.jsonl lines → live_e2e.json `rateLimitWarnings`: `call` = the call record whose runId is
 * the warning's, or whose runId is the parent of that llm_calls row (a repair); `smoke-<k>-…` (scripts/smoke-live.ts)
 * = H<k>; else null (the runId stays).
 */
export function rateLimitWarningsOf(lines: readonly RateWarningRecord[], calls: readonly { id: string; runId: string | null }[], rows: readonly { runId: string; parentRunId: string | null }[]): RateLimitWarning[] {
  const callOf = (runId: string | null): string | null => {
    if (runId === null) return null;
    const own = calls.find((c) => c.runId === runId);
    if (own) return own.id;
    const parent = rows.find((r) => r.runId === runId)?.parentRunId ?? null;
    const viaParent = parent === null ? undefined : calls.find((c) => c.runId === parent);
    if (viaParent) return viaParent.id;
    const smoke = /^smoke-([1-9])-/.exec(runId);
    return smoke ? `H${smoke[1]}` : null;
  };
  return lines.map((w) => ({ call: callOf(w.runId ?? null), runId: w.runId ?? null, status: w.status, rateLimitType: typeof w.rateLimitType === 'string' ? w.rateLimitType : null, utilization: typeof w.utilization === 'number' ? w.utilization : null, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null, at: w.at }));
}
/**
 * run.<n>.json's approval fields (결정 26): the ledger's ALLOW_RATE_WARNING as it reads now — a valid approval → true
 * + its content; none or a damaged one → false / null. dry-mock has no ledger: false / null even when a ledger is given.
 */
export function rateWarningApprovalFields(mode: Mode, ledger: string | undefined): { rateWarningAllowed: boolean; rateWarningApproval: RateWarningApproval | null } {
  const approval = mode === 'dry-mock' || ledger === undefined ? null : readRateWarningApproval(ledger);
  return { rateWarningAllowed: approval !== null, rateWarningApproval: approval };
}
/**
 * live_e2e(.<n>).json's three rate-warning fields: rateWarningApprovalFields + the ledger's rate_warnings.jsonl mapped
 * by rateLimitWarningsOf (dry-mock or no ledger → []). cmdRun and evaluate of scripts/live-e2e.ts take them from here.
 */
export function rateWarningResultFields(mode: Mode, ledger: string | undefined, calls: readonly { id: string; runId: string | null }[], rows: readonly { runId: string; parentRunId: string | null }[]): { rateWarningAllowed: boolean; rateWarningApproval: RateWarningApproval | null; rateLimitWarnings: RateLimitWarning[] } {
  const warnings = mode === 'dry-mock' || ledger === undefined ? [] : readRateWarnings(ledger);
  return { ...rateWarningApprovalFields(mode, ledger), rateLimitWarnings: rateLimitWarningsOf(warnings, calls, rows) };
}
export const LiveE2eResultSchema = z.strictObject({
  mode: z.enum(['live', 'dry-mock', 'dry-fake']),
  /** The ledger carried a valid ALLOW_RATE_WARNING (결정 26) when this was judged; its content (null without it). */
  rateWarningAllowed: z.boolean(),
  rateWarningApproval: RateWarningApprovalSchema.nullable(),
  /** Rate-limit warnings that did not stop the ledger because of that approval. */
  rateLimitWarnings: z.array(RateLimitWarningSchema),
  startedAt: z.number(),
  finishedAt: z.number(),
  selector: z.object({ from: z.string().nullable(), only: z.string().nullable() }),
  stoppedReason: z.string().nullable(),
  calls: z.array(CallRecordSchema),
  skipped: z.array(z.object({ id: z.string(), record: z.string() })),
  planOrder: z.object({ pass: z.boolean(), expected: z.array(z.string()), actual: z.array(z.string()) }),
  /** Planned calls that did not end in run.done (callsNotDone): exit 0 alone does not mean every planned call answered. */
  callsNotDone: z.array(z.string()),
  records: z.strictObject({
    timings: z.array(z.object({ id: z.string(), task: z.string(), ttftMs: Num, durationMs: Num, cold: z.boolean().nullable() })),
    chatLowVsDeep: z.object({ lowTtftMs: Num, deepTtftMs: Num }),
    v2PrefixCache: z.array(z.object({ id: z.string(), cacheCreationTokens: Num, cacheReadTokens: Num })),
    quoteStatus: z.record(z.string(), z.number().int()),
    uncheckedQuotes: z.number().int(),
    eqStatus: z.record(z.string(), z.number().int()),
    eqResolvedRatio: Num,
    cardLabels: z.record(z.string(), z.number().int()),
    cardBadges: z.record(z.string(), z.number().int()),
    unverifiedRatio: Num,
    pEquationOnly: z.object({ cardItems: z.number().int(), cardP: z.number().int(), messageBlocks: z.number().int(), messageP: z.number().int(), ratio: Num }),
    fastlio2StatedKeys: z.object({ keys: z.array(z.string()), pWithEvidence: z.number().int(), ratio: Num }),
    // Earlier reports only have the model-specific fable timings.
    deepTasks: z.array(z.object({ id: z.string(), model: z.string(), durationMs: Num, over600s: z.boolean().nullable() })).default([]),
    fable: z.array(z.object({ id: z.string(), durationMs: Num, over600s: z.boolean().nullable() })),
    repairs: z.number().int(),
    translateInputTokens: z.array(z.object({ id: z.string(), inputTokens: Num })),
    sevenDayUtilization: Num,
    arxivRequests: z.object({ used: z.number().int(), max: z.number().nullable() }).nullable(),
    ledgerUsed: z.object({ total: z.number().int(), perModel: z.record(z.string(), z.number().int()) }).nullable(),
  }),
  conditions: z.array(z.object({ id: z.number().int(), name: z.string(), result: z.enum(['pass', 'fail', 'not_evaluated']), evidence: z.record(z.string(), z.unknown()) })),
  exitCode: z.number().int(),
});
export type LiveE2eResult = z.infer<typeof LiveE2eResultSchema>;
/**
 * The planned calls of --out that did not end in run.done (INT-I10-05), in plan order: every non-conditional call
 * whose record (calls/<id>.json) is missing, a skip, or another outcome; F1r only when it was needed (a record that is
 * not run.done and not skipped_not_needed). Soft failures and model-cap skips go on without failing the run, so a
 * passing exit code alone does not say every planned call answered — this list does (BRIEF_INTEGRATION I10 6).
 */
export function callsNotDone(plan: readonly Pick<PlannedCall, 'id' | 'conditional'>[], records: readonly Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const c of plan) {
    const r = records.find((x) => x.id === c.id);
    if (c.conditional) {
      if (r !== undefined && r.outcome !== 'run.done' && r.skipped !== 'skipped_not_needed') out.push(c.id);
      continue;
    }
    if (r === undefined || r.skipped !== undefined || r.outcome !== 'run.done') out.push(c.id);
  }
  return out;
}

/** The record keys live_e2e.json must carry (D1 checks them). */
export const RECORD_KEYS = Object.keys(LiveE2eResultSchema.shape.records.shape);

/**
 * Every explain / translate selection of `calls` against the stored page text, before the first call: [start, end)
 * inside the page and the SHA-256 of that text = the plan's (chosen on the fixture PDF). `pageText` = page_texts.text
 * (null = no row). Problems name the call and what differs, never the text. [] = every selection is the planned one.
 */
export function checkPlanSelections(calls: readonly PlannedCall[], pageText: (paper: PaperKey, page: number) => string | null): string[] {
  const p: string[] = [];
  for (const c of calls) {
    const t = c.target;
    if (t.kind !== 'explain' && t.kind !== 'translate') continue;
    const s = t.selection;
    const text = pageText(c.paper, s.page);
    if (text === null) {
      p.push(`${c.id}: ${c.paper} page ${s.page} has no stored text`);
      continue;
    }
    if (!(Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.start < s.end && s.end <= text.length)) {
      p.push(`${c.id}: ${c.paper} p${s.page} [${s.start}, ${s.end}) is outside the stored page text (${text.length} chars)`);
      continue;
    }
    const h = createHash('sha256').update(text.slice(s.start, s.end), 'utf8').digest('hex');
    if (h !== s.sha256) p.push(`${c.id}: ${c.paper} p${s.page} [${s.start}, ${s.end}) is not the planned text (sha256 differs: the stored PDF text is not the fixture's)`);
  }
  return p;
}

// ------------------------------------------------------------------------------------------------------------------
// preconditions (before any LLM call: `import` ends with them, `run` checks them again)

export interface PaperFacts {
  found: boolean;
  arxivVersion: number | null;
  supplementVersion: number | null;
  structureSource: string | null;
  /** `number` of every equation row that has one (papers.structure). */
  numberedEquations: string[];
}
const sortedNumbers = (p: PaperFacts) => [...new Set(p.numberedEquations)].sort((x, y) => Number(x) - Number(y) || x.localeCompare(y));

/**
 * The preconditions of one paper: imported, at the planned arXiv version (LIVE_PAPERS — the plan's offsets, hashes,
 * areas and equation numbers belong to that version), supplement v2, latexml structure; FAST-LIO2's numbered equations
 * are exactly 1 … 19 (each number at least once, no other).
 */
export function paperPreconditionProblems(k: PaperKey, p: PaperFacts): string[] {
  if (!p.found) return [`${k}: not imported`];
  const problems: string[] = [];
  if (p.arxivVersion !== LIVE_PAPERS[k].version) problems.push(`${k}: arxivVersion ${String(p.arxivVersion)} (must be ${LIVE_PAPERS[k].version}, the planned version)`);
  if (p.supplementVersion !== 2) problems.push(`${k}: supplementVersion ${String(p.supplementVersion)} (must be 2)`);
  if (p.structureSource !== 'latexml') problems.push(`${k}: structureSource ${String(p.structureSource)} (must be latexml)`);
  if (k === 'fastlio2') {
    const nums = sortedNumbers(p);
    const want = FASTLIO2_EQUATION_NUMBERS;
    if (nums.length !== want.length || nums.some((n, i) => n !== want[i])) problems.push(`fastlio2: numbered equations are [${nums.join(',')}] (must be exactly 1…19)`);
  }
  return problems;
}

/** Both papers (paperPreconditionProblems). */
export function checkPreconditions(f: Record<'kiss' | 'fastlio2', PaperFacts>): { ok: boolean; problems: string[]; fastlio2Numbers: string[]; fastlio2Rows: number } {
  const problems = [...paperPreconditionProblems('kiss', f.kiss), ...paperPreconditionProblems('fastlio2', f.fastlio2)];
  return { ok: problems.length === 0, problems, fastlio2Numbers: sortedNumbers(f.fastlio2), fastlio2Rows: f.fastlio2.numberedEquations.length };
}

/**
 * `import` after the first paper (KISS-ICP), before the second is requested (INT-I10-03): its job ended with job.done,
 * it meets its own preconditions, and it used at most IMPORT_FIRST_PAPER_MAX_REQUESTS arXiv requests. Any problem →
 * exit 2 and FAST-LIO2 is not requested (the preconditions already failed; more requests would only spend the 12).
 * `alreadyImported` (papers.import answered existing: true with no job — the paper was imported by an earlier import of
 * the same data directory, e.g. before a FAST-LIO2 failure): there is no job and no terminal event, so only the paper's
 * own preconditions and the request count decide (FIX4-R1-02).
 */
export function checkFirstPaperImport(terminal: string | null, facts: PaperFacts, arxivUsed: number, alreadyImported = false): string[] {
  const p: string[] = [];
  if (!(alreadyImported && terminal === null) && terminal !== 'job.done') p.push(`kiss: the import job ended with ${terminal ?? 'no terminal event'} (must be job.done)`);
  p.push(...paperPreconditionProblems('kiss', facts));
  if (arxivUsed > IMPORT_FIRST_PAPER_MAX_REQUESTS) p.push(`kiss: used ${arxivUsed} arXiv requests (more than ${IMPORT_FIRST_PAPER_MAX_REQUESTS})`);
  return p;
}

// ------------------------------------------------------------------------------------------------------------------
// run records in --out (M-M2-R2-6 · INT-I10-02): what post-check and `evaluate` read back

/** `run.<n>.json`: one `run` invocation, n = 1, 2, … in the order of the invocations on the same --out. */
export const RUN_META_RE = /^run\.([1-9][0-9]*)\.json$/;
export interface RunMeta {
  run: number;
  mode: Mode;
  startedAt: number;
  /** <data> (resolved): post-check looks for processes left in <data>/claude-cwd. */
  data: string;
  serverPid: number | null;
  selector: { from: string | null; only: string | null };
  /** Calls whose started marker was written (incremented before each request). */
  callsStarted: number;
  /** Set in `run`'s finally: the invocation ended through its own code (not killed). */
  endedAt?: number;
  /** Set with endedAt when no call was started: the explicit "no call" record (the reason the run ended before one). */
  refusedBeforeCall?: string;
  stoppedReason?: string | null;
  /** Same snapshot as the published judgment. Null for dry-mock or an unreadable ledger, absent in older records. */
  ledgerUsed?: LedgerView['used'] | null;
  exitCode?: number;
  /** The ledger carried a valid ALLOW_RATE_WARNING when the run started (결정 26; absent in records made before it). */
  rateWarningAllowed?: boolean;
  rateWarningApproval?: { approvedBy: string; reason: string; at: string } | null;
}
/**
 * The run `evaluate` judges: the last run of --out that started a call. A later run that ended before its first call
 * (a resume refused by the environment or ledger check, `--only` of a call not selected) is not it — its selector and
 * empty skips would otherwise set the selected counts and skip list of conditions 5 and 6. null → no run made a call.
 */
export function evaluateTarget(metas: readonly RunMeta[]): RunMeta | null {
  const sorted = [...metas].sort((p, q) => p.run - q.run);
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i]!.callsStarted > 0) return sorted[i]!;
  return null;
}
/** `calls/<id>.started.json`: written before the request of a call. */
export interface StartedMarker {
  id: string;
  run: number;
  requestId: string;
  startedAt: number;
}
/** The record files of the plan: `calls/<id>.json` (never `<id>.started.json` or an earlier run's `<id>.r<k>.json`). */
export const callRecordFile = (name: string): string | null => {
  const m = /^(.+)\.json$/.exec(name);
  return m && (CALL_IDS as readonly string[]).includes(m[1]!) ? m[1]! : null;
};
export const startedMarkerFile = (name: string): string | null => {
  const m = /^(.+)\.started\.json$/.exec(name);
  return m && (CALL_IDS as readonly string[]).includes(m[1]!) ? m[1]! : null;
};

export type PostCheckResult = 'pass' | 'fail' | 'no_call' | 'unverified';
export interface PostCheckVerdict {
  run: number | null;
  result: PostCheckResult;
  reason: string;
  /** Started markers of this run without a finished record. */
  unfinished: string[];
  /** Recorded children (pid + starttime) still alive. */
  alive: number[];
  /** Processes found in the process table whose working directory is <data>/claude-cwd (recorded or not). */
  leftover: number[];
}
/**
 * post-check after the server stopped. A child still alive (recorded, or found in the process table by its working
 * directory — independent of the records) fails. Otherwise "no call" only on the run's explicit record that it ended
 * before starting one; a run that did not end through its own code (killed), a started marker without a finished
 * record, or no run record at all leaves the child state unverified (not a pass).
 */
export function postCheckVerdict(meta: RunMeta | null, markers: readonly StartedMarker[], finished: ReadonlySet<string>, children: readonly { pid: number; alive: boolean }[], leftover: readonly number[]): PostCheckVerdict {
  const run = meta?.run ?? null;
  const unfinished = meta ? markers.filter((m) => m.run === meta.run && !finished.has(m.id)).map((m) => m.id) : [];
  const alive = children.filter((c) => c.alive).map((c) => c.pid);
  const v = (result: PostCheckResult, reason: string): PostCheckVerdict => ({ run, result, reason, unfinished, alive, leftover: [...leftover] });
  if (alive.length > 0 || leftover.length > 0) return v('fail', `a child of the server is still alive (recorded ${alive.length}, in <data>/claude-cwd ${leftover.length})`);
  if (!meta) return v('unverified', 'child state unverified: no run record in --out, so whether a call started is unknown');
  if (meta.endedAt === undefined) return v('unverified', `child state unverified: run ${meta.run} did not end through its own code (killed?) after ${meta.callsStarted} started call(s)`);
  if (unfinished.length > 0) return v('unverified', `child state unverified: started without a finished record: ${unfinished.join(' ')}`);
  if (meta.refusedBeforeCall !== undefined && meta.callsStarted === 0) return v('no_call', `run ${meta.run} made no call: ${meta.refusedBeforeCall}`);
  return v('pass', `run ${meta.run}: every started call has its record and no child is alive`);
}
/** Condition 8 from a post-check verdict: pass / fail; no call or unverified → not_evaluated (never a pass). */
export function cond8OfVerdict(v: PostCheckVerdict, children: number): Condition {
  if (v.result === 'pass' || v.result === 'fail') return { id: 8, name: 'no child process after the server stopped', result: v.result, evidence: { run: v.run, children, alive: v.alive, leftover: v.leftover } };
  return { id: 8, name: 'no child process after the server stopped', result: 'not_evaluated', evidence: { run: v.run, verdict: v.result, reason: v.reason, unfinished: v.unfinished } };
}
/** Child sightings of run n (one line per child, appended when first seen). */
export const childrenFile = (run: number): string => `children.${run}.jsonl`;
/** Argv samples of every run (one line per changed sample, with its run index). */
export const ARGV_SAMPLES_FILE = 'argv_samples.jsonl';
export interface ChildSeen {
  pid: number;
  starttime: number;
  firstCall: string;
}

// ------------------------------------------------------------------------------------------------------------------
// per-run evidence (INT-I10-01): nothing a run leaves in --out is overwritten by a later run

/** `live_e2e.<n>.json` (the judgement of run n as it ended; `live_e2e.json` stays the latest aggregate). */
export const liveE2eRunFile = (run: number): string => `live_e2e.${run}.json`;
/** `captures/<id>.<n>.png`: the PNG of screen call <id> in run n (never replaced by a later run's resend of the call). */
export const captureFile = (id: string, run: number): string => `captures/${id}.${run}.png`;
/** `post_check.<n>.json`: the first post-check of run n (a later re-check of the same run goes to another name). */
export const postCheckFile = (run: number): string => `post_check.${run}.json`;
export const POST_CHECK_RE = /^post_check\.([0-9]+)\.json$/;

type RunChildVerdict = PostCheckResult | 'no post-check' | 'no run record';
/** The child state of one run of --out from its first post-check (none → no_call on an explicit pre-call refusal). */
function runChildState(m: RunMeta, postChecks: ReadonlyMap<number, PostCheckResult>): { run: number; verdict: RunChildVerdict } {
  const pc = postChecks.get(m.run);
  const noCall = m.callsStarted === 0 && m.refusedBeforeCall !== undefined;
  return { run: m.run, verdict: pc ?? (noCall ? 'no_call' : 'no post-check') };
}
const blocksCond8 = (e: { verdict: RunChildVerdict }) => e.verdict !== 'pass' && e.verdict !== 'no_call';
/**
 * Runs of --out without a readable record (FIX4-R1-03), all blocking: an index in 1 … upTo with no run.<k>.json that
 * parsed (missing, or torn by a kill mid-write — whether it made a call is unknown), and post_check.0.json (a post-check
 * that found no run record at all). `exclude` is the run being judged.
 */
function runsWithoutRecord(upTo: number, metas: readonly RunMeta[], postChecks: ReadonlyMap<number, PostCheckResult>, exclude: number): { run: number; verdict: RunChildVerdict }[] {
  const have = new Set(metas.map((m) => m.run));
  const out: { run: number; verdict: RunChildVerdict }[] = [];
  const zero = postChecks.get(0);
  if (zero !== undefined) out.push({ run: 0, verdict: zero === 'pass' || zero === 'no_call' ? 'no run record' : zero });
  for (let k = 1; k <= upTo; k++) if (k !== exclude && !have.has(k)) out.push({ run: k, verdict: 'no run record' });
  return out;
}

/**
 * Condition 8 as run n judges it, over the earlier runs of the same --out: an earlier post-check that failed or left
 * the child state unverified — or an earlier run that started calls and has no post-check at all — keeps the result
 * `fail` (so the final exit is not 0), as does an earlier index without a readable run record and post_check.0.json
 * (runsWithoutRecord). Otherwise not_evaluated: run n's own children are judged by its post-check after the server
 * stops. An earlier run that explicitly made no call needs no post-check.
 */
export function cond8EarlierRuns(n: number, metas: readonly RunMeta[], postChecks: ReadonlyMap<number, PostCheckResult>): Condition {
  const name = 'no child process after the server stopped';
  const earlier = [...metas.filter((m) => m.run < n).map((m) => runChildState(m, postChecks)), ...runsWithoutRecord(n - 1, metas, postChecks, n)].sort((p, q) => p.run - q.run);
  const blocking = earlier.filter(blocksCond8);
  if (blocking.length > 0) return { id: 8, name, result: 'fail', evidence: { earlierRuns: earlier, blocking, reason: 'an earlier run of --out left a child alive or its child state unverified' } };
  return { id: 8, name, result: 'not_evaluated', evidence: { earlierRuns: earlier, reason: `run ${n} is judged by post-check after the server stops` } };
}

/**
 * Condition 8 as `evaluate` judges run n (FIX4-R1-01): after the fact, so run n's own post-check is part of it, next to
 * every other run of --out (earlier and later). Pass only when run n's own post-check passed and no other run blocks
 * (cond8EarlierRuns' rule). Run n's post-check fail or unverified, or no post-check of run n (it started calls) → fail,
 * so evaluate never turns a run whose children were not cleared into exit 0. `run` keeps cond8EarlierRuns: its own
 * post-check comes after it.
 */
export function cond8Evaluate(n: number, metas: readonly RunMeta[], postChecks: ReadonlyMap<number, PostCheckResult>, runFiles: readonly number[] = []): Condition {
  const name = 'no child process after the server stopped';
  const own = postChecks.get(n) ?? 'no post-check';
  const upTo = Math.max(n, ...metas.map((m) => m.run), ...runFiles, ...postChecks.keys());
  const otherRuns = [...metas.filter((m) => m.run !== n).map((m) => runChildState(m, postChecks)), ...runsWithoutRecord(upTo, metas, postChecks, n)].sort((p, q) => p.run - q.run);
  const blocking = [...otherRuns.filter(blocksCond8), ...(own === 'pass' ? [] : [{ run: n, verdict: own }])].sort((p, q) => p.run - q.run);
  if (blocking.length > 0) return { id: 8, name, result: 'fail', evidence: { run: n, postCheck: own, otherRuns, blocking, reason: own === 'pass' ? 'another run of --out left a child alive or its child state unverified' : `run ${n}'s own post-check is ${own} (not pass)` } };
  return { id: 8, name, result: 'pass', evidence: { run: n, postCheck: own, otherRuns } };
}
