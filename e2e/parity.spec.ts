// Text parity gate (PLAN 8.1): the browser text layer of the seeded synthetic PDF equals the server's stored
// page_texts after N1 normalisation (and, with pdf.js 6.5.438 + disableNormalization, also raw). Real-paper
// parity was measured in the S0 spike; ingest-based real-paper parity belongs to the C/A milestone tests.
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import { n1 } from '../packages/shared/src/anchor/normalize';
import { SEED_PAPER_ID, SEED_TITLE } from './helpers';

test('synthetic PDF: text layer DOM text == server page_texts (N1 and raw)', async ({ page }) => {
  test.skip(test.info().project.name !== 'prod', 'one browser run is enough');
  const db = new Database(join(process.env.SP_E2E_ROOT!, 'prod', 'db', 'study_paper.sqlite'), { readonly: true, fileMustExist: true });
  const server = db.prepare('SELECT page, text, pdfjsVersion FROM page_texts WHERE paperId = ? ORDER BY page').all(SEED_PAPER_ID) as { page: number; text: string; pdfjsVersion: string }[];
  db.close();
  expect(server.length).toBe(2);

  await page.goto(`/paper/${SEED_PAPER_ID}`);
  await expect(page.getByTestId('paper-title')).toHaveText(SEED_TITLE);
  await page.waitForFunction(() => !!(window as unknown as { __spViewer?: { getViewer(): unknown } }).__spViewer?.getViewer() && document.querySelectorAll('.textLayer span').length > 0);
  for (const { page: n, text, pdfjsVersion } of server) {
    await page.evaluate((n) => (window as unknown as { __spViewer: { getViewer(): { scrollPageIntoView(o: object): void } } }).__spViewer.getViewer().scrollPageIntoView({ pageNumber: n }), n);
    await page.waitForFunction((n) => (document.querySelector(`.page[data-page-number="${n}"] .textLayer`)?.querySelectorAll('span').length ?? 0) > 0, n);
    const dom = await page.evaluate((n) => {
      let s = '';
      const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) s += (node as Text).data;
        else if ((node as Element).tagName === 'BR') s += '\n';
        else if (!(node as Element).classList?.contains('PdfHighlighter__highlight-layer')) node.childNodes.forEach(walk);
      };
      document.querySelector(`.page[data-page-number="${n}"] .textLayer`)!.childNodes.forEach(walk);
      return s;
    }, n);
    expect(pdfjsVersion).toBe('6.5.438');
    expect(n1(dom)).toBe(n1(text));
    expect(dom).toBe(text);
  }
});
