// Network entry points (BRIEF_S S5b, PLAN_M2 D23). Owner: supervisor. A new direct fetch / WebSocket / EventSource /
// http / http2 / https / dns / net / tls / dgram / undici use in apps/server/src or scripts would bypass the guard;
// this test finds it mechanically.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/proc';
import { fetchReferences, sourceFiles, stripComments } from '../helpers/sourceScan';

// The global fetch / WebSocket / EventSource are found with the TypeScript AST (fetchReferences: calls AND value
// references such as `const f = fetch`, `{ fetchImpl: fetch }`, `globalThis['fetch']`, `(globalThis as any).fetch`,
// `const g = globalThis; g.fetch`, `new WebSocket(u)`); the module names with these patterns (any quote, so
// `import(\`node:https\`)` and `require('tls')` count too).
const mod = (name: string) => new RegExp(`['"\`](node:)?${name}['"\`]`);
const PATTERNS: [string, RegExp][] = [
  ['node:http', mod('http')],
  ['node:https', mod('https')],
  ['node:http2', mod('http2')],
  ['node:dns', mod('dns(/promises)?')],
  ['node:net', mod('net')],
  ['node:tls', mod('tls')],
  ['node:dgram', mod('dgram')],
  ['undici', /undici/],
];
const ALLOWED = new Set(['apps/server/src/security/network.ts']);

describe('network entry points', () => {
  it('the global fetch (called or as a value) / WebSocket / EventSource / node:http(s|2) / node:dns / node:net / node:tls / node:dgram / undici appear only in security/network.ts', () => {
    const roots = [join(REPO_ROOT, 'apps/server/src'), join(REPO_ROOT, 'scripts')];
    const findings: string[] = [];
    let scanned = 0;
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const rel = relative(REPO_ROOT, file);
        scanned++;
        if (ALLOWED.has(rel)) continue;
        const src = readFileSync(file, 'utf8');
        for (const ref of fetchReferences(src, file)) findings.push(`${rel}:${ref}`);
        const code = stripComments(src);
        for (const [name, re] of PATTERNS) {
          code.split('\n').forEach((line, i) => {
            if (re.test(line)) findings.push(`${rel}:${i + 1}: ${name}: ${line.trim().slice(0, 120)}`);
          });
        }
      }
    }
    expect(scanned).toBeGreaterThan(30);
    expect(findings).toEqual([]);
  });

  it('safeFetch calls the network only through fetchImpl( and guards entry and every hop; defaultFetch uses guardedFetch', () => {
    const code = stripComments(readFileSync(join(REPO_ROOT, 'apps/server/src/ingest/safeFetch.ts'), 'utf8'));
    expect(code.match(/fetchImpl\(/g)?.length).toBe(1);
    expect(code).toMatch(/export async function safeFetch<T>\([^)]*\)[^{]*\{\s*guardNetwork\(url\)/);
    expect(code).toMatch(/guardNetwork\(target\.href\);[\s\S]{0,400}fetchImpl\(target\.href/);
    expect(code).toMatch(/export const defaultFetch[\s\S]{0,300}return guardedFetch\(input, init\)/);
    for (const s of ['scripts/fetch-fixtures.ts', 'scripts/smoke-ingest.ts']) expect(readFileSync(join(REPO_ROOT, s), 'utf8')).toMatch(/guardedFetch\(/);
  });

  it('the checks catch the forms they must catch', () => {
    const hit = (s: string) => fetchReferences(s).length > 0 || PATTERNS.some(([, re]) => re.test(stripComments(s)));
    const mustCatch = [
      'await fetch(url)',
      'globalThis.fetch(u)',
      'client.fetch(u)',
      // value references (a later direct call bypasses the guard; index.ts disableGlobalFetch cannot undo a copy)
      'const f = fetch',
      'safeFetch(u, { fetchImpl: fetch })',
      "const g = globalThis['fetch']",
      'const g = globalThis.fetch',
      'const h = window.fetch',
      "Reflect.get(globalThis, 'fetch')",
      'const { fetch } = globalThis',
      'const { fetch: f } = globalThis',
      'run({ fetch })',
      "import http from 'node:http'",
      "import https from 'https'",
      "import { lookup } from 'node:dns'",
      "import dns from 'dns/promises'",
      "import net from 'node:net'",
      "import { request } from 'undici'",
      // round 2: wrapped / aliased global objects, more node modules, other global network constructors
      'const f = (globalThis as any).fetch;',
      'const f = (<any>globalThis).fetch;',
      'const f = (globalThis!).fetch;',
      'const g = globalThis; const f = g.fetch; f(u);',
      'const g = globalThis as any; const h = g; h.fetch',
      'let g: any; g = window; g.fetch',
      "import http2 from 'node:http2'",
      "import { connect } from 'http2'",
      "import tls from 'node:tls'",
      "const tls = require('tls')",
      "import dgram from 'node:dgram'",
      'const m = await import(`node:https`)',
      "new WebSocket('wss://x')",
      'const W = WebSocket',
      'new globalThis.WebSocket(u)',
      'new (globalThis as any).WebSocket(u)',
      "Reflect.get(globalThis, 'WebSocket')",
      "new EventSource('https://x')",
    ];
    for (const bad of mustCatch) expect(hit(bad), bad).toBe(true);
    const mustPass = [
      'safeFetch(url)',
      'guardedFetch(u)',
      'defaultFetch(u)',
      'fetchImpl(u)',
      '// fetch(u) in a comment',
      '/* const f = fetch */',
      "serve({ fetch: app.fetch, port })",
      "c.req.header('sec-fetch-site')",
      "const UA = 'study_paper (fixture fetch)'",
      'const re = /fetch\\(/',
      'class S { fetch(u: string) { return u; } }',
      'const g = app; const h = g.fetch',
      'const ws: WebSocketLike = make()',
      "const opts = { WebSocket: impl }",
      "const s = 'a tls handshake'",
      "const t = 'http2-like'",
    ];
    for (const ok of mustPass) expect(hit(ok), ok).toBe(false);
  });
});
