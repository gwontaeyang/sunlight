// Domain types shared by server and web. Owner: supervisor (change requests go through the supervisor).
// Conventions (PLAN 5.3, 6):
// - `page` is 1-based everywhere (API, DB, UI). Convert to array indexes only at the point of use.
// - Text offsets are UTF-16 code unit indexes into PageText.text, half-open [start, end).
// - NormRect is a 0..1 fraction of the pdf.js default viewport (crop box + the PDF's own /Rotate, no user
//   rotation), origin top-left, independent of zoom.
// - Stored rects/offsets are bound to papers.pdfSha256 and page_texts.pdfjsVersion; if either changes they
//   are invalid and must be re-anchored from the quote.
// - ids are crypto.randomUUID() strings, times are epoch milliseconds (UTC).
import { z } from 'zod';

export const IdSchema = z.string().min(1).max(64);
export const EpochMsSchema = z.number().int().nonnegative();
export const PageNumberSchema = z.number().int().min(1);

// ---------------------------------------------------------------------------------------------
// Enums (string unions). Keep values identical to the DB text columns (apps/server/src/db/schema.ts).
export const PaperSource = z.enum(['arxiv', 'upload']);
export const PaperStatus = z.enum(['inbox', 'reading', 'done']);
export const IngestStatus = z.enum(['running', 'done', 'failed', 'interrupted']);
export const StructureSource = z.enum(['latexml', 'pdf-outline', 'pdf-inferred', 'none']);
/** Older imports may have both an uploaded PDF and a verified LaTeXML source. */
export function isPdfOnlyUpload(source: string | undefined, structureSource: string | null | undefined): boolean {
  return source === 'upload' && structureSource !== 'latexml';
}

export const ContextMode = z.enum(['pdf', 'text']);
export const PaperReadiness = z.enum(['readable', 'context_ready', 'structure_ready']);
export const FileKind = z.enum(['pdf', 'html', 'supplement', 'capture']);
export const HighlightKind = z.enum(['text', 'area']);
export const HighlightColor = z.number().int().min(1).max(5);
/** The one palette of highlight colors 1–5: the PDF overlay (fill) and every list/button (swatch) use it. */
export const HIGHLIGHT_PALETTE: Record<1 | 2 | 3 | 4 | 5, { name: string; fill: string; swatch: string }> = {
  1: { name: '노랑', fill: 'rgba(255, 213, 0, 0.45)', swatch: '#ffd500' },
  2: { name: '초록', fill: 'rgba(80, 200, 120, 0.40)', swatch: '#50c878' },
  3: { name: '파랑', fill: 'rgba(80, 160, 255, 0.40)', swatch: '#50a0ff' },
  4: { name: '분홍', fill: 'rgba(255, 105, 180, 0.40)', swatch: '#ff69b4' },
  5: { name: '주황', fill: 'rgba(255, 140, 0, 0.45)', swatch: '#ff8c00' },
};
export const ThreadKind = z.enum(['explain', 'translate', 'figure', 'equation', 'chat']);
export const MessageRole = z.enum(['user', 'assistant']);
export const MessageStatus = z.enum(['streaming', 'complete', 'error', 'cancelled', 'interrupted']);
export const CitationOwnerType = z.enum(['message', 'paper_card_item', 'review_card', 'explain_back', 'glossary_term']);
export const CitationKind = z.enum(['quote', 'equation']);
/**
 * unchecked (M1.1 review N3): matching was not completed because the answer's or the quote's work budget or an
 * input cap was used up — the quote was neither found nor ruled out. Never evidence; shown as "확인 못 함".
 */
export const QuoteStatus = z.enum(['verbatim', 'fuzzy', 'ambiguous', 'not_found', 'unchecked']);
/**
 * resolved: the number is in the equation index and has a PDF position / no_anchor: in the index, no position /
 * ambiguous: several equations with this number / not_found: the paper HAS an equation index but not this number /
 * unindexed: the paper has no equation index at all (M1 papers, uploads) — the number cannot be checked.
 * Only resolved and no_anchor count as evidence for a [[P]] block.
 */
export const EqRefStatus = z.enum(['resolved', 'no_anchor', 'ambiguous', 'not_found', 'unindexed']);
export const CitationStatus = z.union([QuoteStatus, EqRefStatus]);
export const GroundingLabel = z.enum(['P', 'N', 'G']);
/**
 * glossary_terms.origin (PLAN_M2 3.4 rule 6 as revised by coordinator note M-R3-3): llmCallId is a successful run of
 * the same paper whose suggestion is still usable (glossary_define: suggestionAvailable; explain/chat: that message)
 * AND the requested term normalizes (termNorm) to the suggestion's term → llm when the definition equals the
 * suggestion after normalization, llm_edited when it differs. Different term, unusable/expired suggestion, no run →
 * manual. A patch that changes the term → manual; a patch of the definition only → llm becomes llm_edited.
 * The column is plain text without a CHECK — adding values changes no SQL.
 */
export const GlossaryOrigin = z.enum(['llm', 'llm_edited', 'manual']);
/**
 * The one term normalization (BRIEF_S S2, v3.4): glossary_terms.termNorm values, the duplicate-term 409 and the origin
 * decision (requested term vs suggested term) all use this function. NFKC (full-width → half-width, composed form),
 * whitespace runs → one space, trim, lower case.
 */
export function normalizeTerm(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}
/**
 * The one equation-number normalization (coordinator note 3(a), PLAN_M2 3.3 `want`): the server's citation decision
 * (llm/citations.ts), the web's index lookup and the viewer's jump all use it. trim → drop a leading `equation`,
 * `eq` or `eq.` (any case) and the spaces after it → drop one pair of parentheses around the whole → trim.
 * "(4)", " 4 ", "Eq. (4a)", "equation 4", "EQ.4" → "4" / "4a". Case is kept here (display); compare with eqNumberKey.
 * `equation` and a bare `eq` are stripped only when no letter follows them, so a word that merely starts with "eq"
 * ("eqn 4", "equal", "Equations 4") stays as it is (and then matches no index number) instead of losing its first
 * letters; `eq.` is always a prefix ("Eq.A.1" → "A.1"). "A letter" is any Unicode letter (\p{L}, flag u — integration
 * decision T1): "eqα 4" and "equation한" stay as they are, like "eqn 4" (stripping less never turns one number into
 * another; the `<eq n>` grammar and the index numbers are ASCII, so the real paths give the same results).
 */
export function normalizeEqNumber(n: string): string {
  return n
    .trim()
    .replace(/^(?:equation(?!\p{L})|eq\.|eq(?!\p{L}))\s*/iu, '')
    .replace(/^\((.*)\)$/, '$1')
    .trim();
}
/** The comparison key of an equation number: normalizeEqNumber, case-insensitive ("A.1" = "a.1", "4A" = "4a"). */
export function eqNumberKey(n: string): string {
  return normalizeEqNumber(n).toLowerCase();
}
export const PaperCardKind = z.enum(['notation', 'assumptions', 'summary']);
export const PaperCardStatus = z.enum(['generating', 'complete', 'parse_failed', 'error', 'interrupted']);
export const ReviewCardType = z.enum(['definition', 'why', 'derivation', 'compare']);
export const ReviewCardOrigin = z.enum(['llm', 'manual']);
/** ts-fsrs State enum values (0 New, 1 Learning, 2 Review, 3 Relearning). */
export const FsrsState = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
/** ts-fsrs Grade values (1 Again, 2 Hard, 3 Good, 4 Easy). Rating.Manual (0) is never accepted from the API. */
export const ReviewRating = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const ReadingState = z.enum(['unread', 'skimmed', 'understood', 'reimplementable']);
export const LlmCallStatus = z.enum(['queued', 'running', 'ok', 'error', 'cancelled', 'timeout', 'interrupted']);
/** upgrade_structure (M2, PLAN_M2 D3): user-started structure upgrade of an M1 paper. S2 `enrich` is M3 (D14). */
export const JobKind = z.enum(['import_arxiv', 'upload', 'retry_ingest', 'upgrade_structure']);
export const JobStatus = z.enum(['running', 'done', 'failed', 'interrupted']);
export const JobStepName = z.enum(['resolve', 'metadata', 'pdf', 'text', 'html', 'structure', 'anchor', 'supplement', 'enrich']);
export const JobStepStatus = z.enum(['running', 'ok', 'skipped', 'warn', 'error']);
export const ExplainBackPointStatus = z.enum(['correct', 'imprecise', 'wrong', 'missing']);
/** job.error codes (ingest). The web maps them to Korean messages; unknown stored text falls back to 'internal'. */
export const JobErrorCode = z.enum([
  'not_found', // arXiv has no such id/version
  'too_large', // > 300 pages, > 50 MB, response over the byte limit
  'invalid_pdf',
  'invalid_metadata',
  'version_mismatch',
  'timeout',
  'network',
  'blocked_url',
  'supplement_exists',
  'cancelled', // paper deleted while the job ran
  'interrupted', // server shutdown / crash (startup recovery)
  'internal',
]);

/**
 * Ingest warning codes (PLAN_M2 3.1–3.2). papers.ingestWarningsJson items are `<code>` or `<code>: <description>`.
 * structure_truncated = structure rows were dropped at the SUPPLEMENT_CAPS count caps, OR a stored text value was cut
 * at a parser character cap (a cut value ends with '…'; supervisor decision S-4). The paper still has a structure,
 * so it does not affect the upgrade decision.
 * anchor_failed = the anchor step threw (supervisor decision S-3): every PDF position of that paper is null (sections,
 * equations, captions unanchored) and the structure is kept. Not a final warning (not in STRUCTURE_FINAL_WARNINGS) —
 * the cause stays in the step detail; anchor_budget is only for the anchor step stopping at its work budget.
 */
export const IngestWarningCode = z.enum([
  'html_not_found',
  'html_deferred',
  'html_version_mismatch',
  'structure_parse_failed',
  'structure_too_large',
  'equation_number_gap',
  'anchor_budget',
  'anchor_failed',
  'katex_budget',
  'supplement_truncated',
  'structure_truncated',
]);
export type IngestWarningCode = z.infer<typeof IngestWarningCode>;
/**
 * Warnings that settle "this paper has no structure" for good (re-running with the same HTML gives the same result):
 * a paper carrying any of these is not an upgrade target (PLAN_M2 3.1 "M1 논문 upgrade").
 */
export const STRUCTURE_FINAL_WARNINGS: readonly IngestWarningCode[] = ['html_not_found', 'html_version_mismatch', 'structure_parse_failed', 'structure_too_large'];

export type PaperSource = z.infer<typeof PaperSource>;
export type PaperStatus = z.infer<typeof PaperStatus>;
export type IngestStatus = z.infer<typeof IngestStatus>;
export type StructureSource = z.infer<typeof StructureSource>;
export type ContextMode = z.infer<typeof ContextMode>;
export type PaperReadiness = z.infer<typeof PaperReadiness>;
export type FileKind = z.infer<typeof FileKind>;
export type HighlightKind = z.infer<typeof HighlightKind>;
export type ThreadKind = z.infer<typeof ThreadKind>;
export type MessageRole = z.infer<typeof MessageRole>;
export type MessageStatus = z.infer<typeof MessageStatus>;
export type CitationOwnerType = z.infer<typeof CitationOwnerType>;
export type CitationKind = z.infer<typeof CitationKind>;
export type QuoteStatus = z.infer<typeof QuoteStatus>;
export type EqRefStatus = z.infer<typeof EqRefStatus>;
export type CitationStatus = z.infer<typeof CitationStatus>;
export type GroundingLabel = z.infer<typeof GroundingLabel>;
export type GlossaryOrigin = z.infer<typeof GlossaryOrigin>;
export type PaperCardKind = z.infer<typeof PaperCardKind>;
export type PaperCardStatus = z.infer<typeof PaperCardStatus>;
export type ReviewCardType = z.infer<typeof ReviewCardType>;
export type FsrsState = z.infer<typeof FsrsState>;
export type ReviewRating = z.infer<typeof ReviewRating>;
export type ReadingState = z.infer<typeof ReadingState>;
export type LlmCallStatus = z.infer<typeof LlmCallStatus>;
export type JobKind = z.infer<typeof JobKind>;
export type JobStatus = z.infer<typeof JobStatus>;
export type JobStepName = z.infer<typeof JobStepName>;
export type JobStepStatus = z.infer<typeof JobStepStatus>;
export type JobErrorCode = z.infer<typeof JobErrorCode>;

// ---------------------------------------------------------------------------------------------
// Anchors (PLAN 5.3)
export const TextQuoteSelectorSchema = z.object({
  exact: z.string().min(1).max(8000),
  prefix: z.string().max(32).optional(),
  suffix: z.string().max(32).optional(),
});
export const TextPositionSelectorSchema = z
  .object({
    page: PageNumberSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((p) => p.start < p.end, { message: 'start must be < end' });
const RECT_EPS = 1e-6;
export const NormRectSchema = z
  .object({
    page: PageNumberSchema,
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  })
  .refine((r) => r.x + r.w <= 1 + RECT_EPS && r.y + r.h <= 1 + RECT_EPS, { message: 'rect must stay inside the page (x+w <= 1, y+h <= 1)' });
export const AnchorSchema = z
  .object({
    kind: HighlightKind,
    quote: TextQuoteSelectorSchema.optional(),
    position: TextPositionSelectorSchema.optional(),
    rects: z.array(NormRectSchema).max(500),
  })
  .refine((a) => a.kind !== 'text' || a.quote !== undefined, { message: 'a text anchor needs a quote' })
  .refine((a) => a.kind !== 'area' || (a.rects.length >= 1 && a.quote === undefined), { message: 'an area anchor needs rects and has no quote' });
export type TextQuoteSelector = z.infer<typeof TextQuoteSelectorSchema>;
export type TextPositionSelector = z.infer<typeof TextPositionSelectorSchema>;
export type NormRect = z.infer<typeof NormRectSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;

/** Text model of one PDF page (PLAN 5.3). text = items.map(i => i.str + (i.hasEOL ? '\n' : '')).join('') */
export const PageTextItemSchema = z.object({
  start: z.number().int().nonnegative(),
  len: z.number().int().nonnegative(),
  rect: NormRectSchema,
});
export const PageTextSchema = z.object({
  page: PageNumberSchema,
  text: z.string(),
  items: z.array(PageTextItemSchema),
});
export type PageTextItem = z.infer<typeof PageTextItemSchema>;
export type PageText = z.infer<typeof PageTextSchema>;

// ---------------------------------------------------------------------------------------------
// Citations and grounding (PLAN 5.1–5.4)
const QUOTE_STATUSES: readonly string[] = QuoteStatus.options;
const EQ_STATUSES: readonly string[] = EqRefStatus.options;
/** Upper bound of a stored equation's LaTeX (equations.latex is cut to this length when stored — PLAN_M2 3.2). */
export const EQUATION_LATEX_MAX = 4000;
export const OVERVIEW_MAX_CHARS = 4000;
export const STUDY_PATH_MAX_CHARS = 64_000;
export const STUDY_PATH_MAX_CHECKS = 32;
/** Max candidates attached to an ambiguous equation reference (PLAN_M2 3.3). */
export const EQ_CANDIDATES_MAX = 8;
/** Why a quote stayed `unchecked` (citations.detail, PLAN_M2 5 "unchecked 이유 미저장"). */
export const UncheckedReason = z.enum(['work_budget', 'quote_too_long', 'text_too_long', 'uploaded_pdf']);
export type UncheckedReason = z.infer<typeof UncheckedReason>;
export const EqCandidateSchema = z.object({ equationId: IdSchema, sectionNumber: z.string().nullable(), pdfPage: PageNumberSchema.nullable() });
export type EqCandidate = z.infer<typeof EqCandidateSchema>;
export const CitationSchema = z
  .object({
    ordinal: z.number().int().min(1),
    kind: CitationKind,
    quote: z.string().optional(),
    eqNumber: z.string().optional(),
    status: CitationStatus,
    score: z.number().min(0).max(1),
    position: TextPositionSelectorSchema.optional(),
    candidates: z.number().int().nonnegative().optional(),
    // M2 (PLAN_M2 3.3) — attached on read from `equations` (only citations.equationId and citations.detail are stored).
    /** The indexed equation (equation reference, resolved | no_anchor only). */
    equationId: IdSchema.optional(),
    /** Normalized LaTeX of that equation (resolved | no_anchor only). */
    latex: z.string().max(EQUATION_LATEX_MAX).optional(),
    /** KaTeX check result of that LaTeX (resolved | no_anchor only). */
    katexOk: z.boolean().optional(),
    /** The equations sharing the number (ambiguous only). */
    eqCandidates: z.array(EqCandidateSchema).max(EQ_CANDIDATES_MAX).optional(),
    /** Why the quote is unchecked (unchecked only). */
    uncheckedReason: UncheckedReason.optional(),
  })
  // kind decides the status family: a quote is never `resolved`, an equation reference never `verbatim`.
  .refine((c) => (c.kind === 'quote' ? QUOTE_STATUSES.includes(c.status) && c.quote !== undefined : EQ_STATUSES.includes(c.status) && c.eqNumber !== undefined), { message: 'citation kind and status/fields do not match' })
  // Only a single located quote carries a position (5.3): ambiguous / not_found have none.
  .refine((c) => c.position === undefined || c.status === 'verbatim' || c.status === 'fuzzy', { message: 'only verbatim/fuzzy quotes have a position' })
  // M2 fields belong to one status each (PLAN_M2 3.3).
  .refine(
    (c) => (c.equationId === undefined && c.latex === undefined && c.katexOk === undefined) || (c.kind === 'equation' && (c.status === 'resolved' || c.status === 'no_anchor')),
    { message: 'equationId/latex/katexOk only on a resolved or no_anchor equation reference' },
  )
  .refine((c) => c.eqCandidates === undefined || (c.kind === 'equation' && c.status === 'ambiguous'), { message: 'eqCandidates only on an ambiguous equation reference' })
  .refine((c) => c.uncheckedReason === undefined || (c.kind === 'quote' && c.status === 'unchecked'), { message: 'uncheckedReason only on an unchecked quote' });
export type Citation = z.infer<typeof CitationSchema>;

/** Citation as extracted by the parser, before it is matched against the paper. */
export const RawCitationSchema = z.object({
  ordinal: z.number().int().min(1),
  kind: CitationKind,
  quote: z.string().optional(),
  eqNumber: z.string().optional(),
});
export type RawCitation = z.infer<typeof RawCitationSchema>;

export const TermSuggestionSchema = z.object({ term: z.string(), definition: z.string() });
export type TermSuggestion = z.infer<typeof TermSuggestionSchema>;

export const ParsedBlockSchema = z.object({
  label: GroundingLabel.optional(),
  citationOrdinals: z.array(z.number().int().min(1)),
});
/** Output of shared/markup/parseAnswer.ts (PLAN 5.2). */
export const ParsedAnswerSchema = z.object({
  displayMd: z.string(),
  citations: z.array(RawCitationSchema),
  blocks: z.array(ParsedBlockSchema),
  glossary: z.array(TermSuggestionSchema),
  issues: z.array(z.string()),
});
export type ParsedBlock = z.infer<typeof ParsedBlockSchema>;
export type ParsedAnswer = z.infer<typeof ParsedAnswerSchema>;

/** One recognised SP-Blocks element (PLAN 7.3). body is SP-Markup and is re-parsed with parseAnswer. */
export interface BlockNode {
  tag: string;
  attrs: Record<string, string>;
  body: string;
  children: BlockNode[];
}
export const BlockNodeSchema: z.ZodType<BlockNode> = z.lazy(() =>
  z.object({ tag: z.string(), attrs: z.record(z.string(), z.string()), body: z.string(), children: z.array(BlockNodeSchema) }),
);
/** Output of shared/markup/parseBlocks.ts (owner B, M2). rawOutput keeps the full model text. */
export const ParsedBlocksSchema = z.object({
  items: z.array(BlockNodeSchema),
  outsideText: z.string(),
  issues: z.array(z.string()),
});
export type ParsedBlocks = z.infer<typeof ParsedBlocksSchema>;

/**
 * messages.statsJson — the single aggregation used everywhere (PLAN 5.4). Each group's sum is its denominator.
 * blocks (PLAN_M2 D18): p = [[P]] blocks with ≥ 1 verbatim quote ("논문 근거") / pEquationOnly = [[P]] blocks whose
 * only evidence is a resolved|no_anchor equation reference / pUnverified = the other [[P]] blocks. Old (M1) statsJson
 * rows have no pEquationOnly and parse as 0 — M1 papers had no equation index, so none of their P blocks qualify.
 */
export const MessageStatsSchema = z.object({
  blocks: z.object({ p: z.number().int(), pEquationOnly: z.number().int().default(0), pUnverified: z.number().int(), n: z.number().int(), g: z.number().int(), unlabeled: z.number().int() }),
  quotes: z.object({ verbatim: z.number().int(), fuzzy: z.number().int(), ambiguous: z.number().int(), notFound: z.number().int(), unchecked: z.number().int().optional() }), // unchecked: present only when > 0
  eqRefs: z.object({ resolved: z.number().int(), noAnchor: z.number().int(), ambiguous: z.number().int(), notFound: z.number().int(), unindexed: z.number().int().default(0) }),
});
export type MessageStats = z.infer<typeof MessageStatsSchema>;

// ---------------------------------------------------------------------------------------------
// Usage (PLAN 2.6). Missing values are null, never 0. Cost is always an "API-equivalent estimate".
export const LlmUsageSchema = z.object({
  inputTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable(),
  cacheCreationTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  thinkingTokens: z.number().int().nullable(),
  costUsdApiEquivEst: z.number().nullable(),
  durationMs: z.number().int().nullable(),
  durationApiMs: z.number().int().nullable(),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

export const RateLimitInfoSchema = z.object({
  status: z.string().nullable(),
  rateLimitType: z.string().nullable(),
  resetsAt: z.number().nullable(),
  sevenDayUtilization: z.number().nullable(),
});
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;

// ---------------------------------------------------------------------------------------------
// Reader shortcuts (PLAN 8.2). Shortcuts are active only on their route and never while an input,
// textarea or contenteditable has focus or an IME composition is in progress.
export const ShortcutScope = z.enum(['reader', 'review']);
export type ShortcutScope = z.infer<typeof ShortcutScope>;
export const SHORTCUT_ROUTES: Record<ShortcutScope, string> = { reader: '/paper/:id', review: '/review' };
export const READER_SHORTCUTS = {
  explain: 'e',
  translate: 't',
  highlightLastColor: 'h',
  highlightColor1: '1',
  highlightColor2: '2',
  highlightColor3: '3',
  highlightColor4: '4',
  highlightColor5: '5',
  ask: 'c',
  note: 'n',
  glossary: 'g',
  escape: 'Escape',
  back: 'Alt+ArrowLeft',
} as const;
export const REVIEW_SHORTCUTS = { reveal: ' ', again: '1', hard: '2', good: '3', easy: '4' } as const;
/** Shortcuts in milestone 1 (PLAN 1.1): E, H, 1–5. The rest arrive in M2. */
export const M1_READER_SHORTCUTS = ['explain', 'highlightLastColor', 'highlightColor1', 'highlightColor2', 'highlightColor3', 'highlightColor4', 'highlightColor5'] as const;
/** Shortcuts in milestone 2 (PLAN_M2 3.8): M1 + T, C, N, G, Alt+←. */
export const M2_READER_SHORTCUTS = [...M1_READER_SHORTCUTS, 'translate', 'ask', 'note', 'glossary', 'back'] as const;

/** Reader actions published by the viewer (C) and consumed by the panels (D) through readerStore. */
export const ReaderActionKind = z.enum(['explain', 'translate', 'ask', 'figure', 'equation', 'note', 'glossary']);
export type ReaderActionKind = z.infer<typeof ReaderActionKind>;

// ---------------------------------------------------------------------------------------------
// Paper cards (PLAN 7.3, PLAN_M2 3.4). Item titles come only from these server-side tables (rule 3).
/** notation_card keys: exactly one <item key> each. (Moved here from markup/grammar.ts, which re-exports it.) */
export const NOTATION_KEYS = [
  'frame_notation',
  'transform_direction',
  'rotation_param',
  'quaternion_convention',
  'perturbation_side',
  'error_definition',
  'state_vector',
  'jacobian_convention',
  'gravity_sign',
  'time_notation',
  'units',
] as const;
export type NotationKey = (typeof NOTATION_KEYS)[number];
export const NOTATION_TITLES_KO: Record<NotationKey, string> = {
  frame_notation: '좌표계 표기',
  transform_direction: '변환 방향',
  rotation_param: '회전 표현',
  quaternion_convention: '쿼터니언 규약',
  perturbation_side: '섭동 방향(좌·우)',
  error_definition: '오차 정의',
  state_vector: '상태 벡터',
  jacobian_convention: '자코비안 규약',
  gravity_sign: '중력 부호',
  time_notation: '시간 표기',
  units: '단위',
};
/** assumptions_card categories; `limitation` items also carry `stated`. */
export const ASSUMPTION_CATEGORIES = ['sensor', 'motion', 'environment', 'initialization', 'time_sync', 'observability', 'computation', 'limitation'] as const;
export type AssumptionCategory = (typeof ASSUMPTION_CATEGORIES)[number];
export const ASSUMPTION_CATEGORY_KO: Record<AssumptionCategory, string> = {
  sensor: '센서',
  motion: '운동',
  environment: '환경',
  initialization: '초기화',
  time_sync: '시간 동기화',
  observability: '관측 가능성',
  computation: '계산',
  limitation: '한계',
};
/** `stated` of a limitation item: the authors say it / it is inferred. */
export const ASSUMPTION_STATED = ['author', 'inferred'] as const;
export type AssumptionStated = (typeof ASSUMPTION_STATED)[number];

// ---------------------------------------------------------------------------------------------
// Reader ↔ Panel (PLAN_M2 3.8)
export type PanelTab = 'ai' | 'highlights' | 'cards' | 'equations' | 'references' | 'glossary';
/** Result of a structure jump: located (rect), page_only (page without rect, or no navigator), no_anchor (no page). */
export type JumpResult = 'located' | 'page_only' | 'no_anchor';
