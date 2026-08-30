ALTER TABLE `backup_policies` ADD `last_run_at` integer;--> statement-breakpoint
ALTER TABLE `backup_policies` ADD `last_status` text;--> statement-breakpoint
ALTER TABLE `backup_policies` ADD `last_backup_id` text;--> statement-breakpoint
ALTER TABLE `backup_policies` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `backup_policies` ADD `overdue_since` integer;