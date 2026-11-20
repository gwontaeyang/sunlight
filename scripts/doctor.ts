// Environment check: Node, npm, better-sqlite3 (load + online backup), claude CLI.
// Usage: npm run doctor  (exit code 1 when any check fails)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/** = engines.node in package.json and .nvmrc (one exact version; .npmrc has engine-strict). */
const REQUIRED_NODE = `v${(JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node}`;
const REQUIRED_NPM_MAJOR = 10;
type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

add('node', process.version === REQUIRED_NODE, `${process.version} (required ${REQUIRED_NODE})`);

function npmVersion(): string | null {
  const ua = process.env.npm_config_user_agent ?? '';
  const m = /\bnpm\/(\d+\.\d+\.\d+)/.exec(ua);
  if (m) return m[1];
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
const npmV = npmVersion();
add('npm', !!npmV && Number(npmV.split('.')[0]) === REQUIRED_NPM_MAJOR, `${npmV ?? 'not found'} (required ${REQUIRED_NPM_MAJOR}.x)`);

const require = createRequire(join(process.cwd(), 'apps/server/package.json'));
const dir = mkdtempSync(join(tmpdir(), 'sp-doctor-'));
try {
  const Database = require('better-sqlite3');
  const db = new Database(join(dir, 'a.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec('create table t(x integer); insert into t values (42);');
  await db.backup(join(dir, 'b.sqlite'));
  db.close();
  const b = new Database(join(dir, 'b.sqlite'), { readonly: true });
  const row = b.prepare('select x from t').get() as { x: number } | undefined;
  const integrity = b.pragma('integrity_check', { simple: true });
  const version = (b.prepare('select sqlite_version() as v').get() as { v: string }).v;
  b.close();
  add('better-sqlite3', row?.x === 42 && integrity === 'ok', `load + backup() ok, sqlite ${version}`);
} catch (e) {
  add('better-sqlite3', false, String(e));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Verified platform. Dependency install scripts are disabled (.npmrc ignore-scripts): native packages must ship
// a prebuilt binary for the platform, which has only been checked here.
const platform = `${process.platform}-${process.arch}`;
add('platform', true, platform === 'linux-x64' ? `${platform} (verified)` : `${platform} — NOT verified: only linux-x64 (glibc) has been tested`);
for (const mod of ['lightningcss', 'esbuild']) {
  try {
    const m = createRequire(join(process.cwd(), 'package.json'))(mod) as { version?: string };
    add(mod, true, `native binding loads${m.version ? ` (${m.version})` : ''}`);
  } catch (e) {
    add(mod, false, `native binding failed to load: ${(e as Error).message.split('\n')[0]}`);
  }
}

const claudeBin = process.env.SP_CLAUDE_BIN ?? 'claude';
if (process.env.SP_LLM === 'mock') add('claude', true, 'optional in API or mock mode');
else try {
  const v = execFileSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  add('claude', /\d+\.\d+\.\d+/.test(v), v + ' (optional for API key users)');
} catch (e) {
  add('claude', true, 'optional for Anthropic API key users; install Claude Code for subscription mode');
}

for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(15)} ${c.detail}`);
if (checks.some((c) => !c.ok)) {
  console.error('doctor: some checks failed');
  process.exit(1);
}
