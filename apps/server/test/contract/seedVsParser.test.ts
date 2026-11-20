// Seed ↔ A's real parser (BRIEF_INTEGRATION I2, PLAN_M2 7절 2). Owner: supervisor.
// SEED_M2_STRUCTURE is hand-written; A's own tests compare it with the parser too, but they are A's and may weaken.
// This contract test pins the comparison: the seed is only compared, never generated from the parser (open question 2).
// Exact comparisons only (toEqual / bytes) — a mismatch is handled by the I2 table, never by loosening the matcher.
//   1. parse(synthetic-m2.html) (+ the pipeline's normalizeForStore / katexCheckAll) = SEED_M2_STRUCTURE
//   2. anchorStructure on synthetic-m2.pdf's page texts = the seed's anchors (anchorSection / anchorEquation /
//      anchorCaption on the same page texts), positions and rects identical; the null set is the fixture header's
//   3. buildSupplementInput(parse, latex, SEED_M2_META) → serializeSupplementV2 = the golden synthetic.supplement.v2.txt
//      bytes = serializeSupplementV2(seedM2SupplementInput())
//   4. pipeline: a real offline import of 2301.00004 (no seed) gives the same papers.structure as SEED_M2_PAPER_ID
//      (row ids replaced by htmlId), the same stored equation contexts (not in the DTO), supplement v2, structureSource
//      latexml, the golden supplement bytes; no fetch.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportPaperResponse, PaperDetailDto, StructureResponse } from '@study-paper/shared/contracts/api';
import { parseSseEvent } from '@study-paper/shared/contracts/sse';
import { serializeSupplementV2 } from '@study-paper/shared/contracts/supplement';
import { anchorCaption, anchorEquation, anchorSection, SEED_ARXIV_IDS, SEED_M2_META, SEED_M2_PAPER_ID, SEED_M2_STRUCTURE, seedM2SupplementInput, type SeedAnchor, type SeedPage } from '../../src/dev/seedFixture';
import { anchorStructure, type AnchorPosition } from '../../src/ingest/anchorStructure';
import { katexCheckAll } from '../../src/ingest/katexCheck';
import { normalizeForStore } from '../../src/ingest/latexNormalize';
import { parse, type ParsedStructure } from '../../src/ingest/latexml';
import { extractPageTexts } from '../../src/ingest/pdfText';
import { buildSupplementInput } from '../../src/ingest/structureStore';
import { startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';

const FIXTURES = join(__dirname, '..', 'fixtures');
const HTML = readFileSync(join(FIXTURES, 'synthetic-m2.html'), 'utf8');
const PDF = readFileSync(join(FIXTURES, 'synthetic-m2.pdf'));
const GOLDEN = readFileSync(join(FIXTURES, 'synthetic.supplement.v2.txt'));

/** The stored latex/katexOk exactly as the pipeline's structure step computes them (pipeline.ts stepStructure). */
async function storedLatex(p: ParsedStructure) {
  const norm = p.equations.map((e) => normalizeForStore(e.latexRaw));
  const k = await katexCheckAll(norm.map((n) => n.latex));
  expect(k.budgetExceeded).toBe(false);
  return norm.map((n, i) => ({ latex: n.latex, katexOk: !n.cut && !p.equations[i]!.latexCut && k.ok[i] === true }));
}

async function seedPages(): Promise<SeedPage[]> {
  return (await extractPageTexts(new Uint8Array(PDF))).pages as SeedPage[];
}

describe('seed ↔ parser (function level)', () => {
  it('1. parse(synthetic-m2.html) equals SEED_M2_STRUCTURE (sections, 7 equation rows with contexts, figures, references, codeUrl) and the fixture header (1 ltx_ERROR, the arXiv:0000.00001v1 mention of the abstract, no warnings)', async () => {
    const p = parse(HTML);
    const latex = await storedLatex(p);
    const sid = (i: number | null) => (i === null ? null : p.sections[i]!.htmlId);
    expect(p.sections.map((s) => ({ htmlId: s.htmlId, number: s.number, title: s.title, level: s.level, parent: sid(s.parentIndex) }))).toEqual(SEED_M2_STRUCTURE.sections);
    expect(
      p.equations.map((e, i) => ({ htmlId: e.htmlId, number: e.number, section: sid(e.sectionIndex), latexRaw: e.latexRaw, latex: latex[i]!.latex, katexOk: latex[i]!.katexOk, contextBefore: e.contextBefore, contextAfter: e.contextAfter })),
    ).toEqual(SEED_M2_STRUCTURE.equations);
    expect(p.equations.map((e) => e.latexCut)).toEqual(SEED_M2_STRUCTURE.equations.map(() => false));
    expect(p.figures.map((f) => ({ htmlId: f.htmlId, kind: f.kind, number: f.number, caption: f.caption, section: sid(f.sectionIndex) }))).toEqual(SEED_M2_STRUCTURE.figures);
    // the seed stores no doi (null column): the parser must find none either
    expect(p.references.map((r) => ({ htmlId: r.htmlId, label: r.label, rawText: r.rawText, arxivId: r.arxivId, doi: r.doi }))).toEqual(SEED_M2_STRUCTURE.references.map((r) => ({ ...r, doi: null })));
    expect(p.codeUrl).toBe(SEED_M2_STRUCTURE.codeUrl);
    expect(p.ltxErrors).toBe(1);
    // since A 수정 3 comments, <script> and <style> are not scanned (A-P2-01, PLAN_M2 9절 66): only the abstract's mention
    expect(p.arxivMentions).toEqual([{ id: '0000.00001', version: 1 }]);
    expect(p.warnings).toEqual([]);
  });

  it('2. anchorStructure on synthetic-m2.pdf = the seed anchors: I, II, II-A, equations 1 and 2 at the same (page, offset, rect); figure page 1; II-B, the table, equations 3, 4, the unnumbered row and A.1 ×2 null', async () => {
    const pages = await seedPages();
    const p = parse(HTML);
    const a = await anchorStructure(p.sections, p.equations, p.figures, pages);
    const S = SEED_M2_STRUCTURE;
    const counts = new Map<string, number>();
    for (const e of S.equations) if (e.number) counts.set(e.number, (counts.get(e.number) ?? 0) + 1);
    // the seed's own rule (seedM2): a number that appears twice is never anchored
    const seedSections = S.sections.map((s) => anchorSection(pages, s.number, s.title));
    const seedEquations = S.equations.map((e) => (e.number && counts.get(e.number) === 1 ? anchorEquation(pages, e.number) : null));
    const seedFigures = S.figures.map((f) => anchorCaption(pages, f.caption));
    const pos = (x: AnchorPosition | SeedAnchor | null) => (x === null ? null : { page: x.page, start: x.start, rect: x.rect });
    expect(a.sections.map(pos)).toEqual(seedSections.map(pos));
    expect(a.equations.map(pos)).toEqual(seedEquations.map(pos));
    expect(a.figures).toEqual(seedFigures);
    // which ones are known (so two all-null results cannot pass): the fixture header's null set
    expect(S.sections.map((s, i) => [s.number, seedSections[i] !== null && seedSections[i]!.rect !== null])).toEqual([
      ['I', true],
      ['II', true],
      ['II-A', true],
      ['II-B', false],
    ]);
    expect(S.equations.map((e, i) => [e.number, seedEquations[i] !== null && seedEquations[i]!.rect !== null])).toEqual([
      ['1', true],
      ['2', true],
      ['3', false],
      ['4', false],
      [null, false],
      ['A.1', false],
      ['A.1', false],
    ]);
    expect(seedFigures).toEqual([1, null]);
    expect(a.orderViolations).toBe(0);
    expect(a.budgetExhausted).toBe(false);
  });

  it('3. the parsed structure + SEED_M2_META → serializeSupplementV2 = the golden synthetic.supplement.v2.txt bytes = serializeSupplementV2(seedM2SupplementInput())', async () => {
    const p = parse(HTML);
    const fromParser = serializeSupplementV2(buildSupplementInput(p, await storedLatex(p), SEED_M2_META));
    const fromSeed = serializeSupplementV2(seedM2SupplementInput());
    expect(fromParser.truncated).toBe(false);
    expect(Buffer.from(fromParser.text).equals(GOLDEN)).toBe(true);
    expect(Buffer.from(fromSeed.text).equals(GOLDEN)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// pipeline level

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});
async function call(s: TestServer, method: string, path: string, body?: unknown) {
  const r = await s.req(`/api${path}`, { method, headers: { 'X-SP-Token': s.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: r.text, type: String(r.headers['content-type'] ?? '') };
}
async function getJson<T>(s: TestServer, path: string): Promise<T> {
  const r = await call(s, 'GET', path);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return JSON.parse(r.text) as T;
}

/** An offline arXiv entry with SEED_M2_META's values (title, one author, 2023, cs.RO). */
function atomOf(id: string, version: number): string {
  const m = SEED_M2_META;
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query</title>
  <id>http://arxiv.org/api/synthetic</id>
  <updated>2023-01-02T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/${id}v${version}</id>
    <updated>2023-01-02T00:00:00Z</updated>
    <published>${m.year}-01-01T12:00:00Z</published>
    <title>${m.title}</title>
    <summary>A synthetic abstract.</summary>
${m.authors.map((a) => `    <author><name>${a}</name></author>`).join('\n')}
    <link href="http://arxiv.org/abs/${id}v${version}" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/${id}v${version}" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="${m.primaryCategory}" scheme="http://arxiv.org/schemas/atom"/>
    <category term="${m.primaryCategory}" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>
`;
}

/** papers.structure with row ids replaced by htmlId (parent/section links too) and inLibraryPaperId left out. */
function byHtmlId(st: StructureResponse) {
  const sec = new Map(st.sections.map((s) => [s.id, s.htmlId] as const));
  const ref = (id: string | null) => (id === null ? null : (sec.get(id) ?? `?${id}`));
  return {
    structureSource: st.structureSource,
    sections: st.sections.map(({ id: _id, parentId, ...s }) => ({ ...s, parent: ref(parentId) })),
    equations: st.equations.map(({ id: _id, sectionId, ...e }) => ({ ...e, section: ref(sectionId) })),
    figures: st.figures.map(({ id: _id, sectionId, ...f }) => ({ ...f, section: ref(sectionId) })),
    references: st.references.map(({ id: _id, inLibraryPaperId: _lib, ...r }) => r),
  };
}

describe('seed ↔ parser (pipeline level)', () => {
  it('4. an offline import of 2301.00004 (synthetic-m2 PDF + HTML, no seed) answers papers.structure exactly like SEED_M2_PAPER_ID; supplementVersion 2, structureSource latexml, supplement.v2.txt = the golden bytes; the injected fetch is never called', async () => {
    const id = SEED_ARXIV_IDS.m2;
    const offline = tempDir('sp-offline-');
    writeFileSync(join(offline, `${id}.atom.xml`), atomOf(id, 1));
    writeFileSync(join(offline, `${id}v1.pdf`), PDF);
    writeFileSync(join(offline, `${id}v1.html`), HTML);
    const fetchSpy = vi.fn(async () => new Response('', { status: 599 }));
    const seeded = await startTestServer({ env: 'test', papers: ['m2'] });
    servers.push(seeded);
    const fresh = await startTestServer({ env: 'test', offlineDir: offline, fetchImpl: fetchSpy });
    servers.push(fresh);

    const imp = await call(fresh, 'POST', '/papers/import', { input: id, clientRequestId: crypto.randomUUID() });
    expect(imp.status, imp.text.slice(0, 300)).toBe(200);
    const { paperId, jobId } = JSON.parse(imp.text) as ImportPaperResponse;
    expect(jobId).not.toBeNull();
    const ev = await call(fresh, 'GET', `/jobs/${jobId}/events`);
    const events = ev.text
      .split('\n\n')
      .filter((f) => f.trim() !== '')
      .map((frame) => parseSseEvent(/^event: (.*)$/m.exec(frame)![1]!, JSON.parse(/^data: (.*)$/m.exec(frame)![1]!)));
    expect(events.at(-1)!.event, ev.text.slice(-500)).toBe('job.done');
    expect(fetchSpy).not.toHaveBeenCalled();

    const detail = await getJson<PaperDetailDto>(fresh, `/papers/${paperId}`);
    expect(detail.supplementVersion).toBe(2);
    expect(detail.structureSource).toBe('latexml');
    expect(detail.codeUrl).toBe(SEED_M2_STRUCTURE.codeUrl);
    const imported = byHtmlId(await getJson<StructureResponse>(fresh, `/papers/${paperId}/structure`));
    const seed = byHtmlId(await getJson<StructureResponse>(seeded, `/papers/${SEED_M2_PAPER_ID}/structure`));
    expect(imported).toEqual(seed);
    expect(imported.sections.map((s) => s.htmlId)).toEqual(SEED_M2_STRUCTURE.sections.map((s) => s.htmlId));
    expect(imported.equations).toHaveLength(7);
    // EquationDto has no contexts (contextBefore/After, decision 2's S-5 rows): compare the stored rows directly.
    // routes/threads.ts reads them for an equation thread's neighbors.
    const contexts = (s: TestServer, pid: string) =>
      s.deps.sqlite.prepare(`SELECT htmlId, number, contextBefore, contextAfter FROM equations WHERE paperId = ? ORDER BY ordinal`).all(pid) as { htmlId: string | null; number: string | null; contextBefore: string | null; contextAfter: string | null }[];
    const importedContexts = contexts(fresh, paperId);
    expect(importedContexts).toEqual(contexts(seeded, SEED_M2_PAPER_ID));
    expect(importedContexts).toEqual(SEED_M2_STRUCTURE.equations.map((e) => ({ htmlId: e.htmlId, number: e.number, contextBefore: e.contextBefore, contextAfter: e.contextAfter })));

    const supplement = readFileSync(fresh.deps.paths.supplementFile(paperId, 2));
    const tail = (b: Buffer) => b.subarray(b.indexOf('<sections>'));
    expect(tail(supplement).equals(tail(GOLDEN))).toBe(true);
    // the <metadata> block too: the offline Atom carries SEED_M2_META's values
    expect(supplement.equals(GOLDEN)).toBe(true);
  });
});
