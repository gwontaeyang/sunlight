// SP-Markup v1 grammar constants (PLAN 5.1, 5.2) and SP-Blocks whitelist skeleton (PLAN 7.3).
// v0 by S0; owner B. The ParsedAnswer / ParsedBlocks types live in contracts/domain.ts (supervisor).

export const SP_MARKUP_VERSION = 1;

/** `<q>…</q>`: one contiguous span copied verbatim from the paper. No nesting. */
export const QUOTE_OPEN = '<q>';
export const QUOTE_CLOSE = '</q>';
export const MAX_QUOTE_CHARS = 600;
export const MAX_QUOTES_PER_MESSAGE = 40;
/**
 * Equation references resolved per content (supervisor decision S-2, PLAN_M2 9절 41): the first 40 `<eq n="…"/>` of
 * one content (a message, or one card item's body) become citations; every further `<eq>` stays as plain text and
 * adds an issue — the same treatment as `<q>` past MAX_QUOTES_PER_MESSAGE. Counted separately from quotes.
 */
export const MAX_EQ_REFS_PER_MESSAGE = 40;

/** `<eq n="4"/>`: numbered equation reference, self-closing only. */
export const EQ_NUMBER_SOURCE = '[A-Za-z]?\\.?\\d+[a-z]?';
export const EQ_NUMBER_RE = new RegExp(`^${EQ_NUMBER_SOURCE}$`);
export const EQ_TAG_SOURCE = `<eq n="(${EQ_NUMBER_SOURCE})"\\s*/>`;

/** Grounding labels, recognised only as the LAST token of a block (paragraph, list item, table row's last cell). */
export const LABELS = ['P', 'N', 'G'] as const;
export const LABEL_TOKEN_SOURCE = '\\[\\[(P|N|G)\\]\\]';

/** Links the parser generates; model-written links with this href prefix are neutralised to text. */
export const RESERVED_HREF_PREFIX = '#sp-';
export const chipHref = {
  cite: (ordinal: number) => `#sp-cite-${ordinal}`,
  eq: (ordinal: number) => `#sp-eq-${ordinal}`,
  label: (label: (typeof LABELS)[number]) => `#sp-label-${label.toLowerCase()}`,
};
export const chipText = {
  cite: (ordinal: number) => `❝${ordinal}`,
  eq: (eqNumber: string) => `식 (${eqNumber})`,
  label: (label: (typeof LABELS)[number]) => label,
};

/** Optional trailing glossary block of explain_selection (max 3 terms). */
export const GLOSSARY_SOURCE = '<glossary>([\\s\\S]*?)</glossary>';
export const GLOSSARY_TERM_SOURCE = '<term name="([^"<>]{1,200})">([\\s\\S]*?)</term>';
export const MAX_GLOSSARY_TERMS = 3;

/** Tags the streaming renderer must not show half-written (PLAN 5.2). */
export const KNOWN_TAG_PREFIXES = ['<q>', '</q>', '<eq n="', '<glossary>', '</glossary>', '<term name="', '</term>'] as const;
export const STREAM_HOLDBACK_MAX_CHARS = 700;

/** Code fences: tags and labels inside them (and inside inline code) are plain text. */
export const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// SP-Blocks (PLAN 7.3): per-task tag/attribute whitelist. Tags are recognised only at the start of a line,
// attribute values cannot contain `"`, `<` or `>`, same-kind nesting is not allowed, fences are text.
export const SP_BLOCKS_LIMITS = { maxItems: 60, maxItemBodyChars: 8000 } as const;
export const SP_BLOCKS_WHITELIST: Record<string, Record<string, readonly string[]>> = {
  notation_card: { item: ['key', 'label'] },
  assumptions_card: { item: ['category', 'label', 'stated'] },
  glossary_define: { term: ['name'] },
  cards_from_highlights: { card: ['type', 'highlight'], front: [], back: [], q: [] },
  explain_back_grade: { verdict: ['score'], point: ['status'], claim: [], fix: [], q: [], followup: [] },
};
export { NOTATION_KEYS } from '../contracts/domain';
