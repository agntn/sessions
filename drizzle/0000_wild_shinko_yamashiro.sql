CREATE TABLE `blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`position` integer NOT NULL,
	`type` text NOT NULL,
	`text` text,
	`tool_name` text,
	`tool_input` text,
	`tool_call_id` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_blocks_message` ON `blocks` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_blocks_type` ON `blocks` (`type`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`platform_id` text,
	`name` text,
	`type` text
);
--> statement-breakpoint
CREATE INDEX `idx_channels_platform` ON `channels` (`platform`,`platform_id`);--> statement-breakpoint
CREATE TABLE `contexts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_contexts_message` ON `contexts` (`message_id`);--> statement-breakpoint
CREATE TABLE `ingest_state` (
	`source` text PRIMARY KEY NOT NULL,
	`cursor` text NOT NULL,
	`last_run` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memxa_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_authors` (
	`message_id` text NOT NULL,
	`participant_id` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_message_authors_message` ON `message_authors` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_message_authors_participant` ON `message_authors` (`participant_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`timestamp` integer NOT NULL,
	`date` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_session` ON `messages` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_source` ON `messages` (`source`);--> statement-breakpoint
CREATE INDEX `idx_messages_date` ON `messages` (`date`);--> statement-breakpoint
CREATE INDEX `idx_messages_timestamp` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`platform_id` text,
	`name` text NOT NULL,
	`is_bot` integer DEFAULT false
);
--> statement-breakpoint
CREATE INDEX `idx_participants_platform` ON `participants` (`platform`,`platform_id`);--> statement-breakpoint
CREATE INDEX `idx_participants_name` ON `participants` (`name`);--> statement-breakpoint
CREATE TABLE `session_participants` (
	`session_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`role` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_participants_session` ON `session_participants` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_session_participants_participant` ON `session_participants` (`participant_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`channel_id` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_source` ON `sessions` (`source`);--> statement-breakpoint
CREATE INDEX `idx_sessions_channel` ON `sessions` (`channel_id`);