// Fails when an installed dependency's license is outside the allowlist (PLAN 9.2-3, appendix B).
// This covers installed packages only; code copied into the repo must be MIT/BSD/Apache (THIRD_PARTY_NOTICES.md).
// Usage: npm run check:licenses
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'Python-2.0']);
const EXCEPTIONS_FILE = join(process.cwd(), 'scripts', 'license-exceptions.json');
/** An exception counts only when a reviewer approved it (approved: true + who + when). */
type Exception = { name: string; version: string; license: string; reason: string; approved?: boolean; approvedBy?: string; approvedOn?: string };
const exceptions: Exception[] = existsSync(EXCEPTIONS_FILE) ? JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8')) : [];

type Pkg = { name: string; version: string; license: string; path: string };
const seen = new Map<string, Pkg>();

function licenseOf(pj: Record<string, unknown>): string {
  const l = pj.license as unknown;
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object' && 'type' in l) return String((l as { type: string }).type);
  const ls = pj.licenses as unknown;
  if (Array.isArray(ls)) return ls.map((x) => (typeof x === 'string' ? x : x?.type)).join(' OR ');
  return 'UNKNOWN';
}

function scan(nodeModules: string) {
  if (!existsSync(nodeModules)) return;
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(nodeModules, entry.name);
    if (entry.name.startsWith('@')) {
      for (const sub of readdirSync(full, { withFileTypes: true })) visit(join(full, sub.name));
    } else visit(full);
  }
}
function visit(dir: string) {
  const pjPath = join(dir, 'package.json');
  if (!existsSync(pjPath)) return;
  const pj = JSON.parse(readFileSync(pjPath, 'utf8')) as Record<string, unknown>;
  const name = String(pj.name ?? dir);
  if (name.startsWith('@study-paper/')) return; // our own workspaces (symlinks)
  const key = `${name}@${pj.version}`;
  if (!seen.has(key)) seen.set(key, { name, version: String(pj.version), license: licenseOf(pj), path: dir });
  scan(join(dir, 'node_modules'));
}

/** Evaluates a simple SPDX expression: OR = any allowed, AND = all allowed. */
export function isAllowed(expr: string): boolean {
  const e = expr.trim().replace(/^\((.*)\)$/, '$1').trim();
  if (/\sOR\s/i.test(e)) return e.split(/\s+OR\s+/i).some(isAllowed);
  if (/\sAND\s/i.test(e)) return e.split(/\s+AND\s+/i).every(isAllowed);
  return ALLOWED.has(e.replace(/^\(|\)$/g, ''));
}

scan(join(process.cwd(), 'node_modules'));
for (const ws of ['packages/shared', 'apps/server', 'apps/web']) scan(join(process.cwd(), ws, 'node_modules'));

const bad: Pkg[] = [];
const pending: Pkg[] = [];
const excused: (Pkg & { reason: string; by: string })[] = [];
for (const p of seen.values()) {
  if (isAllowed(p.license)) continue;
  const ex = exceptions.find((x) => x.name === p.name && x.version === p.version && x.license === p.license);
  if (!ex) bad.push(p);
  else if (ex.approved === true && ex.approvedBy && ex.approvedOn) excused.push({ ...p, reason: ex.reason, by: `${ex.approvedBy} ${ex.approvedOn}` });
  else pending.push(p);
}
const unused = exceptions.filter((x) => ![...seen.values()].some((p) => p.name === x.name && p.version === x.version && p.license === x.license));
const counts = new Map<string, number>();
for (const p of seen.values()) counts.set(p.license, (counts.get(p.license) ?? 0) + 1);
console.log(`checked ${seen.size} packages: ${[...counts].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}=${n}`).join(', ')}`);
for (const p of excused) console.log(`approved exception (${p.by})  ${p.name}@${p.version}  ${p.license}  — ${p.reason}`);
for (const x of unused) console.error(`STALE EXCEPTION  ${x.name}@${x.version}  ${x.license}  (no installed package matches; remove it)`);
for (const p of pending) console.error(`EXCEPTION NOT APPROVED  ${p.name}@${p.version}  ${p.license}  (set approved/approvedBy/approvedOn after review)`);
for (const p of bad) console.error(`NOT ALLOWED  ${p.name}@${p.version}  ${p.license}  (${p.path})`);
if (bad.length || pending.length || unused.length) process.exit(1);
console.log('licenses ok');
