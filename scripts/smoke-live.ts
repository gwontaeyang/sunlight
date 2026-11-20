// Live smoke of the real `claude -p` path (PLAN 2.4, 3, 10; PLAN_M2 7, BRIEF_B B9). Owner B.
// Opt-in: SP_LIVE=1 SP_LIVE_LEDGER=<dir> npm run test:live — refused without a ledger. The call count is enforced by the
// live ledger (llm/liveLedger.ts guardLiveRun at the spawn site), not by this script: with fewer than 3 haiku calls
// left (or STOP / STOP_REQUESTED) nothing is called; a budget_exhausted / ledger_locked answer stops the script. It
// never removes lock or STOP files. The rate-limit stop is the ledger's (watchLiveRun at the CLI event); the
// adapter's `rate_limit` events pass through here unhandled. Its own terminal check follows the ledger's rule
// (INTEGRATION_NOTES 결정 26): a result with a rate-limit status other than 'allowed' stops the script (as before),
// except exactly 'allowed_warning' when the ledger carries ALLOW_RATE_WARNING — then it is logged and the calls go on.
// Uses the subscription CLI (haiku, effort low, the app's isolation flags).
//   ① no PDF: init safety check passes; cache write ≤ system prompt estimate + the CLI's fixed part (683, measured)
//      + task text + 500 tokens (hidden-instruction check: a leaked CLAUDE.md / memory adds thousands).
//   ② v2 supplement prefix cold: the real PDF (fixture 2209.15397v2.pdf) + a supplement v2 serialised by the contracts'
//      serializeSupplementV2 from a hand-written index of that paper (meta, a few sections and equations — this branch
//      has no LaTeXML parser and must not import ingest/** for it): cache write > 0.
//   ③ the same prefix warm with a capture image as tail[0]: cache read > 0 and at least one <q> is verbatim.
// Needs <SP_DATA_DIR>/fixtures/2209.15397v2.pdf (skips without it). Never prints stderr of the CLI.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { serializeSupplementV2, type SupplementIndexInput } from '@study-paper/shared/contracts/supplement';
import { crc32, inspectPng } from '@study-paper/shared/image/png';
import { parseAnswer } from '@study-paper/shared/markup/parseAnswer';
import type { LlmEvent, LlmRunRequest } from '../apps/server/src/llm/adapter';
import { resolveCitations } from '../apps/server/src/llm/citations';
import { ClaudeCliAdapter, type CliErrorEvent, type CliResultEvent } from '../apps/server/src/llm/claudeCli';
import { RATE_WARNING_STATUS, readLiveLedger, readRateWarningApproval } from '../apps/server/src/llm/liveLedger';
import { buildPaperPrefix } from '../apps/server/src/llm/paperContext';
import { SYSTEM_PROMPT } from '../apps/server/src/llm/runManager';
import { serializeTask } from '../apps/server/src/llm/taskSerialize';
import { extractPageTexts } from '../apps/server/src/ingest/pdfText';
import { assertStartupPaths } from '../apps/server/src/security/startupPaths';
import { resolveDataDir } from '../apps/server/src/security/runtimePaths';

/** The calls this script makes (all haiku). The ledger enforces the count; this is what it needs left. */
const MAX_CALLS = 3;
/** Measured by the S0 plan probe (claude 2.1.325, haiku): text-only call with a ~10-token system prompt → 683. */
const PROBE_TEXT_ONLY_CACHE_WRITE = 683;

if (process.env.SP_LIVE !== '1') {
  console.log('smoke-live: skipped (set SP_LIVE=1 to call the real claude CLI)');
  process.exit(0);
}
const ledgerEnv = process.env.SP_LIVE_LEDGER;
if (!ledgerEnv) {
  console.log('smoke-live: refused — SP_LIVE=1 needs SP_LIVE_LEDGER=<ledger dir> (npx tsx scripts/live-ledger.ts init <dir> \'{"total":3,"perModel":{"haiku":3}}\')');
  process.exit(2);
}
const ledger: string = ledgerEnv;
assertStartupPaths();
const dataDir = resolveDataDir();
const pdfFile = join(dataDir, 'fixtures', '2209.15397v2.pdf');
if (!existsSync(pdfFile)) {
  console.log(`smoke-live: skipped (fixture missing: ${pdfFile})`);
  process.exit(0);
}
{
  const state = readLiveLedger(ledger);
  const capOf = (n: number | undefined) => n ?? 0;
  const leftModel = capOf(state.caps?.perModel.haiku) - (state.used.perModel.haiku ?? 0);
  const leftTotal = capOf(state.caps?.total) - state.used.total;
  console.log(`smoke-live: ledger ${ledger}: caps ${JSON.stringify(state.caps)}, used ${JSON.stringify(state.used)}, stop ${state.stopped ?? state.stopRequested ?? 'none'}`);
  if (!state.caps || state.stopped !== null || state.stopRequested !== null || Math.min(leftModel, leftTotal) < MAX_CALLS) {
    console.log(`smoke-live: not run — the ledger has fewer than ${MAX_CALLS} haiku calls left or is stopped (no call made)`);
    process.exit(0);
  }
}

/** Rough token estimate: one per Hangul syllable, one per 3 other non-space characters. */
function estimateTokens(s: string): number {
  const hangul = (s.match(/[가-힣]/g) ?? []).length;
  const other = s.replace(/\s/g, '').length - hangul;
  return hangul + Math.ceil(other / 3);
}

const adapter = new ClaudeCliAdapter({ claudeBin: process.env.SP_CLAUDE_BIN ?? 'claude', cwd: join(dataDir, 'claude-cwd') });
let calls = 0;
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

interface CallResult {
  started: boolean;
  modelResolved: string | null;
  cliVersion: string | null;
  responseStarted: { read: number | null; write: number | null } | null;
  terminal: LlmEvent;
  ms: number;
}

async function call(name: string, prefix: LlmRunRequest['prefix'], taskText: string, image?: string): Promise<CallResult> {
  if (calls >= MAX_CALLS) throw new Error(`call budget (${MAX_CALLS}) exhausted`);
  calls++;
  const t0 = Date.now();
  const r: CallResult = { started: false, modelResolved: null, cliVersion: null, responseStarted: null, terminal: { type: 'error', code: 'cli_error', message: 'no terminal', retryable: false, partialText: '' }, ms: 0 };
  for await (const e of adapter.run({
    runId: `smoke-${name}`,
    task: 'chat',
    model: 'haiku',
    effort: 'low',
    system: SYSTEM_PROMPT,
    prefix,
    tail: [...(image ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: image } }] : []), { type: 'text', text: taskText }],
    timeouts: { startupMs: 30_000, firstContentMs: 120_000, idleMs: 120_000, totalMs: 240_000 },
    signal: new AbortController().signal,
  })) {
    if (e.type === 'started') {
      r.started = true;
      r.modelResolved = e.modelResolved;
      r.cliVersion = e.cliVersion;
    } else if (e.type === 'response_started') r.responseStarted = { read: e.cacheReadTokens, write: e.cacheCreationTokens };
    else if (e.type === 'result' || e.type === 'error') r.terminal = e;
  }
  r.ms = Date.now() - t0;
  const t = r.terminal;
  if (t.type === 'result') {
    const u = t.usage;
    console.log(`[${name}] ok ${r.ms} ms model=${r.modelResolved} cli=${r.cliVersion} input=${u.inputTokens} cacheWrite=${u.cacheCreationTokens} cacheRead=${u.cacheReadTokens} output=${u.outputTokens} costEst=${u.costUsdApiEquivEst} rateLimit=${JSON.stringify(t.rateLimit ?? null)}${(t as CliResultEvent).warnings ? ` warnings=${JSON.stringify((t as CliResultEvent).warnings)}` : ''}`);
    if (t.rateLimit && t.rateLimit.status !== 'allowed') {
      if (t.rateLimit.status === RATE_WARNING_STATUS && readRateWarningApproval(ledger) !== null) console.log(`[${name}] rate_limit_info.status=${t.rateLimit.status} → continuing (ALLOW_RATE_WARNING in the ledger)`);
      else {
        console.log(`[${name}] rate_limit_info.status=${t.rateLimit.status} → stopping`);
        report(1);
      }
    }
  } else if (t.type === 'error') {
    console.log(`[${name}] error ${t.code}: ${t.message} (${r.ms} ms)${(t as CliErrorEvent).detail && t.code !== 'cli_error' ? ` detail=${(t as CliErrorEvent).detail}` : ''}`);
    if (t.code === 'rate_limited') report(1);
    // the ledger refused the spawn (cap, STOP, lock): stop and report; the lock / STOP files are left alone
    if (t.code === 'budget_exhausted' || t.code === 'ledger_locked') {
      console.log(`[${name}] ledger refused the call (${t.code}) → stopping; ledger state ${JSON.stringify(readLiveLedger(ledger).used)}`);
      report(1);
    }
  }
  return r;
}

function report(code: number): never {
  console.log(`smoke-live: ${calls} call(s); ledger used ${JSON.stringify(readLiveLedger(ledger).used)}; ${failures.length ? `FAILED: ${failures.join(' | ')}` : 'all checks passed'}`);
  process.exit(code || (failures.length ? 1 : 0));
}

// ① no PDF
const sysEst = estimateTokens(SYSTEM_PROMPT);
const tiny = serializeTask('chat', { question: 'ICP의 residual을 한 문장으로.' }, '짧게 답한다.');
const r1 = await call('1-no-pdf', [], tiny);
check(r1.started, '① init safety check passed (no tools, no MCP, apiKeySource none)');
if (r1.terminal.type !== 'result') report(1);
const w1 = r1.terminal.usage.cacheCreationTokens;
console.log(`  system prompt estimate ${sysEst} tokens (chars ${SYSTEM_PROMPT.length}); task text estimate ${estimateTokens(tiny)}; probe text-only baseline ${PROBE_TEXT_ONLY_CACHE_WRITE} with a ~10-token system prompt`);
// Hidden-instruction check. The CLI adds a fixed part of its own even with --system-prompt and no settings
// (text-only probe with a ~10-token system prompt: ${PROBE_TEXT_ONLY_CACHE_WRITE} tokens written). So the bound is
// system estimate + that fixed part + the task text + 500 slack. A leaked CLAUDE.md / memory file adds thousands.
const bound1 = sysEst + PROBE_TEXT_ONLY_CACHE_WRITE + estimateTokens(tiny) + 500;
check(w1 !== null && w1 <= bound1, `① cache write ${w1} ≤ system estimate ${sysEst} + CLI fixed ${PROBE_TEXT_ONLY_CACHE_WRITE} + task ${estimateTokens(tiny)} + 500 = ${bound1}`);
console.log(`  (calibrated view: ${w1} − probe baseline ${PROBE_TEXT_ONLY_CACHE_WRITE} = ${w1 === null ? 'n/a' : w1 - PROBE_TEXT_ONLY_CACHE_WRITE} vs system estimate ${sysEst} + 400)`);

// ② / ③ paper context: the real PDF + a supplement v2 of a hand-written index (serializeSupplementV2, contracts)
const pdf = readFileSync(pdfFile);
const index: SupplementIndexInput = {
  meta: { title: 'KISS-ICP: In Defense of Point-to-Point ICP – Simple, Accurate, and Robust Registration If Done the Right Way', authors: ['Ignacio Vizzo', 'Tiziano Guadagnino', 'Benedikt Mersch', 'Louis Wiesmann', 'Jens Behley', 'Cyrill Stachniss'], arxivId: '2209.15397', arxivVersion: 2, year: 2023, primaryCategory: 'cs.RO' },
  sections: [
    { htmlId: 'S1', number: 'I', title: 'Introduction' },
    { htmlId: 'S2', number: 'II', title: 'Related Work' },
    { htmlId: 'S3', number: 'III', title: 'KISS-ICP' },
    { htmlId: 'S3.SS1', number: 'III-A', title: 'Motion Prediction and Scan Deskewing' },
    { htmlId: 'S3.SS2', number: 'III-B', title: 'Spatial Subsampling' },
    { htmlId: 'S3.SS3', number: 'III-C', title: 'Local Map and Correspondences' },
    { htmlId: 'S3.SS4', number: 'III-D', title: 'Adaptive Threshold' },
    { htmlId: 'S3.SS5', number: 'III-E', title: 'Point-to-Point ICP Registration' },
    { htmlId: 'S4', number: 'IV', title: 'Experimental Evaluation' },
    { htmlId: 'S5', number: 'V', title: 'Conclusion' },
  ],
  equations: [
    { number: '1', sectionNumber: 'III-A', latex: '\\mathbf{T}_{\\mathrm{pred},t}=\\mathbf{T}_{t-2}^{-1}\\mathbf{T}_{t-1}' },
    { number: '8', sectionNumber: 'III-E', latex: '\\Delta\\mathbf{T}_{\\mathrm{est}}=\\operatorname*{argmin}_{\\mathbf{T}}\\sum_{(\\mathbf{s},\\mathbf{q})\\in\\mathcal{C}}\\rho\\left(\\|\\mathbf{T}\\mathbf{s}-\\mathbf{q}\\|_{2}\\right)' },
  ],
  figures: [{ kind: 'figure', number: '1', caption: 'Overview of the KISS-ICP odometry pipeline.' }],
  references: [],
};
const supplement = serializeSupplementV2(index).text;
const prefix = buildPaperPrefix(pdf, supplement);
console.log(`  supplement v2: ${supplement.length} chars (serializeSupplementV2 of a hand-written index)`);
const pages = (await extractPageTexts(new Uint8Array(pdf))).pages;

const r2 = await call('2-paper-cold', prefix, serializeTask('explain_selection', { selection: 'In our implementation, we keep only the first point that was inserted into the voxel.', page: '4' }));
if (r2.terminal.type !== 'result') report(1);
const u2 = r2.terminal.usage;
check((u2.cacheCreationTokens ?? 0) > 0, `② paper context cache write ${u2.cacheCreationTokens} > 0 (read ${u2.cacheReadTokens})`);
if (w1 !== null && u2.cacheReadTokens) {
  // ② reads back the system part ① wrote (same system prompt, before the PDF): ① write = system part + user part.
  console.log(`  ① decomposition (info): system part (② cache read) ${u2.cacheReadTokens}, user part ${w1 - u2.cacheReadTokens} (task text estimate ${estimateTokens(tiny)})`);
}

// ③ a capture as tail[0] (a small synthetic PNG: the cache prefix must not change with an image in the tail)
const capture = pngBase64(64, 48);
if (!inspectPng(capture).ok) throw new Error('the synthetic capture PNG does not pass inspectPng');
const r3 = await call('3-paper-warm-image', prefix, serializeTask('chat', { area_page: '1', question: '첨부 이미지는 신경 쓰지 말고, data association의 threshold τ는 어떻게 정하나? 근거 문장을 <q>로 인용해.' }), capture);
if (r3.terminal.type !== 'result') report(1);
const u3 = r3.terminal.usage;
check((u3.cacheReadTokens ?? 0) > 0, `③ cache read ${u3.cacheReadTokens} > 0 (write ${u3.cacheCreationTokens})`);
const parsed = parseAnswer(r3.terminal.text, { final: true });
const cites = resolveCitations(parsed, pages, []);
const quotes = cites.filter((c) => c.kind === 'quote');
check(r3.started, '③ the image request reached the CLI (tail[0] image, same prefix)');
console.log(`  ③ quotes: ${quotes.map((c) => `${c.status}${c.position ? `@p${c.position.page}` : ''}`).join(', ') || 'none'}`);
for (const c of quotes) console.log(`    - [${c.status}] ${c.quote}`);
check(quotes.some((c) => c.status === 'verbatim'), '③ at least one <q> is verbatim in the PDF text');
const r2quotes = resolveCitations(parseAnswer(r2.terminal.text), pages, []).filter((c) => c.kind === 'quote');
console.log(`  ② quotes (info): ${r2quotes.map((c) => c.status).join(', ') || 'none'}`);
report(0);

/** A plain RGB PNG (white) built here: signature, IHDR, one IDAT (zlib), IEND, each chunk with its CRC-32. */
function pngBase64(width: number, height: number): string {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
