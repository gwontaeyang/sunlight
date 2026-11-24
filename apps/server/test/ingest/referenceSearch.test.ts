import { afterEach, describe, expect, it, vi } from 'vitest';
import { findReferences } from '../../src/ingest/referenceSearch';
import { checkUrl, USER_AGENT, type FetchImpl } from '../../src/ingest/safeFetch';
import { HostQueue } from '../../src/ingest/hostQueue';
import { NetworkBudgetError, NetworkDisabledError } from '../../src/security/network';

const title = 'Planar alignment with short scans';
const id = '2402.13456v2';
const atom = (entries: string) => new Response(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${entries}</feed>`);
const entry = (name: string, abs = 'http://arxiv.org/abs/' + id) =>
  `<entry><id>${abs}</id><title>${name}</title><published>2024-02-10</published><author><name>Research group</name></author><arxiv:doi>10.0000/demo</arxiv:doi></entry>`;
const cross = (items: unknown[]) => Response.json({status: 'ok', message: {items}});
const work = (name: string, doi: string) => ({
  DOI: doi, title: [name], author: [{ name: 'Robotics group' }], issued: {'date-parts': [[2025]]},
});
const license = {URL: 'https://creativecommons.org/licenses/by/4.0/', 'content-version': 'vor', start: {timestamp: 0}};
const link = {URL: 'https://journals.example.org/papers/planar.pdf', 'content-version': 'vor', 'content-type': 'application/pdf', 'intended-application': 'unspecified'};
const one = async (fetchImpl: FetchImpl, q = { title }) => findReferences(q, {queue: new HostQueue(), fetchImpl});
const route = (arxiv: () => Response, crossref: () => Response): FetchImpl => async url =>
  new URL(url).hostname === 'export.arxiv.org' ? arxiv() : crossref();
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('two fixed reference metadata sources', () => {
  it('queries only the two metadata endpoints with a generic client name and one request per provider', async () => {
    const calls: URL[] = [];
    const query = { title: 'Planar "alignment" & scans', authors: ['Research group'], year: 2024 };
    const result = await findReferences(query, { queue: new HostQueue(), fetchImpl: async (raw, init) => {
      const url = new URL(raw);
      calls.push(url);
      expect(new Headers(init.headers).get('user-agent')).toBe(USER_AGENT);
      expect(init.redirect).toBe('manual');
      if (url.hostname === 'export.arxiv.org') {
        expect(url.pathname).toBe('/api/query');
        expect(url.searchParams.get('search_query')).toBe('ti:"planar alignment scans"');
        expect(url.searchParams.get('max_results')).toBe('5');
        return atom(entry(title));
      }
      expect(url.origin + url.pathname).toBe('https://api.crossref.org/works');
      expect(url.searchParams.get('query.bibliographic')).toBe('Planar "alignment" & scans Research group 2024');
      expect(url.searchParams.get('rows')).toBe('5');
      return cross([]);
    }});
    expect(calls).toHaveLength(2);
    expect(result.unavailable).toEqual([]);
    expect(result.candidates[0]).toMatchObject({source: 'arxiv', arxivId: id, doi: '10.0000/demo', title, authors: ['Research group'],
      year: 2024, absUrl: 'https://arxiv.org/abs/' + id, pdfUrl: 'https://arxiv.org/pdf/' + id});
  });

  it('ranks both sources together by title, honors the top five, and skips duplicate or unrelated provider records', async () => {
    const rest = [title, 'Planar alignment with scans', 'Short scans', 'Unrelated topic', 'Short scans'];
    const arxiv = [entry('Planar'), entry('Alignment with short scans', 'http://arxiv.org/abs/2402.13457v1')].join('');
    const {candidates} = await one(route(() => atom(arxiv), () => cross(rest.map((n, i) => work(n, '10.1234/test-' + Math.min(i, 2))))));
    expect(candidates).toHaveLength(5);
    expect(candidates[0]).toMatchObject({title, score: 1, absUrl: 'https://doi.org/10.1234/test-0', authors: ['Robotics group'], year: 2025, pdfUrl: null});
    expect(new Set(candidates.map(c => c.arxivId ?? c.doi)).size).toBe(5);
    expect(candidates.map(c => c.score)).toEqual(candidates.map(c => c.score).sort((a, b) => b-a));
    expect(candidates.some(c => c.title === 'Unrelated topic')).toBe(false);
    const capped = await one(route(() => atom(arxiv), () => cross(rest.map((_, i) => work(title, '10.1234/t' + i)))));
    expect(capped.candidates).toHaveLength(5);
  });

  it('permits a publicly licensed PDF for its matching version and a safe https destination', async () => {
    const {candidates} = await one(route(() => atom(''), () => cross([{...work(title, '10.1234/paper'), link: [link], license: [license]}])));
    expect(candidates[0]?.pdfUrl).toBe(link.URL);
  });
  it.each([
    [[], [link]], [[{...license, URL: 'https://journals.example.org/terms'}], [link]],
    [[{...license, 'content-version': 'am'}], [link]], [[{...license, start: {timestamp: Date.UTC(2100,1)}}], [link]],
    [[license], [{...link, 'intended-application': 'text-mining'}]],
    [[license], [{...link, URL: 'http://journals.example.org/sample.pdf'}]], [[license], [{...link, URL: 'https://127.0.0.1/mock.pdf'}]],
    [[license], [{...link, URL: 'https://reader:demo@journals.example.org/a.pdf'}]],
  ])('falls back to the DOI for an unconfirmed PDF (%#)', async (licenses, links) => {
    const {candidates} = await one(route(() => atom(''), () => cross([{...work(title, '10.1234/paper'), link: links, license: licenses}])));
    expect(candidates[0]).toMatchObject({doi: '10.1234/paper', pdfUrl: null});
  });

  it('an arXiv error feed or bad envelope is not a successful empty search; working provider results survive', async () => {
    const arxivError = () => atom(entry('Error', 'http://arxiv.org/api/errors#query'));
    const partial = await one(route(arxivError, () => cross([work(title, '10.1234/find')])));
    expect(partial.unavailable).toEqual(['arxiv']);
    expect(partial.candidates).toHaveLength(1);
    await expect(one(route(arxivError, () => Response.json({message: {items: []}})))).rejects.toMatchObject({kind:'unavailable'});
    expect(await one(route(() => atom(''), () => cross([])))).toEqual({candidates:[],unavailable:[]});
  });

  it('search never follows a redirect or downloads candidate links; paper fetch keeps its original host list', async () => {
    const dispatch = vi.fn<FetchImpl>(async url => new URL(url).host === 'export.arxiv.org'
      ? new Response('', {status:302, headers:{ location:'https://arxiv.org/pdf/' + id }})
      : cross([{...work(title, '10.1234/safe'), link:[link], license:[license]}]));
    const result = await one(dispatch);
    expect(result.unavailable).toEqual(['arxiv']);
    expect(result.candidates[0]?.pdfUrl).toBe(link.URL);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(() => checkUrl('https://api.crossref.org/works')).toThrow();
    expect(() => checkUrl('https://api.crossref.org/elsewhere', 'crossref')).toThrow();
  });

  it('caps streamed bytes even without content-length; rejects oversized responses before parsing', async () => {
    const oversize = () => new Response('a'.repeat(256 * 1024 + 1));
    const result = await one(route(oversize, () => cross([])));
    expect(result.unavailable).toEqual(['arxiv']);
  });

  it('offline and exhausted request budgets refuse before any injected transport call', async () => {
    const dispatch = vi.fn<FetchImpl>();
    vi.stubEnv('SP_NETWORK', 'off');
    await expect(one(dispatch)).rejects.toBeInstanceOf(NetworkDisabledError);
    vi.stubEnv('SP_NETWORK', 'on');
    vi.stubEnv('SP_NETWORK_MAX_REQUESTS', '0');
    await expect(one(dispatch)).rejects.toBeInstanceOf(NetworkBudgetError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses backed-up host queues without starting either request, shares Retry-After with imports', async () => {
    const queue = new HostQueue();
    const dispatch = vi.fn<FetchImpl>(async url => new URL(url).hostname === 'export.arxiv.org'
      ? new Response(null, { status:429, headers:{'retry-after':'90'} }) : cross([]));
    const now = Date.now();
    const partial = await findReferences({title},{queue,fetchImpl:dispatch});
    expect(partial.unavailable).toEqual(['arxiv']);
    expect(queue.cooldownOf('arxiv.org')?.until).toBeGreaterThanOrEqual(now + 90_000);
    const controllers = Array.from({length:4}, () => new AbortController());
    const pending = controllers.map(c => queue.run('arxiv.org', async () => { throw new Error('should not start'); }, c.signal).catch(() => {}));
    await expect(findReferences({title}, {queue,fetchImpl:dispatch})).rejects.toMatchObject({kind:'busy'});
    expect(dispatch).toHaveBeenCalledTimes(2);
    for (const c of controllers) c.abort();
    await Promise.all(pending);
  });
  it('a genuine header timeout fails as timeout, with exactly one dispatch per provider', async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn<FetchImpl>(async (_url, init) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {once:true})));
    const checked = expect(one(dispatch)).rejects.toMatchObject({kind: 'timeout'});
    await vi.advanceTimersByTimeAsync(8000);
    await checked;
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
