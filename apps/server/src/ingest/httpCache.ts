// API response cache in the `http_cache` table (PLAN 4.1: arXiv 7 days; S2/HF 30 days from M2). Owner A.
// Only successful (2xx) text bodies are stored. PDFs and HTML are files, never cached here.
import type { Sqlite } from '../db/client';

export const ARXIV_API_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedResponse {
  url: string;
  status: number;
  body: string;
  fetchedAt: number;
  expiresAt: number;
}

export class HttpCache {
  constructor(
    private readonly sqlite: Sqlite,
    private readonly now: () => number = Date.now,
  ) {}

  /** Fresh entry or null (expired entries are deleted). */
  get(key: string): CachedResponse | null {
    const row = this.sqlite.prepare(`SELECT url, status, body, fetchedAt, expiresAt FROM http_cache WHERE key = ?`).get(key) as CachedResponse | undefined;
    if (!row) return null;
    if (row.expiresAt <= this.now()) {
      this.sqlite.prepare(`DELETE FROM http_cache WHERE key = ?`).run(key);
      return null;
    }
    return row;
  }

  put(key: string, url: string, status: number, body: string, ttlMs: number): void {
    const t = this.now();
    this.sqlite
      .prepare(`INSERT INTO http_cache (key, url, status, body, fetchedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET url=excluded.url, status=excluded.status, body=excluded.body, fetchedAt=excluded.fetchedAt, expiresAt=excluded.expiresAt`)
      .run(key, url, status, body, t, t + ttlMs);
  }

  delete(key: string): void {
    this.sqlite.prepare(`DELETE FROM http_cache WHERE key = ?`).run(key);
  }
}
