// MockLlmAdapter cache numbers: first (model, prefix) writes, later ones read; no prefix → none. Owner B.
import { describe, expect, it } from 'vitest';
import type { LlmEvent } from '../../src/llm/adapter';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { makeRequest, paperPrefix } from './fakeCli';
import { readMockOutput } from '@study-paper/shared/mock-outputs';

async function usage(a: MockLlmAdapter, over: Parameters<typeof makeRequest>[0]) {
  const ev: LlmEvent[] = [];
  for await (const e of a.run(makeRequest(over))) ev.push(e);
  const started = ev.find((e) => e.type === 'response_started') as Extract<LlmEvent, { type: 'response_started' }>;
  const result = ev.at(-1) as Extract<LlmEvent, { type: 'result' }>;
  expect([started.cacheReadTokens, started.cacheCreationTokens]).toEqual([result.usage.cacheReadTokens, result.usage.cacheCreationTokens]);
  return [result.usage.cacheReadTokens, result.usage.cacheCreationTokens];
}

describe('MockLlmAdapter cache rule', () => {
  it('write on the first request per (model, prefix), read afterwards, nothing without a prefix', async () => {
    const a = new MockLlmAdapter({ chunkDelayMs: 0 });
    const prefix = paperPrefix();
    const [r0, w0] = await usage(a, { prefix });
    expect(r0).toBe(0);
    expect(w0).toBeGreaterThan(0);
    expect(await usage(a, { prefix })).toEqual([w0, 0]);
    expect(await usage(a, { prefix, model: 'sonnet' })).toEqual([0, w0]); // cache is per model
    expect(await usage(a, { prefix: [] })).toEqual([0, 0]);
  });
});

// M2 (BRIEF_B B9)
async function textOf(a: MockLlmAdapter, over: Parameters<typeof makeRequest>[0]) {
  let out = '';
  for await (const e of a.run(makeRequest(over))) if (e.type === 'result') out = e.text;
  return out;
}
describe('MockLlmAdapter M2', () => {
  it('an array of outputs answers the calls of that task in order (the last one repeats)', async () => {
    const a = new MockLlmAdapter({ chunkDelayMs: 0, outputs: { notation_card: ['first', 'second'] } });
    expect([await textOf(a, { task: 'notation_card' }), await textOf(a, { task: 'notation_card' }), await textOf(a, { task: 'notation_card' })]).toEqual(['first', 'second', 'second']);
    expect(await textOf(new MockLlmAdapter({ chunkDelayMs: 0, outputs: { chat: 'fixed' } }), { task: 'chat' })).toBe('fixed');
  });
  it('records the task and whether tail[0] is an image', async () => {
    const a = new MockLlmAdapter({ chunkDelayMs: 0 });
    await textOf(a, { task: 'figure_area', tail: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: '<task name="figure_area" v="1"></task>' }] });
    await textOf(a, { task: 'chat' });
    expect(a.requests.map((r) => [r.task, r.image])).toEqual([
      ['figure_area', true],
      ['chat', false],
    ]);
  });
  it('the default glossary_define output answers for the requested term; an override is used verbatim', async () => {
    const tail = [{ type: 'text' as const, text: '<task name="glossary_define" v="1">\n<requested_term trust="user">kernel &amp; co</requested_term>\n</task>' }];
    expect(await textOf(new MockLlmAdapter({ chunkDelayMs: 0 }), { task: 'glossary_define', tail })).toBe(readMockOutput('glossary_define').replace('<term name="robust kernel">', '<term name="kernel & co">'));
    expect(await textOf(new MockLlmAdapter({ chunkDelayMs: 0, outputs: { glossary_define: '<term name="x">y</term>' } }), { task: 'glossary_define', tail })).toBe('<term name="x">y</term>');
  });
});
