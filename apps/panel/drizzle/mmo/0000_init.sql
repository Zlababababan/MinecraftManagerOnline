CREATE TABLE `agent_releases` (
	`version` text PRIMARY KEY NOT NULL,
	`protocol_version` integer NOT NULL,
	`channel` text DEFAULT 'stable' NOT NULL,
	`released_at` integer NOT NULL,
	`bundle_path` text NOT NULL,
	`bundle_sha256` text NOT NULL,
	`bundle_signature` text NOT NULL,
	`bundle_size` integer NOT NULL,
	`runtime_version` text,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`user_id` text,
	`username` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`target_label` text,
	`details` text,
	`ip` text
);
--> statement-breakpoint
CREATE INDEX `idx_audit_ts` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_audit_user` ON `audit_log` (`user_id`,`ts`);--> statement-breakpoint
CREATE TABLE `backup_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`cron` text NOT NULL,
	`destination` text,
	`keep_last` integer,
	`keep_days` integer,
	`only_if_running` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bpol_server` ON `backup_policies` (`server_id`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`policy_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`machine_id` text NOT NULL,
	`archive_path` text,
	`size_bytes` integer,
	`sha256` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	`created_by` text,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `backup_policies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "backups_kind" CHECK("backups"."kind" IN ('manual','scheduled','pre_migration','pre_restore')),
	CONSTRAINT "backups_status" CHECK("backups"."status" IN ('running','success','failed','deleted'))
);
--> statement-breakpoint
CREATE INDEX `idx_backups_server` ON `backups` (`server_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `command_history` (
	`id` integer PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`user_id` text,
	`command` text NOT NULL,
	`via` text DEFAULT 'stdin' NOT NULL,
	`ts` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_cmdhist` ON `command_history` (`server_id`,`user_id`,`ts`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`machine_id` text,
	`server_id` text,
	`user_id` text,
	`payload` text,
	CONSTRAINT "events_severity" CHECK("events"."severity" IN ('debug','info','warning','error','critical'))
);
--> statement-breakpoint
CREATE INDEX `idx_events_ts` ON `events` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_events_server` ON `events` (`server_id`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_events_type` ON `events` (`type`,`ts`);--> statement-breakpoint
CREATE TABLE `java_runtimes` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`major_version` integer NOT NULL,
	`full_version` text,
	`vendor` text,
	`path` text NOT NULL,
	`managed` integer DEFAULT 1 NOT NULL,
	`installed_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_java_machine` ON `java_runtimes` (`machine_id`,`major_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_java_path` ON `java_runtimes` (`machine_id`,`path`);--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`os` text,
	`arch` text,
	`hostname` text,
	`agent_version` text,
	`protocol_version` integer,
	`agent_token_hash` text,
	`agent_token_prev_hash` text,
	`agent_token_prev_until` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_seen_at` integer,
	`cpu_model` text,
	`cpu_cores` integer,
	`ram_total_mb` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "machines_os" CHECK("machines"."os" IN ('windows','linux','macos')),
	CONSTRAINT "machines_arch" CHECK("machines"."arch" IN ('x64','arm64')),
	CONSTRAINT "machines_status" CHECK("machines"."status" IN ('pending','online','offline','disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machines_name_unique` ON `machines` (`name`);--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`user_id`, `event_type`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`id` integer PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`machine_id` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_codes_code_hash_unique` ON `pairing_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `player_sessions` (
	`id` integer PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`player_uuid` text NOT NULL,
	`player_name` text NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_uuid`) REFERENCES `players`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_psess_server` ON `player_sessions` (`server_id`,`joined_at`);--> statement-breakpoint
CREATE INDEX `idx_psess_player` ON `player_sessions` (`player_uuid`,`joined_at`);--> statement-breakpoint
CREATE INDEX `idx_psess_online` ON `player_sessions` (`server_id`) WHERE "player_sessions"."left_at" IS NULL;--> statement-breakpoint
CREATE TABLE `players` (
	`uuid` text PRIMARY KEY NOT NULL,
	`last_name` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `processed_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_processed_ts` ON `processed_events` (`ts`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_success_at` integer,
	`fail_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `idx_push_user` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text,
	`action` text NOT NULL,
	`cron` text NOT NULL,
	`payload` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`next_run_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sched_action" CHECK("scheduled_tasks"."action" IN ('start','stop','restart','backup','command','announce'))
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_next` ON `scheduled_tasks` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `server_log_files` (
	`id` integer PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`file_name` text NOT NULL,
	`size_bytes` integer,
	`first_ts` integer,
	`last_ts` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_log_files` ON `server_log_files` (`server_id`,`file_name`);--> statement-breakpoint
CREATE TABLE `server_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`from_machine_id` text NOT NULL,
	`to_machine_id` text NOT NULL,
	`to_directory_id` text,
	`backup_id` text,
	`status` text NOT NULL,
	`progress_pct` real,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	`created_by` text,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_directory_id`) REFERENCES `watched_directories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`backup_id`) REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_migr_server` ON `server_migrations` (`server_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`directory_id` text,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`loader` text DEFAULT 'unknown' NOT NULL,
	`mc_version` text,
	`loader_version` text,
	`detected` integer DEFAULT 0 NOT NULL,
	`java_runtime_id` text,
	`java_major_required` integer,
	`java_args` text,
	`min_ram_mb` integer DEFAULT 1024 NOT NULL,
	`max_ram_mb` integer DEFAULT 4096 NOT NULL,
	`game_port` integer,
	`rcon_enabled` integer DEFAULT 1 NOT NULL,
	`rcon_port` integer,
	`rcon_password_enc` text,
	`eula_accepted` integer DEFAULT 0 NOT NULL,
	`expose_mode` text DEFAULT 'tailnet' NOT NULL,
	`provisioning` text DEFAULT 'installing' NOT NULL,
	`run_state` text DEFAULT 'stopped' NOT NULL,
	`desired_state` text DEFAULT 'stopped' NOT NULL,
	`attach_mode` text DEFAULT 'attached' NOT NULL,
	`last_exit_reason` text,
	`auto_restart` integer DEFAULT 0 NOT NULL,
	`crash_loop_max` integer DEFAULT 3 NOT NULL,
	`watchdog_freeze_s` integer DEFAULT 120 NOT NULL,
	`pid` integer,
	`started_at` integer,
	`stopped_at` integer,
	`detection_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`directory_id`) REFERENCES `watched_directories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`java_runtime_id`) REFERENCES `java_runtimes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "servers_loader" CHECK("servers"."loader" IN ('vanilla','forge','neoforge','fabric','unknown')),
	CONSTRAINT "servers_expose" CHECK("servers"."expose_mode" IN ('tailnet','direct')),
	CONSTRAINT "servers_provisioning" CHECK("servers"."provisioning" IN ('installing','install_failed','ready','archived','migrating')),
	CONSTRAINT "servers_run_state" CHECK("servers"."run_state" IN ('stopped','starting','running','stopping','crashed')),
	CONSTRAINT "servers_desired" CHECK("servers"."desired_state" IN ('stopped','running')),
	CONSTRAINT "servers_attach" CHECK("servers"."attach_mode" IN ('attached','detached'))
);
--> statement-breakpoint
CREATE INDEX `idx_servers_machine` ON `servers` (`machine_id`);--> statement-breakpoint
CREATE INDEX `idx_servers_run` ON `servers` (`run_state`);--> statement-breakpoint
CREATE INDEX `idx_servers_ports` ON `servers` (`machine_id`,`game_port`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_servers_path` ON `servers` (`machine_id`,`path`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`machine_id` text,
	`server_id` text,
	`status` text NOT NULL,
	`progress` real,
	`payload` text,
	`ref_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_status" CHECK("tasks"."status" IN ('pending','running','stalled','done','failed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL COLLATE NOCASE,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`locale` text DEFAULT 'fr' NOT NULL,
	`theme` text DEFAULT 'dark' NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	CONSTRAINT "users_role" CHECK("users"."role" IN ('admin','operator','viewer')),
	CONSTRAINT "users_locale" CHECK("users"."locale" IN ('fr','en'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `watched_directories` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`path` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_scan_at` integer,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_watched_dir` ON `watched_directories` (`machine_id`,`path`);