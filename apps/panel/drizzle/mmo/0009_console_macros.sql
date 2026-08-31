CREATE TABLE `console_macros` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`commands` text NOT NULL,
	`server_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_console_macros_server` ON `console_macros` (`server_id`);