// PDF links (BRIEF_C C4): citation-number table, references matching (exactly one item), internal default move,
// external confirm with the host + noopener, other schemes ignored, and glyphs read only inside the link rect.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceDto } from '@study-paper/shared/contracts/api';
import { citationNumber, classifyLink, handleLinkClick, isCitationDestination, isInternalLink, namedDestination, openExternal, referenceForNumber, textInRect, type LinkHandlerContext } from '../../src/viewer/links';

const ref = (ordinal: number, label: string | null): ReferenceDto => ({
  id: `r${ordinal}-${label}`,
  ordinal,
  label,
  rawText: 'x',
  title: null,
  authors: [],
  year: null,
  venue: null,
  doi: null,
  arxivId: null,
  citationCount: null,
  inLibraryPaperId: null,
  htmlId: null,
});
const REFS = Array.from({ length: 14 }, (_, i) => ref(i + 1, `[${i + 1}]`));

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('citation number in the link text', () => {
  it.each([
    ['[12]', 12],
    ['12', 12],
    ['12,', 12],
    ['12;', 12],
    [' [ 3 ] ', 3],
    ['[1, 2]', null],
    ['[Smith20]', null],
    ['1–3', null],
    ['1234', null],
    ['Section II', null],
    ['', null],
    ['[12].', null],
  ] as const)('%j → %s', (text, n) => {
    expect(citationNumber(text)).toBe(n);
  });
});

describe('classifyLink (internal)', () => {
  const internal = (text: string, references: readonly ReferenceDto[] = REFS) => classifyLink({ href: '#cite.ref', internal: true, text, references });
  it('a number with exactly one reference → the references panel', () => {
    expect(internal('[12]')).toEqual({ kind: 'reference', referenceOrdinal: 12 });
    expect(internal('12')).toEqual({ kind: 'reference', referenceOrdinal: 12 });
  });
  it('[1, 2], [Smith20], a number not in the references → default internal move', () => {
    expect(internal('[1, 2]')).toEqual({ kind: 'internal' });
    expect(internal('[Smith20]')).toEqual({ kind: 'internal' });
    expect(internal('[99]')).toEqual({ kind: 'internal' });
    expect(internal('[1]', [])).toEqual({ kind: 'internal' }); // a paper without structure
  });
  it('the same number on two items (ordinal of one, label of another) → default move', () => {
    const refs = [ref(1, '[2]'), ref(2, '[3]')];
    expect(referenceForNumber(2, refs)).toBeNull();
    expect(internal('[2]', refs)).toEqual({ kind: 'internal' });
    expect(internal('[3]', refs)).toEqual({ kind: 'reference', referenceOrdinal: 2 }); // label only
    expect(internal('[5]', [ref(5, '[5]'), ref(6, '5')])).toEqual({ kind: 'internal' });
  });
  it('a label that is not a number never matches by text', () => {
    expect(referenceForNumber(12, [ref(1, '[Smith12]')])).toBeNull();
  });
  // C-R1-03: links counted in the KISS-ICP / FAST-LIO2 fixtures whose text is one number but whose target is not a
  // bibliography entry (figure, equation, footnote, algorithm, table, section) and explicit destinations
  it.each([
    ['#figure.3', '3'],
    ['#figure.caption.1', '2'],
    ['#equation.3.5', '5'],
    ['#equation.3.5', '(5)'],
    ['#Hfootnote.1', '1'],
    ['#algocf.2', '2'],
    ['#table.1', '1'],
    ['#section.2', '2'],
    ['#page=3', '3'],
    [`#${escape(JSON.stringify([{ num: 12, gen: 0 }, { name: 'XYZ' }, 72, 700, 0]))}`, '[3]'],
    ['#', '3'],
    [null, '3'],
  ] as const)('%s with text %j → default internal move, never a reference', (href, text) => {
    expect(classifyLink({ href, internal: true, text, references: REFS })).toEqual({ kind: 'internal' });
  });
  it('a citation destination keeps the number rule (also behind a base URL and for biblatex names)', () => {
    expect(classifyLink({ href: 'http://127.0.0.1/doc.pdf#cite.ref3', internal: true, text: '3', references: REFS })).toEqual({ kind: 'reference', referenceOrdinal: 3 });
    expect(classifyLink({ href: '#cite.0@smith20', internal: true, text: '[4]', references: REFS })).toEqual({ kind: 'reference', referenceOrdinal: 4 });
  });
  it('namedDestination / isCitationDestination', () => {
    expect(namedDestination('#cite.ref1')).toBe('cite.ref1');
    expect(namedDestination('#figure.3')).toBe('figure.3');
    expect(namedDestination(`#${escape('cite.Müller')}`)).toBe('cite.Müller');
    expect(namedDestination(`#${escape('[{"num":1}]')}`)).toBeNull();
    expect(namedDestination('#')).toBeNull();
    expect(namedDestination('cite.ref1')).toBeNull();
    expect(isCitationDestination('#cite.ref1')).toBe(true);
    expect(isCitationDestination('#citation.1')).toBe(false);
    expect(isCitationDestination('#xcite.1')).toBe(false);
  });
});

describe('classifyLink (external)', () => {
  const ext = (href: string | null) => classifyLink({ href, internal: false, text: '', references: REFS });
  it('http(s) → external with its host', () => {
    expect(ext('https://github.com/PRBonn/kiss-icp')).toEqual({ kind: 'external', url: 'https://github.com/PRBonn/kiss-icp', host: 'github.com' });
    expect(ext('http://example.org:8080/a')).toMatchObject({ kind: 'external', host: 'example.org:8080' });
  });
  it('javascript:, file:, data:, mailto:, relative and empty hrefs are ignored', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'mailto:a@b.c', '/relative', '', null]) expect(ext(href), String(href)).toEqual({ kind: 'ignore' });
  });
  it('openExternal opens a new tab with noopener,noreferrer and only for http(s)', () => {
    const open = vi.fn();
    openExternal('https://example.org/x', open);
    expect(open).toHaveBeenCalledWith('https://example.org/x', '_blank', 'noopener,noreferrer');
    openExternal('javascript:alert(1)', open);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

/**
 * A page with a text layer line and one annotation link in pdf.js 6.5's shape (an internal link's section carries
 * data-internal-link); glyph boxes 10 px wide starting at x = 0.
 */
function linkPage(line: string, link: { href: string; internal: boolean; left: number; right: number }) {
  document.body.innerHTML = `<div class="page" data-page-number="1"><div class="textLayer"><span id="line">${line}</span></div><div class="annotationLayer"><section class="linkAnnotation"${link.internal ? ' data-internal-link=""' : ''}><a id="a" href="${link.href}"></a></section></div></div>`;
  const span = document.getElementById('line')!;
  span.getBoundingClientRect = () => ({ left: 0, right: line.length * 10, top: 100, bottom: 112, width: line.length * 10, height: 12, x: 0, y: 100, toJSON() {} }) as DOMRect;
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
    const i = this.startOffset;
    return { left: i * 10, right: i * 10 + 10, top: 100, bottom: 112, width: 10, height: 12, x: i * 10, y: 100, toJSON() {} } as DOMRect;
  });
  const section = document.querySelector('section')!;
  section.getBoundingClientRect = () => ({ left: link.left, right: link.right, top: 98, bottom: 114, width: link.right - link.left, height: 16, x: link.left, y: 98, toJSON() {} }) as DOMRect;
  return document.getElementById('a') as HTMLAnchorElement;
}
const ctx = (references: readonly ReferenceDto[] = REFS) => {
  const c = { references: () => references, focusReference: vi.fn(), beforeInternalJump: vi.fn(), confirmExternal: vi.fn() } satisfies LinkHandlerContext;
  return c;
};
const click = (a: Element) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: a });
  return e;
};

describe('textInRect / handleLinkClick', () => {
  const LINE = 'earlier synthetic work [12].'; // "[12]" = characters 23–26 → x 230–270
  it('reads only the glyphs whose centre is inside the link rect', () => {
    linkPage(LINE, { href: '#cite.ref12', internal: true, left: 228, right: 272 });
    expect(textInRect(document.querySelector('.textLayer')!, { left: 228, right: 272, top: 98, bottom: 114 })).toBe('[12]');
    expect(textInRect(document.querySelector('.textLayer')!, { left: 228, right: 272, top: 98, bottom: 114 }, 5)).toBe(''); // over budget → unknown
  });
  it('[12] link with one reference → focus the references panel, no pdf.js move', () => {
    const a = linkPage(LINE, { href: '#cite.ref12', internal: true, left: 228, right: 272 });
    const c = ctx();
    const e = click(a);
    handleLinkClick(e, c);
    expect(c.focusReference).toHaveBeenCalledWith(12);
    expect(e.defaultPrevented).toBe(true);
    expect(c.beforeInternalJump).not.toHaveBeenCalled();
  });
  it('a link rect that also covers the "." → not one number → default move with a stack push', () => {
    const a = linkPage(LINE, { href: '#cite.ref12', internal: true, left: 228, right: 282 });
    const c = ctx();
    const e = click(a);
    handleLinkClick(e, c);
    expect(c.focusReference).not.toHaveBeenCalled();
    expect(c.beforeInternalJump).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
  });
  it('"Fig. 3" link (figure destination, text "3", reference [3] exists) → stack push and pdf.js moves; glyphs not read', () => {
    const a = linkPage('see Fig. 3 for', { href: '#figure.3', internal: true, left: 88, right: 102 });
    const c = ctx();
    const e = click(a);
    vi.mocked(Range.prototype.getBoundingClientRect).mockClear();
    handleLinkClick(e, c);
    expect(c.focusReference).not.toHaveBeenCalled();
    expect(c.beforeInternalJump).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
    expect(Range.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  });
  it('an internal link without a citation number ("Section II") → stack push, pdf.js moves', () => {
    const a = linkPage('see Section II.', { href: '#page=2', internal: true, left: 38, right: 142 });
    const c = ctx();
    const e = click(a);
    handleLinkClick(e, c);
    expect(c.beforeInternalJump).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
  });
  it('pdf.js named action / attachment / OCG link (href "", section data-internal-link) → stack push, pdf.js runs it (C-R2-02)', () => {
    const a = linkPage('next page', { href: '', internal: true, left: 0, right: 90 });
    expect(a.getAttribute('href')).toBe('');
    expect(isInternalLink(a)).toBe(true);
    const c = ctx();
    const e = click(a);
    handleLinkClick(e, c);
    expect(c.beforeInternalJump).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
    expect(c.focusReference).not.toHaveBeenCalled();
    expect(c.confirmExternal).not.toHaveBeenCalled();
    const mid = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    Object.defineProperty(mid, 'target', { value: a });
    handleLinkClick(mid, c);
    expect(mid.defaultPrevented).toBe(true); // a middle click on an internal link is dropped
    expect(c.confirmExternal).not.toHaveBeenCalled();
  });
  it('internal = the section mark or a "#…" href; an empty href without the mark is not internal', () => {
    let a = linkPage('x', { href: '#figure.3', internal: false, left: 0, right: 10 });
    expect(isInternalLink(a)).toBe(true);
    a = linkPage('x', { href: '', internal: false, left: 0, right: 10 });
    expect(isInternalLink(a)).toBe(false);
    const c = ctx();
    const e = click(a);
    handleLinkClick(e, c);
    expect(c.beforeInternalJump).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true); // ignored, as before
  });
  it('an external link → confirmation with the host (default prevented); javascript: → ignored', () => {
    let a = linkPage('code', { href: 'https://github.com/x/y', internal: false, left: 0, right: 40 });
    let c = ctx();
    let e = click(a);
    handleLinkClick(e, c);
    expect(c.confirmExternal).toHaveBeenCalledWith('https://github.com/x/y', 'github.com');
    expect(e.defaultPrevented).toBe(true);
    a = linkPage('x', { href: 'javascript:alert(1)', internal: false, left: 0, right: 10 });
    c = ctx();
    e = click(a);
    handleLinkClick(e, c);
    expect(e.defaultPrevented).toBe(true);
    expect(c.confirmExternal).not.toHaveBeenCalled();
    expect(c.beforeInternalJump).not.toHaveBeenCalled();
  });
  it('middle click (auxclick) on an external link → the same confirmation, the browser does not open a tab', () => {
    const a = linkPage('code', { href: 'https://github.com/x/y', internal: false, left: 0, right: 40 });
    const c = ctx();
    const e = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    Object.defineProperty(e, 'target', { value: a });
    handleLinkClick(e, c);
    expect(e.defaultPrevented).toBe(true);
    expect(c.confirmExternal).toHaveBeenCalledWith('https://github.com/x/y', 'github.com');
  });
  it('middle click on an internal link is dropped (no tab, no move, no stack push); a right-button auxclick is left alone', () => {
    const a = linkPage(LINE, { href: '#cite.ref12', internal: true, left: 228, right: 272 });
    const c = ctx();
    const mid = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    Object.defineProperty(mid, 'target', { value: a });
    handleLinkClick(mid, c);
    expect(mid.defaultPrevented).toBe(true);
    expect(c.focusReference).not.toHaveBeenCalled();
    expect(c.beforeInternalJump).not.toHaveBeenCalled();
    const right = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 });
    Object.defineProperty(right, 'target', { value: a });
    handleLinkClick(right, c);
    expect(right.defaultPrevented).toBe(false);
  });
  it('a click outside the annotation layer is left alone', () => {
    linkPage(LINE, { href: '#x', internal: true, left: 0, right: 10 });
    const c = ctx();
    const e = click(document.getElementById('line')!);
    handleLinkClick(e, c);
    expect(e.defaultPrevented).toBe(false);
    expect(Object.values(c).filter((f) => typeof f === 'function' && 'mock' in f && (f as ReturnType<typeof vi.fn>).mock.calls.length)).toHaveLength(0);
  });
});
