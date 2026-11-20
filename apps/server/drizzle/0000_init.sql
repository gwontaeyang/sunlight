CREATE TABLE `citations` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerType` text NOT NULL,
	`ownerId` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`quote` text,
	`eqNumber` text,
	`status` text NOT NULL,
	`score` real NOT NULL,
	`page` integer,
	`startOffset` integer,
	`endOffset` integer,
	`candidates` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `citations_owner_ordinal_uq` ON `citations` (`ownerType`,`ownerId`,`ordinal`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `equations` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`sectionId` text,
	`htmlId` text,
	`number` text,
	`ordinal` integer NOT NULL,
	`latexRaw` text NOT NULL,
	`latex` text NOT NULL,
	`katexOk` integer NOT NULL,
	`contextBefore` text,
	`contextAfter` text,
	`pdfPage` integer,
	`pdfOffset` integer,
	`pdfRectJson` text,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sectionId`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `equations_paperId_number_idx` ON `equations` (`paperId`,`number`);--> statement-breakpoint
CREATE TABLE `explain_backs` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`sectionId` text,
	`userText` text NOT NULL,
	`rawOutput` text,
	`resultJson` text,
	`score` real,
	`llmCallId` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sectionId`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`llmCallId`) REFERENCES `llm_calls`(`runId`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `explain_backs_paperId_idx` ON `explain_backs` (`paperId`);--> statement-breakpoint
CREATE TABLE `figures` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`sectionId` text,
	`htmlId` text,
	`kind` text NOT NULL,
	`number` text,
	`caption` text NOT NULL,
	`pdfPage` integer,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sectionId`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `figures_paperId_idx` ON `figures` (`paperId`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`kind` text NOT NULL,
	`relPath` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`mime` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `files_paperId_idx` ON `files` (`paperId`);--> statement-breakpoint
CREATE TABLE `glossary_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`term` text NOT NULL,
	`termNorm` text NOT NULL,
	`definitionKo` text,
	`origin` text NOT NULL,
	`sourceMessageId` text,
	`llmCallId` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sourceMessageId`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`llmCallId`) REFERENCES `llm_calls`(`runId`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `glossary_terms_paperId_termNorm_uq` ON `glossary_terms` (`paperId`,`termNorm`);--> statement-breakpoint
CREATE TABLE `highlights` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`kind` text NOT NULL,
	`color` integer NOT NULL,
	`quoteExact` text,
	`quotePrefix` text,
	`quoteSuffix` text,
	`page` integer NOT NULL,
	`startOffset` integer,
	`endOffset` integer,
	`rectsJson` text NOT NULL,
	`sectionId` text,
	`comment` text,
	`imageFileId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sectionId`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`imageFileId`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `highlights_paperId_page_idx` ON `highlights` (`paperId`,`page`);--> statement-breakpoint
CREATE TABLE `http_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`status` integer NOT NULL,
	`body` text NOT NULL,
	`fetchedAt` integer NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`paperId` text,
	`status` text NOT NULL,
	`stepsJson` text DEFAULT '[]' NOT NULL,
	`error` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_paperId_idx` ON `jobs` (`paperId`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`runId` text PRIMARY KEY NOT NULL,
	`clientRequestId` text,
	`payloadHash` text,
	`task` text NOT NULL,
	`paperId` text,
	`threadId` text,
	`model` text NOT NULL,
	`modelResolved` text,
	`effort` text NOT NULL,
	`contextMode` text,
	`promptVersion` text,
	`prefixFingerprint` text,
	`cacheMissUnexpected` integer,
	`status` text NOT NULL,
	`errorCode` text,
	`errorDetail` text,
	`inputTokens` integer,
	`cacheReadTokens` integer,
	`cacheCreationTokens` integer,
	`outputTokens` integer,
	`thinkingTokens` integer,
	`costUsdApiEquivEst` real,
	`ttftMs` integer,
	`durationMs` integer,
	`durationApiMs` integer,
	`queuedMs` integer,
	`rateLimitJson` text,
	`cliVersion` text,
	`acceptedAt` integer NOT NULL,
	`startedAt` integer,
	`finishedAt` integer,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`threadId`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `llm_calls_acceptedAt_idx` ON `llm_calls` (`acceptedAt`);--> statement-breakpoint
CREATE INDEX `llm_calls_fingerprint_idx` ON `llm_calls` (`prefixFingerprint`,`modelResolved`,`finishedAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `llm_calls_clientRequestId_uq` ON `llm_calls` (`clientRequestId`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`threadId` text NOT NULL,
	`role` text NOT NULL,
	`contentMd` text NOT NULL,
	`status` text NOT NULL,
	`statsJson` text,
	`issuesJson` text,
	`llmCallId` text,
	`clientRequestId` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`threadId`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`llmCallId`) REFERENCES `llm_calls`(`runId`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_clientRequestId_unique` ON `messages` (`clientRequestId`);--> statement-breakpoint
CREATE INDEX `messages_threadId_createdAt_idx` ON `messages` (`threadId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`highlightId` text,
	`sectionId` text,
	`bodyMd` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`highlightId`) REFERENCES `highlights`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sectionId`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notes_paperId_idx` ON `notes` (`paperId`);--> statement-breakpoint
CREATE TABLE `page_texts` (
	`paperId` text NOT NULL,
	`page` integer NOT NULL,
	`text` text NOT NULL,
	`itemsJson` text NOT NULL,
	`pdfjsVersion` text NOT NULL,
	PRIMARY KEY(`paperId`, `page`),
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `paper_card_items` (
	`id` text PRIMARY KEY NOT NULL,
	`cardId` text NOT NULL,
	`ordinal` integer NOT NULL,
	`key` text,
	`category` text,
	`label` text,
	`title` text,
	`bodyMd` text NOT NULL,
	`attrsJson` text DEFAULT '{}' NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	`userNote` text,
	FOREIGN KEY (`cardId`) REFERENCES `paper_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `paper_card_items_cardId_idx` ON `paper_card_items` (`cardId`);--> statement-breakpoint
CREATE TABLE `paper_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`rawOutput` text,
	`llmCallId` text,
	`promptVersion` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`llmCallId`) REFERENCES `llm_calls`(`runId`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `paper_cards_paperId_kind_idx` ON `paper_cards` (`paperId`,`kind`);--> statement-breakpoint
CREATE TABLE `paper_references` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`ordinal` integer NOT NULL,
	`htmlId` text,
	`label` text,
	`rawText` text NOT NULL,
	`title` text,
	`authorsJson` text DEFAULT '[]' NOT NULL,
	`year` integer,
	`venue` text,
	`doi` text,
	`arxivId` text,
	`s2Id` text,
	`citationCount` integer,
	`abstract` text,
	`inLibraryPaperId` text,
	`enrichedAt` integer,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inLibraryPaperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `paper_references_paperId_ordinal_idx` ON `paper_references` (`paperId`,`ordinal`);--> statement-breakpoint
CREATE TABLE `papers` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`arxivId` text,
	`arxivVersion` integer,
	`doi` text,
	`s2Id` text,
	`title` text NOT NULL,
	`authorsJson` text DEFAULT '[]' NOT NULL,
	`abstract` text,
	`year` integer,
	`venue` text,
	`primaryCategory` text,
	`publishedAt` integer,
	`codeUrl` text,
	`projectUrl` text,
	`citationCount` integer,
	`collectionId` text,
	`tagsJson` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'inbox' NOT NULL,
	`ingestStatus` text NOT NULL,
	`ingestWarningsJson` text DEFAULT '[]' NOT NULL,
	`readableAt` integer,
	`contextReadyAt` integer,
	`structureReadyAt` integer,
	`structureSource` text,
	`contextMode` text,
	`pageCount` integer,
	`pdfSha256` text,
	`supplementSha256` text,
	`supplementVersion` integer,
	`lastOpenedAt` integer,
	`lastPositionJson` text,
	`deletingAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`collectionId`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `papers_arxivId_unique` ON `papers` (`arxivId`);--> statement-breakpoint
CREATE INDEX `papers_pdfSha256_idx` ON `papers` (`pdfSha256`);--> statement-breakpoint
CREATE INDEX `papers_createdAt_idx` ON `papers` (`createdAt`);--> statement-breakpoint
CREATE TABLE `reading_progress` (
	`paperId` text NOT NULL,
	`sectionId` text NOT NULL,
	`state` text NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`paperId`, `sectionId`),
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sectionId`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `review_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`highlightId` text,
	`sectionId` text,
	`type` text NOT NULL,
	`frontMd` text NOT NULL,
	`backMd` text NOT NULL,
	`origin` text NOT NULL,
	`llmCallId` text,
	`suspended` integer DEFAULT false NOT NULL,
	`due` integer NOT NULL,
	`stability` real NOT NULL,
	`difficulty` real NOT NULL,
	`elapsedDays` real NOT NULL,
	`scheduledDays` real NOT NULL,
	`learningSteps` integer NOT NULL,
	`reps` integer NOT NULL,
	`lapses` integer NOT NULL,
	`state` integer NOT NULL,
	`lastReview` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`highlightId`) REFERENCES `highlights`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sectionId`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`llmCallId`) REFERENCES `llm_calls`(`runId`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `review_cards_due_suspended_idx` ON `review_cards` (`due`,`suspended`);--> statement-breakpoint
CREATE INDEX `review_cards_paperId_idx` ON `review_cards` (`paperId`);--> statement-breakpoint
CREATE TABLE `review_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`cardId` text NOT NULL,
	`clientRequestId` text NOT NULL,
	`rating` integer NOT NULL,
	`state` integer NOT NULL,
	`due` integer NOT NULL,
	`stability` real NOT NULL,
	`difficulty` real NOT NULL,
	`elapsedDays` real NOT NULL,
	`lastElapsedDays` real NOT NULL,
	`scheduledDays` real NOT NULL,
	`learningSteps` integer NOT NULL,
	`reviewedAt` integer NOT NULL,
	`fsrsLibVersion` text NOT NULL,
	FOREIGN KEY (`cardId`) REFERENCES `review_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_logs_clientRequestId_unique` ON `review_logs` (`clientRequestId`);--> statement-breakpoint
CREATE INDEX `review_logs_cardId_idx` ON `review_logs` (`cardId`);--> statement-breakpoint
CREATE INDEX `review_logs_reviewedAt_idx` ON `review_logs` (`reviewedAt`);--> statement-breakpoint
CREATE TABLE `sections` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`parentId` text,
	`htmlId` text,
	`number` text,
	`title` text NOT NULL,
	`level` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`contentMd` text,
	`pdfPage` integer,
	`pdfOffset` integer,
	`pdfRectJson` text,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parentId`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sections_paperId_ordinal_idx` ON `sections` (`paperId`,`ordinal`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`valueJson` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`paperId` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`anchorJson` text,
	`quoteHash` text,
	`highlightId` text,
	`equationId` text,
	`sectionId` text,
	`imageFileId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`highlightId`) REFERENCES `highlights`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`equationId`) REFERENCES `equations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sectionId`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`imageFileId`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `threads_paperId_updatedAt_idx` ON `threads` (`paperId`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `threads_paperId_kind_quoteHash_idx` ON `threads` (`paperId`,`kind`,`quoteHash`);