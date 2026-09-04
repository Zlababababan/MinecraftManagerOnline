CREATE TABLE `whitelist_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_whitelist_requests_name` ON `whitelist_requests` (`server_id`,`name_key`);--> statement-breakpoint
CREATE INDEX `idx_whitelist_requests_status` ON `whitelist_requests` (`server_id`,`status`);--> statement-breakpoint
ALTER TABLE `server_status_pages` ADD `allow_whitelist` integer DEFAULT 0 NOT NULL;