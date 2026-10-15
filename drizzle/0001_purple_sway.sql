CREATE TABLE `auth_credentials` (
	`principal_id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`person_id` text,
	`salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`iterations` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_credentials_login_unique` ON `auth_credentials` (`login`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_credentials_person_id_unique` ON `auth_credentials` (`person_id`);--> statement-breakpoint
CREATE TABLE `auth_login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
