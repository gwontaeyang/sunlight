import type { Sqlite } from '../db/client';
import { readSettings } from './settings';
import { charge, PRICE_VERSION, worstCharge, type Counts } from './prices';
export const utcMonth = (when = Date.now()) => new Date(when).toISOString().slice(0, 7);
export function monthUsage(sqlite: Sqlite, month = utcMonth()) {
  return sqlite
    .prepare(
      `SELECT coalesce(sum(spent),0) AS spentMicroUsd, coalesce(sum(held),0) AS heldMicroUsd,
    count(CASE WHEN kind='message' AND status NOT IN ('released','reserved') THEN 1 END) AS apiCalls,
    count(CASE WHEN kind='check' AND status NOT IN ('released','reserved') THEN 1 END) AS checks FROM api_charges WHERE month=?`,
    )
    .get(month) as { spentMicroUsd: number; heldMicroUsd: number; apiCalls: number; checks: number };
}
export function reserve(sqlite: Sqlite, id: string, model: string, generation: string, kind: 'message' | 'check', now = Date.now()) {
  const held = kind === 'message' ? worstCharge(model) : 0;
  const month = utcMonth(now);
  sqlite
    .transaction(() => {
      const cap = readSettings(sqlite)['llm.monthlyLimitMicroUsd'];
      const usage = monthUsage(sqlite, month);
      if (kind === 'message' && (cap === null || usage.heldMicroUsd + usage.spentMicroUsd + held > cap))
        throw new Error('budget_exhausted');
      sqlite
        .prepare(
          "INSERT INTO api_charges(callId,month,model,generation,priceVersion,kind,held,spent,status) VALUES(?,?,?,?,?,?,?,0,'reserved')",
        )
        .run(id, month, model, generation, PRICE_VERSION, kind, held);
    })
    .immediate();
}
export function markSent(sqlite: Sqlite, id: string) {
  if (sqlite.prepare("UPDATE api_charges SET status='sent' WHERE callId=? AND status='reserved'").run(id).changes !== 1)
    throw new Error('reservation unavailable');
}
export function settle(sqlite: Sqlite, id: string, model: string, usage: Counts | null, final: boolean) {
  let spent = 0;
  try {
    spent = usage ? charge(model, usage) : 0;
  } catch (error) {
    if (final) throw error;
    // An invalid partial report cannot release any part of the hold.
    usage = null;
  }
  sqlite
    .prepare(
      `UPDATE api_charges SET spent=?, held=CASE WHEN status='reserved' OR ? THEN 0 ELSE max(0,held-?) END,
    status=CASE WHEN status='reserved' THEN 'released' WHEN ? THEN 'settled' ELSE 'partial' END,
    usageJson=? WHERE callId=? AND status IN ('reserved','sent')`,
    )
    .run(spent, +final, spent, +final, usage ? JSON.stringify(usage) : null, id);
}

export function recoverReservations(sqlite: Sqlite) {
  // The dispatch callback commits 'sent' before any request can leave. Only 'reserved' is provably unsent.
  sqlite
    .transaction(() => {
      sqlite.prepare("UPDATE api_charges SET held=0,status='released' WHERE status='reserved'").run();
      sqlite.prepare("UPDATE api_charges SET status='partial' WHERE status='sent'").run();
    })
    .immediate();
}
