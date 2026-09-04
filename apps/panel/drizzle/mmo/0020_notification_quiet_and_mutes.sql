CREATE TABLE `notification_mutes` (
	`user_id` text NOT NULL,
	`server_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `server_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `users` ADD `quiet_from` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `quiet_to` integer;