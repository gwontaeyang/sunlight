// paperContext.ts: byte-identical prefix across tasks, fingerprint, sha checks, schema + prefix. Owner B.
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunSseEvent } from '@study-paper/shared/contracts/sse';
import { readMockFile, readMockManifest, readMockOutput } from '@study-paper/shared/mock-outputs';
import { SEED_M2_PAPER_ID, SEED_PAPER_ID, seedFixture } from '../../src/dev/seedFixture';
import { buildStdinLine } from '../../src/llm/claudeCli';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { assertSchemaWithoutPrefix, buildPaperPrefix, ContextError, loadPaperContext, prefixFingerprint } from '../../src/llm/paperContext';
import { PROMPT_VERSION } from '../../src/llm/runManager';
import { startCardRows } from '../../src/study/paperCards';
import { makeTestPngBase64 } from '../helpers/png';
import { ControlledAdapter } from '../helpers/server';
import { events, makeRunEnv, request } from './runEnv';

const parts = { systemSha256: 'a', pdfSha256: 'b', supplementSha256: 'c', contextMode: 'pdf' as const, hasSchema: false };

describe('paper context', () => {
  it('two different tasks send byte-identical prefix JSON (recorded stdin of the fake CLI)', async () => {
    const env = await makeRunEnv();
    const prefixes: string[] = [];
    for (const [task, inputs] of [
      ['explain_selection', { selection: 'We estimate the robot pose' }],
      ['chat', { question: 'How fast is it?' }],
    ] as const) {
      const rec = join(env.root, `${task}.json`);
      env.fakeEnv.FAKE_CLAUDE_RECORD = rec;
      await events(env.manager.runTask(request({ inputs }, task)));
      const stdin = (JSON.parse(readFileSync(rec, 'utf8')) as { stdin: string }).stdin;
      const content = (JSON.parse(stdin) as { message: { content: unknown[] } }).message.content;
      expect(content).toHaveLength(3);
      prefixes.push(JSON.stringify(content.slice(0, 2)));
      expect(stdin.startsWith(`{"type":"user","message":{"role":"user","content":[${prefixes.at(-1)!.slice(1, -1)},`)).toBe(true);
    }
    expect(prefixes[1]).toBe(prefixes[0]);
    expect(prefixes[0]).toMatch(/^\[\{"type":"document","source":\{"type":"base64","media_type":"application\/pdf","data":"/);
    expect(prefixes[0]).toContain('"cache_control":{"type":"ephemeral","ttl":"1h"}}]');
    env.close();
  });

  it('buildPaperPrefix: fixed key order, the supplement carries the only breakpoint', () => {
    const p = buildPaperPrefix(Buffer.from('%PDF-1.4 x'), 'sup');
    expect(JSON.stringify(p)).toBe('[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0xLjQgeA=="}},{"type":"text","text":"sup","cache_control":{"type":"ephemeral","ttl":"1h"}}]');
    expect(buildStdinLine(p, [{ type: 'text', text: 't' }]).endsWith('{"type":"text","text":"t"}]}}\n')).toBe(true);
  });

  it('fingerprint changes with the PDF, the supplement, the system prompt, the context mode and a schema', () => {
    const f = prefixFingerprint(parts);
    expect(prefixFingerprint({ ...parts })).toBe(f);
    for (const k of [{ pdfSha256: 'b2' }, { supplementSha256: 'c2' }, { systemSha256: 'a2' }, { contextMode: 'text' as const }, { hasSchema: true }]) expect(prefixFingerprint({ ...parts, ...k })).not.toBe(f);
  });

  it('PDF or supplement that differs from the recorded sha256 → context_not_ready; text mode → too_large', async () => {
    const env = await makeRunEnv();
    const dir = env.paths.paperDir(SEED_PAPER_ID);
    expect(loadPaperContext(env.db, env.paths, SEED_PAPER_ID).contextMode).toBe('pdf');
    const pdf = readFileSync(join(dir, 'paper.pdf'));
    writeFileSync(join(dir, 'paper.pdf'), Buffer.concat([pdf, Buffer.from('\n%x')]));
    expect(() => loadPaperContext(env.db, env.paths, SEED_PAPER_ID)).toThrow(expect.objectContaining({ code: 'context_not_ready' }));
    writeFileSync(join(dir, 'paper.pdf'), pdf);
    writeFileSync(join(dir, 'supplement.txt'), 'changed');
    expect(() => loadPaperContext(env.db, env.paths, SEED_PAPER_ID)).toThrow(ContextError);
    env.sqlite.prepare(`UPDATE papers SET contextMode = 'text'`).run();
    expect(() => loadPaperContext(env.db, env.paths, SEED_PAPER_ID)).toThrow(expect.objectContaining({ code: 'too_large' }));
    env.sqlite.prepare(`UPDATE papers SET contextReadyAt = NULL`).run();
    expect(() => loadPaperContext(env.db, env.paths, SEED_PAPER_ID)).toThrow(expect.objectContaining({ code: 'context_not_ready' }));
    env.close();
  });

  it('a JSON schema together with a paper prefix throws', () => {
    expect(() => assertSchemaWithoutPrefix(buildPaperPrefix(Buffer.from('%PDF-'), 's'), { type: 'object' })).toThrow(/schema/);
    expect(() => assertSchemaWithoutPrefix([], { type: 'object' })).not.toThrow();
    expect(() => assertSchemaWithoutPrefix(buildPaperPrefix(Buffer.from('%PDF-'), 's'), undefined)).not.toThrow();
  });

  // M2 (PLAN_M2 3.1, 3.5, 3.6, R7)
  it('the row version picks the file: v1 supplement.txt, v2 supplement.v2.txt; a v2 row without its file → context_not_ready', async () => {
    const env = await makeRunEnv();
    await seedFixture(env.db, env.sqlite, env.paths, Date.now(), { papers: ['m2'] });
    const v1 = loadPaperContext(env.db, env.paths, SEED_PAPER_ID);
    expect((v1.prefix[1] as { text: string }).text).toBe(readFileSync(env.paths.supplementFile(SEED_PAPER_ID, 1), 'utf8'));
    const v2 = loadPaperContext(env.db, env.paths, SEED_M2_PAPER_ID);
    expect((v2.prefix[1] as { text: string }).text).toBe(readFileSync(env.paths.supplementFile(SEED_M2_PAPER_ID, 2), 'utf8'));
    expect((v2.prefix[1] as { text: string }).text.startsWith('<paper_index v="2">')).toBe(true);
    rmSync(env.paths.supplementFile(SEED_M2_PAPER_ID, 2));
    expect(() => loadPaperContext(env.db, env.paths, SEED_M2_PAPER_ID)).toThrow(expect.objectContaining({ code: 'context_not_ready' }));
    env.close();
  });

  it('explain, figure (image in the tail), a card and its repair call: byte-identical prefix JSON and one fingerprint; translate: no prefix, fingerprint null', async () => {
    const llm = new ControlledAdapter();
    const env = await makeRunEnv({ adapter: llm });
    const explain = env.manager.runTask(request());
    await events(explain);
    const figure = env.manager.runTask(request({ inputs: { area_page: '1' }, imagePngBase64: makeTestPngBase64({ width: 32, height: 24 }) }, 'figure_area'));
    await events(figure);
    llm.queueOutputs(readMockFile(readMockManifest().m2.blocksInvalid.notation_missing_key!.file), readMockOutput('notation_card'));
    const cardRun = env.manager.runTask({ task: 'notation_card', clientRequestId: randomUUID(), paperId: SEED_PAPER_ID, inputs: {}, startRows: startCardRows(SEED_PAPER_ID, 'notation', PROMPT_VERSION) });
    expect((await events(cardRun)).some((e) => e.event === 'run.retrying')).toBe(true);
    const translate = env.manager.runTask(request({ inputs: { selection: 'We estimate the robot pose' } }, 'translate_selection'));
    await events(translate);
    expect(llm.calls.map((c) => c.task)).toEqual(['explain_selection', 'figure_area', 'notation_card', 'notation_card', 'translate_selection']);
    const prefixes = llm.calls.slice(0, 4).map((c) => JSON.stringify(c.prefix));
    expect(new Set(prefixes).size).toBe(1);
    expect(llm.calls[1]!.tail[0]!.type).toBe('image');
    expect(llm.calls[1]!.tail.map((b) => b.type)).toEqual(['image', 'text']);
    const fp = (runId: string) => (env.sqlite.prepare(`SELECT prefixFingerprint AS f FROM llm_calls WHERE runId = ?`).get(runId) as { f: string | null }).f;
    const repairRow = (env.sqlite.prepare(`SELECT runId FROM llm_calls WHERE parentRunId = ?`).get(cardRun.runId) as { runId: string }).runId;
    const fps = [fp(explain.runId), fp(figure.runId), fp(cardRun.runId), fp(repairRow)];
    expect(fps[0]).toBeTruthy();
    expect(new Set(fps).size).toBe(1);
    expect(llm.calls[4]!.prefix).toEqual([]);
    expect(fp(translate.runId)).toBeNull();
    env.close();
  });

  it('the mock cache counts the image request after an explain as a read (the image is in the tail, the prefix is the same)', async () => {
    const env = await makeRunEnv({ adapter: new MockLlmAdapter({ chunkDelayMs: 0 }) });
    const cache = (ev: RunSseEvent[]) => (ev.find((e) => e.event === 'run.response_started') as Extract<RunSseEvent, { event: 'run.response_started' }>).data;
    const first = cache(await events(env.manager.runTask(request())));
    expect(first.cacheReadTokens).toBe(0);
    expect(first.cacheCreationTokens).toBeGreaterThan(0);
    const second = cache(await events(env.manager.runTask(request({ inputs: { area_page: '1' }, imagePngBase64: makeTestPngBase64({ width: 32, height: 24 }) }, 'figure_area'))));
    expect(second.cacheReadTokens).toBe(first.cacheCreationTokens);
    expect(second.cacheCreationTokens).toBe(0);
    env.close();
  });
});
