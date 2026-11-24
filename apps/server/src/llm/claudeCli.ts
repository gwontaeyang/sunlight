// ClaudeCliAdapter: one `claude -p` child per run (PLAN 2.4, appendix D). Owner B.
//
// - spawn without a shell, constant argv (flags + app settings only); user and paper text go to stdin as ONE
//   stream-json line. API-key variables are removed from the child env (billing must stay on the subscription).
// - The first system:init is checked: no tools (only ["StructuredOutput"] with --json-schema), no MCP servers,
//   apiKeySource "none". Anything else → kill + unsafe_cli_state. Output (stream_event, assistant, user,
//   thinking tokens, result) before that init, or a second init, is a protocol error → kill + unsafe_cli_state;
//   nothing of it reaches the consumer.
// - stdout: StringDecoder (multi-byte safe) → line buffer, 16 MB line cap, last line without newline handled on
//   close, unparsable lines skipped and counted. stderr: last 64 KB only (never sent to the browser).
// - Exactly one terminal event per run (first transition wins). It is yielded only after the child has closed
//   (or 5 s after SIGKILL without a close event), so the caller's "done" implies "no child process".
// - Kill: SIGINT → CHILD_KILL_GRACE_MS → SIGKILL. Timeouts: startup / first content / idle / total.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { LlmUsage, RateLimitInfo } from '@study-paper/shared/contracts/domain';
import type { LlmErrorCode } from '@study-paper/shared/contracts/tasks';
import { CHILD_KILL_GRACE_MS } from '../lifecycle';
import type { ContentBlock, LlmAdapter, LlmEvent, LlmHealth, LlmRunRequest } from './adapter';
import { campaignModel, checkManagedModelSettings, isApprovedFamily } from '../security/m3Campaign';
import { stopLiveLedger, guardLiveRun, watchLiveRun } from './liveLedger';
import { resolveClaudeSpawn } from './claudeSpawn';

export const MAX_LINE_CHARS = 16 * 1024 * 1024;
export const STDERR_KEEP_BYTES = 64 * 1024;
/** After SIGKILL: release resources even without a `close` event (PLAN 2.4). */
export const FORCE_RELEASE_MS = 5_000;

/** Environment variables the child must never see (PLAN 2.4, 3). */
export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    // Model switches: the main model, the per-alias defaults, the background (small/fast) model and the subagent model.
    if (k === 'ANTHROPIC_MODEL' || /^ANTHROPIC_DEFAULT_.*_MODEL$/.test(k) || k === 'ANTHROPIC_SMALL_FAST_MODEL' || k === 'CLAUDE_CODE_SUBAGENT_MODEL') continue;
    if (k === 'SP_SECRETS_DIR' || k === 'ANTHROPIC_CUSTOM_HEADERS' || k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN' || k === 'ANTHROPIC_BASE_URL' || k.startsWith('CLAUDE_CODE_USE_')) continue;
    out[k] = v;
  }
  return out;
}

/** argv of one run: constants and app settings only (model alias, effort, constant system prompt, schema). */
export function buildArgs(req: Pick<LlmRunRequest, 'model' | 'effort' | 'system' | 'jsonSchema'>, model: string = req.model): string[] {
  const args = [
    '-p',
    '--model',
    model,
    '--effort',
    req.effort,
    '--tools',
    '',
    '--system-prompt',
    req.system,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (req.jsonSchema !== undefined) args.push('--json-schema', JSON.stringify(req.jsonSchema));
  return args;
}

/** The single stdin line: {type:"user", message:{role:"user", content:[...prefix, ...tail]}} (fixed key order). */
export function buildStdinLine(prefix: readonly ContentBlock[], tail: readonly ContentBlock[]): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [...prefix, ...tail] } })}\n`;
}

/** Error event with adapter-side detail for llm_calls.errorDetail (stderr tail etc.). Never sent to the browser. */
export type CliErrorEvent = Extract<LlmEvent, { type: 'error' }> & { detail?: string };
/** Result event with non-fatal warnings (non-zero exit after result, skipped lines). */
export type CliResultEvent = Extract<LlmEvent, { type: 'result' }> & { warnings?: string[] };

const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set(['queue_timeout', 'startup_timeout', 'first_content_timeout', 'idle_timeout', 'total_timeout', 'cli_error', 'api_error']);
export const isRetryable = (code: LlmErrorCode) => RETRYABLE.has(code);

type Json = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

/** result.usage → LlmUsage. Absent fields are null, never 0 (PLAN 2.6). */
export function usageFromResult(r: Json): LlmUsage {
  const u = (r.usage ?? {}) as Json;
  const details = (u.output_tokens_details ?? {}) as Json;
  return {
    inputTokens: int(u.input_tokens),
    cacheReadTokens: int(u.cache_read_input_tokens),
    cacheCreationTokens: int(u.cache_creation_input_tokens),
    outputTokens: int(u.output_tokens),
    thinkingTokens: int(details.thinking_tokens),
    costUsdApiEquivEst: num(r.total_cost_usd),
    durationMs: int(r.duration_ms),
    durationApiMs: int(r.duration_api_ms),
  };
}

export function rateLimitFromEvent(e: Json): RateLimitInfo {
  const info = (e.rate_limit_info ?? {}) as Json;
  const seven = ((info.unifiedWindows ?? {}) as Json).seven_day as Json | undefined;
  return {
    status: typeof info.status === 'string' ? info.status : null,
    rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
    resetsAt: num(info.resetsAt),
    sevenDayUtilization: num(seven?.utilization),
  };
}

/** Push/pull channel between child callbacks and the async iterator. */
class Channel<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  push(v: T) {
    if (this.ended) return;
    this.items.push(v);
    this.wake();
  }
  end() {
    this.ended = true;
    this.wake();
  }
  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.waiter = r));
    }
  }
}

export interface ClaudeCliOptions {
  claudeBin: string;
  /** Working directory of the child (<dataDir>/claude-cwd). Can be bound later with useCwdIfUnset(). */
  cwd?: string;
  /** Base environment (default process.env); API-key variables are always removed. */
  env?: Record<string, string | undefined>;
  /** SIGINT → SIGKILL grace (default CHILD_KILL_GRACE_MS). */
  killGraceMs?: number;
  /** SIGKILL → forced release without close (default FORCE_RELEASE_MS). */
  forceReleaseMs?: number;
  /** stdout line cap in UTF-16 units (default 16 MB). */
  maxLineChars?: number;
  /** Called with the pid of every child (tests). */
  onSpawn?: (pid: number) => void;
  /** Warnings (forced release etc.). */
  log?: (msg: string) => void;
}

export class ClaudeCliAdapter implements LlmAdapter {
  readonly mode = 'cli' as const;
  private cwd: string | undefined;
  constructor(private readonly opts: ClaudeCliOptions) {
    this.cwd = opts.cwd;
  }

  /** index.ts constructs the adapter with the binary only; the run owner binds <dataDir>/claude-cwd. */
  useCwdIfUnset(cwd: string): void {
    this.cwd ??= cwd;
  }

  run(req: LlmRunRequest): AsyncIterable<LlmEvent> {
    return watchLiveRun(runChild(this.opts, this.cwd, req), { runId: req.runId });
  }

  health(): Promise<LlmHealth> {
    return new Promise((resolve) => {
      // shell on win32: `claude` is resolved via PATHEXT (claude.cmd / claude.exe); `--version` carries no complex
      // args, so the shell is safe here (unlike a run's argv — see claudeSpawn.ts).
      execFile(this.opts.claudeBin, ['--version'], { timeout: 10_000, env: childEnv(this.opts.env ?? process.env), shell: process.platform === 'win32' }, (err, stdout) => {
        if (err) {
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
          resolve({ cliFound: !missing, cliVersion: null, loggedIn: null, detail: (missing ? 'claude not found: ' : '') + (err.message.split('\n')[0] ?? 'error') });
        } else resolve({ cliFound: true, cliVersion: (/(\d+\.\d+\.\d+)/.exec(stdout) ?? [])[1] ?? (stdout.trim() || null), loggedIn: null, detail: null });
      });
    });
  }
}

async function* runChild(opts: ClaudeCliOptions, cwd: string | undefined, req: LlmRunRequest): AsyncGenerator<LlmEvent> {
  const killGraceMs = opts.killGraceMs ?? CHILD_KILL_GRACE_MS;
  const forceReleaseMs = opts.forceReleaseMs ?? FORCE_RELEASE_MS;
  const maxLine = opts.maxLineChars ?? MAX_LINE_CHARS;
  const log = opts.log ?? ((m: string) => console.warn(`[llm] ${m}`));

  if (req.jsonSchema !== undefined && req.prefix.length > 0) throw new Error('jsonSchema is not allowed with a paper prefix (PLAN 2.4)');
  if (req.signal.aborted) {
    yield { type: 'error', code: 'cancelled', message: 'cancelled before start', retryable: false, partialText: '' };
    return;
  }
  if (!cwd) {
    yield { type: 'error', code: 'cli_error', message: 'claude working directory is not configured', retryable: false, partialText: '' };
    return;
  }
  let campaign: ReturnType<typeof campaignModel>;
  try {
    campaign = campaignModel(process.env, req.model);
    if (!campaign && !['haiku', 'opus', 'sonnet'].includes(req.model)) throw new Error('unbudgeted model');
    if (campaign) checkManagedModelSettings();
  } catch {
    yield { type: 'error', code: 'budget_exhausted', message: 'M3 model or ledger refused before start', retryable: false, partialText: '' };
    return;
  }
  mkdirSync(cwd, { recursive: true, mode: 0o700 });

  const ch = new Channel<LlmEvent>();
  let partial = '';
  let terminal: LlmEvent | null = null;
  let closed = false;
  let killStage: 'none' | 'sigint' | 'sigkill' = 'none';
  let stderr = '';
  let skippedLines = 0;
  let sawInit = false;
  let sawContent = false;
  let sawResponseStart = false;
  let sawTextDelta = false;
  let rateLimit: RateLimitInfo | undefined;
  const warnings: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const timer = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const clear = (t: NodeJS.Timeout | null) => {
    if (t) {
      clearTimeout(t);
      timers.delete(t);
    }
  };

  let child: ChildProcess;
  try {
    // How to launch `claude` on this OS (claudeSpawn.ts): a direct executable on POSIX and on win32 when one is found,
    // else the win32 shell fallback for a .cmd/.bat shim. argv and the scrubbed env are unchanged on both OSes.
    const plan = resolveClaudeSpawn(opts.claudeBin, buildArgs(req, campaign?.id), { env: opts.env ?? process.env });
    // Live ledger (S, PLAN_M2 D25): the only spawn of a model child, inside the ledger's lock section.
    const g = guardLiveRun(req.model, { runId: req.runId, task: req.task }, () => spawn(plan.command, plan.args, { cwd, env: childEnv(opts.env ?? process.env), stdio: ['pipe', 'pipe', 'pipe'], shell: plan.shell }), { expectedCaps: campaign?.caps });
    if (!g.ok) {
      yield { type: 'error', code: g.reason === 'ledger_locked' ? 'ledger_locked' : 'budget_exhausted', message: 'live ledger: ' + g.reason, retryable: false, partialText: '' };
      return;
    }
    child = g.value;
  } catch (e) {
    yield { type: 'error', code: 'cli_error', message: `spawn failed: ${(e as Error).message}`, retryable: false, partialText: '' };
    return;
  }

  const stderrDetail = () => (stderr ? `stderr: ${stderr.slice(-2048)}` : undefined);
  // What the child said before a timeout (llm_calls.errorDetail): event kinds with counts and the last `system`
  // event that is not init/thinking (e.g. an API retry notice) — without it a silent stall cannot be told apart
  // from a CLI that is retrying.
  const seenEvents = new Map<string, number>();
  let lastOtherSystem: string | null = null;
  let lastEventAt = Date.now();
  const timeoutDetail = () => {
    const kinds = [...seenEvents].map(([k, n]) => `${k}×${n}`).join(', ') || 'none';
    return [`events before timeout: ${kinds}`, `last event ${Date.now() - lastEventAt} ms ago`, ...(lastOtherSystem ? [`last system event: ${lastOtherSystem}`] : []), ...(stderr ? [stderrDetail()!] : [])].join('; ');
  };
  const markUnverifiedModel = () => {
    if (!campaign) return;
    try { stopLiveLedger(campaign.dir, 'model_mismatch'); }
    catch { log('could not persist the unverified model stop'); }
  };
  /** Records the terminal transition (first wins) and stops the child when it is still running. */
  const finish = (ev: LlmEvent) => {
    if (terminal) return;
    // A spawned invocation with no init cannot attest even its model family.
    if (!sawInit && child.pid !== undefined) markUnverifiedModel();
    terminal = ev;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (closed) return release();
    if (ev.type === 'error') kill();
    else timer(killGraceMs, kill); // result received: the child should exit on its own
  };
  const fail = (code: LlmErrorCode, message: string, detail?: string) => {
    const ev: CliErrorEvent = { type: 'error', code, message, retryable: isRetryable(code), partialText: partial };
    if (!detail && code.endsWith('_timeout')) detail = timeoutDetail();
    if (detail) ev.detail = detail;
    finish(ev);
  };
  let released = false;
  /** Hands the terminal event to the consumer — only once the child is gone (or forcibly released). */
  const release = () => {
    if (released || !terminal) return;
    released = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    req.signal.removeEventListener('abort', onAbort);
    ch.push(terminal);
    ch.end();
  };
  function kill() {
    if (closed || killStage !== 'none') return;
    killStage = 'sigint';
    child.kill('SIGINT');
    timer(killGraceMs, () => {
      if (closed) return;
      killStage = 'sigkill';
      child.kill('SIGKILL');
      timer(forceReleaseMs, () => {
        if (closed) return;
        log(`run ${req.runId}: child ${child.pid} did not close ${forceReleaseMs} ms after SIGKILL; releasing`);
        warnings.push('forced release after SIGKILL');
        if (!terminal) fail('cli_error', 'child did not exit');
        release();
      });
    });
  }
  const onAbort = () => fail('cancelled', 'cancelled');
  req.signal.addEventListener('abort', onAbort, { once: true });

  // Timeouts (PLAN 2.4 table).
  const startupTimer = timer(req.timeouts.startupMs, () => fail('startup_timeout', `no system:init within ${req.timeouts.startupMs} ms`));
  timer(req.timeouts.totalMs, () => fail('total_timeout', `run exceeded ${req.timeouts.totalMs} ms`));
  let contentTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  const touchIdle = () => {
    if (!sawContent || terminal) return;
    clear(idleTimer);
    idleTimer = timer(req.timeouts.idleMs, () => fail('idle_timeout', `no output for ${req.timeouts.idleMs} ms`));
  };
  const markContent = () => {
    if (sawContent) return;
    sawContent = true;
    clear(contentTimer);
    contentTimer = null;
  };

  child.on('spawn', () => {
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
  });
  child.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') fail('cli_missing', `claude CLI not found (${opts.claudeBin})`);
    else fail('cli_error', `child process error: ${e.message}`);
    if (child.pid === undefined) {
      // spawn failed: there is no process to wait for.
      closed = true;
      release();
    }
  });

  // stdin: one JSON line; backpressure → wait for drain, then end. EPIPE etc. = child failure, never a throw.
  child.stdin!.on('error', (e: NodeJS.ErrnoException) => {
    warnings.push(`stdin ${e.code ?? e.message}`);
    if (!terminal) fail('cli_error', `could not write the request to claude (${e.code ?? e.message})`, stderrDetail());
  });
  if (child.pid !== undefined) {
    const line = buildStdinLine(req.prefix, req.tail);
    if (child.stdin!.write(line)) child.stdin!.end();
    else child.stdin!.once('drain', () => child.stdin!.end());
  } // else: spawn failed (ENOENT…); the 'error' event ends the run

  child.stderr!.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
    if (stderr.length > STDERR_KEEP_BYTES * 2) stderr = stderr.slice(-STDERR_KEEP_BYTES);
  });

  const handle = (raw: string) => {
    if (terminal) return; // events after the terminal transition are ignored
    if (raw.trim() === '') return;
    touchIdle();
    let e: Json;
    try {
      e = JSON.parse(raw) as Json;
    } catch {
      skippedLines++;
      return;
    }
    if (typeof e !== 'object' || e === null) {
      skippedLines++;
      return;
    }
    const type = e.type;
    {
      const sub = typeof e.subtype === 'string' ? e.subtype : typeof (e.event as Json | undefined)?.type === 'string' ? String((e.event as Json).type) : '';
      const kind = `${String(type)}${sub ? `:${sub}` : ''}`;
      seenEvents.set(kind, (seenEvents.get(kind) ?? 0) + 1);
      lastEventAt = Date.now();
      if (type === 'system' && e.subtype !== 'init' && e.subtype !== 'thinking_tokens') lastOtherSystem = raw.slice(0, 400);
    }
    if (type === 'system' && e.subtype === 'init') {
      if (sawInit) {
        markUnverifiedModel();
        fail('unsafe_cli_state', 'claude sent a second system:init (protocol error); output refused', 'protocol: duplicate system:init');
        return;
      }
      sawInit = true;
      clear(startupTimer);
      const tools = Array.isArray(e.tools) ? (e.tools as unknown[]) : null;
      const okTools = req.jsonSchema !== undefined ? tools !== null && tools.length === 1 && tools[0] === 'StructuredOutput' : tools !== null && tools.length === 0;
      const okMcp = Array.isArray(e.mcp_servers) && e.mcp_servers.length === 0;
      if (campaign && !isApprovedFamily(e.model, req.model)) {
        markUnverifiedModel();
        fail('unsafe_cli_state', 'unapproved CLI model');
        return;
      }
      const okKey = e.apiKeySource === 'none';
      if (!okTools || !okMcp || !okKey) {
        fail('unsafe_cli_state', 'claude started with tools, MCP servers or an API key; output refused', `init: tools=${JSON.stringify(e.tools)} mcp_servers=${JSON.stringify(e.mcp_servers)} apiKeySource=${JSON.stringify(e.apiKeySource)}`);
        return;
      }
      ch.push({ type: 'started', modelResolved: typeof e.model === 'string' ? e.model : 'unknown', cliVersion: typeof e.claude_code_version === 'string' ? e.claude_code_version : 'unknown' });
      contentTimer = timer(req.timeouts.firstContentMs, () => fail('first_content_timeout', `no response within ${req.timeouts.firstContentMs} ms after start`));
      return;
    }
    // Nothing that carries model output or a result is accepted before the first init passed the checks above
    // (an unsafe init already ended the run). Other events (status, rate limits, unknown types) are harmless.
    if (!sawInit && (type === 'stream_event' || type === 'assistant' || type === 'user' || type === 'result' || (type === 'system' && e.subtype === 'thinking_tokens'))) {
      fail('unsafe_cli_state', 'claude produced output before system:init (protocol error); output refused', `protocol: ${String(type)}${typeof e.subtype === 'string' ? `:${e.subtype}` : ''} before system:init`);
      return;
    }
    if (type === 'system' && e.subtype === 'thinking_tokens') {
      markContent();
      touchIdle();
      ch.push({ type: 'thinking', estimatedTokens: int(e.estimated_tokens) ?? 0 });
      return;
    }
    if (type === 'stream_event') {
      const ev = (e.event ?? {}) as Json;
      if (ev.type === 'message_start') {
        if (sawResponseStart) return;
        sawResponseStart = true;
        markContent();
        touchIdle();
        const usage = (((ev.message ?? {}) as Json).usage ?? {}) as Json;
        ch.push({ type: 'response_started', cacheReadTokens: int(usage.cache_read_input_tokens) ?? 0, cacheCreationTokens: int(usage.cache_creation_input_tokens) ?? 0 });
      } else if (ev.type === 'content_block_delta') {
        const delta = (ev.delta ?? {}) as Json;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          markContent();
          touchIdle();
          sawTextDelta = true;
          partial += delta.text;
          ch.push({ type: 'text', delta: delta.text });
        }
      }
      return;
    }
    if (type === 'assistant') {
      // Without partial messages the text arrives here in one piece.
      if (sawTextDelta) return;
      const content = (((e.message ?? {}) as Json).content ?? []) as Json[];
      const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('');
      if (text) {
        markContent();
        touchIdle();
        sawTextDelta = true;
        partial += text;
        ch.push({ type: 'text', delta: text });
      }
      return;
    }
    if (type === 'rate_limit_event') {
      rateLimit = rateLimitFromEvent(e);
      ch.push({ type: 'rate_limit', rateLimit }); // S (D25): seen before the terminal, even when no result follows
      return;
    }
    if (type === 'result') {
      if (campaign && ((e.model !== undefined && !isApprovedFamily(e.model, req.model)) ||
          (e.modelUsage !== undefined && (!e.modelUsage || typeof e.modelUsage !== 'object' || Array.isArray(e.modelUsage) ||
            Object.keys(e.modelUsage).some((model) => !isApprovedFamily(model, req.model)))))) {
        markUnverifiedModel();
        fail('unsafe_cli_state', 'unapproved CLI result model');
        return;
      }
      const isError = e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success');
      if (isError) {
        const limited = e.api_error_status === 429 || (rateLimit?.status !== undefined && rateLimit.status !== null && rateLimit.status !== 'allowed' && rateLimit.status !== 'allowed_warning');
        const msg = typeof e.result === 'string' && e.result ? e.result.slice(0, 500) : `claude reported ${String(e.subtype)}`;
        fail(limited ? 'rate_limited' : 'cli_error', msg, `result subtype=${String(e.subtype)} api_error_status=${String(e.api_error_status)}`);
        return;
      }
      if (req.jsonSchema !== undefined && e.structured_output === undefined) {
        fail('cli_error', 'claude returned no structured output');
        return;
      }
      const ev: CliResultEvent = {
        type: 'result',
        text: typeof e.result === 'string' ? e.result : partial,
        ...(e.structured_output !== undefined ? { structured: e.structured_output } : {}),
        usage: usageFromResult(e),
        ...(rateLimit ? { rateLimit } : {}),
      };
      if (skippedLines) warnings.push(`${skippedLines} unparsable stdout line(s) skipped`);
      if (warnings.length) ev.warnings = warnings;
      finish(ev);
    }
  };

  // stdout: chunk boundaries may split UTF-8 code points and lines.
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let overflow = false;
  const feed = (s: string) => {
    if (overflow) return;
    buf += s;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.length > maxLine) return overflowed();
      handle(l);
    }
    if (buf.length > maxLine) overflowed();
  };
  const overflowed = () => {
    overflow = true;
    buf = '';
    fail('cli_error', `claude output line longer than ${maxLine} characters`);
  };
  child.stdout!.on('data', (c: Buffer) => feed(decoder.write(c)));

  child.on('close', (code, signal) => {
    if (released) return;
    feed(decoder.end());
    if (!overflow && buf) {
      const last = buf;
      buf = '';
      handle(last); // last line without a trailing newline
    }
    closed = true;
    if (terminal) {
      if (terminal.type === 'result' && (code !== 0 || signal)) {
        warnings.push(`claude exited with code ${code}${signal ? ` signal ${signal}` : ''} after its result`);
        (terminal as CliResultEvent).warnings = warnings;
      }
      if (terminal.type === 'error' && !(terminal as CliErrorEvent).detail && stderr) (terminal as CliErrorEvent).detail = stderrDetail();
    } else if (req.signal.aborted) fail('cancelled', 'cancelled');
    else fail('cli_error', `claude exited without a result (code ${code}${signal ? `, signal ${signal}` : ''})`, stderrDetail());
    release();
  });

  try {
    yield* ch.drain();
  } finally {
    // Consumer stopped early (it should not): make sure the child does not outlive the run.
    if (!released) {
      if (!terminal) fail('cancelled', 'consumer stopped');
      else kill();
    }
  }
}
