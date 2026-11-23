// The only source of the DB schema (PLAN 6). Change it, then `npm run db:generate` and commit the SQL in
// apps/server/drizzle/. Never run drizzle-kit push against a user DB. Owner: supervisor.
// Conventions: id = crypto.randomUUID() text PK, times = epoch ms integer, JSON = text column (…Json),
// page numbers 1-based, column names identical to PLAN 6 (camelCase).
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

const id = () => text('id').primaryKey();
const createdAt = () => integer('createdAt').notNull();
const updatedAt = () => integer('updatedAt').notNull();

export const collections = sqliteTable('collections', {
  id: id(),
  name: text('name').notNull(),
  sortOrder: integer('sortOrder').notNull().default(0),
});

export const papers = sqliteTable(
  'papers',
  {
    id: id(),
    source: text('source', { enum: ['arxiv', 'upload'] }).notNull(),
    arxivId: text('arxivId').unique(),
    arxivVersion: integer('arxivVersion'),
    doi: text('doi'),
    s2Id: text('s2Id'),
    title: text('title').notNull(),
    authorsJson: text('authorsJson').notNull().default('[]'),
    abstract: text('abstract'),
    year: integer('year'),
    venue: text('venue'),
    primaryCategory: text('primaryCategory'),
    publishedAt: integer('publishedAt'),
    codeUrl: text('codeUrl'),
    projectUrl: text('projectUrl'),
    citationCount: integer('citationCount'),
    collectionId: text('collectionId').references(() => collections.id, { onDelete: 'set null' }),
    tagsJson: text('tagsJson').notNull().default('[]'),
    status: text('status', { enum: ['inbox', 'reading', 'done'] }).notNull().default('inbox'),
    ingestStatus: text('ingestStatus', { enum: ['running', 'done', 'failed', 'interrupted'] }).notNull(),
    ingestWarningsJson: text('ingestWarningsJson').notNull().default('[]'),
    readableAt: integer('readableAt'),
    contextReadyAt: integer('contextReadyAt'),
    structureReadyAt: integer('structureReadyAt'),
    structureSource: text('structureSource', { enum: ['latexml', 'pdf-outline', 'pdf-inferred', 'none'] }),
    contextMode: text('contextMode', { enum: ['pdf', 'text'] }),
    pageCount: integer('pageCount'),
    pdfSha256: text('pdfSha256'),
    supplementSha256: text('supplementSha256'),
    supplementVersion: integer('supplementVersion'),
    lastOpenedAt: integer('lastOpenedAt'),
    lastPositionJson: text('lastPositionJson'),
    deletingAt: integer('deletingAt'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('papers_pdfSha256_idx').on(t.pdfSha256), index('papers_createdAt_idx').on(t.createdAt)],
);

export const files = sqliteTable(
  'files',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['pdf', 'html', 'supplement', 'capture'] }).notNull(),
    relPath: text('relPath').notNull(),
    sha256: text('sha256').notNull(),
    bytes: integer('bytes').notNull(),
    mime: text('mime').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('files_paperId_idx').on(t.paperId)],
);

export const pageTexts = sqliteTable(
  'page_texts',
  {
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    page: integer('page').notNull(),
    text: text('text').notNull(),
    itemsJson: text('itemsJson').notNull(),
    pdfjsVersion: text('pdfjsVersion').notNull(),
  },
  (t) => [primaryKey({ columns: [t.paperId, t.page] })],
);

export const sections = sqliteTable(
  'sections',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    parentId: text('parentId').references((): AnySQLiteColumn => sections.id, { onDelete: 'set null' }),
    htmlId: text('htmlId'),
    number: text('number'),
    title: text('title').notNull(),
    level: integer('level').notNull(),
    ordinal: integer('ordinal').notNull(),
    contentMd: text('contentMd'),
    pdfPage: integer('pdfPage'),
    pdfOffset: integer('pdfOffset'),
    pdfRectJson: text('pdfRectJson'),
  },
  (t) => [index('sections_paperId_ordinal_idx').on(t.paperId, t.ordinal)],
);

export const equations = sqliteTable(
  'equations',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    sectionId: text('sectionId').references(() => sections.id, { onDelete: 'set null' }),
    htmlId: text('htmlId'),
    number: text('number'),
    ordinal: integer('ordinal').notNull(),
    latexRaw: text('latexRaw').notNull(),
    latex: text('latex').notNull(),
    katexOk: integer('katexOk', { mode: 'boolean' }).notNull(),
    contextBefore: text('contextBefore'),
    contextAfter: text('contextAfter'),
    pdfPage: integer('pdfPage'),
    pdfOffset: integer('pdfOffset'),
    pdfRectJson: text('pdfRectJson'),
  },
  (t) => [index('equations_paperId_number_idx').on(t.paperId, t.number)],
);

export const figures = sqliteTable(
  'figures',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    sectionId: text('sectionId').references(() => sections.id, { onDelete: 'set null' }),
    htmlId: text('htmlId'),
    kind: text('kind').notNull(),
    number: text('number'),
    caption: text('caption').notNull(),
    pdfPage: integer('pdfPage'),
  },
  (t) => [index('figures_paperId_idx').on(t.paperId)],
);

export const paperReferences = sqliteTable(
  'paper_references',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    htmlId: text('htmlId'),
    label: text('label'),
    rawText: text('rawText').notNull(),
    title: text('title'),
    authorsJson: text('authorsJson').notNull().default('[]'),
    year: integer('year'),
    venue: text('venue'),
    doi: text('doi'),
    arxivId: text('arxivId'),
    s2Id: text('s2Id'),
    citationCount: integer('citationCount'),
    abstract: text('abstract'),
    inLibraryPaperId: text('inLibraryPaperId').references((): AnySQLiteColumn => papers.id, { onDelete: 'set null' }),
    enrichedAt: integer('enrichedAt'),
  },
  (t) => [index('paper_references_paperId_ordinal_idx').on(t.paperId, t.ordinal)],
);

export const highlights = sqliteTable(
  'highlights',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['text', 'area'] }).notNull(),
    color: integer('color').notNull(),
    quoteExact: text('quoteExact'),
    quotePrefix: text('quotePrefix'),
    quoteSuffix: text('quoteSuffix'),
    page: integer('page').notNull(),
    startOffset: integer('startOffset'),
    endOffset: integer('endOffset'),
    rectsJson: text('rectsJson').notNull(),
    sectionId: text('sectionId').references(() => sections.id, { onDelete: 'set null' }),
    comment: text('comment'),
    imageFileId: text('imageFileId').references(() => files.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('highlights_paperId_page_idx').on(t.paperId, t.page)],
);

export const notes = sqliteTable(
  'notes',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    highlightId: text('highlightId').references(() => highlights.id, { onDelete: 'set null' }),
    sectionId: text('sectionId').references(() => sections.id, { onDelete: 'set null' }),
    bodyMd: text('bodyMd').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('notes_paperId_idx').on(t.paperId)],
);

export const llmCalls = sqliteTable(
  'llm_calls',
  {
    runId: text('runId').primaryKey(),
    clientRequestId: text('clientRequestId'),
    /** sha256 of the request payload (task, paper, thread, inputs, image): same id + other payload → 409 (runContract rule 1). */
    payloadHash: text('payloadHash'),
    task: text('task').notNull(),
    paperId: text('paperId').references(() => papers.id, { onDelete: 'set null' }),
    threadId: text('threadId').references((): AnySQLiteColumn => threads.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    modelResolved: text('modelResolved'),
    effort: text('effort').notNull(),
    contextMode: text('contextMode'),
    promptVersion: text('promptVersion'),
    prefixFingerprint: text('prefixFingerprint'),
    cacheMissUnexpected: integer('cacheMissUnexpected', { mode: 'boolean' }),
    status: text('status', { enum: ['queued', 'running', 'ok', 'error', 'cancelled', 'timeout', 'interrupted'] }).notNull(),
    errorCode: text('errorCode'),
    errorDetail: text('errorDetail'),
    inputTokens: integer('inputTokens'),
    cacheReadTokens: integer('cacheReadTokens'),
    cacheCreationTokens: integer('cacheCreationTokens'),
    outputTokens: integer('outputTokens'),
    thinkingTokens: integer('thinkingTokens'),
    costUsdApiEquivEst: real('costUsdApiEquivEst'),
    ttftMs: integer('ttftMs'),
    durationMs: integer('durationMs'),
    durationApiMs: integer('durationApiMs'),
    queuedMs: integer('queuedMs'),
    rateLimitJson: text('rateLimitJson'),
    cliVersion: text('cliVersion'),
    acceptedAt: integer('acceptedAt').notNull(),
    startedAt: integer('startedAt'),
    finishedAt: integer('finishedAt'),
    // M2 (0002). Plain columns, no FK (an FK makes drizzle-kit rebuild the table — PLAN_M2 4).
    /** Internal repair call (clientRequestId NULL): runId of the run it belongs to. */
    parentRunId: text('parentRunId'),
    backend: text('backend', { enum: ['subscription', 'api'] }),
    executionMode: text('executionMode', { enum: ['cli', 'mock', 'api', 'legacy_unknown'] }).notNull().default('legacy_unknown'),
    credentialGeneration: text('credentialGeneration'),
    requestedModel: text('requestedModel'),
    priceVersion: text('priceVersion'),
    /** Adopted model output of a run whose result has no owner row (M2: glossary_define). Kept 30 days / until the paper is deleted. */
    resultRaw: text('resultRaw'),
  },
  (t) => [
    index('llm_calls_acceptedAt_idx').on(t.acceptedAt),
    index('llm_calls_fingerprint_idx').on(t.prefixFingerprint, t.modelResolved, t.finishedAt),
    // One run per client request (idempotent retries attach to it). Internal follow-up calls (SP-Blocks repair) use NULL.
    uniqueIndex('llm_calls_clientRequestId_uq').on(t.clientRequestId),
  ],
);

export const threads = sqliteTable(
  'threads',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['explain', 'translate', 'figure', 'equation', 'chat'] }).notNull(),
    title: text('title').notNull(),
    anchorJson: text('anchorJson'),
    quoteHash: text('quoteHash'),
    highlightId: text('highlightId').references(() => highlights.id, { onDelete: 'set null' }),
    equationId: text('equationId').references(() => equations.id, { onDelete: 'set null' }),
    sectionId: text('sectionId').references(() => sections.id, { onDelete: 'set null' }),
    imageFileId: text('imageFileId').references(() => files.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('threads_paperId_updatedAt_idx').on(t.paperId, t.updatedAt), index('threads_paperId_kind_quoteHash_idx').on(t.paperId, t.kind, t.quoteHash)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: id(),
    threadId: text('threadId').notNull().references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    contentMd: text('contentMd').notNull(),
    status: text('status', { enum: ['streaming', 'complete', 'error', 'cancelled', 'interrupted'] }).notNull(),
    statsJson: text('statsJson'),
    issuesJson: text('issuesJson'),
    llmCallId: text('llmCallId').references(() => llmCalls.runId, { onDelete: 'set null' }),
    clientRequestId: text('clientRequestId').unique(),
    createdAt: createdAt(),
    /** M2 (0002): 1 while a regenerate turn is not committed; startup recovery deletes such turns. */
    pendingReplace: integer('pendingReplace').notNull().default(0),
  },
  (t) => [index('messages_threadId_createdAt_idx').on(t.threadId, t.createdAt)],
);

/** Polymorphic owner, no FK: AFTER DELETE triggers on the 5 owner tables remove rows (custom migration). */
export const citations = sqliteTable(
  'citations',
  {
    id: id(),
    ownerType: text('ownerType', { enum: ['message', 'paper_card_item', 'review_card', 'explain_back', 'glossary_term'] }).notNull(),
    ownerId: text('ownerId').notNull(),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind', { enum: ['quote', 'equation'] }).notNull(),
    quote: text('quote'),
    eqNumber: text('eqNumber'),
    status: text('status').notNull(),
    score: real('score').notNull(),
    page: integer('page'),
    startOffset: integer('startOffset'),
    endOffset: integer('endOffset'),
    candidates: integer('candidates'),
    // M2 (0002), no FK (polymorphic table): the indexed equation of a resolved | no_anchor reference.
    equationId: text('equationId'),
    /** M2 (0002): uncheckedReason of an unchecked quote. */
    detail: text('detail'),
  },
  (t) => [uniqueIndex('citations_owner_ordinal_uq').on(t.ownerType, t.ownerId, t.ordinal)],
);

export const glossaryTerms = sqliteTable(
  'glossary_terms',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    term: text('term').notNull(),
    termNorm: text('termNorm').notNull(),
    definitionKo: text('definitionKo'),
    origin: text('origin', { enum: ['llm', 'llm_edited', 'manual'] }).notNull(),
    sourceMessageId: text('sourceMessageId').references(() => messages.id, { onDelete: 'set null' }),
    llmCallId: text('llmCallId').references(() => llmCalls.runId, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('glossary_terms_paperId_termNorm_uq').on(t.paperId, t.termNorm)],
);

export const paperCards = sqliteTable(
  'paper_cards',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['notation', 'assumptions', 'summary'] }).notNull(),
    status: text('status', { enum: ['generating', 'complete', 'parse_failed', 'error', 'interrupted'] }).notNull(),
    rawOutput: text('rawOutput'),
    llmCallId: text('llmCallId').references(() => llmCalls.runId, { onDelete: 'set null' }),
    promptVersion: text('promptVersion'),
    createdAt: createdAt(),
    /** M2 (0002): LlmErrorCode of a failed card; NULL after a successful commit. */
    errorCode: text('errorCode'),
  },
  (t) => [
    index('paper_cards_paperId_kind_idx').on(t.paperId, t.kind),
    // M2 (0002): at most one generating card per (paper, kind).
    uniqueIndex('paper_cards_generating_uq').on(t.paperId, t.kind).where(sql`${t.status} = 'generating'`),
  ],
);

export const paperCardItems = sqliteTable(
  'paper_card_items',
  {
    id: id(),
    cardId: text('cardId').notNull().references(() => paperCards.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    key: text('key'),
    category: text('category'),
    label: text('label'),
    title: text('title'),
    bodyMd: text('bodyMd').notNull(),
    attrsJson: text('attrsJson').notNull().default('{}'),
    confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(false),
    userNote: text('userNote'),
  },
  (t) => [index('paper_card_items_cardId_idx').on(t.cardId)],
);

export const reviewCards = sqliteTable(
  'review_cards',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    highlightId: text('highlightId').references(() => highlights.id, { onDelete: 'set null' }),
    sectionId: text('sectionId').references(() => sections.id, { onDelete: 'set null' }),
    type: text('type', { enum: ['definition', 'why', 'derivation', 'compare'] }).notNull(),
    frontMd: text('frontMd').notNull(),
    backMd: text('backMd').notNull(),
    origin: text('origin', { enum: ['llm', 'manual'] }).notNull(),
    llmCallId: text('llmCallId').references(() => llmCalls.runId, { onDelete: 'set null' }),
    suspended: integer('suspended', { mode: 'boolean' }).notNull().default(false),
    // FSRS card (ts-fsrs 5.4.2 Card, converted in study/fsrs.ts only)
    due: integer('due').notNull(),
    stability: real('stability').notNull(),
    difficulty: real('difficulty').notNull(),
    elapsedDays: real('elapsedDays').notNull(),
    scheduledDays: real('scheduledDays').notNull(),
    learningSteps: integer('learningSteps').notNull(),
    reps: integer('reps').notNull(),
    lapses: integer('lapses').notNull(),
    state: integer('state').notNull(),
    lastReview: integer('lastReview'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('review_cards_due_suspended_idx').on(t.due, t.suspended), index('review_cards_paperId_idx').on(t.paperId)],
);

/** One row per grade; FSRS columns hold the card state immediately BEFORE the grade (ts-fsrs ReviewLog). */
export const reviewLogs = sqliteTable(
  'review_logs',
  {
    id: id(),
    cardId: text('cardId').notNull().references(() => reviewCards.id, { onDelete: 'cascade' }),
    clientRequestId: text('clientRequestId').notNull().unique(),
    rating: integer('rating').notNull(),
    state: integer('state').notNull(),
    due: integer('due').notNull(),
    stability: real('stability').notNull(),
    difficulty: real('difficulty').notNull(),
    elapsedDays: real('elapsedDays').notNull(),
    lastElapsedDays: real('lastElapsedDays').notNull(),
    scheduledDays: real('scheduledDays').notNull(),
    learningSteps: integer('learningSteps').notNull(),
    reviewedAt: integer('reviewedAt').notNull(),
    fsrsLibVersion: text('fsrsLibVersion').notNull(),
  },
  (t) => [index('review_logs_cardId_idx').on(t.cardId), index('review_logs_reviewedAt_idx').on(t.reviewedAt)],
);

export const explainBacks = sqliteTable(
  'explain_backs',
  {
    id: id(),
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    sectionId: text('sectionId').references(() => sections.id, { onDelete: 'set null' }),
    userText: text('userText').notNull(),
    rawOutput: text('rawOutput'),
    resultJson: text('resultJson'),
    score: real('score'),
    llmCallId: text('llmCallId').references(() => llmCalls.runId, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('explain_backs_paperId_idx').on(t.paperId)],
);

export const readingProgress = sqliteTable(
  'reading_progress',
  {
    paperId: text('paperId').notNull().references(() => papers.id, { onDelete: 'cascade' }),
    sectionId: text('sectionId').notNull().references(() => sections.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['unread', 'skimmed', 'understood', 'reimplementable'] }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.paperId, t.sectionId] })],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: id(),
    kind: text('kind', { enum: ['import_arxiv', 'upload', 'retry_ingest', 'upgrade_structure'] }).notNull(),
    paperId: text('paperId').references(() => papers.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['running', 'done', 'failed', 'interrupted'] }).notNull(),
    stepsJson: text('stepsJson').notNull().default('[]'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('jobs_paperId_idx').on(t.paperId)],
);

export const httpCache = sqliteTable('http_cache', {
  key: text('key').primaryKey(),
  url: text('url').notNull(),
  status: integer('status').notNull(),
  body: text('body').notNull(),
  fetchedAt: integer('fetchedAt').notNull(),
  expiresAt: integer('expiresAt').notNull(),
});

// One row per dispatch attempt, including repairs and explicit credential checks. No paper FK:
 // deleting a paper must never refund a billed request.
export const apiCharges = sqliteTable('api_charges', {
  callId: text('callId').primaryKey(),
  month: text('month').notNull(),
  model: text('model').notNull(),
  generation: text('generation').notNull(),
  priceVersion: text('priceVersion').notNull(),
  kind: text('kind', { enum: ['message', 'check'] }).notNull(),
  held: integer('held').notNull(),
  spent: integer('spent').notNull(),
  status: text('status', { enum: ['reserved', 'sent', 'partial', 'settled', 'released'] }).notNull(),
  usageJson: text('usageJson'),
}, (t) => [index('api_charges_month_idx').on(t.month)]);

// The pending reservation is created before its llm_calls row in the same transaction.
// The last completed result remains visible through cancellation or a failed regeneration.
export const studyPaths = sqliteTable('study_paths', {
  paperId: text('paperId').primaryKey().references(() => papers.id, { onDelete: 'cascade' }),
  resultJson: text('resultJson'),
  pendingRunId: text('pendingRunId'),
  pendingCodeLanguage: text('pendingCodeLanguage', { enum: ['cpp17', 'python'] }),
  pendingRegenerate: integer('pendingRegenerate', { mode: 'boolean' }).notNull().default(false),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('valueJson').notNull(),
});

/** Owner tables of `citations` and their citations.ownerType value (used by triggers and orphan cleanup). */
export const CITATION_OWNER_TABLES = {
  message: 'messages',
  paper_card_item: 'paper_card_items',
  review_card: 'review_cards',
  explain_back: 'explain_backs',
  glossary_term: 'glossary_terms',
} as const;
