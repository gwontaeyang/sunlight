// Re-opening an existing thread for a reader action (PLAN 부록 D, PLAN_M2 5 "답 없는 thread 재사용"; BRIEF_D D2): the
// web decides, the server always creates. Owner D.
// Only threads whose last message is complete are reused (a thread without an answer gets a new run):
// - explain: the newest explain thread with exactly the same quote (M1 rule)
// - translate: the newest translate thread with exactly the same quote
// - equation with an equationId: the newest equation thread of that equationId (from the equations tab or a chip
//   popover — the deep read is never restarted; "다시 생성" in that thread does that)
// - a capture (figure / equation with an image) and ask: always a new thread
import type { ThreadDto } from '@study-paper/shared/contracts/api';
import type { MessageStatus } from '@study-paper/shared/contracts/domain';
import type { ReaderAction } from '../state/readerStore';

type Reusable = Pick<ThreadDto, 'kind' | 'anchor' | 'updatedAt'> & { equationId?: string | null; lastMessageStatus?: MessageStatus | null };

function newest<T extends Reusable>(threads: readonly T[], match: (t: T) => boolean): T | null {
  let best: T | null = null;
  for (const t of threads) {
    if (t.lastMessageStatus !== 'complete' || !match(t)) continue;
    if (!best || t.updatedAt > best.updatedAt) best = t;
  }
  return best;
}

/** The thread to re-open for this action, or null (= start a new run). */
export function findReusableThread<T extends Reusable>(threads: readonly T[], action: Pick<ReaderAction, 'kind' | 'anchor'> & Partial<Pick<ReaderAction, 'equationId' | 'imagePng'>>): T | null {
  if (action.kind === 'explain' || action.kind === 'translate') {
    const exact = action.anchor?.quote?.exact;
    if (!exact) return null;
    return newest(threads, (t) => t.kind === action.kind && t.anchor?.quote?.exact === exact);
  }
  if (action.kind === 'equation' && action.equationId && action.imagePng === undefined) {
    return newest(threads, (t) => t.kind === 'equation' && t.equationId === action.equationId);
  }
  return null;
}
