CREATE TABLE `server_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_servers` (
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
	`group_id` text,
	`group_position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`directory_id`) REFERENCES `watched_directories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`java_runtime_id`) REFERENCES `java_runtimes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`group_id`) REFERENCES `server_groups`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "servers_loader" CHECK("__new_servers"."loader" IN ('vanilla','forge','neoforge','fabric','velocity','unknown')),
	CONSTRAINT "servers_expose" CHECK("__new_servers"."expose_mode" IN ('tailnet','direct')),
	CONSTRAINT "servers_provisioning" CHECK("__new_servers"."provisioning" IN ('installing','install_failed','ready','archived','migrating')),
	CONSTRAINT "servers_run_state" CHECK("__new_servers"."run_state" IN ('stopped','starting','running','stopping','crashed')),
	CONSTRAINT "servers_desired" CHECK("__new_servers"."desired_state" IN ('stopped','running')),
	CONSTRAINT "servers_attach" CHECK("__new_servers"."attach_mode" IN ('attached','detached'))
);
--> statement-breakpoint
INSERT INTO `__new_servers`("id", "machine_id", "directory_id", "path", "name", "loader", "mc_version", "loader_version", "detected", "java_runtime_id", "java_major_required", "java_args", "min_ram_mb", "max_ram_mb", "game_port", "rcon_enabled", "rcon_port", "rcon_password_enc", "eula_accepted", "expose_mode", "provisioning", "run_state", "desired_state", "attach_mode", "last_exit_reason", "auto_restart", "crash_loop_max", "watchdog_freeze_s", "pid", "started_at", "stopped_at", "detection_json", "created_at", "updated_at", "group_id", "group_position") SELECT "id", "machine_id", "directory_id", "path", "name", "loader", "mc_version", "loader_version", "detected", "java_runtime_id", "java_major_required", "java_args", "min_ram_mb", "max_ram_mb", "game_port", "rcon_enabled", "rcon_port", "rcon_password_enc", "eula_accepted", "expose_mode", "provisioning", "run_state", "desired_state", "attach_mode", "last_exit_reason", "auto_restart", "crash_loop_max", "watchdog_freeze_s", "pid", "started_at", "stopped_at", "detection_json", "created_at", "updated_at", NULL, 0 FROM `servers`;--> statement-breakpoint
DROP TABLE `servers`;--> statement-breakpoint
ALTER TABLE `__new_servers` RENAME TO `servers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_servers_machine` ON `servers` (`machine_id`);--> statement-breakpoint
CREATE INDEX `idx_servers_run` ON `servers` (`run_state`);--> statement-breakpoint
CREATE INDEX `idx_servers_ports` ON `servers` (`machine_id`,`game_port`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_servers_path` ON `servers` (`machine_id`,`path`);