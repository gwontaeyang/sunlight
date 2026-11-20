// Position stack of the reader ("뒤로", Alt+←) — PLAN_M2 3.8, BRIEF_C C3. Owner C.
// Every jump (internal link, citation chip, outline, equation, page) pushes where the reader was before it moved.
// At most POSITION_STACK_MAX entries (the oldest is dropped); a push equal to the top entry is skipped. The owner
// reports canGoBack to readerStore.setCanGoBack through `onChange` (never setState directly).

/** A reading position: 1-based page, `top` = fraction of that page's height at the top of the viewport, zoom. */
export interface StackPosition {
  page: number;
  top: number;
  zoom: number;
}

export const POSITION_STACK_MAX = 50;
/** Positions closer than this (page fraction / zoom) are the same position. */
const SAME_EPS = 1e-3;

export function samePosition(a: StackPosition, b: StackPosition): boolean {
  return a.page === b.page && Math.abs(a.top - b.top) < SAME_EPS && Math.abs(a.zoom - b.zoom) < SAME_EPS;
}

const valid = (p: StackPosition) => Number.isInteger(p.page) && p.page >= 1 && Number.isFinite(p.top) && Number.isFinite(p.zoom) && p.zoom > 0;

export class PositionStack {
  private items: StackPosition[] = [];

  constructor(
    private readonly onChange: (canGoBack: boolean) => void = () => {},
    private readonly max = POSITION_STACK_MAX,
  ) {}

  get size(): number {
    return this.items.length;
  }

  get canGoBack(): boolean {
    return this.items.length > 0;
  }

  /** Pushes a copy of `p` unless it equals the top entry; drops the oldest beyond `max`. */
  push(p: StackPosition): void {
    if (!valid(p)) return;
    const top = this.items.at(-1);
    if (top && samePosition(top, p)) return;
    const was = this.canGoBack;
    this.items.push({ page: p.page, top: Math.min(1, Math.max(0, p.top)), zoom: p.zoom });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    if (!was) this.onChange(true);
  }

  /** The latest position (removed), or null when the stack is empty. */
  pop(): StackPosition | null {
    const p = this.items.pop() ?? null;
    if (p && this.items.length === 0) this.onChange(false);
    return p;
  }

  clear(): void {
    const was = this.canGoBack;
    this.items = [];
    if (was) this.onChange(false);
  }

  /** Copy of the entries, oldest first (tests). */
  entries(): StackPosition[] {
    return this.items.map((p) => ({ ...p }));
  }
}
