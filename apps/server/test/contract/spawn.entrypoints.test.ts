// Child-process entry points (BRIEF_S S6b v3.4). Owner: supervisor. A new spawn path would bypass the live ledger;
// this test finds it mechanically and pins the three S edits in claudeCli.ts.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/proc';
import { sourceFiles, stripComments } from '../helpers/sourceScan';

const CHILD_PROCESS = /['"](node:)?child_process['"]/;

describe('spawn entry points', () => {
  it('only llm/claudeCli.ts, security/winAcl.ts and scripts/doctor.ts import child_process (apps/server/src, scripts)', () => {
    const importers: string[] = [];
    for (const root of ['apps/server/src', 'scripts']) {
      for (const f of sourceFiles(join(REPO_ROOT, root))) if (CHILD_PROCESS.test(stripComments(readFileSync(f, 'utf8')))) importers.push(relative(REPO_ROOT, f));
    }
    // winAcl.ts is the win32-only ACL hardening (icacls); it is NOT a model child (those stay in claudeCli.ts) — the
    // next test pins that.
    expect(importers.sort()).toEqual(['apps/server/src/llm/claudeCli.ts', 'apps/server/src/security/winAcl.ts', 'scripts/doctor.ts']);
  });

  it('security/winAcl.ts spawns only icacls, via spawnSync, guarded by a win32 platform check (no model child)', () => {
    const code = stripComments(readFileSync(join(REPO_ROOT, 'apps/server/src/security/winAcl.ts'), 'utf8'));
    expect(code).toEqual(expect.stringContaining("import { spawnSync } from 'node:child_process';"));
    expect(code.match(/child_process/g)?.length).toBe(1);
    // exactly one spawnSync, of icacls; no other child_process function, free or through a member
    expect(code.match(/(^|[^A-Za-z0-9_$.])spawnSync\(/gm)?.length).toBe(1);
    expect(code).toMatch(/spawnSync\(\s*'icacls'/);
    expect(code.match(/(^|[^A-Za-z0-9_$.])(spawn|exec|execSync|execFile|execFileSync|fork)\s*\(/gm)).toBeNull();
    expect(code.match(/\.\s*(spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(/g)).toBeNull();
    // the spawn is unreachable off win32: an early return before icacls
    expect(code).toMatch(/platform !== 'win32'\) return \{ applied: false/);
  });

  it('the two importers take exactly these names (no namespace import, no require, no second import of child_process)', () => {
    const imports = (rel: string) => {
      const code = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      return { mentions: code.match(/child_process/g)?.length ?? 0, statements: code.match(/^import [^;]*from ['"](node:)?child_process['"];?$/gm) ?? [] };
    };
    expect(imports('apps/server/src/llm/claudeCli.ts')).toEqual({ mentions: 1, statements: ["import { execFile, spawn, type ChildProcess } from 'node:child_process';"] });
    expect(imports('scripts/doctor.ts')).toEqual({ mentions: 1, statements: ["import { execFileSync } from 'node:child_process';"] });
  });

  it('claudeCli.ts: one spawn( inside the guardLiveRun callback, one execFile( (health), watchLiveRun in run(), a rate_limit event in the rate_limit_event branch', () => {
    const code = stripComments(readFileSync(join(REPO_ROOT, 'apps/server/src/llm/claudeCli.ts'), 'utf8'));
    expect(code.match(/(^|[^A-Za-z0-9_$.])spawn\(/gm)?.length).toBe(1);
    expect(code).toMatch(/guardLiveRun\([^;]*\(\) => spawn\(/);
    expect(code.match(/execFile\(/g)?.length).toBe(1);
    // no other child_process function called directly, nor one called through a member (cp.spawn(, x.fork( …;
    // `.exec(` is left out of the member form: it is RegExp.prototype.exec, and a namespace import is refused above)
    expect(code.match(/(^|[^A-Za-z0-9_$.])(spawnSync|execSync|execFileSync|exec|fork)\s*\(/gm)).toBeNull();
    expect(code.match(/\.\s*(spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(/g)).toBeNull();
    expect(code).toMatch(/health\(\)[^{]*\{[\s\S]{0,200}execFile\(this\.opts\.claudeBin, \['--version'\]/);
    expect(code).toMatch(/run\(req: LlmRunRequest\): AsyncIterable<LlmEvent> \{\s*return watchLiveRun\(runChild\(/);
    expect(code).toMatch(/if \(type === 'rate_limit_event'\) \{\s*rateLimit = rateLimitFromEvent\(e\);\s*ch\.push\(\{ type: 'rate_limit', rateLimit \}\)/);
  });
});
