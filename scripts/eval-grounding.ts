// Grounding evaluation (PLAN 5.5). Owner: supervisor. No LLM calls, no network.
// Measures, on real-paper fixtures, what the app's quote matching does with quotes it did not produce itself:
//   positives  = sentences taken from the arXiv LaTeXML HTML of the paper (clean text: no PDF line breaks,
//                hyphenation or ligature glyphs), each with a gold PDF location found by an independent method
//                (NFKC + keep only [a-z0-9], unique occurrence);
//   negatives  = positives with a changed number / negation / word / in-line hyphen / word boundary (two words
//                joined, one word split), plus fabricated sentences.
// Reports: found-rate (verbatim share of positives), position accuracy (page equal, |start| within 2 units),
// and how many negatives were called verbatim (must be 0).
// Usage: SP_DATA_DIR=<dir with fixtures/> npm run eval:grounding -- [--out <dir>] [--per-paper 16]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { matchQuote, type PageTextLike } from '../packages/shared/src/anchor/matchQuote';
import { extractPageTexts } from '../apps/server/src/ingest/pdfText';
import { resolveDataDir } from '../apps/server/src/security/runtimePaths';

const args = process.argv.slice(2);
const argOf = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
import { assertStartupPaths } from '../apps/server/src/security/startupPaths';
if (!process.env.SP_FIXTURES_DIR) assertStartupPaths();
const fixturesDir = process.env.SP_FIXTURES_DIR ?? join(resolveDataDir(), 'fixtures');
const outDir = argOf('--out');
const perPaper = Number(argOf('--per-paper') ?? 16);
const PAPERS = ['2209.15397v2', '2107.06829v1'];

interface Gold {
  page: number;
  start: number;
  end: number;
}
interface Positive {
  paper: string;
  kind: 'sentence' | 'caption';
  quote: string;
  gold: Gold;
  tags: string[];
}
interface Negative {
  paper: string;
  mutation: string;
  quote: string;
  from?: string;
  /** The removed hyphen sits at a PDF line end: `a-\nb` matches both `a-b` and `ab` by design (PLAN 5.3). */
  lineEndHyphen?: boolean;
}

/** Independent locator: NFKC, lower case, keep [a-z0-9] only; returns every occurrence with original offsets. */
function alnumFold(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    for (const ch of s[i]!.normalize('NFKC').toLowerCase()) {
      if (/[a-z0-9]/.test(ch)) {
        text += ch;
        map.push(i);
      }
    }
  }
  return { text, map };
}
function goldLocations(pages: readonly PageTextLike[], quote: string): Gold[] {
  const needle = alnumFold(quote).text;
  const out: Gold[] = [];
  if (needle.length < 20) return out;
  for (const p of pages) {
    const f = alnumFold(p.text);
    for (let i = f.text.indexOf(needle); i >= 0; i = f.text.indexOf(needle, i + 1)) out.push({ page: p.page, start: f.map[i]!, end: f.map[i + needle.length - 1]! + 1 });
  }
  return out;
}

/** Minimal structural type of a linkedom element (the scripts tsconfig has no DOM lib). */
interface El {
  cloneNode(deep: boolean): El;
  querySelectorAll(selector: string): Iterable<El>;
  replaceWith(node: unknown): void;
  textContent: string | null;
}

/** Sentences of paragraphs and captions without math (math renders differently in the PDF text). */
function candidates(html: string): { kind: 'sentence' | 'caption'; text: string }[] {
  const { document } = parseHTML(html);
  const out: { kind: 'sentence' | 'caption'; text: string }[] = [];
  const clean = (el: El) => {
    const c = el.cloneNode(true);
    for (const m of [...c.querySelectorAll('math')]) m.replaceWith(document.createTextNode(' \u0000MATH\u0000 '));
    for (const m of [...c.querySelectorAll('.ltx_tag, .ltx_note, cite')]) m.replaceWith(document.createTextNode(' \u0000REF\u0000 '));
    return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
  };
  const split = (t: string) => t.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const ok = (s: string) => {
    const words = s.split(' ').length;
    return !s.includes('\u0000') && words >= 8 && words <= 40 && /^[A-Z]/.test(s) && /[.!?]$/.test(s);
  };
  for (const p of [...document.querySelectorAll('div.ltx_para p.ltx_p')] as unknown as El[]) for (const s of split(clean(p))) if (ok(s)) out.push({ kind: 'sentence', text: s });
  for (const c of [...document.querySelectorAll('figcaption')] as unknown as El[]) for (const s of split(clean(c))) if (ok(s)) out.push({ kind: 'caption', text: s });
  return out;
}

function pick<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step + step / 2)]!);
}

function mutations(p: Positive, pdfSpan: string): Negative[] {
  const out: Negative[] = [];
  const q = p.quote;
  const num = /\d+(\.\d+)?/.exec(q);
  if (num) out.push({ paper: p.paper, mutation: 'number', from: q, quote: q.replace(num[0], String(Number(num[0]) + 1)) });
  if (/ (is|are|can|does|do) /.test(q)) out.push({ paper: p.paper, mutation: 'negation', from: q, quote: q.replace(/ (is|are|can|does|do) /, (m) => `${m}not `) });
  else if (/ not /.test(q)) out.push({ paper: p.paper, mutation: 'negation', from: q, quote: q.replace(' not ', ' ') });
  const long = [...q.matchAll(/\b[a-z]{8,}\b/g)].map((m) => m[0]);
  if (long.length) out.push({ paper: p.paper, mutation: 'word', from: q, quote: q.replace(long[0]!, long[0] === 'registration' ? 'localization' : 'registration') });
  // Word boundary changes (review M1 of the M1 merge): two words joined, one word split. Never verbatim.
  const pair = /\b([a-z]{4,}) ([a-z]{4,})\b/.exec(q);
  if (pair) out.push({ paper: p.paper, mutation: 'words-joined', from: q, quote: q.replace(pair[0], `${pair[1]}${pair[2]}`) });
  const longWord = /\b([a-z]{4})([a-z]{4,})\b/.exec(q);
  if (longWord) out.push({ paper: p.paper, mutation: 'word-split', from: q, quote: q.replace(longWord[0], `${longWord[1]} ${longWord[2]}`) });
  const hy = /\b([a-z]+)-([a-z]+)\b/i.exec(q);
  if (hy) {
    const atLineEnd = new RegExp(`${hy[1]}-[ \\t]*\\n\\s*${hy[2]}`, 'i').test(pdfSpan);
    out.push({ paper: p.paper, mutation: 'inline-hyphen-removed', from: q, quote: q.replace(hy[0], `${hy[1]}${hy[2]}`), lineEndHyphen: atLineEnd });
  }
  return out;
}

const FABRICATED = [
  'The proposed system relies on a learned feature extractor that is trained on synthetic data only.',
  'We observed that the estimator diverges whenever the vehicle exceeds a speed of forty kilometers per hour.',
  'In contrast to our approach, the baseline requires a pose graph optimization after every tenth scan.',
];

const report: Record<string, unknown>[] = [];
const allPos: Positive[] = [];
const allNeg: Negative[] = [];
const pagesOf = new Map<string, PageTextLike[]>();
for (const paper of PAPERS) {
  const pdf = join(fixturesDir, `${paper}.pdf`);
  const html = join(fixturesDir, `${paper}.html`);
  if (!existsSync(pdf) || !existsSync(html)) {
    console.error(`eval-grounding: fixture ${paper} (.pdf/.html) not found in ${fixturesDir}`);
    process.exit(2);
  }
  const { pages } = await extractPageTexts(new Uint8Array(readFileSync(pdf)));
  pagesOf.set(paper, pages);
  const cands = candidates(readFileSync(html, 'utf8'));
  let unlocated = 0;
  let multi = 0;
  const located: Positive[] = [];
  for (const c of cands) {
    const locs = goldLocations(pages, c.text);
    if (locs.length === 0) unlocated++;
    else if (locs.length > 1) multi++;
    else {
      const g = locs[0]!;
      const span = pages[g.page - 1]!.text.slice(g.start, g.end);
      const tags = [span.includes('\n') ? 'multiline' : 'one-line', ...(/-[ \t]*\n/.test(span) ? ['line-end-hyphen'] : []), ...(/[ﬀ-ﬆ]/.test(span) ? ['ligature'] : [])];
      located.push({ paper, kind: c.kind, quote: c.text, gold: g, tags });
    }
  }
  const sentences = pick(located.filter((p) => p.kind === 'sentence'), perPaper);
  const captions = pick(located.filter((p) => p.kind === 'caption'), 3);
  const chosen = [...sentences, ...captions];
  allPos.push(...chosen);
  for (const p of pick(chosen, 6)) allNeg.push(...mutations(p, pages[p.gold.page - 1]!.text.slice(p.gold.start, p.gold.end)));
  for (const f of FABRICATED) allNeg.push({ paper, mutation: 'fabricated', quote: f });
  report.push({ paper, pages: pages.length, htmlCandidates: cands.length, goldUnique: located.length, goldNotFound: unlocated, goldAmbiguous: multi, positives: chosen.length });
}

const posResults = allPos.map((p) => {
  const m = matchQuote(pagesOf.get(p.paper)!, { exact: p.quote });
  const positionOk = m.status === 'verbatim' && m.position !== undefined && m.position.page === p.gold.page && Math.abs(m.position.start - p.gold.start) <= 2 && Math.abs(m.position.end - p.gold.end) <= 2;
  return { ...p, status: m.status, score: m.score, position: m.position ?? null, positionOk };
});
const negResults = allNeg.map((n) => {
  const m = matchQuote(pagesOf.get(n.paper)!, { exact: n.quote });
  return { ...n, status: m.status, score: m.score };
});

const count = <T extends { status: string }>(xs: T[]) => xs.reduce<Record<string, number>>((a, x) => ({ ...a, [x.status]: (a[x.status] ?? 0) + 1 }), {});
const verb = posResults.filter((r) => r.status === 'verbatim');
const summary = {
  fixturesDir,
  papers: report,
  positives: { total: posResults.length, byStatus: count(posResults), foundRate: verb.length / posResults.length, byTag: Object.fromEntries(['one-line', 'multiline', 'line-end-hyphen', 'ligature'].map((t) => [t, { total: posResults.filter((r) => r.tags.includes(t)).length, verbatim: verb.filter((r) => r.tags.includes(t)).length }])) },
  position: { verbatim: verb.length, correct: verb.filter((r) => r.positionOk).length },
  negatives: { total: negResults.length, byStatus: count(negResults), byMutation: Object.fromEntries([...new Set(negResults.map((n) => n.mutation))].map((mu) => [mu, count(negResults.filter((n) => n.mutation === mu))])), verbatimFalsePositives: negResults.filter((n) => n.status === 'verbatim' && !n.lineEndHyphen).length, verbatimAtLineEndHyphenByDesign: negResults.filter((n) => n.status === 'verbatim' && n.lineEndHyphen).length },
};
console.log(JSON.stringify(summary, null, 2));
for (const r of posResults.filter((r) => r.status !== 'verbatim')) console.log(`positive not verbatim [${r.status} ${r.score.toFixed(2)}] ${r.paper} p${r.gold.page}: ${r.quote.slice(0, 110)}`);
for (const r of verb.filter((r) => !r.positionOk)) console.log(`POSITION MISMATCH ${r.paper}: gold p${r.gold.page}@${r.gold.start} vs p${r.position!.page}@${r.position!.start}: ${r.quote.slice(0, 90)}`);
for (const n of negResults.filter((n) => n.status === 'verbatim')) console.log(`${n.lineEndHyphen ? 'by design (hyphen at a PDF line end)' : 'NEGATIVE CALLED VERBATIM'} [${n.mutation}] ${n.quote.slice(0, 120)}`);
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'grounding_eval.json'), JSON.stringify({ summary, positives: posResults, negatives: negResults }, null, 2));
  console.log(`written ${join(outDir, 'grounding_eval.json')}`);
}
const failed = summary.negatives.verbatimFalsePositives > 0 || summary.position.correct !== summary.position.verbatim;
process.exit(failed ? 1 : 0);
