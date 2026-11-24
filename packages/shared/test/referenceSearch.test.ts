import { describe, expect, it } from 'vitest';
import { ReferenceCandidate, ReferenceSearchRequest, ReferenceSearchResponse } from '../src/contracts/api';

describe('reference search REST contract', () => {
  it('accepts a bounded title with optional bibliographic hints', () => {
    expect(ReferenceSearchRequest.parse({ title: '  A paper  ', authors: [' Builder '], year: 2020 }))
      .toEqual({ title: 'A paper', authors: ['Builder'], year: 2020 });
    expect(ReferenceSearchRequest.parse({ title: 'A paper' })).toEqual({ title: 'A paper' });
    for (const body of [
      { title: ' ' }, { title: 'a'.repeat(513) }, { title: 'A', authors: Array(13).fill('X') },
      { title: 'A', authors: ['x'.repeat(257)] }, { title: 'A', year: 20.5 },
      { title: 'A', url: 'https://example.org/search' },
    ]) expect(ReferenceSearchRequest.safeParse(body).success).toBe(false);
  });

  it('requires a provider identifier and bounds the candidate list, score and link schemes', () => {
    const doiOnly = {
      source: 'crossref', title: 'A paper', authors: [], year: null, arxivId: null, doi: '10.1234/sample',
      pdfUrl: null, absUrl: 'https://doi.org/10.1234/sample', score: 0.8, inLibraryPaperId: null,
    };
    expect(ReferenceSearchResponse.parse({ candidates: [doiOnly], unavailable: ['arxiv'] }).candidates).toEqual([doiOnly]);
    for (const override of [{ doi: null }, { source: 'arxiv' }, { score: 1.1 }, { pdfUrl: 'file:///document.pdf' }]) {
      expect(ReferenceCandidate.safeParse({ ...doiOnly, ...override }).success).toBe(false);
    }
    expect(ReferenceSearchResponse.safeParse({ candidates: Array(6).fill(doiOnly), unavailable: [] }).success).toBe(false);
  });
});
