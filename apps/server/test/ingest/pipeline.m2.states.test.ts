// Owner A. The M2 import (PLAN_M2 3.1): resolve → metadata → pdf → text → html → structure → anchor → supplement →
// terminal. With HTML: v2 + structure in T_struct; without (404 / late / blocked / unparseable): v1 + 'none' + warning.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaperDetailDto } from '@study-paper/shared/contracts/api';
import type { JobSseEvent } from '@study-paper/shared/contracts/sse';
import { IngestError } from '../../src/ingest/errors';
import { configureIngest, ingestService, INGEST_STEPS } from '../../src/ingest/pipeline';
import { FetchError, safeFetchText } from '../../src/ingest/safeFetch';
import { HostQueue } from '../../src/ingest/hostQueue';
import { MENTION_PAIRS_MAX } from '../../src/ingest/latexml';
import { startTestServer, type TestServer } from '../helpers/server';
import { collectJobEvents, FakeArxivSource, freshId, importAndWait, useSource, waitJob } from './helpers';
import { fromSections, GOLDEN_V2, latexmlFootnote, offlineDir, paper, structureCounts, SYN_M2_HTML, SYN_M2_PDF, warnings } from './m2helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function server(o: Parameters<typeof startTestServer>[0] = { env: 'test' }): Promise<TestServer> {
  const s = await startTestServer(o);
  servers.push(s);
  return s;
}
const label = (e: JobSseEvent) => (e.event === 'job.step' ? `${e.data.step}:${e.data.status}` : e.event === 'job.state' ? `state:${e.data.state}` : e.event === 'job.error' ? `error:${e.data.code}` : 'done');
const detail = async (s: TestServer, id: string) => JSON.parse((await s.req(`/api/papers/${id}`, { headers: { 'X-SP-Token': s.token } })).text) as PaperDetailDto;

describe('M2 import with HTML (offline)', () => {
  it('steps in order, readable → context_ready → structure_ready, supplement v2, structureSource latexml, structure rows, files rows', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    const res = ingestService(s.deps).importArxiv(id);
    const events = await collectJobEvents(s.deps, res.jobId!);
    expect(events.map(label)).toEqual([
      'resolve:ok',
      ...['metadata', 'pdf', 'text'].flatMap((x) => [`${x}:running`, `${x}:ok`]),
      'state:readable',
      ...['html', 'structure', 'anchor', 'supplement'].flatMap((x) => [`${x}:running`, `${x}:ok`]),
      'state:context_ready',
      'state:structure_ready',
      'done',
    ]);
    const p = paper(s.deps, res.paperId)!;
    expect(p).toMatchObject({ ingestStatus: 'done', supplementVersion: 2, structureSource: 'latexml', contextMode: 'pdf', codeUrl: 'https://github.com/example/synthetic-registration' });
    expect(p.readableAt! <= p.contextReadyAt! && p.contextReadyAt! <= p.structureReadyAt!).toBe(true);
    expect(warnings(s.deps, res.paperId)).toEqual([]);
    expect(structureCounts(s.deps, res.paperId)).toEqual([4, 7, 2, 3]);
    const v2 = readFileSync(s.deps.paths.supplementFile(res.paperId, 2), 'utf8');
    expect(fromSections(v2)).toBe(fromSections(GOLDEN_V2));
    expect(existsSync(s.deps.paths.supplementFile(res.paperId, 1))).toBe(false);
    expect(readFileSync(s.deps.paths.sourceHtmlFile(res.paperId), 'utf8')).toBe(SYN_M2_HTML);
    const fileKinds = s.deps.sqlite.prepare(`SELECT kind, relPath FROM files WHERE paperId = ? ORDER BY kind`).all(res.paperId);
    expect(fileKinds).toEqual([
      { kind: 'html', relPath: `papers/${res.paperId}/source.html` },
      { kind: 'pdf', relPath: `papers/${res.paperId}/paper.pdf` },
      { kind: 'supplement', relPath: `papers/${res.paperId}/supplement.v2.txt` },
    ]);
    const d = await detail(s, res.paperId);
    expect(d.structureUpgrade).toEqual({ available: false, reason: null, job: null });
    expect(d.lastJob?.steps.map((x) => x.step)).toEqual([...INGEST_STEPS]);
  });
});

describe('M2 import without a usable HTML → v1 + structureSource none + a warning', () => {
  it('HTML 404 → html skipped, structure/anchor skipped, html_not_found, no upgrade', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF }]) });
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(JSON.parse(job.stepsJson).map((x: { step: string; status: string }) => `${x.step}:${x.status}`).slice(4)).toEqual(['html:skipped', 'structure:skipped', 'anchor:skipped', 'supplement:ok']);
    expect(p).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(warnings(s.deps, p.id)).toEqual(['html_not_found']);
    expect(structureCounts(s.deps, p.id)).toEqual([0, 0, 0, 0]);
    expect((await detail(s, p.id)).structureUpgrade).toEqual({ available: false, reason: null, job: null });
  });

  it('HTML late (a transient failure / deadline) → html warn + html_deferred → upgrade available (reason html_deferred)', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1, html: () => Promise.reject(new FetchError('timeout', 'the overall time limit for this arXiv request ran out', undefined, undefined, 'deadline')) } }));
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(JSON.parse(job.stepsJson).find((x: { step: string }) => x.step === 'html')).toMatchObject({ status: 'warn', detail: expect.stringContaining('html_deferred') });
    expect(p).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(warnings(s.deps, p.id)).toEqual(['html_deferred']);
    expect((await detail(s, p.id)).structureUpgrade).toMatchObject({ available: true, reason: 'html_deferred' });
    expect((await detail(s, p.id)).structureUpgradeAvailable).toBe(true);
  });

  it('the network guard refused the HTML (blocked_url with a NetworkDisabledError cause) → html_deferred, step detail network_disabled', async () => {
    const s = await server();
    const id = freshId();
    // The real guard: safeFetch with SP_NETWORK=off refuses before any fetch (no fetchImpl is ever called).
    const guarded = async () => {
      const prev = process.env.SP_NETWORK;
      process.env.SP_NETWORK = 'off';
      try {
        return (await safeFetchText(`https://arxiv.org/html/${id}v1`, { kind: 'html', queue: new HostQueue(), fetchImpl: () => Promise.reject(new Error('fetch must not run')) })).text;
      } finally {
        if (prev === undefined) delete process.env.SP_NETWORK;
        else process.env.SP_NETWORK = prev;
      }
    };
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1, html: guarded } }));
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(JSON.parse(job.stepsJson).find((x: { step: string }) => x.step === 'html')).toEqual({ step: 'html', status: 'warn', detail: 'html_deferred: network_disabled' });
    expect(warnings(s.deps, p.id)).toEqual(['html_deferred']);
    expect(p).toMatchObject({ supplementVersion: 1, structureSource: 'none', ingestStatus: 'done' });
  });

  it('a real blocked URL (not the guard) is also deferred but without network_disabled', async () => {
    const s = await server();
    const id = freshId();
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1, html: () => Promise.reject(new FetchError('blocked_url', 'host evil.example is not allowed')) } }));
    const { job } = await importAndWait(s.deps, id);
    expect(JSON.parse(job.stepsJson).find((x: { step: string }) => x.step === 'html')).toEqual({ step: 'html', status: 'warn', detail: 'html_deferred: host evil.example is not allowed' });
  });

  it('structure parse failure → structure warn + structure_parse_failed, then v1; anchor skipped', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: '<!DOCTYPE html><html><body><p>not LaTeXML</p></body></html>' }]) });
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(JSON.parse(job.stepsJson).map((x: { step: string; status: string }) => `${x.step}:${x.status}`).slice(4)).toEqual(['html:ok', 'structure:warn', 'anchor:skipped', 'supplement:ok']);
    expect(p).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(warnings(s.deps, p.id)).toEqual(['structure_parse_failed']);
    expect((await detail(s, p.id)).structureUpgrade.available).toBe(false);
    // the HTML whose structure failed for good is not kept without a files row
    expect(existsSync(s.deps.paths.sourceHtmlFile(p.id))).toBe(false);
    expect(s.deps.sqlite.prepare(`SELECT kind FROM files WHERE paperId = ? ORDER BY kind`).all(p.id)).toEqual([{ kind: 'pdf' }, { kind: 'supplement' }]);
  });

  it('an unexpected exception after the parse (normalize / KaTeX) → structure warn + structure_parse_failed, v1, source.html removed; job done', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    configureIngest(s.deps, {
      inject: (point) => {
        if (point === 'structure.parsed') throw new Error('injected post-parse failure');
      },
    });
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    const steps = JSON.parse(job.stepsJson) as { step: string; status: string; detail?: string }[];
    expect(steps.map((x) => `${x.step}:${x.status}`).slice(4)).toEqual(['html:ok', 'structure:warn', 'anchor:skipped', 'supplement:ok']);
    expect(steps.find((x) => x.step === 'structure')!.detail).toContain('injected post-parse failure');
    expect(p).toMatchObject({ ingestStatus: 'done', supplementVersion: 1, structureSource: 'none' });
    expect(warnings(s.deps, p.id)).toEqual(['structure_parse_failed']);
    expect(structureCounts(s.deps, p.id)).toEqual([0, 0, 0, 0]);
    expect(existsSync(s.deps.paths.sourceHtmlFile(p.id))).toBe(false);
  });

  it('the HTML of another version (arXiv:<id>v2 in the text) → html_version_mismatch, the HTML file is dropped, v1', async () => {
    const id = freshId();
    const html = SYN_M2_HTML.replace('arXiv:0000.00001v1</p>', `arXiv:${id}v2</p>`);
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html }]) });
    const { paper: p } = await importAndWait(s.deps, id);
    expect(warnings(s.deps, p.id)).toEqual(['html_version_mismatch']);
    expect(p).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(existsSync(s.deps.paths.sourceHtmlFile(p.id))).toBe(false);
  });

  it('v1 ×1,000 then v2 in the text → still html_version_mismatch: the decision is not bound to the mention list cap (M-M2-R2-5)', async () => {
    const id = freshId();
    const html = SYN_M2_HTML.replace('arXiv:0000.00001v1</p>', `${`arXiv:${id}v1 `.repeat(1_000)}arXiv:${id}v2</p>`);
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html }]) });
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(warnings(s.deps, p.id)).toEqual(['html_version_mismatch']);
    expect(p).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(structureCounts(s.deps, p.id)).toEqual([0, 0, 0, 0]);
    expect(existsSync(s.deps.paths.sourceHtmlFile(p.id))).toBe(false);
  });

  const inAbstract = (m: string) => SYN_M2_HTML.replace('arXiv:0000.00001v1</p>', `arXiv:0000.00001v1</p>${m}`);
  /** `n` distinct pairs of other papers (2302.*, never a freshId), written with "." as an entity or not. */
  const pairs = (n: number, dot = '.') => `<p>${Array.from({ length: n }, (_, k) => `arXiv:2302${dot}${String(10_000 + k)}v1`).join(' ')}</p>`;
  const stepsOf = (stepsJson: string) => JSON.parse(stepsJson) as { step: string; status: string; detail?: string }[];
  // more distinct pairs than the list keeps: the version cannot be told → the same end as another version (M-M2-R2-5 a,
  // the pipeline's `unknown` → html_version_mismatch; A-F4R1-04). The fixture's abstract names one pair (0000.00001v1).
  it.each([
    ['in the raw HTML (the html step)', pairs(MENTION_PAIRS_MAX), 'html'],
    ['in the parsed text only, the "." written as an entity (the structure step)', pairs(MENTION_PAIRS_MAX, '&#46;'), 'structure'],
  ])('more than MENTION_PAIRS_MAX distinct arXiv pairs %s → html_version_mismatch, rows 0, the HTML file dropped, v1', async (_n, extra, step) => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: inAbstract(extra) }]) });
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    const steps = stepsOf(job.stepsJson);
    expect(steps.find((x) => x.step === step)).toMatchObject({ status: 'warn' });
    expect(steps.find((x) => x.step === step)!.detail).toContain(`more than ${MENTION_PAIRS_MAX} distinct arXiv versions`);
    if (step === 'structure') expect(steps.find((x) => x.step === 'html')).toMatchObject({ status: 'ok' });
    expect(warnings(s.deps, p.id)).toEqual(['html_version_mismatch']);
    expect(p).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(structureCounts(s.deps, p.id)).toEqual([0, 0, 0, 0]);
    expect(existsSync(s.deps.paths.sourceHtmlFile(p.id))).toBe(false);
  });
  it('exactly MENTION_PAIRS_MAX distinct pairs (with the paper itself, v1) in both readings → no overflow: v2, latexml, no warning', async () => {
    const id = freshId();
    // the abstract pair + the paper's own pair + MAX − 2 others = MAX
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: inAbstract(`<p>arXiv:${id}v1</p>${pairs(MENTION_PAIRS_MAX - 2)}`) }]) });
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(stepsOf(job.stepsJson).filter((x) => x.step === 'html' || x.step === 'structure').map((x) => x.status)).toEqual(['ok', 'ok']);
    expect(warnings(s.deps, p.id)).toEqual([]);
    expect(p).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
  });

  it.each([
    ['an entity', (id: string) => inAbstract(`<p>arXiv:${id.replace('.', '&#46;')}v2</p>`)],
    ['an inline element', (id: string) => inAbstract(`<p>arXiv:${id.split('.')[0]}.<b>${id.split('.')[1]}</b>v2</p>`)],
    // text before the first element stays at document level in linkedom: the walk reads it too (A-F4R1-01)
    ['an entity before the doctype', (id: string) => `arXiv:${id.replace('.', '&#46;')}v2${SYN_M2_HTML}`],
    ['an inline element between the doctype and <html>', (id: string) => SYN_M2_HTML.replace('<!DOCTYPE html>', `<!DOCTYPE html>arXiv:${id.split('.')[0]}.<b>${id.split('.')[1]}</b>v2`)],
    // an empty sup or sub draws nothing: it does not separate the mention it splits (A-FX5-R1-01)
    ['an empty sup', (id: string) => inAbstract(`<p>arXiv:${id}<sup></sup>v2</p>`)],
    ['an empty sub inside an inline element', (id: string) => inAbstract(`<p>arXiv:${id.split('.')[0]}.<b>${id.split('.')[1]}<sub></sub></b>v2</p>`)],
  ])('another version in the parsed text only (%s) → structure warn + html_version_mismatch, the HTML file dropped, v1 — the end of the html step check (M-M2-R2-5)', async (_n, page) => {
    const id = freshId();
    const html = page(id);
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html }]) });
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    const steps = JSON.parse(job.stepsJson) as { step: string; status: string; detail?: string }[];
    expect(steps.map((x) => `${x.step}:${x.status}`).slice(4)).toEqual(['html:ok', 'structure:warn', 'anchor:skipped', 'supplement:ok']);
    expect(steps.find((x) => x.step === 'structure')!.detail).toContain('html_version_mismatch');
    expect(warnings(s.deps, p.id)).toEqual(['html_version_mismatch']);
    expect(p).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(structureCounts(s.deps, p.id)).toEqual([0, 0, 0, 0]);
    expect(existsSync(s.deps.paths.sourceHtmlFile(p.id))).toBe(false);
    expect(s.deps.sqlite.prepare(`SELECT kind FROM files WHERE paperId = ? ORDER BY kind`).all(p.id)).toEqual([{ kind: 'pdf' }, { kind: 'supplement' }]);
    expect((await detail(s, p.id)).structureUpgrade.available).toBe(false);
  });

  // A-FX-01: the paper's own version followed by text drawn raised (LaTeXML's footnote mark, a superscript citation) is
  // the own version in both readings — the parsed text separates sup and sub — so the structure is published.
  // A-FX5-R2-01: also when a sup holding text (LaTeXML's affiliation mark) comes earlier in the document
  it.each<[string, string, string?]>([
    ["LaTeXML's footnote mark", latexmlFootnote(1)],
    ['a superscript', '<sup class="ltx_sup">3</sup>'],
    ["LaTeXML's footnote mark, after an affiliation mark earlier in the paragraph", latexmlFootnote(1), 'A. Author<sup class="ltx_sup">1</sup>. '],
  ])("the paper's own version followed by %s → the HTML is accepted: v2, latexml, structure rows, no warning (A-FX-01)", async (_n, after, before = '') => {
    const id = freshId();
    const html = inAbstract(`<p>${before}A preprint is available as arXiv:${id}v1${after}.</p>`);
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html }]) });
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    const steps = JSON.parse(job.stepsJson) as { step: string; status: string }[];
    expect(steps.map((x) => `${x.step}:${x.status}`).slice(4)).toEqual(['html:ok', 'structure:ok', 'anchor:ok', 'supplement:ok']);
    expect(warnings(s.deps, p.id)).toEqual([]);
    expect(p).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
    expect(structureCounts(s.deps, p.id)).toEqual([4, 7, 2, 3]);
    expect(readFileSync(s.deps.paths.sourceHtmlFile(p.id), 'utf8')).toBe(html);
  });

  it('another version only inside a comment, a script, a style or an unterminated trailing comment → the HTML is accepted (v2, latexml, no warning) (A-P2-01)', async () => {
    const hidden = (id: string, i: number) =>
      [
        SYN_M2_HTML.replace('<body>', `<body><!-- arXiv:${id}v2 -->`),
        SYN_M2_HTML.replace('</head>', `<script>var v = "arXiv:${id}v2";</script><style>/* arXiv:${id}v3 */</style></head>`),
        `${SYN_M2_HTML}<!-- arXiv:${id}v2 (never closed)`,
      ][i]!;
    const ids = [freshId(), freshId(), freshId()];
    const s = await server({ env: 'test', offlineDir: offlineDir(ids.map((id, i) => ({ id, version: 1, pdf: SYN_M2_PDF, html: hidden(id, i) }))) });
    for (const [i, id] of ids.entries()) {
      const { job, paper: p } = await importAndWait(s.deps, id);
      expect(job.status, `case ${i}`).toBe('done');
      expect(warnings(s.deps, p.id), `case ${i}`).toEqual([]);
      expect(p, `case ${i}`).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
      expect(readFileSync(s.deps.paths.sourceHtmlFile(p.id), 'utf8'), `case ${i}`).toBe(hidden(id, i));
    }
  });

  it('another version in the text after a comment, a script and a style → still html_version_mismatch (A-P2-01)', async () => {
    const id = freshId();
    const html = SYN_M2_HTML.replace('<body>', `<body><!-- arXiv:${id}v1 --><script>"arXiv:${id}v1"</script><style>a{}</style>`).replace('arXiv:0000.00001v1</p>', `arXiv:${id}v2</p>`);
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html }]) });
    const { paper: p } = await importAndWait(s.deps, id);
    expect(warnings(s.deps, p.id)).toEqual(['html_version_mismatch']);
    expect(p).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(existsSync(s.deps.paths.sourceHtmlFile(p.id))).toBe(false);
  });

  it('another version in the text after an svg icon with a self-closed <style/>/<script/> → still html_version_mismatch (A-F7-01)', async () => {
    const id = freshId();
    const icon = '<svg width="1" height="1"><style/><script/><path d="M0 0"/></svg>';
    const html = SYN_M2_HTML.replace('<body>', `<body>${icon}`).replace('arXiv:0000.00001v1</p>', `arXiv:${id}v2</p>`);
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html }]) });
    const { paper: p } = await importAndWait(s.deps, id);
    expect(warnings(s.deps, p.id)).toEqual(['html_version_mismatch']);
    expect(p).toMatchObject({ supplementVersion: 1, structureSource: 'none' });
    expect(existsSync(s.deps.paths.sourceHtmlFile(p.id))).toBe(false);
  });
});

describe('budgets and anchor exceptions keep the structure (v2)', () => {
  const posCols = (s: TestServer, id: string) => ({
    sections: s.deps.sqlite.prepare(`SELECT pdfPage, pdfRectJson FROM sections WHERE paperId = ? ORDER BY ordinal`).all(id) as { pdfPage: number | null; pdfRectJson: string | null }[],
    equations: s.deps.sqlite.prepare(`SELECT number, pdfPage, pdfRectJson, katexOk FROM equations WHERE paperId = ? ORDER BY ordinal`).all(id) as { number: string | null; pdfPage: number | null; pdfRectJson: string | null; katexOk: number }[],
    figures: s.deps.sqlite.prepare(`SELECT pdfPage FROM figures WHERE paperId = ? ORDER BY htmlId`).all(id) as { pdfPage: number | null }[],
  });
  const stepOf = (job: { stepsJson: string }, step: string) => (JSON.parse(job.stepsJson) as { step: string; status: string; detail?: string }[]).find((x) => x.step === step)!;

  it('KaTeX budget 0 and anchor work 0 → job done, v2 bytes identical to the default run, katexOk all 0, every position null, katex_budget + anchor_budget, structure/anchor warn', async () => {
    const a = freshId();
    const b = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id: a, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }, { id: b, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML.replaceAll('0000.00001', b) }]) });
    const base = await importAndWait(s.deps, a);
    expect(base.job.status).toBe('done');
    expect(warnings(s.deps, base.paper.id)).toEqual([]);
    const basePos = posCols(s, base.paper.id);
    expect(basePos.equations.some((e) => e.katexOk === 1)).toBe(true);
    expect(basePos.sections.some((x) => x.pdfPage !== null)).toBe(true);

    configureIngest(s.deps, { katexBudgetMs: 0, anchorWork: 0 });
    const zero = await importAndWait(s.deps, b);
    expect(zero.job.status).toBe('done');
    expect(zero.paper).toMatchObject({ ingestStatus: 'done', supplementVersion: 2, structureSource: 'latexml' });
    expect(warnings(s.deps, zero.paper.id).sort()).toEqual(['anchor_budget', 'katex_budget']);
    expect(stepOf(zero.job, 'structure')).toMatchObject({ status: 'warn', detail: expect.stringContaining('katex_budget') });
    expect(stepOf(zero.job, 'anchor')).toMatchObject({ status: 'warn', detail: expect.stringContaining('anchor_budget') });
    // The supplement never carries katexOk or positions: the same <sections>… body (the metadata differs only by id).
    const v2a = readFileSync(s.deps.paths.supplementFile(base.paper.id, 2), 'utf8');
    const v2b = readFileSync(s.deps.paths.supplementFile(zero.paper.id, 2), 'utf8');
    expect(fromSections(v2b)).toBe(fromSections(v2a));
    expect(fromSections(v2b)).toBe(fromSections(GOLDEN_V2));
    const pos = posCols(s, zero.paper.id);
    expect(structureCounts(s.deps, zero.paper.id)).toEqual(structureCounts(s.deps, base.paper.id));
    expect(pos.equations.every((e) => e.katexOk === 0)).toBe(true);
    expect(pos.sections.every((x) => x.pdfPage === null && x.pdfRectJson === null)).toBe(true);
    expect(pos.equations.every((x) => x.pdfPage === null && x.pdfRectJson === null)).toBe(true);
    expect(pos.figures.every((x) => x.pdfPage === null)).toBe(true);
  });

  it('a numbered equation whose latexRaw was cut at a parser cap (A-R3-03) → katexOk 0 although KaTeX draws the part, structure_truncated, structure kept', async () => {
    // S1.E1's holder (table[id]) gets a row of 11,000 filler nodes after its math row: the walk stops at HOLDER_STEPS
    const marker = '<td class="ltx_eqn_cell ltx_eqn_center_padright"></td>';
    const at = SYN_M2_HTML.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    const end = SYN_M2_HTML.indexOf('</table>', at);
    const html = `${SYN_M2_HTML.slice(0, end)}<tr><td>${'<b>w</b>'.repeat(11_000)}</td></tr>${SYN_M2_HTML.slice(end)}`;
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html }]) });
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(p).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
    expect(warnings(s.deps, p.id)).toEqual(['structure_truncated']);
    const eq = s.deps.sqlite.prepare(`SELECT number, latexRaw, katexOk FROM equations WHERE paperId = ? ORDER BY ordinal`).all(p.id) as { number: string | null; latexRaw: string; katexOk: number }[];
    expect(eq[0]).toEqual({ number: '1', latexRaw: '\\displaystyle r_{i}=R\\,p_{i}+t-q_{i}…', katexOk: 0 });
    // the other equations keep the default katexOk (2 and 3 true, 4 false)
    expect(eq.slice(1, 4).map((e) => e.katexOk)).toEqual([1, 1, 0]);
    expect(stepOf(job, 'structure')).toMatchObject({ status: 'warn', detail: expect.stringContaining('structure_truncated') });
  });

  it('an unexpected exception inside the anchor step of an import → anchor warn, every position null, v2 published, job done', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    configureIngest(s.deps, {
      inject: (point) => {
        if (point === 'anchor.run') throw new Error('injected anchor exception');
      },
    });
    const { job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(JSON.parse(job.stepsJson).map((x: { step: string; status: string }) => `${x.step}:${x.status}`).slice(4)).toEqual(['html:ok', 'structure:ok', 'anchor:warn', 'supplement:ok']);
    expect(stepOf(job, 'anchor').detail).toContain('anchor_failed: injected anchor exception');
    expect(p).toMatchObject({ ingestStatus: 'done', supplementVersion: 2, structureSource: 'latexml' });
    expect(p.structureReadyAt).not.toBeNull();
    // S-3: its own code (anchor_budget is only the work budget); not a final warning — the structure is kept
    expect(warnings(s.deps, p.id)).toEqual(['anchor_failed']);
    expect(stepOf(job, 'anchor').detail).not.toContain('anchor_budget');
    expect(structureCounts(s.deps, p.id)).toEqual([4, 7, 2, 3]);
    const pos = posCols(s, p.id);
    expect([...pos.sections, ...pos.equations, ...pos.figures].every((x) => x.pdfPage === null)).toBe(true);
    expect(fromSections(readFileSync(s.deps.paths.supplementFile(p.id, 2), 'utf8'))).toBe(fromSections(GOLDEN_V2));
    expect(readFileSync(s.deps.paths.sourceHtmlFile(p.id), 'utf8')).toBe(SYN_M2_HTML);
  });
});

describe('failure and retry', () => {
  it('a failure at anchor → job failed; retry runs html … supplement again and reaches v2', async () => {
    const id = freshId();
    let fail = true;
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    configureIngest(s.deps, {
      beforeStep: (step) => {
        if (step === 'anchor' && fail) throw new Error('injected anchor failure');
      },
    });
    const { res, job, paper: p } = await importAndWait(s.deps, id);
    expect(job.status).toBe('failed');
    expect(p).toMatchObject({ ingestStatus: 'failed', supplementVersion: null, contextReadyAt: null });
    expect(structureCounts(s.deps, p.id)).toEqual([0, 0, 0, 0]);
    fail = false;
    const { jobId } = ingestService(s.deps).retry(res.paperId);
    const retried = await waitJob(s.deps, jobId);
    expect(JSON.parse(retried.stepsJson).map((x: { step: string; status: string }) => `${x.step}:${x.status}`)).toEqual(['resolve:skipped', 'metadata:skipped', 'pdf:skipped', 'text:skipped', 'html:ok', 'structure:ok', 'anchor:ok', 'supplement:ok']);
    expect(paper(s.deps, p.id)).toMatchObject({ ingestStatus: 'done', supplementVersion: 2, structureSource: 'latexml' });
    expect(structureCounts(s.deps, p.id)).toEqual([4, 7, 2, 3]);
  });

  it('interrupted by a shutdown mid-structure → interrupted after restart; retry completes with v2', async () => {
    const id = freshId();
    const s = await server({ env: 'test', offlineDir: offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }]) });
    let entered!: () => void;
    const at = new Promise<void>((r) => (entered = r));
    configureIngest(s.deps, {
      beforeStep: (step, _job, signal) => {
        if (step !== 'structure') return;
        entered();
        return new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new IngestError('cancelled', 'aborted')), { once: true }));
      },
    });
    const res = ingestService(s.deps).importArxiv(id);
    await at;
    const s2 = await s.restart();
    servers.splice(servers.indexOf(s), 1, s2);
    expect(s2.deps.sqlite.prepare(`SELECT status FROM jobs WHERE id = ?`).get(res.jobId)).toEqual({ status: 'interrupted' });
    expect(paper(s2.deps, res.paperId)).toMatchObject({ ingestStatus: 'interrupted', supplementVersion: null });
    configureIngest(s2.deps, { beforeStep: undefined });
    const { jobId } = ingestService(s2.deps).retry(res.paperId);
    expect((await waitJob(s2.deps, jobId)).status).toBe('done');
    expect(paper(s2.deps, res.paperId)).toMatchObject({ supplementVersion: 2, structureSource: 'latexml' });
  });
});
