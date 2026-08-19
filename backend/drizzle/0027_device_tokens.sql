-- FCM device tokens: the Android APK's background-notification channel (ROADMAP §top).
-- The APK is a WebView shell and Android System WebView exposes no Push API, so it cannot
-- hold a VAPID `push_subscriptions` row the way the PWA does. It registers a Firebase
-- token instead, and the `mail:new` fan-out sends to both channels.
--
-- The token is the device identity, so registration is an upsert on it. `last_seen_at`
-- is refreshed on every registration -- the web layer re-registers on each boot, since
-- FCM rotates tokens and the remote-origin WebView has no working plugin listener to be
-- told about a rotation.
CREATE TABLE `device_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	`last_seen_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `device_tokens_token_unique` ON `device_tokens` (`token`);
