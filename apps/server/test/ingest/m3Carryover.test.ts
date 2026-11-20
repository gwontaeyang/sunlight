import { expect, it } from 'vitest';
import { parse, versionVerdict } from '../../src/ingest/latexml';
import { SYN_M2_HTML } from './m2helpers';

it('separates version digits from MathML superscripts and still reads genuine version mentions', () => {
  const id = '2301.12345';
  const mention = 'arXiv:' + id + 'v1';
  const math = '<math><msup><mrow></mrow><mn>1</mn></msup></math>';
  const parsed = (tail: string) => parse(SYN_M2_HTML.replace('</body>', '<p>' + mention + math + tail + '</p></body>')).textMentions;
  const own = parsed('2');
  expect(own.mentions).toContainEqual({ id, version: 1 });
  expect(versionVerdict(own, id, 1)).toEqual({ kind: 'same' });
  expect(versionVerdict(parsed('<math><mtext>arXiv:' + id + 'v2</mtext></math>'), id, 1)).toEqual({ kind: 'other', version: 2 });
});
