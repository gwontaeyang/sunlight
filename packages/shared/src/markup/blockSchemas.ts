// SP-Blocks validation per task (PLAN 7.3, PLAN_M2 3.4). Owner B.
// validateBlocks reports BlockError values only (contracts/blocks.ts): a code, an item NUMBER and, for `key`, a value
// of the fixed card enums (NOTATION_KEYS — e.g. the missing key). Nothing the model wrote (attribute values, tag
// names, bodies, the term name) ever enters an error: the repair request puts formatBlockError(e) lines into a
// trust="app" block and run.retrying sends them over SSE (D20).
// The validated items carry only whitelisted enum values: `label` ∈ P|N|G, `key` ∈ NOTATION_KEYS, `category` ∈
// ASSUMPTION_CATEGORIES, `stated` ∈ author|inferred; `title` comes from the server tables (NOTATION_TITLES_KO,
// ASSUMPTION_CATEGORY_KO), never from model text. The body is the model's SP-Markup (rendered via parseAnswer).
import { z } from 'zod';
import type { BlockError } from '../contracts/blocks';
import {
  ASSUMPTION_CATEGORIES,
  ASSUMPTION_CATEGORY_KO,
  ASSUMPTION_STATED,
  GroundingLabel,
  NOTATION_KEYS,
  NOTATION_TITLES_KO,
  normalizeTerm,
  type AssumptionCategory,
  type NotationKey,
  type ParsedBlocks,
} from '../contracts/domain';
import { SP_BLOCKS_LIMITS } from './grammar';
import { ISSUE_INPUT_TOO_LONG, ISSUE_NESTED } from './parseBlocks';

/** At most this many assumption items (PLAN_M2 3.4: 1–40). */
export const ASSUMPTIONS_MAX_ITEMS = 40;
/** At most this many error lines go into a repair request / run.retrying (PLAN_M2 3.4). */
export const MAX_REPORTED_ERRORS = 10;

export type BlocksTask = 'notation_card' | 'assumptions_card' | 'glossary_define';
export const BLOCKS_TASKS: readonly BlocksTask[] = ['notation_card', 'assumptions_card', 'glossary_define'];

/** One validated element: only enum values and the server's title. */
export interface ValidatedItem {
  /** 1-based position in the output. */
  ordinal: number;
  key: NotationKey | null;
  category: AssumptionCategory | null;
  label: GroundingLabel | null;
  title: string | null;
  /** SP-Markup body as the model wrote it. */
  bodyMd: string;
  /** Whitelisted attribute names with enum values only. */
  attrs: Record<string, string>;
}

export type ValidateResult = { ok: true; items: ValidatedItem[] } | { ok: false; errors: BlockError[] };

export interface ValidateOptions {
  /** glossary_define: the term the user asked for (compared with normalizeTerm). */
  requestedTerm?: string;
}

const NotationKeyEnum = z.enum(NOTATION_KEYS);
const CategoryEnum = z.enum(ASSUMPTION_CATEGORIES);
const StatedEnum = z.enum(ASSUMPTION_STATED);

const enumOf = <T extends string>(schema: z.ZodType<T>, v: string | undefined): T | null => {
  if (v === undefined) return null;
  const r = schema.safeParse(v);
  return r.success ? r.data : null;
};

/** The structural checks every task shares (nesting, input size, item count, body length). */
function structural(parsed: ParsedBlocks, tag: string, errors: BlockError[]): ParsedBlocks['items'] | null {
  if (parsed.issues.includes(ISSUE_INPUT_TOO_LONG)) {
    // not parsed at all (the run ends parse_failed without a repair — llm/runManager.ts)
    errors.push({ code: 'body_too_long' });
    return null;
  }
  if (parsed.issues.includes(ISSUE_NESTED)) errors.push({ code: 'unclosed_tag' });
  const items = parsed.items.filter((i) => i.tag === tag);
  if (items.length > SP_BLOCKS_LIMITS.maxItems) errors.push({ code: 'too_many_items' });
  items.forEach((it, k) => {
    if (it.body.length > SP_BLOCKS_LIMITS.maxItemBodyChars && k < 1000) errors.push({ code: 'body_too_long', item: k + 1 });
  });
  return items;
}

/** Errors deduplicated (code + item + key), order kept. */
function unique(errors: BlockError[]): BlockError[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const k = `${e.code}|${e.item ?? ''}|${e.key ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function validateNotation(parsed: ParsedBlocks): ValidateResult {
  const errors: BlockError[] = [];
  const items = structural(parsed, 'item', errors);
  if (!items) return { ok: false, errors };
  if (items.length === 0) errors.push({ code: 'no_items' });
  else if (items.length !== NOTATION_KEYS.length) errors.push({ code: 'item_count' });
  const seen = new Map<NotationKey, number>();
  const out: ValidatedItem[] = [];
  items.slice(0, SP_BLOCKS_LIMITS.maxItems).forEach((it, k) => {
    const n = k + 1;
    const key = enumOf(NotationKeyEnum, it.attrs.key);
    const label = enumOf(GroundingLabel, it.attrs.label);
    if (key === null) errors.push({ code: 'unknown_key', item: n });
    else seen.set(key, (seen.get(key) ?? 0) + 1);
    if (label === null) errors.push({ code: 'bad_label', item: n });
    if (key !== null && label !== null) out.push({ ordinal: n, key, category: null, label, title: NOTATION_TITLES_KO[key], bodyMd: it.body, attrs: { key, label } });
  });
  for (const key of NOTATION_KEYS) {
    const c = seen.get(key) ?? 0;
    if (c > 1) errors.push({ code: 'duplicate_key', key });
  }
  for (const key of NOTATION_KEYS) if (!seen.has(key)) errors.push({ code: 'missing_key', key });
  return errors.length ? { ok: false, errors: unique(errors) } : { ok: true, items: out };
}

function validateAssumptions(parsed: ParsedBlocks): ValidateResult {
  const errors: BlockError[] = [];
  const items = structural(parsed, 'item', errors);
  if (!items) return { ok: false, errors };
  if (items.length === 0) errors.push({ code: 'no_items' });
  else if (items.length > ASSUMPTIONS_MAX_ITEMS) errors.push({ code: 'item_count' });
  const out: ValidatedItem[] = [];
  items.slice(0, SP_BLOCKS_LIMITS.maxItems).forEach((it, k) => {
    const n = k + 1;
    const category = enumOf(CategoryEnum, it.attrs.category);
    const label = enumOf(GroundingLabel, it.attrs.label);
    const statedRaw = it.attrs.stated;
    const stated = enumOf(StatedEnum, statedRaw);
    let ok = true;
    if (category === null) {
      errors.push({ code: 'bad_category', item: n });
      ok = false;
    }
    if (label === null) {
      errors.push({ code: 'bad_label', item: n });
      ok = false;
    }
    if (category === 'limitation' && stated === null) {
      errors.push({ code: 'missing_stated', item: n });
      ok = false;
    } else if (category !== null && category !== 'limitation' && statedRaw !== undefined) {
      errors.push({ code: 'unexpected_stated', item: n });
      ok = false;
    }
    if (ok && category !== null && label !== null) {
      out.push({ ordinal: n, key: null, category, label, title: ASSUMPTION_CATEGORY_KO[category], bodyMd: it.body, attrs: { category, label, ...(stated !== null ? { stated } : {}) } });
    }
  });
  return errors.length ? { ok: false, errors: unique(errors) } : { ok: true, items: out };
}

function validateGlossary(parsed: ParsedBlocks, opts: ValidateOptions): ValidateResult {
  const errors: BlockError[] = [];
  const items = structural(parsed, 'term', errors);
  if (!items) return { ok: false, errors };
  if (items.length !== 1) {
    errors.push({ code: 'term_count' });
    return { ok: false, errors: unique(errors) };
  }
  const it = items[0]!;
  const name = it.attrs.name;
  if (name === undefined || opts.requestedTerm === undefined || normalizeTerm(name) !== normalizeTerm(opts.requestedTerm)) errors.push({ code: 'term_name_mismatch' });
  if (errors.length) return { ok: false, errors: unique(errors) };
  // The term's display name is the REQUESTED term (equal under normalizeTerm) — the model's spelling is not kept.
  return { ok: true, items: [{ ordinal: 1, key: null, category: null, label: null, title: null, bodyMd: it.body, attrs: {} }] };
}

/** Validates a parseBlocks result for `task` (notation_card, assumptions_card, glossary_define). */
export function validateBlocks(task: BlocksTask, parsed: ParsedBlocks, opts: ValidateOptions = {}): ValidateResult {
  if (task === 'notation_card') return validateNotation(parsed);
  if (task === 'assumptions_card') return validateAssumptions(parsed);
  return validateGlossary(parsed, opts);
}

/** The errors a repair request and run.retrying carry: at most MAX_REPORTED_ERRORS. */
export function reportedErrors(errors: readonly BlockError[]): BlockError[] {
  return errors.slice(0, MAX_REPORTED_ERRORS);
}
