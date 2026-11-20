// M3 acceptance budgets. This database is coordinator evidence, separate from the application schema.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { ModelAlias } from '@study-paper/shared/contracts/tasks';
import { initLiveLedger, readLiveLedger, stopLiveLedger, type LiveCaps } from '../llm/liveLedger';
import { realDataDirPrefixOf } from './realDataDir';

type Env = Record<string, string | undefined>;
export const CAMPAIGN_ID = 'sunlight-m3';
export const CLI_CAPS = {
  poc: { total: 22, perModel: { haiku: 0, opus: 0, sonnet: 22, fable: 0 } },
  final: { total: 23, perModel: { haiku: 3, opus: 11, sonnet: 9, fable: 0 } },
} as const satisfies Record<string, LiveCaps>;
const HTTP_CAPS = {
  spike: { arxiv: 0, crossref: 4, openalex: 4, s2: 2 },
  record: { arxiv: 4, crossref: 8, openalex: 10, s2: 6 },
  final: { arxiv: 18, crossref: 3, openalex: 4, s2: 2 },
} as const;
const providers = new Map<string, keyof typeof HTTP_CAPS.final>([
  ['arxiv.org', 'arxiv'], ['export.arxiv.org', 'arxiv'], ['api.crossref.org', 'crossref'],
  ['api.openalex.org', 'openalex'], ['api.semanticscholar.org', 's2'],
]);
const phases = ['poc', 'final'] as const;
type CliPhase = typeof phases[number];
const pinsSchema = z.strictObject({ haiku: z.string(), opus: z.string(), sonnet: z.string() });
export type ModelPins = z.infer<typeof pinsSchema>;
const dbName = 'm3-campaign.sqlite';

/** CLI results may use the dated variant of the requested pin. Bare aliases are not resolved IDs. */
export function isApprovedFamily(value: unknown, alias: ModelAlias): boolean {
  if (typeof value !== 'string' || value.length > 96 || !['haiku', 'opus', 'sonnet'].includes(alias)) return false;
  return new RegExp('^claude-(?:' + alias + '-[0-9]+(?:[.-][0-9]+)*|[0-9]+(?:[.-][0-9]+)*-' + alias + '(?:-[0-9]{8})?)$').test(value);
}

function modelPins(value: unknown): ModelPins {
  const pins = pinsSchema.parse(value);
  for (const alias of ['haiku', 'opus', 'sonnet'] as const) {
    if (!isApprovedFamily(pins[alias], alias)) throw new Error('campaign model pin must be a versioned ID of the requested family');
  }
  return pins;
}

function campaignRoot(dir: string): string {
  if (!dir.trim() || realDataDirPrefixOf(dir, process.env)) throw new Error('campaign must use a scratch directory');
  return resolve(dir);
}

function seal(root: string, pins: ModelPins): string {
  return JSON.stringify({ id: CAMPAIGN_ID, root, pins, cli: CLI_CAPS, http: HTTP_CAPS });
}

// The coordinator keeps one parent for this campaign. Its registration survives moving the ledger tree.
const registrationFile = (root: string) => join(dirname(root), '.' + CAMPAIGN_ID + '.registration');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function recordedDigest(file: string): string {
  const st = lstatSync(file);
  if (!st.isFile() || st.size !== 64) throw new Error('invalid campaign registration or ready file');
  return readFileSync(file, 'utf8');
}

/** Interrupted initialization or a missing, moved or replaced ledger must never replenish a budget. */
export function initCampaign(dir: string, input: unknown): void {
  const root = campaignRoot(dir);
  const pins = modelPins(input);
  const registered = registrationFile(root);
  if (realpathSync(dirname(root)) !== dirname(root) || registered === root) throw new Error('invalid campaign path');
  if (existsSync(root) && !existsSync(registered)) throw new Error('existing campaign directory is not registered');
  try {
    writeFileSync(registered, digest(seal(root, pins)), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (recordedDigest(registered) !== digest(seal(root, pins))) throw new Error('campaign root or pins differ from registration');
    const existing = readCampaign(root);
    if (existing.stopped !== null) throw new Error('campaign is stopped');
    return;
  }
  mkdirSync(root, { mode: 0o700 });
  const db = new Database(join(root, dbName));
  try {
    db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), seal TEXT NOT NULL); CREATE TABLE attempts (phase TEXT NOT NULL, provider TEXT NOT NULL)');
    db.prepare('INSERT INTO settings VALUES (1, ?)').run(seal(root, pins));
    for (const phase of phases) {
      const ledger = join(root, phase);
      initLiveLedger(ledger, CLI_CAPS[phase]);
      writeFileSync(join(ledger, 'm3-stage'), CAMPAIGN_ID + '/' + phase, { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(join(root, 'ready'), digest(seal(root, pins)), { flag: 'wx', mode: 0o600 });
  } finally { db.close(); }
}

function withCampaign<T>(dir: string, readonly: boolean, run: (db: Database.Database, pins: ModelPins, root: string) => T): T {
  const root = campaignRoot(dir);
  if (realpathSync(root) !== root || !lstatSync(join(root, dbName)).isFile()) throw new Error('invalid campaign directory');
  const db = new Database(join(root, dbName), { readonly, fileMustExist: true, timeout: 2000 });
  try {
    const row = db.prepare('SELECT seal FROM settings WHERE id=1').get() as { seal: string } | undefined;
    if (!row) throw new Error('campaign seal missing');
    const pins = modelPins(JSON.parse(row.seal).pins);
    const expected = digest(seal(root, pins));
    if (row.seal !== seal(root, pins) || recordedDigest(registrationFile(root)) !== expected || recordedDigest(join(root, 'ready')) !== expected) throw new Error('invalid campaign seal');
    return run(db, pins, root);
  } finally { db.close(); }
}

function inspectCli(root: string, phase: CliPhase) {
  const ledger = join(root, phase);
  if (realpathSync(ledger) !== ledger || readFileSync(join(ledger, 'm3-stage'), 'utf8') !== CAMPAIGN_ID + '/' + phase) throw new Error('campaign stage mismatch');
  return readLiveLedger(ledger, CLI_CAPS[phase]);
}

export function readCampaign(dir: string) {
  return withCampaign(dir, true, (db, pins, root) => {
    const poc = inspectCli(root, 'poc');
    const final = inspectCli(root, 'final');
    const http = db.prepare('SELECT phase, provider, count(*) AS used FROM attempts GROUP BY phase, provider ORDER BY phase, provider').all() as { phase: string; provider: string; used: number }[];
    return { id: CAMPAIGN_ID, pins, poc, final, http, stopped: poc.stopRequested ?? poc.stopped ?? final.stopRequested ?? final.stopped };
  });
}

export function checkCampaignPhase(root: string, phase: string | undefined, ledger: string | undefined) {
  if (phase !== 'poc' && phase !== 'spike' && phase !== 'record' && phase !== 'final') {
    throw new Error('unknown campaign phase');
  }
  if (ledger !== undefined && ((phase !== 'poc' && phase !== 'final') || !ledger || resolve(ledger) !== join(root, phase))) {
    throw new Error('campaign phase and CLI ledger differ');
  }
  return phase;
}

function campaignEnv(env: Env) {
  if (env.SP_M3_CAMPAIGN === undefined && env.SP_M3_PHASE === undefined) {
    if (env.SP_LIVE_LEDGER && existsSync(join(env.SP_LIVE_LEDGER, 'm3-stage'))) throw new Error('marked M3 ledger requires its campaign and phase');
    return null;
  }
  if (!env.SP_M3_CAMPAIGN || !env.SP_M3_PHASE) throw new Error('campaign and phase are both required');
  const root = campaignRoot(env.SP_M3_CAMPAIGN);
  return { root, phase: checkCampaignPhase(root, env.SP_M3_PHASE, env.SP_LIVE_LEDGER) };
}

export function campaignModel(env: Env, alias: ModelAlias) {
  const c = campaignEnv(env);
  if (!c) return null;
  if (c.phase !== 'poc' && c.phase !== 'final') throw new Error('no CLI budget for this phase');
  const dir = join(c.root, c.phase);
  if (!env.SP_LIVE_LEDGER) throw new Error('M3 CLI ledger required');
  const state = readCampaign(c.root);
  if (!Object.hasOwn(state.pins, alias) || alias === 'fable') {
    stopLiveLedger(dir, 'unapproved_model');
    throw new Error('unapproved campaign model');
  }
  if (state.stopped !== null || !CLI_CAPS[c.phase].perModel[alias]) throw new Error('campaign stopped or model not budgeted');
  return { dir, id: state.pins[alias], caps: CLI_CAPS[c.phase] };
}

/** One IMMEDIATE SQLite transaction consumes one cell. Disjoint cells sum to both the host and stage caps. */
export function reserveCampaignHttp(env: Env, input: string): boolean {
  const c = campaignEnv(env);
  if (!c) return false;
  const phase = c.phase;
  if (phase !== 'spike' && phase !== 'record' && phase !== 'final') throw new Error('no HTTP budget for this phase');
  const url = new URL(input);
  const provider = providers.get(url.hostname);
  if (!provider || url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('unapproved campaign host');
  withCampaign(c.root, false, (db, _pins, root) => {
    for (const p of phases) {
      const ledger = inspectCli(root, p);
      if (ledger.stopRequested !== null || ledger.stopped !== null) throw new Error('campaign stopped');
    }
    const cap = HTTP_CAPS[phase][provider];
    db.transaction(() => {
      const result = db.prepare('INSERT INTO attempts (phase,provider) SELECT ?,? WHERE (SELECT count(*) FROM attempts WHERE phase=? AND provider=?) < ?').run(phase, provider, phase, provider, cap);
      if (result.changes !== 1) throw new Error('campaign HTTP cap reached');
    }).immediate();
  });
  return true;
}

/** Empty --setting-sources disables user/project/local settings. Linux managed policy still applies. */
export function checkManagedModelSettings(directory = '/etc/claude-code'): void {
  const readIfPresent = (path: string) => {
    try {
      if (statSync(path).size > 1_048_576) throw new Error('managed settings exceed the inspection limit');
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const schema = z.object({ model: z.unknown().optional(), env: z.record(z.string(), z.unknown()).optional() });
      const settings = schema.parse(value);
      if (Object.hasOwn(settings, 'model') || Object.keys(settings.env ?? {}).some((key) =>
        key === 'ANTHROPIC_MODEL' || /^ANTHROPIC_DEFAULT_.*_MODEL$/.test(key) || key === 'ANTHROPIC_BASE_URL' ||
        key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN' || key.startsWith('CLAUDE_CODE_USE_'))) {
        throw new Error('managed model or billing override');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('managed CLI settings could not be approved');
    }
  };
  readIfPresent(join(directory, 'managed-settings.json'));
  const fragments = join(directory, 'managed-settings.d');
  let names: string[];
  try { names = readdirSync(fragments); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('managed CLI settings could not be inspected');
  }
  if (names.length > 128) throw new Error('too many managed settings fragments');
  for (const name of names) if (name.endsWith('.json')) readIfPresent(join(fragments, name));
}
