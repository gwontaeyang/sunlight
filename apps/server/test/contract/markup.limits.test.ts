// Contract: per-content citation limits of SP-Markup (PLAN_M2 9절 41 — supervisor decision S-2). Owner: supervisor.
// The behaviour (first 40 <eq> resolved, the rest text + issue) is parseAnswer's (owner B) and is tested there.
import { describe, expect, it } from 'vitest';
import { MAX_EQ_REFS_PER_MESSAGE, MAX_QUOTES_PER_MESSAGE } from '@study-paper/shared/markup/grammar';

describe('markup/grammar citation limits (S-2)', () => {
  it('MAX_EQ_REFS_PER_MESSAGE = 40, next to MAX_QUOTES_PER_MESSAGE = 40', () => {
    expect(MAX_EQ_REFS_PER_MESSAGE).toBe(40);
    expect(MAX_QUOTES_PER_MESSAGE).toBe(40);
  });
});
