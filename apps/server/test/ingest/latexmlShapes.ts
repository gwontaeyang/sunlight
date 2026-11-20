// Owner A. Adversarial LaTeXML-shaped documents (≤ 4 MB) whose items share or nest subtrees — each one made an earlier
// parser re-walk a large subtree per item (review A-R2-01). Used by latexml.limits.test.ts.
const doc = (body: string) => `<!DOCTYPE html><html><body><article class="ltx_document">${body}</article></body></html>`;
const section = (inner: string) => `<section id="S1" class="ltx_section"><h2 class="ltx_title"><span class="ltx_tag">1 </span>One</h2>${inner}</section>`;

/** One table.ltx_equationgroup[id] with `rows` math rows, `tags` of them carrying a .ltx_tag_equationgroup (~0.85 MB). */
export function sharedGroupHolder(rows = 19_000, tags = 400): string {
  const every = Math.floor(rows / tags);
  const trs: string[] = [];
  for (let i = 0; i < rows; i++) {
    const tag = i % every === 0 && i / every < tags ? `<td><span class="ltx_tag ltx_tag_equationgroup">(${i / every + 1})</span></td>` : '';
    trs.push(`<tr><td><math alttext="x_{${i}}"></math></td>${tag}</tr>`);
  }
  return doc(section(`<table id="S1.EGx1" class="ltx_equationgroup"><tbody>${trs.join('')}</tbody></table>`));
}

/** `depth` nested heading-less sections around `inline` inline elements (~2.4 MB). */
export function nestedHeadinglessSections(depth = 400, inline = 300_000): string {
  const open = Array.from({ length: depth }, (_, i) => `<section id="S${i + 1}" class="ltx_section">`).join('');
  const close = '</section>'.repeat(depth);
  return doc(`${open}${'<b>a</b>'.repeat(inline)}${close}`);
}

/** One tbody[id] whose `tags` rows each carry a .ltx_tag_equation and a math with an alttext of `alt` chars (~3.2 MB). */
export function sharedTbodyHolder(tags = 400, alt = 8_000): string {
  const trs = Array.from({ length: tags }, (_, i) => `<tr><td><math alttext="${'y'.repeat(alt - 8)}_{${String(i).padStart(4, '0')}}"></math></td><td><span class="ltx_tag ltx_tag_equation">(${i + 1})</span></td></tr>`).join('');
  return doc(section(`<table id="S1.E1" class="ltx_equation"><tbody id="S1.E1.b">${trs}</tbody></table>`));
}

/** A paragraph whose text after its math is one whitespace text node of `spaces` chars, then `tables` equation tables (~3.5 MB). */
export function whitespaceParagraph(spaces = 3_500_000, tables = 32): string {
  const eqs = Array.from({ length: tables }, (_, i) => `<table id="S1.E${i + 1}" class="ltx_equation"><tbody><tr><td><math alttext="e_{${i}}"></math></td><td><span class="ltx_tag ltx_tag_equation">(${i + 1})</span></td></tr></tbody></table>`).join('');
  return doc(section(`<div class="ltx_para"><p class="ltx_p">Lead words <math alttext="a"></math>${' '.repeat(spaces)}</p></div>${eqs}`));
}

/** `count` links that are not URLs (~3.9 MB), one numbered equation so the document has structure. */
export function manyLinks(count = 230_000, href = "x"): string {
  return doc(section(`<table id="S1.E1" class="ltx_equation"><tbody><tr><td><math alttext="z"></math></td><td><span class="ltx_tag ltx_tag_equation">(1)</span></td></tr></tbody></table><p class="ltx_p">${`<a href="${href}">y</a>`.repeat(count)}</p>`));
}

/** A paragraph, `comments` comment nodes, then `tables` numbered equation tables — every sibling scan from a table must
 *  pass the comments (~2.8 MB at 400,000). Review A-R3-02: linkedom's *ElementSibling skips them without a count. */
export function commentSiblings(comments = 400_000, tables = 32): string {
  const eqs = Array.from({ length: tables }, (_, i) => `<table id="S1.E${i + 1}" class="ltx_equation"><tbody><tr><td><math alttext="e_{${i}}"></math></td><td><span class="ltx_tag ltx_tag_equation">(${i + 1})</span></td></tr></tbody></table>`).join('');
  return doc(section(`<div class="ltx_para"><p class="ltx_p">Lead words.</p></div>${'<!---->'.repeat(comments)}${eqs}`));
}
