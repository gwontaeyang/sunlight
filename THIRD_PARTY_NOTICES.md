# Third-party notices

Code copied into this repository (installed npm dependencies are covered by `npm run check:licenses`).

## react-pdf-highlighter-extended 8.1.0 (MIT)

- Location: `apps/web/src/vendor/pdf-highlighter/` (license copy: `LICENSE` in that directory)
- Upstream: https://github.com/DanielArnould/react-pdf-highlighter — npm `react-pdf-highlighter-extended@8.1.0`,
  `gitHead` d80742ca479d3e872c518df45cdebede5ae49cf2
- Copied from: the published npm tarball (`dist/esm/**`, compiled JavaScript + `.d.ts` + CSS), npm integrity
  `sha512-zhwjL9qkpzIjTmyc8cDCB2qT9xfT4GI/zacwHG+V+AEWIxe3H+qbOy7LCNPkzImPInXqqcgQtToJ76+/R9bGHg==`.
  Source maps were dropped. The tarball has no TypeScript sources.
- Copyright: (c) 2023 Daniel Arnould, (c) 2017 Artem Tyurin (MIT, both in `LICENSE`)
- File check: every copied file is compiled from the upstream `src/` of that commit (source maps point to
  `../../../src/**`); no file header names another project or license. `pdf_viewer.css` overrides are upstream's own.
- Modifications (each modified `.js` file starts with a `Modified for study_paper` comment):
  - `components/PdfLoader.js`: removed the unpkg.com default worker URL (`workerSrc` is required, CSP same-origin);
    cleanup no longer calls `PDFDocumentProxy.destroy()` (removed in pdf.js 6); results of a superseded load
    (React StrictMode double effect) are ignored instead of showing "Loading aborted"; the loaded document is
    React state instead of a ref (children rendered even without progress events).
    M1: the load state (document, error, progress) is tagged with the `document` it belongs to and reset when a
    new load starts, so a new document never shows the previous error/progress/document (failure → success,
    fast document changes, StrictMode); `onError` is read from a ref.
  - `components/PdfHighlighter.js`: `pdfjs-dist/web/pdf_viewer.mjs` is imported statically after `pdfjs-dist`
    instead of an un-awaited dynamic import. M1: the scale handler reads the latest `pdfScaleValue` from a ref
    (listeners registered in an earlier render reverted a zoom change on the next resize), and a changed
    `pdfScaleValue` is applied to the viewer immediately. M2: `utils.resetAreaSelection()` clears a finished area
    selection without a ghost highlight.
  - `components/MouseSelection.js` (M2): the page offset comes from `getBoundingClientRect` of the page and the
    container instead of `offsetTop`/`offsetLeft`; no screenshot of the page canvas is taken (`image` is
    undefined). M2 fix round 1: the drag state lives in refs, the listeners are registered once, and the end point
    is taken from the `mouseup` event.
  - `components/TipContainer.js` (M2 fix round 3, C-I10-04; fix round 4, C-FX-01): a tip that would pass the
    bottom of the visible viewer is moved up to end there (not above the visible top) only while the selection (or
    the highlight) is on screen, i.e. its box overlaps the visible part of the viewer, so the menu after a Ctrl+drag
    over almost the whole visible height stays on screen and the tip of a selection scrolled out of view stays next
    to it.
  - `contexts/PdfHighlighterContext.d.ts` (M2): the type of `resetAreaSelection`. This file has no header comment;
    the added member carries a `study_paper (M2)` comment.
  - `lib/coordinates.js`: `convertToViewportRectangle` (removed in pdf.js 6) replaced by two
    `convertToViewportPoint` calls. M1: `viewportPositionToScaled` / `scaledPositionToViewport` convert every
    rect with the viewport of its own page (`rect.pageNumber`) instead of the bounding rect's page.
  - `lib/group-highlights-by-page.js` (M1): page numbers are de-duplicated; upstream listed the bounding rect's
    page plus every rect's page, so a highlight was rendered (rects + 1) times on its page.
- Not copied: quote anchoring (`packages/shared/src/anchor/`, `apps/web/src/viewer/domAnchor.ts`) follows the
  hypothesis-style method as described in PLAN 5.3 (quote + prefix/suffix, position as a hint, DOM range
  re-check); it was written from that description, no `hypothesis/client` code was read or copied. Fuzzy search
  (`editDistanceEnds` in `packages/shared/src/anchor/matchQuote.ts`) implements the published bit-parallel
  edit-distance algorithm (Myers 1999, block form of Hyyrö 2003) with its own work budget. The
  `approx-string-match` package (MIT, (c) 2020 Robert Knight) was the dependency used for this until M1.1 and
  implements the same algorithm with the same two-pass approach (match ends, then a reversed anchored pass for
  the start); it is no longer installed. It is named here as the reference for that approach.

## htmlparser2 10.1.0 (MIT)

- Location: `apps/server/src/ingest/markupScan.ts` (the linear pre-scan that runs before linkedom's `parseHTML`;
  the file is ours, the parts below are copied or ported into it). The file header names the source and license.
- Upstream: https://github.com/fb55/htmlparser2 — npm `htmlparser2@10.1.0` (installed as a dependency of
  linkedom 0.18.15, used unmodified there); copied from that version's `src/Parser.ts` and `src/Tokenizer.ts`.
- Copyright: 2010, 2011, Chris Winberry (MIT, license text below; also `node_modules/htmlparser2/LICENSE`)
- Copied tables (`src/Parser.ts`, as the file header says): `openImpliesClose` with its sets `formTags`, `pTag`,
  `tableSectionTags`, `ddtTags`, `rtpTags` (here `OPEN_IMPLIES_CLOSE` and the same set names), the void element
  set `voidElements` (here `VOID`), and the foreign-context sets `foreignContextElements` and
  `htmlIntegrationElements` (here `FOREIGN` and `INTEGRATION`).
- Ported rules (rewritten in our scanner, same behaviour): the Tokenizer's raw-text ("special") tag choice
  (`stateBeforeTagName` → `stateBeforeSpecialS`/`T` → `startSpecial` → `stateSpecialStartSequence`, here
  `rawTextSequence`) and its end-sequence match `stateInSpecialTag` (here `skipRawText`); the Parser's
  open-element stack rules the depth estimate replays (end tag pops to the nearest open element of that name,
  `</p>` and `</br>` create an element, implied closes) and its `foreignContext` pushes and pops. The text and
  comment section rules behind the non-element node bound follow the Tokenizer's `sectionStart` handling.
- Not copied: the scanner's limits, the depth/node estimate and the counting are ours; no other htmlparser2 code.
- License text (`node_modules/htmlparser2/LICENSE`, verbatim):

```text
Copyright 2010, 2011, Chris Winberry <chris@winberry.net>. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
 
The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
```

## Installed dependencies outside the license allow-list

`npm run check:licenses` allows MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0,
BlueOak-1.0.0 and Python-2.0 for installed packages. The packages below are approved exceptions, pinned by
name, version and license in `scripts/license-exceptions.json` (a version change fails the check again).
They are installed and used unmodified; none of their code is copied into this repository. The rule for
copied code stays MIT/BSD/Apache only.

| Package | License | Why it is installed | Obligation on this repository |
|---|---|---|---|
| lightningcss 1.33.0 (+ `lightningcss-linux-x64-gnu`, `lightningcss-linux-x64-musl`) | MPL-2.0 | build-time CSS tool required by vite 8.3.8 and @tailwindcss/node | none: MPL-2.0 is file-level copyleft and applies to changes of its own files; we do not modify or redistribute it |
| pako 1.0.11 | MIT AND Zlib | dependency of pdf-lib (dev only: synthetic fixture PDF) | none beyond keeping its notices in `node_modules` |

## Anthropic TypeScript SDK

The server uses the unmodified npm package [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript), version 1.10.0, under Apache-2.0. Its license is included in the package. The browser bundle does not include the SDK.
