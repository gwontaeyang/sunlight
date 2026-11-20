// Ingest job error codes (job.error.code, jobs.error prefix). Owner A.
import { JobErrorCode } from '@study-paper/shared/contracts/domain';
import { FetchError } from './safeFetch';

/** = contracts JobErrorCode (job.error.code): one list for the server and the web. */
export type IngestErrorCode = JobErrorCode;

export class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

/** Maps any thrown value to an IngestError (FetchError codes map 1:1 where they exist). */
export function toIngestError(e: unknown): IngestError {
  if (e instanceof IngestError) return e;
  if (e instanceof FetchError) {
    const map: Record<FetchError['code'], IngestErrorCode> = {
      blocked_url: 'blocked_url',
      redirect: 'blocked_url',
      http_status: 'network',
      not_found: 'not_found',
      too_large: 'too_large',
      timeout: 'timeout',
      cancelled: 'cancelled',
      network: 'network',
    };
    return new IngestError(map[e.code], e.message);
  }
  return new IngestError('internal', e instanceof Error ? e.message : String(e));
}

/** jobs.error text: `<code>: <message>` (the code is recovered for job.error on replay). */
export function formatJobError(e: IngestError): string {
  return `${e.code}: ${e.message}`.slice(0, 2000);
}

export function parseJobError(s: string | null): { code: IngestErrorCode; message: string } {
  if (!s) return { code: 'internal', message: 'unknown error' };
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(s);
  const code = m ? JobErrorCode.safeParse(m[1]) : null;
  return m && code?.success ? { code: code.data, message: m[2]! } : { code: 'internal', message: s };
}
