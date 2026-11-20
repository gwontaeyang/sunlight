import { describe, expect, it } from 'vitest';
import { parseAbsUrl, parseArxivInput, versionedId } from '../../src/ingest/arxivId';

describe('parseArxivInput', () => {
  it.each([
    ['2209.15397', { id: '2209.15397' }],
    ['2209.15397v2', { id: '2209.15397', version: 2 }],
    ['  2107.06829v1 ', { id: '2107.06829', version: 1 }],
    ['0704.0001', { id: '0704.0001' }],
    ['1412.6980v9', { id: '1412.6980', version: 9 }],
    ['arXiv:2209.15397', { id: '2209.15397' }],
    ['ARXIV:2209.15397v2', { id: '2209.15397', version: 2 }],
    ['cs/0112017', { id: 'cs/0112017' }],
    ['cs/0112017v1', { id: 'cs/0112017', version: 1 }],
    ['hep-th/9901001v3', { id: 'hep-th/9901001', version: 3 }],
    ['math.GT/0309136', { id: 'math/0309136' }],
    ['https://arxiv.org/abs/2209.15397', { id: '2209.15397' }],
    ['https://arxiv.org/abs/2209.15397v2', { id: '2209.15397', version: 2 }],
    ['http://arxiv.org/pdf/2209.15397v2', { id: '2209.15397', version: 2 }],
    ['https://arxiv.org/pdf/2209.15397v2.pdf', { id: '2209.15397', version: 2 }],
    ['https://www.arxiv.org/html/2209.15397v2/', { id: '2209.15397', version: 2 }],
    ['https://export.arxiv.org/abs/2209.15397?context=cs', { id: '2209.15397' }],
    ['https://arxiv.org/abs/2209.15397v2#S3', { id: '2209.15397', version: 2 }],
    ['https://arxiv.org/abs/cs/0112017v1', { id: 'cs/0112017', version: 1 }],
    ['HTTPS://ARXIV.ORG/abs/2209.15397', { id: '2209.15397' }],
  ])('%s', (input, expected) => {
    expect(parseArxivInput(input)).toEqual(expected);
  });

  it.each([
    '',
    '   ',
    'hello',
    '2209.1539', // 4 digits after 2015
    '1412.69801', // 5 digits before 2015
    '0703.0001', // before the new scheme
    '2213.15397', // month 13
    '2209.15397v0',
    '2209.15397v',
    '2209.15397vv2',
    '2209.15397 v2',
    '2209.15397/../../etc',
    '../2209.15397',
    'cs/011201',
    'cs/0812017', // old-style id after 2007
    'CS/0112017',
    'https://example.com/abs/2209.15397',
    'https://arxiv.org.evil.com/abs/2209.15397',
    'https://arxiv.org/list/cs.RO/recent',
    'ftp://arxiv.org/abs/2209.15397',
    'javascript:alert(1)',
    'https://arxiv.org/abs/2209.15397%2F..%2F',
    'x'.repeat(400),
  ])('rejects %j', (input) => {
    expect(parseArxivInput(input)).toBeNull();
  });
});

describe('helpers', () => {
  it('versionedId only accepts canonical ids', () => {
    expect(versionedId('2209.15397', 2)).toBe('2209.15397v2');
    expect(versionedId('cs/0112017', 1)).toBe('cs/0112017v1');
    expect(() => versionedId('../x', 1)).toThrow();
    expect(() => versionedId('2209.15397', 0)).toThrow();
  });
  it('parseAbsUrl splits Atom entry ids', () => {
    expect(parseAbsUrl('http://arxiv.org/abs/2209.15397v2')).toEqual({ id: '2209.15397', version: 2 });
    expect(parseAbsUrl('http://arxiv.org/abs/cs/0112017v1')).toEqual({ id: 'cs/0112017', version: 1 });
    expect(parseAbsUrl('http://arxiv.org/api/errors#incorrect_id_format_for_1')).toBeNull();
  });
});
