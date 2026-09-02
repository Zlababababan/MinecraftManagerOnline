CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`secret` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`types` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_attempt_at` integer,
	`last_delivered_at` integer,
	`last_status` integer,
	`last_error` text,
	`fail_count` integer DEFAULT 0 NOT NULL
);
