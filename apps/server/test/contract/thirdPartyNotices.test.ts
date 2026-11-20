// THIRD_PARTY_NOTICES.md keeps the list of modified vendored files complete (review C3-R1-03): every file under
// apps/web/src/vendor/pdf-highlighter/ that carries a `Modified for study_paper` header must be named in the
// react-pdf-highlighter-extended "Modifications" list. check-licenses only sees npm packages, so without this a
// vendored change merged without its notice line would pass every gate. Owner: supervisor.
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/proc';
import { sourceFiles } from '../helpers/sourceScan';

const VENDOR = join(REPO_ROOT, 'apps/web/src/vendor/pdf-highlighter');

function modificationsList(): string {
  const notices = readFileSync(join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const section = notices.slice(notices.indexOf('## react-pdf-highlighter-extended'));
  const start = section.indexOf('- Modifications');
  const end = section.indexOf('\n- Not copied', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return section.slice(start, end);
}

describe('THIRD_PARTY_NOTICES: vendored modifications', () => {
  it('every vendored file with a "Modified for study_paper" header is named in the Modifications list', () => {
    const list = modificationsList();
    const modified = sourceFiles(VENDOR)
      .filter((f) => /^\/\/ Modified for study_paper/m.test(readFileSync(f, 'utf8').split('\n').slice(0, 12).join('\n')))
      .map((f) => relative(VENDOR, f).split(sep).join('/'));
    expect(modified.length).toBeGreaterThanOrEqual(5); // PdfLoader, PdfHighlighter, MouseSelection, coordinates, group-highlights-by-page
    expect(modified.filter((p) => !list.includes(`\`${p}\``))).toEqual([]);
  });

  it('the TipContainer.js line says the tip is moved up only while the selection is on screen (C-FX-01, C 수정 4)', () => {
    const list = modificationsList();
    const start = list.indexOf('`components/TipContainer.js`');
    expect(start).toBeGreaterThan(-1);
    const end = list.indexOf('\n  - ', start);
    const line = list.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ');
    expect(line).toMatch(/moved up[^.]*only while the selection[^.]*is on screen/);
  });
});
