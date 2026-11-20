// Structure evaluation (PLAN_M2 3.2 수용 수치 / 7절 4, BRIEF_INTEGRATION I5). Owner: supervisor. No LLM, no network.
// For the two real-paper fixtures: extractPageTexts (frozen) → A's parse · normalizeForStore · katexCheckAll ·
// anchorStructure · buildSupplementInput (imported, no rule of our own) → compared with the adjudicated gold
// (apps/server/test/fixtures/structure-gold.json) by scripts/lib/structureEval.ts, offset by offset.
// What this measures is agreement with those 100 gold items (IEEE two-column papers, 2 of them) — nothing wider.
// Usage: SP_DATA_DIR=<dir with fixtures/> npm run eval:structure -- --out <dir>
//        (fixtures: SP_FIXTURES_DIR, else $SP_DATA_DIR/fixtures; neither set or a fixture missing → exit 2)
// Exit: 0 every PLAN 3.2 row holds · 1 a row fails · 2 usage / missing fixtures (nothing written).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serializeSupplementV2, SUPPLEMENT_CAPS } from '../packages/shared/src/contracts/supplement';
import { anchorStructure, type AnchorPage } from '../apps/server/src/ingest/anchorStructure';
import { structureOf } from './lib/evalStructureInput';
import { extractPageTexts } from '../apps/server/src/ingest/pdfText';
import { buildSupplementInput } from '../apps/server/src/ingest/structureStore';
import { checkNumberSequence, compareWithGold, summaryLine, type GoldItem, type KindComparison, type ParserItem } from './lib/structureEval';

const SUPPLEMENT_MAX_CHARS = 120_000;
const GOLD_FILE = new URL('../apps/server/test/fixtures/structure-gold.json', import.meta.url);

/** PLAN_M2 3.2 수용 수치 (per paper). */
interface Expect {
  arxivId: string;
  version: number;
  sections: number;
  topLevel: number;
  /** Exactly these numbers, DOM order. */
  numbers: string[];
  /** KISS-ICP: every numbered equation's htmlId (DOM order). FAST-LIO2: only the group-tag equations' htmlIds. */
  htmlIds: { scope: 'all' | 'group'; ids: string[] };
  references: number;
  ltxErrors: number;
  katexOkMin: number;
  sectionsMatchedMin: number;
  equationsMatchedMin: number;
}
const range = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
const EXPECT: Record<string, Expect> = {
  '2209.15397v2': {
    arxivId: '2209.15397',
    version: 2,
    sections: 18,
    topLevel: 6,
    numbers: range(15),
    htmlIds: { scope: 'all', ids: range(15).map((n) => `S3.E${n}`) },
    references: 36,
    ltxErrors: 0,
    katexOkMin: 14,
    sectionsMatchedMin: 18,
    equationsMatchedMin: 14,
  },
  '2107.06829v1': {
    arxivId: '2107.06829',
    version: 1,
    sections: 48,
    topLevel: 9,
    numbers: range(19),
    htmlIds: { scope: 'group', ids: ['S4.E2', 'S4.E6', 'S4.E10', 'S5.E17', 'S5.E18'] },
    references: 63,
    ltxErrors: 3,
    katexOkMin: 18,
    sectionsMatchedMin: 46,
    equationsMatchedMin: 17,
  },
};

function usage(msg: string): never {
  console.error(`eval-structure: ${msg}\nusage: npm run eval:structure -- --out <dir>   (fixtures: SP_FIXTURES_DIR or $SP_DATA_DIR/fixtures)`);
  process.exit(2);
}

const args = process.argv.slice(2);
const argOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
for (const a of args) if (a.startsWith('--') && a !== '--out') usage(`unknown option ${a}`);
const outArg = argOf('--out');
if (!outArg || outArg.startsWith('--')) usage('--out <dir> is required');
// Never fall back to the default data directory (the user's real data): one of the two env values must be given.
const fixturesEnv = process.env.SP_FIXTURES_DIR ?? (process.env.SP_DATA_DIR ? join(process.env.SP_DATA_DIR, 'fixtures') : undefined);
if (!fixturesEnv) usage('set SP_FIXTURES_DIR or SP_DATA_DIR (the default data directory is never read)');
const fixturesDir = resolve(fixturesEnv);
for (const id of Object.keys(EXPECT)) for (const ext of ['pdf', 'html']) if (!existsSync(join(fixturesDir, `${id}.${ext}`))) usage(`fixture ${id}.${ext} not found in ${fixturesDir}`);
if (!existsSync(GOLD_FILE)) usage('apps/server/test/fixtures/structure-gold.json not found');
const outDir = resolve(outArg);

type GoldFile = Record<string, { sections: GoldItem[]; equations: GoldItem[] }>;
const gold = JSON.parse(readFileSync(GOLD_FILE, 'utf8')) as GoldFile;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

interface Check {
  id: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

const papers: Record<string, unknown>[] = [];
const totals = { gold: 0, matched: 0, null: 0, mismatched: 0, extra: 0, missing: 0, orderViolations: 0 };
let allPass = true;
const brief: Record<string, unknown>[] = [];

for (const [id, exp] of Object.entries(EXPECT)) {
  const g = gold[id];
  if (!g) usage(`gold has no entry for ${id}`);
  const html = readFileSync(join(fixturesDir, `${id}.html`), 'utf8');
  const pdf = readFileSync(join(fixturesDir, `${id}.pdf`));
  const { pages: extracted } = await extractPageTexts(new Uint8Array(pdf));
  const pages: AnchorPage[] = extracted.map((p) => ({ page: p.page, text: p.text, items: p.items }));

  const run1 = await structureOf(html);
  const { parsed, latex } = run1;
  const a = await anchorStructure(parsed.sections, parsed.equations, parsed.figures, pages);

  // positions (document order)
  const secItems: ParserItem[] = parsed.sections.map((s, i) => ({ htmlId: s.htmlId, number: s.number, pos: a.sections[i] ? { page: a.sections[i]!.page, start: a.sections[i]!.start } : null }));
  const numberedIdx = parsed.equations.flatMap((e, i) => (e.number === null ? [] : [i]));
  const eqItems: ParserItem[] = numberedIdx.map((i) => ({ htmlId: parsed.equations[i]!.htmlId, number: parsed.equations[i]!.number, pos: a.equations[i] ? { page: a.equations[i]!.page, start: a.equations[i]!.start } : null }));
  const sec = compareWithGold('sections', g.sections, secItems);
  const eq = compareWithGold('equations', g.equations, eqItems);

  // stages of the confirmed numbered equations / sections (A exports them)
  const eqStages = { s1: 0, s2: 0, s3: 0 };
  for (const i of numberedIdx) {
    const st = a.equationStages[i];
    if (st) eqStages[st]++;
  }
  const secStages = { s1: a.sectionStages.filter((x) => x === 's1').length, s2: a.sectionStages.filter((x) => x === 's2').length };

  // supplement v2: two independent runs of the structure step → serialize → same bytes. Fixed meta (no Atom feed).
  const meta = { title: `fixture ${id}`, authors: [] as string[], arxivId: exp.arxivId, arxivVersion: exp.version, year: null, primaryCategory: null };
  const sup1 = serializeSupplementV2(buildSupplementInput(parsed, latex, meta));
  const run2 = await structureOf(html);
  const sup2 = serializeSupplementV2(buildSupplementInput(run2.parsed, run2.latex, meta));

  const numbers = parsed.equations.map((e) => e.number);
  const seq = checkNumberSequence(numbers);
  const numberedNumbers = numberedIdx.map((i) => parsed.equations[i]!.number);
  const scopedIds = numberedIdx.filter((i) => exp.htmlIds.scope === 'all' || parsed.equations[i]!.group).map((i) => parsed.equations[i]!.htmlId);
  const katexOk = numberedIdx.filter((i) => latex[i]!.katexOk).length;
  const topLevel = parsed.sections.filter((s) => s.parentIndex === null).length;

  const checks: Check[] = [];
  const add = (cid: string, expected: unknown, actual: unknown, pass: boolean) => checks.push({ id: cid, expected, actual, pass });
  const eqJson = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  // the gold itself is complete (a dropped gold item would otherwise lower the bar of the ≥ rows below)
  add('gold.sections', exp.sections, g.sections.length, g.sections.length === exp.sections);
  add('gold.equations', exp.numbers.length, g.equations.length, g.equations.length === exp.numbers.length);
  add('sections', exp.sections, parsed.sections.length, parsed.sections.length === exp.sections);
  add('sections.topLevel', exp.topLevel, topLevel, topLevel === exp.topLevel);
  add('equations.numbers', exp.numbers, numberedNumbers, eqJson(numberedNumbers, exp.numbers));
  add(exp.htmlIds.scope === 'all' ? 'equations.htmlIds' : 'equations.groupTagHtmlIds', exp.htmlIds.ids, scopedIds, eqJson(scopedIds, exp.htmlIds.ids));
  add('references', exp.references, parsed.references.length, parsed.references.length === exp.references);
  add('ltxErrors', exp.ltxErrors, parsed.ltxErrors, parsed.ltxErrors === exp.ltxErrors);
  add('katexOk (numbered) ≥', exp.katexOkMin, katexOk, katexOk >= exp.katexOkMin);
  add('sections.matched ≥', exp.sectionsMatchedMin, sec.matched, sec.matched >= exp.sectionsMatchedMin);
  add('equations.matched ≥', exp.equationsMatchedMin, eq.matched, eq.matched >= exp.equationsMatchedMin);
  add('mismatched (sections + equations)', 0, sec.mismatched + eq.mismatched, sec.mismatched + eq.mismatched === 0);
  add('orderViolations (eval, sections + equations)', 0, sec.orderViolations + eq.orderViolations, sec.orderViolations + eq.orderViolations === 0);
  add('orderViolations (anchorStructure)', 0, a.orderViolations, a.orderViolations === 0);
  add('extra (sections + equations)', 0, sec.extra + eq.extra, sec.extra + eq.extra === 0);
  add('missing (sections + equations)', 0, sec.missing + eq.missing, sec.missing + eq.missing === 0);
  add('equation numbers 1…max in DOM order', true, seq.ok, seq.ok);
  add('no equation_number_gap warning', false, parsed.warnings.includes('equation_number_gap'), !parsed.warnings.includes('equation_number_gap'));
  add('supplement v2 sha256 equal over 2 runs', sha256(sup1.text), sha256(sup2.text), sha256(sup1.text) === sha256(sup2.text));
  add(`supplement v2 chars ≤ ${SUPPLEMENT_MAX_CHARS}`, SUPPLEMENT_MAX_CHARS, sup1.text.length, sup1.text.length <= SUPPLEMENT_MAX_CHARS);
  add('anchor budget not exhausted', false, a.budgetExhausted, !a.budgetExhausted);
  const pass = checks.every((c) => c.pass);
  allPass &&= pass;

  for (const k of ['gold', 'matched', 'null', 'mismatched', 'extra', 'missing', 'orderViolations'] as const) totals[k] += sec[k] + eq[k];
  const kindOut = (c: KindComparison) => ({
    gold: c.gold,
    matched: c.matched,
    null: c.null,
    mismatched: c.mismatched,
    extra: c.extra,
    missing: c.missing,
    orderViolations: c.orderViolations,
    nullItems: c.nullItems,
    mismatchedItems: c.mismatchedItems,
    extraItems: c.extraItems,
    missingItems: c.missingItems,
    orderViolationPairs: c.orderViolationPairs,
  });
  papers.push({
    paper: id,
    pass,
    checks,
    counts: {
      sections: parsed.sections.length,
      topLevelSections: topLevel,
      equationRows: parsed.equations.length,
      numberedEquations: numberedIdx.length,
      groupTagEquations: numberedIdx.filter((i) => parsed.equations[i]!.group).length,
      figures: parsed.figures.length,
      references: parsed.references.length,
      ltxErrors: parsed.ltxErrors,
      katexOkNumbered: katexOk,
      katexBudgetExceeded: run1.katexBudgetExceeded,
      parserWarnings: parsed.warnings,
      pages: pages.length,
    },
    sections: kindOut(sec),
    equations: kindOut(eq),
    stages: { equations: eqStages, sections: secStages, note: 'stage of each confirmed item as anchorStructure reports it (equations: numbered rows only)' },
    numberSequence: seq,
    supplementV2: {
      sha256Run1: sha256(sup1.text),
      sha256Run2: sha256(sup2.text),
      chars: sup1.text.length,
      bytes: Buffer.byteLength(sup1.text, 'utf8'),
      truncated: sup1.truncated,
      totalCharsCap: SUPPLEMENT_CAPS.totalChars,
      meta: 'fixed from the fixture id (title "fixture <id>", no authors, year and category null) — the fixtures have no Atom feed, so the bytes differ from an imported paper\'s',
    },
  });
  brief.push({
    paper: id,
    pass,
    sections: `${sec.matched}/${sec.gold} 일치 · null ${sec.null} · 불일치 ${sec.mismatched}`,
    equations: `${eq.matched}/${eq.gold} 일치 · null ${eq.null} · 불일치 ${eq.mismatched}`,
    katexOk: `${katexOk}/${numberedIdx.length}`,
    supplementSha256: sha256(sup1.text),
    supplementChars: sup1.text.length,
    failed: checks.filter((c) => !c.pass).map((c) => c.id),
  });
}

const summary = summaryLine(totals);
const report = {
  tool: 'eval-structure',
  createdAt: new Date().toISOString(),
  pass: allPass,
  summary,
  scope: 'the adjudicated gold of 2 IEEE two-column papers (sections 66 + equations 34): agreement with these items only; other layouts are not measured (PLAN_M2 3.2)',
  gold: 'apps/server/test/fixtures/structure-gold.json',
  fixturesDir,
  totals,
  papers,
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'structure_eval.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ pass: allPass, summary, totals, papers: brief, out: join(outDir, 'structure_eval.json') }));
process.exit(allPass ? 0 : 1);
