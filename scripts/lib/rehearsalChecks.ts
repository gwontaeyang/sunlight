// Pure checks of the real-data rehearsal (PLAN_M2 7절 5, 3.1 보존 검증; BRIEF_INTEGRATION I7). Owner: supervisor.
// Inputs are DB rows already read by scripts/rehearsal.ts; outputs carry column names, ids, counts and statuses only —
// never message, thread or highlight text.

/**
 * PLAN_M2 D4: the `papers` columns an upgrade may change. codeUrl only when it was NULL before; ingestWarningsJson only by
 * appending. Every other column of the pre-migration row must stay equal.
 */
export const UPGRADE_FREE_COLUMNS = ['supplementSha256', 'supplementVersion', 'structureSource', 'updatedAt'] as const;

export interface PaperRowDiff {
  ok: boolean;
  /** Columns whose value changed (names only). */
  changed: string[];
  /** Changed columns outside the D4 rule (names + the rule broken). */
  violations: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function warningsArray(v: unknown): string[] | null {
  if (typeof v !== 'string') return null;
  try {
    const a = JSON.parse(v) as unknown;
    return Array.isArray(a) && a.every((x) => typeof x === 'string') ? (a as string[]) : null;
  } catch {
    return null;
  }
}

/** Compares a paper row before / after the structure upgrade over the BEFORE row's columns (D4 rule). */
export function diffPaperRow(before: Record<string, unknown>, after: Record<string, unknown>): PaperRowDiff {
  const changed: string[] = [];
  const violations: string[] = [];
  for (const col of Object.keys(before)) {
    if (!(col in after)) {
      violations.push(`${col}: column missing after`);
      continue;
    }
    if (same(before[col], after[col])) continue;
    changed.push(col);
    if ((UPGRADE_FREE_COLUMNS as readonly string[]).includes(col)) continue;
    if (col === 'codeUrl') {
      if (before[col] !== null) violations.push('codeUrl: changed although it was set before');
      continue;
    }
    if (col === 'ingestWarningsJson') {
      const a = warningsArray(before[col]);
      const b = warningsArray(after[col]);
      if (!a || !b || b.length < a.length || !a.every((w, i) => b[i] === w)) violations.push('ingestWarningsJson: not an append to the earlier list');
      continue;
    }
    violations.push(`${col}: not an upgrade column (D4)`);
  }
  return { ok: violations.length === 0, changed, violations };
}

export interface StatsPremise {
  /** Messages with a statsJson value. */
  messagesWithStats: number;
  /** Messages whose statsJson has an eqRefs object. */
  withEqRefs: number;
  /** Sum over all messages of eqRefs.resolved + eqRefs.noAnchor (must be 0 — PLAN_M2 3.4 rule 2). */
  resolvedPlusNoAnchor: number;
  /** Message ids where that sum is > 0, or whose statsJson is not parseable JSON. */
  violatingMessageIds: string[];
  unparseableMessageIds: string[];
  holds: boolean;
  /** eqRefs fields summed over all messages (counts only). */
  eqRefTotals: Record<string, number>;
}

/** PLAN_M2 3.4 rule 2 premise: before migration every stored message has eqRefs.resolved + eqRefs.noAnchor = 0. */
export function statsPremise(rows: readonly { id: string; statsJson: string | null }[]): StatsPremise {
  const out: StatsPremise = { messagesWithStats: 0, withEqRefs: 0, resolvedPlusNoAnchor: 0, violatingMessageIds: [], unparseableMessageIds: [], holds: true, eqRefTotals: {} };
  for (const r of rows) {
    if (r.statsJson === null) continue;
    out.messagesWithStats++;
    let s: unknown;
    try {
      s = JSON.parse(r.statsJson);
    } catch {
      out.unparseableMessageIds.push(r.id);
      continue;
    }
    const eq = (s as { eqRefs?: unknown } | null)?.eqRefs;
    if (eq === undefined || eq === null || typeof eq !== 'object') continue;
    out.withEqRefs++;
    const e = eq as Record<string, unknown>;
    for (const [k, v] of Object.entries(e)) if (typeof v === 'number') out.eqRefTotals[k] = (out.eqRefTotals[k] ?? 0) + v;
    const n = (typeof e.resolved === 'number' ? e.resolved : 0) + (typeof e.noAnchor === 'number' ? e.noAnchor : 0);
    out.resolvedPlusNoAnchor += n;
    if (n > 0) out.violatingMessageIds.push(r.id);
  }
  out.holds = out.violatingMessageIds.length === 0 && out.unparseableMessageIds.length === 0;
  return out;
}

export interface EquationCitationStatus {
  /** status → count of citations.kind = 'equation'. */
  byStatus: Record<string, number>;
  total: number;
  /** not_found: the count and the owner message ids (a report item, not a failure — PLAN_M2 7절 5). */
  notFound: { count: number; messageIds: string[] };
}

export function equationCitationStatus(rows: readonly { status: string; ownerType: string; ownerId: string }[]): EquationCitationStatus {
  const byStatus: Record<string, number> = {};
  const ids = new Set<string>();
  let nf = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === 'not_found') {
      nf++;
      if (r.ownerType === 'message') ids.add(r.ownerId);
    }
  }
  return { byStatus, total: rows.length, notFound: { count: nf, messageIds: [...ids].sort() } };
}

/** A job SSE stream: exactly one terminal (job.done | job.error), and it is the last event. */
export function jobStreamShape(names: readonly string[]): { ok: boolean; terminal: string | null; problem: string | null } {
  const terminals = names.filter((n) => n === 'job.done' || n === 'job.error');
  if (terminals.length !== 1) return { ok: false, terminal: terminals[0] ?? null, problem: `${terminals.length} terminal events` };
  if (names[names.length - 1] !== terminals[0]) return { ok: false, terminal: terminals[0]!, problem: 'events after the terminal' };
  return { ok: true, terminal: terminals[0]!, problem: null };
}

/** A run SSE stream: first run.accepted, exactly one terminal (run.done | run.error), last. */
export function runStreamShape(names: readonly string[]): { ok: boolean; terminal: string | null; problem: string | null } {
  if (names[0] !== 'run.accepted') return { ok: false, terminal: null, problem: 'first event is not run.accepted' };
  const terminals = names.filter((n) => n === 'run.done' || n === 'run.error');
  if (terminals.length !== 1) return { ok: false, terminal: terminals[0] ?? null, problem: `${terminals.length} terminal events` };
  if (names[names.length - 1] !== terminals[0]) return { ok: false, terminal: terminals[0]!, problem: 'events after the terminal' };
  return { ok: true, terminal: terminals[0]!, problem: null };
}

/** `sha256sum` listing (`<hex>  <path>` lines) → path → hex. */
export function parseShaListing(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const r = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!r) throw new Error(`not a sha256sum line: ${line.slice(0, 80)}`);
    m.set(r[2]!, r[1]!);
  }
  return m;
}

/** Two listings: files only in one, files whose hash differs (paths only). */
export function diffShaListings(a: Map<string, string>, b: Map<string, string>): { equal: boolean; onlyBefore: string[]; onlyAfter: string[]; changed: string[] } {
  const onlyBefore = [...a.keys()].filter((k) => !b.has(k)).sort();
  const onlyAfter = [...b.keys()].filter((k) => !a.has(k)).sort();
  const changed = [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k)).sort();
  return { equal: onlyBefore.length === 0 && onlyAfter.length === 0 && changed.length === 0, onlyBefore, onlyAfter, changed };
}

// ---------------------------------------------------------------------------------------------------------- server logs

/** What a rehearsal server's log says (the `listening on` line, migrations, the lines a check counts). */
export interface ServerLogFacts {
  /** `listening on …` lines (a server that started once has exactly one). */
  listeningLines: number;
  /** The first `listening on …` line from `listening on` on, or null. */
  listening: string | null;
  env: string | null;
  llm: string | null;
  /** null when the line has no `network=` field (an m1 server). */
  network: string | null;
  data: string | null;
  /** Migration tags of `migrations applied:` lines. */
  migrations: string[];
  /** `migrations applied: … (backup …)` lines. */
  backupLines: number;
  /** Lines with `[ingest]` — m2 and m1 log under this prefix only when a job's terminal write fails (pipeline.ts). */
  ingestLines: number;
  /** Lines that look like a failure or a recovery: /error|fail|exception|recovery/i (SqliteError, TypeError, ERROR …). */
  errorLikeLines: number;
  /** `network=on` anywhere in the log. */
  networkOn: boolean;
}

export function parseServerLog(text: string): ServerLogFacts {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const listeningAll = lines.filter((l) => l.includes('listening on http://'));
  const listening = listeningAll[0] ?? null;
  const field = (k: string) => (listening ? (new RegExp(`[(, ]${k}=([^,)]+)`).exec(listening)?.[1] ?? null) : null);
  const migrations = lines
    .filter((l) => l.includes('migrations applied:'))
    .flatMap((l) => l.replace(/^.*migrations applied: /, '').replace(/ \(backup .*$/, '').split(', '));
  return {
    listeningLines: listeningAll.length,
    listening: listening ? listening.replace(/^.*(listening on .*)$/, '$1') : null,
    env: field('env'),
    llm: field('llm'),
    network: field('network'),
    data: field('data'),
    migrations,
    backupLines: lines.filter((l) => /migrations applied: .*\(backup /.test(l)).length,
    ingestLines: lines.filter((l) => l.includes('[ingest]')).length,
    errorLikeLines: lines.filter((l) => /error|fail|exception|recovery/i.test(l)).length,
    networkOn: /network=on/.test(text),
  };
}

export interface ServerLogWant {
  env: 'dev';
  llm: 'mock';
  /** 'off' for an m2 server; null for an m1 server (its line has no network field, m1 has no network guard). */
  network: 'off' | null;
  /** The data directory the server must run on (an absolute path). */
  data: string;
  /** Migrations the start must have applied (m2 on an M1 copy: ['0002_m2']; m1 on a restored copy: []). */
  migrations: readonly string[];
  /** A `(backup …)` part on the migrations line (required when migrations is not empty). */
  backup: boolean;
}

/**
 * The precondition of every rehearsal command that talks to a server (BRIEF_INTEGRATION I7-1 "listening on 줄을 확인하고
 * 진행 — 다르면 즉시 종료"): returns the violations; the caller sends no request unless it is empty.
 */
export function serverLogPrecondition(f: ServerLogFacts, want: ServerLogWant): string[] {
  const v: string[] = [];
  if (f.listeningLines !== 1) v.push(`listening lines ${f.listeningLines} (want 1)`);
  if (f.env !== want.env) v.push(`env=${String(f.env)} (want ${want.env})`);
  if (f.llm !== want.llm) v.push(`llm=${String(f.llm)} (want ${want.llm})`);
  if (f.network !== want.network) v.push(`network=${String(f.network)} (want ${want.network === null ? 'no network field (m1)' : want.network})`);
  if (f.networkOn) v.push('network=on in the log');
  if (f.data !== want.data) v.push(`data=${String(f.data)} (want ${want.data})`);
  if (JSON.stringify(f.migrations) !== JSON.stringify(want.migrations)) v.push(`migrations applied ${JSON.stringify(f.migrations)} (want ${JSON.stringify(want.migrations)})`);
  if (want.backup && f.backupLines !== 1) v.push(`migration backup lines ${f.backupLines} (want 1)`);
  return v;
}

/**
 * The m1-ref server's whole log, judged by an allow-list: the one `listening on` line (dev · mock · loopback) and the
 * signal shutdown line. Anything else — a migration, startup recovery, `[ingest]`, `[server]`, `[llm]`, a drain report
 * (work was still running), a stack trace — is unexpected. Only a short tag of each unexpected line is returned (never
 * the rest of it).
 */
export const M1_LOG_ALLOWED: readonly RegExp[] = [
  /^\[study_paper\] listening on http:\/\/127\.0\.0\.1:\d+ \(env=dev, llm=mock, data=[^)]+\)$/,
  /^\[study_paper\] SIG(INT|TERM): shutting down$/,
];
export function unexpectedLogLines(text: string, allowed: readonly RegExp[]): { count: number; tags: string[] } {
  const bad = text.split('\n').filter((l) => l.length > 0 && !allowed.some((re) => re.test(l)));
  const tag = (l: string) => {
    const m = /^(\[[A-Za-z0-9_-]{1,30}\])?\s*([A-Za-z][A-Za-z ]{0,30})?/.exec(l);
    return [m?.[1], m?.[2]?.trim()].filter(Boolean).join(' ') || '(untagged)';
  };
  return { count: bad.length, tags: bad.map(tag) };
}

// ---------------------------------------------------------------------------------------------------------- restore aside

export interface RehearsalCheck {
  id: string;
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
}
export interface RestoreAsideInput {
  /** Exit code of `data-snapshot.ts restore` (the shell records it). */
  restoreExit: number;
  /** Its stdout / --report JSON (null when missing or not JSON). */
  restore: { ok?: unknown; exitCode?: unknown; data?: unknown; snapshot?: unknown; aside?: unknown; staging?: unknown } | null;
  /** Absolute --data and --snapshot of the restore. */
  data: string;
  snapshot: string;
  /** mutate.json: what the m2 server changed before the restore. */
  mutate: { addedPaperId?: unknown; keptPaperId?: unknown; deletedPaperId?: unknown; captureFileId?: unknown; capturePngSha256?: unknown };
  /** Names in the parent directory of `data` (after the restore). */
  siblings: readonly string[];
  fs: { isDir(p: string): boolean; isFile(p: string): boolean; sha256(p: string): string | null };
}

/**
 * BRIEF_INTEGRATION I7-3 3: restore exit 0, and `<data>-m2-aside-<epoch>/` keeps the M2 state of step 2 — the added
 * paper's directory and the capture PNG (same bytes as the request) — while the paper deleted under m2 is not there;
 * no staging directory is left.
 */
export function restoreAsideChecks(i: RestoreAsideInput): RehearsalCheck[] {
  const out: RehearsalCheck[] = [];
  const c = (id: string, pass: boolean, expected?: unknown, actual?: unknown) => out.push({ id, pass, ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) });
  const r = i.restore;
  c('restore: exit 0 · ok · exitCode 0', i.restoreExit === 0 && !!r && r.ok === true && r.exitCode === 0, { exit: 0, ok: true }, { exit: i.restoreExit, ok: r?.ok ?? null, exitCode: r?.exitCode ?? null });
  c('restore: --data and --snapshot are the rb copy and rb/pre-m2', !!r && r.data === i.data && r.snapshot === i.snapshot, { data: i.data, snapshot: i.snapshot }, { data: r?.data ?? null, snapshot: r?.snapshot ?? null });
  const parent = i.data.slice(0, i.data.lastIndexOf('/'));
  const base = i.data.slice(i.data.lastIndexOf('/') + 1);
  const aside = typeof r?.aside === 'string' ? r.aside : null;
  const asideName = aside && aside.startsWith(`${parent}/`) ? aside.slice(parent.length + 1) : null;
  const prefix = `${base}-m2-aside-`;
  const asideOk = !!asideName && asideName.startsWith(prefix) && /^\d+$/.test(asideName.slice(prefix.length)) && i.siblings.includes(asideName) && i.fs.isDir(aside!);
  c('aside: <data>-m2-aside-<epoch> next to the data directory, exists', asideOk, `${parent}/${base}-m2-aside-<epoch>`, aside);
  const m = i.mutate;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const added = str(m.addedPaperId);
  const kept = str(m.keptPaperId);
  const deleted = str(m.deletedPaperId);
  const capture = str(m.captureFileId);
  const pngSha = str(m.capturePngSha256);
  c('mutate.json names the added, kept and deleted papers and the capture', !!(added && kept && deleted && capture && pngSha));
  if (asideOk) {
    c('aside: db/study_paper.sqlite (the M2 DB) is there', i.fs.isFile(`${aside}/db/study_paper.sqlite`));
    c('aside: papers/<added paper>/ is there', !!added && i.fs.isDir(`${aside}/papers/${added}`), added);
    const capPath = kept && capture ? `${aside}/papers/${kept}/captures/${capture}.png` : null;
    const capSha = capPath && i.fs.isFile(capPath) ? i.fs.sha256(capPath) : null;
    c('aside: papers/<kept paper>/captures/<capture>.png is there with the request PNG bytes', !!pngSha && capSha === pngSha, pngSha, capSha);
    c('aside: papers/<deleted paper>/ is not there (deleted under m2)', !!deleted && !i.fs.isDir(`${aside}/papers/${deleted}`), false, deleted ? i.fs.isDir(`${aside}/papers/${deleted}`) : null);
  }
  const staging = i.siblings.filter((n) => n.startsWith(`${base}.restore-`));
  c('no <data>.restore-* staging left', staging.length === 0 && !(typeof r?.staging === 'string' && i.fs.isDir(r.staging)), [], staging);
  return out;
}
