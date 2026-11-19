ALTER TABLE "users" ADD COLUMN "channel_lookups_day" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "channel_lookups_count" integer DEFAULT 0 NOT NULL;