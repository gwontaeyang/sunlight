// remark plugin over the Markdown AST of displayMd (Owner D; provenance redesigned after review B1).
// Chips and badges come only from nodes the parser issued:
// - The parser writes every chip as `\u0003<kind><id>\u0004[text](#sp-…)` (parseAnswer.ts header). A link is a chip
//   only when the text node right before it ends with that marker, the marker's kind/id agree with the link's
//   href and text, it has no title, every ancestor is ordinary flow/phrasing content, and the id was not used
//   before. Model text cannot contain the marker (control characters are stripped and Markdown entities cannot
//   decode to them), so model-written links — `[x](#sp-…)`, `[x](<#sp-…>)`, titles, reference definitions,
//   nesting, HTML, comments — are never chips; a model-written `#sp-…` link renders as literal text.
// - A label badge carries the index of ITS parser block (`b<k>`), never a count, plus the ordinals of the
//   citation chips admitted in the SAME Markdown block (paragraph / heading / table row). The badge counts as
//   grounded only with evidence among those (chips.tsx): if Markdown ever put the label and its quotes in
//   different blocks, or hid a quote, the badge fails closed instead of borrowing another block's evidence.
// - Leftover markers (in code, math, URLs, alt text …) are stripped so they never show.
// Link-shaped text inside code is never a link node, so it is never a chip.
import { CHIP_MARK_AT_END_RE, CHIP_MARK_RE } from '@study-paper/shared/markup/parseAnswer';
import { SP_HREF } from './grounding';

interface MdNode {
  type: string;
  url?: string;
  title?: string | null;
  alt?: string | null;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
}

export const CHIP_ATTR = 'data-sp-chip';
export const CHIP_KIND_ATTR = 'data-sp-kind';
export const CHIP_ID_ATTR = 'data-sp-id';
/** On a label badge: comma-separated ordinals of the citation chips admitted in the same Markdown block. */
export const COLOCATED_ATTR = 'data-sp-colocated';

export type ChipKindName = 'cite' | 'eq' | 'label';

const EQ_TEXT = /^식 \(([A-Za-z]?\.?\d+[a-z]?)\)$/;
/** Ancestors a chip may have (anything else — link, image, html, code — means it is not shown as a chip). */
const ALLOWED_ANCESTORS = new Set(['root', 'paragraph', 'heading', 'table', 'tableRow', 'tableCell', 'list', 'listItem', 'blockquote', 'emphasis', 'strong', 'delete', 'footnoteDefinition']);
/** The Markdown block a badge and its evidence must share. */
const BLOCK_TYPES = new Set(['paragraph', 'heading', 'tableRow']);

function plainText(n: MdNode): string | null {
  if (!n.children || n.children.length !== 1 || n.children[0]!.type !== 'text') return null;
  return n.children[0]!.value ?? null;
}

function setProps(n: MdNode, props: Record<string, string>) {
  n.data = { ...n.data, hProperties: { ...n.data?.hProperties, ...props } };
}

/** The chip kind a marked link may be, or null when href/text/id disagree with the marker. */
function admitted(link: MdNode, mark: string, id: number): ChipKindName | null {
  if (link.title || !link.url) return null;
  const text = plainText(link);
  if (text === null) return null;
  if (mark === 'c') {
    const m = SP_HREF.cite.exec(link.url);
    return m && Number(m[1]) === id && text === `❝${id}` ? 'cite' : null;
  }
  if (mark === 'e') {
    const m = SP_HREF.eq.exec(link.url);
    return m && Number(m[1]) === id && EQ_TEXT.test(text) ? 'eq' : null;
  }
  const m = SP_HREF.label.exec(link.url);
  return m && text === m[1]!.toUpperCase() ? 'label' : null;
}

const strip = (s: string) => s.replace(CHIP_MARK_RE, '');

export function remarkSpIndex() {
  return (tree: MdNode) => {
    const seen = new Set<string>();
    const blockChips = new Map<MdNode, { cites: number[]; labels: MdNode[] }>();
    const walk = (n: MdNode, ancestors: MdNode[]) => {
      const kids = n.children;
      if (!kids) return;
      const path = [...ancestors, n];
      kids.forEach((c, i) => {
        if (c.type === 'link') {
          const prev = i > 0 ? kids[i - 1] : undefined;
          const mark = prev?.type === 'text' ? CHIP_MARK_AT_END_RE.exec(prev.value ?? '') : null;
          const kind = mark && path.every((a) => ALLOWED_ANCESTORS.has(a.type)) ? admitted(c, mark[1]!, Number(mark[2])) : null;
          const key = kind ? `${kind}:${mark![2]}` : null;
          if (kind && key && !seen.has(key)) {
            seen.add(key);
            prev!.value = prev!.value!.slice(0, -mark![0].length);
            setProps(c, { [CHIP_ATTR]: '1', [CHIP_KIND_ATTR]: kind, [CHIP_ID_ATTR]: mark![2]! });
            const block = [...path].reverse().find((a) => BLOCK_TYPES.has(a.type));
            if (block) {
              const entry = blockChips.get(block) ?? { cites: [], labels: [] };
              if (kind === 'label') entry.labels.push(c);
              else entry.cites.push(Number(mark![2]));
              blockChips.set(block, entry);
            }
          } else if (c.url?.startsWith('#sp-')) setProps(c, { [CHIP_ATTR]: '0' });
        }
        walk(c, path);
      });
    };
    walk(tree, []);
    for (const { cites, labels } of blockChips.values()) for (const l of labels) setProps(l, { [COLOCATED_ATTR]: cites.join(',') });
    // Strip markers that did not end up right before an admitted chip (code, math, URLs, alt text, …).
    const clean = (n: MdNode) => {
      if (typeof n.value === 'string') n.value = strip(n.value);
      if (typeof n.url === 'string') n.url = strip(n.url);
      if (typeof n.title === 'string') n.title = strip(n.title);
      if (typeof n.alt === 'string') n.alt = strip(n.alt);
      n.children?.forEach(clean);
      // remark-math copies the source into data.hChildren at parse time (KaTeX renders from that copy)
      const hChildren = n.data?.hChildren;
      if (Array.isArray(hChildren)) (hChildren as MdNode[]).forEach(clean);
    };
    clean(tree);
  };
}
