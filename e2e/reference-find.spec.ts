import { expect, test } from '@playwright/test';
import type { ReferenceCandidate } from '../packages/shared/src/contracts/api';
import { openPanelTab } from './actions';
import { mockRoute, mockViolations, routePath, SEED_LINKS_PAPER_ID, SEED_M2_PAPER_ID } from './helpers';

test('an unindexed reference can be searched, reviewed and imported without automatically opening external links', async ({ page }) => {
  await page.goto(`/paper/${SEED_M2_PAPER_ID}`);
  await openPanelTab(page, 'references', { timeoutMs: 10_000 });
  const row = page.locator('[data-testid="pn-ref-item"][data-ordinal="1"]');
  // Production and dev both have SP_NETWORK=off. Exercise the real refusal before installing provider fixtures.
  const blocked = page.waitForResponse(r => new URL(r.url()).pathname === routePath('references.find') && r.request().method() === 'POST');
  await row.getByTestId('pn-ref-find').click();
  const first = await blocked;
  expect(first.status()).toBe(503);
  expect(first.request().postDataJSON().title).toBe('A synthetic reference');
  await expect(row.getByTestId('pn-ref-query')).toHaveValue('A synthetic reference');
  await expect(row.getByTestId('pn-ref-find-error')).toContainText('외부 네트워크가 꺼져');

  const arxiv: ReferenceCandidate = {
    source: 'arxiv', title: 'Synthetic grid tracking', authors: ['Author A'], year: 2024, arxivId: '2401.00077v1', doi: null,
    absUrl: 'https://arxiv.org/abs/2401.00077v1', pdfUrl: 'https://arxiv.org/pdf/2401.00077v1', score: 1, inLibraryPaperId: null,
  };
  const doi: ReferenceCandidate = {
    source: 'crossref', title: 'Synthetic tracking in grids', authors: [], year: 2022, arxivId: null, doi: '10.5555/closed',
    absUrl: 'https://doi.org/10.5555/closed', pdfUrl: null, score: 0.7, inLibraryPaperId: null,
  };
  const open: ReferenceCandidate = {
    ...doi, title: 'Open tracking study', doi: '10.5555/open', absUrl: 'https://doi.org/10.5555/open',
    pdfUrl: 'https://journal.example/open.pdf', inLibraryPaperId: SEED_LINKS_PAPER_ID,
  };
  const queries: unknown[] = [];
  const imports: unknown[] = [];
  await mockRoute(page, 'references.find', req => {
    queries.push(req.body);
    return { kind: 'json', body: { candidates: [arxiv, doi, open], unavailable: [] } };
  });
  await mockRoute(page, 'papers.import', req => {
    imports.push(req.body);
    return { kind: 'json', body: { paperId: SEED_LINKS_PAPER_ID, jobId: 'fixture-job', existing: false } };
  });
  await row.getByTestId('pn-ref-query').fill('Synthetic grid tracking');
  await row.getByTestId('pn-ref-search').click();
  const candidates = row.getByTestId('pn-ref-candidate');
  await expect(candidates).toHaveCount(3);
  expect(queries).toEqual([expect.objectContaining({ title: 'Synthetic grid tracking' })]);

  const journal = candidates.filter({ hasText: 'Synthetic tracking in grids' });
  await expect(journal.getByTestId('pn-ref-candidate-source')).toHaveText('Crossref');
  await expect(journal.getByTestId('pn-ref-import')).toHaveCount(0);
  await expect(journal.getByTestId('sp-ext-link')).toHaveCount(1);
  await expect(journal.getByTestId('sp-ext-link')).toContainText('https://doi.org/10.5555/closed');
  await expect(journal).toContainText('공개 PDF 링크를 확인하지 못했습니다');
  const known = candidates.filter({ hasText: 'Open tracking study' });
  await expect(known.getByTestId('pn-ref-in-library')).toBeVisible();
  await expect(known.getByTestId('pn-ref-import')).toHaveCount(0);
  const pdf = known.getByTestId('sp-ext-link').filter({ hasText: 'PDF 받기' });
  await pdf.getByTestId('sp-ext-open').click();
  await expect(pdf.getByTestId('sp-ext-confirm')).toContainText('journal.example');
  await pdf.getByRole('button', { name: '취소' }).click();

  const preprint = candidates.filter({ hasText: 'Synthetic grid tracking' });
  await preprint.getByTestId('pn-ref-import').click();
  await expect(preprint.getByTestId('pn-ref-import-confirm')).toContainText(arxiv.arxivId!);
  expect(imports).toHaveLength(0);
  await preprint.getByTestId('pn-ref-import-go').click();
  await expect(preprint.getByTestId('pn-ref-import-result')).toContainText('가져오기를 시작했습니다');
  expect(imports).toEqual([{ input: arxiv.arxivId, clientRequestId: expect.any(String) }]);
  expect(mockViolations(page)).toEqual([]);
});
