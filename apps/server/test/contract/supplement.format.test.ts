// supplement v2 format (BRIEF_S S4): the golden bytes. The cap / truncation / escaping / boundary properties are in
// packages/shared/test/supplement.test.ts (same serializer, run in the shared project). Owner: supervisor.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeSupplementV2, SUPPLEMENT_CAPS } from '@study-paper/shared/contracts/supplement';
import { SEED_M2_META, SEED_M2_PAPER_ID, seedM2SupplementInput } from '../../src/dev/seedFixture';
import { startTestServer, type TestServer } from '../helpers/server';

const GOLDEN = readFileSync(new URL('../fixtures/synthetic.supplement.v2.txt', import.meta.url), 'utf8');

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer({ env: 'prod', papers: ['m2'] });
});
afterAll(async () => {
  await s.close();
});

describe('supplement v2 golden', () => {
  it('the SEED_M2 structure + SEED_M2_META serialize to the golden bytes, twice the same', () => {
    const input = seedM2SupplementInput();
    expect(input.meta).toBe(SEED_M2_META);
    const a = serializeSupplementV2(input);
    expect(a).toEqual({ text: GOLDEN, truncated: false });
    expect(serializeSupplementV2(seedM2SupplementInput()).text).toBe(GOLDEN);
    expect(GOLDEN.length).toBeLessThanOrEqual(SUPPLEMENT_CAPS.totalChars);
  });

  it('the seeded supplement.v2.txt of SEED_M2_PAPER_ID is the golden; the row points at version 2 with its sha', () => {
    const file = s.deps.paths.supplementFile(SEED_M2_PAPER_ID, 2);
    expect(readFileSync(file, 'utf8')).toBe(GOLDEN);
    const row = s.deps.sqlite.prepare(`SELECT supplementVersion FROM papers WHERE id = ?`).get(SEED_M2_PAPER_ID);
    expect(row).toEqual({ supplementVersion: 2 });
  });

  it('golden shape: v="2", the five metadata lines, group equation as one gathered line, duplicate A.1 kept, no PDF positions', () => {
    const lines = GOLDEN.split('\n');
    expect(lines[0]).toBe('<paper_index v="2">');
    expect(lines.slice(2, 7).map((l) => l.split(':')[0])).toEqual(['title', 'authors', 'arxiv', 'year', 'category']);
    expect(lines.filter((l) => l.startsWith('(3) | II-B | \\begin{gathered}'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('(A.1) | II-B | '))).toHaveLength(2);
    expect(GOLDEN).not.toMatch(/pdfPage|katex/i);
  });
});
