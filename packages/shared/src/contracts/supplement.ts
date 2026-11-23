// supplement.v2.txt format (PLAN_M2 3.1, D1, D21). Owner: supervisor — frozen: A builds the input and calls this; the
// bytes are part of the cache prefix, so nobody re-implements or post-processes the text.
//
// <paper_index v="2">
// <metadata>                       5 lines, same form as v1 (title, authors, arxiv, year, category)
// </metadata>
// <sections>
// <htmlId> | <number> | <title>    one line per section in document order ("-" for a null htmlId/number)
// </sections>
// <equations>
// (<number>) | <sectionNumber> | <normalized LaTeX on one line>    numbered equations only ("-" for no section)
// </equations>
// <figures>
// Figure <number> | <caption>      (Table <number> for tables; the bare word when number is null)
// </figures>
// <references>
// <label> <rawText>                (label as printed, e.g. "[12]"; "-" when the item has none)
// </references>
// </paper_index>
//
// Rules (deterministic: same input → same bytes; never throws):
// - every value: whitespace collapsed + trimmed → cut to its cap counted BEFORE escaping (a cut value ends with "…",
//   the result stays ≤ cap and never splits a surrogate pair) → `& < >` escaped exactly like v1's esc().
// - metadata is cut here too (title 500, ≤ 100 authors + " … (+n)", each name 100, category 50, arXiv id 40): callers
//   pass raw values. Worst case after escaping (× 5 for "&") the metadata block stays far below totalChars.
// - count caps per kind, then the totalChars budget: the skeleton and one `<truncated kind="…" dropped="n"/>` line per
//   kind are reserved first (only when the whole text would not fit); the rest is filled sections → equations →
//   figures → references, each as a prefix of its list (so items are dropped references → figures → equations from
//   the end → sections from the end).
//   A kind that lost items gets its <truncated> line as the last line of its block, and `truncated` is true.
// - text.length ≤ totalChars for every input, including the truncation lines.
// - no PDF positions and no KaTeX results (D21): the bytes do not depend on anchoring or KaTeX time budgets.

export const SUPPLEMENT_CAPS = {
  titleChars: 500,
  authors: 100,
  authorChars: 100,
  categoryChars: 50,
  arxivIdChars: 40,
  sections: 400,
  sectionTitleChars: 300,
  equations: 400,
  equationLatexChars: 2000,
  figures: 200,
  captionChars: 600,
  references: 400,
  referenceChars: 400,
  totalChars: 120_000,
} as const;

export interface SupplementIndexInput {
  meta: { title: string; authors: string[]; arxivId: string | null; arxivVersion: number | null; year: number | null; primaryCategory: string | null };
  /** Document order. */
  sections: { htmlId: string | null; number: string | null; title: string }[];
  /** Numbered equations only; latex = latexNormalize output as is (independent of KaTeX results). */
  equations: { number: string; sectionNumber: string | null; latex: string }[];
  figures: { kind: 'figure' | 'table'; number: string | null; caption: string }[];
  references: { label: string | null; rawText: string }[];
}

export interface SerializedSupplement {
  text: string;
  /** Something was cut or dropped (→ ingest warning supplement_truncated). */
  truncated: boolean;
}

type Kind = 'sections' | 'equations' | 'figures' | 'references';
const KINDS: readonly Kind[] = ['sections', 'equations', 'figures', 'references'];

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Collapse → cut (counted before escaping, "…" marks a cut) → escape. Reports whether it cut. */
function value(raw: string, cap: number, cut: { any: boolean }): string {
  let s = collapse(raw);
  if (s.length > cap) {
    let end = cap - 1;
    const c = s.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--; // never leave a lone high surrogate
    s = s.slice(0, end) + '…';
    cut.any = true;
  }
  return escapeXml(s);
}

const truncatedLine = (kind: Kind, dropped: number): string => `<truncated kind="${kind}" dropped="${dropped}"/>`;

export function serializeSupplementV2(input: SupplementIndexInput): SerializedSupplement {
  const C = SUPPLEMENT_CAPS;
  const cut = { any: false };

  // metadata (5 lines, v1 form)
  const m = input.meta;
  const shownAuthors = m.authors.slice(0, C.authors).map((a) => value(a, C.authorChars, cut));
  const moreAuthors = m.authors.length - shownAuthors.length;
  if (moreAuthors > 0) cut.any = true;
  const metadata = [
    `title: ${value(m.title, C.titleChars, cut)}`,
    `authors: ${shownAuthors.join('; ')}${moreAuthors > 0 ? ` … (+${moreAuthors})` : ''}`,
    m.arxivId === null ? 'source: upload' : `arxiv: ${value(m.arxivId, C.arxivIdChars, cut)}v${m.arxivVersion !== null && Number.isFinite(m.arxivVersion) ? Math.trunc(m.arxivVersion) : 0}`,
    `year: ${m.year === null || !Number.isFinite(m.year) ? 'unknown' : Math.trunc(m.year)}`,
    `category: ${m.primaryCategory ? value(m.primaryCategory, C.categoryChars, cut) : 'unknown'}`,
  ];

  // item lines per kind, after the count caps
  const total: Record<Kind, number> = { sections: input.sections.length, equations: input.equations.length, figures: input.figures.length, references: input.references.length };
  const lines: Record<Kind, string[]> = {
    sections: input.sections.slice(0, C.sections).map((s) => `${s.htmlId === null ? '-' : value(s.htmlId, C.sectionTitleChars, cut)} | ${s.number === null ? '-' : value(s.number, C.sectionTitleChars, cut)} | ${value(s.title, C.sectionTitleChars, cut)}`),
    equations: input.equations.slice(0, C.equations).map((e) => `(${value(e.number, C.sectionTitleChars, cut)}) | ${e.sectionNumber === null ? '-' : value(e.sectionNumber, C.sectionTitleChars, cut)} | ${value(e.latex, C.equationLatexChars, cut)}`),
    figures: input.figures.slice(0, C.figures).map((f) => `${f.kind === 'table' ? 'Table' : 'Figure'}${f.number === null || collapse(f.number) === '' ? '' : ` ${value(f.number, C.sectionTitleChars, cut)}`} | ${value(f.caption, C.captionChars, cut)}`),
    references: input.references.slice(0, C.references).map((r) => `${r.label === null || collapse(r.label) === '' ? '-' : value(r.label, C.sectionTitleChars, cut)} ${value(r.rawText, C.referenceChars, cut)}`),
  };

  // budget. Everything that survived the count caps fits → no reservation needed. Otherwise: skeleton + metadata +
  // one reserved <truncated> line per kind (sized for the largest possible count), the rest filled in order.
  const skeleton = ['<paper_index v="2">', '<metadata>', ...metadata, '</metadata>', ...KINDS.flatMap((k) => [`<${k}>`, `</${k}>`]), '</paper_index>'];
  const skeletonChars = skeleton.reduce((n, l) => n + l.length + 1, 0);
  const countDropped = KINDS.filter((k) => lines[k].length < total[k]);
  const fullChars = skeletonChars + KINDS.reduce((n, k) => n + lines[k].reduce((a, l) => a + l.length + 1, 0), 0) + countDropped.reduce((n, k) => n + truncatedLine(k, total[k] - lines[k].length).length + 1, 0);
  const kept: Record<Kind, string[]> = { sections: [], equations: [], figures: [], references: [] };
  if (fullChars <= C.totalChars) {
    for (const k of KINDS) kept[k] = lines[k];
  } else {
    const reserve = KINDS.reduce((n, k) => n + truncatedLine(k, total[k]).length + 1, 0);
    let budget = C.totalChars - skeletonChars - reserve;
    let full = false;
    for (const k of KINDS) {
      for (const l of lines[k]) {
        // Keep a prefix: the first line that does not fit ends the filling — later lines of this kind AND every later
        // kind are dropped (drop order references → figures → equations from the end → sections from the end).
        if (full || l.length + 1 > budget) {
          full = true;
          break;
        }
        kept[k].push(l);
        budget -= l.length + 1;
      }
    }
  }

  const out: string[] = ['<paper_index v="2">', '<metadata>', ...metadata, '</metadata>'];
  let truncated = cut.any;
  for (const k of KINDS) {
    out.push(`<${k}>`, ...kept[k]);
    const dropped = total[k] - kept[k].length;
    if (dropped > 0) {
      truncated = true;
      out.push(truncatedLine(k, dropped));
    }
    out.push(`</${k}>`);
  }
  out.push('</paper_index>');
  return { text: out.join('\n') + '\n', truncated };
}
