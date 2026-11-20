// Seeds synthetic papers (mock / e2e / contract tests). Owner: supervisor. Uses only committed synthetic fixtures
// (apps/server/test/fixtures) — never real papers.
//
// Four seeds (PLAN_M2 D19, BRIEF_S S7). seedFixture(…, { papers }) defaults to ['m1'] so M1 tests see one paper.
//   m1       SEED_PAPER_ID — the M1 seed, UNCHANGED (code path, the three files' bytes, rows): upload, no arXiv id,
//            synthetic.pdf + synthetic-latexml.html + the M1 supplement.txt.
//   m2       SEED_M2_PAPER_ID — M2 shape: synthetic-m2.pdf + synthetic-m2.html, arXiv 2301.00004v1, supplement v2
//            (serializeSupplementV2 of the structure rows + SEED_M2_META), structureSource 'latexml'.
//   upgrade  SEED_UPGRADE_PAPER_ID — what M1 ingest made: M1 synthetic.pdf, arXiv 2301.00002v1, v1 supplement.txt
//            (buildSupplementV1), no structure rows, structureSource 'none', structureReadyAt set, no warnings, and the
//            finished ingest job M1 import leaves (SEED_UPGRADE_INGEST_JOB_ID: import_arxiv, done, the M1 steps ok) —
//            papers.get's lastJob before an upgrade, which the upgrade must keep (gate G7a).
//   links    SEED_LINKS_PAPER_ID — synthetic-links.pdf, arXiv 2301.00003v1 (= SEED_M2's reference [2]), 1 section,
//            1 reference, supplement v2, no source.html.
// Positions (pdfPage / pdfOffset / pdfRect), page_texts and sha256 values are computed at seed time from that seed's
// PDF — never copied numbers. A position is filled only when the PDF really has the line (the PLAN_M2 3.2 conditions:
// line head = a form of the section number, line tail empty or ':' / '.', an equation tag at the end of its line,
// unique hit); everything else stays null. The structure rows are hand-written equivalents of what A's parser yields
// for synthetic-m2.html (the integration step re-checks them against the real parser).
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { NormRect } from '@study-paper/shared/contracts/domain';
import { serializeSupplementV2, type SupplementIndexInput } from '@study-paper/shared/contracts/supplement';
import { findExactHits, type PageTextLike } from '@study-paper/shared/anchor/matchQuote';
import type { Db, Sqlite } from '../db/client';
import { equations, figures, files, jobs, pageTexts, paperReferences, papers, sections } from '../db/schema';
import { extractPageTexts, PDFJS_VERSION } from '../ingest/pdfText';
import { buildSupplementV1 } from '../ingest/supplement';
import type { DataPaths } from '../paths';

export const SEED_PAPER_ID = '00000000-0000-4000-8000-000000000001';
export const SEED_TITLE = 'A Synthetic Study of Point-to-Point Registration';
export const SEED_UPGRADE_PAPER_ID = '00000000-0000-4000-8000-000000000002';
export const SEED_UPGRADE_TITLE = 'M2 Seed: Upgrade Target';
/** The finished M1 ingest job of SEED_UPGRADE_PAPER_ID (kind import_arxiv, status done). */
export const SEED_UPGRADE_INGEST_JOB_ID = '00000000-0000-4000-8000-000000000102';
export const SEED_LINKS_PAPER_ID = '00000000-0000-4000-8000-000000000003';
export const SEED_LINKS_TITLE = 'M2 Seed: Link Target';
export const SEED_M2_PAPER_ID = '00000000-0000-4000-8000-000000000004';
export const SEED_M2_TITLE = 'M2 Seed: Structured Synthetic Paper';
export const SEED_ARXIV_IDS = { upgrade: '2301.00002', links: '2301.00003', m2: '2301.00004' } as const;
/** metadata of SEED_M2_PAPER_ID's supplement v2 — the golden synthetic.supplement.v2.txt and A's comparison use it. */
export const SEED_M2_META: SupplementIndexInput['meta'] = { title: SEED_M2_TITLE, authors: ['Test Author'], arxivId: SEED_ARXIV_IDS.m2, arxivVersion: 1, year: 2023, primaryCategory: 'cs.RO' };
export const SEED_LINKS_META: SupplementIndexInput['meta'] = { title: SEED_LINKS_TITLE, authors: ['Test Author'], arxivId: SEED_ARXIV_IDS.links, arxivVersion: 1, year: 2023, primaryCategory: 'cs.RO' };
export type SeedPaper = 'm1' | 'm2' | 'upgrade' | 'links';
export const ALL_SEED_PAPERS: readonly SeedPaper[] = ['m1', 'upgrade', 'links', 'm2'];

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES));

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function writeAtomic(paths: DataPaths, dest: string, data: Buffer | string) {
  const part = join(paths.tmpDir, `${randomUUID()}.part`);
  writeFileSync(part, data, { mode: 0o600 });
  renameSync(part, dest);
}

export function supplementV1(title: string): string {
  return `<paper_index>\n<metadata>\ntitle: ${title}\nauthors: Test Author\nsource: synthetic fixture\n</metadata>\n</paper_index>\n`;
}

export interface SeedOptions {
  papers?: readonly SeedPaper[];
}

/**
 * Creates (or recreates) the seed papers with readable + context_ready + structure_ready states. Returns the first
 * id of the list (SEED_PAPER_ID with the default list).
 */
export async function seedFixture(db: Db, sqlite: Sqlite, paths: DataPaths, now = Date.now(), opts: SeedOptions = {}): Promise<string> {
  const list = opts.papers ?? ['m1'];
  const order = ALL_SEED_PAPERS.filter((p) => list.includes(p)); // links before m2: m2's reference [2] points at it
  for (const p of order) {
    if (p === 'm1') await seedM1(db, sqlite, paths, now);
    else if (p === 'upgrade') await seedUpgrade(db, sqlite, paths, now);
    else if (p === 'links') await seedLinks(db, sqlite, paths, now);
    else await seedM2(db, sqlite, paths, now);
  }
  const first = list[0] ?? 'm1';
  return { m1: SEED_PAPER_ID, m2: SEED_M2_PAPER_ID, upgrade: SEED_UPGRADE_PAPER_ID, links: SEED_LINKS_PAPER_ID }[first];
}

// -----------------------------------------------------------------------------------------------------------------
// M1 seed (unchanged)

async function seedM1(db: Db, sqlite: Sqlite, paths: DataPaths, now: number): Promise<void> {
  const id = SEED_PAPER_ID;
  const pdf = fixture('synthetic.pdf');
  const html = fixture('synthetic-latexml.html');
  const supplement = supplementV1(SEED_TITLE);
  const extracted = await extractPageTexts(new Uint8Array(pdf));

  // Recreate from scratch (cascade removes rows; citation triggers remove citations).
  db.delete(papers).where(eq(papers.id, id)).run();
  const dir = paths.paperDir(id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(paths, join(dir, 'paper.pdf'), pdf);
  writeAtomic(paths, join(dir, 'source.html'), html);
  writeAtomic(paths, join(dir, 'supplement.txt'), supplement);

  sqlite.transaction(() => {
    db.insert(papers)
      .values({
        id,
        source: 'upload',
        title: SEED_TITLE,
        authorsJson: JSON.stringify(['Test Author']),
        abstract: 'A synthetic abstract for tests.',
        year: 2000,
        status: 'reading',
        ingestStatus: 'done',
        readableAt: now,
        contextReadyAt: now,
        structureReadyAt: now,
        structureSource: 'latexml',
        contextMode: 'pdf',
        pageCount: extracted.pageCount,
        pdfSha256: sha256(pdf),
        supplementSha256: sha256(supplement),
        supplementVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (const [kind, rel, data, mime] of [
      ['pdf', 'paper.pdf', pdf, 'application/pdf'],
      ['html', 'source.html', html, 'text/html'],
      ['supplement', 'supplement.txt', Buffer.from(supplement), 'text/plain'],
    ] as const) {
      db.insert(files).values({ id: randomUUID(), paperId: id, kind, relPath: `papers/${id}/${rel}`, sha256: sha256(data), bytes: data.length, mime, createdAt: now }).run();
    }
    for (const p of extracted.pages) {
      db.insert(pageTexts).values({ paperId: id, page: p.page, text: p.text, itemsJson: JSON.stringify(p.items), pdfjsVersion: PDFJS_VERSION }).run();
    }
    const s1 = randomUUID();
    const s2 = randomUUID();
    db.insert(sections).values({ id: s1, paperId: id, htmlId: 'S1', number: 'I', title: 'Introduction', level: 1, ordinal: 1, pdfPage: 1 }).run();
    db.insert(sections).values({ id: s2, paperId: id, htmlId: 'S2', number: 'II', title: 'Method', level: 1, ordinal: 2, pdfPage: 2 }).run();
    db.insert(equations).values({ id: randomUUID(), paperId: id, sectionId: s1, htmlId: 'S1.E1', number: '1', ordinal: 1, latexRaw: '\\displaystyle r_{i}=R\\,p_{i}+t-q_{i}', latex: 'r_{i}=R\\,p_{i}+t-q_{i}', katexOk: true, pdfPage: 1 }).run();
    db.insert(equations).values({ id: randomUUID(), paperId: id, sectionId: s2, htmlId: 'S2.E2', number: '2', ordinal: 2, latexRaw: '\\displaystyle T_{k}=T_{k-1}\\,\\Delta T_{k}', latex: 'T_{k}=T_{k-1}\\,\\Delta T_{k}', katexOk: true, pdfPage: 2 }).run();
  })();
}

// -----------------------------------------------------------------------------------------------------------------
// Anchoring at seed time (PLAN_M2 3.2 conditions, computed from the seed's own page texts)

export interface SeedPage {
  page: number;
  text: string;
  items: { start: number; len: number; rect: NormRect }[];
}
export interface SeedAnchor {
  page: number;
  start: number;
  rect: NormRect | null;
}

const lineAround = (text: string, start: number, end: number) => {
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  let le = text.indexOf('\n', end);
  if (le < 0) le = text.length;
  return { head: text.slice(ls, start), tail: text.slice(end, le) };
};
const rectAt = (pages: readonly SeedPage[], page: number, offset: number): NormRect | null =>
  pages.find((p) => p.page === page)?.items.find((i) => offset >= i.start && offset < i.start + i.len)?.rect ?? null;
const like = (pages: readonly SeedPage[]): PageTextLike[] => pages.map((p) => ({ page: p.page, text: p.text }));

/** Line-head forms of a section number: '' for none; else number, number., and for IEEE "III-A" also "A." / "A)". */
export function prefixForms(number: string | null): string[] {
  if (number === null) return [''];
  const forms = [number, `${number}.`];
  if (number.includes('-')) {
    const last = number.split('-').pop()!;
    forms.push(`${last}.`, `${last})`);
  }
  return forms;
}

/** A section heading: the union of hits of the title and its upper case, with the line-head/tail conditions; unique. */
export function anchorSection(pages: readonly SeedPage[], number: string | null, title: string): SeedAnchor | null {
  const seen = new Map<string, { page: number; start: number; end: number }>();
  for (const exact of [title, title.toUpperCase()]) for (const h of findExactHits(like(pages), { exact })) seen.set(`${h.page}:${h.start}`, h);
  const forms = prefixForms(number);
  const ok = [...seen.values()].filter((h) => {
    const { head, tail } = lineAround(pages.find((p) => p.page === h.page)!.text, h.start, h.end);
    return forms.includes(head.trim()) && (tail.trim() === '' || /^[:.]/.test(tail));
  });
  if (ok.length !== 1) return null;
  return { page: ok[0]!.page, start: ok[0]!.start, rect: rectAt(pages, ok[0]!.page, ok[0]!.start) };
}

/** An equation tag "(n)" at the end of its line; unique. */
export function anchorEquation(pages: readonly SeedPage[], number: string): SeedAnchor | null {
  const ok = findExactHits(like(pages), { exact: `(${number})` }).filter((h) => lineAround(pages.find((p) => p.page === h.page)!.text, h.start, h.end).tail.trim() === '');
  if (ok.length !== 1) return null;
  return { page: ok[0]!.page, start: ok[0]!.start, rect: rectAt(pages, ok[0]!.page, ok[0]!.start) };
}

/** A caption: its first ≤ 80 characters found exactly once → that page. */
export function anchorCaption(pages: readonly SeedPage[], caption: string): number | null {
  const hits = findExactHits(like(pages), { exact: caption.slice(0, 80) });
  return hits.length === 1 ? hits[0]!.page : null;
}

// -----------------------------------------------------------------------------------------------------------------
// M2 seeds

interface ArxivSeed {
  id: string;
  title: string;
  arxivId: string;
  pdf: Buffer;
  html: Buffer | null;
  supplement: { text: string; version: 1 | 2; file: string };
  structureSource: 'latexml' | 'none';
  codeUrl?: string;
}

/** Common columns of the three M2 seeds (state readable + contextReady + structureReady). */
async function writeArxivSeed(db: Db, sqlite: Sqlite, paths: DataPaths, now: number, s: ArxivSeed, structure: (pages: SeedPage[]) => void): Promise<void> {
  const extracted = await extractPageTexts(new Uint8Array(s.pdf));
  const pages = extracted.pages as SeedPage[];
  db.delete(papers).where(eq(papers.id, s.id)).run();
  const dir = paths.paperDir(s.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(paths, join(dir, 'paper.pdf'), s.pdf);
  if (s.html) writeAtomic(paths, paths.sourceHtmlFile(s.id), s.html);
  writeAtomic(paths, paths.supplementFile(s.id, s.supplement.version), s.supplement.text);
  sqlite.transaction(() => {
    db.insert(papers)
      .values({
        id: s.id,
        source: 'arxiv',
        arxivId: s.arxivId,
        arxivVersion: 1,
        title: s.title,
        authorsJson: JSON.stringify(['Test Author']),
        abstract: 'A synthetic abstract for tests.',
        year: 2023,
        primaryCategory: 'cs.RO',
        status: 'inbox',
        ingestStatus: 'done',
        ingestWarningsJson: '[]',
        readableAt: now,
        contextReadyAt: now,
        structureReadyAt: now,
        structureSource: s.structureSource,
        contextMode: 'pdf',
        pageCount: extracted.pageCount,
        pdfSha256: sha256(s.pdf),
        supplementSha256: sha256(s.supplement.text),
        supplementVersion: s.supplement.version,
        ...(s.codeUrl ? { codeUrl: s.codeUrl } : {}),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const fileRows: ['pdf' | 'html' | 'supplement', string, Buffer, string][] = [['pdf', 'paper.pdf', s.pdf, 'application/pdf']];
    if (s.html) fileRows.push(['html', 'source.html', s.html, 'text/html']);
    fileRows.push(['supplement', s.supplement.file, Buffer.from(s.supplement.text), 'text/plain']);
    for (const [kind, rel, data, mime] of fileRows) {
      db.insert(files).values({ id: randomUUID(), paperId: s.id, kind, relPath: `papers/${s.id}/${rel}`, sha256: sha256(data), bytes: data.length, mime, createdAt: now }).run();
    }
    for (const p of pages) db.insert(pageTexts).values({ paperId: s.id, page: p.page, text: p.text, itemsJson: JSON.stringify(p.items), pdfjsVersion: PDFJS_VERSION }).run();
    structure(pages);
  })();
}

/** The structure of synthetic-m2.html (hand-written; see that file's header for the expected parse). */
export const SEED_M2_STRUCTURE = {
  sections: [
    { htmlId: 'S1', number: 'I', title: 'Introduction', level: 1, parent: null },
    { htmlId: 'S2', number: 'II', title: 'Method', level: 1, parent: null },
    { htmlId: 'S2.SS1', number: 'II-A', title: 'Robust Kernel', level: 2, parent: 'S2' },
    { htmlId: 'S2.SS2', number: 'II-B', title: 'Implementation Details', level: 2, parent: 'S2' },
  ],
  equations: [
    { htmlId: 'S1.E1', number: '1', section: 'S1', latexRaw: '\\displaystyle r_{i}=R\\,p_{i}+t-q_{i}', latex: 'r_{i}=R\\,p_{i}+t-q_{i}', katexOk: true, contextBefore: 'and gravity is 9.81 m/s^2.', contextAfter: 'Each scan is deskewed with a constant velocity model before matching [1].' },
    { htmlId: 'S2.E2', number: '2', section: 'S2.SS1', latexRaw: '\\displaystyle T_{k}=T_{k-1}\\,\\Delta T_{k}', latex: 'T_{k}=T_{k-1}\\,\\Delta T_{k}', katexOk: true, contextBefore: 'The covariance is propagated with a first-order Jacobian.', contextAfter: 'The method runs at 10 Hz on a single CPU core.' },
    {
      htmlId: 'S2.E3',
      number: '3',
      section: 'S2.SS2',
      latexRaw: '\\begin{gathered} \\displaystyle\\mbox{\\boldmath$v$}_{k}=\\mbox{\\boldmath$v$}_{k-1}+a_{k}\\,\\Delta t \\\\ \\displaystyle{\\mbox{{{R\\/}}}}_{k}={\\mbox{{{R\\/}}}}_{k-1}\\,\\exp(\\omega_{k}\\,\\Delta t) \\end{gathered}',
      latex: '\\begin{gathered} \\boldsymbol{v}_{k}=\\boldsymbol{v}_{k-1}+a_{k}\\,\\Delta t \\\\ \\mathrm{R}_{k}=\\mathrm{R}_{k-1}\\,\\exp(\\omega_{k}\\,\\Delta t) \\end{gathered}',
      katexOk: true,
      contextBefore: 'and the rotation together.',
      contextAfter: 'An unsupported command \\unsupportedcommand is shown as an error. The code is at github.com/example/synthetic-registration.',
    },
    { htmlId: 'S2.E4', number: '4', section: 'S2.SS2', latexRaw: '\\displaystyle\\undefinedmacro{x}+\\undefinedmacrotwo{y}', latex: '\\undefinedmacro{x}+\\undefinedmacrotwo{y}', katexOk: false, contextBefore: 'An unsupported command \\unsupportedcommand is shown as an error. The code is at github.com/example/synthetic-registration.', contextAfter: 'The error of the estimate is written without a number.' },
    { htmlId: 'S2.Ex1', number: null, section: 'S2.SS2', latexRaw: '\\displaystyle e_{k}=\\hat{x}_{k}-x_{k}', latex: 'e_{k}=\\hat{x}_{k}-x_{k}', katexOk: true, contextBefore: 'The error of the estimate is written without a number.', contextAfter: 'Appendix-style numbering: the same tag appears twice below.' },
    { htmlId: 'S2.E5', number: 'A.1', section: 'S2.SS2', latexRaw: '\\displaystyle q_{k}=q_{k-1}\\otimes\\delta q', latex: 'q_{k}=q_{k-1}\\otimes\\delta q', katexOk: true, contextBefore: 'Appendix-style numbering: the same tag appears twice below.', contextAfter: null },
    { htmlId: 'S2.E6', number: 'A.1', section: 'S2.SS2', latexRaw: '\\displaystyle p_{k}=p_{k-1}+v\\,\\Delta t', latex: 'p_{k}=p_{k-1}+v\\,\\Delta t', katexOk: true, contextBefore: 'Appendix-style numbering: the same tag appears twice below.', contextAfter: null },
  ] as { htmlId: string; number: string | null; section: string; latexRaw: string; latex: string; katexOk: boolean; contextBefore: string | null; contextAfter: string | null }[],
  figures: [
    { htmlId: 'S1.F1', kind: 'figure' as const, number: '1', caption: 'Overview of the synthetic registration pipeline.', section: 'S1' },
    { htmlId: 'S2.T1', kind: 'table' as const, number: '1', caption: 'Measured runtime on the synthetic sequence.', section: 'S2.SS2' },
  ],
  references: [
    { htmlId: 'bib.bib1', label: '[1]', rawText: 'A. Placeholder, “A synthetic reference,” Synthetic Journal, 2000.', arxivId: null },
    { htmlId: 'bib.bib2', label: '[2]', rawText: 'B. Placeholder, “A synthetic paper with internal links,” arXiv:2301.00003, 2023.', arxivId: '2301.00003' },
    { htmlId: 'bib.bib3', label: '[3]', rawText: 'C. Placeholder, “A synthetic paper that is not in the library,” arXiv:2301.00099, 2023.', arxivId: '2301.00099' },
  ] as { htmlId: string; label: string; rawText: string; arxivId: string | null }[],
  codeUrl: 'https://github.com/example/synthetic-registration',
};

/** serializeSupplementV2 input of SEED_M2_PAPER_ID (= the golden test/fixtures/synthetic.supplement.v2.txt). */
export function seedM2SupplementInput(): SupplementIndexInput {
  const S = SEED_M2_STRUCTURE;
  const numberOf = (htmlId: string) => S.sections.find((s) => s.htmlId === htmlId)!.number;
  return {
    meta: SEED_M2_META,
    sections: S.sections.map((s) => ({ htmlId: s.htmlId, number: s.number, title: s.title })),
    equations: S.equations.filter((e) => e.number !== null).map((e) => ({ number: e.number!, sectionNumber: numberOf(e.section), latex: e.latex })),
    figures: S.figures.map((f) => ({ kind: f.kind, number: f.number, caption: f.caption })),
    references: S.references.map((r) => ({ label: r.label, rawText: r.rawText })),
  };
}

async function seedM2(db: Db, sqlite: Sqlite, paths: DataPaths, now: number): Promise<void> {
  const S = SEED_M2_STRUCTURE;
  const supplement = serializeSupplementV2(seedM2SupplementInput()).text;
  await writeArxivSeed(
    db,
    sqlite,
    paths,
    now,
    { id: SEED_M2_PAPER_ID, title: SEED_M2_TITLE, arxivId: SEED_ARXIV_IDS.m2, pdf: fixture('synthetic-m2.pdf'), html: fixture('synthetic-m2.html'), supplement: { text: supplement, version: 2, file: 'supplement.v2.txt' }, structureSource: 'latexml', codeUrl: S.codeUrl },
    (pages) => {
      const ids = new Map<string, string>();
      S.sections.forEach((s, i) => {
        const id = randomUUID();
        ids.set(s.htmlId, id);
        const a = anchorSection(pages, s.number, s.title);
        db.insert(sections)
          .values({ id, paperId: SEED_M2_PAPER_ID, parentId: s.parent ? ids.get(s.parent)! : null, htmlId: s.htmlId, number: s.number, title: s.title, level: s.level, ordinal: i + 1, pdfPage: a?.page ?? null, pdfOffset: a?.start ?? null, pdfRectJson: a?.rect ? JSON.stringify(a.rect) : null })
          .run();
      });
      // A number that appears twice (A.1) is ambiguous: never anchored.
      const counts = new Map<string, number>();
      for (const e of S.equations) if (e.number) counts.set(e.number, (counts.get(e.number) ?? 0) + 1);
      S.equations.forEach((e, i) => {
        const a = e.number && counts.get(e.number) === 1 ? anchorEquation(pages, e.number) : null;
        db.insert(equations)
          .values({ id: randomUUID(), paperId: SEED_M2_PAPER_ID, sectionId: ids.get(e.section)!, htmlId: e.htmlId, number: e.number, ordinal: i + 1, latexRaw: e.latexRaw, latex: e.latex, katexOk: e.katexOk, contextBefore: e.contextBefore, contextAfter: e.contextAfter, pdfPage: a?.page ?? null, pdfOffset: a?.start ?? null, pdfRectJson: a?.rect ? JSON.stringify(a.rect) : null })
          .run();
      });
      for (const f of S.figures) {
        db.insert(figures).values({ id: randomUUID(), paperId: SEED_M2_PAPER_ID, sectionId: ids.get(f.section)!, htmlId: f.htmlId, kind: f.kind, number: f.number, caption: f.caption, pdfPage: anchorCaption(pages, f.caption) }).run();
      }
      S.references.forEach((r, i) => {
        db.insert(paperReferences).values({ id: randomUUID(), paperId: SEED_M2_PAPER_ID, ordinal: i + 1, htmlId: r.htmlId, label: r.label, rawText: r.rawText, arxivId: r.arxivId }).run();
      });
    },
  );
}

async function seedUpgrade(db: Db, sqlite: Sqlite, paths: DataPaths, now: number): Promise<void> {
  const supplement = buildSupplementV1({ title: SEED_UPGRADE_TITLE, authors: ['Test Author'], arxivId: SEED_ARXIV_IDS.upgrade, arxivVersion: 1, year: 2023, primaryCategory: 'cs.RO' });
  await writeArxivSeed(
    db,
    sqlite,
    paths,
    now,
    { id: SEED_UPGRADE_PAPER_ID, title: SEED_UPGRADE_TITLE, arxivId: SEED_ARXIV_IDS.upgrade, pdf: fixture('synthetic.pdf'), html: null, supplement: { text: supplement, version: 1, file: 'supplement.txt' }, structureSource: 'none' },
    () => {
      // the finished import job of the M1 ingest (same transaction; removed with the paper by the cascade)
      const steps = [{ step: 'resolve', status: 'ok', detail: `${SEED_ARXIV_IDS.upgrade}v1` }, ...(['metadata', 'pdf', 'text', 'supplement'] as const).map((step) => ({ step, status: 'ok' }))];
      db.insert(jobs).values({ id: SEED_UPGRADE_INGEST_JOB_ID, kind: 'import_arxiv', paperId: SEED_UPGRADE_PAPER_ID, status: 'done', stepsJson: JSON.stringify(steps), error: null, createdAt: now, updatedAt: now }).run();
    },
  );
}

export const SEED_LINKS_STRUCTURE = {
  sections: [{ htmlId: 'S2', number: 'II', title: 'Method' }],
  references: [{ htmlId: 'bib.bib1', label: '[1]', rawText: 'A. Author. A Synthetic Reference. 2000.' }],
};

async function seedLinks(db: Db, sqlite: Sqlite, paths: DataPaths, now: number): Promise<void> {
  const L = SEED_LINKS_STRUCTURE;
  const supplement = serializeSupplementV2({ meta: SEED_LINKS_META, sections: L.sections, equations: [], figures: [], references: L.references.map((r) => ({ label: r.label, rawText: r.rawText })) }).text;
  await writeArxivSeed(
    db,
    sqlite,
    paths,
    now,
    { id: SEED_LINKS_PAPER_ID, title: SEED_LINKS_TITLE, arxivId: SEED_ARXIV_IDS.links, pdf: fixture('synthetic-links.pdf'), html: null, supplement: { text: supplement, version: 2, file: 'supplement.v2.txt' }, structureSource: 'latexml' },
    (pages) => {
      L.sections.forEach((s, i) => {
        const a = anchorSection(pages, s.number, s.title);
        db.insert(sections).values({ id: randomUUID(), paperId: SEED_LINKS_PAPER_ID, htmlId: s.htmlId, number: s.number, title: s.title, level: 1, ordinal: i + 1, pdfPage: a?.page ?? null, pdfOffset: a?.start ?? null, pdfRectJson: a?.rect ? JSON.stringify(a.rect) : null }).run();
      });
      L.references.forEach((r, i) => {
        db.insert(paperReferences).values({ id: randomUUID(), paperId: SEED_LINKS_PAPER_ID, ordinal: i + 1, htmlId: r.htmlId, label: r.label, rawText: r.rawText }).run();
      });
    },
  );
}
