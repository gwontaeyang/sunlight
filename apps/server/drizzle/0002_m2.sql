ALTER TABLE `citations` ADD `equationId` text;--> statement-breakpoint
ALTER TABLE `citations` ADD `detail` text;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `parentRunId` text;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `resultRaw` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `pendingReplace` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `paper_cards` ADD `errorCode` text;--> statement-breakpoint
CREATE UNIQUE INDEX `paper_cards_generating_uq` ON `paper_cards` (`paperId`,`kind`) WHERE "paper_cards"."status" = 'generating';