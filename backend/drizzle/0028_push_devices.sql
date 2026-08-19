-- Self-hosted device push: replaces the FCM registration table (0027) now that the
-- Android APK holds its own connection to Maily instead of routing through Firebase.
--
-- What changed conceptually: a `device_tokens` row held a *Google-minted* FCM token that
-- the server sent TO. A `push_devices` row holds a *Maily-minted* shared secret that the
-- device presents when it connects to `GET /api/push/stream`. So the direction of trust
-- inverted, and the column is a hash: the plaintext is shown once at registration and
-- never stored, the way any bearer credential should be.
--
-- `last_event_at` is the catch-up cursor. The stream only reaches a device that is
-- actually connected (unlike FCM, which queued for us), so on reconnect the server
-- replays the INBOX arrivals it missed since this timestamp.
--
-- Dropped rather than migrated: FCM was never switched on in any deployment (it needed a
-- google-services.json that was never shipped), so the old table is empty everywhere, and
-- an FCM token is worthless to the new transport regardless.
DROP TABLE IF EXISTS `device_tokens`;--> statement-breakpoint
CREATE TABLE `push_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000),
	`last_seen_at` integer,
	`last_event_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_token_hash_unique` ON `push_devices` (`token_hash`);
