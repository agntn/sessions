CREATE TABLE IF NOT EXISTS `blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`position` integer NOT NULL,
	`type` text NOT NULL,
	`text` text,
	`tool_name` text,
	`tool_input` text,
	`tool_call_id` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_blocks_message` ON `blocks` (`message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_blocks_type` ON `blocks` (`type`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `contexts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_contexts_message` ON `contexts` (`message_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ingest_state` (
	`source` text PRIMARY KEY NOT NULL,
	`cursor` text NOT NULL,
	`last_run` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `memxa_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`timestamp` integer NOT NULL,
	`date` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_session` ON `messages` (`session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_source` ON `messages` (`source`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_date` ON `messages` (`date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_timestamp` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`started_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_source` ON `sessions` (`source`);
