// Persistent arXiv cooldown (PLAN_M2 D28, carry-over "arXiv cooldown 메모리 전용"). Owner A.
//
// settings row `ingest.cooldown.<group>` (group 'arxiv' = arxiv.org + export.arxiv.org) = {until, cause, setAt}
// with the server-given time AS IS — never shortened, capped or replaced by a default (M1 F.2). A value that is not
// finite or beyond the Date range (8.64e15 ms) is stored as {until: 8.64e15, indefinite: true, cause, setAt} and
// restored as Infinity: blocked until the user starts the server once with SP_ARXIV_COOLDOWN_RESET=1.
//
// Restore rules (HostQueue construction):
//   no row                              → no cooldown
//   until ≤ now                         → row deleted, no cooldown
//   until > now (any length)            → restored as is (> 7 days: the job error tells how to reset it)
//   indefinite flag / non-finite / > 8.64e15 (e.g. {"until":1e400}) → restored as indefinite (never "repaired")
//   unreadable (broken JSON, until not a number) → row deleted, warning logged, and a conservative
//                                          now + 120 s cooldown in memory (the server's instruction is unknown)
// Reset: resetStoredCooldown() deletes the row and logs the deleted until (IngestService does it when
// config.arxivCooldownReset is true). Passing the time and this reset are the only ways out.
import type { Sqlite } from '../db/client';
import type { Cooldown, CooldownStore } from './hostQueue';

/** Largest epoch ms a Date can hold. */
export const MAX_DATE_MS = 8.64e15;
/** Cooldown used when the stored row cannot be read (one conservative minimum wait instead of an unknown value). */
export const UNREADABLE_COOLDOWN_MS = 120_000;
/** Waits longer than this are suspicious (clock change, wrong answer): the job error explains how to reset them. */
export const SUSPICIOUS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export const cooldownKey = (group: string) => `ingest.cooldown.${group}`;

export interface StoredCooldown {
  until: number;
  cause: string;
  setAt: number;
  indefinite?: true;
}

type Log = (msg: string) => void;

const isIndefinite = (until: number) => !Number.isFinite(until) || until > MAX_DATE_MS;

export class SettingsCooldownStore implements CooldownStore {
  constructor(
    private readonly sqlite: Sqlite,
    private readonly log: Log = (m) => console.warn(m),
  ) {}

  private read(group: string): string | null {
    const row = this.sqlite.prepare(`SELECT valueJson FROM settings WHERE key = ?`).get(cooldownKey(group)) as { valueJson: string } | undefined;
    return row ? row.valueJson : null;
  }

  private remove(group: string): void {
    this.sqlite.prepare(`DELETE FROM settings WHERE key = ?`).run(cooldownKey(group));
  }

  restore(group: string, now: number): Cooldown | null {
    let raw: string | null;
    try {
      raw = this.read(group);
    } catch (e) {
      this.log(`[ingest] cooldown ${group}: cannot read the stored cooldown (${(e as Error).message}); starting with a ${UNREADABLE_COOLDOWN_MS / 1000} s cooldown`);
      return { until: now + UNREADABLE_COOLDOWN_MS, cause: 'stored cooldown unreadable' };
    }
    if (raw === null) return null;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      v = undefined;
    }
    const o = v !== null && typeof v === 'object' ? (v as Partial<StoredCooldown>) : null;
    if (!o || typeof o.until !== 'number' || Number.isNaN(o.until)) {
      this.remove(group);
      this.log(`[ingest] cooldown ${group}: the stored value is unreadable (${raw.slice(0, 200)}); row deleted, starting with a ${UNREADABLE_COOLDOWN_MS / 1000} s cooldown`);
      return { until: now + UNREADABLE_COOLDOWN_MS, cause: 'stored cooldown unreadable' };
    }
    const cause = typeof o.cause === 'string' && o.cause.length > 0 ? o.cause.slice(0, 200) : 'cooldown';
    if (o.indefinite === true || isIndefinite(o.until)) return { until: Number.POSITIVE_INFINITY, cause };
    if (o.until <= now) {
      this.remove(group);
      return null;
    }
    return { until: o.until, cause };
  }

  expire(group: string, now: number): void {
    try {
      const raw = this.read(group);
      if (raw === null) return;
      const v = JSON.parse(raw) as Partial<StoredCooldown>;
      if (typeof v.until === 'number' && v.indefinite !== true && !isIndefinite(v.until) && v.until <= now) this.remove(group);
    } catch {
      // an unreadable row is handled by the next restore
    }
  }

  save(group: string, cd: Cooldown, now: number): void {
    const value: StoredCooldown = isIndefinite(cd.until) ? { until: MAX_DATE_MS, indefinite: true, cause: cd.cause, setAt: now } : { until: cd.until, cause: cd.cause, setAt: now };
    try {
      this.sqlite.prepare(`INSERT INTO settings (key, valueJson) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET valueJson = excluded.valueJson`).run(cooldownKey(group), JSON.stringify(value));
    } catch (e) {
      this.log(`[ingest] cooldown ${group}: could not save the cooldown until ${String(cd.until)} (${(e as Error).message}); it holds in memory only`);
    }
  }
}

/** SP_ARXIV_COOLDOWN_RESET=1: deletes the stored cooldown of `group` and logs what was deleted. Returns the raw row. */
export function resetStoredCooldown(sqlite: Sqlite, group: string, log: Log = (m) => console.warn(m)): string | null {
  const row = sqlite.prepare(`SELECT valueJson FROM settings WHERE key = ?`).get(cooldownKey(group)) as { valueJson: string } | undefined;
  if (!row) return null;
  sqlite.prepare(`DELETE FROM settings WHERE key = ?`).run(cooldownKey(group));
  log(`[ingest] SP_ARXIV_COOLDOWN_RESET=1: deleted the stored ${group} cooldown ${row.valueJson.slice(0, 200)}`);
  return row.valueJson;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Local "YYYY-MM-DD HH:mm" of an epoch ms (finite, within the Date range). */
export function formatResumeAt(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const COOLDOWN_RESET_HINT = '잘못된 값이면 서버를 SP_ARXIV_COOLDOWN_RESET=1로 한 번 시작하세요';

/**
 * The Korean job error for a wait the job will not sit through. The REAL remaining time: < 60 min → "약 N분 뒤",
 * otherwise the resume time; > 7 days adds the reset hint; indefinite (non-finite / beyond the Date range) names no
 * date at all (never "Invalid Date").
 */
export function cooldownMessage(waitMs: number, cause: string, now: number): string {
  if (!Number.isFinite(waitMs) || isIndefinite(now + waitMs)) return `arXiv가 기한 없는 대기를 요청했습니다 (${cause}) — ${COOLDOWN_RESET_HINT}`;
  const wait = Math.max(0, waitMs);
  const head = wait < 60 * 60_000 ? `arXiv가 약 ${Math.max(1, Math.ceil(wait / 60_000))}분 뒤 다시 요청하라고 응답했습니다` : `arXiv가 ${formatResumeAt(now + wait)} 이후에 다시 요청하라고 응답했습니다`;
  const hint = wait > SUSPICIOUS_COOLDOWN_MS ? ` (${COOLDOWN_RESET_HINT})` : '';
  return `${head} (${cause}) — 그 뒤 다시 시도하세요${hint}`;
}
