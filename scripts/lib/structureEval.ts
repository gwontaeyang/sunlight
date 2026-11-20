// Structure evaluation against the adjudicated gold (PLAN_M2 3.2 / 7절 4, BRIEF_INTEGRATION I5). Owner: supervisor.
// Pure functions only: no file, no parser, no matcher. The script (scripts/eval-structure.ts) runs A's code and hands
// the positions here.
//
// Unit = (page, start) of a gold item. Per gold item (sections keyed by htmlId, numbered equations by number + htmlId):
//   matched     the parser item has a position and it is EQUAL to the gold (page, start)
//   null        the parser item has no position
//   mismatched  the parser item has a position and it differs in page or start (by 1 is a mismatch, never a match)
//   missing     no parser item has that key
//   extra       a parser item with a position whose key is not in the gold (or whose gold item was already taken)
// Order: the confirmed positions, in the parser's document order, must strictly increase (page, start); every adjacent
// pair that does not is one violation.
// Numbers: the integer equation numbers in DOM order must be exactly 1…max (no gap, no repeat, no reorder).
// Outputs carry ids, numbers and positions only — never paper text.

export interface GoldItem {
  htmlId: string;
  /** Equations: the tag number. Sections: ignored for the key. */
  number: string | null;
  page: number;
  start: number;
}
export interface Position {
  page: number;
  start: number;
}
export interface ParserItem {
  htmlId: string | null;
  number: string | null;
  pos: Position | null;
}
export type ItemKind = 'sections' | 'equations';

export interface ItemOutcome {
  htmlId: string | null;
  number: string | null;
  gold: Position | null;
  actual: Position | null;
}
export interface KindComparison {
  gold: number;
  matched: number;
  null: number;
  mismatched: number;
  extra: number;
  missing: number;
  orderViolations: number;
  /** Items behind the non-matched counts (positions and ids only). */
  nullItems: ItemOutcome[];
  mismatchedItems: ItemOutcome[];
  extraItems: ItemOutcome[];
  missingItems: ItemOutcome[];
  orderViolationPairs: { before: ItemOutcome; after: ItemOutcome }[];
}

const keyOf = (kind: ItemKind, htmlId: string | null, number: string | null): string | null => {
  if (htmlId === null) return null;
  return kind === 'sections' ? htmlId : `${number ?? ''}\u0000${htmlId}`;
};
const before = (a: Position, b: Position) => a.page < b.page || (a.page === b.page && a.start < b.start);

/** Compares one kind of one paper with its gold (see the header). `items` are in document order. */
export function compareWithGold(kind: ItemKind, gold: readonly GoldItem[], items: readonly ParserItem[]): KindComparison {
  const byKey = new Map<string, GoldItem>();
  for (const g of gold) {
    const k = keyOf(kind, g.htmlId, g.number)!;
    if (byKey.has(k)) throw new Error(`gold has the ${kind} key ${g.htmlId}${kind === 'equations' ? ` (${g.number})` : ''} twice`);
    byKey.set(k, g);
  }
  const taken = new Set<string>();
  const out: KindComparison = { gold: gold.length, matched: 0, null: 0, mismatched: 0, extra: 0, missing: 0, orderViolations: 0, nullItems: [], mismatchedItems: [], extraItems: [], missingItems: [], orderViolationPairs: [] };
  for (const it of items) {
    const k = keyOf(kind, it.htmlId, it.number);
    const g = k === null || taken.has(k) ? undefined : byKey.get(k);
    const outcome: ItemOutcome = { htmlId: it.htmlId, number: it.number, gold: g ? { page: g.page, start: g.start } : null, actual: it.pos ? { page: it.pos.page, start: it.pos.start } : null };
    if (!g) {
      // Not a gold item: only a confirmed position counts (an unconfirmed extra row shows no jump and claims nothing).
      if (it.pos) {
        out.extra++;
        out.extraItems.push(outcome);
      }
      continue;
    }
    taken.add(k!);
    if (!it.pos) {
      out.null++;
      out.nullItems.push(outcome);
    } else if (it.pos.page === g.page && it.pos.start === g.start) out.matched++;
    else {
      out.mismatched++;
      out.mismatchedItems.push(outcome);
    }
  }
  for (const g of gold) {
    if (taken.has(keyOf(kind, g.htmlId, g.number)!)) continue;
    out.missing++;
    out.missingItems.push({ htmlId: g.htmlId, number: g.number, gold: { page: g.page, start: g.start }, actual: null });
  }
  let prev: ParserItem | null = null;
  for (const it of items) {
    if (!it.pos) continue;
    if (prev && !before(prev.pos!, it.pos)) {
      out.orderViolations++;
      out.orderViolationPairs.push({ before: { htmlId: prev.htmlId, number: prev.number, gold: null, actual: prev.pos }, after: { htmlId: it.htmlId, number: it.number, gold: null, actual: it.pos } });
    }
    prev = it;
  }
  return out;
}

export interface NumberSequenceCheck {
  /** The integer numbers in DOM order. */
  numbers: number[];
  max: number | null;
  /** 1…max values that do not occur. */
  gaps: number[];
  /** Values that occur more than once. */
  repeated: number[];
  /** DOM order is not 1, 2, …, max. */
  outOfOrder: boolean;
  /** Numbers that are not plain integers (e.g. "A.1") — not part of the sequence. */
  nonInteger: string[];
  ok: boolean;
}

/** The equation numbers in DOM order must be exactly 1…max (unnumbered rows — null — are skipped). */
export function checkNumberSequence(numbers: readonly (string | null)[]): NumberSequenceCheck {
  const ints: number[] = [];
  const nonInteger: string[] = [];
  for (const n of numbers) {
    if (n === null) continue;
    if (/^[1-9]\d{0,5}$/.test(n)) ints.push(Number(n));
    else nonInteger.push(n);
  }
  const max = ints.length ? Math.max(...ints) : null;
  const seen = new Map<number, number>();
  for (const n of ints) seen.set(n, (seen.get(n) ?? 0) + 1);
  const gaps: number[] = [];
  if (max !== null) for (let k = 1; k <= max; k++) if (!seen.has(k)) gaps.push(k);
  const repeated = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
  const outOfOrder = ints.some((n, i) => n !== i + 1);
  return { numbers: ints, max, gaps, repeated, outOfOrder, nonInteger, ok: gaps.length === 0 && repeated.length === 0 && !outOfOrder };
}

/** The phrase the brief fixes for the summary line (agreement with the gold only — no wider accuracy claim). */
export function summaryLine(t: { gold: number; matched: number; null: number; mismatched: number }): string {
  return `판정 gold ${t.gold}개 중 일치 ${t.matched} · null ${t.null} · 불일치 ${t.mismatched} (범위: IEEE 2단 논문 2편)`;
}
