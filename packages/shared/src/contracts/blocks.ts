// SP-Blocks validation errors (PLAN_M2 3.4, D20). Owner: supervisor. B's validateBlocks reports BlockError values;
// the repair request and run.retrying carry ONLY formatBlockError lines. A message is a fixed template + an item
// number + a whitelisted enum value — there is no slot where model-written text (attribute values, tag names, body
// text, the term name) could enter (a model string never reaches a trust="app" block or an SSE error text).
import { ASSUMPTION_CATEGORIES, ASSUMPTION_STATED, NOTATION_KEYS } from './domain';

export const BLOCK_ERROR_CODES = [
  'no_items',
  'item_count',
  'missing_key',
  'duplicate_key',
  'unknown_key',
  'bad_label',
  'bad_category',
  'missing_stated',
  'unexpected_stated',
  'term_count',
  'term_name_mismatch',
  'unclosed_tag',
  'too_many_items',
  'body_too_long',
] as const;
export type BlockErrorCode = (typeof BLOCK_ERROR_CODES)[number];

export interface BlockError {
  code: BlockErrorCode;
  /** 1-based item number in the output (a number — never model text). */
  item?: number;
  /** A whitelisted enum value only (e.g. the missing NOTATION_KEYS entry). Anything else makes formatBlockError throw. */
  key?: string;
}

/** Values that may appear as `key` in a message: the fixed card enums. */
export const BLOCK_ERROR_KEY_WHITELIST: ReadonlySet<string> = new Set<string>([...NOTATION_KEYS, ...ASSUMPTION_CATEGORIES, ...ASSUMPTION_STATED]);
export const BLOCK_ERROR_MAX_CHARS = 120;
/** Largest item number accepted (SP_BLOCKS_LIMITS.maxItems is 60; a few more for "too many" reports). */
const MAX_ITEM_NUMBER = 1000;

const TEMPLATES: Record<BlockErrorCode, (key: string | undefined) => string> = {
  no_items: () => 'no <item> elements were found at the start of a line',
  item_count: () => 'the number of items does not match what the task requires',
  missing_key: (k) => (k ? `no item has key="${k}"` : 'an item for a required key is missing'),
  duplicate_key: (k) => (k ? `key="${k}" is used by more than one item` : 'a key is used by more than one item'),
  unknown_key: () => 'key is not one of the allowed keys',
  bad_label: () => 'label must be P, N or G',
  bad_category: () => 'category is not one of the allowed categories',
  missing_stated: () => 'a limitation item needs stated="author" or stated="inferred"',
  unexpected_stated: () => 'stated is allowed only on limitation items',
  term_count: () => 'exactly one <term> element is required',
  term_name_mismatch: () => 'term name does not match the requested term',
  unclosed_tag: () => 'a tag is not closed',
  too_many_items: () => 'there are more items than the limit allows',
  body_too_long: () => 'the item body is longer than the limit allows',
};

/** One fixed-template line (≤ 120 chars). Throws on a key outside the whitelist or a bad item number. */
export function formatBlockError(e: BlockError): string {
  if (!(BLOCK_ERROR_CODES as readonly string[]).includes(e.code)) throw new Error('unknown block error code');
  if (e.key !== undefined && !BLOCK_ERROR_KEY_WHITELIST.has(e.key)) throw new Error('block error key is not a whitelisted enum value');
  if (e.item !== undefined && (!Number.isInteger(e.item) || e.item < 1 || e.item > MAX_ITEM_NUMBER)) throw new Error('block error item must be an integer 1..1000');
  const text = (e.item !== undefined ? `item ${e.item}: ` : '') + TEMPLATES[e.code](e.key);
  if (text.length > BLOCK_ERROR_MAX_CHARS) throw new Error('block error message over the length limit');
  return text;
}
