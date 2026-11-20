#!/usr/bin/env node
// Synthetic `claude -p` stand-in for tests (PLAN 9.2-7). Emits stream-json lines shaped like the events observed
// from Claude Code 2.1.325 (system:init, system:status, stream_event.*, system:thinking_tokens, assistant,
// rate_limit_event, result). Every id, path, model name and text is synthetic — no recorded output is included.
// Owner: supervisor.
//
// Scenario: FAKE_CLAUDE_SCENARIO (default ok):
//   ok | slow | thinking | error_result | no_result_exit | hang_after_init | hang_mid | rate_limit | unsafe_init |
//   huge_line | split_utf8 | no_trailing_newline | stderr_flood | exit_before_stdin_read |
//   init_before_stdin (init is written before stdin is read) | result_then_exit_nonzero | garbage_line |
//   schema_no_output (with --json-schema: success result without structured_output) |
//   protocol scenarios (the adapter must refuse output that is not preceded by ONE safe init):
//   no_init (normal output, never an init) | result_before_init (a success result, then init) |
//   content_before_init (a text delta, then the normal stream) | duplicate_init (init twice, then normal) |
//   killed_mid (init + some text, then the process SIGKILLs itself)
//   rate-limit scenarios (M2 live ledger): ok_limit_warning (normal success, but the rate_limit_event before the
//   result has status allowed_warning) | rate_rejected_exit (init → rate_limit_event rejected → exit 3, no result) |
//   rate_warning_exit (init → rate_limit_event allowed_warning → exit 0, no result) | rate_rejected_hang
//   (init → rate_limit_event rejected → never ends: the adapter times out)
//   | warning_rate_limited (init → rate_limit_event allowed_warning → an error result with api_error_status 429:
//   the warning first, then a terminal rate_limited — INTEGRATION_NOTES 결정 26)
//   | ok_limit_rejected (a normal success, but the rate_limit_event before the result has status rejected: a
//   successful result whose status is neither allowed nor allowed_warning — INT-WARNOK-R1-03)
//   | warning_error_result (init → rate_limit_event allowed_warning → an error result with api_error_status 500
//   (subtype error_during_execution): a transient CLI error under the warning, not a rate limit — INTEGRATION_NOTES
//   결정 29, RCW-01). FAKE_CLAUDE_LIMIT_STATUS overrides the event's status (`none` = no rate_limit_event) and
//   FAKE_CLAUDE_API_ERROR_STATUS the result's api_error_status (a number, or `null`) — the classification table
// With --json-schema the stream follows the observed structured-output shape: init tools ["StructuredOutput"],
// a tool_use block with input_json_delta chunks (NO text deltas), an assistant tool_use message, a `user`
// tool_result event, and result.structured_output (+ result = the same JSON as a string).
//
// Strict mode (default; FAKE_CLAUDE_STRICT=0 turns it off): the adapter under test must send what the real CLI
// needs, otherwise the fake exits with a message on stderr —
//   exit 64: a required flag is missing or wrong (-p, --tools "", --setting-sources "", --strict-mcp-config,
//            --disable-slash-commands, --no-session-persistence, --input-format/--output-format stream-json,
//            --verbose, non-empty --system-prompt, --model, --effort) or a forbidden flag is present
//            (--resume, --continue, --add-dir, --mcp-config, --bare, --dangerously-skip-permissions);
//   exit 65: stdin is not exactly one JSON line {type:"user",message:{role:"user",content:[…]}} with valid
//            blocks (document = base64 PDF, image = base64 PNG, text non-empty, cache_control only
//            {type:"ephemeral",ttl:"1h"} and at most one).
// Usage follows the request: no cache_control → no cache tokens; a cache_control block → cache read ("hit"),
// or cache write with FAKE_CLAUDE_CACHE=cold. FAKE_CLAUDE_CACHE=missing omits the usage fields.
// Other env:
//   FAKE_CLAUDE_TEXT        answer text (default: synthetic Korean SP-Markup with one <q>)
//   FAKE_CLAUDE_STRUCTURED  JSON for result.structured_output with --json-schema (default: synthetic metadata)
//   FAKE_CLAUDE_DELAY_MS    delay between events (default 5; `slow` uses 200)
//   FAKE_CLAUDE_IGNORE_SIGINT=1  ignore SIGINT (tests the SIGKILL escalation)
//   FAKE_CLAUDE_RECORD=<file>    write {argv, stdin, envKeys, cwd} as JSON for assertions
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'ok';
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const alias = arg('--model') ?? 'haiku';
const model = `fake-${alias}-model`;
const partial = argv.includes('--include-partial-messages');
const schema = arg('--json-schema');
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? (scenario === 'slow' ? 200 : 5));
const sessionId = randomUUID();
const strict = process.env.FAKE_CLAUDE_STRICT !== '0';
const structured = JSON.parse(process.env.FAKE_CLAUDE_STRUCTURED ?? '{"title":"A Synthetic Title","authors":["A. Author"],"year":2020,"venue":null,"doi":null,"arxivId":null}');

function die(code, message) {
  process.stderr.write(`fake-claude: ${message}\n`);
  process.exit(code);
}

function checkArgs() {
  const required = [['-p'], ['--tools', ''], ['--setting-sources', ''], ['--strict-mcp-config'], ['--disable-slash-commands'], ['--no-session-persistence'], ['--input-format', 'stream-json'], ['--output-format', 'stream-json'], ['--verbose'], ['--system-prompt'], ['--model'], ['--effort']];
  for (const [flag, value] of required) {
    const i = argv.indexOf(flag);
    if (i < 0) die(64, `missing flag ${flag}`);
    if (value !== undefined && argv[i + 1] !== value) die(64, `flag ${flag} must be ${JSON.stringify(value)}, got ${JSON.stringify(argv[i + 1])}`);
  }
  if (!arg('--system-prompt')) die(64, 'empty --system-prompt');
  for (const bad of ['--resume', '-r', '--continue', '-c', '--add-dir', '--mcp-config', '--bare', '--dangerously-skip-permissions']) {
    if (argv.includes(bad)) die(64, `forbidden flag ${bad}`);
  }
  if (schema !== undefined) {
    try {
      JSON.parse(schema);
    } catch {
      die(64, '--json-schema is not JSON');
    }
  }
}

/** Validates the single stream-json user message; returns what the usage numbers depend on. */
function checkStdin(stdin) {
  const lineList = stdin.split('\n').filter((l) => l.trim() !== '');
  if (lineList.length !== 1) die(65, `stdin must be exactly one JSON line, got ${lineList.length}`);
  let msg;
  try {
    msg = JSON.parse(lineList[0]);
  } catch {
    die(65, 'stdin line is not JSON');
  }
  const content = msg?.message?.content;
  if (msg?.type !== 'user' || msg?.message?.role !== 'user' || !Array.isArray(content) || content.length === 0) die(65, 'stdin must be {type:"user",message:{role:"user",content:[…]}}');
  let cacheControls = 0;
  for (const [i, b] of content.entries()) {
    if (b?.cache_control !== undefined) {
      cacheControls++;
      if (b.cache_control?.type !== 'ephemeral' || b.cache_control?.ttl !== '1h') die(65, `content[${i}].cache_control must be {type:"ephemeral",ttl:"1h"}`);
    }
    if (b?.type === 'text') {
      if (typeof b.text !== 'string' || b.text === '') die(65, `content[${i}]: empty text block`);
    } else if (b?.type === 'document') {
      if (b.source?.type !== 'base64' || b.source?.media_type !== 'application/pdf' || !Buffer.from(String(b.source?.data ?? ''), 'base64').subarray(0, 5).equals(Buffer.from('%PDF-'))) die(65, `content[${i}]: document must be a base64 application/pdf`);
    } else if (b?.type === 'image') {
      if (b.source?.type !== 'base64' || b.source?.media_type !== 'image/png' || !Buffer.from(String(b.source?.data ?? ''), 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) die(65, `content[${i}]: image must be a base64 image/png`);
    } else die(65, `content[${i}]: unknown block type ${JSON.stringify(b?.type)}`);
  }
  if (cacheControls > 1) die(65, 'more than one cache_control block');
  if (content.at(-1)?.type !== 'text') die(65, 'the last content block must be the task text');
  return { cached: cacheControls === 1 };
}
let request = { cached: false };
const text =
  process.env.FAKE_CLAUDE_TEXT ??
  '합성 답변이다. 근거: <q>The method runs at 10 Hz on a single CPU core.</q> [[P]]\n\n일반적인 설명이다. [[G]]';

if (process.env.FAKE_CLAUDE_IGNORE_SIGINT === '1') process.on('SIGINT', () => {});
else process.on('SIGINT', () => process.exit(130));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) =>
  new Promise((resolve) => {
    if (process.stdout.write(`${JSON.stringify(obj)}\n`)) resolve();
    else process.stdout.once('drain', resolve);
  });
const base = () => ({ session_id: sessionId, uuid: randomUUID() });
/** cache tokens of this request: none without a cache_control block, read on a hit, write when cold. */
function cacheTokens() {
  const mode = process.env.FAKE_CLAUDE_CACHE ?? (request.cached ? 'hit' : 'none');
  if (mode === 'missing') return null;
  if (mode === 'cold') return { cache_creation_input_tokens: 3120, cache_read_input_tokens: 0 };
  if (mode === 'hit') return { cache_creation_input_tokens: 120, cache_read_input_tokens: 3000 };
  return { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}
const usage = (extra = {}) => {
  const cache = cacheTokens();
  if (cache === null) return { output_tokens: 6, ...extra }; // usage fields missing (must become null, not 0)
  return { input_tokens: 2, ...cache, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cache.cache_creation_input_tokens }, output_tokens: 6, service_tier: 'standard', ...extra };
};
const messageId = `msg_fake_${randomUUID().slice(0, 8)}`;
const hangForever = () => new Promise(() => setInterval(() => {}, 1 << 30));

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function initEvent() {
  const unsafe = scenario === 'unsafe_init';
  return {
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    ...base(),
    tools: unsafe ? ['Bash', 'Read'] : schema ? ['StructuredOutput'] : [],
    mcp_servers: unsafe ? [{ name: 'fake-mcp', status: 'connected' }] : [],
    model,
    permissionMode: 'default',
    slash_commands: [],
    apiKeySource: unsafe ? 'ANTHROPIC_API_KEY' : 'none',
    claude_code_version: '0.0.0-fake',
    output_style: 'default',
  };
}

function streamEvent(event) {
  return { type: 'stream_event', event, ...base(), parent_tool_use_id: null };
}

async function emitText(answer) {
  if (partial) {
    await out(streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
    const step = 12;
    for (let i = 0; i < answer.length; i += step) {
      await out(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer.slice(i, i + step) } }));
      await sleep(delay);
      if (scenario === 'hang_mid' && i >= step * 2) await hangForever();
      if (scenario === 'killed_mid' && i >= step * 2) process.kill(process.pid, 'SIGKILL');
    }
    await out(streamEvent({ type: 'content_block_stop', index: 1 }));
  }
  await out({ type: 'assistant', message: { model, id: messageId, type: 'message', role: 'assistant', content: [{ type: 'text', text: answer }], usage: usage() }, parent_tool_use_id: null, ...base() });
}

function rateLimitEvent(status) {
  return {
    type: 'rate_limit_event',
    rate_limit_info: { status, resetsAt: 4102444800, rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: status === 'allowed' ? 0.12 : 1, resetsAt: 4102444800, status } } },
    ...base(),
  };
}

function resultEvent(answer, extra = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    duration_ms: 1234,
    duration_api_ms: 1100,
    num_turns: 1,
    result: answer,
    stop_reason: 'end_turn',
    session_id: sessionId,
    total_cost_usd: 0.0012,
    usage: usage({ output_tokens: 42, output_tokens_details: { thinking_tokens: scenario === 'thinking' ? 30 : 0 } }),
    modelUsage: { [model]: { inputTokens: 2, outputTokens: 42, cacheReadInputTokens: cacheTokens()?.cache_read_input_tokens ?? 0, cacheCreationInputTokens: cacheTokens()?.cache_creation_input_tokens ?? 0, costUSD: 0.0012 } },
    ...(schema && scenario !== 'schema_no_output' ? { structured_output: structured } : {}),
    uuid: randomUUID(),
    ...extra,
  };
}

async function main() {
  if (scenario === 'exit_before_stdin_read') {
    process.stderr.write('fake-claude: exiting before reading stdin\n');
    process.exit(1);
  }
  if (strict) checkArgs();
  if (scenario === 'init_before_stdin') await out(initEvent());
  const stdin = await readStdin();
  if (strict) request = checkStdin(stdin);
  if (process.env.FAKE_CLAUDE_RECORD) {
    writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, stdin, envKeys: Object.keys(process.env).sort(), cwd: process.cwd() }));
  }
  if (scenario === 'result_before_init') {
    await out(resultEvent(text));
    await out(initEvent());
    return;
  }
  if (scenario === 'content_before_init') await out(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'BEFORE-INIT ' } }));
  if (scenario !== 'init_before_stdin' && scenario !== 'no_init') await out(initEvent());
  if (scenario === 'duplicate_init') await out(initEvent());
  if (scenario === 'hang_after_init') await hangForever();
  if (scenario === 'rate_rejected_exit' || scenario === 'rate_warning_exit' || scenario === 'rate_rejected_hang') {
    await out(rateLimitEvent(scenario === 'rate_warning_exit' ? 'allowed_warning' : 'rejected'));
    if (scenario === 'rate_rejected_hang') await hangForever();
    process.exit(scenario === 'rate_rejected_exit' ? 3 : 0);
  }
  await out({ type: 'system', subtype: 'status', status: 'requesting', ...base() });
  await sleep(delay);
  if (scenario === 'stderr_flood') process.stderr.write('x'.repeat(1024 * 1024));
  if (partial) await out(streamEvent({ type: 'message_start', message: { model, id: messageId, type: 'message', role: 'assistant', content: [], usage: usage() } }));

  if (scenario === 'thinking') {
    if (partial) await out(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }));
    for (let n = 1; n <= 3; n++) {
      await out({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 * n, estimated_tokens_delta: 50, ...base() });
      await sleep(delay * 4);
    }
    if (partial) {
      await out(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 150 } }));
      await out(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'ZmFrZS1zaWduYXR1cmU=' } }));
    }
    await out({ type: 'assistant', message: { model, id: messageId, type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'ZmFrZS1zaWduYXR1cmU=' }], usage: usage() }, ...base() });
    if (partial) await out(streamEvent({ type: 'content_block_stop', index: 0 }));
  }

  if (scenario === 'huge_line') {
    await out(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'y'.repeat(17 * 1024 * 1024) } }));
  }

  if (scenario === 'split_utf8') {
    const korean = '한국어 분할 테스트: 잔차를 최소화한다. [[G]]';
    const line = Buffer.from(`${JSON.stringify(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: korean } }))}\n`, 'utf8');
    for (let i = 0; i < line.length; i += 7) {
      process.stdout.write(line.subarray(i, i + 7)); // 7-byte slices split 3-byte Hangul code points
      await sleep(1);
    }
    await out({ type: 'assistant', message: { model, id: messageId, type: 'message', role: 'assistant', content: [{ type: 'text', text: korean }] }, ...base() });
    await out(rateLimitEvent('allowed'));
    await out(resultEvent(korean));
    return;
  }

  if (scenario === 'warning_rate_limited') {
    await out(rateLimitEvent('allowed_warning'));
    await out(resultEvent('API Error: rate limited (synthetic)', { subtype: 'error_during_execution', is_error: true, api_error_status: 429, stop_reason: null }));
    return;
  }

  if (scenario === 'warning_error_result') {
    const status = process.env.FAKE_CLAUDE_LIMIT_STATUS ?? 'allowed_warning';
    const raw = process.env.FAKE_CLAUDE_API_ERROR_STATUS ?? '500';
    if (status !== 'none') await out(rateLimitEvent(status));
    await out(resultEvent('API Error: internal (synthetic)', { subtype: 'error_during_execution', is_error: true, api_error_status: raw === 'null' ? null : Number(raw), stop_reason: null }));
    process.exit(1);
  }

  if (scenario === 'rate_limit') {
    await out(rateLimitEvent('rejected'));
    await out(resultEvent('API Error: rate limited (synthetic)', { subtype: 'error_during_execution', is_error: true, api_error_status: 429, stop_reason: null }));
    return;
  }

  if (schema !== undefined) {
    // Structured output: a StructuredOutput tool call, never text deltas (observed with Claude Code 2.1.325).
    const json = JSON.stringify(structured);
    const toolUseId = `toolu_fake_${randomUUID().slice(0, 8)}`;
    if (partial) {
      await out(streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: toolUseId, name: 'StructuredOutput', input: {} } }));
      for (let i = 0; i < json.length; i += 9) await out(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 9) } }));
      await out(streamEvent({ type: 'content_block_stop', index: 1 }));
    }
    await out({ type: 'assistant', message: { model, id: messageId, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'StructuredOutput', input: structured }], usage: usage() }, parent_tool_use_id: null, ...base() });
    await out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: 'Structured output provided successfully' }] }, parent_tool_use_id: null, ...base() });
    if (partial) {
      await out(streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage({ output_tokens: 42 }) }));
      await out(streamEvent({ type: 'message_stop' }));
    }
    await out(rateLimitEvent('allowed'));
    await out(resultEvent(scenario === 'schema_no_output' ? '' : json, { num_turns: 2 }));
    return;
  }

  await emitText(text);
  if (scenario === 'garbage_line') process.stdout.write('this line is not JSON\n{"type":"unknown_future_event","x":1}\n');

  if (scenario === 'no_result_exit') {
    process.stderr.write('fake-claude: exiting without result\n');
    process.exit(3);
  }
  if (partial) {
    await out(streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage({ output_tokens: 42 }) }));
    await out(streamEvent({ type: 'message_stop' }));
  }
  await out(rateLimitEvent(scenario === 'ok_limit_warning' ? 'allowed_warning' : scenario === 'ok_limit_rejected' ? 'rejected' : 'allowed'));
  if (scenario === 'error_result') {
    await out(resultEvent('API Error: internal (synthetic)', { subtype: 'error_during_execution', is_error: true, api_error_status: 500, stop_reason: null }));
    process.exit(1);
  }
  if (scenario === 'no_trailing_newline') {
    process.stdout.write(JSON.stringify(resultEvent(text)));
    return;
  }
  await out(resultEvent(text));
  if (scenario === 'result_then_exit_nonzero') process.exit(1);
}

main().then(
  () => process.exitCode ?? 0,
  (e) => {
    process.stderr.write(`fake-claude crashed: ${e?.stack ?? e}\n`);
    process.exit(70);
  },
);
