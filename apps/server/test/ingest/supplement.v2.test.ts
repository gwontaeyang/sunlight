// Owner A. supplement v2 (PLAN_M2 3.1): the golden (A's parser + latexNormalize + SEED_M2_META = S's
// synthetic.supplement.v2.txt bytes), determinism, metadata passed uncut (the serializer caps it), and the papers the
// pipeline makes (an offline import and the upgrade of 2301.00002) equal the golden from <sections> on.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SUPPLEMENT_CAPS, serializeSupplementV2 } from '@study-paper/shared/contracts/supplement';
import { SEED_M2_META, SEED_UPGRADE_PAPER_ID } from '../../src/dev/seedFixture';
import { sha256Hex } from '../../src/ingest/files';
import { normalizeForStore } from '../../src/ingest/latexNormalize';
import { parse } from '../../src/ingest/latexml';
import { buildSupplementInput } from '../../src/ingest/structureStore';
import { startTestServer, type TestServer } from '../helpers/server';
import { tempDir } from '../helpers/tmp';
import { FakeArxivSource, freshId, importAndWait, useSource } from './helpers';
import { fromSections, GOLDEN_V2, offlineDir, SYN_M2_HTML, SYN_M2_PDF, upgradeAndWait, warnings } from './m2helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});

const build = () => {
  const parsed = parse(SYN_M2_HTML);
  return serializeSupplementV2(buildSupplementInput(parsed, parsed.equations.map((e) => ({ latex: normalizeForStore(e.latexRaw).latex, katexOk: true })), SEED_M2_META));
};

describe('supplement v2', () => {
  it('golden: synthetic-m2.html through A\'s parser and latexNormalize + SEED_M2_META = synthetic.supplement.v2.txt bytes', () => {
    expect(build().text).toBe(GOLDEN_V2);
    expect(build().truncated).toBe(false);
  });
  it('deterministic: the same structure twice → the same sha256', () => {
    expect(sha256Hex(build().text)).toBe(sha256Hex(build().text));
  });

  it('a 100,000-character title and 3,000 authors (not cut by the pipeline) → published, supplement_truncated, ≤ totalChars', async () => {
    const s = await startTestServer({ env: 'test' });
    servers.push(s);
    const id = freshId();
    const title = 'T'.repeat(100_000);
    const authors = Array.from({ length: 3_000 }, (_, i) => `Author ${i} & <co>`);
    useSource(s.deps, new FakeArxivSource({ [id]: { version: 1, title, authors, pdf: SYN_M2_PDF, html: SYN_M2_HTML } }));
    const { job, paper } = await importAndWait(s.deps, id);
    expect(job.status).toBe('done');
    expect(paper).toMatchObject({ supplementVersion: 2, title });
    expect(JSON.parse(paper.authorsJson)).toHaveLength(3_000); // the metadata itself is stored as given
    expect(warnings(s.deps, paper.id)).toContain('supplement_truncated');
    const text = readFileSync(s.deps.paths.supplementFile(paper.id, 2), 'utf8');
    expect(text.length).toBeLessThanOrEqual(SUPPLEMENT_CAPS.totalChars);
    expect(fromSections(text)).toBe(fromSections(GOLDEN_V2));
  });

  it('pipeline papers: an offline import and the upgrade of 2301.00002 equal the golden from <sections> on; the v1 file of the upgraded paper is unchanged', async () => {
    const id = freshId();
    const offline = offlineDir([{ id, version: 1, pdf: SYN_M2_PDF, html: SYN_M2_HTML }], tempDir('sp-offline-'));
    writeFileSync(join(offline, '2301.00002v1.html'), SYN_M2_HTML);
    const s = await startTestServer({ env: 'test', papers: ['upgrade'], offlineDir: offline });
    servers.push(s);
    const { paper } = await importAndWait(s.deps, id);
    expect(fromSections(readFileSync(s.deps.paths.supplementFile(paper.id, 2), 'utf8'))).toBe(fromSections(GOLDEN_V2));
    const v1 = readFileSync(s.deps.paths.supplementFile(SEED_UPGRADE_PAPER_ID, 1));
    expect((await upgradeAndWait(s.deps, SEED_UPGRADE_PAPER_ID)).job.status).toBe('done');
    const v2 = readFileSync(s.deps.paths.supplementFile(SEED_UPGRADE_PAPER_ID, 2), 'utf8');
    expect(fromSections(v2)).toBe(fromSections(GOLDEN_V2));
    expect(v2).toContain('arxiv: 2301.00002v1');
    expect(readFileSync(s.deps.paths.supplementFile(SEED_UPGRADE_PAPER_ID, 1)).equals(v1)).toBe(true);
    const row = s.deps.sqlite.prepare(`SELECT supplementSha256 FROM papers WHERE id = ?`).get(SEED_UPGRADE_PAPER_ID) as { supplementSha256: string };
    expect(row.supplementSha256).toBe(sha256Hex(v2));
  });
});
