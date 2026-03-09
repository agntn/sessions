PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_message_authors` (
	`message_id` text NOT NULL,
	`participant_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `participant_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_message_authors`("message_id", "participant_id") SELECT DISTINCT "message_id", "participant_id" FROM `message_authors`;--> statement-breakpoint
DROP TABLE `message_authors`;--> statement-breakpoint
ALTER TABLE `__new_message_authors` RENAME TO `message_authors`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_message_authors_message` ON `message_authors` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_message_authors_participant` ON `message_authors` (`participant_id`);--> statement-breakpoint
CREATE TABLE `__new_session_participants` (
	`session_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`role` text,
	PRIMARY KEY(`session_id`, `participant_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_session_participants`("session_id", "participant_id", "role") SELECT "session_id", "participant_id", max("role") as "role" FROM `session_participants` GROUP BY "session_id", "participant_id";--> statement-breakpoint
DROP TABLE `session_participants`;--> statement-breakpoint
ALTER TABLE `__new_session_participants` RENAME TO `session_participants`;--> statement-breakpoint
CREATE INDEX `idx_session_participants_session` ON `session_participants` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_session_participants_participant` ON `session_participants` (`participant_id`);
