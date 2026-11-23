import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SEED_PAPER_ID } from '../../src/dev/seedFixture';
import { aiAvailability } from '../../src/ingest/readiness';
import { buildUploadTextContext } from '../../src/ingest/uploadTextContext';
import { readCitations } from '../../src/llm/citationStore';
import { MockLlmAdapter } from '../../src/llm/mockAdapter';
import { loadPaperContext, sha256 } from '../../src/llm/paperContext';
import { matchDefinition } from '../../src/study/glossary';
import { events, makeRunEnv, request, threadRows } from './runEnv';

describe('PDF-only study evidence', () => {
  it('saves an actual matching passage as unchecked without weakening an indexed paper with the same text', async () => {
    const adapter = new MockLlmAdapter({ chunkDelayMs: 0 });
    const env = await makeRunEnv({ adapter });
    try {
      const quote = '<q>We estimate the robot pose by minimizing the point-to-point residual between consecutive scans.</q>';
      expect(matchDefinition(env.db, SEED_PAPER_ID, quote)[0]?.status).toBe('verbatim');
      env.sqlite.prepare("UPDATE papers SET structureSource='pdf-inferred' WHERE id=?").run(SEED_PAPER_ID);
      expect(matchDefinition(env.db, SEED_PAPER_ID, quote)[0]).toMatchObject({ status: 'unchecked', uncheckedReason: 'uploaded_pdf' });
      const rows = threadRows();
      const stream = await events(env.manager.runTask(request({ startRows: rows })));
      expect(stream.at(-1)?.event).toBe('run.done');
      const saved = readCitations(env.db, 'message', rows.ids.messageId!);
      expect(saved.map(c => [c.kind, c.status, c.uncheckedReason])).toEqual([
        ['quote', 'unchecked', 'uploaded_pdf'], ['equation', 'unindexed', undefined], ['quote', 'unchecked', 'uploaded_pdf'],
      ]);
      for (const c of saved) {
        expect(c.position).toBeUndefined();
        expect(c.equationId).toBeUndefined();
      }
      expect(() => env.manager.runTask(request({}, 'equation_deep'))).toThrow(/LaTeX/);
      expect(adapter.requests.map(r => r.task)).toEqual(['explain_selection']);
    } finally { env.close(); }
  });

  it('uses only the hashed local excerpts on a large upload; a missing text layer has no AI context', async () => {
    const env = await makeRunEnv({ adapter: new MockLlmAdapter() });
    try {
      const pages = Array.from({ length: 90 }, (_, i) => ({ page: i + 1, text: '<page>' + 'a'.repeat(5000) }));
      const text = buildUploadTextContext(pages);
      expect(buildUploadTextContext(pages)).toEqual(text);
      expect(text.match(/<page n=/g)).toHaveLength(64);
      expect(text).toContain('<page n="1">&lt;page&gt;');
      expect(text).toContain('<page n="90">');
      expect(text.length).toBeLessThan(85_000);
      expect(buildUploadTextContext([{ page: 1, text: '  ' }])).toBe('');
      const p = { source: 'upload', structureSource: 'pdf-inferred', contextMode: 'text' as const, contextReadyAt: 1, pageCount: 90 };
      expect(aiAvailability(p)).toEqual({ available: true, reason: null });
      expect(aiAvailability({ ...p, ingestWarningsJson: '["upload_no_text"]' })).toEqual({ available: false, reason: 'upload_no_text' });
      const file = env.paths.supplementFile(SEED_PAPER_ID, 1);
      writeFileSync(file, text);
      env.sqlite.prepare("UPDATE papers SET structureSource='pdf-inferred', contextMode='text', supplementSha256=? WHERE id=?").run(sha256(text), SEED_PAPER_ID);
      expect(loadPaperContext(env.db, env.paths, SEED_PAPER_ID).prefix).toEqual([
        { type: 'text', text, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ]);
      writeFileSync(file, 'changed');
      expect(() => loadPaperContext(env.db, env.paths, SEED_PAPER_ID)).toThrow(/sha256/);
    } finally { env.close(); }
  });
});
