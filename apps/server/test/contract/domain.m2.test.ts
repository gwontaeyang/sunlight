// Contract: M2 additions to contracts/domain.ts (BRIEF_S S2). Owner: supervisor.
import { describe, expect, it } from 'vitest';
import {
  ASSUMPTION_CATEGORIES,
  ASSUMPTION_CATEGORY_KO,
  ASSUMPTION_STATED,
  CitationSchema,
  GlossaryOrigin,
  IngestWarningCode,
  JobKind,
  M1_READER_SHORTCUTS,
  M2_READER_SHORTCUTS,
  MessageStatsSchema,
  NOTATION_KEYS,
  NOTATION_TITLES_KO,
  READER_SHORTCUTS,
  STRUCTURE_FINAL_WARNINGS,
} from '@study-paper/shared/contracts/domain';
import { NOTATION_KEYS as GRAMMAR_NOTATION_KEYS } from '@study-paper/shared/markup/grammar';

describe('contracts/domain M2', () => {
  it('an M1 statsJson (no pEquationOnly) parses with pEquationOnly = 0; a new one keeps its value', () => {
    const m1 = {
      blocks: { p: 2, pUnverified: 1, n: 0, g: 1, unlabeled: 0 },
      quotes: { verbatim: 2, fuzzy: 0, ambiguous: 0, notFound: 1 },
      eqRefs: { resolved: 0, noAnchor: 0, ambiguous: 0, notFound: 0 },
    };
    const parsed = MessageStatsSchema.parse(JSON.parse(JSON.stringify(m1)));
    expect(parsed.blocks).toEqual({ p: 2, pEquationOnly: 0, pUnverified: 1, n: 0, g: 1, unlabeled: 0 });
    expect(MessageStatsSchema.parse({ ...m1, blocks: { ...m1.blocks, pEquationOnly: 3 } }).blocks.pEquationOnly).toBe(3);
  });

  it('Citation M2 fields: each belongs to one status family', () => {
    const eq = { ordinal: 1, kind: 'equation', eqNumber: '1', score: 1 } as const;
    const q = { ordinal: 1, kind: 'quote', quote: 'abc', score: 1 } as const;
    expect(CitationSchema.safeParse({ ...eq, status: 'resolved', equationId: 'e1', latex: 'x', katexOk: true }).success).toBe(true);
    expect(CitationSchema.safeParse({ ...eq, status: 'no_anchor', equationId: 'e1', latex: 'x', katexOk: false }).success).toBe(true);
    expect(CitationSchema.safeParse({ ...eq, status: 'not_found', equationId: 'e1' }).success).toBe(false);
    expect(CitationSchema.safeParse({ ...eq, status: 'ambiguous', latex: 'x' }).success).toBe(false);
    expect(CitationSchema.safeParse({ ...q, status: 'verbatim', katexOk: true }).success).toBe(false);
    const cand = { equationId: 'e1', sectionNumber: null, pdfPage: null };
    expect(CitationSchema.safeParse({ ...eq, status: 'ambiguous', score: 0, candidates: 2, eqCandidates: [cand, cand] }).success).toBe(true);
    expect(CitationSchema.safeParse({ ...eq, status: 'resolved', eqCandidates: [cand] }).success).toBe(false);
    expect(CitationSchema.safeParse({ ...eq, status: 'ambiguous', eqCandidates: Array.from({ length: 9 }, () => cand) }).success).toBe(false);
    expect(CitationSchema.safeParse({ ...q, status: 'unchecked', score: 0, uncheckedReason: 'work_budget' }).success).toBe(true);
    expect(CitationSchema.safeParse({ ...q, status: 'not_found', score: 0, uncheckedReason: 'work_budget' }).success).toBe(false);
    expect(CitationSchema.safeParse({ ...eq, status: 'resolved', latex: 'x'.repeat(4000) }).success).toBe(true);
    expect(CitationSchema.safeParse({ ...eq, status: 'resolved', latex: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('enums: GlossaryOrigin (coordinator M-R3-3: no llm_unverified), JobKind, IngestWarningCode', () => {
    expect(GlossaryOrigin.options).toEqual(['llm', 'llm_edited', 'manual']);
    expect(JobKind.options).toContain('upgrade_structure');
    expect(JobKind.options).not.toContain('enrich');
    expect(IngestWarningCode.options).toHaveLength(11); // 10 of m2-contracts + anchor_failed (supervisor decision S-3)
    expect([...STRUCTURE_FINAL_WARNINGS].sort()).toEqual(['html_not_found', 'html_version_mismatch', 'structure_parse_failed', 'structure_too_large']);
  });

  it('anchor_failed (S-3) is an ingest warning code and not a final warning: the structure is kept', () => {
    expect(IngestWarningCode.safeParse('anchor_failed').success).toBe(true);
    expect(IngestWarningCode.options).toContain('anchor_budget');
    expect(STRUCTURE_FINAL_WARNINGS).not.toContain('anchor_failed');
  });

  it('M2 shortcuts = M1 + translate, ask, note, glossary, back; all are READER_SHORTCUTS keys', () => {
    expect(M2_READER_SHORTCUTS).toEqual([...M1_READER_SHORTCUTS, 'translate', 'ask', 'note', 'glossary', 'back']);
    for (const k of M2_READER_SHORTCUTS) expect(READER_SHORTCUTS[k]).toBeDefined();
  });

  it('card constants: NOTATION_KEYS defined once (grammar re-exports it), titles and categories complete', () => {
    expect(GRAMMAR_NOTATION_KEYS).toBe(NOTATION_KEYS);
    expect(NOTATION_KEYS).toHaveLength(11);
    expect(Object.keys(NOTATION_TITLES_KO).sort()).toEqual([...NOTATION_KEYS].sort());
    expect(Object.keys(ASSUMPTION_CATEGORY_KO).sort()).toEqual([...ASSUMPTION_CATEGORIES].sort());
    expect(ASSUMPTION_STATED).toEqual(['author', 'inferred']);
  });
});
