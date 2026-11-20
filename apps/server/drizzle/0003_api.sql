CREATE TABLE `api_charges` (
	`callId` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`model` text NOT NULL,
	`generation` text NOT NULL,
	`priceVersion` text NOT NULL,
	`kind` text NOT NULL,
	`held` integer NOT NULL,
	`spent` integer NOT NULL,
	`status` text NOT NULL,
	`usageJson` text
);
--> statement-breakpoint
CREATE INDEX `api_charges_month_idx` ON `api_charges` (`month`);--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `backend` text;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `executionMode` text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `credentialGeneration` text;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `requestedModel` text;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `priceVersion` text;