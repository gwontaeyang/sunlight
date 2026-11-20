// The one way to create the rate-limit warning approval (INTEGRATION_NOTES 결정 26 item 1, INT-WARNOK-R1-07). Owner:
// supervisor. <ledger>/ALLOW_RATE_WARNING lets a rate-limit warning through the live ledger; only `live-e2e.ts init
// --allow-rate-warning` may write it (the runbook side — the flag only when RATE_WARNING_OK=1 — is pinned in
// liveRateWarning.test.ts). This scan keeps a later script or server path from calling allowRateWarning or writing the
// file another way. Tests (apps/server/test) are not scanned: they write the file into synthetic ledgers.
// INT-WARNOK-R2-01: the identifier allowRateWarning is inventoried with the TypeScript AST in every scanned file (so a
// renamed import — `import { allowRateWarning as f }` — or a namespace call is a new entry), and the shell scripts are
// scanned too: a line that names ALLOW_RATE_WARNING may only print a refusal to stderr.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/proc';
import { sourceFiles, stripComments } from '../helpers/sourceScan';

const ROOTS = ['apps/server/src', 'apps/web/src', 'packages', 'scripts', 'e2e'];
const LEDGER = 'apps/server/src/llm/liveLedger.ts';
const LIVE_E2E = 'scripts/live-e2e.ts';

/** *.sh under the repository (no node_modules, .git or dist). */
function sourceFilesSh(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFilesSh(p));
    else if (e.name.endsWith('.sh')) out.push(p);
  }
  return out.sort();
}

function scan(): { rel: string; code: string }[] {
  const out: { rel: string; code: string }[] = [];
  for (const root of ROOTS) {
    for (const f of sourceFiles(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, f);
      if (rel.includes('/node_modules/') || rel.includes('/dist/')) continue;
      out.push({ rel, code: stripComments(readFileSync(f, 'utf8')) });
    }
  }
  return out;
}
const linesWith = (code: string, re: RegExp) => code.split('\n').filter((l) => re.test(l)).map((l) => l.trim());

/**
 * Every place the identifier (or a string equal to it) appears in `src`, by syntax: 'function' (its declaration),
 * 'import' / 'export' (a specifier, also `x as y` on either side), 'call' (`f(` or `ns.f(`), '<object>.prop' (a
 * property read that is not called), 'key' (an object literal key), 'signature' (an interface member), 'string',
 * 'other' (anything else: a shorthand `{ f }`, a binding, a variable, a parameter …).
 */
function identifierUses(src: string, fileName: string, name: string): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) && n.text === name) out.push('string');
    else if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent;
      let kind = 'other';
      if (ts.isFunctionDeclaration(p) && p.name === n) kind = 'function';
      else if (ts.isImportSpecifier(p)) kind = 'import';
      else if (ts.isExportSpecifier(p)) kind = 'export';
      else if (ts.isCallExpression(p) && p.expression === n) kind = 'call';
      else if (ts.isPropertyAccessExpression(p) && p.name === n) kind = ts.isCallExpression(p.parent) && p.parent.expression === p ? 'call' : `${p.expression.getText(sf)}.prop`;
      else if (ts.isPropertyAssignment(p) && p.name === n) kind = 'key';
      else if (ts.isPropertySignature(p) && p.name === n) kind = 'signature';
      out.push(kind);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('ALLOW_RATE_WARNING has one writer (결정 26)', () => {
  const files = scan();

  it('allowRateWarning is called only in scripts/live-e2e.ts cmdInit, once, behind --allow-rate-warning (every use of the name, by syntax)', () => {
    const uses: Record<string, string[]> = {};
    for (const { rel } of files) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      if (!src.includes('allowRateWarning')) continue;
      const u = identifierUses(src, rel, 'allowRateWarning');
      if (u.length) uses[rel] = u;
    }
    expect(uses).toEqual({
      [LEDGER]: ['function'],
      [LIVE_E2E]: ['import', 'key', 'a.prop', 'a.prop', 'call'], // import · LiveArgs { allowRateWarning: true } · a.allowRateWarning ×2 · the one call
      'scripts/lib/liveE2eChecks.ts': ['signature'], // LiveArgs.allowRateWarning?: true
    });
    const code = files.find((f) => f.rel === LIVE_E2E)!.code;
    expect(code).toMatch(/function cmdInit\(a: LiveArgs\): void \{[\s\S]*?if \(a\.allowRateWarning\) \{\s*try \{\s*approval = allowRateWarning\(dir, rateWarningApprovalOf\(a\.mode\)\);/);
  });

  it('the file name is spelled only in llm/liveLedger.ts (its constant), and only liveLedger.ts writes it — once, in allowRateWarning', () => {
    const spelled = files.filter((f) => /(['"`])ALLOW_RATE_WARNING\1/.test(f.code)).map((f) => f.rel);
    expect(spelled).toEqual([LEDGER]);
    const ledger = files.find((f) => f.rel === LEDGER)!.code;
    expect(linesWith(ledger, /(['"`])ALLOW_RATE_WARNING\1/)).toEqual(["export const RATE_WARNING_APPROVAL_FILE = 'ALLOW_RATE_WARNING';"]);
    const WRITE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|copyFile|cpSync|cp|renameSync|rename|linkSync|link|symlinkSync|symlink|openSync|open|createWriteStream)\s*\(/;
    expect(linesWith(ledger, /RATE_WARNING_APPROVAL_FILE/).filter((l) => WRITE.test(l))).toEqual(["writeFileSync(join(dir, RATE_WARNING_APPROVAL_FILE), JSON.stringify(parsed), { flag: 'wx', mode: 0o600 });"]);
    expect(ledger).toMatch(/export function allowRateWarning\([^)]*\): RateWarningApproval \{[\s\S]{0,300}writeFileSync\(join\(dir, RATE_WARNING_APPROVAL_FILE\)/);
    // elsewhere the constant is only read (live-e2e.ts: init refuses a ledger that has it without the flag)
    const users = files.filter((f) => f.rel !== LEDGER && /\bRATE_WARNING_APPROVAL_FILE\b/.test(f.code));
    expect(users.map((f) => f.rel)).toEqual([LIVE_E2E]);
    expect(linesWith(users[0]!.code, /\bRATE_WARNING_APPROVAL_FILE\b/).filter((l) => WRITE.test(l))).toEqual([]);
  });

  it('package commands and continued shell lines never call the approval writer or substitute a command in a marker refusal', () => {
    const pkg = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path, 'package.json'), 'utf8'));
    const root = pkg('.');
    const dirs = ['.', ...root.workspaces.flatMap((pattern: string) => {
      if (!pattern.endsWith('/*')) return [pattern];
      const parent = pattern.slice(0, -2);
      return readdirSync(join(REPO_ROOT, parent), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(parent, e.name));
    })];
    const commands: string[] = dirs.flatMap((dir) => Object.values<string>(pkg(dir).scripts ?? {}));
    for (const path of sourceFilesSh(REPO_ROOT)) {
      for (const line of readFileSync(path, 'utf8').replace(/\\\r?\n/g, '').split('\n')) {
        const code = line.trim().startsWith('#') ? '' : line.replace(/\s#\s.*$/, '').trim();
        commands.push(code);
      }
    }
    for (const command of commands) {
      expect(command).not.toMatch(/\ballowRateWarning\b/);
      if (command.includes('ALLOW_RATE_WARNING')) expect(command).not.toMatch(/\$\(|\x60/);
    }
  });

  it('shell scripts: a line that names ALLOW_RATE_WARNING only prints a refusal to stderr and exits 2 — no redirect, copy or other write (INT-WARNOK-R2-01)', () => {
    const sh = sourceFilesSh(REPO_ROOT).map((f) => relative(REPO_ROOT, f));
    expect(sh).toEqual(['scripts/live-runbook.sh']); // a new shell script is scanned here too: add it to this list
    const named: string[] = [];
    for (const rel of sh) {
      for (const line of readFileSync(join(REPO_ROOT, rel), 'utf8').split('\n')) {
        const code = line.trim().startsWith('#') ? '' : line.replace(/\s#\s.*$/, '').trim(); // drop comments
        if (code.includes('ALLOW_RATE_WARNING')) named.push(code);
      }
    }
    expect(named).toHaveLength(3); // damaged approval · RESUME mismatch · not RESUME with the approval and RATE_WARNING_OK=0
    for (const l of named) {
      expect(l).toMatch(/^if \[[^;]*\];? then echo "[^"]*" >&2; exit 2; fi$/);
      expect(l.replace(/ >&2;/, ';')).not.toMatch(/>|\b(tee|cp|mv|ln|touch|install|dd|rsync|printf|cat)\b/);
    }
  });
});
