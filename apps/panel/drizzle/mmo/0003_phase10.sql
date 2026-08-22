ALTER TABLE `machines` ADD `addresses` text;--> statement-breakpoint
ALTER TABLE `machines` ADD `tailnet_host` text;--> statement-breakpoint
ALTER TABLE `machines` ADD `public_host` text;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `user_agent` text;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `notifications_seen_id` integer DEFAULT 0 NOT NULL;