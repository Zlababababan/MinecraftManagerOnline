CREATE TABLE `server_status_pages` (
	`server_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`show_players` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_status_pages_token_unique` ON `server_status_pages` (`token`);