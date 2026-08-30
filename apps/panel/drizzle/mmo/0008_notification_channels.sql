CREATE TABLE `notification_channel_prefs` (
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`event_type` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`user_id`, `channel`, `event_type`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
