CREATE TABLE `backup_replicas` (
	`id` text PRIMARY KEY NOT NULL,
	`backup_id` text NOT NULL,
	`server_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`status` text NOT NULL,
	`archive_path` text,
	`size_bytes` integer,
	`sha256` text,
	`task_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	FOREIGN KEY (`backup_id`) REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_replicas_backup` ON `backup_replicas` (`backup_id`);--> statement-breakpoint
CREATE INDEX `idx_replicas_machine` ON `backup_replicas` (`machine_id`,`server_id`);--> statement-breakpoint
CREATE TABLE `backup_replication` (
	`server_id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`keep_last` integer DEFAULT 7 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE cascade
);
