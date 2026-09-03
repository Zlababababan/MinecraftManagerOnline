CREATE TABLE `user_machine_permissions` (
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `machine_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_machine_permissions_machine` ON `user_machine_permissions` (`machine_id`);--> statement-breakpoint
CREATE TABLE `user_server_permissions` (
	`user_id` text NOT NULL,
	`server_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `server_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_server_permissions_server` ON `user_server_permissions` (`server_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `scoped` integer DEFAULT 0 NOT NULL;