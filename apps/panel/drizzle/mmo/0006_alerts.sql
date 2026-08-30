CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`rule` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`state` text NOT NULL,
	`first_fired_at` integer NOT NULL,
	`last_fired_at` integer NOT NULL,
	`resolved_at` integer,
	`notified_at` integer,
	`detail` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_alerts_rule_scope` ON `alerts` (`rule`,`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_alerts_state` ON `alerts` (`state`);