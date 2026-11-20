// REST DTOs (PLAN 2.3, appendix A). The server validates requests with these schemas and the web parses
// responses with the same schemas. Owner: supervisor — builders request changes (what, why, who is affected).
// M2/M3 DTOs are first drafts: the owning builder may ask the supervisor to refine them before implementing.
import { z } from 'zod';
import {
  AnchorSchema,
  CitationSchema,
  ContextMode,
  EpochMsSchema,
  EQUATION_LATEX_MAX,
  ExplainBackPointStatus,
  FsrsState,
  GlossaryOrigin,
  GroundingLabel,
  HighlightColor,
  HighlightKind,
  IdSchema,
  IngestStatus,
  JobKind,
  JobStatus,
  JobStepName,
  JobStepStatus,
  LlmCallStatus,
  MessageRole,
  MessageStatsSchema,
  MessageStatus,
  NormRectSchema,
  PageNumberSchema,
  PaperCardKind,
  PaperCardStatus,
  PaperSource,
  PaperStatus,
  ReadingState,
  ReviewCardOrigin,
  ReviewCardType,
  ReviewRating,
  StructureSource,
  STUDY_PATH_MAX_CHARS,
  STUDY_PATH_MAX_CHECKS,
  TextPositionSelectorSchema,
  TextQuoteSelectorSchema,
  ThreadKind,
} from './domain';
import { Effort, LlmErrorCode, ModelAlias, TaskId } from './tasks';
import type { RouteId } from './routes';
import { isCanonicalBase64 } from '../image/png';

// ---------------------------------------------------------------------------------------------
// Limits (PLAN 3)
export const LIMITS = {
  jsonBodyBytes: 1 * 1024 * 1024,
  captureRequestBytes: 6 * 1024 * 1024,
  capturePngBytes: 4 * 1024 * 1024,
  uploadBytes: 50 * 1024 * 1024,
  selectionChars: 8000,
  questionChars: 8000,
  historyTokensApprox: 6000,
  importInputChars: 500,
  maxPdfPages: 300,
  /** Capture files (files.kind='capture') per paper: count and total bytes (storeCapture → 409 beyond, PLAN_M2 3.5). */
  capturesPerPaper: 500,
  captureBytesPerPaper: 500 * 1024 * 1024,
} as const;

const ClientRequestId = z.uuid();
const NullableString = z.string().nullable();
/**
 * Capture PNG as base64. Size: a PNG of capturePngBytes + 3 bytes or more fails here (the length cap); smaller
 * oversize PNGs fail in inspectPng — both are 400 `validation` (PLAN_M2 3.5). Only the canonical form is accepted
 * (D32: padding bits zero = decode/re-encode gives the input), so one PNG has one textual form and the payload hash
 * of the string equals byte identity. A non-canonical string is a 400 before the handler and before findExisting.
 */
export const Base64Png = z
  .string()
  .max(Math.ceil((LIMITS.capturePngBytes * 4) / 3) + 4)
  .refine((s) => isCanonicalBase64(s), { message: 'imagePng must be canonical standard base64 (padded, zero pad bits, no whitespace or data: prefix)' });

// ---------------------------------------------------------------------------------------------
// Common params
export const IdParams = z.object({ id: IdSchema });
export const RunIdParams = z.object({ runId: IdSchema });
export const ProgressParams = z.object({ id: IdSchema, sectionId: IdSchema });
export const CardsGenerateParams = z.object({ id: IdSchema, kind: PaperCardKind });

// ---------------------------------------------------------------------------------------------
// Health
export const HealthResponse = z.object({
  ok: z.boolean(),
  app: z.literal('study_paper'),
  version: z.string(),
  env: z.enum(['dev', 'prod', 'test']),
  llm: z.enum(['cli', 'api', 'mock']),
  backend: z.enum(['subscription', 'api']).optional(),
  pdfjsVersion: z.string(),
  db: z.object({ ok: z.boolean(), lastMigration: z.string().nullable() }),
});

// ---------------------------------------------------------------------------------------------
// Papers
export const PaperStateDto = z.object({ readable: z.boolean(), contextReady: z.boolean(), structureReady: z.boolean() });
/**
 * Whether the current LLM can answer about the paper (M1.1 review M5). `state.contextReady` only says that the
 * files and the AI index are ready; a ready paper in contextMode 'text' (>= 41 pages or > 15 MiB) is still not
 * answerable before M3. `reason` is null when `available`; the web maps it to a Korean message.
 * - context_not_ready: the AI index (supplement) is not ready yet
 * - text_mode_pages / text_mode_bytes: contextMode 'text' because of the page count / the PDF size
 */
export const AiUnavailableReason = z.enum(['context_not_ready', 'text_mode_pages', 'text_mode_bytes']);
export const AiAvailabilityDto = z.object({ available: z.boolean(), reason: AiUnavailableReason.nullable() });
export const PaperSummaryDto = z.object({
  id: IdSchema,
  source: PaperSource,
  arxivId: NullableString,
  arxivVersion: z.number().int().nullable(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int().nullable(),
  status: PaperStatus,
  ingestStatus: IngestStatus,
  state: PaperStateDto,
  /** Whether the current LLM can answer about this paper, and why not (see AiAvailabilityDto). */
  ai: AiAvailabilityDto,
  pageCount: z.number().int().nullable(),
  collectionId: NullableString,
  tags: z.array(z.string()),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  lastOpenedAt: EpochMsSchema.nullable(),
  // M2 (Library row badge and upgrade button from papers.list alone)
  structureSource: StructureSource.nullable(),
  /** 1 = metadata-only supplement.txt, 2 = supplement.v2.txt with the structure index, null = not ready yet. */
  supplementVersion: z.number().int().nullable(),
  /** Same decision as PaperDetailDto.structureUpgrade.available. */
  structureUpgradeAvailable: z.boolean(),
});
/**
 * Last reading position (PLAN_M2 3.8). `mode`/`top` arrived in M2: values stored by M1 ({page, zoom}) parse with
 * mode 'custom' and top 0. `top` = fraction of the page height at the top of the viewport.
 */
export const LastPositionDto = z.object({
  page: PageNumberSchema,
  zoom: z.number().positive(),
  mode: z.enum(['page-width', 'custom']).default('custom'),
  top: z.number().min(0).max(1).default(0),
});

// Jobs. A job has no JSON route of its own: its state reaches the web through PaperDetailDto.lastJob
// (reload, failure reason, retry) and through GET /jobs/:id/events (live).
// jobs.events contract: on subscribe the server first replays the stored steps as job.step events and the
// states already reached as job.state events, then streams live events, and ends with exactly one
// job.done | job.error. Subscribing to a finished job replays and ends immediately. Any number of subscribers.
export const JobStepDto = z.object({ step: JobStepName, status: JobStepStatus, detail: z.string().optional() });
/** `error` is `<JobErrorCode>: <message>` for a failed job (same code as the job.error event). */
export const JobDto = z.object({ id: IdSchema, kind: JobKind, paperId: IdSchema.nullable(), status: JobStatus, steps: z.array(JobStepDto), error: NullableString });
/**
 * M1 paper structure upgrade (PLAN_M2 3.1, D3). available = source arxiv, supplementVersion 1, structureSource 'none',
 * structureReadyAt set, not being deleted, and no STRUCTURE_FINAL_WARNINGS. reason: 'html_deferred' when the warnings
 * have html_deferred, 'm1_paper' for a target without warnings, null when not a target. job = the latest
 * upgrade_structure job of the paper (null when none).
 */
export const StructureUpgradeDto = z.object({
  available: z.boolean(),
  reason: z.enum(['m1_paper', 'html_deferred']).nullable(),
  job: JobDto.nullable(),
});
export const PaperDetailDto = PaperSummaryDto.extend({
  abstract: NullableString,
  doi: NullableString,
  venue: NullableString,
  primaryCategory: NullableString,
  publishedAt: EpochMsSchema.nullable(),
  codeUrl: NullableString,
  projectUrl: NullableString,
  citationCount: z.number().int().nullable(),
  structureSource: StructureSource.nullable(),
  contextMode: ContextMode.nullable(),
  ingestWarnings: z.array(z.string()),
  readableAt: EpochMsSchema.nullable(),
  contextReadyAt: EpochMsSchema.nullable(),
  structureReadyAt: EpochMsSchema.nullable(),
  lastPosition: LastPositionDto.nullable(),
  /**
   * Most recent INGEST job of the paper — kind import_arxiv | retry_ingest | upload (null when it has none). An
   * upgrade_structure job never shows here (it is structureUpgrade.job). The web shows steps/error from it and
   * re-subscribes to jobs.events with lastJob.id while ingestStatus is 'running'.
   */
  lastJob: JobDto.nullable(),
  /** M2: structure upgrade of an M1 paper (StructureUpgradeDto). */
  structureUpgrade: StructureUpgradeDto,
});
export const ListPapersResponse = z.object({ papers: z.array(PaperSummaryDto) });
export const ImportPaperRequest = z.object({ input: z.string().min(1).max(LIMITS.importInputChars), clientRequestId: ClientRequestId });
export const ImportPaperResponse = z.object({
  paperId: IdSchema,
  jobId: IdSchema.nullable(),
  existing: z.boolean(),
  existingVersion: z.number().int().optional(),
  requestedVersion: z.number().int().optional(),
});
export const PatchPaperRequest = z
  .object({ title: z.string().min(1).max(1000), status: PaperStatus, collectionId: IdSchema.nullable(), tags: z.array(z.string().max(100)).max(50) })
  .partial();
export const RetryIngestResponse = z.object({ jobId: IdSchema });
/** papers.upgradeStructure (M2): the started job, or the running one when an upgrade is already in progress. */
export const UpgradeStructureResponse = z.object({ jobId: IdSchema });
/** papers.capture (M2): GET /papers/:id/captures/:fileId → image/png. */
export const CaptureParams = z.object({ id: IdSchema, fileId: IdSchema });
export const UploadPaperResponse = z.object({ paperId: IdSchema, jobId: IdSchema.nullable(), existing: z.boolean() });


// ---------------------------------------------------------------------------------------------
// Highlights
export const HighlightDto = z.object({
  id: IdSchema,
  paperId: IdSchema,
  kind: HighlightKind,
  color: HighlightColor,
  quote: TextQuoteSelectorSchema.nullable(),
  position: TextPositionSelectorSchema.nullable(),
  page: PageNumberSchema,
  rects: z.array(NormRectSchema),
  sectionId: NullableString,
  comment: NullableString,
  imageFileId: NullableString,
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
/** The web never sends offsets: the server fills `position` with matchQuote on the stored page text. */
export const CreateHighlightRequest = z
  .object({
    kind: HighlightKind,
    color: HighlightColor,
    quote: TextQuoteSelectorSchema.optional(),
    page: PageNumberSchema,
    rects: z.array(NormRectSchema).min(1).max(500),
    imagePng: Base64Png.optional(),
    comment: z.string().max(LIMITS.questionChars).optional(),
  })
  .refine((h) => (h.kind === 'text' ? h.quote !== undefined && h.imagePng === undefined : h.quote === undefined), { message: 'text highlights need a quote (and no image); area highlights have no quote' })
  // M1: a highlight lives on one page (multi-page selections are split or refused by the viewer).
  .refine((h) => h.rects.every((r) => r.page === h.page), { message: 'every rect must be on `page`' });
export const PatchHighlightRequest = z.object({ color: HighlightColor, comment: z.string().max(LIMITS.questionChars).nullable() }).partial();
export const ListHighlightsResponse = z.object({ highlights: z.array(HighlightDto) });

// ---------------------------------------------------------------------------------------------
// Structure (M2)
export const SectionDto = z.object({
  id: IdSchema,
  parentId: NullableString,
  htmlId: NullableString,
  number: NullableString,
  title: z.string(),
  level: z.number().int(),
  ordinal: z.number().int(),
  pdfPage: PageNumberSchema.nullable(),
  pdfOffset: z.number().int().nullable(),
  /** Display rect of the anchored heading line (display only, never used for matching — PLAN_M2 3.2). */
  pdfRect: NormRectSchema.nullable(),
});
export const EquationDto = z.object({
  id: IdSchema,
  sectionId: NullableString,
  htmlId: NullableString,
  number: NullableString,
  ordinal: z.number().int(),
  latexRaw: z.string(),
  /** latexNormalize output, cut to EQUATION_LATEX_MAX (4,000; contracts/domain) when stored — never longer on read. */
  latex: z.string().max(EQUATION_LATEX_MAX),
  katexOk: z.boolean(),
  pdfPage: PageNumberSchema.nullable(),
  pdfOffset: z.number().int().nullable(),
  /** Display rect of the anchored equation tag (display only). */
  pdfRect: NormRectSchema.nullable(),
});
export const FigureDto = z.object({ id: IdSchema, sectionId: NullableString, htmlId: NullableString, kind: z.string(), number: NullableString, caption: z.string(), pdfPage: PageNumberSchema.nullable() });
export const ReferenceDto = z.object({
  id: IdSchema,
  ordinal: z.number().int(),
  label: NullableString,
  rawText: z.string(),
  title: NullableString,
  authors: z.array(z.string()),
  year: z.number().int().nullable(),
  venue: NullableString,
  doi: NullableString,
  arxivId: NullableString,
  citationCount: z.number().int().nullable(),
  /** Filled by papers.structure on read: a non-deleting Library paper with this arxivId (never stored — PLAN_M2 3.2). */
  inLibraryPaperId: NullableString,
  /** id of the li.ltx_bibitem in source.html (null when the item has none). */
  htmlId: NullableString,
});
export const StructureResponse = z.object({
  structureSource: StructureSource.nullable(),
  sections: z.array(SectionDto),
  equations: z.array(EquationDto),
  figures: z.array(FigureDto),
  references: z.array(ReferenceDto),
});
export const PutPositionRequest = LastPositionDto;

// Notes (M2)
export const NoteDto = z.object({ id: IdSchema, paperId: IdSchema, highlightId: NullableString, sectionId: NullableString, bodyMd: z.string(), createdAt: EpochMsSchema, updatedAt: EpochMsSchema });
export const CreateNoteRequest = z.object({ bodyMd: z.string().max(100_000), highlightId: IdSchema.optional(), sectionId: IdSchema.optional() });
export const PatchNoteRequest = z.object({ bodyMd: z.string().max(100_000) });
export const ListNotesResponse = z.object({ notes: z.array(NoteDto) });

// Reading progress (M2)
export const ProgressDto = z.object({ sectionId: IdSchema, state: ReadingState, updatedAt: EpochMsSchema });
export const ListProgressResponse = z.object({ progress: z.array(ProgressDto) });
export const PutProgressRequest = z.object({ state: ReadingState });

// Collections (M3)
export const CollectionDto = z.object({ id: IdSchema, name: z.string(), sortOrder: z.number().int() });
export const ListCollectionsResponse = z.object({ collections: z.array(CollectionDto) });
export const CreateCollectionRequest = z.object({ name: z.string().min(1).max(200) });
export const PatchCollectionRequest = z.object({ name: z.string().min(1).max(200), sortOrder: z.number().int() }).partial();

// ---------------------------------------------------------------------------------------------
// Review (M3, PLAN 8.6)
export const FsrsCardDto = z.object({
  due: EpochMsSchema,
  stability: z.number(),
  difficulty: z.number(),
  elapsedDays: z.number(),
  scheduledDays: z.number(),
  learningSteps: z.number().int(),
  reps: z.number().int(),
  lapses: z.number().int(),
  state: FsrsState,
  lastReview: EpochMsSchema.nullable(),
});
export const ReviewCardDto = z.object({
  id: IdSchema,
  paperId: IdSchema,
  highlightId: NullableString,
  sectionId: NullableString,
  type: ReviewCardType,
  frontMd: z.string(),
  backMd: z.string(),
  origin: ReviewCardOrigin,
  suspended: z.boolean(),
  fsrs: FsrsCardDto,
  citations: z.array(CitationSchema),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export const GradePreviewDto = z.object({ rating: ReviewRating, due: EpochMsSchema, scheduledDays: z.number() });
export const ReviewQueueResponse = z.object({
  now: EpochMsSchema,
  cards: z.array(z.object({ card: ReviewCardDto, preview: z.array(GradePreviewDto).length(4) })),
  newRemainingToday: z.number().int(),
});
export const ReviewStatsResponse = z.object({ dueToday: z.number().int(), newToday: z.number().int(), reviewedToday: z.number().int(), total: z.number().int() });
export const GradeRequest = z.object({ rating: ReviewRating, expectedReps: z.number().int().nonnegative(), clientRequestId: ClientRequestId });
export const CreateReviewCardRequest = z.object({ paperId: IdSchema, type: ReviewCardType, frontMd: z.string().min(1).max(8000), backMd: z.string().min(1).max(8000), highlightId: IdSchema.optional(), sectionId: IdSchema.optional() });
export const PatchReviewCardRequest = z.object({ frontMd: z.string().min(1).max(8000), backMd: z.string().min(1).max(8000), suspended: z.boolean() }).partial();

export const StudyCodeLanguage = z.enum(['cpp17', 'python']);
export type StudyCodeLanguage = z.infer<typeof StudyCodeLanguage>;
export const AnswerLanguage = z.enum(['ko', 'en']);
export const StudyPathResult = z.object({
  runId: IdSchema,
  text: z.string().min(1).max(STUDY_PATH_MAX_CHARS),
  citations: z.array(CitationSchema),
  codeLanguage: StudyCodeLanguage,
  checked: z.array(z.boolean()).min(1).max(STUDY_PATH_MAX_CHECKS),
});
export const StudyPathDto = z.object({
  result: StudyPathResult.nullable(),
  pending: z.object({
    runId: IdSchema,
    clientRequestId: ClientRequestId,
    regenerate: z.boolean(),
    codeLanguage: StudyCodeLanguage,
  }).nullable(),
});
export type StudyPathDto = z.infer<typeof StudyPathDto>;
const GenerateStudyPathRequest = z.strictObject({ clientRequestId: ClientRequestId, regenerate: z.boolean().optional() });
const CheckStudyPathRequest = z.strictObject({ runId: IdSchema, index: z.number().int().min(0).lt(STUDY_PATH_MAX_CHECKS), checked: z.boolean() });

// Only these user settings may cross the HTTP boundary. The settings table also contains private ingest state.
export const UserSettings = z.strictObject({
  'llm.backend': z.enum(['subscription', 'api']),
  'llm.monthlyLimitMicroUsd': z.number().int().min(0).max(1_000_000_000).nullable(),
  'llm.economy': z.boolean(),
  'llm.answerLanguage': AnswerLanguage,
  'study.codeLanguage': StudyCodeLanguage,
});
export type UserSettings = z.infer<typeof UserSettings>;
export const SecretStatus = z.strictObject({ keyConfigured: z.boolean(), generation: z.string().nullable(), updatedAt: z.number().int().nullable() });
export const SettingsDto = z.strictObject({ settings: UserSettings, credential: SecretStatus, aiAvailable: z.boolean() });
export const PutSettingsRequest = z.strictObject({ settings: UserSettings.partial() });
export const PutSecretRequest = z.strictObject({ key: z.string().regex(/^sk-ant-api03-[A-Za-z0-9_-]{24,200}$/) });
export const CheckSecretResponse = z.strictObject({ status: z.enum(['verified', 'missing', 'unavailable', 'rejected']) });


// ---------------------------------------------------------------------------------------------
// Threads and messages (B, M1)
// threads.create / messages.create contract (PLAN 2.3):
// - The SSE stream starts with run.accepted {runId, threadId, messageId (assistant message)} and ends with
//   exactly one run.done | run.error. The run itself persists the message, citations and llm_calls row.
// - A repeated clientRequestId never starts a second run or a second thread: the server attaches the new
//   stream to the existing run (replaying its events from run.accepted), or, when that run already finished,
//   replays run.accepted and its terminal event.
// - The server always creates a new thread for threads.create. Re-opening an existing explain thread for the
//   same selection is the web's job (compare ThreadDto.kind and anchor.quote.exact from threads.list).
// - 409 context_not_ready (JSON error DTO, no stream) until the paper is context_ready.
export const MessageDto = z.object({
  id: IdSchema,
  threadId: IdSchema,
  role: MessageRole,
  /**
   * assistant: the model's raw SP-Markup text exactly as stored (NOT displayMd). The web renders it by running
   * shared parseAnswer(contentMd, { final: status === 'complete' }) and pairs the result with `citations`
   * (matched server-side, same ordinals). user: the question or the selected quote as plain text.
   */
  contentMd: z.string(),
  status: MessageStatus,
  stats: MessageStatsSchema.nullable(),
  issues: z.array(z.string()),
  citations: z.array(CitationSchema),
  llmCallId: NullableString,
  /** llm_calls.effort of the answer (assistant messages with a run); null otherwise. "깊게" shows when 'high' on chat. */
  effort: Effort.nullable(),
  createdAt: EpochMsSchema,
});
export const ThreadDto = z.object({
  id: IdSchema,
  paperId: IdSchema,
  kind: ThreadKind,
  title: z.string(),
  anchor: AnchorSchema.nullable(),
  highlightId: NullableString,
  equationId: NullableString,
  sectionId: NullableString,
  /** Capture of a figure/equation thread (files.id, read with papers.capture); null otherwise. */
  imageFileId: NullableString,
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
/**
 * lastStats = the stored stats of the last assistant message (summary only — never shown as "논문 근거").
 * lastMessageStatus = status of the thread's last message (the web reuses a thread only when it is 'complete').
 */
export const ListThreadsResponse = z.object({ threads: z.array(ThreadDto.extend({ lastStats: MessageStatsSchema.nullable(), lastMessageStatus: MessageStatus.nullable() })) });
export const ThreadDetailResponse = z.object({ thread: ThreadDto, messages: z.array(MessageDto) });
/**
 * threads.create fields per kind (PLAN_M2 3.5–3.7). The schema checks SHAPE only; the kind table below is enforced
 * by B's handler (a combination outside it is a 400, never ignored):
 *   kind       | required                                   | optional       | not allowed
 *   explain    | a selection: anchor (text) or text (≥ 1)   | question       | imagePng, equationId, deep
 *   chat       | question                                   | anchor, text, deep | imagePng, equationId
 *   translate  | a selection: anchor (text) or text (≥ 1)   | —              | question, imagePng, equationId, deep
 *   figure     | anchor (area, 1 rect) + imagePng           | question       | equationId, deep, text
 *   equation   | equationId XOR (anchor (area, 1 rect) + imagePng) | question | deep, text
 * "a selection" (explain, translate): at least one of anchor (kind text, with quote) and text — both may be sent; the
 * selected text is anchor.quote.exact ?? text (the M1 handler rule, kept: M1 clients and tests send text alone).
 * deep (PLAN_M2 3.7): allowed only when the server-side task supportsDeep (chat); deep:false = absent. In the request
 * identity deep is a key only when true (runContract.ts, D31).
 */
export const CreateThreadRequest = z
  .object({
    kind: ThreadKind,
    anchor: AnchorSchema.optional(),
    text: z.string().max(LIMITS.selectionChars).optional(),
    question: z.string().max(LIMITS.questionChars).optional(),
    imagePng: Base64Png.optional(),
    equationId: IdSchema.optional(),
    deep: z.boolean().optional(),
    clientRequestId: ClientRequestId,
  })
  // Shape only: an image always belongs to an area anchor.
  .refine((r) => r.imagePng === undefined || r.anchor?.kind === 'area', { message: 'imagePng needs an area anchor' });
/**
 * messages.create adds a user turn `text` and streams the assistant answer.
 * regenerate=true replaces the LAST turn instead (the web sends the previous user text to "다시 생성", or an
 * edited one). Replace-on-success (M1.1, review M4): the new turn (user `text` + streaming assistant) is added
 * AFTER the old one, and the old turn (last assistant message, the user message before it, their citations) is
 * deleted only in the transaction that stores the new answer. If the new run ends any other way (error, cancel,
 * timeout) its new turn is deleted and the old turn stays as it was. M2 (PLAN_M2 3.4): the new turn's two messages
 * carry pendingReplace=1 until that commit; after a server restart startup recovery DELETES a pendingReplace turn
 * (both messages, their citations) and the old turn stays as it was. While the new run streams, threads.get returns
 * both turns.
 * 409 conflict when the thread has no assistant message to replace or a run of this thread is still in flight.
 * deep (PLAN_M2 3.7): follow-up questions run as task chat, so deep:true → high effort; regenerate inherits the
 * original turn's effort and regenerate + deep is a 400. deep:false = absent (identity key only when true).
 */
export const PostMessageRequest = z.object({ text: z.string().min(1).max(LIMITS.questionChars), regenerate: z.boolean().optional(), deep: z.boolean().optional(), clientRequestId: ClientRequestId });

// LLM runs
export const RunDto = z.object({
  runId: IdSchema,
  task: TaskId,
  status: LlmCallStatus,
  errorCode: LlmErrorCode.nullable(),
  paperId: NullableString,
  threadId: NullableString,
  model: ModelAlias,
  modelResolved: NullableString,
  effort: Effort,
  acceptedAt: EpochMsSchema,
  startedAt: EpochMsSchema.nullable(),
  finishedAt: EpochMsSchema.nullable(),
});
export const LlmHealthResponse = z.object({
  cliFound: z.boolean(),
  cliVersion: NullableString,
  verifiedVersion: z.string(),
  versionMatches: z.boolean(),
  mode: z.enum(['cli', 'api', 'mock']),
  detail: NullableString,
});

// Paper cards (B, M2)
export const CardItemDto = z.object({
  id: IdSchema,
  ordinal: z.number().int(),
  key: NullableString,
  category: NullableString,
  label: GroundingLabel.nullable(),
  title: NullableString,
  bodyMd: z.string(),
  attrs: z.record(z.string(), z.string()),
  confirmed: z.boolean(),
  userNote: NullableString,
  citations: z.array(CitationSchema),
});
/** CardItemDto.title: filled ONLY from the server constant tables (NOTATION_TITLES_KO, ASSUMPTION_CATEGORY_KO) — never model text. */
export const PaperCardDto = z.object({
  id: IdSchema,
  kind: PaperCardKind,
  status: PaperCardStatus,
  /** Model output kept for display only when status is parse_failed. A successful card's raw output stays in the DB (replay). */
  rawOutput: NullableString,
  /** paper_cards.errorCode: why the card failed (null on success). */
  errorCode: LlmErrorCode.nullable(),
  /** runId of the card's first run (paper_cards.llmCallId) — a returning panel polls it with llm.runs.get. */
  runId: NullableString,
  items: z.array(CardItemDto),
  createdAt: EpochMsSchema,
});
export const ListCardsResponse = z.object({ cards: z.array(PaperCardDto) });
export const GenerateCardRequest = z.object({ clientRequestId: ClientRequestId });
export const PatchCardItemRequest = z.object({ confirmed: z.boolean(), userNote: z.string().max(8000).nullable() }).partial();

// Glossary (B, M2)
/** definitionKo: SP-Markup source text; the web renders it with parseAnswer (citations are the server's matching). */
export const GlossaryTermDto = z.object({ id: IdSchema, paperId: IdSchema, term: z.string(), definitionKo: NullableString, origin: GlossaryOrigin, createdAt: EpochMsSchema, citations: z.array(CitationSchema) });
export const ListGlossaryResponse = z.object({ terms: z.array(GlossaryTermDto) });
/** glossary.create stores a term the user typed or accepted (JSON). glossary.define asks the model (SSE run;
 * the suggestion is stored only when the user then calls glossary.create). Strict: unknown fields (citations,
 * origin, status …) are a 400 — the client cannot send grounding state; the server re-parses and matches (D9). */
export const CreateGlossaryRequest = z.strictObject({ term: z.string().min(1).max(200), definitionKo: z.string().max(4000).optional(), sourceMessageId: IdSchema.optional(), llmCallId: IdSchema.optional() });
export const DefineGlossaryRequest = z.object({ term: z.string().min(1).max(200), selection: z.string().max(LIMITS.selectionChars).optional(), clientRequestId: ClientRequestId });
export const PatchGlossaryRequest = z.strictObject({ term: z.string().min(1).max(200), definitionKo: z.string().max(4000).nullable() }).partial();

// Review card generation (B, M3)
export const GenerateReviewCardsRequest = z.object({ highlightIds: z.array(IdSchema).min(1).max(50), clientRequestId: ClientRequestId });
export const AcceptReviewCardsRequest = z.object({
  llmCallId: IdSchema,
  cards: z.array(z.object({ type: ReviewCardType, frontMd: z.string().min(1).max(8000), backMd: z.string().min(1).max(8000), highlightId: IdSchema.optional(), sectionId: IdSchema.optional() })).min(1).max(24),
});
export const AcceptReviewCardsResponse = z.object({ cards: z.array(ReviewCardDto) });

// Explain-back (B, M3)
export const ExplainBackRequest = z.object({ sectionId: IdSchema, userText: z.string().min(1).max(LIMITS.questionChars), clientRequestId: ClientRequestId });
export const ExplainBackPointDto = z.object({ status: ExplainBackPointStatus, claim: z.string(), fix: z.string(), citations: z.array(CitationSchema) });
export const ExplainBackDto = z.object({ id: IdSchema, sectionId: NullableString, userText: z.string(), score: z.number().nullable(), points: z.array(ExplainBackPointDto), followup: NullableString, createdAt: EpochMsSchema });
export const ListExplainBacksResponse = z.object({ explainBacks: z.array(ExplainBackDto) });

// Usage (B, M3)
export const UsageQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(7) });
export const UsageRowDto = z.object({
  day: z.string(),
  task: TaskId,
  calls: z.number().int(),
  inputTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable(),
  cacheCreationTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  costUsdApiEquivEst: z.number().nullable(),
  cacheMissUnexpected: z.number().int(),
});
export const UsageSummaryResponse = z.object({ rows: z.array(UsageRowDto), sevenDayUtilization: z.number().nullable(),
  month: z.string(), spentMicroUsd: z.number().int(), heldMicroUsd: z.number().int(),
  apiCalls: z.number().int(), checks: z.number().int(), subscriptionCalls: z.number().int(), subscriptionTokens: z.number().int(),
  subscriptionCacheReadTokens: z.number().int(), subscriptionCacheWriteTokens: z.number().int(),
});

// ---------------------------------------------------------------------------------------------
/**
 * Request/response schema per route. `response` is the JSON body schema for json routes; null for SSE
 * (see sse.ts), binary, markdown and 204 routes. Mutating JSON routes return the updated DTO.
 */
export interface RouteSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType | null;
}
export const API_SCHEMAS = {
  health: { response: HealthResponse },
  'papers.import': { body: ImportPaperRequest, response: ImportPaperResponse },
  'jobs.events': { params: IdParams, response: null },
  'papers.list': { response: ListPapersResponse },
  'papers.get': { params: IdParams, response: PaperDetailDto },
  'papers.patch': { params: IdParams, body: PatchPaperRequest, response: PaperDetailDto },
  'papers.delete': { params: IdParams, response: null },
  'papers.pdf': { params: IdParams, response: null },
  'papers.retryIngest': { params: IdParams, response: RetryIngestResponse },
  'papers.upgradeStructure': { params: IdParams, response: UpgradeStructureResponse },
  'papers.capture': { params: CaptureParams, response: null },
  'highlights.list': { params: IdParams, response: ListHighlightsResponse },
  'highlights.create': { params: IdParams, body: CreateHighlightRequest, response: HighlightDto },
  'highlights.patch': { params: IdParams, body: PatchHighlightRequest, response: HighlightDto },
  'highlights.delete': { params: IdParams, response: null },
  'papers.structure': { params: IdParams, response: StructureResponse },
  'papers.position': { params: IdParams, body: PutPositionRequest, response: null },
  'notes.list': { params: IdParams, response: ListNotesResponse },
  'notes.create': { params: IdParams, body: CreateNoteRequest, response: NoteDto },
  'notes.patch': { params: IdParams, body: PatchNoteRequest, response: NoteDto },
  'notes.delete': { params: IdParams, response: null },
  'progress.list': { params: IdParams, response: ListProgressResponse },
  'progress.put': { params: ProgressParams, body: PutProgressRequest, response: ProgressDto },
  // Raw application/pdf body (no JSON body schema); the file name travels in the X-SP-Filename header.
  'papers.upload': { response: UploadPaperResponse },
  'collections.list': { response: ListCollectionsResponse },
  'collections.create': { body: CreateCollectionRequest, response: CollectionDto },
  'collections.patch': { params: IdParams, body: PatchCollectionRequest, response: CollectionDto },
  'collections.delete': { params: IdParams, response: null },
  'review.queue': { response: ReviewQueueResponse },
  'review.stats': { response: ReviewStatsResponse },
  'review.grade': { params: IdParams, body: GradeRequest, response: ReviewCardDto },
  'review.cards.create': { body: CreateReviewCardRequest, response: ReviewCardDto },
  'review.cards.patch': { params: IdParams, body: PatchReviewCardRequest, response: ReviewCardDto },
  'review.cards.delete': { params: IdParams, response: null },
  'papers.exportMd': { params: IdParams, response: null },
  'settings.secret.put': { body: PutSecretRequest, response: SecretStatus },
  'settings.secret.delete': { response: SecretStatus },
  'settings.secret.check': { body: z.strictObject({}), response: CheckSecretResponse },
  'settings.get': { response: SettingsDto },
  'settings.put': { body: PutSettingsRequest, response: SettingsDto },
  'threads.list': { params: IdParams, response: ListThreadsResponse },
  'threads.get': { params: IdParams, response: ThreadDetailResponse },
  'threads.delete': { params: IdParams, response: null },
  'threads.create': { params: IdParams, body: CreateThreadRequest, response: null },
  'messages.create': { params: IdParams, body: PostMessageRequest, response: null },
  'llm.runs.get': { params: RunIdParams, response: RunDto },
  'llm.runs.cancel': { params: RunIdParams, response: null },
  'llm.health': { response: LlmHealthResponse },
  'cards.list': { params: IdParams, response: ListCardsResponse },
  'cards.generate': { params: CardsGenerateParams, body: GenerateCardRequest, response: null },
  'cardItems.patch': { params: IdParams, body: PatchCardItemRequest, response: CardItemDto },
  'glossary.list': { params: IdParams, response: ListGlossaryResponse },
  'glossary.create': { params: IdParams, body: CreateGlossaryRequest, response: GlossaryTermDto },
  'glossary.define': { params: IdParams, body: DefineGlossaryRequest, response: null },
  'glossary.patch': { params: IdParams, body: PatchGlossaryRequest, response: GlossaryTermDto },
  'glossary.delete': { params: IdParams, response: null },
  'reviewCards.generate': { params: IdParams, body: GenerateReviewCardsRequest, response: null },
  'reviewCards.accept': { params: IdParams, body: AcceptReviewCardsRequest, response: AcceptReviewCardsResponse },
  'explainBack.create': { params: IdParams, body: ExplainBackRequest, response: null },
  'explainBack.list': { params: IdParams, response: ListExplainBacksResponse },
  'usage.summary': { query: UsageQuery, response: UsageSummaryResponse },
  'studyPath.get': { params: IdParams, response: StudyPathDto },
  'studyPath.generate': { params: IdParams, body: GenerateStudyPathRequest, response: null },
  'studyPath.check': { params: IdParams, body: CheckStudyPathRequest, response: StudyPathDto },
} as const satisfies Record<RouteId, RouteSchemas>;

type Schemas = typeof API_SCHEMAS;
/** Typed helpers: validated params / request body / JSON response of a route. */
export type ApiParams<R extends RouteId> = Schemas[R] extends { params: infer S extends z.ZodType } ? z.infer<S> : Record<string, never>;
export type ApiQuery<R extends RouteId> = Schemas[R] extends { query: infer S extends z.ZodType } ? z.input<S> : Record<string, never>;
export type ApiBody<R extends RouteId> = Schemas[R] extends { body: infer S extends z.ZodType } ? z.infer<S> : never;
export type ApiResponse<R extends RouteId> = Schemas[R] extends { response: infer S extends z.ZodType } ? z.infer<S> : never;

export type HealthResponse = z.infer<typeof HealthResponse>;
export type JobStepDto = z.infer<typeof JobStepDto>;
export type JobDto = z.infer<typeof JobDto>;
export type LastPositionDto = z.infer<typeof LastPositionDto>;
export type PaperStateDto = z.infer<typeof PaperStateDto>;
export type PaperSummaryDto = z.infer<typeof PaperSummaryDto>;
export type AiAvailabilityDto = z.infer<typeof AiAvailabilityDto>;
export type AiUnavailableReason = z.infer<typeof AiUnavailableReason>;
export type PaperDetailDto = z.infer<typeof PaperDetailDto>;
export type StructureUpgradeDto = z.infer<typeof StructureUpgradeDto>;
export type SectionDto = z.infer<typeof SectionDto>;
export type EquationDto = z.infer<typeof EquationDto>;
export type FigureDto = z.infer<typeof FigureDto>;
export type ReferenceDto = z.infer<typeof ReferenceDto>;
export type CardItemDto = z.infer<typeof CardItemDto>;
export type ListThreadsResponse = z.infer<typeof ListThreadsResponse>;
export type ListPapersResponse = z.infer<typeof ListPapersResponse>;
export type ImportPaperRequest = z.infer<typeof ImportPaperRequest>;
export type ImportPaperResponse = z.infer<typeof ImportPaperResponse>;
export type HighlightDto = z.infer<typeof HighlightDto>;
export type CreateHighlightRequest = z.infer<typeof CreateHighlightRequest>;
export type StructureResponse = z.infer<typeof StructureResponse>;
export type MessageDto = z.infer<typeof MessageDto>;
export type ThreadDto = z.infer<typeof ThreadDto>;
export type ThreadDetailResponse = z.infer<typeof ThreadDetailResponse>;
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;
export type RunDto = z.infer<typeof RunDto>;
export type LlmHealthResponse = z.infer<typeof LlmHealthResponse>;
export type ReviewCardDto = z.infer<typeof ReviewCardDto>;
export type PaperCardDto = z.infer<typeof PaperCardDto>;
export type GlossaryTermDto = z.infer<typeof GlossaryTermDto>;
export type ListCardsResponse = z.infer<typeof ListCardsResponse>;
export type ListGlossaryResponse = z.infer<typeof ListGlossaryResponse>;
export type UpgradeStructureResponse = z.infer<typeof UpgradeStructureResponse>;
export type NoteDto = z.infer<typeof NoteDto>;
export type ProgressDto = z.infer<typeof ProgressDto>;
