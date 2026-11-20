// The real ClaudeCliAdapter wired to the synthetic CLI (test/fixtures/fake-claude.mjs, strict mode). Owner B.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmEvent } from '../../src/llm/adapter';
import { ClaudeCliAdapter, childEnv, type CliErrorEvent, type CliResultEvent } from '../../src/llm/claudeCli';
import { CHILD_KILL_GRACE_MS } from '../../src/lifecycle';
import { tempDir } from '../helpers/tmp';
import { alive, collect, fakeClaudeBin, LONG_TIMEOUTS, makeRequest, paperPrefix, writeScript } from './fakeCli';

function setup(scenario: string, env: Record<string, string> = {}) {
  const dir = tempDir('sp-cli-');
  const record = join(dir, 'record.json');
  return {
    dir,
    record,
    opts: { claudeBin: fakeClaudeBin(dir), cwd: join(dir, 'claude-cwd'), env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_RECORD: record, ...env } },
  };
}
const kinds = (ev: LlmEvent[]) => ev.map((e) => e.type);
const err = (e: LlmEvent) => e as CliErrorEvent;

describe('ClaudeCliAdapter × fake-claude (strict)', () => {
  it('ok: started → response_started → text… → result; argv carries no user text, env no API keys', async () => {
    const { opts, record, dir } = setup('ok', { ANTHROPIC_API_KEY: 'sk-should-not-pass', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CODE_USE_BEDROCK: '1' });
    const r = await collect(opts, makeRequest());
    const k = kinds(r.events);
    expect(k[0]).toBe('started');
    expect(k[1]).toBe('response_started');
    expect(k.filter((x) => x === 'text').length).toBeGreaterThan(1);
    expect(k.at(-1)).toBe('result');
    const result = r.terminal as CliResultEvent;
    expect(r.events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe(result.text);
    expect(r.events[0]).toMatchObject({ type: 'started', modelResolved: 'fake-haiku-model', cliVersion: '0.0.0-fake' });
    expect(result.rateLimit).toMatchObject({ status: 'allowed', rateLimitType: 'seven_day', sevenDayUtilization: 0.12 });
    const rec = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; stdin: string; envKeys: string[]; cwd: string };
    expect(rec.argv.join(' ')).not.toContain('USER-SECRET-SELECTION');
    expect(rec.stdin).toContain('USER-SECRET-SELECTION');
    expect(rec.stdin.trim().split('\n')).toHaveLength(1);
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK']) expect(rec.envKeys).not.toContain(k);
    expect(rec.cwd).toBe(join(dir, 'claude-cwd'));
    expect(r.pids).toHaveLength(1);
    expect(alive(r.pids[0]!)).toBe(false);
  });

  it('usage without a cache_control block: zero cache tokens (present fields stay numbers)', async () => {
    const r = await collect(setup('ok').opts, makeRequest());
    expect((r.terminal as CliResultEvent).usage).toEqual({ inputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 42, thinkingTokens: 0, costUsdApiEquivEst: 0.0012, durationMs: 1234, durationApiMs: 1100 });
  });

  it.each([
    ['hit', { read: 3000, write: 120 }],
    ['cold', { read: 0, write: 3120 }],
  ] as const)('FAKE_CLAUDE_CACHE=%s with the paper prefix → cache usage', async (cache, want) => {
    const r = await collect(setup('ok', { FAKE_CLAUDE_CACHE: cache }).opts, makeRequest({ prefix: paperPrefix() }));
    expect(r.events.find((e) => e.type === 'response_started')).toEqual({ type: 'response_started', cacheReadTokens: want.read, cacheCreationTokens: want.write });
    expect((r.terminal as CliResultEvent).usage).toMatchObject({ cacheReadTokens: want.read, cacheCreationTokens: want.write });
  });

  it('FAKE_CLAUDE_CACHE=missing → absent usage fields are null, not 0', async () => {
    const r = await collect(setup('ok', { FAKE_CLAUDE_CACHE: 'missing' }).opts, makeRequest({ prefix: paperPrefix() }));
    expect((r.terminal as CliResultEvent).usage).toEqual({ inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, outputTokens: 42, thinkingTokens: 0, costUsdApiEquivEst: 0.0012, durationMs: 1234, durationApiMs: 1100 });
  });

  it('thinking: thinking events before the first text', async () => {
    const r = await collect(setup('thinking').opts, makeRequest());
    const k = kinds(r.events);
    expect(k.indexOf('thinking')).toBeGreaterThan(-1);
    expect(k.indexOf('thinking')).toBeLessThan(k.indexOf('text'));
    expect(r.events.filter((e) => e.type === 'thinking').map((e) => (e as { estimatedTokens: number }).estimatedTokens)).toEqual([50, 100, 150]);
    expect((r.terminal as CliResultEvent).usage.thinkingTokens).toBe(30);
  });

  it('split_utf8: code points split across chunks are decoded intact', async () => {
    const r = await collect(setup('split_utf8').opts, makeRequest());
    const text = r.events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('한국어 분할 테스트: 잔차를 최소화한다. [[G]]');
    expect(r.terminal.type).toBe('result');
  });

  it('no_trailing_newline: the last line without "\\n" is still the result', async () => {
    const r = await collect(setup('no_trailing_newline').opts, makeRequest());
    expect(r.terminal.type).toBe('result');
  });

  it('garbage_line: unparsable lines are skipped and counted', async () => {
    const r = await collect(setup('garbage_line').opts, makeRequest());
    expect(r.terminal.type).toBe('result');
    expect((r.terminal as CliResultEvent).warnings).toEqual(expect.arrayContaining([expect.stringContaining('1 unparsable')]));
  });

  it('init_before_stdin: init written before the request is read still works', async () => {
    const r = await collect(setup('init_before_stdin').opts, makeRequest());
    expect(kinds(r.events)[0]).toBe('started');
    expect(r.terminal.type).toBe('result');
  });

  it('result_then_exit_nonzero: success is kept, the exit code is a warning', async () => {
    const r = await collect(setup('result_then_exit_nonzero').opts, makeRequest());
    expect(r.terminal.type).toBe('result');
    expect((r.terminal as CliResultEvent).warnings).toEqual(expect.arrayContaining([expect.stringContaining('code 1')]));
  });

  it('stderr_flood: 1 MB of stderr does not break the run', async () => {
    const r = await collect(setup('stderr_flood').opts, makeRequest());
    expect(r.terminal.type).toBe('result');
  });

  it('no_result_exit → cli_error with the exit code (stderr only in detail)', async () => {
    const r = await collect(setup('no_result_exit').opts, makeRequest());
    expect(r.terminal).toMatchObject({ type: 'error', code: 'cli_error', retryable: true });
    expect(err(r.terminal).message).toContain('code 3');
    expect(err(r.terminal).message).not.toContain('fake-claude:');
    expect(err(r.terminal).detail).toContain('exiting without result');
    expect(err(r.terminal).partialText).toContain('합성 답변');
  });

  it('error_result → cli_error', async () => {
    const r = await collect(setup('error_result').opts, makeRequest());
    expect(r.terminal).toMatchObject({ type: 'error', code: 'cli_error' });
  });

  it('rate_limit → rate_limited (not retryable)', async () => {
    const r = await collect(setup('rate_limit').opts, makeRequest());
    expect(r.terminal).toMatchObject({ type: 'error', code: 'rate_limited', retryable: false });
  });

  it('unsafe_init → unsafe_cli_state, child killed, no started event', async () => {
    const r = await collect(setup('unsafe_init').opts, makeRequest());
    expect(kinds(r.events)).toEqual(['error']);
    expect(r.terminal).toMatchObject({ code: 'unsafe_cli_state' });
    expect(err(r.terminal).detail).toContain('ANTHROPIC_API_KEY');
    expect(alive(r.pids[0]!)).toBe(false);
  });

  describe('system:init must come first (review M2)', () => {
    // Output that is not preceded by ONE safe init never reaches the consumer: the only event is the terminal error.
    it.each([
      ['no_init', 'stream_event'],
      ['result_before_init', 'result'],
      ['content_before_init', 'stream_event'],
    ])('%s → unsafe_cli_state, no started/text/result event, child killed', async (scenario, first) => {
      const r = await collect(setup(scenario).opts, makeRequest());
      expect(kinds(r.events)).toEqual(['error']);
      expect(r.terminal).toMatchObject({ type: 'error', code: 'unsafe_cli_state', retryable: false, partialText: '' });
      expect(err(r.terminal).detail).toContain(`protocol: ${first}`);
      expect(alive(r.pids[0]!)).toBe(false);
    });

    it('duplicate_init → unsafe_cli_state after the first (valid) init; no text or result accepted', async () => {
      const r = await collect(setup('duplicate_init').opts, makeRequest());
      expect(kinds(r.events)).toEqual(['started', 'error']);
      expect(r.terminal).toMatchObject({ code: 'unsafe_cli_state', partialText: '' });
      expect(err(r.terminal).detail).toContain('duplicate system:init');
      expect(alive(r.pids[0]!)).toBe(false);
    });

    it('unsafe_init followed by a normal stream: nothing after the init is forwarded', async () => {
      const r = await collect(setup('unsafe_init').opts, makeRequest());
      expect(r.events.some((e) => e.type === 'text' || e.type === 'result' || e.type === 'response_started')).toBe(false);
      expect(err(r.terminal).partialText).toBe('');
    });

    it('killed_mid (child SIGKILLed after some text) → one cli_error terminal with the partial text', async () => {
      const r = await collect(setup('killed_mid').opts, makeRequest());
      expect(r.terminal).toMatchObject({ type: 'error', code: 'cli_error' });
      expect(err(r.terminal).message).toContain('SIGKILL');
      expect(err(r.terminal).partialText.length).toBeGreaterThan(0);
      expect(r.events.some((e) => e.type === 'result')).toBe(false);
    });
  });

  it('huge_line (17 MB) → cli_error, child killed', async () => {
    const r = await collect(setup('huge_line').opts, makeRequest());
    expect(r.terminal).toMatchObject({ type: 'error', code: 'cli_error' });
    expect(err(r.terminal).message).toContain('line longer');
    expect(alive(r.pids[0]!)).toBe(false);
  });

  it('exit_before_stdin_read with a large request: EPIPE is a run failure, never a throw', async () => {
    const big = 'x'.repeat(4 * 1024 * 1024);
    const r = await collect(setup('exit_before_stdin_read').opts, makeRequest({ tail: [{ type: 'text', text: big }] }));
    expect(r.terminal).toMatchObject({ type: 'error', code: 'cli_error' });
  });

  it('ENOENT → cli_missing', async () => {
    const dir = tempDir('sp-cli-');
    const r = await collect({ claudeBin: join(dir, 'no-such-claude'), cwd: join(dir, 'cwd') }, makeRequest());
    expect(r.terminal).toMatchObject({ type: 'error', code: 'cli_missing', retryable: false });
  });

  it('a strict-mode rejection (bad request) surfaces as cli_error, not success', async () => {
    const r = await collect(setup('ok').opts, makeRequest({ tail: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bm90IGEgcG5n' } }, { type: 'text', text: 'q' }] }));
    expect(r.terminal).toMatchObject({ type: 'error', code: 'cli_error' });
    expect(err(r.terminal).detail).toContain('image must be a base64 image/png');
  });

  it('jsonSchema together with a paper prefix throws (PLAN 2.4)', async () => {
    const a = new ClaudeCliAdapter({ claudeBin: 'unused', cwd: tempDir() });
    const it = a.run(makeRequest({ prefix: paperPrefix(), jsonSchema: { type: 'object' } }))[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/jsonSchema/);
  });

  describe('timeouts', () => {
    it('startup_timeout: no system:init', async () => {
      const dir = tempDir('sp-cli-');
      const bin = writeScript(dir, 'claude', 'exec sleep 30');
      const r = await collect({ claudeBin: bin, cwd: join(dir, 'cwd') }, makeRequest({ timeouts: { ...LONG_TIMEOUTS, startupMs: 300 } }));
      expect(r.terminal).toMatchObject({ type: 'error', code: 'startup_timeout', retryable: true });
      expect(alive(r.pids[0]!)).toBe(false);
    });
    it('first_content_timeout: init, then nothing', async () => {
      const r = await collect(setup('hang_after_init').opts, makeRequest({ timeouts: { ...LONG_TIMEOUTS, firstContentMs: 300 } }));
      expect(kinds(r.events)).toEqual(['started', 'error']);
      expect(r.terminal).toMatchObject({ code: 'first_content_timeout' });
      expect(alive(r.pids[0]!)).toBe(false);
    });
    it('idle_timeout: output stops mid-answer; partial text is kept', async () => {
      const r = await collect(setup('hang_mid').opts, makeRequest({ timeouts: { ...LONG_TIMEOUTS, idleMs: 300 } }));
      expect(r.terminal).toMatchObject({ code: 'idle_timeout' });
      expect(err(r.terminal).partialText.length).toBeGreaterThan(0);
      expect(alive(r.pids[0]!)).toBe(false);
    });
    it('total_timeout: a slow but steady answer exceeds totalMs', async () => {
      const r = await collect(setup('slow').opts, makeRequest({ timeouts: { ...LONG_TIMEOUTS, totalMs: 700 } }));
      expect(r.terminal).toMatchObject({ code: 'total_timeout' });
      expect(alive(r.pids[0]!)).toBe(false);
    });
  });

  describe('abort and kill', () => {
    it('abort → SIGINT → child exits → cancelled (fast)', async () => {
      const ac = new AbortController();
      const r = await collect(setup('hang_after_init').opts, makeRequest({ signal: ac.signal }), (e) => e.type === 'started' && ac.abort());
      expect(r.terminal).toMatchObject({ code: 'cancelled', retryable: false });
      expect(r.ms).toBeLessThan(CHILD_KILL_GRACE_MS);
      expect(alive(r.pids[0]!)).toBe(false);
    });

    it('abort with SIGINT ignored → SIGKILL after the 2 s grace; terminal only after the child is gone', async () => {
      const ac = new AbortController();
      let abortedAt = 0;
      const r = await collect(setup('hang_after_init', { FAKE_CLAUDE_IGNORE_SIGINT: '1' }).opts, makeRequest({ signal: ac.signal }), (e) => {
        if (e.type === 'started') {
          abortedAt = Date.now();
          ac.abort();
        }
      });
      expect(r.terminal).toMatchObject({ code: 'cancelled' });
      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(CHILD_KILL_GRACE_MS - 50);
      expect(alive(r.pids[0]!)).toBe(false);
    }, 15_000);

    it('a signal aborted before start spawns nothing', async () => {
      const ac = new AbortController();
      ac.abort();
      const r = await collect(setup('ok').opts, makeRequest({ signal: ac.signal }));
      expect(r.terminal).toMatchObject({ code: 'cancelled' });
      expect(r.pids).toEqual([]);
    });
  });

  it('childEnv removes API-key variables only', () => {
    expect(childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', ANTHROPIC_BASE_URL: 'c', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CONFIG_DIR: '/x', U: undefined })).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/x' });
  });

  it('health: version from `claude --version`; missing binary → cliFound false', async () => {
    const dir = tempDir('sp-cli-');
    const bin = writeScript(dir, 'claude', 'echo "2.1.325 (Claude Code)"');
    expect(await new ClaudeCliAdapter({ claudeBin: bin }).health()).toMatchObject({ cliFound: true, cliVersion: '2.1.325' });
    expect(await new ClaudeCliAdapter({ claudeBin: join(dir, 'missing') }).health()).toMatchObject({ cliFound: false, cliVersion: null });
  });
});
