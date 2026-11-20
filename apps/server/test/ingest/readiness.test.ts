// M1.1 review M5: "files/text ready" vs "AI available with the current LLM". Boundaries 40/41 pages and
// 15 MiB ± 1 byte through the whole chain: ingest → paper DTO (papers.get / papers.list) → LLM context loader.
import { afterEach, describe, expect, it } from 'vitest';
import type { ListPapersResponse, PaperDetailDto } from '@study-paper/shared/contracts/api';
import type { z } from 'zod';
import { aiAvailability } from '../../src/ingest/readiness';
import { CONTEXT_TEXT_MIN_BYTES, contextModeFor } from '../../src/ingest/supplement';
import { loadPaperContext } from '../../src/llm/paperContext';
import { startTestServer, type TestServer } from '../helpers/server';
import { FakeArxivSource, freshId, importAndWait, makePdf, paperRow, useSource } from './helpers';

const MiB = 1024 * 1024;

describe('contextMode and aiAvailability boundaries', () => {
  it('40 pages → pdf, 41 → text; 15 MiB → pdf, 15 MiB + 1 → text', () => {
    expect(CONTEXT_TEXT_MIN_BYTES).toBe(15 * MiB + 1);
    expect(contextModeFor(40, 15 * MiB)).toBe('pdf');
    expect(contextModeFor(41, 1)).toBe('text');
    expect(contextModeFor(40, 15 * MiB + 1)).toBe('text');
    expect(contextModeFor(1, 15 * MiB - 1)).toBe('pdf');
  });

  it('available only for a ready paper in pdf mode; text mode names the rule', () => {
    expect(aiAvailability({ contextReadyAt: null, contextMode: null, pageCount: 8 })).toEqual({ available: false, reason: 'context_not_ready' });
    expect(aiAvailability({ contextReadyAt: 1, contextMode: 'pdf', pageCount: 40 })).toEqual({ available: true, reason: null });
    expect(aiAvailability({ contextReadyAt: 1, contextMode: 'text', pageCount: 41 })).toEqual({ available: false, reason: 'text_mode_pages' });
    expect(aiAvailability({ contextReadyAt: 1, contextMode: 'text', pageCount: 12 })).toEqual({ available: false, reason: 'text_mode_bytes' });
  });
});

describe('ingest → paper DTO → LLM context (M5)', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const cases: { name: string; pdf: () => Buffer; pages: number; mode: 'pdf' | 'text'; ai: z.infer<typeof PaperDetailDto>['ai'] }[] = [
    { name: '40 pages', pdf: () => makePdf(40), pages: 40, mode: 'pdf', ai: { available: true, reason: null } },
    { name: '41 pages', pdf: () => makePdf(41), pages: 41, mode: 'text', ai: { available: false, reason: 'text_mode_pages' } },
    { name: 'exactly 15 MiB', pdf: () => makePdf(3, 15 * MiB), pages: 3, mode: 'pdf', ai: { available: true, reason: null } },
    { name: '15 MiB + 1 byte', pdf: () => makePdf(3, 15 * MiB + 1), pages: 3, mode: 'text', ai: { available: false, reason: 'text_mode_bytes' } },
  ];

  for (const c of cases) {
    it(`${c.name}: contextMode ${c.mode}, ai ${c.ai!.available ? 'available' : c.ai!.reason}`, async () => {
      const s = await startTestServer({ env: 'test' });
      servers.push(s);
      const id = freshId();
      const pdf = c.pdf();
      useSource(s.deps, new FakeArxivSource({ [id]: { version: 1, pdf } }));
      const { job, paper } = await importAndWait(s.deps, id);
      expect(job.status).toBe('done');
      expect(paper).toMatchObject({ pageCount: c.pages, contextMode: c.mode });
      expect(paper.contextReadyAt).not.toBeNull(); // files and the AI index are ready either way

      const auth = { headers: { 'X-SP-Token': s.token } };
      const detail = JSON.parse((await s.req(`/api/papers/${paper.id}`, auth)).text) as PaperDetailDto;
      expect(detail.state.contextReady).toBe(true);
      expect(detail.ai).toEqual(c.ai);
      const list = JSON.parse((await s.req('/api/papers', auth)).text) as ListPapersResponse;
      expect(list.papers.find((p) => p.id === paper.id)?.ai).toEqual(c.ai);

      // The DTO agrees with what the LLM path does when asked.
      if (c.ai!.available) expect(loadPaperContext(s.deps.db, s.deps.paths, paper.id).contextMode).toBe('pdf');
      else expect(() => loadPaperContext(s.deps.db, s.deps.paths, paper.id)).toThrow(expect.objectContaining({ code: 'too_large' }));
    }, 30_000);
  }

  it('a paper whose ingest is still running reports context_not_ready', async () => {
    const s = await startTestServer({ env: 'test' });
    servers.push(s);
    const id = freshId();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1 } }), { beforeStep: (step) => (step === 'supplement' ? gate : undefined) });
    const { ingestService } = await import('../../src/ingest/pipeline');
    const res = ingestService(s.deps).importArxiv(id);
    const { waitFor } = await import('../helpers/proc');
    await waitFor(() => paperRow(s.deps, res.paperId)?.readableAt != null, 'readable');
    const d = JSON.parse((await s.req(`/api/papers/${res.paperId}`, { headers: { 'X-SP-Token': s.token } })).text) as PaperDetailDto;
    expect(d.ai).toEqual({ available: false, reason: 'context_not_ready' });
    release();
    await ingestService(s.deps).whenDone(res.jobId!);
  });
});
