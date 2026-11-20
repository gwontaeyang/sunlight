// Validates the synthetic claude stand-in itself (each scenario produces the documented shape).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collect, fakeClaudeBin, makeRequest } from '../llm/fakeCli';
import { tempDir } from '../helpers/tmp';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
/** The flag set of PLAN 2.4 — what B's ClaudeCliAdapter must pass (the fake's strict mode checks it). */
const ARGS = ['-p', '--model', 'haiku', '--effort', 'low', '--tools', '', '--system-prompt', 'synthetic system prompt', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
const STDIN = `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'synthetic question' }] } })}\n`;

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  chunks: number;
  stdinError: string | null;
}

function runFake(scenario: string, opts: { killAfterMs?: number; killSignals?: NodeJS.Signals[]; env?: Record<string, string>; stdin?: string; args?: string[] } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FAKE, ...(opts.args ?? ARGS)], { env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    let stdinError: string | null = null;
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.stdin.on('error', (e) => (stdinError = (e as NodeJS.ErrnoException).code ?? String(e)));
    child.stdin.end(opts.stdin ?? STDIN);
    if (opts.killAfterMs !== undefined) {
      const signals = opts.killSignals ?? ['SIGINT'];
      signals.forEach((s, i) => setTimeout(() => child.kill(s), opts.killAfterMs! + i * 400));
    }
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr, chunks: out.length, stdinError }));
  });
}

const lines = (r: Run) => r.stdout.toString('utf8').split('\n').filter(Boolean);
const events = (r: Run) => lines(r).filter((l) => l.length < 1_000_000).map((l) => JSON.parse(l) as Record<string, unknown>);
const kinds = (r: Run) => events(r).map((e) => [e.type, e.subtype, (e.event as { type?: string } | undefined)?.type].filter(Boolean).join(':'));

describe('fake-claude scenarios', () => {
  it('ok: init (safe) → status → message_start → text deltas → assistant → rate_limit_event → result', async () => {
    const r = await runFake('ok');
    expect(r.code).toBe(0);
    const ev = events(r);
    expect(ev[0]).toMatchObject({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], apiKeySource: 'none' });
    expect(kinds(r)).toEqual(expect.arrayContaining(['system:status', 'stream_event:message_start', 'stream_event:content_block_delta', 'assistant', 'rate_limit_event']));
    expect(ev.at(-1)).toMatchObject({ type: 'result', subtype: 'success', is_error: false });
    const deltas = ev.filter((e) => (e.event as { delta?: { type: string } } | undefined)?.delta?.type === 'text_delta');
    expect(deltas.map((d) => (d.event as { delta: { text: string } }).delta.text).join('')).toBe(ev.at(-1)!.result);
  });
  it('thinking: system:thinking_tokens before text', async () => {
    const k = kinds(await runFake('thinking'));
    expect(k.indexOf('system:thinking_tokens')).toBeGreaterThan(-1);
    expect(k.indexOf('system:thinking_tokens')).toBeLessThan(k.lastIndexOf('stream_event:content_block_delta'));
  });
  it('error_result: result with is_error and non-zero exit', async () => {
    const r = await runFake('error_result');
    expect(r.code).toBe(1);
    expect(events(r).at(-1)).toMatchObject({ type: 'result', is_error: true, api_error_status: 500 });
  });
  it('no_result_exit: exits without a result line', async () => {
    const r = await runFake('no_result_exit');
    expect(r.code).toBe(3);
    expect(events(r).some((e) => e.type === 'result')).toBe(false);
  });
  it('rate_limit: rejected rate_limit_event and a 429 result', async () => {
    const ev = events(await runFake('rate_limit'));
    expect(ev.find((e) => e.type === 'rate_limit_event')).toMatchObject({ rate_limit_info: { status: 'rejected' } });
    expect(ev.at(-1)).toMatchObject({ type: 'result', is_error: true, api_error_status: 429 });
  });
  it('unsafe_init: tools, MCP servers and an API key source', async () => {
    const init = events(await runFake('unsafe_init'))[0]!;
    expect(init.tools).toEqual(['Bash', 'Read']);
    expect(init.apiKeySource).toBe('ANTHROPIC_API_KEY');
  });
  it('hang_after_init: only init, exits on SIGINT', async () => {
    const r = await runFake('hang_after_init', { killAfterMs: 300 });
    expect(kinds(r)).toEqual(['system:init']);
    expect(r.code).toBe(130);
  });
  it('hang_after_init + FAKE_CLAUDE_IGNORE_SIGINT: survives SIGINT, dies on SIGKILL', async () => {
    const r = await runFake('hang_after_init', { killAfterMs: 300, killSignals: ['SIGINT', 'SIGKILL'], env: { FAKE_CLAUDE_IGNORE_SIGINT: '1' } });
    expect(r.signal).toBe('SIGKILL');
  });
  it('hang_mid: some text, then silence', async () => {
    const r = await runFake('hang_mid', { killAfterMs: 400 });
    expect(kinds(r).filter((k) => k === 'stream_event:content_block_delta').length).toBeGreaterThan(0);
    expect(events(r).some((e) => e.type === 'result')).toBe(false);
  });
  it('huge_line: one line longer than 16 MB', async () => {
    const r = await runFake('huge_line');
    expect(Math.max(...lines(r).map((l) => l.length))).toBeGreaterThan(16 * 1024 * 1024);
  });
  it('split_utf8: output arrives in many small chunks and decodes to valid Korean', async () => {
    const r = await runFake('split_utf8');
    expect(r.chunks).toBeGreaterThan(5);
    expect(events(r).at(-1)).toMatchObject({ type: 'result', result: expect.stringContaining('한국어 분할 테스트') });
  });
  it('no_trailing_newline: last result line has no newline', async () => {
    const r = await runFake('no_trailing_newline');
    expect(r.stdout.toString().endsWith('\n')).toBe(false);
    expect(events(r).at(-1)).toMatchObject({ type: 'result' });
  });
  it('stderr_flood: ≥ 1 MB stderr and still a result', async () => {
    const r = await runFake('stderr_flood');
    expect(r.stderr.length).toBeGreaterThanOrEqual(1024 * 1024);
    expect(events(r).at(-1)).toMatchObject({ type: 'result', is_error: false });
  });
  it('exit_before_stdin_read: exits 1 without reading stdin (writer sees EPIPE on a large write)', async () => {
    const r = await runFake('exit_before_stdin_read', { stdin: 'z'.repeat(8 * 1024 * 1024) });
    expect(r.code).toBe(1);
    expect(r.stdout.length).toBe(0);
    expect(r.stdinError).toBe('EPIPE');
  });
  it('slow: same shape with longer gaps', async () => {
    const t0 = Date.now();
    const r = await runFake('slow', { env: { FAKE_CLAUDE_TEXT: 'abcdefghijklmnopqrstuvwxyz' } });
    expect(Date.now() - t0).toBeGreaterThan(400);
    expect(events(r).at(-1)).toMatchObject({ type: 'result', result: 'abcdefghijklmnopqrstuvwxyz' });
  });

  // --- strict mode, structured output, cache accounting (review M4, M5) ---
  const PDF_B64 = Buffer.from('%PDF-1.4 synthetic').toString('base64');
  const userLine = (content: unknown[]) => `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
  const cachedPaper = userLine([
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 } },
    { type: 'text', text: '<paper_index>synthetic</paper_index>', cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: '<task name="explain_selection" v="1"></task>' },
  ]);
  const resultOf = (r: Run) => events(r).at(-1) as { usage: Record<string, number>; structured_output?: unknown; result: string };

  it('strict: missing safety flags and forbidden flags are refused (exit 64)', async () => {
    const without = (flag: string, n = 1) => ARGS.filter((_, i) => i < ARGS.indexOf(flag) || i >= ARGS.indexOf(flag) + n);
    for (const args of [without('--tools', 2), without('--strict-mcp-config'), without('--no-session-persistence'), without('--setting-sources', 2), without('--system-prompt', 2), [...ARGS, '--add-dir', '/tmp'], [...ARGS, '--resume', 'x']]) {
      const r = await runFake('ok', { args });
      expect(r.code, args.join(' ')).toBe(64);
      expect(r.stderr).toMatch(/fake-claude: (missing|forbidden|flag|empty)/);
      expect(lines(r)).toEqual([]);
    }
    const tools = [...ARGS];
    tools[tools.indexOf('--tools') + 1] = 'Read';
    expect((await runFake('ok', { args: tools })).code).toBe(64);
  });

  it('strict: a malformed stdin message is refused (exit 65)', async () => {
    const bad = [
      'not json\n',
      userLine([]),
      userLine([{ type: 'text', text: '' }]),
      userLine([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('not a pdf').toString('base64') } }, { type: 'text', text: 'q' }]),
      userLine([{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'q' }]), // 5m ttl: the real CLI answers 400
      userLine([{ type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: 'q' }]),
      userLine([{ type: 'text', text: 'q' }]) + userLine([{ type: 'text', text: 'second line' }]),
    ];
    for (const stdin of bad) expect((await runFake('ok', { stdin })).code, stdin.slice(0, 80)).toBe(65);
  });

  it('usage follows the request: no cache block → 0, cache block → read, cold → write, missing → no fields', async () => {
    expect(resultOf(await runFake('ok')).usage).toMatchObject({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(resultOf(await runFake('ok', { stdin: cachedPaper })).usage).toMatchObject({ cache_read_input_tokens: 3000 });
    expect(resultOf(await runFake('ok', { stdin: cachedPaper, env: { FAKE_CLAUDE_CACHE: 'cold' } })).usage).toMatchObject({ cache_read_input_tokens: 0, cache_creation_input_tokens: 3120 });
    const missing = resultOf(await runFake('ok', { env: { FAKE_CLAUDE_CACHE: 'missing' } })).usage;
    expect(missing.cache_read_input_tokens).toBeUndefined();
    expect(missing.input_tokens).toBeUndefined();
  });

  it('--json-schema: StructuredOutput tool call with input_json_delta, a user tool_result, no text deltas', async () => {
    const args = [...ARGS, '--json-schema', JSON.stringify({ type: 'object' })];
    const r = await runFake('ok', { args });
    expect(r.code).toBe(0);
    const ev = events(r);
    expect(ev[0]).toMatchObject({ subtype: 'init', tools: ['StructuredOutput'] });
    const deltaTypes = ev.map((e) => (e.event as { delta?: { type: string } } | undefined)?.delta?.type).filter(Boolean);
    expect(deltaTypes).toContain('input_json_delta');
    expect(deltaTypes).not.toContain('text_delta');
    expect(ev.some((e) => e.type === 'user')).toBe(true);
    const res = resultOf(r);
    expect(res.structured_output).toMatchObject({ title: 'A Synthetic Title' });
    expect(JSON.parse(res.result)).toEqual(res.structured_output);
    const partial = ev.filter((e) => (e.event as { delta?: { type: string } } | undefined)?.delta?.type === 'input_json_delta').map((e) => (e.event as { delta: { partial_json: string } }).delta.partial_json).join('');
    expect(JSON.parse(partial)).toEqual(res.structured_output);
    expect(resultOf(await runFake('schema_no_output', { args })).structured_output).toBeUndefined();
    expect((await runFake('ok', { args: [...ARGS, '--json-schema', '{not json'] })).code).toBe(64);
  });

  it('init_before_stdin, garbage_line and result_then_exit_nonzero', async () => {
    const early = await runFake('init_before_stdin');
    expect(events(early)[0]).toMatchObject({ subtype: 'init' });
    expect(events(early).filter((e) => e.subtype === 'init').length).toBe(1);
    const garbage = await runFake('garbage_line');
    expect(garbage.code).toBe(0);
    expect(lines(garbage)).toContain('this line is not JSON');
    const late = await runFake('result_then_exit_nonzero');
    expect(late.code).toBe(1);
    expect(events(late).at(-1)).toMatchObject({ type: 'result', is_error: false });
  });
});

describe('fake-claude rate-limit scenarios (M2 live ledger) and the adapter rate_limit event', () => {
  const rl = (r: Run) => events(r).filter((e) => e.type === 'rate_limit_event').map((e) => (e.rate_limit_info as { status: string }).status);
  it('ok_limit_warning: a normal success whose rate_limit_event before the result is allowed_warning', async () => {
    const r = await runFake('ok_limit_warning');
    expect(r.code).toBe(0);
    expect(rl(r)).toEqual(['allowed_warning']);
    expect(events(r).at(-1)).toMatchObject({ type: 'result', subtype: 'success', is_error: false });
  });
  it('ok_limit_rejected: a normal success whose rate_limit_event before the result is rejected; the adapter yields rate_limit rejected, then a result', async () => {
    const r = await runFake('ok_limit_rejected');
    expect(r.code).toBe(0);
    expect(rl(r)).toEqual(['rejected']);
    expect(events(r).at(-1)).toMatchObject({ type: 'result', subtype: 'success', is_error: false });
    const dir = tempDir('sp-fake-rlr-');
    const c = await collect({ claudeBin: fakeClaudeBin(dir), cwd: dir, env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'ok_limit_rejected' }, log: () => {} }, makeRequest());
    expect(c.events.find((e) => e.type === 'rate_limit')).toMatchObject({ rateLimit: { status: 'rejected' } });
    expect(c.terminal).toMatchObject({ type: 'result', rateLimit: { status: 'rejected' } });
  }, 30_000);
  it('rate_rejected_exit / rate_warning_exit: init → rate_limit_event → exit without a result', async () => {
    const rej = await runFake('rate_rejected_exit');
    expect(rej.code).toBe(3);
    expect(rl(rej)).toEqual(['rejected']);
    expect(events(rej).some((e) => e.type === 'result')).toBe(false);
    const warn = await runFake('rate_warning_exit');
    expect(warn.code).toBe(0);
    expect(rl(warn)).toEqual(['allowed_warning']);
    expect(events(warn).some((e) => e.type === 'result')).toBe(false);
  });
  it('rate_rejected_hang: init → rate_limit_event rejected → no further output', async () => {
    const r = await runFake('rate_rejected_hang', { killAfterMs: 600, killSignals: ['SIGKILL'] });
    expect(r.signal).toBe('SIGKILL');
    expect(rl(r)).toEqual(['rejected']);
    expect(kinds(r)).toEqual(['system:init', 'rate_limit_event']);
  });
  it('the adapter yields a rate_limit event before its terminal event in all four scenarios', async () => {
    const dir = tempDir('sp-fake-rl-');
    const bin = fakeClaudeBin(dir);
    const cases: [string, string, string][] = [
      ['ok_limit_warning', 'allowed_warning', 'result'],
      ['rate_rejected_exit', 'rejected', 'error'],
      ['rate_warning_exit', 'allowed_warning', 'error'],
      ['rate_rejected_hang', 'rejected', 'error'],
    ];
    for (const [scenario, status, terminal] of cases) {
      const c = await collect({ claudeBin: bin, cwd: dir, env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario }, log: () => {} }, makeRequest(scenario === 'rate_rejected_hang' ? { timeouts: { startupMs: 10_000, firstContentMs: 800, idleMs: 800, totalMs: 5_000 } } : {}));
      const i = c.events.findIndex((e) => e.type === 'rate_limit');
      expect(i, scenario).toBeGreaterThanOrEqual(0);
      expect(c.events[i], scenario).toMatchObject({ type: 'rate_limit', rateLimit: { status } });
      expect(i, scenario).toBeLessThan(c.events.indexOf(c.terminal));
      expect(c.terminal.type, scenario).toBe(terminal);
    }
  }, 60_000);
});

// INTEGRATION_NOTES 결정 29 (RCW-01): the adapter's terminal for an error result. rate_limited = api_error_status 429,
// or a rate-limit status that is set and is neither 'allowed' nor 'allowed_warning'; every other error result is
// cli_error — so a transient CLI error under an allowed_warning (500, overloaded 529, no status) stays resumable.
describe('error result classification: rate_limited vs cli_error (결정 29, RCW-01)', () => {
  const rl = (r: Run) => events(r).filter((e) => e.type === 'rate_limit_event').map((e) => (e.rate_limit_info as { status: string }).status);
  it('warning_error_result: init → rate_limit_event allowed_warning → an error result with api_error_status 500, exit 1; the overrides set the status (none = no event) and api_error_status', async () => {
    const r = await runFake('warning_error_result');
    expect(r.code).toBe(1);
    expect(rl(r)).toEqual(['allowed_warning']);
    expect(events(r).at(-1)).toMatchObject({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 500 });
    const o = await runFake('warning_error_result', { env: { FAKE_CLAUDE_LIMIT_STATUS: 'rejected', FAKE_CLAUDE_API_ERROR_STATUS: 'null' } });
    expect(rl(o)).toEqual(['rejected']);
    expect(events(o).at(-1)).toMatchObject({ type: 'result', is_error: true, api_error_status: null });
    const none = await runFake('warning_error_result', { env: { FAKE_CLAUDE_LIMIT_STATUS: 'none' } });
    expect(rl(none)).toEqual([]);
  });

  it('the adapter terminal per (rate-limit status, api_error_status)', async () => {
    const dir = tempDir('sp-fake-cls-');
    const bin = fakeClaudeBin(dir);
    const table: [string, string, 'cli_error' | 'rate_limited'][] = [
      ['allowed_warning', '500', 'cli_error'],
      ['allowed_warning', '529', 'cli_error'],
      ['allowed_warning', 'null', 'cli_error'],
      ['allowed', '500', 'cli_error'],
      ['none', '500', 'cli_error'],
      ['allowed_warning', '429', 'rate_limited'],
      ['allowed', '429', 'rate_limited'],
      ['none', '429', 'rate_limited'],
      ['rejected', '500', 'rate_limited'],
      ['rejected', 'null', 'rate_limited'],
      ['allowed_warning_soon', '500', 'rate_limited'],
    ];
    for (const [status, api, code] of table) {
      const c = await collect({ claudeBin: bin, cwd: dir, env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'warning_error_result', FAKE_CLAUDE_LIMIT_STATUS: status, FAKE_CLAUDE_API_ERROR_STATUS: api }, log: () => {} }, makeRequest());
      expect(c.terminal, `${status} + ${api}`).toMatchObject({ type: 'error', code, detail: `result subtype=error_during_execution api_error_status=${api}` });
    }
  }, 60_000);
});
