// Source scanning for the entry-point tests (network.entrypoints, spawn.entrypoints). Owner: supervisor.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|mts|cts|js|mjs|cjs|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/** Source without comments (a comment that mentions fetch( is not a finding). Strings stay. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);
/** Global network constructors of Node 22 / the browser that bypass the fetch guard. */
const NETWORK_GLOBALS = new Set(['WebSocket', 'EventSource']);

/** `x as T`, `<T>x`, `(x)`, `x!`, `x satisfies T` → x. */
function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/**
 * Every use of a global network entry in `src` (parsed with the TypeScript AST, so comments, strings and regex
 * literals are not mistaken for code).
 * - fetch: a call or reference of the identifier `fetch` (`fetch(u)`, `const f = fetch`, `{ fetchImpl: fetch }`,
 *   `{ fetch } = globalThis`), any `.fetch(` call, `<global>.fetch` as a value, and the string `'fetch'`
 *   (`globalThis['fetch']`, `Reflect.get(globalThis, 'fetch')`).
 * - WebSocket / EventSource: the identifier, `<global>.WebSocket`, and the strings 'WebSocket' / 'EventSource'.
 * `<global>` is globalThis / global / window / self, also wrapped in `as` / `<T>` / parentheses / `!`
 * (`(globalThis as any).fetch`), or a local name bound to one of them in the same file (`const g = globalThis;
 * g.fetch`, `let g; g = globalThis`).
 * Not a finding: other identifiers (`fetchImpl`, `safeFetch`, `WebSocketLike`), an object key (`{ fetch: handler }`),
 * a member of a non-global object that is not called (`app.fetch`), a method / property declaration with that name,
 * and longer strings ('sec-fetch-site').
 * Not covered (a static scan cannot follow them): a global reached through a function call or another module
 * (`getGlobal().fetch`), computed names built at run time (`globalThis['fe' + 'tch']`), and `eval` / `Function`.
 * Returns "<line>: <source line>" per finding.
 */
export function fetchReferences(src: string, fileName = 'x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // local aliases of a global object: `const g = globalThis`, `g = window` (fixed point, so `const h = g` counts too)
  const globals = new Set(GLOBAL_OBJECTS);
  const isGlobalObject = (e: ts.Expression): boolean => {
    const u = unwrap(e);
    return ts.isIdentifier(u) && globals.has(u.text);
  };
  for (let grew = true; grew; ) {
    grew = false;
    const collect = (n: ts.Node): void => {
      let name: string | undefined;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isGlobalObject(n.initializer)) name = n.name.text;
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && isGlobalObject(n.right)) name = n.left.text;
      if (name !== undefined && !globals.has(name)) {
        globals.add(name);
        grew = true;
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
  }
  const found: string[] = [];
  const report = (n: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    found.push(`${line + 1}: ${src.split('\n')[line]!.trim().slice(0, 120)}`);
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && (n.text === 'fetch' || NETWORK_GLOBALS.has(n.text))) report(n);
    else if (ts.isIdentifier(n) && (n.text === 'fetch' || NETWORK_GLOBALS.has(n.text))) {
      const p = n.parent;
      if (ts.isPropertyAccessExpression(p) && p.name === n) {
        const called = n.text === 'fetch' && ts.isCallExpression(p.parent) && p.parent.expression === p;
        if (called || isGlobalObject(p.expression)) report(n);
      } else if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)) && p.name === n) {
        // an object key / class member with that name is not the global
      } else if (ts.isBindingElement(p) && p.propertyName === n) {
        report(n); // const { fetch: f } = globalThis
      } else report(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
