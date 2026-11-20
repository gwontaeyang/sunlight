import { Backends } from '../apps/server/src/byok/backend';
import { ApiProvider } from '../apps/server/src/byok/provider';
import { CredentialStore } from '../apps/server/src/byok/credentials';
// Network smoke test of the arXiv ingest (opt-in). Owner A.
// Usage: SP_NET=1 npm run smoke:ingest -- <arXiv id or URL> [--keep]
// Imports one paper from the real arXiv into a fresh temporary data directory (never the user's; under
// SP_SMOKE_DIR when set, else the OS temp dir), prints the steps, states, page count and the M2 structure numbers
// (sections / top-level / numbered equations / KaTeX ok / references / anchored sections and equations / supplement
// version / warnings), then imports the same id again and checks that it makes no request. For the two real-paper
// fixtures the structure numbers must equal PLAN_M2 3.2 (KISS-ICP 18/6/15/36, FAST-LIO2 48/9/19/63, supplement v2).
// Requests: metadata (export.arxiv.org) + PDF + HTML (arxiv.org) = 3, spaced >= 3 s by the host queue.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../apps/server/src/config';
import { openSqlite, toDrizzle } from '../apps/server/src/db/client';
import { migrateWithBackup } from '../apps/server/src/db/migrate';
import type { AppDeps } from '../apps/server/src/deps';
import { configureIngest, ingestService, jobEvents } from '../apps/server/src/ingest/pipeline';
import type { FetchImpl } from '../apps/server/src/ingest/safeFetch';
import { Lifecycle } from '../apps/server/src/lifecycle';
import { createRunTask } from '../apps/server/src/llm/index';
import { MockLlmAdapter } from '../apps/server/src/llm/mockAdapter';
import { dataPaths, ensureDataDirs } from '../apps/server/src/paths';
import { guardedFetch } from '../apps/server/src/security/network';

/** PLAN_M2 3.2 numbers of the real-paper fixtures (the arXiv versions the latest import resolves to). */
const EXPECTED: Record<string, { supplementVersion: number; sections: number; topLevel: number; numberedEquations: number; references: number }> = {
  '2209.15397v2': { supplementVersion: 2, sections: 18, topLevel: 6, numberedEquations: 15, references: 36 },
  '2107.06829v1': { supplementVersion: 2, sections: 48, topLevel: 9, numberedEquations: 19, references: 63 },
};

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const keep = args.includes('--keep');
if (process.env.SP_NET !== '1') {
  console.error('smoke:ingest uses the real arXiv; set SP_NET=1 to allow network access.');
  process.exit(2);
}
if (!input) {
  console.error('usage: SP_NET=1 npm run smoke:ingest -- <arXiv id or URL> [--keep]');
  process.exit(2);
}

import { assertStartupPaths } from '../apps/server/src/security/startupPaths';
assertStartupPaths();
if (process.env.SP_SMOKE_DIR) assertStartupPaths({ ...process.env, SP_DATA_DIR: process.env.SP_SMOKE_DIR });
const root = mkdtempSync(join(process.env.SP_SMOKE_DIR || tmpdir(), 'sp-smoke-'));
const paths = dataPaths(join(root, 'data'));
ensureDataDirs(paths);
const sqlite = openSqlite(paths.dbFile);
await migrateWithBackup(sqlite, { backupsDir: paths.backupsDir });
const db = toDrizzle(sqlite);
const config = loadConfig({ ...process.env, SP_ENV: 'prod', SP_DATA_DIR: paths.root, SP_LLM: 'mock', SP_CONFIG_PATH: join(root, 'none.json') });
const lifecycle = new Lifecycle();
const llm = new MockLlmAdapter({ chunkDelayMs: 0 });
const backends = new Backends(sqlite, llm, new ApiProvider(sqlite, new CredentialStore(join(root, 'secrets'))), config.claudeBin);
const deps: AppDeps = { backends, config, paths, sqlite, db, getToken: () => '', llm, ...createRunTask({ db, paths, adapter: llm, backends, lifecycle }), lifecycle, shutdown: lifecycle.signal };

const requests: { url: string; status: number; startedAt: number }[] = [];
const counting: FetchImpl = async (url, init) => {
  const startedAt = Date.now();
  const res = await guardedFetch(url, init);
  requests.push({ url, status: res.status, startedAt });
  const gap = requests.length > 1 ? ` (+${startedAt - requests[requests.length - 2]!.startedAt} ms after the previous request)` : '';
  console.log(`  request ${requests.length}: ${url} → ${res.status}${gap}`);
  return res;
};
configureIngest(deps, { fetchImpl: counting, offlineDir: null });

let exitCode = 0;
try {
  const t0 = Date.now();
  const svc = ingestService(deps);
  const res = svc.importArxiv(input);
  console.log(`import ${input}: paper ${res.paperId}, job ${res.jobId}`);
  const states: string[] = [];
  for await (const e of jobEvents(deps, res.jobId!)!) {
    if (e.event === 'job.step') console.log(`  step ${e.data.step}: ${e.data.status}${e.data.detail ? ` (${e.data.detail})` : ''}`);
    else if (e.event === 'job.state') {
      states.push(e.data.state);
      console.log(`  state ${e.data.state}`);
    } else console.log(`  ${e.event} ${JSON.stringify(e.data)}`);
  }
  const p = sqlite.prepare(`SELECT title, arxivId, arxivVersion, pageCount, contextMode, ingestStatus, pdfSha256, supplementSha256, supplementVersion, structureSource, ingestWarningsJson FROM papers WHERE id = ?`).get(res.paperId) as Record<string, unknown>;
  console.log(`paper: ${JSON.stringify(p)}`);
  console.log(`first import: ${requests.length} request(s), ${Date.now() - t0} ms`);
  const n = (q: string) => (sqlite.prepare(q).get(res.paperId) as { n: number }).n;
  const structure = {
    sections: n(`SELECT count(*) AS n FROM sections WHERE paperId = ?`),
    topLevel: n(`SELECT count(*) AS n FROM sections WHERE paperId = ? AND level = 1`),
    numberedEquations: n(`SELECT count(*) AS n FROM equations WHERE paperId = ? AND number IS NOT NULL`),
    katexOk: n(`SELECT count(*) AS n FROM equations WHERE paperId = ? AND number IS NOT NULL AND katexOk = 1`),
    references: n(`SELECT count(*) AS n FROM paper_references WHERE paperId = ?`),
    figures: n(`SELECT count(*) AS n FROM figures WHERE paperId = ?`),
    anchoredSections: n(`SELECT count(*) AS n FROM sections WHERE paperId = ? AND pdfPage IS NOT NULL`),
    anchoredEquations: n(`SELECT count(*) AS n FROM equations WHERE paperId = ? AND number IS NOT NULL AND pdfPage IS NOT NULL`),
  };
  console.log(`structure: ${JSON.stringify(structure)}`);
  const want = EXPECTED[`${String(p.arxivId)}v${String(p.arxivVersion)}`];
  let structureOk = true;
  if (want) {
    const got = { supplementVersion: p.supplementVersion, sections: structure.sections, topLevel: structure.topLevel, numberedEquations: structure.numberedEquations, references: structure.references };
    structureOk = JSON.stringify(got) === JSON.stringify(want);
    console.log(structureOk ? `structure matches the fixture table: ${JSON.stringify(want)}` : `STRUCTURE MISMATCH: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }

  const before = requests.length;
  const again = svc.importArxiv(input);
  console.log(`re-import: ${JSON.stringify(again)}; requests made: ${requests.length - before}`);

  const ok = states.join(',') === 'readable,context_ready,structure_ready' && again.existing && again.jobId === null && requests.length === before && structureOk;
  console.log(ok ? `SMOKE OK: 3 states reached, structure ${want ? 'as expected' : 'printed'}, re-import made 0 requests` : 'SMOKE FAILED');
  if (!ok) exitCode = 1;
} catch (e) {
  console.error(`SMOKE FAILED: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  await lifecycle.drain(6_000);
  sqlite.close();
  if (keep) console.log(`data kept in ${paths.root}`);
  else rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
