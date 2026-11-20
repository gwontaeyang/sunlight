// SP-Blocks parser (PLAN 7.3, PLAN_M2 3.4). Owner B. One pass over the lines, no regex with nested quantifiers.
//
// Grammar:
// - Control characters are removed first (the same set as parseAnswer: chip markers cannot be forged).
// - Input over SP_BLOCKS_INPUT_MAX_CHARS is not parsed at all (ISSUE_INPUT_TOO_LONG — the run ends parse_failed).
// - Outside code fences (``` / ~~~, the opening run length or longer closes), a whitelisted tag of the task
//   (SP_BLOCKS_WHITELIST[task]) is recognised only at the START of a line: `<tag a="v" b="v">`. Attribute names must be
//   in the tag's whitelist, each at most once; values cannot contain `"`, `<`, `>` (or a newline). Any other shape —
//   an unknown or repeated attribute, a tag in the middle of a line, a tag inside a fence — is plain text.
// - The element ends at the first `</tag>` (outside fences) after its opening tag; the text after `</tag>` on that
//   line is outside text. The body is the text in between (one leading / trailing newline trimmed).
// - Same-kind nesting is not allowed: an opening tag of the same kind at the start of a line while that element is
//   open makes the WHOLE output invalid (ISSUE_NESTED → validateBlocks reports `unclosed_tag`; the run repairs once,
//   then parse_failed). The inner line is never read as text of the outer item (its <q> would become the outer
//   item's citation — S review R2-01).
// - An element still open at the end of the input is text (+ issue).
// - Bodies are SP-Markup and are parsed later with parseAnswer (labels: 'strip' for card items).
import type { BlockNode, ParsedBlocks } from '../contracts/domain';
import { FENCE_RE, SP_BLOCKS_WHITELIST } from './grammar';

/** Inputs longer than this are not parsed (PLAN_M2 3.4: 200,000 chars → parse_failed). */
export const SP_BLOCKS_INPUT_MAX_CHARS = 200_000;
/** Fixed issue texts validateBlocks reads (parser-made constants — never model text). */
export const ISSUE_NESTED = 'same-kind element nested inside an open element';
export const ISSUE_INPUT_TOO_LONG = `input longer than ${SP_BLOCKS_INPUT_MAX_CHARS} chars: not parsed`;
export const ISSUE_UNCLOSED = 'an element is not closed: kept as text';
export const ISSUE_CONTROL = 'control characters removed';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Work counter for the linearity test: one step per line and per character the tokenizer looks at. */
export interface BlocksWork {
  steps: number;
}

interface OpenTag {
  tag: string;
  attrs: Record<string, string>;
  /** Index in the line right after `>`. */
  end: number;
}

const isNameChar = (c: string) => (c >= 'a' && c <= 'z') || c === '_';
const isSpace = (c: string) => c === ' ' || c === '\t';

/** Reads `<tag a="v" …>` at the start of `line` (whitelist-checked) or returns null. Linear in the tag's length. */
function readOpenTag(line: string, allowed: Record<string, readonly string[]>, work: BlocksWork): OpenTag | null {
  if (line[0] !== '<') return null;
  let i = 1;
  const nameStart = i;
  while (i < line.length && isNameChar(line[i]!)) i++;
  work.steps += i;
  const tag = line.slice(nameStart, i);
  const names = Object.prototype.hasOwnProperty.call(allowed, tag) ? allowed[tag]! : null;
  if (!names) return null;
  const attrs: Record<string, string> = {};
  for (;;) {
    const before = i;
    while (i < line.length && isSpace(line[i]!)) i++;
    work.steps += i - before + 1;
    if (line[i] === '>') return { tag, attrs, end: i + 1 };
    if (i === before) return null; // an attribute must follow whitespace
    const a = i;
    while (i < line.length && isNameChar(line[i]!)) i++;
    const name = line.slice(a, i);
    if (!name || line[i] !== '=' || line[i + 1] !== '"') return null;
    if (!names.includes(name) || Object.prototype.hasOwnProperty.call(attrs, name)) return null;
    i += 2;
    const v = i;
    while (i < line.length && line[i] !== '"' && line[i] !== '<' && line[i] !== '>') i++;
    work.steps += i - a;
    if (line[i] !== '"') return null;
    attrs[name] = line.slice(v, i);
    i++;
  }
}

/** The opening run of a code fence at the start of `line` (CommonMark: ``` or ~~~, up to 3 spaces of indent). */
function fenceOpen(line: string): { ch: string; len: number } | null {
  const m = FENCE_RE.exec(line);
  return m ? { ch: m[1]![0]!, len: m[1]!.length } : null;
}
/** A closing fence for `f`: the same character, at least as long, nothing else on the line. */
function closesFence(line: string, f: { ch: string; len: number }): boolean {
  const t = line.trim();
  if (t.length < f.len || line.length - line.trimStart().length > 3) return false;
  for (const c of t) if (c !== f.ch) return false;
  return true;
}

/**
 * Parses an SP-Blocks output of `task`. Never throws; the result is checked by validateBlocks (blockSchemas.ts).
 * `work` (tests) counts the steps.
 */
export function parseBlocks(raw: string, task: string, work: BlocksWork = { steps: 0 }): ParsedBlocks {
  const issues: string[] = [];
  if (raw.length > SP_BLOCKS_INPUT_MAX_CHARS) return { items: [], outsideText: '', issues: [ISSUE_INPUT_TOO_LONG] };
  const cleaned = raw.replace(CONTROL_CHARS_RE, '');
  if (cleaned.length !== raw.length) issues.push(ISSUE_CONTROL);
  const allowed = SP_BLOCKS_WHITELIST[task] ?? {};
  const lines = cleaned.replace(/\r\n?/g, '\n').split('\n');
  const items: BlockNode[] = [];
  const outside: string[] = [];
  // body[0] is the rest of the opening line
  let open: { tag: string; attrs: Record<string, string>; head: string; body: string[] } | null = null;
  let fence: { ch: string; len: number } | null = null;
  let nested = false;

  for (const line of lines) {
    work.steps += 1 + line.length;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      (open ? open.body : outside).push(line);
      continue;
    }
    if (!open) {
      const t = readOpenTag(line, allowed, work);
      if (!t) {
        fence = fenceOpen(line);
        outside.push(line);
        continue;
      }
      const rest = line.slice(t.end);
      const close = rest.indexOf(`</${t.tag}>`);
      if (close >= 0) {
        items.push({ tag: t.tag, attrs: t.attrs, body: rest.slice(0, close).trim(), children: [] });
        const after = rest.slice(close + t.tag.length + 3);
        if (after.trim()) outside.push(after);
        continue;
      }
      open = { tag: t.tag, attrs: t.attrs, head: line, body: [rest] };
      continue;
    }
    // inside an open element
    const again = readOpenTag(line, allowed, work);
    if (again && again.tag === open.tag) {
      nested = true; // the whole output is invalid; the inner line is dropped, never read as the outer item's text
      continue;
    }
    const close = line.indexOf(`</${open.tag}>`);
    if (close >= 0) {
      open.body.push(line.slice(0, close));
      items.push({ tag: open.tag, attrs: open.attrs, body: open.body.join('\n').trim(), children: [] });
      const after = line.slice(close + open.tag.length + 3);
      if (after.trim()) outside.push(after);
      open = null;
      continue;
    }
    fence = fenceOpen(line);
    open.body.push(line);
  }
  if (open) {
    // never closed: its opening line and body are text
    issues.push(ISSUE_UNCLOSED);
    // A loop, not `push(...body)`: spreading ~125k+ lines as arguments overflows the call stack (review B-R2-03).
    outside.push(open.head);
    for (let k = 1; k < open.body.length; k++) outside.push(open.body[k]!);
  }
  if (nested) issues.push(ISSUE_NESTED);
  return { items, outsideText: outside.join('\n').trim(), issues };
}
