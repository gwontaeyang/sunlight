// Helpers for tests that run the real ClaudeCliAdapter against test/fixtures/fake-claude.mjs. Owner B.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBlock, LlmEvent, LlmRunRequest, LlmTimeouts } from '../../src/llm/adapter';
import { ClaudeCliAdapter, type ClaudeCliOptions } from '../../src/llm/claudeCli';

export const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
export const SYNTHETIC_PDF = readFileSync(new URL('../fixtures/synthetic.pdf', import.meta.url));

/** Executable wrapper `<dir>/claude` → node fake-claude.mjs (exec keeps the pid). */
export function fakeClaudeBin(dir: string): string {
  return writeScript(dir, 'claude', `exec "${process.execPath}" "${FAKE_CLAUDE}" "$@"`);
}

/** Any other stand-in (e.g. a binary that never prints anything). */
export function writeScript(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

export const LONG_TIMEOUTS: LlmTimeouts = { startupMs: 10_000, firstContentMs: 10_000, idleMs: 10_000, totalMs: 20_000 };

export function paperPrefix(): ContentBlock[] {
  return [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: SYNTHETIC_PDF.toString('base64') } },
    { type: 'text', text: '<paper_index>synthetic</paper_index>', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ];
}

export function makeRequest(over: Partial<LlmRunRequest> = {}): LlmRunRequest {
  return {
    runId: 'run-test',
    task: 'explain_selection',
    model: 'haiku',
    effort: 'low',
    system: 'synthetic system prompt',
    prefix: [],
    tail: [{ type: 'text', text: '<task name="explain_selection" v="1">USER-SECRET-SELECTION</task>' }],
    timeouts: LONG_TIMEOUTS,
    signal: new AbortController().signal,
    ...over,
  };
}

export interface Collected {
  events: LlmEvent[];
  /** ms since start for each event */
  at: number[];
  terminal: LlmEvent;
  pids: number[];
  ms: number;
}

/** Runs one request to the end; `onEvent` may abort etc. */
export async function collect(opts: Omit<ClaudeCliOptions, 'onSpawn'>, req: LlmRunRequest, onEvent?: (e: LlmEvent) => void): Promise<Collected> {
  const pids: number[] = [];
  const adapter = new ClaudeCliAdapter({ ...opts, onSpawn: (pid) => pids.push(pid) });
  const t0 = Date.now();
  const events: LlmEvent[] = [];
  const at: number[] = [];
  for await (const e of adapter.run(req)) {
    events.push(e);
    at.push(Date.now() - t0);
    onEvent?.(e);
  }
  const terminals = events.filter((e) => e.type === 'result' || e.type === 'error');
  if (terminals.length !== 1) throw new Error(`expected exactly one terminal event, got ${terminals.length}`);
  if (events.at(-1) !== terminals[0]) throw new Error('terminal event is not last');
  return { events, at, terminal: terminals[0]!, pids, ms: Date.now() - t0 };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
