// Downloads the real-paper fixtures (arXiv PDF + LaTeXML HTML) into <dataDir>/fixtures/.
// These files are never committed. Existing files are skipped, requests are spaced >= 3 s apart.
// Usage: SP_DATA_DIR=<dir> npm run fetch:fixtures [-- --only pdf|html] [--max N]
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertStartupPaths } from '../apps/server/src/security/startupPaths';
import { resolveDataDir } from '../apps/server/src/security/runtimePaths';
import { guardedFetch } from '../apps/server/src/security/network';

const FIXTURES = [
  { id: '2209.15397', version: 2, label: 'KISS-ICP' },
  { id: '2107.06829', version: 1, label: 'FAST-LIO2' },
] as const;
const MIN_GAP_MS = 3_000;
const MAX_BYTES = { pdf: 50 * 1024 * 1024, html: 10 * 1024 * 1024 };
const USER_AGENT = 'study_paper/0.0.0 (fixture fetch)';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const maxRequests = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : 4;
assertStartupPaths();
const dir = join(resolveDataDir(), 'fixtures');
mkdirSync(dir, { recursive: true, mode: 0o700 });

let requests = 0;
let lastRequestAt = 0;
async function download(url: string, dest: string, kind: 'pdf' | 'html') {
  if (requests >= maxRequests) throw new Error(`request budget (${maxRequests}) exhausted before ${url}`);
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  requests++;
  lastRequestAt = Date.now();
  const res = await guardedFetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`${url} -> HTTP ${res.status}`);
  const part = `${dest}.part`;
  let bytes = 0;
  const limited = Readable.fromWeb(res.body as never).on('data', (c: Buffer) => {
    bytes += c.length;
    if (bytes > MAX_BYTES[kind]) limited.destroy(new Error(`${url} exceeds ${MAX_BYTES[kind]} bytes`));
  });
  try {
    await pipeline(limited, createWriteStream(part, { mode: 0o600 }));
    if (kind === 'pdf' && readFileSync(part).subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`${url} is not a PDF`);
    renameSync(part, dest);
  } catch (e) {
    if (existsSync(part)) unlinkSync(part);
    throw e;
  }
  console.log(`fetched ${url} -> ${dest} (${statSync(dest).size} bytes)`);
}

for (const f of FIXTURES) {
  const base = `${f.id}v${f.version}`;
  for (const kind of ['pdf', 'html'] as const) {
    if (only && only !== kind) continue;
    const dest = join(dir, `${base}.${kind}`);
    if (existsSync(dest)) {
      console.log(`skip ${dest} (exists)`);
      continue;
    }
    await download(`https://arxiv.org/${kind}/${base}`, dest, kind);
  }
}
console.log(`done: ${requests} request(s), dir ${dir}`);
