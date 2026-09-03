CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`last_used_ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_token_hash_unique` ON `api_keys` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_user` ON `api_keys` (`user_id`);