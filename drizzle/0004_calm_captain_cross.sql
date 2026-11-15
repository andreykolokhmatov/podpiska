ALTER TABLE "issues" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_blocked_at" timestamp with time zone;