CREATE TABLE `study_paths` (
	`paperId` text PRIMARY KEY NOT NULL,
	`resultJson` text,
	`pendingRunId` text,
	`pendingCodeLanguage` text,
	`pendingRegenerate` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`paperId`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade
);
