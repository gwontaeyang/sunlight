// happy-dom fake pdf.js text layers: Range restore from a quote and the N1 re-check (PLAN 5.3 web flow).
import { beforeEach, describe, expect, it } from 'vitest';
import { anchorQuoteInTextLayer, rangeFromOffsets, rangeMatchesQuote, rangeOffsets, rangeTextWithBreaks, textLayerText } from '../../src/viewer/domAnchor';

/** Builds a text layer like pdf.js 6: one span per text item, <br> after hasEOL items, marked content nesting. */
function makeLayer(lines: string[][], extra = ''): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  layer.innerHTML =
    lines.map((items) => items.map((t) => `<span role="presentation">${t}</span>`).join('') + '<br role="presentation">').join('') +
    extra +
    '<div class="PdfHighlighter__highlight-layer"><div class="sp-hl"><div class="sp-hl-part">not text</div></div></div><div class="endOfContent"></div>';
  document.body.appendChild(layer);
  return layer;
}

const LINES = [
  ['SYNTHETIC TEST PAPER - NOT A REAL PUBLICATION'],
  ['We estimate the robot pose by minimizing the point-to-'],
  ['point residual between consecutive scans. The data asso-'],
  ['ciation uses a fixed threshold of 0.5 m and a ', 'robust kernel', '.'],
  ['The robust kernel down-weights outliers.'],
];
const TEXT = LINES.map((l) => l.join('') + '\n').join('');

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('textLayerText', () => {
  it('equals the PageText model (text nodes + <br> as \\n) and skips overlay layers', () => {
    const dpt = textLayerText(makeLayer(LINES));
    expect(dpt.text).toBe(TEXT);
    expect(dpt.text).not.toContain('not text');
  });
  it('walks nested marked-content spans', () => {
    const layer = makeLayer([], '<span class="markedContent"><span>inner</span><span class="markedContent"><span> deep</span></span></span><br>');
    expect(textLayerText(layer).text).toBe('inner deep\n');
  });
});

describe('Range ↔ offsets', () => {
  it('rangeFromOffsets / rangeOffsets round trip, across <br> and spans', () => {
    const layer = makeLayer(LINES);
    const dpt = textLayerText(layer);
    const start = TEXT.indexOf('The data');
    const end = TEXT.indexOf(' uses a fixed') + ' uses'.length;
    const range = rangeFromOffsets(dpt, start, end)!;
    expect(range.toString()).toBe('The data asso-ciation uses');
    expect(rangeTextWithBreaks(range)).toBe('The data asso-\nciation uses');
    expect(rangeOffsets(dpt, range)).toEqual({ start, end });
  });
  it('element boundary points (selection ending on the layer / endOfContent) map to text offsets', () => {
    const layer = makeLayer(LINES);
    const dpt = textLayerText(layer);
    const r = document.createRange();
    r.setStart(layer.children[2]!.firstChild!, 3); // inside line 2 span
    r.setEnd(layer, layer.childNodes.length); // after everything
    expect(rangeOffsets(dpt, r)).toEqual({ start: TEXT.indexOf('We estimate') + 3, end: TEXT.length });
  });
});

describe('anchorQuoteInTextLayer', () => {
  it('restores a verbatim quote as a DOM Range whose text re-checks against the quote', () => {
    const layer = makeLayer(LINES);
    const r = anchorQuoteInTextLayer(layer, 1, 'We estimate the robot pose by minimizing the point-to-point residual');
    expect(r.status).toBe('located');
    if (r.status !== 'located') return;
    expect(rangeTextWithBreaks(r.range)).toBe('We estimate the robot pose by minimizing the point-to-\npoint residual');
    expect(TEXT.slice(r.start, r.end)).toBe('We estimate the robot pose by minimizing the point-to-\npoint residual');
  });
  it('a quote that drops a line-end hyphen is located (re-check allows it)', () => {
    const r = anchorQuoteInTextLayer(makeLayer(LINES), 1, 'The data association uses a fixed threshold');
    expect(r.status).toBe('located');
  });
  it('a quote crossing item spans inside one line is located', () => {
    const r = anchorQuoteInTextLayer(makeLayer(LINES), 1, 'and a robust kernel.');
    expect(r.status).toBe('located');
    if (r.status === 'located') expect(r.range.toString()).toBe('and a robust kernel.');
  });
  it('a quote occurring twice on the page needs the server position to pick one', () => {
    const layer = makeLayer(LINES);
    expect(anchorQuoteInTextLayer(layer, 1, 'robust kernel')).toEqual({ status: 'page_only', reason: 'ambiguous' });
    const second = TEXT.lastIndexOf('robust kernel');
    const r = anchorQuoteInTextLayer(layer, 1, 'robust kernel', second);
    expect(r).toMatchObject({ status: 'located', start: second });
    expect(anchorQuoteInTextLayer(layer, 1, 'robust kernel', 3)).toMatchObject({ status: 'page_only' });
  });
  it('fuzzy (nonlinear / changed word) is never located: page only, no Range', () => {
    expect(anchorQuoteInTextLayer(makeLayer(LINES), 1, 'We estimate the robot pose by maximizing the point-to-point residual')).toEqual({ status: 'page_only', reason: 'fuzzy' });
  });
  it('not found on this page → page only', () => {
    expect(anchorQuoteInTextLayer(makeLayer(LINES), 1, 'The method runs at 10 Hz on a single CPU core.')).toEqual({ status: 'page_only', reason: 'not_found' });
  });
});

describe('rangeMatchesQuote (re-check)', () => {
  it('rejects a Range whose text differs from the quote', () => {
    const layer = makeLayer(LINES);
    const dpt = textLayerText(layer);
    const s = TEXT.indexOf('The robust kernel down');
    const range = rangeFromOffsets(dpt, s, s + 'The robust kernel'.length)!;
    expect(rangeMatchesQuote(range, 'The robust kernel')).toBe(true);
    expect(rangeMatchesQuote(range, 'The robust kernels')).toBe(false);
    expect(rangeMatchesQuote(range, 'the robust kernel')).toBe(false);
  });
  it('a DOM that drifted from the server text fails the re-check even when offsets "match"', () => {
    // Server position computed on the original text; the DOM has one glyph changed at that place.
    const layer = makeLayer([['We estimate the robot pose.']]);
    const dpt = textLayerText(layer);
    (layer.querySelector('span')!.firstChild as Text).data = 'We estimate the robat pose.';
    const range = rangeFromOffsets(dpt, 0, 'We estimate the robot pose.'.length)!;
    expect(rangeMatchesQuote(range, 'We estimate the robot pose.')).toBe(false);
  });
});

describe('word boundaries in the DOM re-check (review M1)', () => {
  it('a line break is a word boundary: "now<br>here" never re-checks as "nowhere"', () => {
    const layer = makeLayer([['The robot is now'], ['here.']]);
    const dpt = textLayerText(layer);
    const range = rangeFromOffsets(dpt, 0, dpt.text.trimEnd().length)!;
    expect(range.toString()).toBe('The robot is nowhere.'); // what the old toString() shortcut compared
    expect(rangeMatchesQuote(range, 'The robot is nowhere.')).toBe(false);
    expect(rangeMatchesQuote(range, 'The robot is now here.')).toBe(true);
    expect(anchorQuoteInTextLayer(layer, 1, 'The robot is nowhere.').status).toBe('page_only');
  });
  it('"nowhere" in the PDF is not located for a quote "now here", and ﬁ is not located for f', () => {
    const layer = makeLayer([['The robot is nowhere.'], ['a ﬁne day']]);
    expect(anchorQuoteInTextLayer(layer, 1, 'The robot is now here.').status).toBe('page_only');
    expect(anchorQuoteInTextLayer(layer, 1, 'a f').status).toBe('page_only');
    expect(anchorQuoteInTextLayer(layer, 1, 'a fine day').status).toBe('located');
  });
});
