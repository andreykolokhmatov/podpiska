ALTER TABLE "issues" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "schedule_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "schedule_every_days" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "schedule_hour" smallint DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "next_issue_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "schedule_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_notify_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_next_issue_at_idx" ON "users" USING btree ("next_issue_at");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_trigger_check" CHECK ("trigger" in ('manual', 'scheduled'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_schedule_every_days_check" CHECK ("schedule_every_days" in (1, 3, 7));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_schedule_hour_check" CHECK ("users"."schedule_hour" >= 0 and "users"."schedule_hour" <= 23);