CREATE TABLE `metrics_machine_1h` (
	`machine_id` text NOT NULL,
	`ts` integer NOT NULL,
	`cpu_avg` real,
	`cpu_max` real,
	`ram_avg` integer,
	`ram_max` integer,
	`disk_used_gb` real,
	`disk_total_gb` real,
	`samples` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `ts`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `metrics_machine_1m` (
	`machine_id` text NOT NULL,
	`ts` integer NOT NULL,
	`cpu_avg` real,
	`cpu_max` real,
	`ram_avg` integer,
	`ram_max` integer,
	`disk_used_gb` real,
	`disk_total_gb` real,
	`samples` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `ts`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `metrics_machine_raw` (
	`machine_id` text NOT NULL,
	`ts` integer NOT NULL,
	`cpu_pct` real,
	`ram_used_mb` integer,
	`disk_used_gb` real,
	`disk_total_gb` real,
	PRIMARY KEY(`machine_id`, `ts`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `metrics_server_1h` (
	`server_id` text NOT NULL,
	`ts` integer NOT NULL,
	`cpu_avg` real,
	`cpu_max` real,
	`ram_avg` integer,
	`ram_max` integer,
	`tps_avg` real,
	`tps_min` real,
	`players_max` integer,
	`samples` integer NOT NULL,
	PRIMARY KEY(`server_id`, `ts`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `metrics_server_1m` (
	`server_id` text NOT NULL,
	`ts` integer NOT NULL,
	`cpu_avg` real,
	`cpu_max` real,
	`ram_avg` integer,
	`ram_max` integer,
	`tps_avg` real,
	`tps_min` real,
	`players_max` integer,
	`samples` integer NOT NULL,
	PRIMARY KEY(`server_id`, `ts`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `metrics_server_raw` (
	`server_id` text NOT NULL,
	`ts` integer NOT NULL,
	`cpu_pct` real,
	`ram_mb` integer,
	`tps` real,
	`mspt` real,
	`players` integer,
	PRIMARY KEY(`server_id`, `ts`)
) WITHOUT ROWID;
