CREATE TABLE `ui_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`user_id` text,
	`username` text,
	`kind` text NOT NULL,
	`page` text NOT NULL,
	`target` text
);
--> statement-breakpoint
CREATE INDEX `ui_events_ts` ON `ui_events` (`ts`);