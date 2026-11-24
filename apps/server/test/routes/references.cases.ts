import { expect } from 'vitest';
import { ReferenceSearchResponse } from '@study-paper/shared/contracts/api';
import { configureIngest } from '../../src/ingest/pipeline';
import { atomFeed } from '../ingest/helpers';
import type { RouteCase } from '../helpers/routeCases';

const title = 'Synthetic finite lattice reconstruction';
export const cases: RouteCase[] = [
  {
    route: 'references.find', name: 'returns ranked metadata and keeps DOI-only works link-only', expect: 'ok',
    body: { title, year: 2022 },
    setup: ({ server }) => {
      configureIngest(server.deps, {
        fetchImpl: async (input) => {
          const url = new URL(input);
          if (url.origin === 'https://export.arxiv.org' && url.pathname === '/api/query') {
            return new Response(atomFeed([{ id: '2301.88888', version: 1, title }]), {
              headers: { 'Content-Type': 'application/atom+xml' },
            });
          }
          if (url.origin === 'https://api.crossref.org' && url.pathname === '/works') {
            const work = { title: [title + ' methods'], DOI: '10.1234/synthetic-lattice', published: { 'date-parts': [[2022]] } };
            return Response.json({ status: 'ok', 'message-type': 'work-list', message: { items: [work] } });
          }
          throw new Error('Unexpected reference search endpoint in contract fixture');
        },
      });
    },
    check: (r) => {
      const { candidates, unavailable } = ReferenceSearchResponse.parse(r.json);
      expect(unavailable).toEqual([]);
      expect(candidates).toHaveLength(2);
      expect(candidates[0]).toMatchObject({ source: 'arxiv', title });
      expect(candidates[0]!.pdfUrl).toMatch(/^https:\/\/arxiv\.org\/pdf\//);
      expect(candidates[1]).toMatchObject({ source: 'crossref', doi: '10.1234/synthetic-lattice', pdfUrl: null });
    },
  },
  {
    route: 'references.find', name: 'rejects a whitespace-only title', expect: 'validation',
    body: { title: '   ' },
  },
];
