PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`position` integer NOT NULL,
	`type` text NOT NULL,
	`text` text,
	`tool_name` text,
	`tool_input` text,
	`tool_call_id` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_blocks`("id", "message_id", "position", "type", "text", "tool_name", "tool_input", "tool_call_id") SELECT "id", "message_id", "position", "type", "text", "tool_name", "tool_input", "tool_call_id" FROM `blocks`;--> statement-breakpoint
DROP TABLE `blocks`;--> statement-breakpoint
ALTER TABLE `__new_blocks` RENAME TO `blocks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_blocks_message` ON `blocks` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_blocks_type` ON `blocks` (`type`);--> statement-breakpoint
CREATE TABLE `__new_contexts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_contexts`("id", "message_id", "key", "value") SELECT "id", "message_id", "key", "value" FROM `contexts`;--> statement-breakpoint
DROP TABLE `contexts`;--> statement-breakpoint
ALTER TABLE `__new_contexts` RENAME TO `contexts`;--> statement-breakpoint
CREATE INDEX `idx_contexts_message` ON `contexts` (`message_id`);--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`timestamp` integer NOT NULL,
	`date` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_messages`("id", "source", "session_id", "role", "timestamp", "date") SELECT "id", "source", "session_id", "role", "timestamp", "date" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
CREATE INDEX `idx_messages_session` ON `messages` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_source` ON `messages` (`source`);--> statement-breakpoint
CREATE INDEX `idx_messages_date` ON `messages` (`date`);--> statement-breakpoint
CREATE INDEX `idx_messages_timestamp` ON `messages` (`timestamp`);