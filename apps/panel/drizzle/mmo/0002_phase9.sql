ALTER TABLE `machines` ADD `runtime_version` text;--> statement-breakpoint
ALTER TABLE `server_migrations` ADD `source_path` text;--> statement-breakpoint
ALTER TABLE `server_migrations` ADD `to_path` text;--> statement-breakpoint
ALTER TABLE `server_migrations` ADD `mode` text;--> statement-breakpoint
ALTER TABLE `server_migrations` ADD `export_task_id` text;--> statement-breakpoint
ALTER TABLE `server_migrations` ADD `import_task_id` text;--> statement-breakpoint
ALTER TABLE `server_migrations` ADD `restart_after` integer DEFAULT 1 NOT NULL;