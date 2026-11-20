// The milestone the gate files (m1.gate, m2.gate, routes.gate) run at. Owner: supervisor.
import { GATED_MILESTONE } from '@study-paper/shared/contracts/routeManifest';

/**
 * GATED_MILESTONE, raised (never lowered) by SP_GATE_MILESTONE for a builder's preview: max(GATED_MILESTONE, env).
 * A lower value (1, 0) or an empty one is the constant — a stale shell variable can no longer skip the M2 gates and
 * still pass (X-I10-01); a value that is not a non-negative integer throws, so the gate file fails instead of skipping.
 */
export function gateMilestone(env: Record<string, string | undefined> = process.env): number {
  const v = env.SP_GATE_MILESTONE;
  if (v === undefined || v === '') return GATED_MILESTONE;
  if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`SP_GATE_MILESTONE must be a non-negative integer (got ${JSON.stringify(v)})`);
  return Math.max(GATED_MILESTONE, Number(v));
}
