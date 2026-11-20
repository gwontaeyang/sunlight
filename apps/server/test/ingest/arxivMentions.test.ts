// Owner A. arxivMentions (the html step's version check, PLAN_M2 3.1 "본문에 같은 id의 arXiv:<id>vN 표기"): a mention
// counts only where the HTML parser makes text — never inside a comment (an unterminated one runs to the end of the
// document) nor inside <script>/<style> content (review A-P2-01). Linear in the input; the distinct (id, version) pairs,
// at most 1,000 (more → overflow: the version is unknown — M-M2-R2-5).
import { describe, expect, it } from 'vitest';
import { arxivMentions, FOREIGN_STACK_MAX, MENTION_PAIRS_MAX, type MentionMeter, parse, versionVerdict } from '../../src/ingest/latexml';
import { BYTE_LIMITS } from '../../src/ingest/safeFetch';
import { latexmlFootnote, SYN_M2_HTML } from './m2helpers';

const V1 = { id: '2301.00001', version: 1 };
const V2 = { id: '2301.00001', version: 2 };
const m1 = 'arXiv:2301.00001v1';
const m2 = 'arXiv:2301.00001v2';
/** The mention list of the scan (the distinct pairs). */
const mentionsOf = (html: string, meter?: MentionMeter) => arxivMentions(html, meter).mentions;
const page = (body: string) => `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;

describe('arxivMentions: comments, script and style are not text', () => {
  it('synthetic-m2.html → exactly the abstract mention (the header comment is not counted)', () => {
    expect(mentionsOf(SYN_M2_HTML)).toEqual([{ id: '0000.00001', version: 1 }]);
    expect(parse(SYN_M2_HTML).arxivMentions).toEqual([{ id: '0000.00001', version: 1 }]);
  });
  it('a comment hides its mention; text before and after it still counts', () => {
    expect(mentionsOf(page(`<p>${m1}</p><!-- ${m2} --><p>after</p>`))).toEqual([V1]);
    expect(mentionsOf(page(`<!-- ${m2} --><p>${m1}</p>`))).toEqual([V1]);
    expect(mentionsOf(page(`<!--${m2}--><!--x--><p>${m1}</p><!-- ${m2} -->`))).toEqual([V1]);
    // the comment ends at the first "-->" (or "--!>"); a "<!--" inside it starts nothing
    expect(mentionsOf(page(`<!-- a <!-- ${m2} --> ${m1}`))).toEqual([V1]);
    expect(mentionsOf(page(`<!-- ${m2} --!> ${m1}`))).toEqual([V1]);
    // "<!-->" and "<!--->" are whole (empty) comments: the text right after them counts
    expect(mentionsOf(page(`<!--> ${m2} -->`))).toEqual([V2]);
    expect(mentionsOf(page(`<!---> ${m2} -->`))).toEqual([V2]);
  });
  it('an unterminated comment runs to the end of the document', () => {
    expect(mentionsOf(page(`<p>${m1}</p><!-- unterminated ${m2} <p>${m2}</p>`))).toEqual([V1]);
    expect(mentionsOf(`<!--${m2}`)).toEqual([]);
    expect(mentionsOf(`<!--`)).toEqual([]);
  });
  it('<script> and <style> content (any case, with attributes) is not counted; the text after the end tag is', () => {
    for (const tag of ['script', 'style', 'SCRIPT', 'Style']) {
      expect(mentionsOf(page(`<${tag} type="x">var a = "${m2}";</${tag}><p>${m1}</p>`)), tag).toEqual([V1]);
      expect(mentionsOf(page(`<p>${m1}</p><${tag}>/* ${m2} */</${tag} ><p>${m2}</p>`)), tag).toEqual([V1, V2]);
    }
    // the end tag needs whitespace, "/" or ">" after the name: </scripts> does not end a script
    expect(mentionsOf(page(`<script>x</scripts>${m2}</script>${m1}`))).toEqual([V1]);
    // an unterminated script/style hides the rest of the document
    expect(mentionsOf(page(`<p>${m1}</p><script>${m2}`))).toEqual([V1]);
    expect(mentionsOf(`<style>${m2}`)).toEqual([]);
    // "<!--" inside a script is script text, not a comment: the text after </script> counts
    expect(mentionsOf(page(`<script>a<!--b</script><p>${m2}</p>`))).toEqual([V2]);
    // <scripts> / <styles> are other elements: their content counts
    expect(mentionsOf(page(`<scripts>${m2}</scripts><styles>${m1}</styles>`))).toEqual([V2, V1]);
  });
  it('never hides text the parser shows: "<!--" / "<script" inside an attribute value, a title or a textarea is text', () => {
    expect(mentionsOf(page(`<a title="<!--">${m2}</a><b title='-->'>x</b>`))).toEqual([V2]);
    expect(mentionsOf(page(`<a title="x" data-y='<script>'>${m2}</a>`))).toEqual([V2]);
    // a ">" inside a quoted value does not end the tag, so the "<!--" / "<script" after it is still inside the value
    expect(mentionsOf(page(`<a title="x > <!--">${m2}</a><b title="-->">${m1}</b>`))).toEqual([V2, V1]);
    expect(mentionsOf(page(`<a title='y > <script>'>${m2}</a>`))).toEqual([V2]);
    expect(mentionsOf(page(`<a b=x"<!-- >${m2}</a>`))).toEqual([V2]); // an unquoted value ends at whitespace or ">"
    expect(mentionsOf(`<html><head><title><!-- ${m2} --></title></head></html>`)).toEqual([V2]);
    expect(mentionsOf(page(`<textarea><!-- ${m2} --></textarea><textarea><script>${m1}</textarea>`))).toEqual([V2, V1]);
    // a mention split by a comment reads as one text in the document
    expect(mentionsOf(page(`<p>arXiv:<!-- x -->2301.00001v2</p>`))).toEqual([V2]);
    // a doctype / bogus comment ends at the first ">": a "<!--" after it starts a real comment
    expect(mentionsOf(`<!DOCTYPE html><!-- ${m2} --><p>${m1}</p>`)).toEqual([V1]);
  });
  it('never hides text the parser shows: plaintext, "<?", end-tag attributes, the other raw text elements, attribute spacing (review A-F7-02)', () => {
    expect(mentionsOf(page(`<plaintext><!-- ${m2}`))).toEqual([V2]); // the rest of the document is text
    expect(mentionsOf(page(`<plaintext></plaintext><!-- ${m2} -->`))).toEqual([V2]); // even after a </plaintext>
    expect(mentionsOf(page(`<?x <!-- > ${m2} -->`))).toEqual([V2]); // "<?" is a bogus comment that ends at the first ">"
    expect(mentionsOf(page(`</ <!-- > ${m2} -->`))).toEqual([V2]); // "</" + a non-letter: the same
    expect(mentionsOf(page(`</p x="> <!-- "> ${m2} -->`))).toEqual([V2]); // an end tag's quoted attribute value
    for (const tag of ['xmp', 'iframe', 'noembed', 'noframes', 'noscript']) expect(mentionsOf(page(`<${tag}><!-- ${m2} --></${tag}>`)), tag).toEqual([V2]);
    expect(mentionsOf(page(`<a b = "x > <!--"> ${m2} <b title="-->">`))).toEqual([V2]); // "=" after whitespace still starts the value
    expect(mentionsOf(page(`<a b=x c="> <!--"> ${m2} <b title="-->">`))).toEqual([V2]); // an unquoted value ends at whitespace
  });
  it('a mention inside a doctype, "<!…>" or "<?…>" is counted although the parser hides it (stricter on purpose)', () => {
    expect(mentionsOf(page(`<!x ${m2}>`))).toEqual([V2]);
    expect(mentionsOf(page(`<?x ${m2}>`))).toEqual([V2]);
    expect(mentionsOf(`<!DOCTYPE ${m2}><p>x</p>`)).toEqual([V2]);
  });
  // Each row: the input, whether parse5 8.1.1 shows the mention as text (taken once, offline — parse5 is not a direct
  // dependency of this package; the A 수정 4 rows from .data/m2-a/scratch/fix4/p5/rows.mts), and what the scan returns.
  // Where parse5 shows it, the scan must count it (review A-F7-01).
  const vsParse5: [string, boolean, boolean][] = [
    // svg/math/select content: <script>/<style> there are not raw text (or not elements at all)
    [`<svg width="1" height="1"><style/><path d="M0 0"/></svg><p>${m2} [cs.RO]</p>`, true, true],
    [`<svg><script/></svg><p>${m2}</p>`, true, true],
    [`<svg><style><p>${m2}</p></style></svg>`, true, true],
    [`<select><style>${m2}</style></select>`, true, true],
    [`<math><style/><script> ${m2} <style/></p>`, true, true],
    [`<svg><style><style/> ${m2} </svg>`, true, true],
    [`<svg/><svg><style/></svg><p>${m2}</p>`, true, true],
    [`<SVG><STYLE/></SVG><p>${m2}</p>`, true, true],
    [`<math><mi>x</mi><script/></math><p>${m2}</p>`, true, true],
    [`<svg a=b/><style>${m2}</style>`, true, true], // "b/" is the value: the svg is not self-closed
    // "<![CDATA[" is CDATA only in svg/math; in HTML it is a bogus comment that ends at the first ">"
    [`<p><![CDATA[ a > b <textarea> ]]> <!-- ${m2} --> </textarea></p>`, true, true],
    [`<svg><![CDATA[ a > <!-- ${m2} --> ]]></svg>`, true, true],
    [`<math><![CDATA[ ${m2} ]]></math>`, true, true],
    [`<svg><p><![CDATA[ a > <textarea> ]]> <!-- ${m2} --> </textarea>`, true, true], // <p> broke out of the svg: bogus to the first ">"
    [`<math><mi><![CDATA[ a > <textarea> ]]> <!-- ${m2} --> </textarea>`, true, true], // <mi> is an integration point
    [`<svg><![CDATA[ a > b ]]></svg><!-- ${m2} -->`, false, true], // either reading may hold: the rest is kept
    [`<svg><foreignObject><textarea><!-- ${m2} --></textarea></foreignObject></svg>`, true, true],
    // hidden where the parser hides it: script/style in HTML after a closed or self-closed svg/math/select
    [`<svg/><style>${m2}</style><p>x</p>`, false, false],
    [`<svg></svg><style>${m2}</style>`, false, false],
    [`<select></select><style>${m2}</style>`, false, false],
    [`<math></math><script>${m2}</script>`, false, false],
    [`<![CDATA[ x ]]><!-- ${m2} -->`, false, false],
    [`<svg><![CDATA[ x ]]></svg><!-- ${m2} -->`, false, false], // both readings end at "]]>"
    [`</ x="> <!-- "> ${m2} -->`, false, false], // "</" + a non-letter is a bogus comment: no attributes, ends at the first ">"
    [`</1 x="> <!-- "> ${m2} -->`, false, false],
    // counted although the parser hides it (the scan errs toward counting)
    [`<style/>${m2}</style>`, false, true],
    [`<script/>${m2}</script>`, false, true],
    [`<svg><foreignObject><style>${m2}</style></foreignObject></svg>`, false, true],
    [`<math><mi><style>${m2}</style></mi></math>`, false, true],
    [`<select><script>${m2}</script></select>`, false, true],
    // ER-A-01 (INTEGRATION_NOTES 결정 14): a raw text element skipped inside svg/math/select/frameset whose skipped part
    // holds a "<" — the parser reads markup there (a comment, an attribute value, a breakout) — keeps the rest as text
    [`<svg><title><a b="</title><!--"> ${m2} <!-- --></svg>`, true, true],
    [`<svg><xmp><a b="</xmp><!--"> ${m2} <!-- --></svg>`, true, true],
    [`<math><textarea><a b="</textarea><!--"> ${m2} <!-- --></math>`, true, true],
    [`<select><title><a b="</title><!--"> ${m2} <!-- --></select>`, true, true],
    [`<svg><title><!-- </title><!--!> ${m2} <!-- --></svg>`, true, true],
    [`<select><title><!-- </title><!--!> ${m2} <!-- --></select>`, true, true],
    [`<svg><xmp><p><svg><svg></xmp></svg><style>${m2}</style>`, true, true],
    [`<svg><style><p><svg><svg></style></svg><style>${m2}</style>`, true, true],
    [`<svg><style/></svg><script> var s = "</style>"; var t = "<!--"; </script> ${m2} <!-- x -->`, true, true],
    [`<svg><script/></svg><a title="</script><!--">${m2}</a><!-- x -->`, true, true],
    [`<select><style></select><a title="</style><!--">${m2}</a><!-- x -->`, true, true],
    [`<math><xmp><div><title></xmp><!-- ${m2} `, true, true],
    [`<math><script/><font color=red><plaintext></script><!-- ${m2} `, true, true],
    [`<math><title><![CDATA[<svg><title>a &lt; b</title><!--[if IE]> ${m2} `, true, true],
    // ER-A-01: a hidden HTML script whose content has "<!--" and then "<script" (the double-escaped state: a "</script>"
    // there does not end the script) keeps the rest from that "<!--" as text
    [`<script><!-- <script> </script> <!-- </script> ${m2} -->`, true, true],
    [`<script><!--<script></script><!--</script><p>${m2}</p><!-- x -->`, true, true],
    // the natural forms keep their reading: no "<" in the skipped part, a script "<!--" without "<script" after it
    [`<svg><title>Icon</title></svg><!-- ${m2} -->`, false, false],
    [`<svg><style>.a{fill:red}</style></svg><!-- ${m2} -->`, false, false],
    [`<script>var a = "<!--";</script><!-- ${m2} -->`, false, false],
    [`<script><!--\nvar y;\n//--></script><!-- ${m2} -->`, false, false],
    // ER-A-04: branches pinned directly — after "<svg><style/></svg>" scanning goes on (the comment stays hidden); the
    // CDATA rule only in svg/math; a later "</style>" makes the "<style/>" span hold markup → the rest is text (stricter);
    // an empty svg title has no end tag → the rest is text (stricter)
    [`<svg><style/></svg><!-- ${m2} -->`, false, false],
    [`<p><![CDATA[ a > b ]]></p><!-- ${m2} -->`, false, false],
    [`<svg><style/></svg><p>a</p><script>${m2}</script><style>.a{}</style>`, false, true],
    [`<svg><title/><path/></svg><p>x</p><!-- ${m2} -->`, false, true],
    // A-F4R1-02: an HTML element open inside an integration point (svg foreignObject/desc/title, MathML mi/mo/mn/ms/
    // mtext, annotation-xml) — the parser ignores a "</svg>" / "</math>" there, so the svg/math stays open and a later
    // <style>/<script> is foreign: its content is text
    [`<svg><foreignObject><p></svg></p></foreignObject><style>${m2}</style>`, true, true],
    [`<svg><foreignObject><p></svg></p></foreignObject><style><p>${m2}</p></style>`, true, true],
    [`<svg><desc><b></svg></b></desc><style>${m2}</style>`, true, true],
    [`<svg><desc><b></svg></b></desc><script><p>${m2}</p></script>`, true, true],
    [`<math><mi><p></math></p></mi><style>${m2}</style>`, true, true],
    [`<math><mtext><span></math></span></mtext><style><div>${m2}</div></style>`, true, true],
    [`<svg><foreignObject><select></svg></select></foreignObject><style>${m2}</style>`, true, true],
    [`<math><annotation-xml encoding="text/html"><p></math></p></annotation-xml><style>${m2}</style>`, true, true],
    [`<svg><foreignObject><p></svg></p></foreignObject><title><a b="</title><!--"> ${m2} <!-- -->`, true, true],
    [`<svg><foreignObject><x-y></svg></x-y></foreignObject><style>${m2}</style>`, true, true],
    [`<svg><foreignObject><p><svg></svg></svg></p></foreignObject><style>${m2}</style>`, true, true],
    // … and the natural forms keep their reading: closed HTML in an integration point, MathML tokens, a breakout
    [`<svg><g><foreignObject><span class="ltx_text">x</span></foreignObject></g></svg><style>${m2}</style>`, false, false],
    [`<svg><foreignObject><p>a<br>b<img src=x></p></foreignObject></svg><style>${m2}</style>`, false, false],
    [`<math><semantics><mrow><mi>x</mi><mo>=</mo><mn>1</mn></mrow><annotation encoding="application/x-tex">x=1</annotation></semantics></math><style>${m2}</style>`, false, false],
    [`<svg><foreignObject><p></p></foreignObject></svg><!-- ${m2} -->`, false, false],
    [`<svg><g><path></g></svg><style>${m2}</style>`, false, false],
    [`<svg><p></p></svg><style>${m2}</style>`, false, false],
    [`<svg><p></svg><style>${m2}</style>`, false, false], // <p> breaks out: the svg is closed before the </svg>
    [`<svg><font color=red></svg><style>${m2}</style>`, false, false], // so does a <font> with color/face/size
    [`<svg><font></svg><style>${m2}</style>`, false, false], // a <font> without them is an svg element
    [`<svg><foreignObject><svg><p></p><x-y></svg></svg></x-y></foreignObject><style>${m2}</style>`, true, true], // <p> closed the inner svg only
    [`<svg><foreignObject><svg><font size=1><x-y></svg></svg></x-y></font></foreignObject><style>${m2}</style>`, true, true],
    [`<b><svg></b><math><foreignObject></svg><style><p>${m2}</p></style>`, true, true], // </b> closed the svg: </svg> leaves the math open
    [`<svg><math></p><svg><mo></math><style><p>${m2}</p></style>`, true, true], // </p> broke out of the math
    // stricter: the HTML element stays open in the parser as well, but there the <style> is HTML (hidden)
    [`<svg><foreignObject><span/></svg></foreignObject><style>${m2}</style>`, false, true],
    [`<svg><desc><x/></desc></svg><style>${m2}</style>`, false, true],
    // A-F4R2-01: the scan's top above the parser's current node — after an ignored "</svg>" / "</math>" (another root
    // above it, which the parser closes) or a breakout in an element that is an integration point by name only
    // (annotation-xml without an HTML encoding, an svg mi, a MathML desc). The next start tag is an HTML element in the
    // parser; a later breakout or pop-down must not drop it, or the scan closes the svg the parser keeps open
    [`<svg><foreignObject><svg><math></svg><a><br></svg></a></foreignObject><style>${m2}</style>`, true, true],
    [`<svg><foreignObject><svg><math></svg><a></p></svg></a></foreignObject><style>${m2}</style>`, true, true],
    [`<svg><foreignObject><svg><math></svg><x-y><br></svg></x-y></foreignObject><style>${m2}</style>`, true, true],
    [`<svg><foreignObject><svg><math></svg><a><br></svg></a></foreignObject><style><p>${m2}</p></style>`, true, true],
    [`<svg><foreignObject><svg><math></svg><a><br></svg></a></foreignObject><script>${m2}</script>`, true, true],
    [`<math><mtext><math><svg></math><a><img></math></a></mtext><style>${m2}</style>`, true, true],
    [`<svg><desc><math><svg></math><q><hr></svg></q></desc><style>${m2}</style>`, true, true],
    [`<svg><foreignObject><math><annotation-xml><br></annotation-xml><a><br></svg></a></foreignObject><style>${m2}</style>`, true, true],
    [`<svg><foreignObject><svg><mi><br></mi><a><br></svg></a></foreignObject><style>${m2}</style>`, true, true],
    [`<svg><foreignObject><svg><math></svg><a></math></svg></svg></a></foreignObject><style>${m2}</style>`, true, true],
    [`<math><mi><svg><math></svg><a><br></math></a></mi><style><p>${m2}</p></style>`, true, true],
    [`<svg><foreignObject><svg><math></svg><a/><br></svg></a></foreignObject><style>${m2}</style>`, true, true], // "/>" opens an HTML <a>
    [`<svg><foreignObject><svg><math></svg><x/><img></svg></x></foreignObject><style>${m2}</style>`, true, true],
    [`<svg><foreignObject><svg><math></svg><area><a><br></svg></a></foreignObject><style>${m2}</style>`, true, true],
    // … where the parser closed the same elements, the reading stays: no HTML element was opened after the ignored "</svg>"
    [`<svg><foreignObject><svg><math></svg><br></svg></foreignObject><style>${m2}</style>`, false, false],
    [`<svg><title>t</title><mi>x</mi></svg><style>${m2}</style>`, false, false],
    // the stale state ends when the stack is empty: a later svg is followed as before ("/>" closes its <path>)
    [`<math><annotation-xml><ci>x</ci></annotation-xml></math><svg><path d="M0"/></svg><style>${m2}</style>`, false, false],
    [`<svg><mi></mi></svg><svg><g/></svg><style>${m2}</style>`, false, false],
    // A-F4R3-02: an end tag other than "</svg>" / "</math>" that pops nothing (the parser's </div> / </span> closed the
    // inner root) starts the stale state too — the <a> after it is HTML in the parser, so the outer svg/math stays open
    [`<svg><foreignObject><div><svg><g></div><a></svg></div></foreignObject></svg></a></foreignObject><style>${m2}</style>`, true, true],
    [`<math><mtext><span><math><mrow></span><a></math></span></mtext></math></a></mtext><style>${m2}</style>`, true, true],
    // … and the integration points are per namespace: svg desc/title and MathML mi/mo/mn/ms/mtext are points, so the "/>"
    // element after one is foreign again, the svg/math closes at its end tag and the <style> after it is HTML (hidden)
    [`<svg><desc>d</desc><path d="M0"/></svg><style>${m2}</style>`, false, false],
    [`<svg><title>t</title><path d="M0"/></svg><style>${m2}</style>`, false, false],
    [`<math><mi>x</mi><mspace/></math><style>${m2}</style>`, false, false], // A-F4B1-03
    [`<math><mtext>a</mtext><mspace/></math><style>${m2}</style>`, false, false],
    [`<math><mo>+</mo><mn>1</mn><ms>s</ms><mspace/></math><style>${m2}</style>`, false, false],
    // A-F4R2-02: a <font> without color/face/size is an svg element (the <style> in it is foreign: text); with one it
    // breaks out (the <style> is HTML: hidden)
    [`<svg><font><style>${m2}</style>`, true, true],
    [`<svg><font color=red><style>${m2}</style>`, false, false],
    [`<svg><g><font x=1></font><style>${m2}</style></g></svg>`, true, true],
  ];
  it.each(vsParse5)('vs parse5: %s', (body, parserShows, counted) => {
    const got = mentionsOf(page(body)).some((m) => m.id === V2.id && m.version === 2);
    if (parserShows) expect(got).toBe(true);
    expect(got).toBe(counted);
  });
  // Whole documents (not in page()): a frameset is counted like a select — <style> there is no raw text (ER-A-01)
  const vsParse5Documents: [string, boolean, boolean][] = [
    [`<frameset><style><noframes> ${m2} `, true, true],
    [`<!DOCTYPE html><html><head></head><frameset><style><noframes> ${m2} `, true, true],
    [`<frameset><noframes>${m2}</noframes></frameset>`, true, true],
    [`<frameset></frameset><style>${m2}</style>`, false, false],
    [`<frameset><style>${m2}</style></frameset>`, false, true], // the parser drops text in a frameset; the scan keeps it
  ];
  it.each(vsParse5Documents)('vs parse5 (document): %s', (html, parserShows, counted) => {
    const got = mentionsOf(html).some((m) => m.id === V2.id && m.version === 2);
    if (parserShows) expect(got).toBe(true);
    expect(got).toBe(counted);
  });
  // A-F4R2-02: FOREIGN_STACK_MAX open elements inside svg/math are followed (a comment after them stays hidden); one more
  // keeps the rest of the document as text — through each kind of entry: foreign elements, HTML elements in an
  // integration point, nested svg roots
  it.each([
    ['foreign <g> elements', (k: number) => `<svg>${'<g>'.repeat(k - 1)}`],
    ['HTML <b> elements in a foreignObject', (k: number) => `<svg><foreignObject>${'<b>'.repeat(k - 2)}`],
    ['nested <svg> roots', (k: number) => '<svg>'.repeat(k)],
  ] as const)('the open-element cap with %s: hidden at FOREIGN_STACK_MAX, the rest is text one over it', (_name, open) => {
    const v2 = (html: string) => mentionsOf(html).some((m) => m.id === V2.id && m.version === 2);
    expect(v2(`${open(FOREIGN_STACK_MAX)}<!-- ${m2} -->`)).toBe(false);
    expect(v2(`${open(FOREIGN_STACK_MAX + 1)}<!-- ${m2} -->`)).toBe(true);
    expect(v2(`${open(FOREIGN_STACK_MAX + 1)}<p>x</p><!-- ${m2} -->`)).toBe(true); // the rest, not just the next tag
  });
  it('the open-element cap: an HTML element over it keeps the svg the parser keeps open (its </svg> is ignored)', () => {
    // parse5 8.1.1: the <i> is HTML in the foreignObject, so the "</svg>" is ignored and the <style> is svg text
    const html = page(`<svg><foreignObject>${'<b>'.repeat(FOREIGN_STACK_MAX - 2)}<i></svg><style>${m2}</style>`);
    expect(mentionsOf(html)).toEqual([V2]);
  });
  it('mentions in the visible text are counted in order, each (id, version) pair once (M-M2-R2-5)', () => {
    expect(mentionsOf(page(`<p>${m1} and ${m2}</p><p>arXiv:math.gt/0701001v3</p>`))).toEqual([V1, V2, { id: 'math.gt/0701001', version: 3 }]);
    expect(mentionsOf(page(`<p>${`${m1} `.repeat(1_500)}</p>`))).toEqual([V1]);
    expect(mentionsOf(page(`<p>${m1} ${m2} arXiv:2301.00001v01 ${m1}</p>`))).toEqual([V1, V2]); // v01 is version 1
  });
});

describe('arxivMentions work is linear in the input (4 MB adversarial shapes)', () => {
  const n = BYTE_LIMITS.html;
  const fill = (unit: string, tail = '') => unit.repeat(Math.floor((n - tail.length) / unit.length)) + tail;
  const shapes: [string, string][] = [
    ['many small comments (no "--!>" anywhere)', fill('<!--a-->x')],
    ['many short scripts and styles', fill('<script>a</script><style>b</style>')],
    ['many "<!" without ">" after the first', fill('<!x ')],
    ['many tags with quoted and unquoted attributes', fill('<a b="c" d=\'e\' f=g h>')],
    ['many unterminated quotes', fill('<a b="')],
    ['many "<" that start nothing', fill('< a<1 </ ')],
    ['one unterminated comment', `<!--${'-'.repeat(n - 4)}`],
    ['one huge text with mentions', fill(`${m2} `)],
    ['many end tags with attributes', fill('</p x="y">')],
    ['many one-letter tags', fill('<s>')],
    ['many short tags with text', fill('<b>x')],
    ['many titles (kept raw text)', fill('<title>a</title>')],
    ['many svg/math/select open and closed', fill('<svg><style/></svg><math></math><select></select>')],
    // ER-A-01: the double-escape check in hidden scripts and the "<" check in skipped raw text inside svg/math/select
    ['many scripts with "<!--" and no "<script" after it', fill('<script><!--a--></script>')],
    ['many scripts with "<!--" each, one "<script" far after', fill('<script><!--a--></script>', '<script>x')],
    ['many svg titles and styles without "<" inside', fill('<svg><title>a</title><style>b</style></svg>')],
    ['many frameset open and closed', fill('<frameset><style>a</style></frameset>')],
    // A-F4R1-02: the open-element stack kept inside svg/math (pushes, pops, ignored "</svg>", the depth cap)
    ['many svg pictures with HTML in a foreignObject', fill('<svg><g><foreignObject><span>x</span></foreignObject></g></svg>')],
    ['many self-closed paths in one open svg', `<svg>${fill('<path d="M0 0"/>')}`],
    ['many unclosed HTML elements in one foreignObject (the stack cap)', `<svg><foreignObject>${fill('<b>x')}`],
    ['many unclosed foreign elements in one svg (the stack cap)', `<svg>${fill('<g>')}`],
    ['many ignored "</svg>" above an HTML element', `<svg><foreignObject><p>${fill('</svg>')}`],
    ['many svg with an HTML element left open in a foreignObject', fill('<svg><foreignObject><p></svg>')],
    // A-F4R2-01: the stale stack (every element after an ignored "</svg>" kept as HTML; reset when the stack is empty)
    ['many HTML elements opened while stale (the stack cap)', `<svg><foreignObject><svg><math></svg>${fill('<a>x')}`],
    ['many math with a name-only integration point, each closed', fill('<math><annotation-xml><ci>x</ci></annotation-xml></math>')],
    ['many stale end tags in one svg', `<svg><foreignObject><svg><math>${fill('</svg></g>')}`],
  ];
  // A script/style kept as text whose end tag never comes (in svg/math/select, or "<style/>") costs one search to the end
  // of the document per name — at most two (script, style), each once (A-F7-01)
  const searchShapes: [string, string][] = [
    ['many self-closed style and script in one open svg', `<svg>${fill('<style/><script/>', '')}`],
    ['many svg icons with self-closed style and script', fill('<svg><style/><script/></svg>')],
  ];
  it.each(shapes)('%s', (_name, html) => {
    const meter = { chars: 0, names: 0 };
    const t0 = Date.now();
    const out = mentionsOf(html, meter);
    expect(Date.now() - t0).toBeLessThan(10_000); // loose; the work counter decides
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(meter.chars).toBeGreaterThan(0);
    expect(meter.chars).toBeLessThanOrEqual(3 * html.length);
    expect(meter.names).toBeLessThanOrEqual(html.split('<').length - 1); // at most one name lookup per tag
  });
  it.each(searchShapes)('%s', (_name, html) => {
    const meter = { chars: 0, names: 0 };
    expect(mentionsOf(html, meter)).toEqual([]);
    expect(meter.chars).toBeLessThanOrEqual(3 * html.length + 2 * html.length);
  });
  // A tag name is cut, lower-cased and looked up only when its first letter and length can name an element the scan
  // acts on (review A-F7-03: the per-tag slice + toLowerCase + lookup made dense 4 MB tag shapes take 55–80 ms)
  it.each([
    ['<s>', 0],
    ['<b>x', 0],
    ['<p class="x">a</p>', 0],
    ['<span>a</span>', 1], // outside svg/math an end tag is looked up only when it can close a select or frameset
    ['<title>a</title>', 1],
    ['<svg><style/></svg>', 3],
    ['<svg><g><foreignObject><span>x</span></foreignObject></g></svg>', 8], // inside svg/math every tag, once (A-F4R1-02)
  ])('name lookups per unit of %s: %i', (unit, perUnit) => {
    const reps = 1_000;
    const meter = { chars: 0, names: 0 };
    mentionsOf(unit.repeat(reps), meter);
    expect(meter.names).toBe(perUnit * reps);
  });
});

describe('the version decision is not bound to the list cap (M-M2-R2-5)', () => {
  const many = (n: number) => `${m1} `.repeat(n);
  it('the mentions are the distinct (id, version) pairs in order of first appearance: v1 ×1,000 then v2 → both, no overflow', () => {
    const list = arxivMentions(page(`<p>${many(1_000)}${m2}</p>`));
    expect(list).toEqual({ mentions: [V1, V2], overflow: false });
    expect(versionVerdict(list, V1.id, 1)).toEqual({ kind: 'other', version: 2 });
    expect(versionVerdict(list, V1.id, 2)).toEqual({ kind: 'other', version: 1 });
    expect(versionVerdict(arxivMentions(page(`<p>${many(5_000)}</p>`)), V1.id, 1)).toEqual({ kind: 'same' });
  });
  it('more than MENTION_PAIRS_MAX distinct pairs → overflow, the version is unknown (a mismatch for the pipeline)', () => {
    const ids = Array.from({ length: MENTION_PAIRS_MAX + 1 }, (_, k) => `arXiv:2302.${String(10_000 + k)}v1`).join(' ');
    const list = arxivMentions(page(`<p>${ids} ${m1}</p>`));
    expect(list.overflow).toBe(true);
    expect(list.mentions).toHaveLength(MENTION_PAIRS_MAX);
    expect(versionVerdict(list, V1.id, 1)).toEqual({ kind: 'unknown' });
    // exactly MENTION_PAIRS_MAX distinct pairs is not an overflow
    const atCap = arxivMentions(page(`<p>${Array.from({ length: MENTION_PAIRS_MAX - 1 }, (_, k) => `arXiv:2302.${String(10_000 + k)}v1`).join(' ')} ${m1}</p>`));
    expect(atCap).toMatchObject({ overflow: false });
    expect(atCap.mentions).toHaveLength(MENTION_PAIRS_MAX);
    expect(versionVerdict(atCap, V1.id, 1)).toEqual({ kind: 'same' });
    // another version among the kept pairs decides even when the list overflowed
    expect(versionVerdict(arxivMentions(page(`<p>${m2} ${ids}</p>`)), V1.id, 1)).toEqual({ kind: 'other', version: 2 });
  });
  it('no mention of the id, or another id only → same (accepted)', () => {
    expect(versionVerdict(arxivMentions(page('<p>none</p>')), V1.id, 1)).toEqual({ kind: 'same' });
    expect(versionVerdict(arxivMentions(page('<p>arXiv:2301.00009v4</p>')), V1.id, 1)).toEqual({ kind: 'same' });
  });
});

describe("the parser's text: the structure step checks the version on the text linkedom built (M-M2-R2-5)", () => {
  const ABSTRACT = 'arXiv:0000.00001v1</p>';
  const withBody = (extra: string) => SYN_M2_HTML.replace(ABSTRACT, `${ABSTRACT}${extra}`);
  const own = { id: '0000.00001', version: 1 };
  const other = { id: '2301.00002', version: 2 };
  it('an entity or an inline element inside the mention: the raw scan misses it, the parsed text has it', () => {
    for (const extra of ['<p>arXiv:2301&#46;00002v2</p>', '<p>arXiv:2301.<b>00002</b>v2</p>', '<p>arXiv&#58;2301.00002v2</p>', '<p>arXiv:<span>2301.00002</span>v2</p>']) {
      const html = withBody(extra);
      expect(mentionsOf(html), extra).toEqual([own]);
      const s = parse(html);
      expect(s.textMentions, extra).toEqual({ mentions: [own, other], overflow: false });
      expect(versionVerdict(s.textMentions, '2301.00002', 1), extra).toEqual({ kind: 'other', version: 2 });
    }
    // a comment inside the mention: both readings join the text around it
    const c = withBody('<p>arXiv:2301.00002<!-- x -->v2</p>');
    expect(mentionsOf(c)).toEqual([own, other]);
    expect(parse(c).textMentions.mentions).toEqual([own, other]);
  });
  it('comments, script, style and template content are not text; blocks and line breaks separate the text', () => {
    const hidden = '<!-- arXiv:2301.00002v2 --><script>"arXiv:2301.00002v3"</script><style>/* arXiv:2301.00002v4 */</style><template><p>arXiv:2301.00002v5</p></template>';
    expect(parse(withBody(hidden)).textMentions).toEqual({ mentions: [own], overflow: false });
    for (const split of ['<p>arXiv:2301.00002</p><p>v2</p>', '<div>arXiv:2301.00002</div>v2', 'arXiv:2301.00002<br>v2', '<table><tr><td>arXiv:2301.00002</td><td>v2</td></tr></table>']) {
      expect(parse(withBody(split)).textMentions.mentions, split).toEqual([own]);
    }
    // an element that is not a block (here an unknown one) runs on — the stricter reading
    expect(parse(withBody('<x-y>arXiv:2301.00002</x-y><x-z>v2</x-z>')).textMentions.mentions).toEqual([own, other]);
  });
  // A-FX-01: text drawn raised or lowered (sup, sub) does not run on into the version before it — LaTeXML's footnote
  // mark or a superscript citation right after the paper's own version is not a longer version
  it.each([
    ['a superscript', '<sup>2</sup>'],
    ['a superscript citation', '<sup class="ltx_sup">3</sup>'],
    ["LaTeXML's footnote mark (the real fixtures' markup)", latexmlFootnote(1)],
    ['a subscript', '<sub>2</sub>'],
  ])("the paper's own version followed by %s → same: the walk separates sup and sub (A-FX-01)", (_n, after) => {
    const html = withBody(`<p>A preprint is available as arXiv:0000.00001v1${after}.</p>`);
    expect(mentionsOf(html)).toEqual([own]);
    const s = parse(html);
    expect(s.textMentions).toEqual({ mentions: [own], overflow: false });
    expect(versionVerdict(s.textMentions, own.id, 1)).toEqual({ kind: 'same' });
  });
  it('any other inline element still runs on: inside a mention → that version, after the own version → a longer one (A-FX-01)', () => {
    const inside = parse(withBody('<p>arXiv:2301.<b>00002</b>v2</p>')).textMentions;
    expect(inside).toEqual({ mentions: [own, other], overflow: false });
    expect(versionVerdict(inside, '2301.00002', 1)).toEqual({ kind: 'other', version: 2 });
    // stricter than the reader sees it: a digit in a span right after the own version is read as part of it (refused)
    const after = parse(withBody('<p>arXiv:0000.00001v1<span>3</span>.</p>')).textMentions;
    expect(versionVerdict(after, own.id, 1)).toEqual({ kind: 'other', version: 13 });
  });
  // A-FX5-R1-01: a sup or sub separates only where it holds text — one that draws nothing (empty, or only a comment,
  // script or an empty element) runs on like the text it sits in, so it does not hide a mention it splits
  it.each([
    ['an empty sup between the id and the version', '<p>arXiv:2301.00002<sup></sup>v2</p>'],
    ['an empty sub between v and the number', '<p>arXiv:2301.00002v<sub></sub>2</p>'],
    ['an empty sup after "arXiv:"', '<p>arXiv:<sup></sup>2301.00002v2</p>'],
    ['an empty sup nested in another inline element', '<p>arXiv:2301.<b>00002<sup></sup></b>v2</p>'],
    ['an empty sup with attributes', '<p>arXiv:2301.00002v<sup class="ltx_sup"></sup>2</p>'],
    ['a sup holding only a comment', '<p>arXiv:2301.00002<sup><!-- x --></sup>v2</p>'],
    ['a sup holding only a script', '<p>arXiv:2301.00002<sup><script>1</script></sup>v2</p>'],
    ['a sup holding only an empty span', '<p>arXiv:2301.00002<sup><span></span></sup>v2</p>'],
    ['a sub holding an empty sup', '<p>arXiv:2301.00002<sub><sup></sup></sub>v2</p>'],
  ])('%s draws nothing → the mention reads as written: other (A-FX5-R1-01)', (_n, body) => {
    const s = parse(withBody(body));
    expect(s.textMentions).toEqual({ mentions: [own, other], overflow: false });
    expect(versionVerdict(s.textMentions, '2301.00002', 1)).toEqual({ kind: 'other', version: 2 });
  });
  it('an empty sup right after the own version runs on into a digit after it (stricter, A-FX5-R1-01); one with text still separates', () => {
    const empty = parse(withBody('<p>arXiv:0000.00001v1<sup></sup>3.</p>')).textMentions;
    expect(versionVerdict(empty, own.id, 1)).toEqual({ kind: 'other', version: 13 });
    for (const body of ['<p>arXiv:0000.00001v1<sup><!-- x -->2</sup>.</p>', '<p>arXiv:0000.00001v1<sup><span></span>2</sup>.</p>', '<p>arXiv:0000.00001v1<sup><sup></sup>2</sup>.</p>', '<p>arXiv:0000.00001v1<sub><sup>2</sup></sub>.</p>']) {
      expect(parse(withBody(body)).textMentions, body).toEqual({ mentions: [own], overflow: false });
    }
    // a sup holding text splits a mention at its first text: the part before it is not joined to the part inside
    expect(parse(withBody('<p>arXiv:2301.<sup>a</sup>00002v2</p>')).textMentions.mentions).toEqual([own]);
    expect(parse(withBody('<p>arXiv:2301.<sup>00002</sup>v2</p>')).textMentions.mentions).toEqual([own]);
  });
  // A-FX5-R2-01: the rest of the RAISED counting — each row passes at HEAD and fails when one part of it is dropped
  // (mutants in .data/m2-a/scratch/review-fix5-r2/mut, run by the repo tests through an alias)
  it.each([
    // the count of sups holding text goes back down at the end of one: a later sup separates at its first text too —
    // the usual shape of a paper, where an author or affiliation mark comes before the mention
    ['a sup holding text before it in the document (an affiliation mark)', '<p><sup>1</sup> Text. arXiv:0000.00001v1<sup>2</sup>.</p>'],
    ["LaTeXML's affiliation mark before it, then LaTeXML's footnote mark", `<p>A. Author<sup class="ltx_sup">1</sup>. arXiv:0000.00001v1${latexmlFootnote(1)}.</p>`],
    // the end of a sup that held text separates: the text after it does not run on into the mention inside it
    ['the mention inside a sup, a digit after it', '<p><sup>arXiv:0000.00001v1</sup>3</p>'],
    // a text node marks every open sup or sub as holding text, not only the innermost: the outer sup ends the run too
    ['the mention in a sub inside a sup, a digit after the sub in the sup', '<p><sup><sub>arXiv:0000.00001v1</sub>2</sup></p>'],
  ])('%s → the own version only (A-FX5-R2-01)', (_n, body) => {
    const s = parse(withBody(body));
    expect(s.textMentions).toEqual({ mentions: [own], overflow: false });
    expect(versionVerdict(s.textMentions, own.id, 1)).toEqual({ kind: 'same' });
  });
  it('v1 ×1,000 then v2 in the parsed text → both pairs; more than MENTION_PAIRS_MAX distinct pairs → overflow', () => {
    const s = parse(withBody(`<p>${'arXiv:2301.00002v1 '.repeat(1_000)}arXiv:2301.00002v2</p>`));
    expect(s.textMentions).toEqual({ mentions: [own, { id: '2301.00002', version: 1 }, other], overflow: false });
    const ids = Array.from({ length: MENTION_PAIRS_MAX }, (_, k) => `arXiv:2302.${String(10_000 + k)}v1`).join(' ');
    const o = parse(withBody(`<p>${ids}</p>`)).textMentions;
    expect(o.overflow).toBe(true);
    expect(versionVerdict(o, '0000.00001', 1)).toEqual({ kind: 'unknown' });
  });
  it('the fixture: the abstract mention only', () => {
    expect(parse(SYN_M2_HTML).textMentions).toEqual({ mentions: [own], overflow: false });
  });
  // linkedom keeps text before the first element at document level (and puts the doctype first): the walk reads every
  // child of the document, not only the document element (A-F4R1-01)
  it.each([
    ['at the start of the document', (m: string) => `${m}${SYN_M2_HTML}`],
    ['between the doctype and <html>', (m: string) => SYN_M2_HTML.replace('<!DOCTYPE html>', `<!DOCTYPE html>${m}`)],
    ['after </html>', (m: string) => `${SYN_M2_HTML}${m}`],
  ])('another version outside the document element (%s) is in the parsed text', (_n, place) => {
    for (const m of ['arXiv:2301&#46;00002v2', 'arXiv:2301.<b>00002</b>v2', 'arXiv&#58;2301.00002v2']) {
      const html = place(m);
      expect(mentionsOf(html), m).toEqual([own]);
      const s = parse(html);
      expect(s.textMentions.mentions, m).toContainEqual(other);
      expect(s.textMentions.mentions, m).toContainEqual(own);
      expect(versionVerdict(s.textMentions, '2301.00002', 1), m).toEqual({ kind: 'other', version: 2 });
    }
  });
  it('a comment or the doctype before <html> is not text', () => {
    expect(parse(`<!-- arXiv:2301.00002v2 -->${SYN_M2_HTML}`).textMentions).toEqual({ mentions: [own], overflow: false });
    expect(parse(SYN_M2_HTML.replace('<!DOCTYPE html>', '<!DOCTYPE html><!-- arXiv:2301&#46;00002v2 -->')).textMentions).toEqual({ mentions: [own], overflow: false });
  });
});

// Known limits recorded in latexml.ts, not fixed: parse5 8.1.1 shows the other version in each of these bodies (taken
// offline, .data/m2-a/scratch/fix7/limits.txt and fix8/limits2.txt), yet both checks miss it and the version reads
// "same". Pinned so the header stays true; a change that closes one of them updates this list and the header together.
describe('known limits: forms both version checks miss although the parser shows the mention', () => {
  const ABSTRACT = 'arXiv:0000.00001v1</p>';
  const withBody = (extra: string) => SYN_M2_HTML.replace(ABSTRACT, `${ABSTRACT}${extra}`);
  const missed = (body: string) => {
    const html = withBody(body);
    const s = parse(html);
    expect(versionVerdict(arxivMentions(html), V1.id, 1)).toEqual({ kind: 'same' });
    expect(versionVerdict(s.textMentions, V1.id, 1)).toEqual({ kind: 'same' });
  };
  it('control: the same mention as plain text reads "other" in both checks', () => {
    const html = withBody(`<p>${m2}</p>`);
    expect(versionVerdict(arxivMentions(html), V1.id, 1)).toEqual({ kind: 'other', version: 2 });
    expect(versionVerdict(parse(html).textMentions, V1.id, 1)).toEqual({ kind: 'other', version: 2 });
  });
  it.each([
    ['td', `<svg><foreignObject><table><td><svg><foreignObject><td></td></foreignObject><a></svg></td></table>x</foreignObject></svg></a></foreignObject><style>${m2}</style>`],
    ['caption', `<svg><foreignObject><table><caption><svg><foreignObject><caption></caption></foreignObject><a></svg></caption></table>x</foreignObject></svg></a></foreignObject><style>${m2}</style>`],
    ['math/mtext', `<math><mtext><table><td><math><mtext><td></td></mtext><a></math></td></table>x</mtext></math></a></mtext><style>${m2}</style>`],
  ])('A-F4R3-01: a table part start tag in a nested integration point (%s)', (_n, body) => missed(body));
  it.each([
    ['an entity inside a textarea', '<textarea>arXiv:2301&#46;00001v2</textarea>'],
    ['a CDATA section inside an svg', '<svg><text>arXiv:2301.<![CDATA[00001]]>v2</text></svg>'],
    ['a NUL', '<p>arXiv:2301.00001\u0000v2</p>'],
    ['a stray <td> in body text', '<p>arXiv:2301.<td>00001v2</p>'],
    ['a stray <tr>', '<p>arXiv:2301.<tr>00001v2</p>'],
    ['a stray <caption>', '<p>arXiv:2301.<caption>00001v2</p>'],
    ['a stray <head>', '<p>arXiv:2301.<head>00001v2</p>'],
    ['a stray <body>', '<p>arXiv:2301.<body>00001v2</p>'],
    ['a stray <html>', '<p>arXiv:2301.<html>00001v2</p>'],
    ['text moved out of a table', '<table><tr><td>a</td></tr>arXiv:2301.<tr><td>b</td></tr>00001v2</table>'],
  ])('A-F4R1-05 / A-F4R2-03: a mention split or encoded where only the HTML parser joins it (%s)', (_n, body) => missed(body));
  // A-F4B1-02: more forms of the same limits (the header lists examples, not a closed list; .data/m2-a/scratch/fix8/limits2.txt)
  it.each([
    ['a stray <th>', '<p>arXiv:2301.<th>00001v2</p>'],
    ['a stray <tbody>', '<p>arXiv:2301.<tbody>00001v2</p>'],
    ['a stray <thead>', '<p>arXiv:2301.<thead>00001v2</p>'],
    ['a stray <tfoot>', '<p>arXiv:2301.<tfoot>00001v2</p>'],
    ['a stray </body>', '<p>arXiv:2301.</body>00001v2</p>'],
    ['a stray </html>', '<p>arXiv:2301.</html>00001v2</p>'],
    ['a nested <form>', '<form>arXiv:2301.<form>00001v2</form>'],
    ['a <div> inside a select', '<select>arXiv:2301.<div>00001v2</select>'],
    ['a <td> inside a select', '<select>arXiv:2301.<td>00001v2</select>'],
    ['a NUL inside a select', '<select>arXiv:2301.00001\u0000v2</select>'],
    ['a NUL inside a table cell', '<table><tr><td>arXiv:2301.00001\u0000v2</td></tr></table>'],
    ['a CDATA section inside a math mrow', '<math><mrow>arXiv:2301.<![CDATA[00001]]>v2</mrow></math>'],
    ['a CDATA section directly inside a math', '<math>arXiv:2301.<![CDATA[00001]]>v2</math>'],
    ['an entity inside an svg <style>', '<svg><style>arXiv:2301&#46;00001v2</style></svg>'],
    ['an entity inside an svg <script>', '<svg><script>arXiv:2301&#46;00001v2</script></svg>'],
    ['an entity inside a math <style>', '<math><style>arXiv:2301&#46;00001v2</style></math>'],
    ['an entity inside a <style> in a select', '<select><style>arXiv:2301&#46;00001v2</style></select>'],
  ])('A-F4B1-02: a mention split or encoded where only the HTML parser joins it (%s)', (_n, body) => missed(body));
  // A-FX-01: sup and sub separate the parsed text (a footnote mark after the own version is not a longer version), so
  // a version — or any part of a mention — drawn raised or lowered is not read; the raw scan stops at the tag. A-FX5-R1-01:
  // only a sup or sub that holds text separates (an empty one runs on — the parsed-text describe above)
  it.each([
    ['a superscript', '<p>arXiv:2301.00001v<sup>2</sup></p>'],
    ['a subscript', '<p>arXiv:2301.00001v<sub>2</sub></p>'],
    ['a superscript, after an empty sup', '<p>arXiv:2301.00001<sup></sup>v<sup>2</sup></p>'],
    ['a superscript inside another inline element', '<p>arXiv:2301.00001v<b><sup>2</sup></b></p>'],
  ])('A-FX-01: the version number written in %s', (_n, body) => missed(body));
  // A-FX5-R2-01: the end of a sup or sub that holds text separates too — a version written after it is not read
  it.each([
    ['after the id in a superscript', '<p><sup>arXiv:2301.00001</sup>v2</p>'],
    ['after the id in a subscript', '<p><sub>arXiv:2301.00001</sub>v2</p>'],
  ])('A-FX5-R2-01: the version written %s', (_n, body) => missed(body));
});
